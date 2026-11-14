/**
 * @deepseek-ai/dsh-hemi-mobile-access — the desktop owner's mobile-access
 * service. It owns the one-time pairing invitation, the approved-device
 * directory, and the private TLS listener phones connect to on the home LAN.
 * The listener mounts only while the owner keeps it started; it never autostarts,
 * binds only concrete private or link-local IPv4 addresses, and forwards
 * admitted phone traffic to the Host's existing `/api` bridge, registered web
 * resources, and the Gateway's Remote mux, so no second runtime or transport
 * exists. Management methods answer only the desktop browser's owner Peer —
 * a paired phone's independent owner Peer cannot manage the service.
 */

import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialKeyScope, type CredentialKey } from '@deepseek-ai/dsh-credentials'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { IncomingMessage } from 'node:http'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-api-gateway'
import { AddressRateLimiter, enumerateMobileAddresses } from './internal/net.ts'
import { PairingEngine } from './internal/pairing.ts'
import { MOBILE_ACCESS_CREDENTIAL_SCOPE, MobileAccessStore, type MobileDeviceRecord } from './internal/records.ts'
import { generateTlsMaterial, type MobileTlsMaterial } from './internal/tls.ts'
import { deviceSecretMatches } from './internal/wire.ts'
import { MobileTlsListener, presentedCredential, type AdmittedDevice } from './listener.ts'
import { MobileListenerPool } from './listener-pool.ts'
import type {
  MobileAccessState,
  MobileAddress,
  MobileDeviceId,
  MobileInvitation,
  MobileListenerRecord,
  MobileRequestId,
} from './types.ts'

export type {
  MobileAccessState,
  MobileAddress,
  MobileDeviceId,
  MobileDeviceView,
  MobileInvitation,
  MobileInvitationView,
  MobileListenerRecord,
  MobilePairRequest,
  MobilePairStatus,
  MobileRequestId,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Hemi mobile-access pairing, device directory, and TLS carrier. */
    hemiMobileAccess: HemiMobileAccess
  }
}

/** Default listener body cap for pair-endpoint JSON. */
const DEFAULT_MAX_PAIR_BODY_BYTES = 8192

/** Default per-address pair-endpoint events per minute. */
const DEFAULT_PAIR_REQUESTS_PER_MINUTE = 20

/** Default approved-device cap. */
const DEFAULT_MAX_DEVICES = 10

/** Default `/api` request-body cap forwarded to the shared bridge. */
const DEFAULT_MAX_API_BODY_BYTES = 64 * 1024 * 1024

/** Default one-time invitation lifetime. */
const DEFAULT_INVITATION_TTL_SECONDS = 120

/** Default pending-claim lifetime. */
const DEFAULT_REQUEST_TTL_SECONDS = 300

/** Mobile-access listener configuration. */
export interface Config {
  /**
   * Listen port. Zero (the default) asks the OS for a port on the first
   * start; that port is then persisted and reused by later starts, so a
   * phone's saved origin keeps working. An explicit port always wins, and a
   * busy persisted port fails the start instead of silently moving.
   * @default 0
   */
  port?: number
  /**
   * Server name shown to phones in pairing and session responses. Defaults
   * to the machine hostname.
   */
  serverName?: string
  /** One-time invitation lifetime in seconds. @default 120 */
  invitationTtlSeconds?: number
  /** Pending pairing-claim lifetime in seconds. @default 300 */
  requestTtlSeconds?: number
  /** Maximum accepted pair-endpoint JSON body in bytes. @default 8192 */
  maxPairBodyBytes?: number
  /** Pair-endpoint events allowed per remote address per minute. @default 20 */
  pairRequestsPerMinute?: number
  /** Maximum number of approved devices. @default 10 */
  maxDevices?: number
  /** Maximum buffered `/api` request body forwarded to the shared bridge. @default 67108864 */
  maxApiBodyBytes?: number
}

