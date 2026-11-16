/** VVCode OAuth 2.0 + PKCE S256 browser login with a loopback authorization-code callback. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { positiveInt, readJsonBody, resolveOrigin } from './api.ts'
import { asObject } from '../response.ts'

import type { VvcodeGrant, VvcodeLoginInput } from './types.ts'

/** Loopback path the VVCode success page redirects to with `code` and `state`. */
const CALLBACK_PATH = '/callback'

/** Character count of the PKCE `code_verifier`, inside the 43–128 range the server accepts. */
const VERIFIER_LENGTH = 64

/** Characters allowed in a PKCE `code_verifier`; sampled without modulo bias. */
const VERIFIER_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'

/** HTML shown in the browser after the application received the authorization code. */
const RECEIVED_PAGE = '<!doctype html><html><body><p>Authorization received.'
  + ' You can close this window and return to the application.</p></body></html>'

/**
 * Identify the deadline abort reason produced by `AbortSignal.timeout`.
 * @param error - A caught abort reason or failure.
 * @returns whether the value is the deadline abort.
 */
function isTimeout(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'TimeoutError'
}

/**
 * Sample one cryptographically random character without modulo bias.
 * @returns one character from the RFC 7636 unreserved set.
 */
function randomVerifierCharacter(): string {
  const limit = Math.floor(256 / VERIFIER_ALPHABET.length) * VERIFIER_ALPHABET.length
  for (;;) {
    const byte = randomBytes(1)[0] ?? 0
    if (byte < limit) return VERIFIER_ALPHABET[byte % VERIFIER_ALPHABET.length] ?? ''
  }
}

/**
 * Generate the PKCE code verifier.
 * @returns a 64-character RFC 7636 unreserved verifier.
 */
function pkceVerifier(): string {
  let verifier = ''
  for (let index = 0; index < VERIFIER_LENGTH; index += 1) verifier += randomVerifierCharacter()
  return verifier
}

/**
 * Compare the callback state against the expected state without leaking timing.
 * @param received - State value from the callback query.
 * @param expected - Random state this login generated.
 * @returns whether the values are byte-identical.
 */
function sameState(received: string, expected: string): boolean {
  const left = Buffer.from(received, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * Answer one callback request and close the response.
 * @param response - Browser response to complete.
 * @param status - HTTP status to report.
 * @param body - Plain-text or HTML body describing the outcome.
 */
function respond(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'content-type': status === 200 ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(body)
}

interface CallbackListener {
  redirectUri: string
  code: Promise<string>
  stop(): Promise<void>
}

/**
 * Close one HTTP server and destroy its sockets, resolving once the server is quiescent.
 * @param server - The server to release.
 * @returns resolved after the server emitted `close`.
 */
async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => { resolve() })
    server.closeAllConnections()
  })
}

/**
 * Bind a one-shot loopback listener that validates the authorization callback. A bind failure
 * rejects through the same promise; after bind, a server error rejects the pending code, which
 * the login deadline bounds even when the code was already resolved.
 * @param expectedState - Random state this login generated.
 * @returns the bound listener with its redirect URI, code promise, and quiescent stop.
 */
