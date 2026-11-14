/**
 * Wire-boundary primitives for the mobile carrier: the Host/Origin/cross-site
 * request fence, phone device-credential parsing, constant-time secret
 * comparison, capped JSON body reads, and node:http response writing. Every
 * value here crosses the TLS listener, so nothing trusts the caller.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** Cookie the phone keeps after its first `GET /mobile/session`. */
export const MOBILE_SESSION_COOKIE = '__Host-hemi-mobile'

/** Lowercase UUID grammar of a device id. */
const DEVICE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** base64url of exactly 32 bytes: 43 characters, no padding. */
const DEVICE_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/

/** Six decimal digits. */
const VERIFICATION_CODE_PATTERN = /^\d{6}$/

/** `<deviceId>.<secret>` as the Authorization bearer value or cookie carries it. */
export interface DeviceCredential {
  readonly deviceId: string
  readonly secret: string
}

/**
 * Parse one `<deviceId>.<secret>` value; a wrong grammar is not a device.
 * @param value - bearer token or cookie value.
 * @returns the credential when both halves match their grammar.
 */
export function parseDeviceCredentialValue(value: string): DeviceCredential | undefined {
  const separator = value.indexOf('.')
  if (separator === -1) return undefined
  const deviceId = value.slice(0, separator)
  const secret = value.slice(separator + 1)
  if (!DEVICE_ID_PATTERN.test(deviceId) || !DEVICE_SECRET_PATTERN.test(secret)) return undefined
  return { deviceId, secret }
}

/**
 * Extract the device credential from an Authorization header.
 * @param header - raw `authorization` value, when present.
 * @returns the credential for a well-formed `Bearer` value.
 */
export function parseBearerCredential(header: string | undefined): DeviceCredential | undefined {
  if (header === undefined) return undefined
  const prefix = 'bearer '
  if (!header.toLowerCase().startsWith(prefix)) return undefined
  return parseDeviceCredentialValue(header.slice(prefix.length))
}

/**
 * Extract the device credential from the session cookie.
 * @param header - raw `cookie` value, when present.
 * @returns the credential when the session cookie holds a valid value.
 */
export function parseCookieCredential(header: string | undefined): DeviceCredential | undefined {
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator === -1) continue
    if (part.slice(0, separator).trim() !== MOBILE_SESSION_COOKIE) continue
    return parseDeviceCredentialValue(part.slice(separator + 1).trim())
  }
  return undefined
}

/**
 * SHA-256 hex digest of one device secret; the only stored and compared form.
 * @param secret - presented or generated secret.
 * @returns lowercase hex digest.
 */
export function hashDeviceSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

/**
 * Constant-time secret check: both sides hash to a fixed 32-byte digest first,
 * so length differences cannot leak through comparison time.
 * @param presented - secret exactly as the phone presented it.
 * @param storedHash - stored sha256 hex digest.
 * @returns true only on an exact digest match.
 */
export function deviceSecretMatches(presented: string, storedHash: string): boolean {
  const presentedHash = Buffer.from(hashDeviceSecret(presented), 'hex')
  const stored = Buffer.from(storedHash, 'hex')
  if (presentedHash.length !== stored.length || stored.length !== 32) return false
  return timingSafeEqual(presentedHash, stored)
}

/**
 * Constant-time six-digit verification-code check.
 * @param presented - code as the desktop owner entered it.
 * @param expected - code as the claim generated it.
 * @returns true only on an exact match.
 */
export function verificationCodeMatches(presented: string, expected: string): boolean {
  if (!VERIFICATION_CODE_PATTERN.test(presented) || !VERIFICATION_CODE_PATTERN.test(expected)) return false
  return timingSafeEqual(Buffer.from(presented, 'utf8'), Buffer.from(expected, 'utf8'))
}

/** Which fence a request failed; each maps to one refusal status. */
export type RequestFenceFailure = 'host' | 'origin' | 'cross-site'

