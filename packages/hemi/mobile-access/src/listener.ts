/**
 * The mobile TLS listener: one `node:https` server that admits phones after
 * device-credential verification and forwards admitted traffic to the Host's
 * existing seams. Only `/mobile/pair` and `/mobile/pair/status` are public;
 * everything else authenticates, `/api` rides `connection.serveHttp` over the
 * shared Fetch handler, other GET/HEAD reads serve through
 * `webServer.readResource` with the device's own Peer, and the single upgrade
 * path is the Gateway's `/api/remote.mux` WebSocket.
 */

import { createServer as createSecureServer } from 'node:https'
import type { Server } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { z } from 'zod'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { AddressRateLimiter } from './internal/net.ts'
import type { PairingEngine } from './internal/pairing.ts'
import type { MobileTlsMaterial } from './internal/tls.ts'
import {
  MOBILE_SESSION_COOKIE,
  parseBearerCredential,
  parseCookieCredential,
  readJsonBody,
  requestFenceFailure,
  refuseUpgrade,
  writeFetchResponse,
  writeJsonResponse,
  type DeviceCredential,
} from './internal/wire.ts'

/** Methods this carrier serves; anything else is refused before routing. */
const ALLOWED_METHODS = 'GET, HEAD, POST'

/** Request headers forwarded into `webServer.readResource` reads. */
const RESOURCE_REQUEST_HEADERS = ['accept', 'accept-language', 'if-modified-since', 'if-none-match', 'range'] as const

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/

/** Strict body of `POST /mobile/pair`; unknown fields are rejected. */
const pairBodySchema = z.strictObject({
  version: z.literal(1),
  invitationToken: z.string().regex(SECRET_PATTERN),
  requestId: z.string().regex(UUID_PATTERN),
  deviceName: z.string().min(1).max(64),
  secret: z.string().regex(SECRET_PATTERN),
})

/** Strict body of `POST /mobile/pair/status`. */
const pairStatusBodySchema = z.strictObject({
  requestId: z.string().regex(UUID_PATTERN),
  secret: z.string().regex(SECRET_PATTERN),
})

/** One authenticated phone request. */
export interface AdmittedDevice {
  readonly deviceId: string
  readonly secret: string
  readonly peer: PeerScope
}

/** Host seams the listener forwards admitted traffic to. */
export interface MobileListenerDeps {
  /** Verify one request's device credential and admit its Peer; undefined refuses. */
  readonly authenticate: (headers: IncomingMessage['headers']) => Promise<AdmittedDevice | undefined>
  /** Pairing state machine answering the public endpoints. */
  readonly pairing: PairingEngine
  /** Serve one `/api` request through shared admission (`ctx.connection.serveHttp`). */
  readonly serveApi: (request: IncomingMessage, response: ServerResponse, peer: PeerScope) => Promise<void>
  /** Read one registered resource (`ctx.webServer.readResource`). */
  readonly readResource: (request: Request, peer: PeerScope) => Promise<Response>
  /** Transfer one authenticated upgrade to the Gateway mux (`ctx.typertGateway.websocket.acceptUpgrade`). */
  readonly acceptUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer, peer: PeerScope) => void
  /** Absolute upgrade pathname the Gateway mux owns, read from `ctx.typertGateway.websocket.path`. */
  readonly websocketPath: string
  /** Pair-endpoint rate limiter, keyed by remote address. */
  readonly limiter: AddressRateLimiter
  /** Server name published to phones. */
  readonly serverName: string
  /** Maximum accepted pair-body size in bytes. */
  readonly maxPairBodyBytes: number
  /** Whether application readiness has been committed. */
  readonly isReady: () => boolean
  /** Current time in epoch milliseconds. */
  readonly now: () => number
  /** Contained logging sink for request-lifecycle failures. */
  readonly log: (error: unknown) => void
}

/**
 * Owns the listener lifecycle: bind once with generated TLS material, answer
 * requests until {@link stop}, and refuse everything while absent. Disposal
 * closes the listener and every connection it still tracks.
 */
export class MobileTlsListener {
  private server: Server | undefined
  private starting: Promise<void> | undefined
  private readonly tlsConnections = new Set<Duplex>()
  private authority: string | undefined
  private origin: string | undefined

