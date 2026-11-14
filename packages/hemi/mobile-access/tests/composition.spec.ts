/**
 * Loader-shaped composition with real Host services: the Connection bridge,
 * the Typert Gateway and its mux, the real webServer, and this package's
 * service behind its real TLS listener. The phone drives the whole wire
 * protocol; the desktop owner drives management through an owner invocation.
 */

import { connect as tlsConnect } from 'node:tls'
import { randomUUID } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { CredentialProvider, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { apply as connectionApply, inject as connectionInject } from '@deepseek-ai/dsh-client-connection'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type { PeerScope, RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import HemiMobileAccess from '../src/index.ts'
import type { MobileRequestId } from '../src/types.ts'

/** In-memory credential provider backing every real service in this composition. */
class MemoryCredentials extends CredentialProvider {
  private readonly stored = new Map<string, CredentialRecord>()

  async readRecord(key: { toString(): string }): Promise<CredentialRecord | undefined> {
    return this.stored.get(String(key))
  }

  async modifyRecord(
    key: { toString(): string },
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const current = this.stored.get(String(key))
    const next = await mutate(current)
    if (next === undefined) return current
    this.stored.set(String(key), next)
    return next
  }

  async deleteRecord(key: { toString(): string }): Promise<void> {
    this.stored.delete(String(key))
  }

  async resolve(): Promise<undefined> { return undefined }
  async describe(): Promise<never> { throw new Error('unused in this composition') }
  async set(): Promise<void> { throw new Error('unused in this composition') }
  async unset(): Promise<void> { throw new Error('unused in this composition') }
  async describeRecord(): Promise<never> { throw new Error('unused in this composition') }
  async listRecords(): Promise<[]> { return [] }
}

/** Deterministic-address service subclass so the composition binds loopback. */
class SpecService extends HemiMobileAccess {
  protected override enumerateAddresses(): readonly [{ address: '127.0.0.1'; interface: 'lo'; scope: 'private' }] {
    return [{ address: '127.0.0.1', interface: 'lo', scope: 'private' }]
  }
}

interface Reply {
  status: number
  headers: Record<string, string | string[] | undefined>
  text: string
}

function call(
  origin: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(new URL(path, origin), {
      method: options.method ?? 'GET',
      headers: options.headers,
      rejectUnauthorized: false,
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk) => { chunks.push(chunk as Buffer) })
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') })
      })
    })
    request.on('error', reject)
    if (options.body !== undefined) request.write(options.body)
    request.end()
  })
}

/**
 * Raw TLS upgrade exchange. Resolves the first response line and a reader for
 * the first WebSocket frame opcode after the handshake: a bare socket cannot
 * complete the close handshake, so the test reads the server's close frame
 * instead of awaiting a TCP close.
 */
function upgrade(
  origin: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ line: string; closeFrame: Promise<boolean>; done: () => void }> {
  return new Promise((resolve, reject) => {
    const url = new URL(origin)
    const socket = tlsConnect({ host: url.hostname, port: Number(url.port), rejectUnauthorized: false }, () => {
      socket.write(`GET ${path} HTTP/1.1\r\nhost: ${url.host}\r\nconnection: Upgrade\r\nupgrade: websocket\r\nsec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n${Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join('')}\r\n`)
    })
    socket.setEncoding('binary')
    let head = ''
    let frames = ''
    let resolveClose: ((seen: boolean) => void) | undefined
    const closeFrame = new Promise<boolean>((resolvePromise) => { resolveClose = resolvePromise })
    const onData = (chunk: string): void => {
      const separator = '\r\n\r\n'
      if (head.length < separator.length || !head.includes(separator)) {
        head += chunk
        if (!head.includes(separator)) return
        const line = head.slice(0, head.indexOf('\r\n'))
        const rest = head.slice(head.indexOf(separator) + separator.length)
        frames += rest
        resolve({ line, closeFrame, done: () => { socket.destroy() } })
        return
      }
      frames += chunk
      checkFrames()
    }
    const checkFrames = (): void => {
      // One close control frame is opcode 0x8 in the low nibble of the first byte.
      if (frames.length > 0 && (frames.charCodeAt(0) & 0x0f) === 0x8) {
        resolveClose?.(true)
        resolveClose = undefined
      }
    }
    socket.on('data', onData)
    socket.on('error', reject)
  })
}

interface Composition {
  readonly owner: <T>(method: string, run: (service: HemiMobileAccess) => Promise<T>) => Promise<T>
  close(): Promise<void>
}

async function compose(): Promise<Composition> {
  const ctx = new Context()
  new MemoryCredentials(ctx)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccessService)
  await ctx.plugin(TypertGatewayService, {
    websocketHeartbeatIntervalMs: 2_000,
    streamInboxBytes: 262_144,
    websocketCompression: 'none',
  })
  await ctx.plugin({ apply: connectionApply, inject: connectionInject })
  ctx.webServer.register({
    kind: 'exact',
    path: '/probe.txt',
    resource: async (request: Request, peer?: PeerScope) => peer === undefined
      ? new Response('unauthorized', { status: 401 })
      : new Response(`resource ${new URL(request.url).pathname} for ${peer.principal.kind}`, { headers: { 'content-type': 'text/plain' } }),
  })
  const fiber = await ctx.plugin(SpecService, { port: 0, serverName: 'composition-host' })
  const invocationFor = (method: string): RemoteInvocation => ({
    request: { namespace: 'hemiMobileAccess', method, args: {} },
    service: 'hemiMobileAccess',
    peer: ctx.connection.browserPeer,
    signal: new AbortController().signal,
    uplink: () => { throw new Error('this composition sends no uplink') },
  })
  return {
    owner: async (method, run) => {
      const service = ctx.extend({ invocation: invocationFor(method) }).get('hemiMobileAccess')
      if (service === undefined) throw new Error('hemiMobileAccess was not mounted')
      return run(service)
    },
    close: async () => { await fiber.dispose(); await ctx.fiber.dispose() },
  }
}

