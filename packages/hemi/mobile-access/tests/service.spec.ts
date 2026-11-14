/** Service lifecycle barriers: serialized start/stop/dispose, management authorization, and restart semantics. */

import { connect as tlsConnect } from 'node:tls'
import { request as tlsRequest } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider, credentialKey, type CredentialKey, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { PeerId, PeerScope, RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import HemiMobileAccess from '../src/index.ts'

/** In-memory credential provider whose next TLS-record read can be parked on a gate. */
class GatedCredentials extends CredentialProvider {
  readonly records = new Map<string, CredentialRecord>()
  readCount = 0
  private readonly gates: Array<PromiseWithResolvers<CredentialRecord | undefined>> = []
  private listenerWriteGate: {
    entered: PromiseWithResolvers<{ host: string; port: number }>
    release: PromiseWithResolvers<undefined>
  } | undefined

  holdListenerWrite() {
    const gate = { entered: Promise.withResolvers<{ host: string; port: number }>(), release: Promise.withResolvers<undefined>() }
    this.listenerWriteGate = gate
    return gate
  }

  /** Park the next readRecord call, whatever key it asks for. */
  holdNextRead(): PromiseWithResolvers<CredentialRecord | undefined> {
    const gate = Promise.withResolvers<CredentialRecord | undefined>()
    this.gates.push(gate)
    return gate
  }

  async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    this.readCount += 1
    const gate = this.gates.shift()
    if (gate !== undefined) return gate.promise
    return this.records.get(String(key))
  }

  async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const current = this.records.get(String(key))
    const next = await mutate(current)
    if (next === undefined) return current
    const gate = this.listenerWriteGate
    if (String(key).endsWith('/listener') && gate !== undefined) {
      this.listenerWriteGate = undefined
      const payload = next.kind === 'grant' ? next.payload : undefined
      if (typeof payload !== 'object' || payload === null || !('host' in payload) || typeof payload.host !== 'string'
        || !('port' in payload) || typeof payload.port !== 'number') throw new Error('invalid listener fixture record')
      gate.entered.resolve({ host: payload.host, port: payload.port })
      await gate.release.promise
    }
    this.records.set(String(key), next)
    return next
  }

  async deleteRecord(key: CredentialKey): Promise<void> {
    this.records.delete(String(key))
  }

  async resolve(): Promise<undefined> { return undefined }
  async describe(): Promise<never> { throw new Error('not used in this spec') }
  async set(): Promise<void> { throw new Error('not used in this spec') }
  async unset(): Promise<void> { throw new Error('not used in this spec') }
  async describeRecord(): Promise<never> { throw new Error('not used in this spec') }
  async listRecords(): Promise<[]> { return [] }
}

/** Disposable fake Peer recording its disposal. */
class FakePeer implements PeerScope {
  readonly id: PeerId = randomUUID() as PeerId
  readonly ctx = undefined as never
  readonly principal = { kind: 'owner' } as const
  readonly signal = new AbortController().signal
  readonly interactions = 'answer' as const
  disposed = false

  dispose(): Promise<void> {
    this.disposed = true
    return Promise.resolve()
  }
}

interface Fixture {
  readonly ctx: Context
  readonly owner: Context
  readonly other: Context
  readonly credentials: GatedCredentials
  readonly browserPeer: FakePeer
  readonly phonePeers: FakePeer[]
  service(): Promise<HemiMobileAccess>
  dispose(): Promise<void>
}

/** Deterministic-address service subclass so the spec binds loopback. */
class SpecService extends HemiMobileAccess {
  protected override enumerateAddresses(): readonly [{ address: '127.0.0.1'; interface: 'lo'; scope: 'private' }] {
    return [{ address: '127.0.0.1', interface: 'lo', scope: 'private' }]
  }
}

class NoNetworkService extends HemiMobileAccess {
  protected override enumerateAddresses(): readonly [] { return [] }
}

