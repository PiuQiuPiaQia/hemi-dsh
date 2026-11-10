/** Delivery file actions retain the viewed Session's target through file checks and native handoff. */
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, type SessionExecutionTarget } from '@deepseek-ai/dsh-session'
import { FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import { WorkspaceFiles } from '@deepseek-ai/dsh-api-workspace-files'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import { expect, it, onTestFinished, vi } from 'vitest'
import { registerPresentOpen } from '../src/present-open.ts'

async function fixture(route: 'present' | 'changes', cold: boolean) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-delivery-target-')))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const file = join(root, 'same.txt')
  await writeFile(file, 'Host-private-content')
  await ctx.plugin(SessionStore)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  ctx.provide('sandboxPolicy', { workspaceRoot: root } as never)
  const id = SessionId('viewed')
  const target: SessionExecutionTarget = { provider: 'delivery-target' as SessionExecutionTarget['provider'], id: 'remote' as SessionExecutionTarget['id'] }
  const options = { meta: { cwd: root, executionTarget: target } }
  const session = cold ? ctx.sessions.prepare(id, options) : ctx.sessions.create(id, options)
  if (cold) ctx.provide('sessionPersistence', { stat: async () => ({ header: session.header }) } as never)
  ctx.provide('sessionQuery', { readEvent: async () => ({ session: session.header,
    target: { type: 'deliverables/presented', data: { turn: 1, callId: 'delivery', files: [{ path: file }] } } }) } as never)
  ctx.provide('workspaceChanges', { summary: () => ({ cwd: root, files: [{ path: file }] }) } as never)
  new WorkspaceFiles(ctx, { maxBytes: 1024, maxFileBytes: 1024, maxLines: 100, maxEntries: 100 })
  const openPath = vi.fn(async () => {})
  const revealPath = vi.fn(async () => {})
  const fileApplications = vi.fn(async () => [])
  new SessionController(ctx, { nativeOpen: true }, { openPath, revealPath, fileApplications })
  const label = Symbol('remote filesystem')
  const fs = {
    resolve: vi.fn(async (path: string, options?: { cwd?: string }) => {
      const value = resolve(options?.cwd ?? root, path)
      return { targetKey: FsTargetKey(value), displayPath: value }
    }),
    lstat: vi.fn(async () => ({ type: 'file' })),
    stat: vi.fn(async () => ({ type: 'file', size: 14, version: FsVersion('remote-v1') })),
    processPath: (path: { displayPath: string }) => path.displayPath,
    processPathFromHostPath: vi.fn(() => undefined),
  }
  ctx.isolate('fs', label).provide('fs', fs as never)
  const close = vi.fn(async () => {})
  const acquire = vi.fn(async () => ({ realm: Symbol('remote'), signal: new AbortController().signal,
    bind: (base: Context) => base.isolate('fs', label), close }))
  ctx.effect(() => ctx.sessions.registerExecutionProvider(target.provider, { acquire }))
  const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
  registerPresentOpen(ctx)
  const handler = connection.createSharedFetchHandler('/api')
  const call = (action: 'open' | 'reveal' | 'applications') => handler.fetch(new Request(
    `http://localhost/api/${route}.open?sessionId=${id}&seq=7&index=0${action === 'reveal' ? '&action=reveal' : ''}`,
    { method: action === 'applications' ? 'GET' : 'POST' },
  ), connection.browserPeer)
  return { ctx, fs, openPath, revealPath, fileApplications, acquire, close, call }
}

it.each([
  ['present', false], ['present', true], ['changes', false], ['changes', true],
] as const)('refuses %s native handoffs without a Host mapping, cold=%s', async (route, cold) => {
  const f = await fixture(route, cold)
  const hostResolve = vi.spyOn(f.ctx.fs, 'resolve')
  for (const action of ['open', 'reveal', 'applications'] as const) expect((await f.call(action)).status).toBe(422)
  expect(f.fs.stat).toHaveBeenCalledTimes(3)
  expect(f.fs.processPathFromHostPath).toHaveBeenCalledTimes(3)
  expect(f.close).toHaveBeenCalledTimes(6)
  expect(hostResolve).not.toHaveBeenCalled()
  expect(f.openPath).not.toHaveBeenCalled()
  expect(f.revealPath).not.toHaveBeenCalled()
  expect(f.fileApplications).not.toHaveBeenCalled()
})

it.each(['present', 'changes'] as const)('does not inspect Host files for an offline cold %s target', async (route) => {
  const f = await fixture(route, true)
  f.acquire.mockRejectedValueOnce(new Error('offline'))
  const hostResolve = vi.spyOn(f.ctx.fs, 'resolve')
  expect((await f.call('open')).status).toBe(500)
  expect(hostResolve).not.toHaveBeenCalled()
  expect(f.fs.resolve).not.toHaveBeenCalled()
  expect(f.openPath).not.toHaveBeenCalled()
})
