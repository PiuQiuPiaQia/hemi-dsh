/**
 * Snapshot backup engine for Hemi desktop data.
 *
 * Archive pipeline: dual-root whitelist collection (the Harness home and the
 * shared agent-configuration root) → streaming ustar+gzip pack → volumes
 * chunked by byte budget with one sha256 each → `manifest.json`. The archive
 * is not encrypted; credentials ship inside it by recorded user decision, so
 * cloud targets hold a plaintext equivalent and the UI must say so.
 *
 * Relative archive paths are always posix. Each entry is prefixed with its
 * root label (`dsh/…`, `agents/…`) so one archive restores into both roots.
 *
 * @module @deepseek-ai/dsh-hemi-backup/engine
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip, createGunzip } from 'node:zlib'

/** Manifest `kind` discriminator for Hemi backup directories. */
export const BACKUP_KIND = 'hemi-dsh-backup'
/** Backup format version this build writes and accepts. */
export const BACKUP_SCHEMA_VERSION = 1
/** Default volume size before the packer rolls to the next part file. */
export const DEFAULT_CHUNK_BYTES = 300 * 1024 * 1024
/** Directory-name prefix every backup set uses, on local and remote targets. */
export const BACKUP_DIR_PREFIX = 'hemi-backup-'
/** Archive label for entries under the Harness home (`~/.dsh`). */
export const DSH_ROOT_LABEL = 'dsh'
/** Archive label for entries under the shared agent root (`~/.agents`). */
export const AGENTS_ROOT_LABEL = 'agents'

/**
 * Whitelisted entries under the Harness home, relative to the root. Profiles
 * contribute only their composition manifests: `node_modules` is rebuilt by
 * the plugin manager, and the projection cache is rebuilt from sessions.
 */
const DSH_ENTRIES: readonly string[] = [
  '.credentials.yaml',
  '.anonymous-user-id',
  'sessions',
  'storages',
  'memory',
  'profiles',
]

/** Filenames a profile directory contributes; everything else is rebuilt. */
const PROFILE_FILES: ReadonlySet<string> = new Set([
  'cordis.yml',
  'cordis.patch.yml',
  'package.json',
  'pnpm-workspace.yaml',
  'settings.yaml',
])

/**
 * `storages` children that are rebuildable caches and never archived. The
 * session projection cache is fully derived from `sessions/`.
 */
const STORAGE_EXCLUDED: ReadonlySet<string> = new Set(['session_projcache', 'session_projcache.json'])

/** Top-level paths that swap whole-file on restore: credentials pair with nothing else. */
const ATOMIC_RELS: ReadonlySet<string> = new Set(['dsh/.credentials.yaml'])

/** One collected archive member before packing. */
export interface BackupEntry {
  /** Posix archive path including the root label prefix. */
  readonly rel: string
  /** Member kind; directories are recorded but carry no content. */
  readonly type: 'file' | 'dir'
  /** File size in bytes at collection time; 0/absent for directories. */
  readonly bytes?: number
  /** Modification time in milliseconds at collection time. */
  readonly mtimeMs?: number
}

/** One skill directory skipped by the size threshold, with the reason recorded. */
export interface SkippedSkill {
  /** Top-level skill directory name under `agents/skills/`. */
  readonly name: string
  /** Collected size in bytes that exceeded the threshold. */
  readonly bytes: number
  /** Exclusion reason; currently only the size threshold. */
  readonly reason: 'oversize'
}

/** Written `manifest.json` of one backup set. */
export interface BackupManifest {
  /** Discriminator equal to {@linkcode BACKUP_KIND}. */
  readonly kind: typeof BACKUP_KIND
  /** Format version; a higher version than the reader supports is rejected. */
  readonly schemaVersion: number
  /** Always `'light'`; kept for forward-compatible readers. */
  readonly tier: 'light'
  /** ISO creation timestamp. */
  readonly createdAt: string
  /** Producing application version, when known. */
  readonly appVersion: string | null
  /** Always `'gzip'`. */
  readonly compression: 'gzip'
  /** Volume byte budget used while packing. */
  readonly chunkBytes: number
  /** Volume files in archive order, each with size and sha256. */
  readonly parts: readonly { readonly name: string; readonly bytes: number; readonly sha256: string }[]
  /** Member counts. */
  readonly entries: { readonly files: number; readonly dirs: number }
  /** Size totals before and after compression. */
  readonly totals: { readonly rawBytes: number; readonly packedBytes: number }
  /** Skill directories excluded by the size threshold. */
  readonly skipped: readonly SkippedSkill[]
}

