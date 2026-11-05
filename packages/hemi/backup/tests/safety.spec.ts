/** Backup failures and restore isolation against durable and untrusted filesystem input. */
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { collectEntries, createBackup, estimateMerge, extractBackup, mergeRestore, readManifest } from '../src/engine.ts'

let root: string
let dshHome: string
let agentsHome: string
const write = (file: string, value: string | Buffer): void => {
  fs.mkdirSync(join(file, '..'), { recursive: true })
  fs.writeFileSync(file, value)
}
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'hemi-backup-safety-'))
  dshHome = join(root, 'dsh')
  agentsHome = join(root, 'agents')
  write(join(dshHome, 'hemi-memory/MEMORY.md'), 'long-term memory')
  write(join(dshHome, 'hemi-memory/daily/2026-11-05.md'), 'daily memory')
  write(join(dshHome, 'hemi-memory/SCRATCHPAD.md'), 'working notes')
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})
const pack = () => createBackup({ dshHome, agentsHome, outDir: join(root, 'backups'), appVersion: 'test', skillMaxBytes: 5242880 })

/** Build foreign tar bytes independently of the production encoder, including GNU long-name records. */
function tarMember(name: string, type = '0', content = Buffer.from('payload')): Buffer {
  const header = Buffer.alloc(512)
  header.write(name)
  header.write('0000644\0', 100)
  header.write('0000000\0', 108)
  header.write('0000000\0', 116)
  header.write(content.length.toString(8).padStart(11, '0') + '\0', 124)
  header.write('00000000000\0', 136)
  header.fill(32, 148, 156)
  header.write(type, 156)
  header.write('ustar\0', 257)
  header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148)
  return Buffer.concat([header, content, Buffer.alloc((512 - content.length % 512) % 512)])
}

async function foreignArchive(tar: Buffer): Promise<string> {
  const { backupDir } = await pack()
  const manifest = readManifest(backupDir)
  const bytes = gzipSync(tar)
  write(join(backupDir, 'part-0000.gz'), bytes)
  write(join(backupDir, 'manifest.json'), JSON.stringify({
    ...manifest, parts: [{ name: 'part-0000.gz', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }],
  }))
  return backupDir
}

it('round-trips all three Hemi memory stores into a fresh home', async () => {
  const { backupDir } = await pack()
  const stagingDir = join(root, 'staging')
  await extractBackup(backupDir, stagingDir)
  const restoredHome = join(root, 'restored')
  await mergeRestore({ stagingDir, roots: { dsh: restoredHome, agents: join(root, 'restored-agents') }, safeCopyRoot: join(root, 'safe') })
  for (const rel of ['MEMORY.md', 'daily/2026-11-05.md', 'SCRATCHPAD.md']) {
    expect(fs.readFileSync(join(restoredHome, 'hemi-memory', rel))).toEqual(fs.readFileSync(join(dshHome, 'hemi-memory', rel)))
  }
})

it('keeps an open Session writer on the canonical file and preserves conflicting backup generations', async () => {
  const rel = 'sessions/workspace/session-1/session.v4.jsonl'
  const live = join(dshHome, rel)
  const stagingDir = join(root, 'staging')
  write(live, 'local-generation')
  write(join(stagingDir, 'dsh', rel), 'backup-generation')
  write(join(stagingDir, 'dsh/sessions/workspace/session-1/session.v5.jsonl'), 'backup-higher-generation')
  fs.utimesSync(live, 1000000000, 1000000000)
  fs.utimesSync(join(stagingDir, 'dsh', rel), 2000000000, 2000000000)
  const fd = fs.openSync(live, 'a')
  try {
    const before = fs.statSync(live)
    expect(await estimateMerge(stagingDir, { dsh: dshHome })).toEqual({ newFiles: 0, identical: 0, conflicts: 2 })
    const { stats } = await mergeRestore({ stagingDir, roots: { dsh: dshHome }, safeCopyRoot: join(root, 'safe') })
    fs.writeSync(fd, '\naccepted-event')
    expect(fs.readFileSync(live, 'utf8')).toBe('local-generation\naccepted-event')
    expect(fs.statSync(live).ino).toBe(before.ino)
    expect(fs.existsSync(join(dshHome, 'sessions/workspace/session-1/session.v5.jsonl'))).toBe(false)
    expect(fs.readFileSync(join(root, 'safe/dsh', rel), 'utf8')).toBe('backup-generation')
    expect(fs.readFileSync(join(root, 'safe/dsh/sessions/workspace/session-1/session.v5.jsonl'), 'utf8')).toBe('backup-higher-generation')
    expect(stats).toEqual({ newFiles: 0, identical: 0, keepLocal: 2, takeBackup: 0 })
  } finally { fs.closeSync(fd) }
})

it('restores a missing Session with every generation and refuses to clobber a competing publication', async () => {
  const stagingDir = join(root, 'staging')
  const rel = 'sessions/workspace/new/session.v4.jsonl'
  write(join(stagingDir, 'dsh', rel), 'backup')
  write(join(stagingDir, 'dsh/sessions/workspace/new/session.v3.jsonl'), 'historical')
  const original = fs.linkSync
  vi.spyOn(fs, 'linkSync').mockImplementation((source, target) => {
    if (target === join(dshHome, rel)) write(target, 'competing-writer')
    original(source, target)
  })
  const { stats } = await mergeRestore({ stagingDir, roots: { dsh: dshHome }, safeCopyRoot: join(root, 'safe') })
  expect(fs.readFileSync(join(dshHome, rel), 'utf8')).toBe('competing-writer')
  expect(fs.readFileSync(join(dshHome, 'sessions/workspace/new/session.v3.jsonl'), 'utf8')).toBe('historical')
  expect(fs.readFileSync(join(root, 'safe/dsh', rel), 'utf8')).toBe('backup')
  expect(stats.keepLocal).toBe(1)
  expect(fs.readdirSync(join(dshHome, 'sessions/workspace/new')).some(name => name.startsWith('.hemi-'))).toBe(false)
})

