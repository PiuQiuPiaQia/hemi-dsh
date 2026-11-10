/** Desktop file-drag authorization borrows a native file only through the Session's own execution filesystem. */
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import SessionStore, { type SessionExecutionTarget } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { localDragResource } from '../src/file-drag.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-host-drag-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(SessionStore)
  ctx.provide('sandboxPolicy', { workspaceRoot: root } as never)
  const id = SessionId('file-drag-test')
  ctx.sessions.create(id, { meta: { cwd: root, origin: 'subagent' } })
  const path = join(root, '报告.pdf')
  const bytes = Buffer.from('%PDF-1.4\n原始内容\n%%EOF')
  await writeFile(path, bytes)
  return { ctx, root, id, path, bytes, address: sessionFileAddress(id, '报告.pdf') }
}

const remoteTarget: SessionExecutionTarget = {
  provider: brandString<SessionExecutionTarget['provider']>('file-drag-remote'),
  id: brandString<SessionExecutionTarget['id']>('target'),
}

async function remoteFixture(cold: boolean, mapping: (hostPath: string) => string | undefined) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-host-drag-remote-')))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(SessionStore)
  ctx.provide('sandboxPolicy', { workspaceRoot: root } as never)
  const path = join(root, 'share.png')
  await writeFile(path, Buffer.from('host-private-bytes'))
  const remoteBytes = new TextEncoder().encode('remote-authoritative-bytes')
  const id = SessionId('file-drag-remote')
  if (cold) {
    const header = ctx.sessions.prepare(id, { meta: { cwd: root, executionTarget: remoteTarget } }).header
    ctx.provide('sessionPersistence', { stat: vi.fn(async () => ({ header })) } as never)
  } else ctx.sessions.create(id, { meta: { cwd: root, executionTarget: remoteTarget } })
  const label = Symbol('remote filesystem')
  const remote = ctx.isolate('fs', label)
  const fs = {
    lstat: vi.fn(async () => ({ type: 'file' as const })),
    resolve: vi.fn(async (value: string) => ({ targetKey: FsTargetKey(`remote:${value}`), displayPath: value })),
    processPath: (value: { displayPath: string }) => value.displayPath,
    processPathFromHostPath: vi.fn(mapping),
    stat: vi.fn(async () => ({ type: 'file' as const, version: FsVersion('remote-v1'), size: remoteBytes.length })),
    readByteRange: vi.fn(async (_target: unknown, range: { offset: number; length: number }, _signal?: AbortSignal): Promise<Uint8Array> =>
      remoteBytes.subarray(range.offset, range.offset + range.length)),
  }
  remote.provide('fs', fs as never)
  const disconnect = new AbortController()
  const close = vi.fn(async () => {})
  const acquire = vi.fn(async () => ({ realm: Symbol('remote'), signal: disconnect.signal,
    bind: (base: Context) => base.isolate('fs', label), close }))
  const unregister = ctx.sessions.registerExecutionProvider(remoteTarget.provider, { acquire })
  onTestFinished(unregister)
  return { ctx, root, id, path, address: sessionFileAddress(id, path), fs, remoteBytes, acquire, close, disconnect }
}

it('authorizes Session-relative file reads and returns their original digest privately to main', async () => {
  const f = await fixture()
  expect(await localDragResource(f.ctx, f.address)).toEqual({
    path: await realpath(f.path), size: f.bytes.length, sha256: createHash('sha256').update(f.bytes).digest('hex'),
  })
})

it('rejects unscoped references and missing Sessions', async () => {
  const f = await fixture()
  await expect(localDragResource(f.ctx, f.path)).rejects.toThrow('Session resource')
  await expect(localDragResource(f.ctx, sessionFileAddress('missing', f.path))).rejects.toThrow('Session unavailable')
  await expect(localDragResource(f.ctx, sessionFileAddress(f.id, f.root))).resolves.toBeNull()
})

it('does not authorize borrowing when the filesystem has no Host mapping', async () => {
  const f = await fixture()
  vi.spyOn(f.ctx.fs, 'processPathFromHostPath').mockReturnValue(undefined)
  expect(await localDragResource(f.ctx, f.address)).toBeNull()
})

it('honors filesystem read denial without returning a path', async () => {
  const f = await fixture()
  vi.spyOn(f.ctx.fs, 'readByteRange').mockRejectedValue(new Error('read denied'))
  await expect(localDragResource(f.ctx, f.address)).rejects.toThrow('read denied')
})

it.skipIf(process.platform === 'win32')('declines symlink borrowing so the authorized byte reader can copy it', async () => {
  const f = await fixture()
  await symlink(f.path, join(f.root, 'linked.pdf'))
  expect(await localDragResource(f.ctx, sessionFileAddress(f.id, 'linked.pdf'))).toBeNull()
})