/** Typed engine failure with a stable code for callers and the UI. */
export class BackupEngineError extends Error {
  override name = 'BackupEngineError'
  /**
   * @param code - stable failure code.
   * @param message - human-readable failure description.
   */
  constructor(readonly code: 'EMPTY_ARCHIVE' | 'NOT_A_BACKUP' | 'NEWER_SCHEMA' | 'MISSING_PARTS' | 'PART_CORRUPT' | 'SYMLINK' | 'SNAPSHOT_SHRUNK' | 'PATH_TOO_LONG', message: string) {
    super(message)
  }
}

const lstatIfPresent = (abs: string): fs.Stats | (null) => {
  try {
    return fs.lstatSync(abs)
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw error
  }
}

/** Whether any ancestor of `rel` under `root`, or the entry itself, is a symlink. */
function hasLinkedAncestor(root: string, rel: string): boolean {
  if (lstatIfPresent(root)?.isSymbolicLink() ?? false) return true
  const segments = rel.split('/')
  let abs = root
  for (const segment of segments) {
    abs = path.join(abs, segment)
    if (lstatIfPresent(abs)?.isSymbolicLink() ?? false) return true
  }
  return false
}

const isExcludedRel = (rel: string): boolean => {
  const segments = rel.split('/')
  const name = segments.at(-1) ?? rel
  if (name.endsWith('.tmp') || name.endsWith('.log') || name === 'session.lock') return true
  // Whitelisted top-level dotfiles (`.credentials.yaml`) stay; dotfiles below
  // them are transient or foreign and never archived.
  return segments.length > 2 && name.startsWith('.')
}

/** Resolve the live root for one archive path; every path starts with a root label. */
function rootFor(roots: Readonly<Record<string, string>>, rel: string): { root: string; inner: string } {
  const label = rel.split('/')[0]
  const root = label === undefined ? undefined : roots[label]
  if (root === undefined) throw new BackupEngineError('NOT_A_BACKUP', `archive entry has no root label: ${rel}`)
  return { root, inner: rel.split('/').slice(1).join('/') }
}

/** Directory-collected size in bytes, following no symlinks. */
function directoryBytes(abs: string): number {
  let total = 0
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const child = path.join(abs, entry.name)
    if (entry.isDirectory()) total += directoryBytes(child)
    else if (entry.isFile()) total += lstatIfPresent(child)?.size ?? 0
  }
  return total
}

/** Result of one collection pass: members plus threshold-excluded skills. */
export interface Collection {
  /** Sorted archive members. */
  readonly entries: readonly BackupEntry[]
  /** Skills excluded by the size threshold. */
  readonly skipped: readonly SkippedSkill[]
}

/**
 * Collect whitelist members from both roots without following symlinks.
 * @param dshHome - resolved Harness home (`$DSH_HOME`, default `~/.dsh`).
 * @param agentsHome - resolved shared agent root (`$DSH_AGENTS_HOME`, default `~/.agents`).
 * @param skillMaxBytes - skill directories larger than this are skipped whole and recorded.
 * @returns sorted members and skipped-skill records.
 */
export function collectEntries(dshHome: string, agentsHome: string, skillMaxBytes: number): Collection {
  const entries = new Map<string, BackupEntry>()
  const skipped: SkippedSkill[] = []
  const record = (root: string, rel: string): void => {
    if (isExcludedRel(rel)) return
    if (hasLinkedAncestor(root, rel)) return
    const abs = path.join(root, ...rel.split('/').slice(1))
    const stats = lstatIfPresent(abs)
    if (stats === null) return
    if (stats.isDirectory()) {
      entries.set(rel, { rel, type: 'dir' })
    } else if (stats.isFile()) {
      entries.set(rel, { rel, type: 'file', bytes: stats.size, mtimeMs: stats.mtimeMs })
    }
  }
  const walk = (root: string, rel: string): void => {
    record(root, rel)
    const abs = path.join(root, ...rel.split('/').slice(1))
    if (!(lstatIfPresent(abs)?.isDirectory() ?? false)) return
    for (const child of fs.readdirSync(abs, { withFileTypes: true })) walk(root, `${rel}/${child.name}`)
  }
  for (const entry of DSH_ENTRIES) {
    if (!fs.existsSync(path.join(dshHome, entry))) continue
    if (entry === 'profiles') {
      // Profiles contribute manifests only: node_modules trees are rebuilt by
      // the plugin manager and are never walked, whatever the profile layout.
      const profilesAbs = path.join(dshHome, 'profiles')
      entries.set('dsh/profiles', { rel: 'dsh/profiles', type: 'dir' })
      for (const profile of fs.readdirSync(profilesAbs, { withFileTypes: true })) {
        if (!profile.isDirectory() || profile.name === 'node_modules' || profile.name.startsWith('.')) continue
        const profileRel = `dsh/profiles/${profile.name}`
        record(dshHome, profileRel)
        for (const file of PROFILE_FILES) {
          if (fs.existsSync(path.join(profilesAbs, profile.name, file))) record(dshHome, `${profileRel}/${file}`)
        }
      }
    } else if (entry === 'storages') {
      walk(dshHome, 'dsh/storages')
      for (const excluded of STORAGE_EXCLUDED) {
        entries.delete(`dsh/storages/${excluded}`)
        for (const rel of [...entries.keys()]) {
          if (rel.startsWith(`dsh/storages/${excluded}/`)) entries.delete(rel)
        }
      }
    } else {
      walk(dshHome, `dsh/${entry}`)
    }
  }
  const skillsRoot = path.join(agentsHome, 'skills')
  if (fs.existsSync(skillsRoot)) {
    for (const skill of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
      if (skill.name.startsWith('.')) continue
      if (hasLinkedAncestor(agentsHome, `skills/${skill.name}`)) continue
      const abs = path.join(skillsRoot, skill.name)
      if (skill.isDirectory()) {
        const bytes = directoryBytes(abs)
        if (bytes > skillMaxBytes) {
          skipped.push({ name: skill.name, bytes, reason: 'oversize' })
          continue
        }
      }
      walk(agentsHome, `${AGENTS_ROOT_LABEL}/skills/${skill.name}`)
    }
  }
  return { entries: [...entries.values()].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)), skipped }
}

