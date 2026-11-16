import { afterEach, expect, it, vi } from 'vitest'
import { connect } from 'node:net'
import type { Server } from 'node:http'
import { createHash } from 'node:crypto'
import { remoteErrorOf, type RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import { createVvcodeClient } from '../src/vvcode/api.ts'
import { loginVvcode } from '../src/vvcode/oauth.ts'

import type { VvcodeClient, VvcodeClientOptions } from '../src/vvcode/types.ts'

/** Every loopback listener created through the module under test, with its close settlement. */
const trackedServers = vi.hoisted(() => ({
  servers: [] as { server: Server; closed: Promise<boolean> }[],
}))

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>()
  const createServer = ((...args: Parameters<typeof actual.createServer>) => {
    const server = actual.createServer(...args)
    const closed = new Promise<boolean>((resolve) => {
      server.once('close', () => { resolve(true) })
      server.once('error', () => { resolve(false) })
    })
    trackedServers.servers.push({ server, closed })
    return server
  }) as typeof actual.createServer
  return { ...actual, createServer }
})

const ORIGIN = 'https://vvcode.example'
const EXPIRES_AT = Math.floor(Date.now() / 1000) + 3600
const TOKEN_RESPONSE = {
  access_token: 'nap_7Kd9mQ2pXwRtY5uZ8sB3vN6cJ1hG4fD0aL2eS5gU8iK',
  token_type: 'Bearer',
  expires_in: 3600,
  expires_at: EXPIRES_AT,
  scope: 'api_key:read api_key:reveal api_key:write profile:read',
  user_id: 123,
  username: 'vvcode-user',
  display_name: 'VVCode User',
  role: 1,
}
const OPTIONS: VvcodeClientOptions = {
  origin: ORIGIN,
  accessToken: 'nap_7Kd9mQ2pXwRtY5uZ8sB3vN6cJ1hG4fD0aL2eS5gU8iK',
  timeoutMs: 2000,
  maxResponseBytes: 65536,
  tokenPageLimit: 2,
  maxModels: 3,
}

interface RecordedRequest {
  url: string
  init: RequestInit | undefined
}

type FetchHandler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>

/**
 * Replace global fetch for external origins while passing loopback callback traffic through.
 * @param handler - Response source for every non-loopback request.
 * @returns the recorded non-loopback requests.
 */
function interceptFetch(handler: FetchHandler): RecordedRequest[] {
  const realFetch = globalThis.fetch.bind(globalThis)
  const requests: RecordedRequest[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init)
    requests.push({ url, init })
    return handler(url, init)
  })
  return requests
}

/**
 * Create one promise resolved from an event callback.
 * @returns the promise and its resolver.
 */
function defer<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

/**
 * Assert one promise rejects with a RemoteError carrying the expected code and details.
 * @param promise - The promise expected to reject.
 * @param code - Expected stable failure code.
 * @param details - Expected detail fields, matched partially.
 * @returns the failure for further assertions.
 */
async function expectRemote(
  promise: Promise<unknown>, code: string, details?: object,
): Promise<RemoteFailure> {
  let failure: RemoteFailure | undefined
  await promise.catch((error: unknown) => { failure = remoteErrorOf(error) })
  if (failure === undefined) throw new Error(`Expected a RemoteError with code ${code}.`)
  expect(failure.code).toBe(code)
  if (details !== undefined) expect(failure.details).toMatchObject(details)
  return failure
}

/**
 * Connect to a loopback port until it refuses, proving the listener released the socket.
 * @param port - Port the callback listener bound.
 */
async function expectPortClosed(port: number): Promise<void> {
  const deadline = Date.now() + 2000
  for (;;) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: '127.0.0.1', port })
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('error', () => { resolve(false) })
    })
    if (!open) return
    if (Date.now() > deadline) throw new Error(`The callback listener on port ${port} still accepts connections.`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/**
 * Bind one login up to the browser start URL. The login promise carries a no-op rejection handler
 * from creation so a rejection racing the test's own assertions never becomes unhandled.
 * @param overrides - Input overrides applied to the default login input.
 * @returns the login promise and the resolved start URL.
 */
function startLogin(overrides: Partial<Parameters<typeof loginVvcode>[0]> = {}): {
  login: Promise<unknown>
  startUrl: Promise<URL>
} {
  const notified = defer<string>()
  const login = loginVvcode({
    origin: ORIGIN,
    timeoutMs: 5000,
    maxResponseBytes: 65536,
    notifyURL: (url) => { notified.resolve(url) },
    ...overrides,
  })
  void login.catch(() => { /* The test's own assertion reads the rejection below. */ })
  return { login, startUrl: notified.promise.then(url => new URL(url)) }
}

/** Drive the loopback callback exactly as the VVCode success page would. */
async function driveCallback(startUrl: URL, query: string): Promise<Response> {
  return fetch(`${startUrl.searchParams.get('redirect_uri')}?${query}`)
}

afterEach(async () => {
  vi.restoreAllMocks()
  const servers = trackedServers.servers.splice(0)
  for (const { closed } of servers) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => { resolve(false) }, 2000)
      timer.unref()
    })
    const didClose = await Promise.race([closed, timedOut])
    clearTimeout(timer)
    expect(didClose, 'every loopback listener must reach quiescence').toBe(true)
  }
})

it('completes one browser login: start URL, validated callback, single exchange', async () => {
  const requests = interceptFetch(() => Response.json(TOKEN_RESPONSE))
  const { login, startUrl } = startLogin()
  const url = await startUrl
  expect(url.origin).toBe(ORIGIN)
  expect(url.pathname).toBe('/oauth/vscode/login')
  const state = url.searchParams.get('state')
  const challenge = url.searchParams.get('code_challenge')
  expect(state).toMatch(/^[A-Za-z0-9_-]{40,}$/)
  expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  const redirectUri = url.searchParams.get('redirect_uri')
  expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)

  const callback = await driveCallback(url, `code=ac-1&state=${state}`)
  expect(callback.status).toBe(200)
  expect(callback.headers.get('content-type')).toContain('text/html')

  await expect(login).resolves.toEqual({
    accessToken: TOKEN_RESPONSE.access_token,
    userId: 123,
    expiresAt: EXPIRES_AT * 1000,
    scopes: ['api_key:read', 'api_key:reveal', 'api_key:write', 'profile:read'],
  })
  expect(requests).toHaveLength(1)
  const [exchange] = requests
  if (exchange === undefined) throw new Error('The token exchange request was not sent.')
  expect(exchange.url).toBe(`${ORIGIN}/api/oauth/vscode/token`)
  expect(exchange.init?.method).toBe('POST')
  expect(exchange.init?.redirect).toBe('error')
  expect(exchange.init?.cache).toBe('no-store')
  const form = exchange.init?.body as URLSearchParams
  expect(form.get('grant_type')).toBe('authorization_code')
  expect(form.get('code')).toBe('ac-1')
  expect(form.get('state')).toBe(state)
  expect(form.get('redirect_uri')).toBe(redirectUri)
  const verifier = form.get('code_verifier')
  expect(verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/)
  expect(createHash('sha256').update(verifier ?? '').digest('base64url')).toBe(challenge)
  await expectPortClosed(Number(new URL(redirectUri ?? '').port))
})

it('keeps listening through invalid callbacks and completes on the valid one', async () => {
  const requests = interceptFetch(() => Response.json(TOKEN_RESPONSE))
  const { login, startUrl } = startLogin()
  const url = await startUrl
  const state = url.searchParams.get('state')
  const redirectUri = url.searchParams.get('redirect_uri')
  const base = new URL(redirectUri ?? '')
  const wrongState = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

  expect((await fetch(`${base.origin}/other?code=x&state=${state}`)).status).toBe(404)
  expect((await fetch(redirectUri ?? '', { method: 'POST', body: 'x' })).status).toBe(405)
  expect((await driveCallback(url, `code=ac-1&state=${wrongState}`)).status).toBe(400)
  expect((await driveCallback(url, `code=ac-1&state=${wrongState.slice(1)}`)).status).toBe(400)
  expect((await driveCallback(url, 'code=ac-1&code=ac-2&state=x')).status).toBe(400)
  expect((await driveCallback(url, 'code=ac-1')).status).toBe(400)
  expect((await driveCallback(url, 'code=&state=x')).status).toBe(400)
  expect((await driveCallback(url, 'code=ac-1&state=')).status).toBe(400)

  const callback = await driveCallback(url, `code=ac-correct&state=${state}`)
  expect(callback.status).toBe(200)
  await expect(login).resolves.toMatchObject({ accessToken: TOKEN_RESPONSE.access_token })
  expect(requests).toHaveLength(1)
  expect((requests[0]?.init?.body as URLSearchParams).get('code')).toBe('ac-correct')
})