export const Config: z<Config> = z.object({
  port: z.natural().max(65535).default(0),
  serverName: z.string().min(1).default(undefined as never),
  invitationTtlSeconds: z.natural().min(10).default(DEFAULT_INVITATION_TTL_SECONDS),
  requestTtlSeconds: z.natural().min(30).default(DEFAULT_REQUEST_TTL_SECONDS),
  maxPairBodyBytes: z.natural().min(256).default(DEFAULT_MAX_PAIR_BODY_BYTES),
  pairRequestsPerMinute: z.natural().min(1).default(DEFAULT_PAIR_REQUESTS_PER_MINUTE),
  maxDevices: z.natural().min(1).default(DEFAULT_MAX_DEVICES),
  maxApiBodyBytes: z.natural().min(1024).default(DEFAULT_MAX_API_BODY_BYTES),
})

/**
 * The mobile-access service. Remote methods manage pairing and the listener;
 * the listener itself answers phones over TLS. Disposal closes the listener,
 * disposes every device Peer, and clears pairing state without touching
 * Host-side Sessions or agent work.
 */
export default class HemiMobileAccess extends TypertRemoteService {
  static inject = ['connection', 'typertGateway', 'webServer', 'credentials']
  static Config = Config

  private readonly pairing: PairingEngine
  private readonly store: MobileAccessStore
  private readonly limiter: AddressRateLimiter
  private listener: MobileListenerPool | undefined
  private readonly createListener: (generation: number) => MobileTlsListener
  private carrierGeneration = 0
  private committedGeneration: number | undefined
  private readonly serverName: string
  private readonly maxDevices: number
  private readonly configuredPort: number
  private readonly now = (): number => Date.now()
  private ready = false
  private carrierDisposed = false
  private lifecycle: Promise<unknown> = Promise.resolve()
  private lastListener: MobileListenerRecord | undefined
  private lastListenerLoaded = false
  private activeFingerprint: string | undefined
  private readonly peers = new Map<string, PeerScope>()
  /** Secret hash each live Peer was admitted under, so a rotation retires the old socket. */
  private readonly peerBindings = new Map<string, string>()
  private readonly lastSeen = new Map<string, number>()

  /**
   * @param ctx - Host context supplying Connection, the Gateway, the webServer, and credentials.
   * @param config - resolved plugin config; the Loader applies schema defaults.
   */
  constructor(ctx: Context, config?: Config) {
    super(ctx, 'hemiMobileAccess', { namespace: 'hemiMobileAccess' })
    // The Loader resolves schema defaults; hand-built test contexts may pass none.
    const invitationTtlSeconds = config?.invitationTtlSeconds ?? DEFAULT_INVITATION_TTL_SECONDS
    const requestTtlSeconds = config?.requestTtlSeconds ?? DEFAULT_REQUEST_TTL_SECONDS
    const maxPairBodyBytes = config?.maxPairBodyBytes ?? DEFAULT_MAX_PAIR_BODY_BYTES
    const pairRequestsPerMinute = config?.pairRequestsPerMinute ?? DEFAULT_PAIR_REQUESTS_PER_MINUTE
    const maxApiBodyBytes = config?.maxApiBodyBytes ?? DEFAULT_MAX_API_BODY_BYTES
    this.maxDevices = config?.maxDevices ?? DEFAULT_MAX_DEVICES
    this.configuredPort = config?.port ?? 0
    this.serverName = config?.serverName ?? hostname()
    this.pairing = new PairingEngine(invitationTtlSeconds * 1000, requestTtlSeconds * 1000)
    this.store = new MobileAccessStore(ctx.credentials)
    this.limiter = new AddressRateLimiter(60_000, pairRequestsPerMinute)
    const fetchHandler = ctx.connection.createSharedFetchHandler('/api')
    this.createListener = generation => new MobileTlsListener({
      authenticate: headers => this.authenticateDevice(headers, generation),
      pairing: this.pairing,
      serveApi: (request, response, peer) =>
        ctx.connection.serveHttp(request, response, fetchHandler, peer, maxApiBodyBytes),
      readResource: (request, peer) => ctx.webServer.readResource(request, peer),
      acceptUpgrade: (request, socket, head, peer) => {
        ctx.typertGateway.websocket.acceptUpgrade(request, socket, head, peer)
      },
      websocketPath: ctx.typertGateway.websocket.path,
      limiter: this.limiter,
      serverName: this.serverName,
      maxPairBodyBytes,
      isReady: () => this.isCarrierCurrent(generation),
      now: this.now,
      log: (error) => { ctx.logger.warn(error) },
    })
    const ready = ctx.get('appReady')
    if (ready === undefined) this.ready = true
    else ctx.effect(() => ready.onReady(() => { this.ready = true }), 'hemi-mobile-access: application readiness')
    ctx.on('credentials/record-updated', (key) => { this.onRecordUpdated(key) })
    ctx.effect(() => () => {
      this.carrierDisposed = true
      this.retireCarrier()
      return this.runLifecycle(() => this.shutdownCarrier())
    }, 'hemi-mobile-access: listener and device Peers')
  }

