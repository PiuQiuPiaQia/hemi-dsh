/** Session-origin file routes preserve execution identity even when a Host path exists. */
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, type SessionExecutionTarget } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import { FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { expect, it, onTestFinished, vi } from 'vitest'
import SessionController from '../src/index.ts'
import { SessionMediaReferences } from '../src/media-references.ts'

async function fixture(cold = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-session-paths-')))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await ctx.plugin(SessionStore)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  const path = join(root, 'same.png')
  await writeFile(path, 'Host-private-content')
  const target: SessionExecutionTarget = {
    provider: brandString<SessionExecutionTarget['provider']>('session-files'), id: brandString<SessionExecutionTarget['id']>('target'),
  }
  const id = SessionId('remote-files')
  if (cold) {
    const header = ctx.sessions.prepare(id, { meta: { cwd: root, executionTarget: target } }).header
    ctx.provide('sessionPersistence', { stat: vi.fn(async () => ({ header })) } as never)
  } else ctx.sessions.create(id, { meta: { cwd: root, executionTarget: target } })
  const label = Symbol('remote filesystem')
  const remote = ctx.isolate('fs', label)
  const bytes = new TextEncoder().encode('remote-image')
  const fs = {
    resolve: vi.fn(async (value: string) => ({ targetKey: FsTargetKey(value), displayPath: value })),
    stat: vi.fn(async () => ({ type: 'file', version: FsVersion('remote-v1'), size: bytes.length })),
    readBytes: vi.fn(async () => bytes),
    processPathFromHostPath: vi.fn(() => undefined),
    processPath: (value: { displayPath: string }) => value.displayPath,
  }
  remote.provide('fs', fs as never)
  const close = vi.fn(async () => {})
  const acquire = vi.fn(async () => ({ realm: Symbol('remote'), signal: new AbortController().signal,
    bind: (base: Context) => base.isolate('fs', label), close }))
  const unregister = ctx.sessions.registerExecutionProvider(target.provider, { acquire })
  onTestFinished(unregister)
  let fetcher: ((request: Request) => Promise<Response>) | undefined
  ctx.provide('connection', { fetch: { register: (route: { fetch: typeof fetcher }) => {
    fetcher = route.fetch
    return async () => { fetcher = undefined }
  } } } as never)
  ctx.provide('attachments', { imageLimits: { maxImageBytes: 1000 } } as never)
  await ctx.plugin(SessionMediaReferences)
  const request = (url: string) => {
    if (fetcher === undefined) throw new Error('media route unavailable')
    return fetcher(new Request(url))
  }
  const url = `http://localhost/api/file?${new URLSearchParams({ path, sessionId: id })}`
  return { ctx, root, id, path, request, url, fs, close, acquire }
}

it.each([false, true])('reads same-named remote media with Session-preserving redirects, cold=%s', async (cold) => {
  const f = await fixture(cold)
  const hostRead = vi.spyOn(f.ctx.fs, 'readBytes')
  const hostResolve = vi.spyOn(f.ctx.fs, 'resolve')
  const first = await f.request(f.url)
  expect(first.status).toBe(302)
  const versioned = new URL(first.headers.get('location')!, f.url)
  expect(versioned.searchParams.get('sessionId')).toBe(f.id)
  expect(versioned.searchParams.get('path')).toBe(f.path)
  expect(versioned.searchParams.get('v')).toBe('remote-v1')
  const response = await f.request(versioned.href)
  expect(await response.text()).toBe('remote-image')
  expect(hostRead).not.toHaveBeenCalled()
  expect(hostResolve).not.toHaveBeenCalled()
  expect(f.close).toHaveBeenCalledTimes(2)
})

it('refuses an offline cold target without Host file I/O or cacheable success', async () => {
  const f = await fixture(true)
  f.acquire.mockRejectedValueOnce(new Error('offline'))
  const hostResolve = vi.spyOn(f.ctx.fs, 'resolve')
  const response = await f.request(f.url)
  expect(response.status).toBe(503)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(await response.text()).toBe('session/execution-unavailable')
  expect(hostResolve).not.toHaveBeenCalled()
})

it('never hands a Session target path to native open, reveal or association queries without a Host mapping', async () => {
  const f = await fixture(true)
  const openPath = vi.fn(async () => {})
  const revealPath = vi.fn(async () => {})
  const fileApplications = vi.fn(async () => [])
  const controller = new SessionController(f.ctx, { nativeOpen: true }, { openPath, revealPath, fileApplications })
  const request = { sessionId: f.id, path: f.path }
  const signal = new AbortController().signal
  const hostResolve = vi.spyOn(f.ctx.fs, 'resolve')
  for (const operation of [
    () => controller.openWorkspacePath(request, signal),
    () => controller.openWorkspacePath({ ...request, action: 'reveal' }, signal),
    () => controller.workspacePathApplications(request, signal),
  ]) await expect(operation()).rejects.toMatchObject({ code: 'session/path-unavailable' })
  expect(openPath).not.toHaveBeenCalled()
  expect(revealPath).not.toHaveBeenCalled()
  expect(fileApplications).not.toHaveBeenCalled()
  expect(hostResolve).not.toHaveBeenCalled()
  expect(f.close).toHaveBeenCalledTimes(3)
  await controller.openWorkspacePath({ path: f.path }, signal)
  expect(openPath).toHaveBeenCalledOnce()
})