it('answers a duplicate callback with 400 and still exchanges exactly once', async () => {
  const release = defer<Response>()
  const requests = interceptFetch((url) => {
    if (url === `${ORIGIN}/api/oauth/vscode/token`) return release.promise
    return Response.json(TOKEN_RESPONSE)
  })
  const { login, startUrl } = startLogin()
  const url = await startUrl
  const state = url.searchParams.get('state')
  expect((await driveCallback(url, `code=ac-1&state=${state}`)).status).toBe(200)
  expect((await driveCallback(url, `code=ac-1&state=${state}`)).status).toBe(400)
  release.resolve(Response.json(TOKEN_RESPONSE))
  await expect(login).resolves.toMatchObject({ accessToken: TOKEN_RESPONSE.access_token })
  expect(requests).toHaveLength(1)
})

it('rejects the deadline with a typed timeout and releases the listener', async () => {
  await expectRemote(loginVvcode({ origin: ORIGIN, timeoutMs: 200, maxResponseBytes: 65536 }),
    'hemi/vvcode-login-failed', { reason: 'timeout' })
})

it('surfaces caller cancellation and never notifies after an abort during the bind', async () => {
  const notify = vi.fn()
  const controller = new AbortController()
  const login = loginVvcode({
    origin: ORIGIN, timeoutMs: 5000, maxResponseBytes: 65536, notifyURL: notify, signal: controller.signal,
  })
  void login.catch(() => { /* asserted below. */ })
  controller.abort(new Error('stop'))
  await expect(login).rejects.toThrow('stop')
  expect(notify).not.toHaveBeenCalled()
})

it('falls back through the exchange error fields without leaking credentials', async () => {
  let exchangeResponse: Response = Response.json({ error: 'invalid_grant' }, { status: 400 })
  interceptFetch((url) => {
    if (url === `${ORIGIN}/api/oauth/vscode/token`) return exchangeResponse
    return Response.json(TOKEN_RESPONSE)
  })
  const first = startLogin()
  const url = await first.startUrl
  await driveCallback(url, `code=ac-secret-917&state=${url.searchParams.get('state')}`)
  const failure = await expectRemote(first.login, 'hemi/vvcode-login-failed', { reason: 'exchange' })
  expect(failure.message).toBe('invalid_grant')
  expect(JSON.stringify(failure)).not.toContain('ac-secret-917')
  exchangeResponse = Response.json({ unrelated: true }, { status: 503 })
  const second = startLogin()
  const secondUrl = await second.startUrl
  await driveCallback(secondUrl, `code=ac-secret-917&state=${secondUrl.searchParams.get('state')}`)
  const fallback = await expectRemote(second.login, 'hemi/vvcode-login-failed', { reason: 'exchange' })
  expect(fallback.message).toBe('The VVCode token exchange failed. Start the sign-in again.')
  expect(JSON.stringify(fallback)).not.toContain('ac-secret-917')
})

it('reports a throwing notifier as a login failure and releases the listener', async () => {
  const login = loginVvcode({
    origin: ORIGIN,
    timeoutMs: 5000,
    maxResponseBytes: 65536,
    notifyURL: () => { throw new Error('browser launch failed') },
  })
  void login.catch(() => { /* asserted below. */ })
  const failure = await expectRemote(login, 'hemi/vvcode-login-failed', { reason: 'callback' })
  expect(failure.cause).toBeInstanceOf(Error)
})

it('reports a malformed raw request target as 400 without crashing and completes the login', async () => {
  interceptFetch(() => Response.json(TOKEN_RESPONSE))
  const { login, startUrl } = startLogin()
  const url = await startUrl
  const port = Number(new URL(url.searchParams.get('redirect_uri') ?? '').port)
  await new Promise<void>((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.once('connect', () => { socket.end('GET http://[ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n') })
    socket.once('data', () => { socket.destroy() })
    socket.once('close', () => { resolve() })
    socket.once('error', () => { resolve() })
  })
  const callback = await driveCallback(url, `code=ac-1&state=${url.searchParams.get('state')}`)
  expect(callback.status).toBe(200)
  await expect(login).resolves.toMatchObject({ accessToken: TOKEN_RESPONSE.access_token })
})

it('settles a caller abort raised inside notifyURL and closes the bound listener port', async () => {
  const notified = defer<string>()
  const controller = new AbortController()
  const login = loginVvcode({
    origin: ORIGIN,
    timeoutMs: 5000,
    maxResponseBytes: 65536,
    notifyURL: (url) => {
      notified.resolve(url)
      controller.abort(new Error('stop'))
    },
    signal: controller.signal,
  })
  void login.catch(() => { /* asserted below. */ })
  const redirectUri = new URL(await notified.promise).searchParams.get('redirect_uri')
  if (redirectUri === null) throw new Error('The start URL carried no redirect URI.')
  await expect(login).rejects.toThrow('stop')
  await expectPortClosed(Number(new URL(redirectUri).port))
})

it('surfaces caller cancellation mid-wait and closes the bound listener port', async () => {
  const controller = new AbortController()
  const { login, startUrl } = startLogin({ signal: controller.signal })
  const url = await startUrl
  const port = Number(new URL(url.searchParams.get('redirect_uri') ?? '').port)
  controller.abort('stop')
  await expect(login).rejects.toBe('stop')
  await expectPortClosed(port)
})