it('stops a chunked authorization read when the caller cancels', async () => {
  const f = await fixture()
  const pending = Promise.withResolvers<Uint8Array>()
  const reading = vi.spyOn(f.ctx.fs, 'readByteRange').mockReturnValue(pending.promise)
  const abort = new AbortController()
  const preparing = localDragResource(f.ctx, f.address, abort.signal)
  const rejected = expect(preparing).rejects.toThrow()
  await vi.waitFor(() => { expect(reading).toHaveBeenCalledOnce() })
  const signal = reading.mock.calls[0]![2]
  abort.abort()
  expect(signal?.aborted).toBe(true)
  pending.resolve(f.bytes)
  await rejected
})

it('authorizes empty files and detects content changes while reading', async () => {
  const f = await fixture()
  await writeFile(f.path, '')
  expect(await localDragResource(f.ctx, f.address)).toMatchObject({ size: 0, sha256: createHash('sha256').digest('hex') })
  await writeFile(f.path, f.bytes)
  vi.spyOn(f.ctx.fs, 'readByteRange').mockResolvedValueOnce(new Uint8Array())
  await expect(localDragResource(f.ctx, f.address)).resolves.toBeNull()
})

it.each([false, true])('does not borrow a same-spelled Host file for a targeted Session, cold=%s', async (cold) => {
  const f = await remoteFixture(cold, () => undefined)
  const hostResolve = vi.spyOn(f.ctx.fs, 'resolve')
  const hostRead = vi.spyOn(f.ctx.fs, 'readByteRange')
  expect(await localDragResource(f.ctx, f.address)).toBeNull()
  expect(f.fs.lstat).toHaveBeenCalledOnce()
  expect(hostResolve).not.toHaveBeenCalled()
  expect(hostRead).not.toHaveBeenCalled()
  expect(f.close).toHaveBeenCalledOnce()
})

it('borrows through a mapped execution filesystem and digests only its authorized bytes', async () => {
  const f = await remoteFixture(false, hostPath => hostPath)
  const hostResolve = vi.spyOn(f.ctx.fs, 'resolve')
  const hostRead = vi.spyOn(f.ctx.fs, 'readByteRange')
  expect(await localDragResource(f.ctx, f.address)).toEqual({
    path: f.path, size: f.remoteBytes.length, sha256: createHash('sha256').update(f.remoteBytes).digest('hex'),
  })
  expect(hostResolve).not.toHaveBeenCalled()
  expect(hostRead).not.toHaveBeenCalled()
  expect(f.close).toHaveBeenCalledOnce()
})

it('rejects a targeted Session whose execution environment is stopped, without Host fallback', async () => {
  const f = await remoteFixture(false, () => undefined)
  f.acquire.mockRejectedValueOnce(new Error('provider offline'))
  const hostResolve = vi.spyOn(f.ctx.fs, 'resolve')
  await expect(localDragResource(f.ctx, f.address)).rejects.toThrow('execution environment unavailable')
  expect(hostResolve).not.toHaveBeenCalled()
  expect(f.close).not.toHaveBeenCalled()
})

it('stops a targeted authorization read and closes the lease when the caller cancels', async () => {
  const f = await remoteFixture(false, hostPath => hostPath)
  const pending = Promise.withResolvers<Uint8Array>()
  const reading = f.fs.readByteRange.mockReturnValue(pending.promise)
  const abort = new AbortController()
  const rejected = expect(localDragResource(f.ctx, f.address, abort.signal)).rejects.toThrow()
  await vi.waitFor(() => { expect(reading).toHaveBeenCalledOnce() })
  const signal = reading.mock.calls[0]![2]
  abort.abort()
  expect(signal?.aborted).toBe(true)
  pending.resolve(f.remoteBytes.subarray(0, 1))
  await rejected
  expect(f.close).toHaveBeenCalledOnce()
})

it('rejects with a disconnected report when the execution environment drops mid-read', async () => {
  const f = await remoteFixture(false, hostPath => hostPath)
  const pending = Promise.withResolvers<Uint8Array>()
  const reading = f.fs.readByteRange.mockReturnValue(pending.promise)
  const rejected = expect(localDragResource(f.ctx, f.address)).rejects.toThrow('disconnected')
  await vi.waitFor(() => { expect(reading).toHaveBeenCalledOnce() })
  f.disconnect.abort(new Error('connection lost'))
  pending.resolve(f.remoteBytes.subarray(0, 1))
  await rejected
  expect(f.close).toHaveBeenCalledOnce()
})