const octal = (value: number, length: number): string => value.toString(8).padStart(length - 1, '0') + '\0'

interface TarHeader {
  readonly needsLong: boolean
  readonly header?: Buffer
}

function buildHeader(member: { name: string; type: 'file' | 'dir'; size: number; mtimeMs: number }): TarHeader {
  let prefix = ''
  let base = member.name
  if (member.name.length > 100) {
    const split = member.name.lastIndexOf('/', member.name.length - 101)
    if (split > 0 && member.name.length - split - 1 <= 100) {
      prefix = member.name.slice(0, split)
      base = member.name.slice(split + 1)
    } else return { needsLong: true }
  }
  const buffer = Buffer.alloc(512, 0)
  buffer.write(base, 0, 100, 'utf8')
  buffer.write(octal(member.type === 'dir' ? 0o755 : 0o644, 8), 100)
  buffer.write(octal(0, 8), 108)
  buffer.write(octal(0, 8), 116)
  buffer.write(octal(member.type === 'dir' ? 0 : member.size, 12), 124)
  buffer.write(octal(Math.floor(member.mtimeMs / 1000), 12), 136)
  buffer.write('        ', 148)
  buffer.write(member.type === 'dir' ? '5' : '0', 156)
  buffer.write('ustar\0', 257)
  buffer.write('00', 263)
  if (prefix !== '') buffer.write(prefix, 345, 155, 'utf8')
  let sum = 0
  for (const byte of buffer) sum += byte
  buffer.write(octal(sum, 8), 148)
  return { needsLong: false, header: buffer }
}

async function writeAll(stream: Duplex, chunk: Buffer): Promise<void> {
  if (!stream.write(chunk)) await new Promise<void>(resolve => stream.once('drain', resolve))
}

async function writeLongNameEntry(gzip: Duplex, name: string): Promise<void> {
  const content = Buffer.from(`${name}\0`, 'utf8')
  const long = buildHeader({ name: '././@LongLink', type: 'file', size: content.length, mtimeMs: 0 })
  if (long.needsLong || long.header === undefined) throw new BackupEngineError('PATH_TOO_LONG', `backup path too long (>255): ${name}`)
  long.header.write('L', 156)
  long.header.write('        ', 148)
  let sum = 0
  for (const byte of long.header) sum += byte
  long.header.write(octal(sum, 8), 148)
  await writeAll(gzip, long.header)
  await writeAll(gzip, content)
  const pad = (512 - (content.length % 512)) % 512
  if (pad > 0) await writeAll(gzip, Buffer.alloc(pad, 0))
}

async function writeTarEntries(gzip: Duplex, entries: readonly BackupEntry[], roots: Readonly<Record<string, string>>): Promise<void> {
  for (const entry of entries) {
    const { root, inner } = rootFor(roots, entry.rel)
    if (hasLinkedAncestor(root, inner)) {
      throw new BackupEngineError('SYMLINK', `backup path crosses a symlink: ${entry.rel}`)
    }
    const size = entry.type === 'dir' ? 0 : entry.bytes ?? 0
    const header = buildHeader({ name: entry.rel, type: entry.type, size, mtimeMs: entry.mtimeMs ?? Date.now() })
    if (header.needsLong) {
      await writeLongNameEntry(gzip, entry.rel)
      const retry = buildHeader({ name: '_L', type: entry.type, size, mtimeMs: entry.mtimeMs ?? Date.now() })
      if (retry.header !== undefined) await writeAll(gzip, retry.header)
    } else if (header.header !== undefined) {
      await writeAll(gzip, header.header)
    }
    if (entry.type !== 'file') continue
    const abs = path.join(root, ...entry.rel.split('/').slice(1))
    // Snapshot-consistency defense: a file appended after collection is cut to
    // its collected size; a file rewritten shorter fails the snapshot instead
    // of archiving a torn read.
    let remaining = entry.bytes ?? 0
    for await (const chunk of fs.createReadStream(abs, { highWaterMark: 1 << 20 }) as AsyncIterable<Buffer>) {
      if (remaining <= 0) break
      const piece = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
      await writeAll(gzip, piece)
      remaining -= piece.length
    }
    if (remaining > 0) throw new BackupEngineError('SNAPSHOT_SHRUNK', `file rewrote shorter during backup: ${entry.rel} (missing ${remaining} bytes)`)
    const pad = (512 - (size % 512)) % 512
    if (pad > 0) await writeAll(gzip, Buffer.alloc(pad, 0))
  }
  await writeAll(gzip, Buffer.alloc(1024, 0))
}

