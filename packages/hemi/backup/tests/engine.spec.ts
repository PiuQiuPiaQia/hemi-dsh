/** Engine behavior: collection whitelist, pack/extract roundtrip, chunking, corruption, and merge restore. */
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync, statSync, utimesSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BACKUP_DIR_PREFIX,
  createBackup,
  decideRestoreAction,
  estimateMerge,
  extractBackup,
  listLocalBackups,
  mergeRestore,
  readManifest,
} from '../src/engine.ts'

let root: string
let dshHome: string
let agentsHome: string
let outDir: string

const write = (abs: string, content: string): void => {
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'hemi-backup-engine-'))
  dshHome = join(root, 'dsh')
  agentsHome = join(root, 'agents')
  outDir = join(root, 'out')
  write(join(dshHome, '.credentials.yaml'), 'version: 1\n')
  write(join(dshHome, '.anonymous-user-id'), 'anon')
  write(join(dshHome, 'sessions/--ws--/session-1/session.v4.jsonl.zstd'), 'abc')
  write(join(dshHome, 'sessions/--ws--/session-1/session.lock'), 'lock')
  write(join(dshHome, 'storages/workspace.json'), '{}')
  write(join(dshHome, 'storages/session_projcache.json'), 'cache')
  write(join(dshHome, 'storages/session_projcache/inner/state.json'), 'cache')
  write(join(dshHome, 'memory/MEMORY.md'), '# memory')
  write(join(dshHome, 'profiles/desktop/cordis.yml'), 'plugins: []\n')
  write(join(dshHome, 'profiles/desktop/settings.yaml'), 'ui: {}\n')
  write(join(dshHome, 'profiles/desktop/node_modules/some-pkg/index.js'), 'export {}')
  write(join(dshHome, 'profiles/node_modules/.pnpm/lock.yaml'), 'lockfile')
  write(join(dshHome, 'cache/tmp.bin'), 'cache')
  write(join(agentsHome, 'skills/small/SKILL.md'), '# small')
  write(join(agentsHome, 'skills/small/assets/theme.css'), 'body{}')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

it('collects the whitelist, excludes caches, locks, and profile node_modules', async () => {
  const { manifest } = await createBackup({ dshHome, agentsHome, outDir, appVersion: 'test', skillMaxBytes: 5 * 1024 * 1024, now: new Date('2026-11-04T10:00:00Z') })
  const rels = await (async () => {
    const staging = join(root, 'staging-1')
    const { entries } = await extractBackup(join(outDir, readdirSync(outDir).find(name => name.startsWith(BACKUP_DIR_PREFIX)) ?? ''), staging)
    return new Set(entries.map(entry => entry.rel))
  })()
  expect(rels.has('dsh/.credentials.yaml')).toBe(true)
  expect(rels.has('dsh/.anonymous-user-id')).toBe(true)
  expect(rels.has('dsh/sessions/--ws--/session-1/session.v4.jsonl.zstd')).toBe(true)
  expect(rels.has('dsh/sessions/--ws--/session-1/session.lock')).toBe(false)
  expect(rels.has('dsh/storages/workspace.json')).toBe(true)
  expect(rels.has('dsh/storages/session_projcache.json')).toBe(false)
  expect(rels.has('dsh/storages/session_projcache/inner/state.json')).toBe(false)
  expect(rels.has('dsh/memory/MEMORY.md')).toBe(true)
  expect(rels.has('dsh/profiles/desktop/cordis.yml')).toBe(true)
  expect(rels.has('dsh/profiles/desktop/settings.yaml')).toBe(true)
  expect([...rels].some(rel => rel.includes('node_modules'))).toBe(false)
  expect(rels.has('dsh/cache/tmp.bin')).toBe(false)
  expect(rels.has('agents/skills/small/SKILL.md')).toBe(true)
  expect(manifest.skipped).toEqual([])
})

it('skips oversize skills whole and records them in the manifest', async () => {
  write(join(agentsHome, 'skills/huge/assets/blob.bin'), 'x'.repeat(64))
  const { manifest } = await createBackup({ dshHome, agentsHome, outDir: join(root, 'out-2'), appVersion: 'test', skillMaxBytes: 32, now: new Date('2026-11-04T11:00:00Z') })
  const names = manifest.skipped.map(skill => skill.name)
  expect(names).toContain('huge')
  expect(names).not.toContain('small')
})

it('chunks volumes at the configured byte budget and keeps every volume verifiable', async () => {
  // Deterministic incompressible payload so the 512-byte budget rolls many volumes.
  const noise = Buffer.from(Array.from({ length: 8192 }, (_, index) => (index * 37 + 11) % 251)).toString('latin1')
  mkdirSync(join(agentsHome, 'skills/small/assets'), { recursive: true })
  writeFileSync(join(agentsHome, 'skills/small/assets/noise.bin'), noise, 'latin1')
  const dir = join(root, 'out-3')
  const { manifest } = await createBackup({ dshHome, agentsHome, outDir: dir, appVersion: 'test', skillMaxBytes: 5 * 1024 * 1024, chunkBytes: 512, now: new Date('2026-11-04T12:00:00Z') })
  expect(manifest.parts.length).toBeGreaterThan(1)
  const staging = join(root, 'staging-3')
  const { entries } = await extractBackup(manifest.parts.length > 0 ? join(dir, readdirSync(dir).find(name => name.startsWith(BACKUP_DIR_PREFIX)) ?? '') : '', staging)
  expect(entries.some(entry => entry.rel === 'agents/skills/small/assets/noise.bin')).toBe(true)
  expect(readFileSync(join(staging, 'agents/skills/small/assets/noise.bin'), 'latin1')).toBe(noise)
})