  /** Read the persisted listener record lazily so a broken credential store never fails Host boot. */
  private async loadLastListener(): Promise<MobileListenerRecord | undefined> {
    if (!this.lastListenerLoaded) {
      const persisted = await this.store.readListener()
      this.lastListener = persisted === undefined ? undefined : { host: persisted.host, port: persisted.port }
      this.lastListenerLoaded = true
    }
    return this.lastListener
  }

  /**
   * Current management state: listener status, bind candidates, the safe
   * invitation view, pairing rows, and approved devices.
   * @param signal - caller cancellation before the read.
   * @returns the authoritative state.
   * @throws RemoteError `hemi-mobile/unauthorized` from any Peer but the desktop browser owner Peer.
   */
  @Remote
  async getState(signal: AbortSignal): Promise<MobileAccessState> {
    signal.throwIfAborted()
    this.requireDesktopOwner()
    return this.snapshot()
  }

  /**
   * Automatically bind the current LAN candidates; no client supplies a network address.
   * The group accepts traffic only after all binding and durable-port work succeeds.
   * @param signal - caller cancellation before lifecycle admission.
   * @returns committed listener state; failed starts close every acquired listener.
   * @throws RemoteError for no network, an existing listener, credential failure or a failed bind.
   */
  @Remote
  async start(signal: AbortSignal): Promise<MobileAccessState> {
    signal.throwIfAborted()
    this.requireDesktopOwner()
    const hosts = [...new Set(this.enumerateAddresses().map(address => address.address))]
    if (hosts.length === 0) throw new RemoteError('hemi-mobile/no-network', 'No local network is available', {})
    if (hosts.length > 32) {
      throw new RemoteError('hemi-mobile/listen-failed', 'Too many candidate network addresses', { reason: 'candidate-limit' })
    }
    const requestedGeneration = this.carrierGeneration
    return this.runLifecycle(async () => {
      this.assertCarrierLive()
      if (this.listener !== undefined) throw new RemoteError('hemi-mobile/already-listening', 'Phone connection is already on', {})
      this.assertCarrierGeneration(requestedGeneration)
      const generation = ++this.carrierGeneration
      try {
        let tls: MobileTlsMaterial
        let persistedListener: MobileListenerRecord | undefined
        try {
          tls = await this.ensureTlsMaterial(hosts)
          this.assertCarrierGeneration(generation)
          persistedListener = await this.loadLastListener()
        } catch (error) {
          if (error instanceof RemoteError) throw error
          throw new RemoteError('hemi-mobile/credentials-unavailable', `Mobile credentials could not be read: ${describe(error)}`, {})
        }
        this.assertCarrierGeneration(generation)
        const pool = new MobileListenerPool(() => this.createListener(generation))
        this.listener = pool
        const requestedPort = this.configuredPort !== 0 ? this.configuredPort : persistedListener?.port ?? 0
        try {
          await pool.start(hosts, requestedPort, tls)
        } catch (error) {
          throw new RemoteError('hemi-mobile/listen-failed', `Phone connection could not bind: ${describe(error)}`, { reason: describe(error) })
        }
        this.assertCarrierGeneration(generation)
        const origin = pool.listenerOrigin
        const port = pool.port
        if (origin === undefined || port === undefined) throw new Error('Mobile listener group has no bound address')
        const host = new URL(origin).hostname
        try {
          await this.store.writeListener(host, port)
        } catch (error) {
          throw new RemoteError('hemi-mobile/credentials-unavailable', `Listener state could not be saved: ${describe(error)}`, {})
        }
        this.assertCarrierGeneration(generation)
        this.lastListener = { host, port }
        this.lastListenerLoaded = true
        this.activeFingerprint = tls.fingerprint
        this.committedGeneration = generation
        return await this.snapshot()
      } catch (error) {
        if (this.carrierGeneration === generation) this.retireCarrier()
        await this.shutdownCarrier()
        throw error
      }
    })
  }