it('surfaces caller cancellation during the exchange without another exchange attempt', async () => {
  const requests = interceptFetch((_url, init) => new Response(new ReadableStream({
    start(controller) {
      init?.signal?.addEventListener('abort', () => { controller.error(new Error('body lost')) }, { once: true })
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
  const controller = new AbortController()
  const { login, startUrl } = startLogin({ signal: controller.signal })
  const url = await startUrl
  await driveCallback(url, `code=ac-1&state=${url.searchParams.get('state')}`)
  controller.abort(null)
  await expect(login).rejects.toBeNull()
  expect(requests).toHaveLength(1)
})

it('surfaces caller cancellation while the exchange request is pending', async () => {
  const requests = interceptFetch((_url, init) => new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener('abort', () => { reject(new Error('The request was aborted.')) }, { once: true })
  }))
  const controller = new AbortController()
  const { login, startUrl } = startLogin({ signal: controller.signal })
  const url = await startUrl
  await driveCallback(url, `code=ac-1&state=${url.searchParams.get('state')}`)
  controller.abort(new Error('stop'))
  await expect(login).rejects.toThrow('stop')
  expect(requests).toHaveLength(1)
})

it('reports a deadline reached during the exchange as a typed exchange failure', async () => {
  interceptFetch((_url, init) => new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener('abort', () => { reject(new Error('The request was aborted.')) }, { once: true })
  }))
  const { login, startUrl } = startLogin({ timeoutMs: 300 })
  const url = await startUrl
  await driveCallback(url, `code=ac-1&state=${url.searchParams.get('state')}`)
  await expectRemote(login, 'hemi/vvcode-login-failed', { reason: 'exchange' })
})

it('reports an exchange transport failure without retrying the one-time code', async () => {
  const requests = interceptFetch((url) => {
    if (url === `${ORIGIN}/api/oauth/vscode/token`) throw new TypeError('network down')
    return Response.json(TOKEN_RESPONSE)
  })
  const { login, startUrl } = startLogin()
  const url = await startUrl
  await driveCallback(url, `code=ac-secret-917&state=${url.searchParams.get('state')}`)
  const failure = await expectRemote(login, 'hemi/vvcode-login-failed', { reason: 'exchange' })
  expect(JSON.stringify(failure)).not.toContain('ac-secret-917')
  expect(requests).toHaveLength(1)
})

it('reports a refused exchange with the server message and without credential leakage', async () => {
  const requests = interceptFetch((url) => {
    if (url === `${ORIGIN}/api/oauth/vscode/token`) {
      return Response.json({ error: 'invalid_grant', error_description: 'authorization code expired' }, { status: 400 })
    }
    return Response.json(TOKEN_RESPONSE)
  })
  const { login, startUrl } = startLogin()
  const url = await startUrl
  await driveCallback(url, `code=ac-secret-917&state=${url.searchParams.get('state')}`)
  const failure = await expectRemote(login, 'hemi/vvcode-login-failed', { reason: 'exchange' })
  expect(failure.message).toBe('authorization code expired')
  expect(JSON.stringify(failure)).not.toContain('ac-secret-917')
  expect(requests).toHaveLength(1)
})

it.each([
  [{ ...TOKEN_RESPONSE, access_token: 'sk-not-a-pat' }],
  [{ ...TOKEN_RESPONSE, token_type: 'bearer' }],
  [{ ...TOKEN_RESPONSE, expires_at: 'soon' }],
  [{ ...TOKEN_RESPONSE, user_id: 0 }],
  [{ ...TOKEN_RESPONSE, scope: '' }],
  [{ ...TOKEN_RESPONSE, access_token: undefined }],
  [{ ...TOKEN_RESPONSE, expires_at: Math.floor(Date.now() / 1000) - 10 }],
])('refuses an invalid token response: %j', async (body) => {
  interceptFetch((url) => {
    if (url === `${ORIGIN}/api/oauth/vscode/token`) return Response.json(body)
    return Response.json(TOKEN_RESPONSE)
  })
  const { login, startUrl } = startLogin()
  const url = await startUrl
  await driveCallback(url, `code=ac-1&state=${url.searchParams.get('state')}`)
  await expectRemote(login, 'hemi/vvcode-login-failed', { reason: 'exchange' })
})

it('reports an unreadable token response as an exchange failure', async () => {
  interceptFetch((url) => {
    if (url === `${ORIGIN}/api/oauth/vscode/token`) return new Response('not json', { status: 200 })
    return Response.json(TOKEN_RESPONSE)
  })
  const { login, startUrl } = startLogin()
  const url = await startUrl
  await driveCallback(url, `code=ac-1&state=${url.searchParams.get('state')}`)
  await expectRemote(login, 'hemi/vvcode-login-failed', { reason: 'exchange' })
})

it('rejects a non-HTTPS origin before binding any listener', async () => {
  await expect(loginVvcode({ origin: 'http://vvcode.example', timeoutMs: 5000, maxResponseBytes: 65536 }))
    .rejects.toThrow('plain HTTPS origin')
})

it('rejects an unparseable origin and invalid budgets before any work', async () => {
  await expect(loginVvcode({ origin: 'not a url', timeoutMs: 5000, maxResponseBytes: 65536 }))
    .rejects.toThrow('absolute URL')
  await expect(loginVvcode({ origin: ORIGIN, timeoutMs: 0, maxResponseBytes: 65536 }))
    .rejects.toThrow('positive integer')
  await expect(loginVvcode({ origin: ORIGIN, timeoutMs: 5000, maxResponseBytes: 0 }))
    .rejects.toThrow('positive integer')
})

it('reads the group list with the application marker and sorts it', async () => {
  const requests = interceptFetch(() => Response.json({
    success: true,
    message: '',
    data: { vip: { ratio: 0.8, desc: 'VIP' }, auto: { ratio: 'auto', desc: 'Auto' }, mid: { ratio: 1, desc: 'Mid' } },
  }))
  const client = createVvcodeClient(OPTIONS)
  await expect(client.listGroups()).resolves.toEqual([
    { name: 'auto', ratio: 'auto', desc: 'Auto' },
    { name: 'mid', ratio: 1, desc: 'Mid' },
    { name: 'vip', ratio: 0.8, desc: 'VIP' },
  ])
  const [request] = requests
  if (request === undefined) throw new Error('The group request was not sent.')
  expect(request.url).toBe(`${ORIGIN}/api/desktop/groups?app=hemi-dsh`)
  const headers = new Headers(request.init?.headers)
  expect(headers.get('authorization')).toBe(`Bearer ${OPTIONS.accessToken}`)
  expect(headers.get('x-ai-app')).toBe('hemi-dsh')
  expect(request.init?.redirect).toBe('error')
})

it('reads an empty group list as no groups instead of falling back', async () => {
  interceptFetch(() => Response.json({ success: true, message: '', data: {} }))
  await expect(createVvcodeClient(OPTIONS).listGroups()).resolves.toEqual([])
})

it('reads one group model directory as a plain GET with the scoped PAT', async () => {
  const requests = interceptFetch(() => Response.json({ success: true, message: '', data: ['model-b', 'model-a'] }))
  await expect(createVvcodeClient(OPTIONS).groupModels('vip')).resolves.toEqual(['model-b', 'model-a'])
  const [request] = requests
  if (request === undefined) throw new Error('The group model request was not sent.')
  expect(request.url).toBe(`${ORIGIN}/api/user/models?group=vip`)
  expect(request.init?.method).toBe('GET')
  const headers = new Headers(request.init?.headers)
  expect(headers.get('authorization')).toBe(`Bearer ${OPTIONS.accessToken}`)
  expect(headers.get('x-ai-app')).toBe('hemi-dsh')
  expect(request.init?.redirect).toBe('error')
})

it('refuses an unusable group model list instead of reporting no models', async () => {
  interceptFetch(() => Response.json({ success: true, message: '', data: 'models' }))
  await expectRemote(createVvcodeClient(OPTIONS).groupModels('vip'), 'hemi/vvcode-request-failed',
    { operation: 'group-models', status: 200 })
  interceptFetch(() => Response.json({ success: true, message: '', data: ['a', 4] }))
  await expectRemote(createVvcodeClient(OPTIONS).groupModels('vip'), 'hemi/vvcode-request-failed',
    { operation: 'group-models', status: 200 })
  interceptFetch(() => Response.json({ success: true, message: '', data: [''] }))
  await expectRemote(createVvcodeClient(OPTIONS).groupModels('vip'), 'hemi/vvcode-request-failed',
    { operation: 'group-models', status: 200 })
  interceptFetch(() => Response.json({ success: false, message: 'no group mapping' }))
  const refusal = await expectRemote(createVvcodeClient(OPTIONS).groupModels('vip'), 'hemi/vvcode-request-failed',
    { operation: 'group-models', status: 200 })
  expect(refusal.message).toBe('no group mapping')
})

it('bounds the group model list and refuses invalid group names', async () => {
  interceptFetch(() => Response.json({ success: true, message: '', data: ['a', 'b', 'c', 'd'] }))
  await expectRemote(createVvcodeClient(OPTIONS).groupModels('vip'), 'hemi/vvcode-request-failed',
    { operation: 'group-models', status: 200 })
  await expect(createVvcodeClient(OPTIONS).groupModels('')).rejects.toThrow('1–128 characters')
  await expect(createVvcodeClient(OPTIONS).groupModels('v'.repeat(129))).rejects.toThrow('1–128 characters')
})

it('reports an expired account from the group model read like every management read', async () => {
  interceptFetch(() => Response.json({ success: false, message: 'spec: PAT no longer authorized' }, { status: 401 }))
  await expectRemote(createVvcodeClient(OPTIONS).groupModels('vip'), 'hemi/vvcode-management-auth-expired', {})
})

it('refuses a non-object group payload instead of reporting no groups', async () => {
  interceptFetch(() => Response.json({ success: true, message: '', data: null }))
  await expectRemote(createVvcodeClient(OPTIONS).listGroups(), 'hemi/vvcode-request-failed',
    { operation: 'list-groups', status: 200 })
  interceptFetch(() => Response.json({ success: true, message: '', data: ['vip'] }))
  await expectRemote(createVvcodeClient(OPTIONS).listGroups(), 'hemi/vvcode-request-failed',
    { operation: 'list-groups', status: 200 })
})

it('reports an explicit success refusal through the envelope contract', async () => {
  interceptFetch(() => Response.json({ success: false, message: 'no group mapping' }))
  const failure = await expectRemote(createVvcodeClient(OPTIONS).listGroups(), 'hemi/vvcode-request-failed',
    { operation: 'list-groups', status: 200 })
  expect(failure.message).toBe('no group mapping')
})

it.each([
  [{ vip: { ratio: -1, desc: 'x' } }],
  [{ vip: { ratio: 'cheap', desc: 'x' } }],
  [{ vip: { desc: 'no ratio' } }],
  [{ vip: 'not-an-object' }],
  [{ vip: { ratio: 1 } }],
])('refuses a malformed group list: %j', async (data) => {
  interceptFetch(() => Response.json({ success: true, message: '', data }))
  await expectRemote(createVvcodeClient(OPTIONS).listGroups(), 'hemi/vvcode-request-failed',
    { operation: 'list-groups', status: 200 })
})

it('reads the signed-in identity and defaults a missing display name', async () => {
  const requests = interceptFetch(() => Response.json({
    success: true, message: '', data: { id: 7, username: 'u', display_name: 'N' },
  }))
  await expect(createVvcodeClient(OPTIONS).self()).resolves.toEqual({ id: 7, username: 'u', displayName: 'N' })
  interceptFetch(() => Response.json({ success: true, message: '', data: { id: 8, username: 'v' } }))
  await expect(createVvcodeClient(OPTIONS).self()).resolves.toEqual({ id: 8, username: 'v', displayName: '' })
  expect(new URL(requests[0]?.url ?? '').pathname).toBe('/api/user/self')
})

it.each([
  { data: { username: 'no-id', display_name: '' } },
  { data: { id: 7, username: 'u', display_name: 9 } },
])('refuses an invalid account identity: %j', async ({ data }) => {
  interceptFetch(() => Response.json({ success: true, message: '', data }))
  await expectRemote(createVvcodeClient(OPTIONS).self(), 'hemi/vvcode-request-failed', { operation: 'self' })
})

it('pages through the token list and stops on the page limit', async () => {
  const requests = interceptFetch(() => Response.json({ success: true, message: '', data: {
    page: 1, page_size: 100, total: 400,
    items: Array.from({ length: 100 }, (_, index) => ({
      id: index + 1, user_id: 123, name: `token-${index}`, status: 1, expired_time: -1, group: '',
    })),
  } }))
  await expect(createVvcodeClient(OPTIONS).listTokens()).resolves.toHaveLength(200)
  expect(requests).toHaveLength(2)
  expect(requests[0]?.url).toContain('/api/token/?p=1&page_size=100')
  expect(requests[1]?.url).toContain('/api/token/?p=2&page_size=100')
})

it('stops listing once the reported total is covered', async () => {
  const requests = interceptFetch((url) => {
    const page = new URL(url).searchParams.get('p') === '1' ? 1 : 2
    return Response.json({ success: true, message: '', data: {
      page, page_size: 100, total: 101,
      items: Array.from({ length: page === 1 ? 100 : 1 }, (_, index) => ({
        id: (page - 1) * 100 + index + 1, user_id: 123, name: `token-${page}-${index}`, status: 1,
      })),
    } })
  })
  const tokens = await createVvcodeClient(OPTIONS).listTokens()
  expect(tokens).toHaveLength(101)
  expect(tokens[0]).toEqual({ id: 1, userId: 123, name: 'token-1-0', group: '', enabled: true, expiresAt: undefined })
  expect(requests).toHaveLength(2)
  const single = interceptFetch(() => Response.json({ success: true, message: '', data: {
    page: 1, page_size: 100, total: 100,
    items: Array.from({ length: 100 }, (_, index) => ({
      id: index + 1, user_id: 123, name: `token-${index}`, status: 1,
    })),
  } }))
  await expect(createVvcodeClient(OPTIONS).listTokens()).resolves.toHaveLength(100)
  expect(single).toHaveLength(1)
})

it('stops listing on a short final page', async () => {
  const requests = interceptFetch(() => Response.json({ success: true, message: '', data: {
    page: 1, page_size: 100, total: 2,
    items: [
      { id: 5, user_id: 123, name: 'expired', status: 2, expired_time: EXPIRES_AT, group: 'vip' },
      { id: 6, user_id: 123, name: 'live', status: 1 },
    ],
  } }))
  await expect(createVvcodeClient(OPTIONS).listTokens()).resolves.toEqual([
    { id: 5, userId: 123, name: 'expired', group: 'vip', enabled: false, expiresAt: EXPIRES_AT * 1000 },
    { id: 6, userId: 123, name: 'live', group: '', enabled: true, expiresAt: undefined },
  ])
  expect(requests).toHaveLength(1)
})

it.each([
  { success: true, message: '', data: { page: 1, page_size: 100, total: 1 } },
  { success: true, message: '', data: { page: 1, page_size: 100, total: 1, items: [{ id: 'x', user_id: 1, name: 'n', status: 1 }] } },
])('refuses an invalid token page: %j', async (body) => {
  interceptFetch(() => Response.json(body))
  await expectRemote(createVvcodeClient(OPTIONS).listTokens(), 'hemi/vvcode-request-failed', { operation: 'list-tokens' })
})

it('finds a token by exact unique name and rejects duplicates', async () => {
  const requests = interceptFetch(() => Response.json({ success: true, message: '', data: {
    page: 1, page_size: 100, total: 2,
    items: [
      { id: 9, user_id: 123, name: 'prefix-other', status: 1 },
      { id: 10, user_id: 123, name: 'unique-name', status: 1 },
    ],
  } }))
  await expect(createVvcodeClient(OPTIONS).findToken('unique-name')).resolves.toEqual({
    id: 10, userId: 123, name: 'unique-name', group: '', enabled: true, expiresAt: undefined,
  })
  expect(new URL(requests[0]?.url ?? '').searchParams.get('keyword')).toBe('unique-name')
  interceptFetch(() => Response.json({ success: true, message: '', data: {
    page: 1, page_size: 100, total: 0, items: [],
  } }))
  await expect(createVvcodeClient(OPTIONS).findToken('unique-name')).resolves.toBeUndefined()
  interceptFetch(() => Response.json({ success: true, message: '', data: {
    page: 1, page_size: 100, total: 2,
    items: [
      { id: 10, user_id: 123, name: 'unique-name', status: 1 },
      { id: 11, user_id: 123, name: 'unique-name', status: 1 },
    ],
  } }))
  await expectRemote(createVvcodeClient(OPTIONS).findToken('unique-name'), 'hemi/vvcode-request-failed',
    { operation: 'find-token', status: 200 })
})

it('creates an exclusive token and verifies the detail before reporting it', async () => {
  const requests = interceptFetch((url, init) => {
    if (init?.method === 'POST') {
      return Response.json({ success: true, message: '', data: { id: 41 } })
    }
    expect(url).toBe(`${ORIGIN}/api/token/41`)
    return Response.json({ success: true, message: '', data: {
      id: 41, user_id: 123, name: 'hemi-abc', group: 'vip', status: 1, expired_time: -1, key: 'sk-masked',
    } })
  })
  const client = createVvcodeClient(OPTIONS)
  await expect(client.createToken('hemi-abc', 'vip')).resolves.toEqual({
    id: 41, userId: 123, name: 'hemi-abc', group: 'vip', enabled: true, expiresAt: undefined,
  })
  const [creation] = requests
  if (creation === undefined) throw new Error('The creation request was not sent.')
  expect(creation.url).toBe(`${ORIGIN}/api/token/`)
  expect(creation.init?.method).toBe('POST')
  expect(new Headers(creation.init?.headers).get('x-ai-app')).toBe('hemi-dsh')
  if (typeof creation.init?.body !== 'string') throw new Error('The creation body was not sent as JSON.')
  expect(JSON.parse(creation.init.body)).toEqual({
    name: 'hemi-abc', group: 'vip', expired_time: -1, remain_quota: 0, unlimited_quota: true,
  })
})

it('verifies a legacy creation without an ID through the exact-name search', async () => {
  const requests = interceptFetch((url, init) => {
    if (init?.method === 'POST') return Response.json({ success: true, message: '' })
    expect(url).toContain('/api/token/search?keyword=hemi-abc')
    return Response.json({ success: true, message: '', data: {
      page: 1, page_size: 100, total: 1,
      items: [{ id: 42, user_id: 123, name: 'hemi-abc', group: 'default', status: 1 }],
    } })
  })
  const client = createVvcodeClient({ ...OPTIONS, userId: 123 })
  await expect(client.createToken('hemi-abc', 'default')).resolves.toEqual({
    id: 42, userId: 123, name: 'hemi-abc', group: 'default', enabled: true, expiresAt: undefined,
  })
  expect(requests).toHaveLength(2)
})

it('refuses a creation acknowledged without a verifiable record', async () => {
  interceptFetch((_url, init) => init?.method === 'POST'
    ? Response.json({ success: true, message: '' })
    : Response.json({ success: true, message: '', data: { page: 1, page_size: 100, total: 0, items: [] } }))
  await expectRemote(createVvcodeClient(OPTIONS).createToken('hemi-abc', 'default'), 'hemi/vvcode-request-failed',
    { operation: 'create-token', status: 200 })
})

it.each([
  [{ name: 'other', group: 'vip', status: 1, user_id: 123 }, undefined],
  [{ name: 'hemi-abc', group: 'other', status: 1, user_id: 123 }, undefined],
  [{ name: 'hemi-abc', group: 'vip', status: 1, user_id: 999 }, 123],
])('refuses a verified token that does not match the request: %j', async (detail, userId) => {
  interceptFetch((_url, init) => init?.method === 'POST'
    ? Response.json({ success: true, message: '', data: { id: 43 } })
    : Response.json({ success: true, message: '', data: { id: 43, ...detail } }))
  const client = createVvcodeClient(userId === undefined ? OPTIONS : { ...OPTIONS, userId })
  await expectRemote(client.createToken('hemi-abc', 'vip'), 'hemi/vvcode-request-failed',
    { operation: 'create-token', status: 200 })
})

it('hands the created ID to the caller before verification and after a searched legacy creation', async () => {
  const handed: number[] = []
  interceptFetch((url, init) => {
    if (init?.method === 'POST') return Response.json({ success: true, message: '', data: { id: 41 } })
    expect(url).toBe(`${ORIGIN}/api/token/41`)
    return Response.json({ success: true, message: '', data: {
      id: 41, user_id: 123, name: 'hemi-abc', group: 'vip', status: 1,
    } })
  })
  const client = createVvcodeClient(OPTIONS)
  await expect(client.createToken('hemi-abc', 'vip', undefined, async (id) => { handed.push(id) }))
    .resolves.toMatchObject({ id: 41 })
  expect(handed).toEqual([41])
  interceptFetch((_url, init) => init?.method === 'POST'
    ? Response.json({ success: true, message: '' })
    : Response.json({ success: true, message: '', data: {
      page: 1, page_size: 100, total: 1,
      items: [{ id: 42, user_id: 123, name: 'hemi-abc', group: 'default', status: 1 }],
    } }))
  await expect(client.createToken('hemi-abc', 'default', undefined, async (id) => { handed.push(id) }))
    .resolves.toMatchObject({ id: 42 })
  expect(handed).toEqual([41, 42])
})

it('refuses a creation response carrying an invalid token ID', async () => {
  const requests = interceptFetch((_url, init) => {
    if (init?.method === 'POST') return Response.json({ success: true, message: '', data: { id: '41' } })
    return Response.json({ success: true, message: '', data: {} })
  })
  await expectRemote(createVvcodeClient(OPTIONS).createToken('hemi-abc', 'vip'), 'hemi/vvcode-request-failed',
    { operation: 'create-token', status: 200 })
  expect(requests).toHaveLength(1)
})

it('reports a malformed 200 creation envelope as unknown instead of refused', async () => {
  const requests = interceptFetch(() => Response.json({}))
  await expectRemote(createVvcodeClient(OPTIONS).createToken('hemi-abc', 'vip'),
    'hemi/vvcode-token-unknown', { uniqueName: 'hemi-abc', group: 'vip' })
  expect(requests).toHaveLength(1)
})

it('reports a server refusal without a message through the fallback wording', async () => {
  const requests = interceptFetch(() => Response.json({ success: false }))
  const failure = await expectRemote(createVvcodeClient(OPTIONS).createToken('hemi-abc', 'vip'),
    'hemi/vvcode-token-refused', { status: 200 })
  expect(failure.message).toBe('VVCode refused the token creation.')
  expect(requests).toHaveLength(1)
})

it('reports a server refusal as a definite refusal without retrying', async () => {
  const requests = interceptFetch(() => Response.json({ success: false, message: 'Maximum number of tokens reached (10)' }))
  await expectRemote(createVvcodeClient(OPTIONS).createToken('hemi-abc', 'vip'), 'hemi/vvcode-token-refused',
    { status: 200 })
  expect(requests).toHaveLength(1)
})

it('reports an HTTP refusal of the creation as a definite refusal without retrying', async () => {
  const requests = interceptFetch(() => Response.json({ success: false, message: 'invalid group' }, { status: 400 }))
  await expectRemote(createVvcodeClient(OPTIONS).createToken('hemi-abc', 'vip'), 'hemi/vvcode-token-refused',
    { status: 400 })
  expect(requests).toHaveLength(1)
})

it('reports a first-request 401 as a refused creation carrying the status', async () => {
  const requests = interceptFetch(() => Response.json({ success: false }, { status: 401 }))
  await expectRemote(createVvcodeClient(OPTIONS).createToken('hemi-abc', 'vip'),
    'hemi/vvcode-token-refused', { status: 401 })
  expect(requests).toHaveLength(1)
})

it('reports a server-level 5xx creation outcome as unknown with the recovery name', async () => {
  const requests = interceptFetch(() => Response.json({ success: false, message: 'gateway' }, { status: 502 }))
  const failure = await expectRemote(createVvcodeClient(OPTIONS).createToken('hemi-abc', 'vip'),
    'hemi/vvcode-token-unknown', { uniqueName: 'hemi-abc', group: 'vip' })
  expect(remoteErrorOf(failure.cause)?.details).toMatchObject({ status: 502 })
  expect(requests).toHaveLength(1)
})

it('reports a transport failure during creation as unknown without retrying', async () => {
  const requests = interceptFetch(() => { throw new TypeError('network down') })
  await expectRemote(createVvcodeClient(OPTIONS).createToken('hemi-abc', 'vip'),
    'hemi/vvcode-token-unknown', { uniqueName: 'hemi-abc', group: 'vip' })
  expect(requests).toHaveLength(1)
})

it('reports an unreadable creation response as unknown', async () => {
  const requests = interceptFetch((_url, init) => init?.method === 'POST'
    ? new Response('x'.repeat(128), { status: 200, headers: { 'content-type': 'application/json' } })
    : Response.json({ success: true, message: '', data: {} }))
  const client = createVvcodeClient({ ...OPTIONS, maxResponseBytes: 32 })
  await expectRemote(client.createToken('hemi-abc', 'vip'), 'hemi/vvcode-token-unknown',
    { uniqueName: 'hemi-abc', group: 'vip' })
  expect(requests).toHaveLength(1)
})

it('surfaces caller cancellation during creation instead of reporting unknown', async () => {
  const controller = new AbortController()
  controller.abort(new Error('stop'))
  await expect(createVvcodeClient(OPTIONS).createToken('hemi-abc', 'vip', controller.signal))
    .rejects.toThrow('stop')
})

it.each([
  '',
  'x'.repeat(51),
  'bad\nname',
])('refuses an invalid token name: %j', async (name) => {
  await expect(createVvcodeClient(OPTIONS).createToken(name, 'vip')).rejects.toThrow('1–50 printable characters')
})

it.each([
  '',
  'g'.repeat(129),
])('refuses an invalid group name: %j', async (group) => {
  await expect(createVvcodeClient(OPTIONS).createToken('hemi-abc', group)).rejects.toThrow('1–128 characters')
})

it('reveals a stored token key normalized to the sk- relay form', async () => {
  interceptFetch(() => Response.json({ success: true, message: '', data: { key: 'Abcdef123456' } }))
  await expect(createVvcodeClient(OPTIONS).tokenKey(41)).resolves.toBe('sk-Abcdef123456')
  interceptFetch(() => Response.json({ success: true, message: '', data: { key: 'sk-Abcdef123456' } }))
  await expect(createVvcodeClient(OPTIONS).tokenKey(41)).resolves.toBe('sk-Abcdef123456')
})

it('refuses an unusable token key response', async () => {
  interceptFetch(() => Response.json({ success: true, message: '', data: { key: 'has space' } }))
  await expectRemote(createVvcodeClient(OPTIONS).tokenKey(41), 'hemi/vvcode-request-failed',
    { operation: 'token-key', status: 200 })
  interceptFetch(() => Response.json({ success: true, message: '', data: { key: TOKEN_RESPONSE.access_token } }))
  await expectRemote(createVvcodeClient(OPTIONS).tokenKey(41), 'hemi/vvcode-request-failed',
    { operation: 'token-key', status: 200 })
})

it('deletes a token and reports auth expiry distinctly', async () => {
  const requests = interceptFetch(() => Response.json({ success: true, message: '', data: null }))
  await expect(createVvcodeClient(OPTIONS).deleteToken(41)).resolves.toBeUndefined()
  expect(requests[0]?.init?.method).toBe('DELETE')
  interceptFetch(() => Response.json({ success: false }, { status: 401 }))
  await expectRemote(createVvcodeClient(OPTIONS).deleteToken(41), 'hemi/vvcode-management-auth-expired', {})
  interceptFetch(() => Response.json({ success: false, message: 'restricted group' }, { status: 403 }))
  await expectRemote(createVvcodeClient(OPTIONS).deleteToken(41), 'hemi/vvcode-request-failed',
    { operation: 'delete-token', status: 403 })
})

it('reads a token detail by ID', async () => {
  interceptFetch(() => Response.json({ success: true, message: '', data: {
    id: 41, user_id: 123, name: 'hemi-abc', group: 'vip', status: 1,
  } }))
  await expect(createVvcodeClient(OPTIONS).getToken(41)).resolves.toEqual({
    id: 41, userId: 123, name: 'hemi-abc', group: 'vip', enabled: true, expiresAt: undefined,
  })
  interceptFetch(() => Response.json({ success: false, message: 'not found' }, { status: 404 }))
  await expectRemote(createVvcodeClient(OPTIONS).getToken(41), 'hemi/vvcode-request-failed',
    { operation: 'token-detail', status: 404 })
})

it('reads the relay catalog with endpoint metadata and derives the model list', async () => {
  const requests = interceptFetch(() => Response.json({
    object: 'list',
    data: [
      { id: 'model-a', supported_endpoint_types: ['openai', 'anthropic'] },
      { id: 'model-b' },
      { object: 'chat.completion', id: 'ignored-row' },
    ],
  }))
  const client = createVvcodeClient(OPTIONS)
  await expect(client.modelCatalog('sk-model-key-000000')).resolves.toEqual([
    { id: 'model-a', supportedEndpointTypes: ['openai', 'anthropic'] },
    { id: 'model-b', supportedEndpointTypes: [] },
    { id: 'ignored-row', supportedEndpointTypes: [] },
  ])
  await expect(client.listModels('sk-model-key-000000')).resolves.toEqual(['model-a', 'model-b', 'ignored-row'])
  const [request] = requests
  if (request === undefined) throw new Error('The model list request was not sent.')
  expect(request.url).toBe(`${ORIGIN}/v1/models`)
  const headers = new Headers(request.init?.headers)
  expect(headers.get('authorization')).toBe('Bearer sk-model-key-000000')
  expect(headers.get('x-ai-app')).toBe('hemi-dsh')
})

it('reports a rejected model key distinctly from an expired PAT', async () => {
  interceptFetch(() => Response.json({ error: 'invalid api key' }, { status: 401 }))
  await expectRemote(createVvcodeClient(OPTIONS).listModels('sk-model-key-000000'),
    'hemi/vvcode-model-auth-expired', {})
  interceptFetch(() => Response.json({ success: false, message: 'forbidden' }, { status: 403 }))
  await expectRemote(createVvcodeClient(OPTIONS).modelCatalog('sk-model-key-000000'),
    'hemi/vvcode-request-failed', { operation: 'list-models', status: 403 })
})

it('refuses relay responses and oversized catalogs', async () => {
  interceptFetch(() => Response.json({ data: 'not-a-list' }))
  await expectRemote(createVvcodeClient(OPTIONS).modelCatalog('sk-model-key-000000'),
    'hemi/vvcode-request-failed', { operation: 'list-models', status: 200 })
  interceptFetch(() => Response.json({ object: 'list', data: [{ id: 4 }] }))
  await expectRemote(createVvcodeClient(OPTIONS).listModels('sk-model-key-000000'),
    'hemi/vvcode-request-failed', { operation: 'list-models', status: 200 })
  interceptFetch(() => Response.json({ object: 'list', data: [
    { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' },
  ] }))
  await expectRemote(createVvcodeClient(OPTIONS).modelCatalog('sk-model-key-000000'),
    'hemi/vvcode-request-failed', { operation: 'list-models', status: 200 })
})

it('reports relay transport failures and caller cancellation', async () => {
  const requests = interceptFetch(() => { throw new TypeError('network down') })
  await expectRemote(createVvcodeClient(OPTIONS).listModels('sk-model-key-000000'),
    'hemi/vvcode-request-failed', { operation: 'list-models' })
  expect(requests).toHaveLength(1)
  const controller = new AbortController()
  controller.abort(new Error('stop'))
  await expect(createVvcodeClient(OPTIONS).listModels('sk-model-key-000000', controller.signal))
    .rejects.toThrow('stop')
  await expect(createVvcodeClient(OPTIONS).modelCatalog('bad key')).rejects.toThrow('must be a sk- key')
  await expect(createVvcodeClient(OPTIONS).listModels(OPTIONS.accessToken)).rejects.toThrow('must be a sk- key')
})

it('reports unreadable and interrupted relay bodies', async () => {
  interceptFetch(() => new Response('not json', { status: 200 }))
  await expectRemote(createVvcodeClient(OPTIONS).modelCatalog('sk-model-key-000000'),
    'hemi/vvcode-request-failed', { operation: 'list-models' })
  const controller = new AbortController()
  interceptFetch((_url, init) => new Response(new ReadableStream({
    start(stream) {
      init?.signal?.addEventListener('abort', () => { stream.error(new Error('body lost')) }, { once: true })
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
  const pending = createVvcodeClient(OPTIONS).modelCatalog('sk-model-key-000000', controller.signal)
  controller.abort(new Error('stop'))
  await expect(pending).rejects.toThrow('stop')
})

it('filters pricing candidates by group without guessing endpoint protocols', async () => {
  interceptFetch(() => Response.json({ success: true, message: '', data: [
    { model_name: 'zeta', enable_groups: ['vip'], supported_endpoint_types: ['openai'] },
    { model_name: 'alpha', enable_groups: ['other'], supported_endpoint_types: ['anthropic'] },
    { model_name: 'beta', enable_groups: ['vip'] },
    { model_name: 'gamma', enable_groups: ['vip', 'other'], supported_endpoint_types: ['openai-response'] },
    'not-an-object',
    { model_name: 'no-groups' },
  ] }))
  await expect(createVvcodeClient(OPTIONS).modelCandidates('vip')).resolves.toEqual([
    { modelName: 'beta', enableGroups: ['vip'], supportedEndpointTypes: [] },
    { modelName: 'gamma', enableGroups: ['vip', 'other'], supportedEndpointTypes: ['openai-response'] },
    { modelName: 'zeta', enableGroups: ['vip'], supportedEndpointTypes: ['openai'] },
  ])
})

it('refuses invalid pricing data and bounds the candidate list', async () => {
  interceptFetch(() => Response.json({ success: true, message: '', data: 'not-a-list' }))
  await expectRemote(createVvcodeClient(OPTIONS).modelCandidates('vip'), 'hemi/vvcode-request-failed',
    { operation: 'model-candidates', status: 200 })
  interceptFetch(() => Response.json({ success: true, message: '', data: [
    { model_name: 'a', enable_groups: ['vip'], supported_endpoint_types: 'openai' },
  ] }))
  await expectRemote(createVvcodeClient(OPTIONS).modelCandidates('vip'), 'hemi/vvcode-request-failed',
    { operation: 'model-candidates', status: 200 })
  interceptFetch(() => Response.json({ success: true, message: '', data: [
    { enable_groups: ['vip'] },
  ] }))
  await expectRemote(createVvcodeClient(OPTIONS).modelCandidates('vip'), 'hemi/vvcode-request-failed',
    { operation: 'model-candidates', status: 200 })
  await expect(createVvcodeClient(OPTIONS).modelCandidates('')).rejects.toThrow('1–128 characters')
  await expect(createVvcodeClient(OPTIONS).modelCandidates('v'.repeat(129))).rejects.toThrow('1–128 characters')
  interceptFetch(() => Response.json({ success: true, message: '', data: [
    { model_name: 'a', enable_groups: ['vip'] },
    { model_name: 'b', enable_groups: ['vip'] },
    { model_name: 'c', enable_groups: ['vip'] },
    { model_name: 'd', enable_groups: ['vip'] },
  ] }))
  await expectRemote(createVvcodeClient(OPTIONS).modelCandidates('vip'), 'hemi/vvcode-request-failed',
    { operation: 'model-candidates', status: 200 })
})

it('wraps management transport failures with a stable request failure', async () => {
  const requests = interceptFetch(() => { throw new TypeError('network down') })
  await expectRemote(createVvcodeClient(OPTIONS).listGroups(), 'hemi/vvcode-request-failed',
    { operation: 'list-groups' })
  expect(requests).toHaveLength(1)
})

it('wraps management body failures and surfaces caller cancellation', async () => {
  const controller = new AbortController()
  interceptFetch((_url, init) => new Response(new ReadableStream({
    start(stream) {
      init?.signal?.addEventListener('abort', () => { stream.error(new Error('body lost')) }, { once: true })
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
  const pending = createVvcodeClient(OPTIONS).listGroups(controller.signal)
  controller.abort(new Error('stop'))
  await expect(pending).rejects.toThrow('stop')
  interceptFetch(() => new Response('not json', { status: 200 }))
  await expectRemote(createVvcodeClient(OPTIONS).listGroups(), 'hemi/vvcode-request-failed',
    { operation: 'list-groups' })
  interceptFetch(() => new Response('x'.repeat(128), { status: 200, headers: { 'content-type': 'application/json' } }))
  const client = createVvcodeClient({ ...OPTIONS, maxResponseBytes: 16 })
  await expectRemote(client.listGroups(), 'hemi/vvcode-request-failed', { operation: 'list-groups' })
  interceptFetch(() => new Response(undefined, { status: 200 }))
  await expectRemote(createVvcodeClient(OPTIONS).listGroups(), 'hemi/vvcode-request-failed',
    { operation: 'list-groups' })
})

it('uses the fallback message when an error body carries no readable message', async () => {
  interceptFetch(() => new Response('<html>boom</html>', { status: 500 }))
  const failure = await expectRemote(createVvcodeClient(OPTIONS).deleteToken(41), 'hemi/vvcode-request-failed',
    { operation: 'delete-token', status: 500 })
  expect(failure.message).toBe('VVCode refused the request.')
})

it('reports a non-envelope success body as an invalid response', async () => {
  interceptFetch(() => Response.json([1, 2]))
  await expectRemote(createVvcodeClient(OPTIONS).listGroups(), 'hemi/vvcode-request-failed',
    { operation: 'list-groups', status: 200 })
})

it.each([
  ['http://vvcode.example', 'plain HTTPS origin'],
  ['https://user@vvcode.example', 'plain HTTPS origin'],
  ['https://user:pass@vvcode.example', 'plain HTTPS origin'],
  ['https://vvcode.example/path', 'plain HTTPS origin'],
  ['https://vvcode.example/?a=b', 'plain HTTPS origin'],
  ['https://vvcode.example/#f', 'plain HTTPS origin'],
  ['not a url', 'absolute URL'],
])('rejects client origin %j', async (origin, message) => {
  expect(() => createVvcodeClient({ ...OPTIONS, origin })).toThrow(message)
})

it.each([
  [{ ...OPTIONS, accessToken: 'sk-not-a-pat' }],
  [{ ...OPTIONS, timeoutMs: 0 }],
  [{ ...OPTIONS, timeoutMs: 1.5 }],
  [{ ...OPTIONS, maxResponseBytes: 0 }],
  [{ ...OPTIONS, tokenPageLimit: 0 }],
  [{ ...OPTIONS, maxModels: 0 }],
  [{ ...OPTIONS, userId: 0 }],
])('rejects invalid client options: %j', async (options) => {
  expect(() => createVvcodeClient(options)).toThrow()
})

/** Display configuration every usage test falls back to: USD with a 500000-token dollar. */
const USAGE_STATUS = {
  quota_per_unit: 500000,
  quota_display_type: 'USD',
  usd_exchange_rate: 7.3,
  custom_currency_symbol: '¤',
  custom_currency_exchange_rate: 2,
}

/** Wire fields a wallet grant carries; the wallet scope is added only where a test needs it. */
const BASE_SCOPES = ['profile:read', 'api_key:read', 'api_key:write', 'api_key:reveal']

/** Scripted usage responses; every unset part falls back to a valid answer. */
interface UsageScript {
  status?: unknown
  self?: unknown
  subscriptions?: unknown
  selfStatus?: number
  subscriptionStatus?: number
}

/**
 * Answer the three usage reads from scripted state.
 * @param script - Per-endpoint envelope data and refusal statuses.
 * @returns the recorded requests.
 */
function usageSite(script: UsageScript = {}): RecordedRequest[] {
  return interceptFetch((url) => {
    if (url === `${ORIGIN}/api/status`) {
      return Response.json({ success: true, message: '', data: script.status ?? USAGE_STATUS })
    }
    if (url === `${ORIGIN}/api/user/self`) {
      const status = script.selfStatus ?? 200
      return Response.json({ success: status === 200, message: status === 200 ? '' : 'spec: refused',
        data: script.self ?? { id: 123, username: 'u', quota: 1000000 } }, { status })
    }
    if (url === `${ORIGIN}/api/subscription/self`) {
      const status = script.subscriptionStatus ?? 200
      return Response.json({ success: status === 200, message: status === 200 ? '' : 'spec: refused',
        data: script.subscriptions ?? { subscriptions: [subscriptionSummary(61)] } }, { status })
    }
    throw new Error(`usage spec has no handler for ${url}`)
  })
}

/**
 * One subscription summary as `/api/subscription/self` reports it, active around the current time.
 * @param id - Server subscription ID.
 * @param overrides - Field overrides, including explicit times for exact assertions.
 * @returns the wrapped summary row.
 */
function subscriptionSummary(id: number, overrides: Record<string, unknown> = {}): unknown {
  const nowSeconds = Math.floor(Date.now() / 1000)
  return { subscription: {
    id, user_id: 123, plan_id: 3, amount_total: 250000, amount_used: 100000,
    status: 'active', start_time: nowSeconds - 60, end_time: nowSeconds + 3600, next_reset_time: 0,
    ...overrides,
  } }
}

/** The usage report of one client read, for assertions on its parts. */
type VvcodeUsageReport = Awaited<ReturnType<VvcodeClient['usage']>>

/** The ready items of a usage report, for assertions that only make sense when it is ready. */
function readyItems(subscriptions: VvcodeUsageReport['subscriptions']): unknown[] {
  if (subscriptions.state !== 'ready') throw new Error('Expected the subscriptions to be ready.')
  return subscriptions.items
}

it('reads balance and active subscriptions in the site unit without sending the PAT to the status read', async () => {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const requests = usageSite({ subscriptions: { subscriptions: [
    subscriptionSummary(61, { start_time: nowSeconds - 60, end_time: nowSeconds + 3600 }),
    subscriptionSummary(62, { amount_total: 0, amount_used: 50000, next_reset_time: 1700000000,
      start_time: nowSeconds - 60, end_time: nowSeconds + 3600 }),
  ] } })
  const client = createVvcodeClient(OPTIONS)
  const usage = await client.usage([...BASE_SCOPES, 'wallet:read'])

  expect(usage.unit).toEqual({ kind: 'currency', symbol: '$' })
  expect(usage.balance).toEqual({ state: 'ready', remaining: 2 })
  expect(readyItems(usage.subscriptions)).toEqual([
    { id: 61, total: 0.5, used: 0.2, remaining: 0.3, expiresAt: (nowSeconds + 3600) * 1000, resetAt: null },
    { id: 62, total: null, used: 0.1, remaining: null, expiresAt: (nowSeconds + 3600) * 1000, resetAt: 1700000000000 },
  ])
  const statusRequest = requests.find(request => request.url === `${ORIGIN}/api/status`)
  const statusHeaders = new Headers(statusRequest?.init?.headers)
  expect(statusHeaders.get('authorization')).toBeNull()
  expect(statusHeaders.get('x-ai-app')).toBe('hemi-dsh')
  expect(statusRequest?.init?.redirect).toBe('error')
  for (const path of ['/api/user/self', '/api/subscription/self']) {
    const request = requests.find(candidate => candidate.url === `${ORIGIN}${path}`)
    expect(new Headers(request?.init?.headers).get('authorization')).toBe(`Bearer ${OPTIONS.accessToken}`)
  }
})

it.each([
  [{ ...USAGE_STATUS, quota_display_type: 'CNY', usd_exchange_rate: 7.3 }, { kind: 'currency', symbol: '¥' }, 500000, 7.3],
  [{ ...USAGE_STATUS, quota_display_type: 'TOKENS' }, { kind: 'tokens', symbol: 'TOKENS' }, 123456, 123456],
  [{ ...USAGE_STATUS, quota_display_type: 'CUSTOM', custom_currency_symbol: '₮',
    custom_currency_exchange_rate: 2 }, { kind: 'currency', symbol: '₮' }, 500000, 2],
])('reports the balance in the configured unit: %j', async (status, unit, quota, expectedRemaining) => {
  usageSite({ status, self: { id: 123, username: 'u', quota } })
  const usage = await createVvcodeClient(OPTIONS).usage(BASE_SCOPES)
  expect(usage.unit).toEqual(unit)
  expect(usage.balance).toEqual({ state: 'ready', remaining: expectedRemaining })
})

it('keeps a negative wallet balance as an overdraft', async () => {
  usageSite({ self: { id: 123, username: 'u', quota: -250000 } })
  const usage = await createVvcodeClient(OPTIONS).usage(BASE_SCOPES)
  expect(usage.balance).toEqual({ state: 'ready', remaining: -0.5 })
})

it.each([
  { ...USAGE_STATUS, quota_per_unit: 0 },
  { ...USAGE_STATUS, quota_per_unit: -5 },
  { quota_display_type: 'USD' },
  { ...USAGE_STATUS, quota_display_type: 'EUR' },
  { ...USAGE_STATUS, quota_display_type: 'CNY', usd_exchange_rate: undefined },
  { ...USAGE_STATUS, quota_display_type: 'CNY', usd_exchange_rate: 0 },
  { ...USAGE_STATUS, quota_display_type: 'CNY', usd_exchange_rate: 'cheap' },
  { ...USAGE_STATUS, quota_display_type: 'CUSTOM', custom_currency_exchange_rate: undefined },
  { ...USAGE_STATUS, quota_display_type: 'CUSTOM', custom_currency_exchange_rate: 0 },
  { ...USAGE_STATUS, quota_display_type: 'CUSTOM', custom_currency_symbol: '' },
  { ...USAGE_STATUS, quota_display_type: 'CUSTOM', custom_currency_symbol: 3 },
  { ...USAGE_STATUS, quota_display_type: 'CUSTOM', custom_currency_symbol: undefined },
])('fails the whole usage on an unusable display configuration: %j', async (status) => {
  usageSite({ status })
  await expectRemote(createVvcodeClient(OPTIONS).usage([...BASE_SCOPES, 'wallet:read']),
    'hemi/vvcode-request-failed', { operation: 'usage-status' })
})

it('fails the whole usage when the status read is refused, unreachable, or unreadable', async () => {
  const refused = interceptFetch((url) => {
    if (url === `${ORIGIN}/api/status`) return Response.json({ success: false, message: 'status hidden' })
    throw new Error('usage must stop at the status read')
  })
  const failure = await expectRemote(createVvcodeClient(OPTIONS).usage([...BASE_SCOPES, 'wallet:read']),
    'hemi/vvcode-request-failed', { operation: 'usage-status', status: 200 })
  expect(failure.message).toBe('status hidden')
  expect(refused).toHaveLength(1)
  interceptFetch((url) => {
    if (url === `${ORIGIN}/api/status`) return new Response('not json', { status: 200 })
    throw new Error('usage must stop at the status read')
  })
  await expectRemote(createVvcodeClient(OPTIONS).usage([...BASE_SCOPES, 'wallet:read']),
    'hemi/vvcode-request-failed', { operation: 'usage-status' })
  const unreachable = interceptFetch((url) => {
    if (url === `${ORIGIN}/api/status`) throw new TypeError('network down')
    throw new Error('usage must stop at the status read')
  })
  await expectRemote(createVvcodeClient(OPTIONS).usage([...BASE_SCOPES, 'wallet:read']),
    'hemi/vvcode-request-failed', { operation: 'usage-status' })
  expect(unreachable).toHaveLength(1)
})

it('answers an anonymous status 401 as a refusal instead of account expiry', async () => {
  interceptFetch((url) => {
    if (url === `${ORIGIN}/api/status`) return Response.json({ success: false, message: 'status disabled' }, { status: 401 })
    return Response.json({ success: true, message: '', data: {} })
  })
  await expectRemote(createVvcodeClient(OPTIONS).usage([...BASE_SCOPES, 'wallet:read']),
    'hemi/vvcode-request-failed', { operation: 'usage-status', status: 401 })
})

it('skips the subscription read for a grant without the wallet scope and reports reauthorize', async () => {
  const requests = usageSite()
  const usage = await createVvcodeClient(OPTIONS).usage(BASE_SCOPES)
  expect(usage.balance).toEqual({ state: 'ready', remaining: 2 })
  expect(usage.subscriptions).toEqual({ state: 'reauthorize' })
  expect(requests.some(request => request.url === `${ORIGIN}/api/subscription/self`)).toBe(false)
  expect(requests.some(request => request.url === `${ORIGIN}/api/user/self`)).toBe(true)
})

it('reports a server-side subscription refusal as reauthorize without marking the account expired', async () => {
  usageSite({ subscriptionStatus: 403 })
  const usage = await createVvcodeClient(OPTIONS).usage([...BASE_SCOPES, 'wallet:read'])
  expect(usage.balance).toEqual({ state: 'ready', remaining: 2 })
  expect(usage.subscriptions).toEqual({ state: 'reauthorize' })
})

it('reports a failed or unusable subscription read as unavailable while the balance stays ready', async () => {
  usageSite({ subscriptionStatus: 500 })
  const refused = await createVvcodeClient(OPTIONS).usage([...BASE_SCOPES, 'wallet:read'])
  expect(refused.balance).toEqual({ state: 'ready', remaining: 2 })
  expect(refused.subscriptions).toEqual({ state: 'unavailable' })
  usageSite({ subscriptions: { all_subscriptions: [], subscriptions: 'many' } })
  const shapeless = await createVvcodeClient(OPTIONS).usage([...BASE_SCOPES, 'wallet:read'])
  expect(shapeless.subscriptions).toEqual({ state: 'unavailable' })
  usageSite({ subscriptions: { subscriptions: [{ subscription: { id: 0 } }] } })
  const invalidRecord = await createVvcodeClient(OPTIONS).usage([...BASE_SCOPES, 'wallet:read'])
  expect(invalidRecord.balance).toEqual({ state: 'ready', remaining: 2 })
  expect(invalidRecord.subscriptions).toEqual({ state: 'unavailable' })
})

it.each([
  subscriptionSummary(91, { amount_total: -1 }),
  subscriptionSummary(92, { amount_used: -5 }),
  subscriptionSummary(93, { next_reset_time: -1 }),
])('refuses a subscription record with a negative quota field: %j', async (record) => {
  usageSite({ subscriptions: { subscriptions: [record] } })
  const usage = await createVvcodeClient(OPTIONS).usage([...BASE_SCOPES, 'wallet:read'])
  expect(usage.balance).toEqual({ state: 'ready', remaining: 2 })
  expect(usage.subscriptions).toEqual({ state: 'unavailable' })
})

it('reports a failed or unusable balance read as unavailable while subscriptions stay ready', async () => {
  usageSite({ selfStatus: 500 })
  const refused = await createVvcodeClient(OPTIONS).usage([...BASE_SCOPES, 'wallet:read'])
  expect(refused.balance).toEqual({ state: 'unavailable' })
  expect(readyItems(refused.subscriptions)).toEqual([expect.objectContaining({ id: 61 })])
  usageSite({ self: { id: 123, username: 'u' } })
  const quotaless = await createVvcodeClient(OPTIONS).usage([...BASE_SCOPES, 'wallet:read'])
  expect(quotaless.balance).toEqual({ state: 'unavailable' })
  expect(readyItems(quotaless.subscriptions)).toEqual([expect.objectContaining({ id: 61 })])
})

it('propagates an expired account from either authenticated usage read', async () => {
  usageSite({ selfStatus: 401 })
  await expectRemote(createVvcodeClient(OPTIONS).usage([...BASE_SCOPES, 'wallet:read']),
    'hemi/vvcode-management-auth-expired', {})
  usageSite({ subscriptionStatus: 401 })
  await expectRemote(createVvcodeClient(OPTIONS).usage([...BASE_SCOPES, 'wallet:read']),
    'hemi/vvcode-management-auth-expired', {})
})

it('drops records outside the active window and clamps an overdrawn remaining', async () => {
  const nowSeconds = Math.floor(Date.now() / 1000)
  usageSite({
    status: { ...USAGE_STATUS, quota_display_type: 'TOKENS' },
    subscriptions: { subscriptions: [
      subscriptionSummary(71, { end_time: nowSeconds - 10, start_time: nowSeconds - 60 }),
      subscriptionSummary(72, { start_time: nowSeconds + 60, end_time: nowSeconds + 3600 }),
      subscriptionSummary(73, { status: 'expired', start_time: nowSeconds - 60, end_time: nowSeconds + 3600 }),
      subscriptionSummary(74, { amount_total: 100, amount_used: 150,
        start_time: nowSeconds - 60, end_time: nowSeconds + 3600 }),
    ] },
  })
  const usage = await createVvcodeClient(OPTIONS).usage([...BASE_SCOPES, 'wallet:read'])
  expect(readyItems(usage.subscriptions)).toEqual([
    { id: 74, total: 100, used: 150, remaining: 0, expiresAt: (nowSeconds + 3600) * 1000, resetAt: null },
  ])
})

it('fails the subscription read when a record names another account', async () => {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const foreign = { subscriptions: [subscriptionSummary(81, { user_id: 999,
    start_time: nowSeconds - 60, end_time: nowSeconds + 3600 })] }
  usageSite({ subscriptions: foreign })
  const usage = await createVvcodeClient({ ...OPTIONS, userId: 123 }).usage([...BASE_SCOPES, 'wallet:read'])
  expect(usage.balance).toEqual({ state: 'ready', remaining: 2 })
  expect(usage.subscriptions).toEqual({ state: 'unavailable' })
  usageSite({ subscriptions: foreign })
  const usageWithoutAccount = await createVvcodeClient(OPTIONS).usage([...BASE_SCOPES, 'wallet:read'])
  expect(readyItems(usageWithoutAccount.subscriptions)).toEqual([expect.objectContaining({ id: 81 })])
})

it('surfaces caller cancellation from the usage reads', async () => {
  usageSite()
  const controller = new AbortController()
  controller.abort(new Error('stop'))
  await expect(createVvcodeClient(OPTIONS).usage([...BASE_SCOPES, 'wallet:read'], controller.signal))
    .rejects.toThrow('stop')
})