const pad2 = (value: number): string => String(value).padStart(2, '0')

function stamp(now: Date): string {
  return `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`
}

/** Resolve a non-clobbering backup directory for this second. */
export function resolveBackupDir(outDir: string, now: Date): string {
  const base = BACKUP_DIR_PREFIX + stamp(now)
  let dirName = base
  let n = 2
  while (fs.existsSync(path.join(outDir, dirName)) && n <= 999) {
    dirName = `${base}-${n}`
    n += 1
  }
  return path.join(outDir, dirName)
}

/** Inputs of one pack run. */
export interface CreateBackupInput {
  /** Resolved Harness home. */
  readonly dshHome: string
  /** Resolved shared agent root. */
  readonly agentsHome: string
  /** Directory receiving the backup-set directory. */
  readonly outDir: string
  /** Volume byte budget; defaults to {@linkcode DEFAULT_CHUNK_BYTES}. */
  readonly chunkBytes?: number
  /** Creation time; defaults to now. */
  readonly now?: Date
  /** Producing application version recorded in the manifest. */
  readonly appVersion: string | null
  /** Skill directories above this size are skipped whole and recorded. */
  readonly skillMaxBytes: number
}

/** Result of one pack run. */
export interface CreateBackupResult {
  /** Created backup-set directory. */
  readonly backupDir: string
  /** Written manifest. */
  readonly manifest: BackupManifest
}

/**
 * Pack one snapshot archive from both roots.
 * @param input - roots, output directory, thresholds, and version stamp.
 * @returns the created directory and manifest.
 * @throws BackupEngineError when the whitelist collects no file, or a member crosses a symlink or shrinks mid-read.
 */
export async function createBackup(input: CreateBackupInput): Promise<CreateBackupResult> {
  const chunkBytes = input.chunkBytes ?? DEFAULT_CHUNK_BYTES
  const now = input.now ?? new Date()
  const { entries, skipped } = collectEntries(input.dshHome, input.agentsHome, input.skillMaxBytes)
  if (!entries.some(entry => entry.type === 'file')) {
    throw new BackupEngineError('EMPTY_ARCHIVE', 'backup whitelist collected no files; the data roots look wrong')
  }
  const backupDir = resolveBackupDir(input.outDir, now)
  fs.mkdirSync(backupDir, { recursive: true })
  const roots: Record<string, string> = { [DSH_ROOT_LABEL]: input.dshHome, [AGENTS_ROOT_LABEL]: input.agentsHome }
  const gzip: Duplex = createGzip({ level: 6 })
  const pump = (async () => {
    try {
      await writeTarEntries(gzip, entries, roots)
    } finally {
      gzip.end()
    }
  })().catch(() => {})
  const parts: BackupManifest['parts'][number][] = []
  let index = 0
  let hash = createHash('sha256')
  let written = 0
  // The current volume; `rollPart` returns a fresh handle and `closePart`
  // closes the current one, so the invariant stays local to this block.
  const rollPart = (): { handle: fs.WriteStream; name: string } => {
    const name = `part-${String(index).padStart(4, '0')}.gz`
    hash = createHash('sha256')
    written = 0
    return { handle: fs.createWriteStream(path.join(backupDir, name)), name }
  }
  let part = rollPart()
  const closePart = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      part.handle.end(() => { resolve() })
    })
    if (written > 0 || parts.length === 0) parts.push({ name: part.name, bytes: written, sha256: hash.digest('hex') })
    else fs.rmSync(path.join(backupDir, part.name), { force: true })
  }
  try {
    for await (const chunk of gzip as AsyncIterable<Buffer>) {
      let offset = 0
      while (offset < chunk.length) {
        if (written >= chunkBytes && index < 9999) {
          await closePart()
          index += 1
          part = rollPart()
        }
        const take = Math.min(chunkBytes - written, chunk.length - offset)
        const piece = chunk.subarray(offset, offset + take)
        if (!part.handle.write(piece)) await new Promise<void>(resolve => part.handle.once('drain', resolve))
        hash.update(piece)
        written += take
        offset += take
      }
    }
    await closePart()
    await pump
  } catch (error) {
    fs.rmSync(backupDir, { recursive: true, force: true })
    throw error
  }
  const rawBytes = entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0)
  const manifest: BackupManifest = {
    kind: BACKUP_KIND,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    tier: 'light',
    createdAt: now.toISOString(),
    appVersion: input.appVersion,
    compression: 'gzip',
    chunkBytes,
    parts,
    entries: { files: entries.filter(entry => entry.type === 'file').length, dirs: entries.filter(entry => entry.type === 'dir').length },
    totals: { rawBytes, packedBytes: parts.reduce((sum, part) => sum + part.bytes, 0) },
    skipped,
  }
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return { backupDir, manifest }
}