  /**
   * Stop the TLS listener: sockets and device Peers close and pending pairing
   * state clears. Host-side Sessions and accepted agent work keep running.
   * @param signal - caller cancellation before shutdown starts.
   * @returns the authoritative state after shutdown.
   */
  @Remote
  async stop(signal: AbortSignal): Promise<MobileAccessState> {
    signal.throwIfAborted()
    this.requireDesktopOwner()
    this.retireCarrier()
    return this.runLifecycle(async () => {
      await this.shutdownCarrier()
      return this.snapshot()
    })
  }

  /**
   * Mint a new one-time invitation, replacing any live one. The complete
   * payload — including the token — is returned exactly once; management
   * state never repeats it.
   * @param signal - caller cancellation before minting.
   * @returns the invitation for the owner to transfer to the phone, plus state.
   * @throws RemoteError `hemi-mobile/not-listening` before the listener runs.
   */
  @Remote
  async createInvitation(signal: AbortSignal): Promise<{ readonly invitation: MobileInvitation; readonly state: MobileAccessState }> {
    signal.throwIfAborted()
    this.requireDesktopOwner()
    const origins = this.activeOrigins()
    const origin = origins[0]
    const fingerprint = this.activeFingerprint
    if (origin === undefined || fingerprint === undefined) {
      throw new RemoteError('hemi-mobile/not-listening', 'start the mobile listener before creating an invitation', {})
    }
    const invitation = this.pairing.createInvitation(origin, fingerprint, this.now(), origins)
    return { invitation, state: await this.snapshot() }
  }

  /**
   * Approve one pending pairing after comparing the six-digit code shown on
   * both screens. The device record — name, creation time, and the secret
   * hash — is durably written before the request publishes `approved`, so a
   * phone never observes an approval that did not persist.
   * @param requestId - pairing attempt identity.
   * @param code - six-digit verification code.
   * @param signal - caller cancellation before the durable write.
   * @returns the authoritative state.
   * @throws RemoteError `hemi-mobile/request-not-found`, `hemi-mobile/wrong-code`,
   * `hemi-mobile/device-limit`, or `hemi-mobile/credentials-unavailable`.
   */
  @Remote
  async approve(requestId: MobileRequestId, code: string, signal: AbortSignal): Promise<MobileAccessState> {
    signal.throwIfAborted()
    this.requireDesktopOwner()
    const reservation = this.pairing.reserveApproval(requestId, code, this.now())
    if (reservation.kind === 'missing') {
      throw new RemoteError('hemi-mobile/request-not-found',
        `no open pairing request "${requestId}"`, { requestId })
    }
    if (reservation.kind === 'wrong-code') {
      throw new RemoteError('hemi-mobile/wrong-code',
        `the verification code does not match the request from "${reservation.deviceName}"`, {})
    }
    const deviceId = randomUUID()
    try {
      await this.store.addDevice(
        { deviceId, name: reservation.deviceName, createdAt: this.now(), secretHash: reservation.secretHash },
        this.maxDevices,
      )
    } catch (error) {
      reservation.release()
      throw new RemoteError('hemi-mobile/credentials-unavailable',
        `the approved device could not be persisted: ${describe(error)}`, {})
    }
    if (!reservation.commit(deviceId)) {
      // The row left the pending state while the record was being written
      // (stop, a new invitation); withdraw the orphan record so the directory
      // carries only devices a phone can learn about.
      try {
        await this.store.removeDevice(deviceId)
      } catch (rollbackError) {
        this.ctx.logger.warn(rollbackError)
        // The outcome is unknown: the device record may exist while no
        // request publishes it. Refuse with a storage failure so the owner
        // inspects the device list and revokes any leftover record.
        throw new RemoteError('hemi-mobile/credentials-unavailable',
          `approval of "${requestId}" was persisted but could not be withdrawn after its request disappeared; check the device list and revoke the leftover device`, {})
      }
      throw new RemoteError('hemi-mobile/request-not-found',
        `pairing request "${requestId}" no longer exists`, { requestId })
    }
    return this.snapshot()
  }

