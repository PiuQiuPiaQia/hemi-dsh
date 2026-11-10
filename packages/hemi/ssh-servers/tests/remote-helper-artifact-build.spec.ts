/** Unit coverage for the app-owned remote helper artifact build: payload selection, digests, and portability. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  REMOTE_HELPER_BOOTSTRAP,
  REMOTE_HELPER_ENTRY,
  assertPortableModule,
  collectRemoteHelperFiles,
  isArtifactNoise,
  writeRuntimePackage,
} from '../build/remote-helper.ts'

const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
const runtimePackageText = `${JSON.stringify({ name: 'hemi-ssh-helper-runtime', version: '1.2.3-test', type: 'module' }, null, 2)}\n`

let root: string

/** Lay down one complete artifact tree; individual tests delete or add entries. */
async function writeCompleteTree(): Promise<void> {
  await mkdir(join(root, 'runtime/helper/inner'), { recursive: true })
  await writeFile(join(root, 'runtime/helper/helper.js'), 'export const helper = 1\n')
  await writeFile(join(root, 'runtime/helper/koffi-chunk.js'), 'export const koffi = 2\n')
  await writeFile(join(root, 'runtime/helper/ptc-process.js'), 'export const ptc = 3\n')
  await writeFile(join(root, 'runtime/helper/inner/real.js'), 'export const inner = 4\n')
  await writeRuntimePackage(root, '1.2.3-test')
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hemi-remote-helper-spec-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('artifact residue exclusion', () => {
  it('excludes exact AppleDouble metadata and compiler residue on every segment', () => {
    expect(isArtifactNoise('runtime/helper/._helper.js')).toBe(true)
    expect(isArtifactNoise('runtime/helper/helper.js')).toBe(false)
    expect(isArtifactNoise('runtime/helper/inner.js.tsbuildinfo')).toBe(true)
    expect(isArtifactNoise('runtime/helper/inner/real.js')).toBe(false)
  })

  it('keeps a legitimate dot-prefixed payload name', () => {
    expect(isArtifactNoise('runtime/helper/.well-known.js')).toBe(false)
  })
})

describe('runtime package manifest', () => {
  it('writes the attribution manifest with a trailing newline', async () => {
    await writeRuntimePackage(root, '9.9.9-alpha.1')
    await expect(readFile(join(root, 'runtime/package.json'), 'utf8')).resolves.toBe(
      `${JSON.stringify({ name: 'hemi-ssh-helper-runtime', version: '9.9.9-alpha.1', type: 'module' }, null, 2)}\n`,
    )
  })
})

describe('artifact file collection', () => {
  beforeEach(writeCompleteTree)

  it('digests every payload file in deterministic path order and skips residue', async () => {
    await writeFile(join(root, 'runtime/helper/._helper.js'), 'sidecar')
    await writeFile(join(root, 'runtime/helper/inner/._real.js'), 'sidecar')
    await writeFile(join(root, 'runtime/helper/stale.tsbuildinfo'), 'stale')
    await expect(collectRemoteHelperFiles(root)).resolves.toEqual([
      { path: REMOTE_HELPER_ENTRY, sha256: digest('export const helper = 1\n') },
      { path: 'runtime/helper/inner/real.js', sha256: digest('export const inner = 4\n') },
      { path: 'runtime/helper/koffi-chunk.js', sha256: digest('export const koffi = 2\n') },
      { path: REMOTE_HELPER_BOOTSTRAP, sha256: digest('export const ptc = 3\n') },
      { path: 'runtime/package.json', sha256: digest(runtimePackageText) },
    ])
  })

  it('fails loud when the helper entry is absent', async () => {
    await rm(join(root, REMOTE_HELPER_ENTRY))
    await expect(collectRemoteHelperFiles(root)).rejects.toThrow(`remote helper artifact set is missing ${REMOTE_HELPER_ENTRY}`)
  })

  it('fails loud when the PTC bootstrap is absent', async () => {
    await rm(join(root, REMOTE_HELPER_BOOTSTRAP))
    await expect(collectRemoteHelperFiles(root)).rejects.toThrow(`remote helper artifact set is missing ${REMOTE_HELPER_BOOTSTRAP}`)
  })

  it('fails loud when the nested runtime package manifest is absent', async () => {
    await rm(join(root, 'runtime/package.json'))
    await expect(collectRemoteHelperFiles(root)).rejects.toThrow('remote helper artifact set is missing runtime/package.json')
  })
})

describe('bundled module portability', () => {
  it('rejects static workspace imports in every statement form', () => {
    for (const source of [
      'import{x}from"@deepseek-ai/dsh-ssh/protocol"',
      'import "@deepseek-ai/dsh-ssh"',
      'export * from \'@deepseek-ai/dsh-fs\'',
      'const load = () => import("@deepseek-ai/dsh-brand")',
      '__require("@deepseek-ai/dsh-brand")',
    ]) {
      expect(() => { assertPortableModule('runtime/helper/helper.js', Buffer.from(source, 'utf8')) })
        .toThrow(/statically imports workspace package @deepseek-ai\/dsh-[a-z-]+/)
    }
  })

  it('allows lazy resolution, absent externals, and documentation mentions', () => {
    expect(() => { assertPortableModule('runtime/helper/helper.js', Buffer.from([
      'const runner = createRequire(import.meta.url)("./runner")',
      'const lazy = createLazyRequire("node-pty", import.meta.url)',
      'const local = path.join(import.meta.resolve("@deepseek-ai/dsh-subprocess-local/runner"))',
      '/** A sandboxing backend (`@deepseek-ai/dsh-fs-sandbox`) stays documented. */',
      'const descriptor = "@deepseek-ai/dsh-typert-protocol/remote-methods"',
    ].join('\n'), 'utf8')) }).not.toThrow()
  })
})