async function fixture(Plugin: typeof HemiMobileAccess = SpecService): Promise<Fixture> {
  const ctx = new Context()
  const credentials = new GatedCredentials(ctx)
  const browserPeer = new FakePeer()
  const phonePeers: FakePeer[] = []
  ctx.provide('connection', {
    browserPeer,
    createPeer: () => {
      const peer = new FakePeer()
      phonePeers.push(peer)
      return peer
    },
    createSharedFetchHandler: () => ({ requestBodyMode: () => 'buffered' as const, fetch: async () => new Response(null, { status: 404 }) }),
    serveHttp: async (_request: IncomingMessage, response: ServerResponse) => { response.writeHead(501); response.end() },
  })
  ctx.provide('typertGateway', { websocket: { acceptUpgrade: () => {}, path: '/api/remote.mux' } })
  ctx.provide('webServer', { readResource: async () => new Response(null, { status: 404 }) })
  const fiber = await ctx.plugin(Plugin, { port: 0, pairRequestsPerMinute: 1000, serverName: 'spec-host' })
  const invocationFor = (peer: PeerScope): RemoteInvocation => ({
    request: { namespace: 'hemiMobileAccess', method: 'getState', args: {} },
    service: 'hemiMobileAccess',
    peer,
    signal: new AbortController().signal,
    uplink: () => { throw new Error('this spec sends no uplink') },
  })
  return {
    ctx,
    owner: ctx.extend({ invocation: invocationFor(browserPeer) }),
    other: ctx.extend({ invocation: invocationFor(new FakePeer()) }),
    credentials,
    browserPeer,
    phonePeers,
    service: async () => {
      const service = ctx.get('hemiMobileAccess')
      if (service === undefined) throw new Error('hemiMobileAccess was not mounted')
      return service
    },
    dispose: async () => { await fiber.dispose() },
  }
}

const SIGNAL = new AbortController().signal

/** GET by default; an explicit body sends JSON POST over the listener's real TLS channel. */
function tlsStatus(origin: string, path: string, headers: Record<string, string>, body?: object): Promise<{ status: number }> {
  const content = body === undefined ? undefined : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const request = tlsRequest(new URL(path, origin), {
      method: content === undefined ? 'GET' : 'POST', rejectUnauthorized: false,
      headers: { ...headers, ...(content === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(content) }) },
    }, (response) => {
      response.resume()
      response.on('end', () => { resolve({ status: response.statusCode ?? 0 }) })
    })
    request.on('error', reject)
    request.end(content)
  })
}

/** Whether the given origin still accepts TLS connections. */
function reachable(origin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const url = new URL(origin)
    const socket = tlsConnect({ host: url.hostname, port: Number(url.port), rejectUnauthorized: false, timeout: 500 }, () => {
      socket.destroy()
      resolve(true)
    })
    socket.on('error', () => { resolve(false) })
    socket.on('timeout', () => { socket.destroy(); resolve(false) })
  })
}

describe('HemiMobileAccess management authorization', () => {
  it('answers only the desktop browser owner Peer', async () => {
    const fx = await fixture()
    try {
      await expect(fx.owner.get('hemiMobileAccess')?.getState(SIGNAL)).resolves.toMatchObject({ listening: false, origin: null })
      await expect(fx.other.get('hemiMobileAccess')?.getState(SIGNAL)).rejects.toMatchObject({ code: 'hemi-mobile/unauthorized' })
      await expect(fx.ctx.get('hemiMobileAccess')?.getState(SIGNAL)).rejects.toMatchObject({ code: 'hemi-mobile/unauthorized' })
    } finally {
      await fx.dispose()
    }
  })
})

describe('HemiMobileAccess automatic network admission', () => {
  it('refuses an unavailable network without asking for a host', async () => {
    const fx = await fixture(NoNetworkService)
    try {
      const service = fx.owner.get('hemiMobileAccess')
      if (service === undefined) throw new Error('missing service')
      await expect(service.start(SIGNAL)).rejects.toMatchObject({ code: 'hemi-mobile/no-network' })
      await expect(service.getState(SIGNAL)).resolves.toMatchObject({ listening: false, origin: null })
    } finally { await fx.dispose() }
  })

  it('returns 503 on a bound socket until the listener record is committed', async () => {
    const fx = await fixture()
    const gate = fx.credentials.holdListenerWrite()
    try {
      const service = fx.owner.get('hemiMobileAccess')
      if (service === undefined) throw new Error('missing service')
      const starting = service.start(SIGNAL)
      const bound = await gate.entered.promise
      const origin = `https://${bound.host}:${String(bound.port)}`
      await expect(tlsStatus(origin, '/mobile/session', {})).resolves.toEqual({ status: 503 })
      await expect(service.getState(SIGNAL)).resolves.toMatchObject({ listening: false, origin: null })
      gate.release.resolve(undefined)
      await expect(starting).resolves.toMatchObject({ listening: true })
      await expect(tlsStatus(origin, '/mobile/session', {})).resolves.toEqual({ status: 401 })
    } finally {
      gate.release.resolve(undefined)
      await fx.dispose()
    }
  })
})