/**
 * Read and validate one backup-set manifest.
 * @param backupDir - backup-set directory holding `manifest.json`.
 * @returns the parsed manifest.
 * @throws BackupEngineError for foreign directories, newer schemas, or missing volume lists.
 */
export function readManifest(backupDir: string): BackupManifest {
  const parsed = JSON.parse(fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8')) as { kind?: unknown }
  if (parsed.kind !== BACKUP_KIND) {
    throw new BackupEngineError('NOT_A_BACKUP', 'not a Hemi backup directory (manifest.kind mismatch)')
  }
  const manifest = parsed as BackupManifest
  if ((manifest.schemaVersion | 0) > BACKUP_SCHEMA_VERSION) {
    throw new BackupEngineError('NEWER_SCHEMA', `backup format version ${manifest.schemaVersion} is newer than supported ${BACKUP_SCHEMA_VERSION}; upgrade the app first`)
  }
  if (!Array.isArray(manifest.parts) || manifest.parts.length === 0) {
    throw new BackupEngineError('MISSING_PARTS', 'manifest has no volume list')
  }
  return manifest
}

async function* partsConcat(backupDir: string, parts: readonly { name: string }[]): AsyncGenerator<Buffer> {
  for (const part of parts) {
    const stream = fs.createReadStream(path.join(backupDir, part.name), { highWaterMark: 1 << 20 }) as AsyncIterable<Buffer>
    for await (const chunk of stream) yield chunk
  }
}

async function sha256File(abs: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(abs, { highWaterMark: 1 << 20 })
    stream.on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => { resolve() })
  })
  return hash.digest('hex')
}

/** One extracted file record, in archive order. */
export interface RestoredEntry {
  /** Posix archive path with the root label prefix. */
  readonly rel: string
  /** Always `'file'`; directories are created implicitly. */
  readonly type: 'file'
  /** Extracted size in bytes. */
  readonly bytes: number
}

/** Incremental ustar reader: headers and content stream straight to disk. */
class TarExtractor {
  private readonly restored: RestoredEntry[] = []
  private buffer = Buffer.alloc(0)
  private state: 'header' | 'content' | 'pad' = 'header'
  private need = 512
  private longName: string | null = null
  private longSink: Buffer[] | null = null
  private fileStream: fs.WriteStream | null = null
  private fileTarget: string | null = null
  private fileMtimeSec = 0
  private pendingPad = 0
  /** @param dir - staging directory receiving extracted members. */
  constructor(private readonly dir: string) {}

  private onHeader(header: Buffer): void {
    if (header.every(byte => byte === 0)) {
      this.state = 'header'
      this.need = 512
      return
    }
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const size = Number.parseInt(header.toString('utf8', 124, 136).replace(/\0.*$/, '').trim(), 8) || 0
    const mtimeSec = Number.parseInt(header.toString('utf8', 136, 148).replace(/\0.*$/, '').trim(), 8) || 0
    const type = String.fromCharCode(header[156] ?? 0)
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    if (type === 'L') {
      this.state = 'content'
      this.need = size
      this.fileStream = null
      this.longSink = []
      this.pendingPad = (512 - (size % 512)) % 512
      return
    }
    const rel = this.longName ?? (prefix !== '' ? `${prefix}/${name}` : name)
    this.longName = null
    const pad = (512 - (size % 512)) % 512
    this.pendingPad = pad
    if (type === '5') {
      fs.mkdirSync(path.join(this.dir, rel), { recursive: true })
      this.state = pad > 0 ? 'pad' : 'header'
      this.need = pad || 512
      return
    }
    const write = type === '0' || type === '\0'
    if (write) {
      const target = path.join(this.dir, rel)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      this.fileStream = fs.createWriteStream(target)
      this.fileTarget = target
      this.fileMtimeSec = mtimeSec
      this.restored.push({ rel, type: 'file', bytes: size })
    } else {
      this.fileStream = null
      this.fileTarget = null
      this.fileMtimeSec = 0
    }
    this.state = 'content'
    this.need = size
  }