it('rejects a file shrinking after collection without publishing a manifest or retaining partial volumes', async () => {
  const victim = join(dshHome, 'hemi-memory/MEMORY.md')
  const original = fs.createReadStream
  vi.spyOn(fs, 'createReadStream').mockImplementation((file, options) => {
    if (file === victim) fs.truncateSync(victim, 0)
    return original(file, options)
  })
  await expect(pack()).rejects.toMatchObject({ code: 'SNAPSHOT_SHRUNK' })
  expect(fs.readdirSync(join(root, 'backups'))).toEqual([])
})

it('propagates source read errors and output failures without retaining a successful set', async () => {
  const original = fs.createReadStream
  vi.spyOn(fs, 'createReadStream').mockImplementation((file, options) => original(file === join(dshHome, 'hemi-memory/MEMORY.md') ? join(root, 'missing') : file, options))
  await expect(pack()).rejects.toMatchObject({ code: 'ENOENT' })
  expect(fs.readdirSync(join(root, 'backups'))).toEqual([])
  vi.restoreAllMocks()
  write(join(root, 'blocked-output'), 'file')
  await expect(createBackup({ dshHome, agentsHome, outDir: join(root, 'blocked-output'), appVersion: null, skillMaxBytes: 5242880 })).rejects.toThrow()
})

it.each(['../escaped.txt', '/tmp/escaped.txt', 'dsh/../escaped.txt', 'dsh\\..\\escaped.txt', 'C:/escaped.txt', '//server/share/file', 'other/file', 'dsh/hemi-memory/a:stream', 'dsh/hemi-memory/CON', 'dsh/profiles/web/node_modules/evil.js', 'dsh', 'agents/skills', 'dsh/.credentials.yaml/payload', 'dsh/sessions/session.jsonl', 'dsh/profiles/settings.yaml'])(
  'rejects the archive path %s before writing outside the whitelist', async (name) => {
    const backupDir = await foreignArchive(Buffer.concat([tarMember(name), Buffer.alloc(1024)]))
    await expect(extractBackup(backupDir, join(root, 'staging'))).rejects.toMatchObject({ code: 'INVALID_PATH' })
    expect(fs.existsSync(join(root, 'escaped.txt'))).toBe(false)
    expect(fs.existsSync(join(root, 'staging'))).toBe(false)
  },
)

it('validates GNU long names and rejects link entries', async () => {
  const backupDir = await foreignArchive(Buffer.concat([
    tarMember('././@LongLink', 'L', Buffer.from('../escaped.txt\0')), tarMember('_L'), Buffer.alloc(1024),
  ]))
  await expect(extractBackup(backupDir, join(root, 'staging'))).rejects.toMatchObject({ code: 'INVALID_PATH' })
  const linked = await foreignArchive(Buffer.concat([tarMember('dsh/hemi-memory/link', '2'), Buffer.alloc(1024)]))
  await expect(extractBackup(linked, join(root, 'staging'))).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' })
})

it('rejects a hash-valid but truncated tar stream', async () => {
  const backupDir = await foreignArchive(tarMember('dsh/hemi-memory/file'))
  await expect(extractBackup(backupDir, join(root, 'staging'))).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' })
})

it.each(['../part-0000.gz', '..\\part-0000.gz', '/part-0000.gz', 'C:part-0000.gz'])(
  'rejects the manifest volume name %s before reading or downloading it', async (name) => {
    const { backupDir } = await pack()
    const manifest = readManifest(backupDir)
    write(join(backupDir, 'manifest.json'), JSON.stringify({ ...manifest, parts: [{ ...manifest.parts[0], name }] }))
    expect(() => readManifest(backupDir)).toThrow(/invalid Hemi backup manifest/u)
  },
)

it('skips a linked Hemi memory directory during collection', () => {
  fs.renameSync(join(dshHome, 'hemi-memory'), join(root, 'outside-memory'))
  fs.symlinkSync(join(root, 'outside-memory'), join(dshHome, 'hemi-memory'), 'junction')
  expect(collectEntries(dshHome, agentsHome, 5242880).entries.some(entry => entry.rel.startsWith('dsh/hemi-memory'))).toBe(false)
})

it('rejects destination write errors, closes the volume, and removes the incomplete set', async () => {
  const original = fs.promises.open
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
    const handle = await original(...args)
    if (String(args[0]).endsWith('.gz')) {
      vi.spyOn(handle, 'writeFile').mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }))
    }
    return handle
  })
  await expect(pack()).rejects.toMatchObject({ code: 'ENOSPC' })
  expect(fs.readdirSync(join(root, 'backups'))).toEqual([])
})

it('round-trips GNU long UTF-8 names, empty files, and files restored across volumes', async () => {
  const rel = `hemi-memory/${'中文'.repeat(35)}.md`
  write(join(dshHome, rel), 'long filename')
  write(join(dshHome, 'hemi-memory/empty.md'), '')
  const { backupDir } = await pack()
  const stagingDir = join(root, 'staging')
  await extractBackup(backupDir, stagingDir)
  const original = fs.renameSync
  vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
    if (String(source).startsWith(stagingDir)) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
    original(source, target)
  })
  const restored = join(root, 'restored')
  await mergeRestore({ stagingDir, roots: { dsh: restored }, safeCopyRoot: join(root, 'safe') })
  expect(fs.readFileSync(join(restored, rel), 'utf8')).toBe('long filename')
  expect(fs.statSync(join(restored, 'hemi-memory/empty.md')).size).toBe(0)
})
