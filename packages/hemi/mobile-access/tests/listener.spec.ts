/** Listener behavior over a real TLS listener on loopback: fences, pairing, device admission, and routing. */

import { connect as tlsConnect } from 'node:tls'
import { request as httpsRequest } from 'node:https'
import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { brandString } from '@deepseek-ai/dsh-brand'
import { AddressRateLimiter } from '../src/internal/net.ts'
import { PairingEngine } from '../src/internal/pairing.ts'
import { generateTlsMaterial } from '../src/internal/tls.ts'
import { deviceSecretMatches, hashDeviceSecret } from '../src/internal/wire.ts'
import { MobileTlsListener, presentedCredential, type MobileListenerDeps } from '../src/listener.ts'

const DEVICE_ID = '44444444-4444-4444-8444-444444444444'
const DEVICE_SECRET = 's'.repeat(43)
const REQUEST_ID = '11111111-1111-4111-8111-111111111111'
const PEER: PeerScope = {
  id: brandString<PeerId>('listener-spec-peer'),
  ctx: undefined as never,
  principal: { kind: 'owner' },
  signal: new AbortController().signal,
  interactions: 'answer',
  dispose: () => Promise.resolve(),
}

interface TestSurface {
  readonly listener: MobileTlsListener
  readonly origin: string
  readonly authority: string
  readonly pairing: PairingEngine
  readonly apiPeers: PeerScope[]
  readonly resourceReads: Array<{ url: string; headers: Headers; peer: PeerScope }>
  readonly upgrades: Array<{ path: string; peer: PeerScope }>
  setReady(ready: boolean): void
  approveDevice(): void
  close(): Promise<void>
}

async function surface(options: { ready?: boolean; perMinute?: number } = {}): Promise<TestSurface> {
  const pairing = new PairingEngine(120_000, 300_000)
  const limiter = new AddressRateLimiter(60_000, options.perMinute ?? 100)
  const apiPeers: PeerScope[] = []
  const resourceReads: Array<{ url: string; headers: Headers; peer: PeerScope }> = []
  const upgrades: Array<{ path: string; peer: PeerScope }> = []
  let ready = options.ready ?? true
  let approved = false
  const deps: MobileListenerDeps = {
    authenticate: async (headers) => {
      const credential = presentedCredential(headers)
      if (credential === undefined || !approved || credential.deviceId !== DEVICE_ID) return undefined
      if (!deviceSecretMatches(credential.secret, hashDeviceSecret(DEVICE_SECRET))) return undefined
      return { deviceId: credential.deviceId, secret: credential.secret, peer: PEER }
    },
    pairing,
    serveApi: async (_request: IncomingMessage, response: ServerResponse, peer: PeerScope) => {
      apiPeers.push(peer)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ served: true }))
    },
    readResource: async (request: Request, peer: PeerScope) => {
      resourceReads.push({ url: request.url, headers: request.headers, peer })
      if (request.url.endsWith('/probe.txt')) return new Response('resource bytes', { headers: { 'content-type': 'text/plain' } })
      return new Response(null, { status: 404 })
    },
    acceptUpgrade: (request, _socket, _head, peer: PeerScope) => {
      upgrades.push({ path: new URL(request.url ?? '/', 'https://x').pathname, peer })
      _socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: upgrade\r\nsec-websocket-accept: fixture\r\n\r\n')
    },
    websocketPath: '/api/remote.mux',
    limiter,
    serverName: 'fixture-host',
    maxPairBodyBytes: 512,
    isReady: () => ready,
    now: () => 1_000,
    log: () => undefined,
  }
  const listener = new MobileTlsListener(deps)
  await listener.start('127.0.0.1', 0, generateTlsMaterial(['127.0.0.1'], 1_000))
  const port = listener.port
  if (port === undefined) throw new Error('listener did not bind')
  return {
    listener,
    origin: `https://127.0.0.1:${String(port)}`,
    authority: `127.0.0.1:${String(port)}`,
    pairing,
    apiPeers,
    resourceReads,
    upgrades,
    setReady: (value) => { ready = value },
    approveDevice: () => { approved = true },
    close: () => listener.stop(),
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
    }, (response: IncomingMessage) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk) => { chunks.push(chunk as Buffer) })
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        })
      })
    })
    request.on('error', reject)
    if (options.body !== undefined) request.write(options.body)
    request.end()
  })
}