  /**
   * Reject one pending pairing request; the phone observes `rejected` on its
   * next status poll.
   * @param requestId - pairing attempt identity.
   * @param signal - caller cancellation before the rejection.
   * @returns the authoritative state.
   * @throws RemoteError `hemi-mobile/request-not-found`.
   */
  @Remote
  async reject(requestId: MobileRequestId, signal: AbortSignal): Promise<MobileAccessState> {
    signal.throwIfAborted()
    this.requireDesktopOwner()
    if (!this.pairing.reject(requestId)) {
      throw new RemoteError('hemi-mobile/request-not-found',
        `no pending pairing request "${requestId}"`, { requestId })
    }
    return this.snapshot()
  }

  /**
   * Revoke one approved device. The durable record is removed first, so new
   * requests fail authentication immediately; the device's Peer is then
   * disposed, closing its WebSocket. Already-accepted Host work is not recalled.
   * @param deviceId - approved device identity.
   * @param signal - caller cancellation before the revocation.
   * @returns the authoritative state.
   * @throws RemoteError `hemi-mobile/device-not-found` or `hemi-mobile/credentials-unavailable`.
   */
  @Remote
  async revoke(deviceId: MobileDeviceId, signal: AbortSignal): Promise<MobileAccessState> {
    signal.throwIfAborted()
    this.requireDesktopOwner()
    const id = deviceId as string
    let removed: boolean
    try {
      removed = await this.store.removeDevice(id)
    } catch (error) {
      throw new RemoteError('hemi-mobile/credentials-unavailable',
        `the device record could not be removed: ${describe(error)}`, {})
    }
    if (!removed) {
      throw new RemoteError('hemi-mobile/device-not-found', `no approved device "${id}"`, { deviceId: id })
    }
    this.lastSeen.delete(id)
    const peer = this.peers.get(id)
    this.peers.delete(id)
    this.peerBindings.delete(id)
    await peer?.dispose()
    return this.snapshot()
  }

  /**
   * Refuse a lifecycle transaction step after disposal. A method read keeps
   * this live across `await` boundaries where a narrowed field read would let
   * the type checker drop a guard a concurrent dispose can still trip.
   */
  private assertCarrierLive(): void {
    if (this.carrierDisposed) {
      throw new RemoteError('hemi-mobile/listen-failed', 'mobile-access is shutting down', { reason: 'shutting-down' })
    }
  }

