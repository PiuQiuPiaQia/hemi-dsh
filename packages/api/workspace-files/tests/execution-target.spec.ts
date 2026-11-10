/** Session file operations keep path strings inside the selected execution environment. */
import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import SessionStore, { isSessionExecutionTarget, SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceFiles, type WorkspaceFileScope } from '../src/index.ts'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})

/** Real files in two private trees share the same public path spelling. */
class NamespacedFiles extends LocalFileSystem {
  constructor(ctx: Context, private readonly physical: string, private readonly namespace: string) {
    super(ctx, { cwd: physical, diffBasisMaxBytes: 1024 })
  }

  override resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    return super.resolve(this.translate(path, opts?.cwd), opts?.signal === undefined ? {} : { signal: opts.signal })
  }

  override lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal) {
    return super.lstat(this.translate(path, opts?.cwd), {}, signal)
  }

  override processPath(target: FsTarget): string {
    return join(this.namespace, relative(this.physical, super.processPath(target)))
  }

  private translate(path: string, cwd = this.namespace): string {
    return join(this.physical, relative(this.namespace, resolve(cwd, path)))
  }
}

async function fixture() {
  const allocated = await mkdtemp(join(tmpdir(), 'dsh-workspace-world-'))
  const root = await realpath(allocated)
  cleanups.push(async () => {
    if (await realpath(allocated) !== root) throw new Error('fixture root was replaced')
    await rm(root, { recursive: true, force: true })
  })
  const hostRoot = join(root, 'host'), remoteRoot = join(root, 'remote')
  const namespace = join(root, 'public-path')
  await mkdir(join(hostRoot, 'content'), { recursive: true })
  await mkdir(join(remoteRoot, 'content'), { recursive: true })
  for (const [directory, text] of [[hostRoot, 'Host secret'], [remoteRoot, 'remote value']]) {
    await writeFile(join(directory!, 'notes.txt'), text!)
    await writeFile(join(directory!, 'content', 'base.md'), '# document')
    await writeFile(join(directory!, 'content', 'image.bin'), text!)
  }
  await writeFile(join(hostRoot, 'host-only.txt'), 'must not be listed')
  await writeFile(join(remoteRoot, 'remote-only.txt'), 'target entry')
  const ctx = new Context(), label = Symbol('remote filesystem')
  const remote = ctx.isolate('fs', label)
  cleanups.push(async () => { await ctx.fiber.dispose() })
  new NamespacedFiles(ctx, hostRoot, namespace)
  new NamespacedFiles(remote, remoteRoot, namespace)
  ctx.provide('sandboxPolicy', { workspaceRoot: namespace } as never)
  await ctx.plugin(SessionStore)
  const reference = { provider: 'fixture', id: 'saved-directory' }
  if (!isSessionExecutionTarget(reference)) throw new Error('invalid fixture target')
  const closed = vi.fn(async () => {})
  const withdraw = ctx.sessions.registerExecutionProvider(reference.provider, {
    acquire: async (_id, signal) => ({ realm: Symbol('remote'), signal, bind: base => base.isolate('fs', label), close: closed }),
  })
  const scope: WorkspaceFileScope = { sessionId: SessionId('targeted'), workspaceRoot: namespace, executionTarget: reference }
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(WorkspaceFiles, { maxBytes: 1024, maxFileBytes: 1024, maxLines: 100, maxEntries: 100 })
  const files = ctx.get('workspaceFiles')!
  const hostResolve = vi.spyOn(ctx.fs, 'resolve')
  return { ctx, remote, scope, files, closed, withdraw, hostResolve, namespace }
}

it('reads text, bytes, relative media, metadata and listings from the selected filesystem only', async () => {
  const f = await fixture(), signal = new AbortController().signal
  expect(await f.files.read(f.scope, 'notes.txt', {}, signal)).toMatchObject({ text: 'remote value' })
  expect(Buffer.from((await f.files.readBytes(f.scope, 'notes.txt', {}, signal)).data).toString()).toBe('remote value')
  expect(Buffer.from((await f.files.readBytes(f.scope, 'image.bin', { baseFile: 'content/base.md' }, signal)).data).toString()).toBe('remote value')
  expect(await f.files.stat(f.scope, 'notes.txt', signal)).toMatchObject({ absolutePath: join(f.namespace, 'notes.txt'), bytes: 12 })
  const listing = await f.files.list(f.scope, '.', signal)
  expect(listing.entries.map(entry => entry.name)).toContain('remote-only.txt')
  expect(listing.entries.map(entry => entry.name)).not.toContain('host-only.txt')
  expect(f.hostResolve).not.toHaveBeenCalled()
  expect(f.closed).toHaveBeenCalledTimes(5)
})

it('refuses an offline target rather than reading a same-spelled Host file', async () => {
  const f = await fixture()
  await f.withdraw()
  await expect(f.files.read(f.scope, 'notes.txt', {}, new AbortController().signal))
    .rejects.toMatchObject({ code: 'EXECUTION_TARGET_UNAVAILABLE' })
  expect(f.hostResolve).not.toHaveBeenCalled()
})

it('reports unsupported remote watching without starting a Host watcher', async () => {
  const f = await fixture()
  const hostWatch = vi.spyOn(f.ctx.fs, 'watch')
  vi.spyOn(f.remote.fs, 'watch').mockRejectedValue(new Error('remote watches unavailable'))
  const changes = f.files.changes(f.scope, 'notes.txt', new AbortController().signal)[Symbol.asyncIterator]()
  try { await expect(changes.next()).rejects.toMatchObject({ code: 'workspace-file/watch-unsupported' }) }
  finally { await changes.return?.() }
  expect(hostWatch).not.toHaveBeenCalled()
  expect(f.closed).toHaveBeenCalledOnce()
})

it('retains a cancelled read lease until the source iterator has actually settled', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  vi.spyOn(f.remote.fs, 'streamText').mockImplementation(async (_target, signal) => (async function* () {
    entered.resolve(undefined)
    await release.promise
    signal?.throwIfAborted()
    yield 'remote value'
  })())
  const controller = new AbortController()
  const reading = f.files.read(f.scope, 'notes.txt', {}, controller.signal)
  try {
    await entered.promise
    controller.abort(new Error('reader cancelled'))
    expect(f.closed).not.toHaveBeenCalled()
    release.resolve(undefined)
    await expect(reading).rejects.toThrow('reader cancelled')
    expect(f.closed).toHaveBeenCalledOnce()
  } finally { release.resolve(undefined); await Promise.allSettled([reading]) }
})