/** Raw TLS upgrade exchange; resolves with the first response line. */
function upgrade(origin: string, path: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL(origin)
    const socket = tlsConnect({ host: url.hostname, port: Number(url.port), rejectUnauthorized: false }, () => {
      socket.write(`GET ${path} HTTP/1.1\r\nhost: ${url.host}\r\nconnection: Upgrade\r\nupgrade: websocket\r\nsec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n${Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join('')}\r\n`)
    })
    socket.setEncoding('utf8')
    let head = ''
    const onData = (chunk: string): void => {
      head += chunk
      const line = head.split('\r\n', 1)[0]
      if (line !== undefined && line.length > 0) {
        socket.off('data', onData)
        socket.destroy()
        resolve(line)
      }
    }
    socket.on('data', onData)
    socket.on('error', reject)
  })
}

describe('MobileTlsListener admission fences', () => {
  it('refuses everything while readiness has not committed', async () => {
    const fixture = await surface({ ready: false })
    try {
      expect((await call(fixture.origin, '/mobile/pair', { method: 'POST', body: '{}' })).status).toBe(503)
      expect(await upgrade(fixture.origin, '/api/remote.mux')).toContain('503')
    } finally {
      await fixture.close()
    }
  })

  it('refuses foreign Host, foreign Origin, cross-site fetch metadata, and unknown methods', async () => {
    const fixture = await surface()
    try {
      expect((await call(fixture.origin, '/mobile/session', { headers: { host: 'evil.example:1' } })).status).toBe(403)
      expect((await call(fixture.origin, '/mobile/session', { headers: { origin: 'https://evil.example' } })).status).toBe(403)
      expect((await call(fixture.origin, '/mobile/session', { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
      expect((await call(fixture.origin, '/mobile/session', { method: 'PUT' })).status).toBe(405)
    } finally {
      await fixture.close()
    }
  })
})

describe('MobileTlsListener public pairing endpoints', () => {
  it('refuses pairing before any invitation exists', async () => {
    const fixture = await surface()
    try {
      const reply = await call(fixture.origin, '/mobile/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: 1, invitationToken: 't'.repeat(43), requestId: REQUEST_ID, deviceName: 'iPhone', secret: DEVICE_SECRET }),
      })
      expect(reply.status).toBe(403)
      expect(JSON.parse(reply.text)).toEqual({ error: 'pairing-refused' })
    } finally {
      await fixture.close()
    }
  })

  it('answers a claim, repeats it idempotently, and refuses status polls with the wrong secret', async () => {
    const fixture = await surface({ perMinute: 6 })
    try {
      const token = fixture.pairing.createInvitation(fixture.origin, 'f'.repeat(64), 1_000).token
      const body = JSON.stringify({ version: 1, invitationToken: token, requestId: REQUEST_ID, deviceName: 'iPhone', secret: DEVICE_SECRET })
      const first = await call(fixture.origin, '/mobile/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      expect(first.status).toBe(200)
      const claimed = JSON.parse(first.text) as { verificationCode: string; status: string; serverName: string; requestId: string }
      expect(claimed).toMatchObject({ status: 'pending', serverName: 'fixture-host', requestId: REQUEST_ID })
      expect(claimed.verificationCode).toMatch(/^\d{6}$/)
      const repeated = await call(fixture.origin, '/mobile/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      expect(JSON.parse(repeated.text)).toEqual(claimed)
      const status = await call(fixture.origin, '/mobile/pair/status', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: REQUEST_ID, secret: DEVICE_SECRET }),
      })
      expect(JSON.parse(status.text)).toMatchObject({ status: 'pending', verificationCode: claimed.verificationCode, serverName: 'fixture-host' })
      const wrong = await call(fixture.origin, '/mobile/pair/status', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: REQUEST_ID, secret: 'o'.repeat(43) }),
      })
      expect(wrong.status).toBe(403)
    } finally {
      await fixture.close()
    }
  })

  it('rejects malformed bodies, unknown fields, oversized bodies, and bursts', async () => {
    const fixture = await surface({ perMinute: 6 })
    try {
      const token = fixture.pairing.createInvitation(fixture.origin, 'f'.repeat(64), 1_000).token
      const base = { 'content-type': 'application/json' }
      expect((await call(fixture.origin, '/mobile/pair', { method: 'POST', headers: base, body: 'not json' })).status).toBe(400)
      expect((await call(fixture.origin, '/mobile/pair', {
        method: 'POST', headers: base,
        body: JSON.stringify({ version: 1, invitationToken: token, requestId: REQUEST_ID, deviceName: 'iPhone', secret: DEVICE_SECRET, extra: true }),
      })).status).toBe(400)
      const oversized = 'x'.repeat(600)
      expect((await call(fixture.origin, '/mobile/pair', {
        method: 'POST', headers: { ...base, 'content-length': String(oversized.length) },
        body: JSON.stringify({ version: 1, invitationToken: token, requestId: REQUEST_ID, deviceName: 'iPhone', secret: oversized }),
      })).status).toBe(413)
      // The four allowed events are spent; the next pair call is refused before its body is read.
      for (let index = 0; index < 3; index += 1) {
        await call(fixture.origin, '/mobile/pair/status', { method: 'POST', headers: base, body: JSON.stringify({ requestId: REQUEST_ID, secret: DEVICE_SECRET }) })
      }
      const limited = await call(fixture.origin, '/mobile/pair', {
        method: 'POST', headers: base,
        body: JSON.stringify({ version: 1, invitationToken: token, requestId: REQUEST_ID, deviceName: 'iPhone', secret: DEVICE_SECRET }),
      })
      expect(limited.status).toBe(429)
      expect(JSON.parse(limited.text)).toEqual({ error: 'rate-limited' })
    } finally {
      await fixture.close()
    }
  })
})