  /**
   * Serialize carrier lifecycle operations: every start, stop, and the
   * dispose cleanup run as one transaction on a shared chain, so stop and
   * dispose join an in-flight start instead of completing beside it and
   * leaving a listener bound after the service stopped.
   * @param operation - one lifecycle transaction step.
   * @returns the operation's settlement.
   */
  private runLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.lifecycle.then(operation, operation)
    this.lifecycle = run.then(() => undefined, () => undefined)
    return run
  }

  /** Verify one phone request's device credential and admit its Peer. */
  private async authenticateDevice(headers: IncomingMessage['headers'], generation: number): Promise<AdmittedDevice | undefined> {
    if (!this.isCarrierCurrent(generation)) return undefined
    const credential = presentedCredential(headers)
    if (credential === undefined) return undefined
    // One retry: a credential-store change landing between the lookup and the
    // admission makes the looked-up record stale, so the second pass re-reads.
    // A second racing change refuses admission (fail closed).
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const observed = this.store.version
      let record: MobileDeviceRecord | undefined
      try {
        record = await this.store.deviceById(credential.deviceId)
      } catch (error) {
        // Fail closed: an unreadable store admits nobody.
        this.ctx.logger.warn(error)
        return undefined
      }
      if (record === undefined || !deviceSecretMatches(credential.secret, record.secretHash)) return undefined
      if (!this.isCarrierCurrent(generation)) return undefined
      if (this.store.version !== observed) continue
      this.lastSeen.set(record.deviceId, this.now())
      if (this.peerBindings.get(record.deviceId) !== record.secretHash) {
        // A rotated secret retires the Peer admitted under the old binding.
        const stale = this.peers.get(record.deviceId)
        if (stale !== undefined) {
          this.peers.delete(record.deviceId)
          void stale.dispose().catch((error: unknown) => { this.ctx.logger.warn(error) })
        }
      }
      return { deviceId: record.deviceId, secret: credential.secret, peer: this.peerFor(record) }
    }
    return undefined
  }

  /** One independent owner Peer per device, reused across its requests. */
  private peerFor(record: MobileDeviceRecord): PeerScope {
    const existing = this.peers.get(record.deviceId)
    if (existing !== undefined) return existing
    const peer = this.ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' })
    this.peers.set(record.deviceId, peer)
    this.peerBindings.set(record.deviceId, record.secretHash)
    return peer
  }

  /** Retire admission synchronously before any asynchronous shutdown work. */
  private retireCarrier(): void {
    this.carrierGeneration += 1
    this.committedGeneration = undefined
    this.pairing.reset()
  }

  /** Whether the request still belongs to the committed carrier group. */
  private isCarrierCurrent(generation: number): boolean {
    return !this.carrierDisposed && this.ready && this.carrierGeneration === generation && this.committedGeneration === generation
  }

  /** Check a pending start's generation after each asynchronous acquisition. */
  private assertCarrierGeneration(generation: number): void {
    this.assertCarrierLive()
    if (this.carrierGeneration !== generation) {
      throw new RemoteError('hemi-mobile/listen-failed', 'Phone connection was stopped', { reason: 'stopped' })
    }
  }

  /** Actual bound origins are advertised only after group commit. */
  private activeOrigins(): readonly string[] {
    return this.committedGeneration !== undefined && this.isCarrierCurrent(this.committedGeneration)
      ? this.listener?.origins ?? [] : []
  }

  /** Close the listener, dispose device Peers, and clear pairing state. */
  private async shutdownCarrier(): Promise<void> {
    const listener = this.listener
    this.committedGeneration = undefined
    this.activeFingerprint = undefined
    this.pairing.reset()
    const peers = [...this.peers.entries()]
    const closing = [listener?.stop() ?? Promise.resolve(), ...peers.map(([, peer]) => peer.dispose())]
    const results = await Promise.allSettled(closing)
    for (const [index, [id]] of peers.entries()) {
      if (results[index + 1]?.status === 'fulfilled') {
        this.peers.delete(id)
        this.peerBindings.delete(id)
        this.lastSeen.delete(id)
      }
    }
    const failures = results.filter(result => result.status === 'rejected')
    if (failures.length > 0) {
      for (const failure of failures) this.ctx.logger.warn(failure.reason)
      throw new RemoteError('hemi-mobile/listen-failed', 'Phone connection cleanup is incomplete', { reason: 'shutdown-failed' })
    }
    if (this.listener === listener) this.listener = undefined
  }

  /** Build the authoritative management state. */
  private async snapshot(): Promise<MobileAccessState> {
    this.pairing.sweepRequests(this.now())
    let devices: readonly MobileDeviceRecord[]
    let lastListener: MobileListenerRecord | null
    try {
      devices = await this.store.listDevices()
      lastListener = (await this.loadLastListener()) ?? null
    } catch (error) {
      throw new RemoteError('hemi-mobile/credentials-unavailable',
        `the device directory could not be read: ${describe(error)}`, {})
    }
    return {
      listening: this.activeOrigins().length > 0,
      origin: this.activeOrigins()[0] ?? null,
      addresses: this.enumerateAddresses(),
      invitation: this.pairing.invitationView(),
      requests: this.pairing.requestViews(),
      devices: devices.map(device => ({
        deviceId: brandString<MobileDeviceId>(device.deviceId),
        name: device.name,
        createdAt: device.createdAt,
        lastSeenAt: this.lastSeen.get(device.deviceId) ?? null,
        connected: this.peers.has(device.deviceId),
      })),
      lastListener,
    }
  }

  /**
   * Load or generate the TLS material, regenerating only when a current
   * candidate address is missing from the stored certificate's SANs.
   */
  private async ensureTlsMaterial(ips: readonly string[]): Promise<MobileTlsMaterial> {
    const stored = await this.store.readTls()
    if (stored !== undefined && ips.every(ip => stored.sanIps.includes(ip))) return stored
    const material = generateTlsMaterial(ips, this.now())
    await this.store.writeTls(material)
    return material
  }

  /**
   * Current bind candidates. A same-package test subclass narrows this to a
   * fixed address so the listener is drivable on hosts whose real interfaces
   * are not deterministic; production reads the machine's interfaces.
   * @returns candidate addresses in interface order.
   */
  protected enumerateAddresses(): readonly MobileAddress[] {
    return enumerateMobileAddresses()
  }

  /**
   * React to an external change of one of this plugin's credential records:
   * drop the cache and dispose every live device Peer whose record the fresh
   * directory no longer carries, so a deletion outside this service cannot
   * leave an authenticated socket behind.
   */
  private onRecordUpdated(key: CredentialKey): void {
    if (credentialKeyScope(key) !== MOBILE_ACCESS_CREDENTIAL_SCOPE) return
    this.store.invalidate()
    void this.reconcileDevicePeers().catch((error: unknown) => { this.ctx.logger.warn(error) })
  }

  /** Dispose Peers of devices the durable directory no longer lists. */
  private async reconcileDevicePeers(): Promise<void> {
    let devices: readonly MobileDeviceRecord[]
    try {
      devices = await this.store.listDevices()
    } catch (error) {
      // Fail closed: an unreadable directory keeps no authenticated Peer.
      this.ctx.logger.warn(error)
      devices = []
    }
    const present = new Map(devices.map(device => [device.deviceId, device.secretHash]))
    const retired = [...this.peers.keys()].filter((deviceId) => {
      const secretHash = present.get(deviceId)
      return secretHash === undefined || this.peerBindings.get(deviceId) !== secretHash
    })
    await Promise.all(retired.map(async (deviceId) => {
      const peer = this.peers.get(deviceId)
      this.peers.delete(deviceId)
      this.peerBindings.delete(deviceId)
      this.lastSeen.delete(deviceId)
      await peer?.dispose()
    }))
  }

  /** Refuse management from any Peer but the desktop browser's owner Peer. */
  private requireDesktopOwner(): void {
    const invocation = this.ctx.invocation
    if (invocation === undefined || invocation.peer !== this.ctx.connection.browserPeer) {
      throw new RemoteError('hemi-mobile/unauthorized',
        'mobile access management is available only to the desktop owner session', {})
    }
  }
}

/** Readable one-line description of an unknown failure for Remote diagnostics. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