  /** @param chunk - next decompressed archive bytes. */
  async push(chunk: Buffer): Promise<void> {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      if (this.state === 'header' && this.buffer.length >= 512) {
        const header = this.buffer.subarray(0, 512)
        this.buffer = this.buffer.subarray(512)
        this.onHeader(header)
      } else if (this.state === 'content') {
        if (this.need === 0) {
          if (this.longSink !== null) {
            this.longName = Buffer.concat(this.longSink).toString('utf8').replace(/\0.*$/, '')
            this.longSink = null
          }
          if (this.fileStream !== null) {
            const closing = this.fileStream
            await new Promise<void>((resolve) => {
              closing.end(() => { resolve() })
            })
            this.fileStream = null
            // Restore the packed mtime so merge restore compares the same
            // timeline as the backup source; tar headers are second-granular.
            if (this.fileMtimeSec > 0 && this.fileTarget !== null) fs.utimesSync(this.fileTarget, this.fileMtimeSec, this.fileMtimeSec)
            this.fileTarget = null
            this.fileMtimeSec = 0
          }
          this.state = this.pendingPad > 0 ? 'pad' : 'header'
          this.need = this.pendingPad || 512
          this.pendingPad = 0
        } else if (this.buffer.length > 0) {
          const take = Math.min(this.buffer.length, this.need)
          const piece = this.buffer.subarray(0, take)
          this.buffer = this.buffer.subarray(take)
          this.need -= take
          if (this.fileStream !== null) {
            const target = this.fileStream
            if (!target.write(piece)) await new Promise<void>(resolve => target.once('drain', resolve))
          } else if (this.longSink !== null) this.longSink.push(Buffer.from(piece))
        } else break
      } else if (this.state === 'pad') {
        if (this.need === 0) {
          this.state = 'header'
          this.need = 512
          continue
        }
        if (this.buffer.length === 0) break
        const take = Math.min(this.buffer.length, this.need)
        this.buffer = this.buffer.subarray(take)
        this.need -= take
      } else break
    }
  }

  /** Extracted file records in archive order. */
  records(): readonly RestoredEntry[] {
    return this.restored
  }
}

/** Result of extracting one backup set into staging. */
export interface ExtractResult {
  /** Validated manifest. */
  readonly manifest: BackupManifest
  /** Extracted file records. */
  readonly entries: readonly RestoredEntry[]
}

/**
 * Verify every volume then extract the archive into staging.
 * @param backupDir - backup-set directory.
 * @param stagingDir - empty directory receiving extracted members.
 * @returns the manifest and extracted records.
 * @throws BackupEngineError when a volume's size or sha256 mismatches.
 */
export async function extractBackup(backupDir: string, stagingDir: string): Promise<ExtractResult> {
  const manifest = readManifest(backupDir)
  for (const part of manifest.parts) {
    const abs = path.join(backupDir, part.name)
    const size = fs.statSync(abs).size
    if (size !== part.bytes) throw new BackupEngineError('PART_CORRUPT', `volume ${part.name} size mismatch (expected ${part.bytes}, found ${size})`)
    if (await sha256File(abs) !== part.sha256) throw new BackupEngineError('PART_CORRUPT', `volume ${part.name} failed its sha256 check; the backup may be damaged`)
  }
  fs.rmSync(stagingDir, { recursive: true, force: true })
  fs.mkdirSync(stagingDir, { recursive: true })
  const extractor = new TarExtractor(stagingDir)
  await pipeline(
    partsConcat(backupDir, manifest.parts),
    createGunzip(),
    async (source) => {
      for await (const chunk of source as AsyncIterable<Buffer>) await extractor.push(chunk)
    },
  )
  return { manifest, entries: extractor.records() }
}

/** Per-file disposition shared by merge restore and its preview estimate. */
export type RestoreAction = 'new' | 'identical' | 'keepLocal' | 'takeBackup'

const IDENTICAL_INLINE_MAX_BYTES = 4 * 1024 * 1024

async function filesIdentical(a: string, b: string): Promise<boolean> {
  const sa = fs.statSync(a)
  const sb = fs.statSync(b)
  if (sa.size !== sb.size) return false
  if (sa.size <= IDENTICAL_INLINE_MAX_BYTES) return fs.readFileSync(a).equals(fs.readFileSync(b))
  return await sha256File(a) === await sha256File(b)
}

/**
 * Decide one file's disposition; the single authority shared by restore and preview.
 * @param stagingAbs - extracted file in staging.
 * @param localAbs - same relative position under the live root.
 * @param rel - posix archive path with the root label prefix.
 * @param localRoot - live root the relative path resolves against.
 * @returns the disposition for this file.
 */