describe('MobileTlsListener authenticated endpoints', () => {
  it('issues the exact session cookie for a bearer credential and refuses unauthenticated calls', async () => {
    const fixture = await surface()
    try {
      fixture.approveDevice()
      expect((await call(fixture.origin, '/mobile/session')).status).toBe(401)
      expect((await call(fixture.origin, '/mobile/session', { headers: { authorization: `Bearer ${DEVICE_ID}.wrong-secret-value-aaaaaaaaaaaaaaaaaaaa` } })).status).toBe(401)
      const session = await call(fixture.origin, '/mobile/session', { headers: { authorization: `Bearer ${DEVICE_ID}.${DEVICE_SECRET}` } })
      expect(session.status).toBe(200)
      expect(session.headers['set-cookie']).toEqual([
        `__Host-hemi-mobile=${DEVICE_ID}.${DEVICE_SECRET}; Secure; HttpOnly; SameSite=Strict; Path=/`,
      ])
      expect(JSON.parse(session.text)).toEqual({ version: 1, deviceId: DEVICE_ID, serverName: 'fixture-host' })
    } finally {
      await fixture.close()
    }
  })

  it('serves /api with the device Peer and reads resources without forwarding credentials', async () => {
    const fixture = await surface()
    try {
      fixture.approveDevice()
      const authorization = { authorization: `Bearer ${DEVICE_ID}.${DEVICE_SECRET}` }
      const api = await call(fixture.origin, '/api/session.list', {
        method: 'POST', headers: { ...authorization, 'content-type': 'application/json', cookie: `__Host-hemi-mobile=${DEVICE_ID}.${DEVICE_SECRET}` }, body: '{}',
      })
      expect(api.status).toBe(200)
      expect(JSON.parse(api.text)).toEqual({ served: true })
      expect(fixture.apiPeers).toEqual([PEER])
      const resource = await call(fixture.origin, '/probe.txt', { headers: { ...authorization, cookie: '__Host-hemi-mobile=stale', accept: 'text/plain' } })
      expect(resource.text).toBe('resource bytes')
      const read = fixture.resourceReads.at(-1)
      expect(read?.peer).toBe(PEER)
      expect(read?.headers.get('accept')).toBe('text/plain')
      expect(read?.headers.get('cookie')).toBeNull()
      expect(read?.headers.get('authorization')).toBeNull()
      expect((await call(fixture.origin, '/missing.txt', { headers: authorization })).status).toBe(404)
      expect((await call(fixture.origin, '/probe.txt')).status).toBe(401)
    } finally {
      await fixture.close()
    }
  })

  it('refuses upgrades off the mux path or unauthenticated, and transfers authenticated ones', async () => {
    const fixture = await surface()
    try {
      fixture.approveDevice()
      expect(await upgrade(fixture.origin, '/api/other.mux')).toContain('404')
      expect(await upgrade(fixture.origin, '/api/remote.mux')).toContain('401')
      expect(await upgrade(fixture.origin, '/api/remote.mux', { authorization: `Bearer ${DEVICE_ID}.${DEVICE_SECRET}` })).toContain('101')
      expect(fixture.upgrades).toEqual([{ path: '/api/remote.mux', peer: PEER }])
    } finally {
      await fixture.close()
    }
  })

  it('stops idempotently and reports no origin afterwards', async () => {
    const fixture = await surface()
    await fixture.close()
    await expect(fixture.close()).resolves.toBeUndefined()
    expect(fixture.listener.listenerOrigin).toBeUndefined()
    await expect(call(fixture.origin, '/mobile/session')).rejects.toThrow()
  })
})