  /**
   * @param deps - Host seams and configuration the listener forwards to.
   */
  constructor(private readonly deps: MobileListenerDeps) {}

  /** The bound port, or undefined while stopped. */
  get port(): number | undefined {
    if (this.server === undefined) return undefined
    const address = this.server.address()
    return typeof address === 'object' && address !== null ? address.port : undefined
  }

  /** The listener origin `https://<IPv4>:<port>`, or undefined while stopped. */
  get listenerOrigin(): string | undefined {
    return this.origin
  }

  /**
   * Bind to one address with the given TLS material. The bind is reserved
   * synchronously, so a second {@link start} while one is in flight — or
   * after a successful bind — refuses instead of leaking a second listener;
   * a failed bind releases the reservation for a retry.
   * @param host - concrete private IPv4 address.
   * @param port - requested port; 0 asks the OS to assign one.
   * @param tls - certificate and key covering `host` as a SAN.
   * @throws the underlying listen error, so the caller reports the failing step.
   */
  async start(host: string, port: number, tls: MobileTlsMaterial): Promise<void> {
    if (this.server !== undefined || this.starting !== undefined) {
      throw new Error('mobile-access: listener is already started')
    }
    const bind = this.bindListener(host, port, tls)
    this.starting = bind
    try {
      await bind
    } finally {
      this.starting = undefined
    }
  }