async function startCallback(expectedState: string): Promise<CallbackListener> {
  let resolveCode: ((code: string) => void) | undefined
  let rejectCode!: (error: Error) => void
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })
  const server: Server = createServer((request, response) => { handle(request, response) })
  let settled = false
  await new Promise<void>((listening, failed) => {
    server.once('error', failed)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', failed)
      listening()
    })
  })
  // listen(0, '127.0.0.1') always reports an AddressInfo once the listening event fired.
  const { port } = server.address() as AddressInfo
  server.on('error', rejectCode)

  /**
   * Validate one callback request: GET on the exact path with exactly one `code` and one `state`,
   * the state byte-identical to this login's value. Mismatches answer 4xx and keep listening;
   * the first valid callback settles the login and later ones answer 400.
   * @param request - The browser request.
   * @param response - The browser response.
   */
  function handle(request: IncomingMessage, response: ServerResponse): void {
    if (settled) {
      respond(response, 400, 'The authorization callback was already processed.')
      return
    }
    if (request.method !== 'GET') {
      respond(response, 405, 'Only GET is accepted on the callback.')
      return
    }
    // A malformed or absolute-form request target parses to null; answer 400 instead of throwing
    // out of the HTTP callback, which would take the process down.
    const url = URL.parse(String(request.url), 'http://127.0.0.1')
    if (url === null || url.pathname !== CALLBACK_PATH) {
      respond(response, 404, 'Unknown callback path.')
      return
    }
    const codes = url.searchParams.getAll('code')
    const states = url.searchParams.getAll('state')
    const receivedCode = codes.length === 1 ? codes[0] : undefined
    const receivedState = states.length === 1 ? states[0] : undefined
    if (receivedCode === undefined || receivedCode === '' || receivedState === undefined || receivedState === '') {
      respond(response, 400, 'The callback parameters are invalid.')
      return
    }
    if (!sameState(receivedState, expectedState)) {
      respond(response, 400, 'The callback state does not match this sign-in.')
      return
    }
    settled = true
    respond(response, 200, RECEIVED_PAGE)
    resolveCode?.(receivedCode)
  }

  return {
    redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
    code,
    stop: async (): Promise<void> => {
      settled = true
      await stopServer(server)
    },
  }
}

/**
 * Wait for the validated callback code, bounded by the composed login signal.
 * @param code - Promise resolved by the loopback listener.
 * @param signal - Composed login signal carrying the deadline and caller cancellation.
 * @returns the received authorization code.
 */
async function waitForCode(code: Promise<string>, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  let detach!: () => void
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = (): void => {
      detach()
      const timedOut = isTimeout(signal.reason)
      // The login caller rethrows its own raw reason when its signal aborted, so this typed
      // rejection only surfaces for the deadline.
      reject(new RemoteError('hemi/vvcode-login-failed',
        timedOut
          ? 'The VVCode sign-in timed out before the browser returned the authorization.'
          : 'The VVCode sign-in was cancelled.',
        { reason: timedOut ? 'timeout' : 'callback' }, { cause: signal.reason }))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    detach = () => { signal.removeEventListener('abort', onAbort) }
  })
  try {
    return await Promise.race([code, aborted])
  } finally {
    detach()
  }
}

/**
 * Exchange the one-time authorization code for the scoped PAT. The request runs exactly once:
 * a lost response leaves the code possibly consumed, and a correct replay would revoke the PAT.
 * @param origin - Validated deployment origin.
 * @param exchange - Callback result bound to this login.
 * @param maxResponseBytes - Byte budget for the token response.
 * @param signal - Composed login signal.
 * @returns the validated grant.
 */