/**
 * Apply the carrier fence: the Host header must name this listener, a present
 * Origin must be this listener's origin, and a present `Sec-Fetch-Site` must
 * not name another site. Forwarded and by-hop headers are never read, so no
 * proxy can satisfy the fence for the caller.
 * @param headers - request headers from node:http.
 * @param expectedAuthority - `<IPv4>:<port>` this listener bound.
 * @returns the failed fence, or undefined when the request may proceed.
 */
export function requestFenceFailure(
  headers: IncomingMessage['headers'],
  expectedAuthority: string,
): RequestFenceFailure | undefined {
  const host = headers.host
  if (host === undefined || host.toLowerCase() !== expectedAuthority) return 'host'
  const origin = headers.origin
  if (origin !== undefined && origin.toLowerCase() !== `https://${expectedAuthority}`) return 'origin'
  const fetchSite = headers['sec-fetch-site']
  if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') return 'cross-site'
  return undefined
}

/** Capped JSON body read outcome. */
export type JsonBodyResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: 'too-large' | 'not-json' }

/**
 * Read one request body as JSON under a hard byte cap. The declared
 * content-length is checked before any byte is read; a streamed body that
 * exceeds the cap aborts the read without buffering further.
 * @param req - incoming request whose body is read exactly once.
 * @param maxBytes - maximum accepted body size.
 * @returns the parsed JSON value, or which fence rejected the body.
 */
export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<JsonBodyResult> {
  const declaredLength = req.headers['content-length']
  if (declaredLength !== undefined && Number(declaredLength) > maxBytes) return { ok: false, reason: 'too-large' }
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    received += buffer.byteLength
    if (received > maxBytes) return { ok: false, reason: 'too-large' }
    chunks.push(buffer)
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return { ok: true, value }
  } catch {
    return { ok: false, reason: 'not-json' }
  }
}

/**
 * Write one JSON response and end the exchange.
 * @param res - response owned by the caller.
 * @param status - HTTP status.
 * @param body - JSON-serializable value.
 * @param headers - additional headers, such as `set-cookie`.
 */
export function writeJsonResponse(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(payload.byteLength), ...headers })
  res.end(payload)
}

/**
 * Write a bare status line to a socket that requested an upgrade and close it;
 * an upgrade has no response object to write through.
 * @param socket - upgrade socket owned by the caller.
 * @param status - refusal status; the text is the standard reason phrase.
 */
export function refuseUpgrade(socket: { write(chunk: string): unknown; destroy(): unknown }, status: 401 | 403 | 404 | 503): void {
  const phrase = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : status === 404 ? 'Not Found' : 'Service Unavailable'
  socket.write(`HTTP/1.1 ${String(status)} ${phrase}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`)
  socket.destroy()
}

/**
 * Write a Fetch response onto a node:http exchange with backpressure; a HEAD
 * request and a null body write no body bytes.
 * @param res - response owned until this returns.
 * @param response - Fetch response to transfer.
 * @param head - whether the request method was HEAD.
 */
export async function writeFetchResponse(res: ServerResponse, response: Response, head: boolean): Promise<void> {
  const headers: Record<string, string | string[]> = {}
  for (const [name, value] of response.headers) {
    const existing = headers[name]
    headers[name] = existing === undefined ? value : [...(typeof existing === 'string' ? [existing] : existing), value]
  }
  const cookies = response.headers.getSetCookie()
  if (cookies.length > 0) headers['set-cookie'] = cookies
  res.writeHead(response.status, headers)
  const body = response.body
  if (body === null || head) {
    await body?.cancel()
    res.end()
    return
  }
  let resume: (() => void) | undefined
  const wake = (): void => {
    const waiting = resume
    resume = undefined
    waiting?.()
  }
  res.on('drain', wake)
  res.on('close', wake)
  try {
    for await (const chunk of body) {
      if (!res.write(chunk) && !res.destroyed) await new Promise<void>((resolve) => { resume = resolve })
    }
    res.end()
  } finally {
    res.off('drain', wake)
    res.off('close', wake)
  }
}
