/** WebDAV failure classification: stable codes read from the raw response's XML exception field, never from error messages. */
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWebdavClient, type WebdavClient } from '../src/webdav.ts'

/** The quota-exception shape reported by cloud WebDAV providers, with the exact field value. */
const trafficXml = '<?xml version="1.0" encoding="UTF-8"?><D:error xmlns:D="DAV:"><D:exception>TrafficRateExhausted</D:exception></D:error>'

let dir: string
let client: WebdavClient
let part: string

beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), 'hemi-webdav-'))
  part = join(dir, 'part-0000.gz')
  fs.writeFileSync(part, 'payload')
  client = createWebdavClient({ baseUrl: 'https://dav.example/dav/', username: 'user', password: 'app-pass' })
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('blocked', { status: 403 }))
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

it('classifies a quota 403 carrying the exact XML exception value as TRAFFIC_EXHAUSTED', async () => {
  vi.mocked(globalThis.fetch).mockResolvedValue(new Response(trafficXml, { status: 403 }))
  await expect(client.uploadFile('hemi-backups/set/part-0000.gz', part)).rejects.toMatchObject({ name: 'WebdavError', code: 'TRAFFIC_EXHAUSTED' })
})

it.each([
  ['a similar exception name', '<?xml version="1.0"?><D:error xmlns:D="DAV:"><D:exception>OtherTrafficRateExhausted</D:exception></D:error>'],
  ['the exception word outside the exception field', '<?xml version="1.0"?><D:error xmlns:D="DAV:"><D:responsibility>TrafficRateExhausted</D:responsibility></D:error>'],
  ['a plain-text body', 'TrafficRateExhausted'],
])('keeps a 403 failing with %s as FORBIDDEN', async (_label, body) => {
  vi.mocked(globalThis.fetch).mockResolvedValue(new Response(body, { status: 403 }))
  await expect(client.uploadFile('hemi-backups/set/part-0000.gz', part)).rejects.toMatchObject({ code: 'FORBIDDEN' })
})

it('keeps a 401 authoritative even when the body names the quota exception', async () => {
  vi.mocked(globalThis.fetch).mockResolvedValue(new Response(trafficXml, { status: 401 }))
  await expect(client.listDir('hemi-backups')).rejects.toMatchObject({ code: 'AUTH_FAILED' })
})

it('classifies non-quota statuses as NOT_FOUND or REQUEST_FAILED', async () => {
  vi.mocked(globalThis.fetch).mockResolvedValue(new Response('missing', { status: 404 }))
  await expect(client.downloadToFile('hemi-backups/set/manifest.json', join(dir, 'manifest.json'))).rejects.toMatchObject({ code: 'NOT_FOUND' })
  vi.mocked(globalThis.fetch).mockResolvedValue(new Response(trafficXml, { status: 503 }))
  await expect(client.ensureDir('hemi-backups')).rejects.toMatchObject({ code: 'REQUEST_FAILED' })
  await expect(client.downloadToFile('hemi-backups/set/manifest.json', join(dir, 'manifest.json'))).rejects.toMatchObject({ code: 'REQUEST_FAILED' })
})

it('classifies probe failures with the same codes and keeps the diagnostic status', async () => {
  vi.mocked(globalThis.fetch).mockResolvedValue(new Response(trafficXml, { status: 403 }))
  const probe = await client.testConnection()
  expect(probe).toMatchObject({ ok: false, code: 'TRAFFIC_EXHAUSTED' })
  if (probe.ok) throw new Error('Expected the quota probe to fail')
  expect(probe.message).toContain('HTTP 403')
  vi.mocked(globalThis.fetch).mockResolvedValue(new Response('blocked', { status: 403 }))
  expect(await client.testConnection()).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  vi.mocked(globalThis.fetch).mockResolvedValue(new Response('', { status: 401 }))
  expect(await client.testConnection()).toMatchObject({ ok: false, code: 'AUTH_FAILED' })
  vi.mocked(globalThis.fetch).mockResolvedValue(new Response('', { status: 404 }))
  expect(await client.testConnection()).toMatchObject({ ok: false, code: 'NOT_FOUND' })
})

it('reports a rejected request as REQUEST_FAILED', async () => {
  vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError('fetch failed'))
  expect(await client.testConnection()).toMatchObject({ ok: false, code: 'REQUEST_FAILED', message: 'fetch failed' })
})