it('rejects a volume whose bytes were flipped after packing', async () => {
  const dir = join(root, 'out-4')
  const { backupDir } = await createBackup({ dshHome, agentsHome, outDir: dir, appVersion: 'test', skillMaxBytes: 5 * 1024 * 1024, now: new Date('2026-11-04T13:00:00Z') })
  const manifest = readManifest(backupDir)
  writeFileSync(join(backupDir, manifest.parts[0]!.name), readFileSync(join(backupDir, manifest.parts[0]!.name)).subarray(0, 2))
  await expect(extractBackup(backupDir, join(root, 'staging-4'))).rejects.toThrow(/size mismatch|sha256/)
})

it('merges a restore: new files land, identical files skip, conflicts keep the newer side, credentials swap whole', async () => {
  const dir = join(root, 'out-5')
  const { backupDir } = await createBackup({ dshHome, agentsHome, outDir: dir, appVersion: 'test', skillMaxBytes: 5 * 1024 * 1024, now: new Date('2026-11-04T14:00:00Z') })
  const staging = join(root, 'staging-5')
  await extractBackup(backupDir, staging)
  // Local mutations after the backup: one newer file, one identical file.
  write(join(dshHome, 'memory/MEMORY.md'), 'changed after backup')
  utimesSync(join(dshHome, 'memory/MEMORY.md'), new Date('2030-01-01T00:00:00Z'), new Date('2030-01-01T00:00:00Z'))
  rmSync(join(dshHome, 'sessions/--ws--/session-1'), { recursive: true })
  const safeCopy = join(root, 'safe-5')
  const roots = { dsh: dshHome, agents: agentsHome }
  const estimate = await estimateMerge(staging, roots)
  const { stats } = await mergeRestore({ stagingDir: staging, roots, safeCopyRoot: safeCopy })
  expect(stats.newFiles).toBe(estimate.newFiles)
  expect(stats.identical).toBe(estimate.identical)
  expect(readFileSync(join(dshHome, 'memory/MEMORY.md'), 'utf8')).toBe('changed after backup')
  expect(existsSync(join(safeCopy, 'dsh/memory/MEMORY.md'))).toBe(true)
  expect(readFileSync(join(dshHome, 'sessions/--ws--/session-1/session.v4.jsonl.zstd'), 'utf8')).toBe('abc')
  // Identical files (anonymous id untouched by restore) keep both sides.
  expect(readFileSync(join(dshHome, '.anonymous-user-id'), 'utf8')).toBe('anon')
})

it('replaces the credentials file whole when the backup version differs', async () => {
  const staging = join(root, 'staging-6')
  mkdirSync(staging, { recursive: true })
  write(join(staging, 'dsh/.credentials.yaml'), 'version: 2\n')
  const action = await decideRestoreAction(join(staging, 'dsh/.credentials.yaml'), join(dshHome, '.credentials.yaml'), 'dsh/.credentials.yaml', dshHome)
  expect(action).toBe('takeBackup')
  const safeCopy = join(root, 'safe-6')
  await mergeRestore({ stagingDir: staging, roots: { dsh: dshHome, agents: agentsHome }, safeCopyRoot: safeCopy })
  expect(readFileSync(join(dshHome, '.credentials.yaml'), 'utf8')).toBe('version: 2\n')
  expect((statSync(join(dshHome, '.credentials.yaml')).mode & 0o777)).toBe(0o600)
  expect(readFileSync(join(safeCopy, 'dsh/.credentials.yaml'), 'utf8')).toBe('version: 1\n')
})

it('skips symlinked whitelist entries instead of archiving through them', async () => {
  const linkedHome = join(root, 'dsh-linked')
  mkdirSync(linkedHome, { recursive: true })
  symlinkSync(dshHome, join(linkedHome, 'sessions'))
  const { manifest } = await createBackup({ dshHome: linkedHome, agentsHome, outDir: join(root, 'out-7'), appVersion: 'test', skillMaxBytes: 5 * 1024 * 1024, now: new Date('2026-11-04T15:00:00Z') })
  expect(manifest.entries.files).toBe(4) // agents skills only (small x3 + huge); the symlinked sessions tree never archived
})

it('lists local backup sets newest-first and flags broken ones', async () => {
  const sets = listLocalBackups(outDir)
  expect(sets.length).toBeGreaterThan(0)
  expect(sets.every(set => ! set.broken)).toBe(true)
  const brokenDir = join(outDir, `${BACKUP_DIR_PREFIX}20990101-000000`)
  mkdirSync(brokenDir, { recursive: true })
  const withBroken = listLocalBackups(outDir)
  expect(withBroken[0]?.broken).toBe(false)
  expect(withBroken.at(-1)?.name).toBe(`${BACKUP_DIR_PREFIX}20990101-000000`)
  expect(withBroken.at(-1)?.broken).toBe(true)
})

describe('readManifest validation', () => {
  it('rejects foreign directories and newer schemas', () => {
    const foreign = join(root, 'foreign')
    mkdirSync(foreign, { recursive: true })
    writeFileSync(join(foreign, 'manifest.json'), JSON.stringify({ kind: 'other', schemaVersion: 1, parts: [] }))
    expect(() => readManifest(foreign)).toThrow(/not a Hemi backup/)
    const newer = join(root, 'newer')
    mkdirSync(newer, { recursive: true })
    writeFileSync(join(newer, 'manifest.json'), JSON.stringify({ kind: 'hemi-dsh-backup', schemaVersion: 99, parts: [{ name: 'part-0000.gz', bytes: 1, sha256: '0'.repeat(64) }] }))
    expect(() => readManifest(newer)).toThrow(/newer than supported/)
  })
})