export async function decideRestoreAction(stagingAbs: string, localAbs: string, rel: string, localRoot: string): Promise<RestoreAction> {
  if (hasLinkedAncestor(localRoot, rel.split('/').slice(1).join('/'))) return 'takeBackup'
  const local = lstatIfPresent(localAbs)
  if (ATOMIC_RELS.has(rel)) return local !== null ? 'takeBackup' : 'new'
  if (local === null) return 'new'
  if (local.isSymbolicLink() || !local.isFile()) return 'takeBackup'
  if (await filesIdentical(stagingAbs, localAbs)) return 'identical'
  const localSec = Math.floor(local.mtimeMs / 1000)
  const backupSec = Math.floor(fs.statSync(stagingAbs).mtimeMs / 1000)
  // Ties take the backup: the user's intent right now is to restore it.
  return localSec > backupSec ? 'keepLocal' : 'takeBackup'
}

/** Recursively list posix relative file paths under `abs`, rejecting symlinks. */
function walkFiles(abs: string, relPrefix: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = relPrefix !== '' ? `${relPrefix}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw new BackupEngineError('SYMLINK', `restore staging holds a symlink: ${rel}`)
    if (entry.isDirectory()) out.push(...walkFiles(path.join(abs, entry.name), rel))
    else out.push(rel)
  }
  return out
}

function moveIntoSafeCopy(abs: string, rel: string, safeCopyRoot: string): void {
  const safeAbs = path.join(safeCopyRoot, ...rel.split('/'))
  if (hasLinkedAncestor(safeCopyRoot, rel)) throw new BackupEngineError('SYMLINK', `safe-copy path crosses a symlink: ${rel}`)
  fs.mkdirSync(path.dirname(safeAbs), { recursive: true })
  const prior = lstatIfPresent(safeAbs)
  if (prior !== null) fs.rmSync(safeAbs, { recursive: !prior.isSymbolicLink(), force: true })
  fs.renameSync(abs, safeAbs)
}

/** Disposition counts reported by merge restore and preview. */
export interface MergeStats {
  /** Files only in the backup; restored. */
  newFiles: number
  /** Byte-identical files; skipped on both sides. */
  identical: number
  /** Local was newer; backup copy moved to the safe copy. */
  keepLocal: number
  /** Backup won or the domain swaps whole; local loser moved to the safe copy. */
  takeBackup: number
}

/** Result of applying one staged restore. */
export interface MergeResult {
  /** Top-level staging entries applied. */
  readonly applied: readonly string[]
  /** Directory holding displaced local losers, preserving relative paths. */
  readonly safeCopyRoot: string
  /** Disposition counts. */
  readonly stats: MergeStats
}

/** Inputs of one merge-restore application. */
export interface MergeRestoreInput {
  /** Staging directory produced by {@linkcode extractBackup}. */
  readonly stagingDir: string
  /** Live root label → absolute root mapping. */
  readonly roots: Readonly<Record<string, string>>
  /** Directory receiving displaced local files. */
  readonly safeCopyRoot: string
}

/**
 * Merge one staged restore into the live roots: absent files move in,
 * identical files skip, conflicts keep the newer side and displace the loser
 * into the safe copy, and atomic domains swap whole.
 * @param input - staging, live roots, and safe-copy destination.
 * @returns applied top-level entries, the safe-copy root, and counts.
 * @throws BackupEngineError when any involved path crosses a symlink.
 */
export async function mergeRestore(input: MergeRestoreInput): Promise<MergeResult> {
  const { stagingDir, roots, safeCopyRoot } = input
  for (const root of [stagingDir, safeCopyRoot, ...Object.values(roots)]) {
    if (lstatIfPresent(root)?.isSymbolicLink() ?? false) throw new BackupEngineError('SYMLINK', 'a restore root is a symlink')
  }
  walkFiles(stagingDir, '')
  fs.mkdirSync(safeCopyRoot, { recursive: true })
  const stats: MergeStats = { newFiles: 0, identical: 0, keepLocal: 0, takeBackup: 0 }
  const count = (action: RestoreAction): void => {
    if (action === 'new') stats.newFiles += 1
    else if (action === 'identical') stats.identical += 1
    else if (action === 'keepLocal') stats.keepLocal += 1
    else stats.takeBackup += 1
  }
  const rootOf = (rel: string): { root: string; inner: string } => rootFor(roots, rel)
  const mergeFile = async (stagingAbs: string, rel: string): Promise<void> => {
    const { root, inner } = rootOf(rel)
    const targetAbs = path.join(root, inner)
    if (hasLinkedAncestor(root, inner)) throw new BackupEngineError('SYMLINK', `restore target parent crosses a symlink: ${rel}`)
    const action = await decideRestoreAction(stagingAbs, targetAbs, rel, root)
    count(action)
    if (action === 'identical') return
    if (action === 'keepLocal') {
      moveIntoSafeCopy(stagingAbs, rel, safeCopyRoot)
      return
    }
    if (action === 'takeBackup' && lstatIfPresent(targetAbs) !== null) moveIntoSafeCopy(targetAbs, rel, safeCopyRoot)
    fs.mkdirSync(path.dirname(targetAbs), { recursive: true })
    fs.renameSync(stagingAbs, targetAbs)
    // Extraction writes 0644; the credential store refuses group/world-readable
    // files, so the atomic credential file restores to owner-only.
    if (ATOMIC_RELS.has(rel)) fs.chmodSync(targetAbs, 0o600)
  }
  const mergeDir = async (stagingAbs: string, relPrefix: string): Promise<void> => {
    const { root, inner } = rootOf(relPrefix)
    const targetAbs = path.join(root, inner)
    if (hasLinkedAncestor(root, inner)) throw new BackupEngineError('SYMLINK', `restore target parent crosses a symlink: ${relPrefix}`)
    const target = lstatIfPresent(targetAbs)
    if (target !== null && (target.isSymbolicLink() || !target.isDirectory())) moveIntoSafeCopy(targetAbs, relPrefix, safeCopyRoot)
    fs.mkdirSync(targetAbs, { recursive: true })
    for (const entry of fs.readdirSync(stagingAbs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = `${relPrefix}/${entry.name}`
      if (entry.isDirectory()) await mergeDir(path.join(stagingAbs, entry.name), rel)
      else await mergeFile(path.join(stagingAbs, entry.name), rel)
    }
  }
  const applied: string[] = []
  for (const entry of fs.readdirSync(stagingDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = entry.name
    const stagingAbs = path.join(stagingDir, rel)
    if (entry.isDirectory()) await mergeDir(stagingAbs, rel)
    else await mergeFile(stagingAbs, rel)
    applied.push(rel)
  }
  return { applied, safeCopyRoot, stats }
}

/** Preview counts: dispositions collapsed to new, identical, and conflicts. */
export interface MergeEstimate {
  /** Files only in the backup. */
  readonly newFiles: number
  /** Byte-identical files. */
  readonly identical: number
  /** `keepLocal` plus `takeBackup`: everything decided by recency or domain swap. */
  readonly conflicts: number
}

/**
 * Read-only preview of what {@linkcode mergeRestore} would do, through the
 * same per-file authority.
 * @param stagingDir - staging directory produced by {@linkcode extractBackup}.
 * @param roots - live root label → absolute root mapping.
 * @returns collapsed disposition counts.
 */
export async function estimateMerge(stagingDir: string, roots: Readonly<Record<string, string>>): Promise<MergeEstimate> {
  let newFiles = 0
  let identical = 0
  let conflicts = 0
  for (const rel of walkFiles(stagingDir, '')) {
    const { root, inner } = rootFor(roots, rel)
    const action = await decideRestoreAction(path.join(stagingDir, ...rel.split('/')), path.join(root, inner), rel, root)
    if (action === 'new') newFiles += 1
    else if (action === 'identical') identical += 1
    else conflicts += 1
  }
  return { newFiles, identical, conflicts }
}

/** One local backup set listed for the UI. */
export interface LocalBackupSet {
  /** Absolute backup-set directory. */
  readonly dir: string
  /** Directory name. */
  readonly name: string
  /** ISO creation time, or null when the manifest is unreadable. */
  readonly createdAt: string | null
  /** Packed size in bytes, or null when unreadable. */
  readonly packedBytes: number | null
  /** Producing application version, or null when unreadable. */
  readonly appVersion: string | null
  /** True when the manifest could not be read or validated. */
  readonly broken: boolean
}

/**
 * List backup-set directories under one local root, newest first.
 * @param rootDir - directory holding backup sets.
 * @returns readable sets first-class and unreadable ones flagged `broken`.
 */
export function listLocalBackups(rootDir: string): LocalBackupSet[] {
  if (!fs.existsSync(rootDir)) return []
  return fs.readdirSync(rootDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith(BACKUP_DIR_PREFIX))
    .map((entry) => {
      const dir = path.join(rootDir, entry.name)
      try {
        const manifest = readManifest(dir)
        return {
          dir,
          name: entry.name,
          createdAt: manifest.createdAt,
          packedBytes: manifest.totals.packedBytes,
          appVersion: manifest.appVersion,
          broken: false,
        }
      } catch {
        return { dir, name: entry.name, createdAt: null, packedBytes: null, appVersion: null, broken: true }
      }
    })
    .sort((a, b) => ((b.createdAt ?? '') < (a.createdAt ?? '') ? -1 : (b.createdAt ?? '') > (a.createdAt ?? '') ? 1 : 0))
}