const SIGNAL = new AbortController().signal

describe('HemiMobileAccess real composition', () => {
  it('pairs a phone over real TLS and keeps management on the desktop', async () => {
    const composition = await compose()
    try {
      const started = await composition.owner('start', service => service.start(SIGNAL))
      expect(started.listening).toBe(true)
      const origin = started.origin ?? ''

      const { invitation } = await composition.owner('createInvitation', service => service.createInvitation(SIGNAL))
      expect(invitation.origin).toBe(origin)
      expect(invitation.fingerprint).toMatch(/^[0-9a-f]{64}$/)

      // Phone claims the invitation over the real TLS listener.
      const requestId = randomUUID()
      const secret = 'c'.repeat(43)
      const claim = await call(origin, '/mobile/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: 1, invitationToken: invitation.token, requestId, deviceName: 'iPhone', secret }),
      })
      expect(claim.status).toBe(200)
      const claimed = JSON.parse(claim.text) as { verificationCode: string; status: string; serverName: string }
      expect(claimed).toMatchObject({ status: 'pending', serverName: 'composition-host' })
      expect(claimed.verificationCode).toMatch(/^\d{6}$/)

      // A second phone cannot reuse the consumed invitation.
      const secondClaim = await call(origin, '/mobile/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: 1, invitationToken: invitation.token, requestId: randomUUID(), deviceName: 'Evil', secret: 'e'.repeat(43) }),
      })
      expect(secondClaim.status).toBe(403)

      // The owner approves after comparing the codes both screens show.
      const approved = await composition.owner('approve', service => service.approve(
        brandString<MobileRequestId>(requestId), claimed.verificationCode, SIGNAL))
      expect(approved.requests[0]).toMatchObject({ status: 'approved' })
      const device = approved.devices[0]
      expect(device?.name).toBe('iPhone')

      // The phone learns its device id and a session cookie.
      const status = await call(origin, '/mobile/pair/status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId, secret }),
      })
      expect(JSON.parse(status.text)).toMatchObject({ status: 'approved', deviceId: device?.deviceId })
      const session = await call(origin, '/mobile/session', { headers: { authorization: `Bearer ${device?.deviceId}.${secret}` } })
      expect(session.status).toBe(200)
      expect(JSON.parse(session.text)).toEqual({ version: 1, deviceId: device?.deviceId, serverName: 'composition-host' })
      const cookie = `__Host-hemi-mobile=${device?.deviceId}.${secret}`
      expect(session.headers['set-cookie']).toEqual([`${cookie}; Secure; HttpOnly; SameSite=Strict; Path=/`])

      // The phone's Remote call reaches the real Gateway and is refused management.
      const rpc = await call(origin, '/api/hemiMobileAccess/getState', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${device?.deviceId}.${secret}` },
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'hemiMobileAccess/getState', payload: { args: {} } }),
      })
      expect(rpc.status).toBe(200)
      expect(JSON.parse(rpc.text)).toMatchObject({
        type: 'server-response',
        result: { ok: false, error: { code: 'hemi-mobile/unauthorized' } },
      })

      // Registered resources answer for the device Peer; unauthenticated reads do not.
      const resource = await call(origin, '/probe.txt', { headers: { cookie } })
      expect(resource.status).toBe(200)
      expect(resource.text).toBe('resource /probe.txt for owner')
      expect((await call(origin, '/probe.txt')).status).toBe(401)

      // The phone's WebSocket joins the real Gateway mux and closes on revoke.
      const mux = await upgrade(origin, '/api/remote.mux', { cookie })
      expect(mux.line).toContain('101')
      await composition.owner('revoke', service => service.revoke(device!.deviceId, SIGNAL))
      await expect(mux.closeFrame).resolves.toBe(true)
      mux.done()
      expect((await call(origin, '/mobile/session', { headers: { authorization: `Bearer ${device?.deviceId}.${secret}` } })).status).toBe(401)
      const revokedRpc = await call(origin, '/api/hemiMobileAccess/getState', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${device?.deviceId}.${secret}` },
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'hemiMobileAccess/getState', payload: { args: {} } }),
      })
      expect(revokedRpc.status).toBe(401)

      // Stopping closes the listener and the same port restarts later.
      const stopped = await composition.owner('stop', service => service.stop(SIGNAL))
      expect(stopped).toMatchObject({ listening: false, origin: null })
      await expect(call(origin, '/mobile/session')).rejects.toThrow()
      const restarted = await composition.owner('start', service => service.start(SIGNAL))
      expect(restarted.origin).toBe(origin)
    } finally {
      await composition.close()
    }
  })
})
