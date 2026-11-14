/** Wire-boundary primitives: request fence, credential parsing, constant-time comparison, and capped bodies. */

import { describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import {
  deviceSecretMatches,
  hashDeviceSecret,
  parseBearerCredential,
  parseCookieCredential,
  parseDeviceCredentialValue,
  readJsonBody,
  requestFenceFailure,
  verificationCodeMatches,
} from '../src/internal/wire.ts'

const AUTHORITY = '192.168.1.10:43211'

function headers(extra: Record<string, string | undefined>): IncomingMessage['headers'] {
  const out: IncomingMessage['headers'] = {}
  for (const [name, value] of Object.entries(extra)) {
    if (value !== undefined) out[name] = value
  }
  return out
}

describe('request fence', () => {
  it('accepts a matching Host, a same-origin Origin, and native fetch metadata', () => {
    expect(requestFenceFailure(headers({ host: AUTHORITY }), AUTHORITY)).toBeUndefined()
    expect(requestFenceFailure(headers({ host: AUTHORITY, origin: `https://${AUTHORITY}` }), AUTHORITY)).toBeUndefined()
    expect(requestFenceFailure(headers({ host: AUTHORITY, 'sec-fetch-site': 'same-origin' }), AUTHORITY)).toBeUndefined()
    expect(requestFenceFailure(headers({ host: AUTHORITY, 'sec-fetch-site': 'none' }), AUTHORITY)).toBeUndefined()
  })

  it('refuses a foreign Host, a foreign Origin, and a cross-site fetch header', () => {
    expect(requestFenceFailure(headers({ host: 'evil.example:43211' }), AUTHORITY)).toBe('host')
    expect(requestFenceFailure(headers({}), AUTHORITY)).toBe('host')
    expect(requestFenceFailure(headers({ host: AUTHORITY, origin: 'https://evil.example' }), AUTHORITY)).toBe('origin')
    expect(requestFenceFailure(headers({ host: AUTHORITY, 'sec-fetch-site': 'cross-site' }), AUTHORITY)).toBe('cross-site')
    expect(requestFenceFailure(headers({ host: AUTHORITY, 'sec-fetch-site': 'same-site' }), AUTHORITY)).toBe('cross-site')
  })
})

describe('device credentials', () => {
  const deviceId = '44444444-4444-4444-8444-444444444444'
  const secret = 's'.repeat(43)

  it('parses the bearer header and the session cookie', () => {
    expect(parseDeviceCredentialValue(`${deviceId}.${secret}`)).toEqual({ deviceId, secret })
    expect(parseDeviceCredentialValue(`${deviceId}.short`)).toBeUndefined()
    expect(parseDeviceCredentialValue(`not-a-uuid.${secret}`)).toBeUndefined()
    expect(parseBearerCredential(`Bearer ${deviceId}.${secret}`)).toEqual({ deviceId, secret })
    expect(parseBearerCredential(`Basic ${deviceId}.${secret}`)).toBeUndefined()
    expect(parseBearerCredential(undefined)).toBeUndefined()
    expect(parseCookieCredential(`other=1; __Host-hemi-mobile=${deviceId}.${secret}`)).toEqual({ deviceId, secret })
    expect(parseCookieCredential('__Host-hemi-mobile=missing-dot')).toBeUndefined()
  })

  it('compares secrets and codes in constant time over fixed digests', () => {
    const stored = hashDeviceSecret(secret)
    expect(deviceSecretMatches(secret, stored)).toBe(true)
    expect(deviceSecretMatches('x'.repeat(43), stored)).toBe(false)
    expect(deviceSecretMatches(secret, 'ff')).toBe(false)
    expect(verificationCodeMatches('123456', '123456')).toBe(true)
    expect(verificationCodeMatches('123456', '123457')).toBe(false)
    expect(verificationCodeMatches('12345', '123456')).toBe(false)
  })
})

describe('capped JSON bodies', () => {
  function post(body: string, contentLength?: string): IncomingMessage {
    const request = Readable.from([Buffer.from(body)]) as IncomingMessage
    Object.assign(request, { method: 'POST', headers: { 'content-type': 'application/json', ...(contentLength === undefined ? {} : { 'content-length': contentLength }) } })
    return request
  }

  it('parses a body under the cap', async () => {
    await expect(readJsonBody(post('{"a":1}'), 64)).resolves.toEqual({ ok: true, value: { a: 1 } })
  })

  it('refuses an over-cap declared length before reading bytes', async () => {
    await expect(readJsonBody(post('{}', '999'), 64)).resolves.toEqual({ ok: false, reason: 'too-large' })
  })

  it('refuses a streamed body that exceeds the cap mid-read', async () => {
    await expect(readJsonBody(post('x'.repeat(80)), 64)).resolves.toEqual({ ok: false, reason: 'too-large' })
  })

  it('refuses a body that is not JSON', async () => {
    await expect(readJsonBody(post('not json'), 64)).resolves.toEqual({ ok: false, reason: 'not-json' })
  })
})