  /** Create and bind the server; a listen failure closes the server before rejecting. */
  private async bindListener(host: string, port: number, tls: MobileTlsMaterial): Promise<void> {
    const server = createSecureServer({ key: tls.keyPem, cert: tls.certPem }, (req, res) => {
      void this.dispatch(req, res).catch((error: unknown) => {
        this.deps.log(error)
        if (res.headersSent) {
          res.destroy()
          return
        }
        res.writeHead(400)
        res.end()
      })
    })
    server.on('connection', (socket) => {
      this.tlsConnections.add(socket)
      socket.once('close', () => { this.tlsConnections.delete(socket) })
    })
    server.on('upgrade', (req, socket, head) => { this.upgrade(req, socket, head) })
    const bound = await new Promise<number>((resolve, reject) => {
      const onListenError = (error: Error): void => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        server.off('error', onListenError)
        const address = server.address()
        /* v8 ignore next 2 -- a listening TLS server always reports a port. */
        if (typeof address !== 'object' || address === null) reject(new Error('mobile-access: listener bound without a port'))
        else resolve(address.port)
      }
      server.once('error', onListenError)
      server.once('listening', onListening)
      server.listen(port, host)
    }).catch((error: unknown) => {
      server.close()
      throw error
    })
    server.on('error', (error) => { this.deps.log(error) })
    this.server = server
    this.authority = `${host}:${String(bound)}`
    this.origin = `https://${this.authority}`
  }

  /**
   * Close the listener and every connection it tracks; later requests on
   * in-flight sockets fail at the TLS layer. A bind still in flight settles
   * first, so stop never races a listener it has not seen. Idempotent.
   */
  async stop(): Promise<void> {
    const starting = this.starting
    if (starting !== undefined) {
      // A failed bind leaves nothing to close; its rejection is the caller's.
      await starting.catch(() => undefined)
    }
    const server = this.server
    if (server === undefined) return
    this.server = undefined
    this.authority = undefined
    this.origin = undefined
    const closed = new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    server.closeAllConnections()
    const socketsClosed = [...this.tlsConnections].map(socket => new Promise<void>((resolve) => {
      socket.once('close', () => { resolve() })
      socket.destroy()
    }))
    await Promise.all([closed, ...socketsClosed])
    this.tlsConnections.clear()
    this.deps.limiter.reset()
  }

  /** Route one admitted-carrier request; every failure answers, never throws. */
  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.server === undefined || this.origin === undefined || this.authority === undefined || !this.deps.isReady()) {
      writeJsonResponse(res, 503, { error: 'not-ready' })
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
      writeJsonResponse(res, 405, { error: 'method-not-allowed' }, { allow: ALLOWED_METHODS })
      return
    }
    const fence = requestFenceFailure(req.headers, this.authority)
    if (fence !== undefined) {
      writeJsonResponse(res, 403, { error: 'forbidden' })
      return
    }
    /* v8 ignore next 2 -- node:http always sets url on server requests. */
    const target = new URL(req.url ?? '/', this.origin)
    if (target.pathname === '/mobile/pair') return this.servePair(req, res)
    if (target.pathname === '/mobile/pair/status') return this.servePairStatus(req, res)
    if (target.pathname === '/mobile/session') return this.serveSession(req, res)
    if (target.pathname === '/api' || target.pathname.startsWith('/api/')) return this.serveApi(req, res)
    if (req.method === 'GET' || req.method === 'HEAD') return this.serveResource(req, res)
    writeJsonResponse(res, 404, { error: 'not-found' })
  }

  /** Public pair claim; rate-limited per remote address and strictly validated. */
  private async servePair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      writeJsonResponse(res, 405, { error: 'method-not-allowed' }, { allow: ALLOWED_METHODS })
      return
    }
    if (!this.deps.limiter.push(req.socket.remoteAddress ?? 'unknown', this.deps.now())) {
      writeJsonResponse(res, 429, { error: 'rate-limited' })
      return
    }
    const body = await readJsonBody(req, this.deps.maxPairBodyBytes)
    if (this.server === undefined || !this.deps.isReady()) {
      writeJsonResponse(res, 503, { error: 'not-ready' })
      return
    }
    if (!body.ok) {
      writeJsonResponse(res, body.reason === 'too-large' ? 413 : 400,
        { error: body.reason === 'too-large' ? 'body-too-large' : 'body-invalid' },
        body.reason === 'too-large' ? { connection: 'close' } : {})
      if (body.reason === 'too-large') req.resume()
      return
    }
    const parsed = pairBodySchema.safeParse(body.value)
    if (!parsed.success) {
      writeJsonResponse(res, 400, { error: 'body-invalid' })
      return
    }
    const claim = this.deps.pairing.claim(
      parsed.data.invitationToken, parsed.data.requestId, parsed.data.deviceName, parsed.data.secret, this.deps.now())
    if (claim.kind === 'refused') {
      writeJsonResponse(res, 403, { error: 'pairing-refused' })
      return
    }
    writeJsonResponse(res, 200, {
      requestId: parsed.data.requestId,
      verificationCode: claim.verificationCode,
      status: 'pending',
      expiresAt: claim.expiresAt,
      serverName: this.deps.serverName,
    })
  }

  /** Public status poll; an unknown request and a wrong secret answer alike. */
  private async servePairStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      writeJsonResponse(res, 405, { error: 'method-not-allowed' }, { allow: ALLOWED_METHODS })
      return
    }
    if (!this.deps.limiter.push(req.socket.remoteAddress ?? 'unknown', this.deps.now())) {
      writeJsonResponse(res, 429, { error: 'rate-limited' })
      return
    }
    const body = await readJsonBody(req, this.deps.maxPairBodyBytes)
    if (this.server === undefined || !this.deps.isReady()) {
      writeJsonResponse(res, 503, { error: 'not-ready' })
      return
    }
    if (!body.ok) {
      writeJsonResponse(res, body.reason === 'too-large' ? 413 : 400,
        { error: body.reason === 'too-large' ? 'body-too-large' : 'body-invalid' },
        body.reason === 'too-large' ? { connection: 'close' } : {})
      if (body.reason === 'too-large') req.resume()
      return
    }
    const parsed = pairStatusBodySchema.safeParse(body.value)
    if (!parsed.success) {
      writeJsonResponse(res, 400, { error: 'body-invalid' })
      return
    }
    const status = this.deps.pairing.statusOf(parsed.data.requestId, parsed.data.secret, this.deps.now())
    if (status.kind === 'unknown') {
      writeJsonResponse(res, 403, { error: 'unknown-request' })
      return
    }
    writeJsonResponse(res, 200, {
      status: status.status,
      ...(status.status === 'approved' && status.deviceId !== undefined ? { deviceId: status.deviceId } : {}),
      ...(status.status === 'pending' ? { verificationCode: status.verificationCode } : {}),
      expiresAt: status.expiresAt,
      serverName: this.deps.serverName,
    })
  }

  /** Authenticated session probe; also (re)issues the session cookie. */
  private async serveSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') {
      writeJsonResponse(res, 405, { error: 'method-not-allowed' }, { allow: ALLOWED_METHODS })
      return
    }
    const admitted = await this.deps.authenticate(req.headers)
    if (this.server === undefined || !this.deps.isReady()) {
      writeJsonResponse(res, 503, { error: 'not-ready' })
      return
    }
    if (admitted === undefined) {
      writeJsonResponse(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer realm="hemi-mobile"' })
      return
    }
    const cookie = `${MOBILE_SESSION_COOKIE}=${admitted.deviceId}.${admitted.secret}; Secure; HttpOnly; SameSite=Strict; Path=/`
    writeJsonResponse(res, 200, { version: 1, deviceId: admitted.deviceId, serverName: this.deps.serverName }, { 'set-cookie': cookie })
  }

  /** `/api` traffic: authenticate, then ride shared admission and the bridge. */
  private async serveApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const admitted = await this.deps.authenticate(req.headers)
    if (this.server === undefined || !this.deps.isReady()) {
      writeJsonResponse(res, 503, { error: 'not-ready' })
      return
    }
    if (admitted === undefined) {
      writeJsonResponse(res, 401, { error: 'unauthorized' })
      return
    }
    try {
      await this.deps.serveApi(req, res, admitted.peer)
    } catch (error) {
      this.deps.log(error)
      if (!res.headersSent) writeJsonResponse(res, 502, { error: 'api-unavailable' })
      else res.destroy()
    }
  }

  /** Other GET/HEAD: registered resources only, read as the device Peer. */
  private async serveResource(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const admitted = await this.deps.authenticate(req.headers)
    if (this.server === undefined || !this.deps.isReady()) {
      writeJsonResponse(res, 503, { error: 'not-ready' })
      return
    }
    if (admitted === undefined) {
      writeJsonResponse(res, 401, { error: 'unauthorized' })
      return
    }
    const headers = new Headers()
    for (const name of RESOURCE_REQUEST_HEADERS) {
      const value = req.headers[name]
      if (typeof value === 'string') headers.set(name, value)
    }
    /* v8 ignore next 2 -- node:http always sets url and method on server requests. */
    const url = `${this.origin ?? 'https://mobile.invalid'}${req.url ?? '/'}`
    const response = await this.deps.readResource(new Request(url, { method: req.method ?? 'GET', headers }), admitted.peer)
    await writeFetchResponse(res, response, req.method === 'HEAD')
  }

  /** The single upgrade path: authenticated devices transfer to the mux. */
  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (this.server === undefined || this.origin === undefined || !this.deps.isReady()) {
      refuseUpgrade(socket, 503)
      return
    }
    let pathname: string
    try {
      /* v8 ignore next 2 -- node:http always sets url on server requests. */
      pathname = new URL(req.url ?? '/', this.origin).pathname
    } catch (error) {
      this.deps.log(error)
      socket.destroy()
      return
    }
    if (pathname !== this.deps.websocketPath) {
      refuseUpgrade(socket, 404)
      return
    }
    if (requestFenceFailure(req.headers, this.authority ?? '') !== undefined) {
      refuseUpgrade(socket, 403)
      return
    }
    void this.deps.authenticate(req.headers).then((admitted) => {
      if (socket.destroyed) return
      if (this.server === undefined || !this.deps.isReady()) {
        refuseUpgrade(socket, 503)
        return
      }
      if (admitted === undefined) {
        refuseUpgrade(socket, 401)
        return
      }
      this.deps.acceptUpgrade(req, socket, head, admitted.peer)
    }).catch((error: unknown) => {
      this.deps.log(error)
      refuseUpgrade(socket, 503)
    })
  }
}

/**
 * Read the device credential a request carries, preferring the Authorization
 * header; callers decide admission from the record lookup.
 * @param headers - request headers.
 * @returns the presented credential when either channel parses.
 */
export function presentedCredential(headers: IncomingMessage['headers']): DeviceCredential | undefined {
  return parseBearerCredential(headers.authorization) ?? parseCookieCredential(headers.cookie)
}