async function exchangeCode(
  origin: URL,
  exchange: { code: string; verifier: string; state: string; redirectUri: string },
  maxResponseBytes: number,
  signal: AbortSignal,
): Promise<VvcodeGrant> {
  let response: Response
  try {
    signal.throwIfAborted()
    response = await fetch(new URL('/api/oauth/vscode/token', origin), {
      method: 'POST',
      cache: 'no-store',
      redirect: 'error',
      signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: exchange.code,
        code_verifier: exchange.verifier,
        state: exchange.state,
        redirect_uri: exchange.redirectUri,
      }),
    })
  } catch (error: unknown) {
    if (signal.aborted && !isTimeout(signal.reason)) throw signal.reason
    throw new RemoteError('hemi/vvcode-login-failed',
      'The VVCode token exchange failed. Start the sign-in again.', { reason: 'exchange' }, { cause: error })
  }
  let body: unknown
  try {
    body = await readJsonBody(response, maxResponseBytes)
  } catch (error: unknown) {
    if (signal.aborted && !isTimeout(signal.reason)) throw signal.reason
    throw new RemoteError('hemi/vvcode-login-failed',
      'The VVCode token response was unreadable.', { reason: 'exchange' }, { cause: error })
  }
  if (!response.ok) {
    const failure = asObject(body)
    const description = failure?.error_description
    const errorName = failure?.error
    const detail = typeof description === 'string' && description !== ''
      ? description
      : typeof errorName === 'string' && errorName !== '' ? errorName : null
    throw new RemoteError('hemi/vvcode-login-failed',
      detail === null ? 'The VVCode token exchange failed. Start the sign-in again.' : detail,
      { reason: 'exchange' }, { cause: response.status })
  }
  const grant = asObject(body)
  const accessToken = grant?.access_token
  const tokenType = grant?.token_type
  const expiresAt = grant?.expires_at
  const userId = grant?.user_id
  const scope = grant?.scope
  const valid = typeof accessToken === 'string' && /^nap_[A-Za-z0-9_-]{8,512}$/.test(accessToken)
    && tokenType === 'Bearer'
    && typeof expiresAt === 'number' && Number.isSafeInteger(expiresAt) && expiresAt > 0
    && typeof userId === 'number' && Number.isSafeInteger(userId) && userId > 0
    && typeof scope === 'string'
  if (!valid) {
    throw new RemoteError('hemi/vvcode-login-failed', 'The VVCode token response was invalid.', { reason: 'exchange' })
  }
  const expiresAtMs = expiresAt * 1000
  if (expiresAtMs <= Date.now()) {
    throw new RemoteError('hemi/vvcode-login-failed', 'The VVCode token response reported an expired token.', { reason: 'exchange' })
  }
  const scopes = scope.split(/\s+/).filter(name => name !== '')
  if (scopes.length === 0) {
    throw new RemoteError('hemi/vvcode-login-failed', 'The VVCode token response carried no scopes.', { reason: 'exchange' })
  }
  return { accessToken, userId, expiresAt: expiresAtMs, scopes }
}

/**
 * Run one full VVCode browser login: bind a loopback listener, let the caller open the start URL,
 * wait for the validated callback, and exchange the code for the scoped PAT in exactly one request.
 * The code exchange is never retried: a lost response leaves the one-time code consumed.
 * @param input - Origin, budgets, optional notifier and cancellation signal.
 * @returns the validated grant with the epoch-millisecond expiry.
 */
export async function loginVvcode(input: VvcodeLoginInput): Promise<VvcodeGrant> {
  positiveInt(input.timeoutMs, 'login timeout')
  positiveInt(input.maxResponseBytes, 'response byte budget')
  const origin = resolveOrigin(input.origin)
  input.signal?.throwIfAborted()
  const signal = input.signal === undefined
    ? AbortSignal.timeout(input.timeoutMs)
    : AbortSignal.any([input.signal, AbortSignal.timeout(input.timeoutMs)])
  const verifier = pkceVerifier()
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(32).toString('base64url')
  const listener = await startCallback(state)
  try {
    // The listener bind may outlast the deadline or the caller's patience; fail before notifying.
    if (signal.aborted) {
      const timedOut = isTimeout(signal.reason)
      throw new RemoteError('hemi/vvcode-login-failed',
        timedOut
          ? 'The VVCode sign-in timed out before the browser returned the authorization.'
          : 'The VVCode sign-in was cancelled.',
        { reason: timedOut ? 'timeout' : 'callback' }, { cause: signal.reason })
    }
    const startUrl = new URL('/oauth/vscode/login', origin)
    startUrl.searchParams.set('state', state)
    startUrl.searchParams.set('code_challenge', challenge)
    startUrl.searchParams.set('code_challenge_method', 'S256')
    startUrl.searchParams.set('redirect_uri', listener.redirectUri)
    input.notifyURL?.(startUrl.href)
    const code = await waitForCode(listener.code, signal)
    input.signal?.throwIfAborted()
    return await exchangeCode(origin, { code, verifier, state, redirectUri: listener.redirectUri }, input.maxResponseBytes, signal)
  } catch (error: unknown) {
    if (input.signal?.aborted) throw input.signal.reason
    if (error instanceof RemoteError && error.code === 'hemi/vvcode-login-failed') throw error
    throw new RemoteError('hemi/vvcode-login-failed', 'The VVCode sign-in ended unexpectedly.',
      { reason: 'callback' }, { cause: error })
  } finally {
    await listener.stop()
  }
}