describe('HemiMobileAccess lifecycle barriers', () => {
  it('restarts after a normal stop and reuses the persisted port', async () => {
    const fx = await fixture()
    try {
      const started = await fx.owner.get('hemiMobileAccess')?.start(SIGNAL)
      expect(started?.listening).toBe(true)
      expect(started?.origin).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/)
      const origin = started?.origin ?? ''
      const stopped = await fx.owner.get('hemiMobileAccess')?.stop(SIGNAL)
      expect(stopped).toMatchObject({ listening: false, origin: null, lastListener: { host: '127.0.0.1', port: Number(new URL(origin).port) } })
      await expect(reachable(origin)).resolves.toBe(false)
      const restarted = await fx.owner.get('hemiMobileAccess')?.start(SIGNAL)
      expect(restarted?.origin).toBe(origin)
    } finally {
      await fx.dispose()
    }
  })

  it('refuses a concurrent second start and leaves exactly one listener', async () => {
    const fx = await fixture()
    try {
      const service = fx.owner.get('hemiMobileAccess')
      if (service === undefined) throw new Error('missing service')
      const first = service.start(SIGNAL)
      const second = service.start(SIGNAL)
      await expect(first).resolves.toMatchObject({ listening: true })
      await expect(second).rejects.toMatchObject({ code: 'hemi-mobile/already-listening' })
      const state = await service.getState(SIGNAL)
      if (state.origin === null) throw new Error('listener origin missing')
      await expect(reachable(state.origin)).resolves.toBe(true)
      await service.stop(SIGNAL)
      await expect(reachable(state.origin)).resolves.toBe(false)
    } finally {
      await fx.dispose()
    }
  })

  it('does not mint a Peer when an old authentication read resumes after stop and restart', async () => {
    const fx = await fixture()
    const deferred: Array<PromiseWithResolvers<CredentialRecord | undefined>> = []
    try {
      const service = fx.owner.get('hemiMobileAccess')
      if (service === undefined) throw new Error('missing service')
      await service.start(SIGNAL)
      const { invitation } = await service.createInvitation(SIGNAL)
      const secret = 't'.repeat(43)
      const requestId = randomUUID()
      await tlsStatus(invitation.origin, '/mobile/pair', {}, {
        version: 1, invitationToken: invitation.token, requestId, deviceName: 'epoch phone', secret,
      })
      const row = (await service.getState(SIGNAL)).requests[0]
      if (row === undefined) throw new Error('pair request missing')
      const device = (await service.approve(row.requestId, row.verificationCode, SIGNAL)).devices[0]
      if (device === undefined) throw new Error('approved device missing')
      const key = credentialKey('hemi-mobile-access', 'devices')
      const record = fx.credentials.records.get(String(key))
      const baselineReads = fx.credentials.readCount
      deferred.push(fx.credentials.holdNextRead())
      fx.ctx.emit('credentials/record-updated', key)
      deferred.push(fx.credentials.holdNextRead())
      const credential = `Bearer ${device.deviceId}.${secret}`
      const oldRequest = tlsStatus(invitation.origin, '/mobile/session', { authorization: credential }).catch(() => ({ status: 0 }))
      await vi.waitFor(() => { expect(fx.credentials.readCount).toBe(baselineReads + 2) })
      await service.stop(SIGNAL)
      const restarted = await service.start(SIGNAL)
      if (restarted.origin === null) throw new Error('new group did not start')
      for (const gate of deferred) gate.resolve(record)
      await oldRequest
      // A new I/O exchange drains the old read's Promise continuations, without a fixed sleep.
      await tlsStatus(restarted.origin, '/mobile/session', {})
      expect(fx.phonePeers).toHaveLength(0)
      await expect(tlsStatus(restarted.origin, '/mobile/session', { authorization: credential })).resolves.toEqual({ status: 200 })
      expect(fx.phonePeers).toHaveLength(1)
    } finally {
      for (const gate of deferred) gate.resolve(undefined)
      await fx.dispose()
    }
  })

  it('makes stop join an in-flight start instead of completing beside it', async () => {
    const fx = await fixture()
    try {
      const gate = fx.credentials.holdNextRead()
      const service = fx.owner.get('hemiMobileAccess')
      if (service === undefined) throw new Error('missing service')
      const starting = service.start(SIGNAL)
      // Stop retires the pending start's generation before waiting for its cleanup.
      const stopping = service.stop(SIGNAL)
      gate.resolve(undefined)
      await expect(starting).rejects.toMatchObject({ code: 'hemi-mobile/listen-failed' })
      await expect(stopping).resolves.toMatchObject({ listening: false })
      const state = await service.getState(SIGNAL)
      if (state.origin !== null) throw new Error('listener survived stop')
      // The carrier still restarts afterwards on the same address.
      await expect(service.start(SIGNAL)).resolves.toMatchObject({ listening: true })
    } finally {
      await fx.dispose()
    }
  })

  it('closes a listener whose start raced plugin disposal', async () => {
    const fx = await fixture()
    const gate = fx.credentials.holdNextRead()
    const service = fx.owner.get('hemiMobileAccess')
    if (service === undefined) throw new Error('missing service')
    const starting = service.start(SIGNAL)
    const disposing = fx.dispose()
    gate.resolve(undefined)
    await expect(starting).rejects.toMatchObject({ code: 'hemi-mobile/listen-failed' })
    await disposing
  })
})

