/** Installation discovery overlaps physical reads without changing dependency precedence. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { createRuntimeResolution } from '../src/profile.ts'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

const nativeReadFile = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).readFile
const roots: string[] = []
afterEach(() => {
  vi.mocked(readFile).mockImplementation(nativeReadFile)
  vi.clearAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function manifest(directory: string, name: string, dependencies: Record<string, string> = {}): string {
  mkdirSync(directory, { recursive: true })
  const path = join(directory, 'package.json')
  writeFileSync(path, JSON.stringify({ name, version: '1.0.0', dependencies }))
  return path
}

function fixture(): { root: string; anchor: string; modules: string } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-installation-resolution-')))
  roots.push(root)
  const anchor = manifest(join(root, 'app'), 'app', { left: '*', right: '*' })
  return { root, anchor, modules: join(dirname(anchor), 'node_modules') }
}

it('reads independent installation manifests before waiting for either read to finish', async () => {
  const f = fixture()
  const left = manifest(join(f.modules, 'left'), 'left')
  const right = manifest(join(f.modules, 'right'), 'right')
  const entered = new Set<string>()
  const both = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  vi.mocked(readFile).mockImplementation(async (path, options) => {
    if (path === left || path === right) {
      entered.add(path)
      if (entered.size === 2) both.resolve(undefined)
      await release.promise
    }
    return nativeReadFile(path, options)
  })
  const resolution = createRuntimeResolution({ installAnchor: f.anchor, home: f.root })
  onTestFinished(async () => { release.resolve(undefined); await Promise.allSettled([resolution]) })
  await Promise.race([both.promise, resolution.then(() => { throw new Error('Discovery did not overlap manifest reads') })])
  expect(entered.size).toBe(2)
  release.resolve(undefined)
  expect((await resolution).entries.map(entry => entry.name)).toEqual(['app', 'left', 'right'])
})

it('keeps the first successful BFS edge when an earlier declaration cannot resolve a package', async () => {
  const f = fixture()
  manifest(join(f.modules, 'left'), 'left', { shared: '*', earlier: '*' })
  manifest(join(f.modules, 'right'), 'right', { shared: '*' })
  const earlier = join(f.modules, 'left', 'node_modules', 'earlier')
  manifest(earlier, 'earlier', { collision: '*' })
  const shared = join(f.modules, 'right', 'node_modules', 'shared')
  manifest(shared, 'shared', { collision: '*' })
  manifest(join(earlier, 'node_modules', 'collision'), 'collision')
  manifest(join(shared, 'node_modules', 'collision'), 'collision')
  const result = await createRuntimeResolution({ installAnchor: f.anchor, home: f.root })
  expect(result.entries.map(entry => entry.name)).toEqual(['app', 'left', 'right', 'earlier', 'shared', 'collision'])
  expect(result.entries.find(entry => entry.name === 'collision')?.declarer).toBe(join(earlier, 'package.json'))
})

it('reports the first traversal error even when a later read fails first', async () => {
  const f = fixture()
  const left = manifest(join(f.modules, 'left'), 'left')
  const right = manifest(join(f.modules, 'right'), 'right')
  const later = Promise.withResolvers<undefined>()
  const firstError = new Error('earlier manifest failed')
  vi.mocked(readFile).mockImplementation(async (path, options) => {
    if (path === left) { await later.promise; throw firstError }
    if (path === right) { later.resolve(undefined); throw new Error('later manifest failed first') }
    return nativeReadFile(path, options)
  })
  await expect(createRuntimeResolution({ installAnchor: f.anchor, home: f.root })).rejects.toBe(firstError)
})