describe('HemiMobileAccess pairing management', () => {
  it('gates the invitation on the listener and publishes approval only with the right code', async () => {
    const fx = await fixture()
    try {
      const service = fx.owner.get('hemiMobileAccess')
      if (service === undefined) throw new Error('missing service')
      await expect(service.createInvitation(SIGNAL)).rejects.toMatchObject({ code: 'hemi-mobile/not-listening' })
      await service.start(SIGNAL)
      const { invitation, state } = await service.createInvitation(SIGNAL)
      expect(invitation).toMatchObject({ kind: 'hemi-dsh-mobile', version: 1 })
      expect(invitation.origin).toBe(state.origin)
      expect(JSON.stringify(state.invitation)).not.toContain(invitation.token)
      const requestId = '12345678-1234-4123-8123-123456789abc'
      const secret = 'c'.repeat(43)
      await expect(tlsStatus(invitation.origin, '/mobile/pair', {}, {
        version: 1, invitationToken: invitation.token, requestId, deviceName: 'iPhone', secret,
      })).resolves.toEqual({ status: 200 })
      const pending = await service.getState(SIGNAL)
      const row = pending.requests.find(request => String(request.requestId) === requestId)
      const wrongCode = row!.verificationCode === '000000' ? '000001' : '000000'
      await expect(service.approve(row!.requestId, wrongCode, SIGNAL)).rejects.toMatchObject({ code: 'hemi-mobile/wrong-code' })
      await expect(service.approve(row!.requestId, row!.verificationCode, SIGNAL)).resolves.toMatchObject({
        requests: [expect.objectContaining({ status: 'approved', requestId: row!.requestId })],
        devices: [expect.objectContaining({ name: 'iPhone' })],
      })
      const device = (await service.getState(SIGNAL)).devices[0]
      if (device === undefined) throw new Error('device missing')
      await expect(service.reject(row!.requestId, SIGNAL)).rejects.toMatchObject({ code: 'hemi-mobile/request-not-found' })
      // One authenticated request through the real listener creates the device Peer.
      if (pending.origin === null) throw new Error('listener origin missing')
      const session = await tlsStatus(pending.origin, '/mobile/session', { authorization: `Bearer ${device.deviceId}.${secret}` })
      expect(session.status).toBe(200)
      expect(fx.phonePeers).toHaveLength(1)
      // Revocation disposes the device Peer and removes the record.
      await expect(service.revoke(device.deviceId, SIGNAL)).resolves.toMatchObject({ devices: [] })
      expect(fx.phonePeers.filter(peer => peer.disposed)).toHaveLength(1)
      await expect(service.revoke(device.deviceId, SIGNAL)).rejects.toMatchObject({ code: 'hemi-mobile/device-not-found' })
      expect((await tlsStatus(pending.origin, '/mobile/session', { authorization: `Bearer ${device.deviceId}.${secret}` })).status).toBe(401)
    } finally {
      await fx.dispose()
    }
  })
})
