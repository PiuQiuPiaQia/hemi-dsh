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

import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { FileHandle } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { createGzip, createGunzip } from 'node:zlib'
import { z } from 'zod'

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
  'hemi-memory',
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
  constructor(readonly code: 'EMPTY_ARCHIVE' | 'NOT_A_BACKUP' | 'NEWER_SCHEMA' | 'MISSING_PARTS' | 'PART_CORRUPT' | 'SYMLINK' | 'SNAPSHOT_SHRUNK' | 'PATH_TOO_LONG' | 'INVALID_PATH' | 'INVALID_ARCHIVE', message: string) {
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
    if (hasLinkedAncestor(root, rel.split('/').slice(1).join('/'))) return
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
  if (Buffer.byteLength(member.name) > 100) {
    const split = member.name.lastIndexOf('/')
    if (split > 0 && Buffer.byteLength(member.name.slice(split + 1)) <= 100 && Buffer.byteLength(member.name.slice(0, split)) <= 155) {
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

function* longNameEntry(name: string): Generator<Buffer> {
  const content = Buffer.from(`${name}\0`, 'utf8')
  const long = buildHeader({ name: '././@LongLink', type: 'file', size: content.length, mtimeMs: 0 })
  if (long.needsLong || long.header === undefined) throw new BackupEngineError('PATH_TOO_LONG', `backup path too long (>255): ${name}`)
  long.header.write('L', 156)
  long.header.write('        ', 148)
  let sum = 0
  for (const byte of long.header) sum += byte
  long.header.write(octal(sum, 8), 148)
  yield long.header
  yield content
  const pad = (512 - (content.length % 512)) % 512
  if (pad > 0) yield Buffer.alloc(pad, 0)
}

async function* tarEntries(entries: readonly BackupEntry[], roots: Readonly<Record<string, string>>): AsyncGenerator<Buffer> {
  for (const entry of entries) {
    const { root, inner } = rootFor(roots, entry.rel)
    validateArchivePath(entry.rel, entry.type)
    if (hasLinkedAncestor(root, inner)) {
      throw new BackupEngineError('SYMLINK', `backup path crosses a symlink: ${entry.rel}`)
    }
    const size = entry.type === 'dir' ? 0 : entry.bytes ?? 0
    const header = buildHeader({ name: entry.rel, type: entry.type, size, mtimeMs: entry.mtimeMs ?? Date.now() })
    if (header.needsLong) {
      yield* longNameEntry(entry.rel)
      const retry = buildHeader({ name: '_L', type: entry.type, size, mtimeMs: entry.mtimeMs ?? Date.now() })
      if (retry.header !== undefined) yield retry.header
    } else if (header.header !== undefined) {
      yield header.header
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
      yield piece
      remaining -= piece.length
    }
    if (remaining > 0) throw new BackupEngineError('SNAPSHOT_SHRUNK', `file rewrote shorter during backup: ${entry.rel} (missing ${remaining} bytes)`)
    const pad = (512 - (size % 512)) % 512
    if (pad > 0) yield Buffer.alloc(pad, 0)
  }
  yield Buffer.alloc(1024, 0)
}

const pad2 = (value: number): string => String(value).padStart(2, '0')

function stamp(now: Date): string {
  return `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`
}

/**
 * Resolve a non-clobbering backup directory for this second.
 * @param outDir - Parent directory where the backup set is created.
 * @param now - Timestamp used to name the backup set.
 * @returns the new backup-set directory path.
 */
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
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) throw new BackupEngineError('INVALID_ARCHIVE', 'volume size must be a positive safe integer')
  const now = input.now ?? new Date()
  const { entries, skipped } = collectEntries(input.dshHome, input.agentsHome, input.skillMaxBytes)
  if (!entries.some(entry => entry.type === 'file')) {
    throw new BackupEngineError('EMPTY_ARCHIVE', 'backup whitelist collected no files; the data roots look wrong')
  }
  const backupDir = resolveBackupDir(input.outDir, now)
  fs.mkdirSync(backupDir, { recursive: true })
  const roots: Record<string, string> = { [DSH_ROOT_LABEL]: input.dshHome, [AGENTS_ROOT_LABEL]: input.agentsHome }
  const parts: BackupManifest['parts'][number][] = []
  let handle: FileHandle | undefined
  let hash = createHash('sha256')
  let written = 0
  const closePart = async (): Promise<void> => {
    if (handle === undefined) return
    await handle.close()
    handle = undefined
    parts.push({ name: `part-${String(parts.length).padStart(4, '0')}.gz`, bytes: written, sha256: hash.digest('hex') })
  }
  try {
    await pipeline(tarEntries(entries, roots), createGzip({ level: 6 }), async (source) => {
      for await (const chunk of source as AsyncIterable<Buffer>) {
        let offset = 0
        while (offset < chunk.length) {
          if (handle === undefined) {
            handle = await fs.promises.open(path.join(backupDir, `part-${String(parts.length).padStart(4, '0')}.gz`), 'wx', 0o600)
            hash = createHash('sha256')
            written = 0
          }
          const piece = chunk.subarray(offset, offset + Math.min(chunkBytes - written, chunk.length - offset))
          await handle.writeFile(piece)
          hash.update(piece)
          written += piece.length
          offset += piece.length
          if (written === chunkBytes) await closePart()
        }
      }
      await closePart()
    })
  } catch (error) {
    try {
      await handle?.close()
    } finally {
      fs.rmSync(backupDir, { recursive: true, force: true })
    }
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

const manifestSchema = z.object({
  kind: z.literal(BACKUP_KIND),
  schemaVersion: z.literal(BACKUP_SCHEMA_VERSION),
  tier: z.literal('light'),
  createdAt: z.iso.datetime(),
  appVersion: z.string().nullable(),
  compression: z.literal('gzip'),
  chunkBytes: z.number().int().positive(),
  parts: z.array(z.object({
    name: z.string().regex(/^part-[0-9]{4,}\.gz$/u),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })).min(1),
  entries: z.object({ files: z.number().int().nonnegative(), dirs: z.number().int().nonnegative() }),
  totals: z.object({ rawBytes: z.number().int().nonnegative(), packedBytes: z.number().int().positive() }),
  skipped: z.array(z.object({ name: z.string(), bytes: z.number().int().nonnegative(), reason: z.literal('oversize') })),
})

/**
 * Read and validate one backup-set manifest, including plain volume filenames.
 * @param backupDir - backup-set directory holding `manifest.json`.
 * @returns the parsed manifest.
 * @throws BackupEngineError for foreign, unsupported, or invalid manifests.
 */
export function readManifest(backupDir: string): BackupManifest {
  const parsed: unknown = JSON.parse(fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8'))
  const envelope = z.object({ kind: z.literal(BACKUP_KIND), schemaVersion: z.number().int() }).safeParse(parsed)
  if (!envelope.success) throw new BackupEngineError('NOT_A_BACKUP', 'not a Hemi backup manifest')
  if (envelope.data.schemaVersion > BACKUP_SCHEMA_VERSION) {
    throw new BackupEngineError('NEWER_SCHEMA', `backup format version ${envelope.data.schemaVersion} is newer than supported ${BACKUP_SCHEMA_VERSION}; upgrade the app first`)
  }
  const result = manifestSchema.safeParse(parsed)
  if (!result.success) throw new BackupEngineError('NOT_A_BACKUP', 'invalid Hemi backup manifest; select an intact backup set')
  const manifest = result.data
  if (new Set(manifest.parts.map(part => part.name)).size !== manifest.parts.length) {
    throw new BackupEngineError('NOT_A_BACKUP', 'backup manifest repeats a volume')
  }
  return manifest
}

/** Reject paths that can escape staging or name platform-specific filesystem targets. */
function validateArchivePath(rel: string, type: 'file' | 'dir'): void {
  const segments = rel.split('/')
  if (rel.includes('\\') || rel.includes(':') || rel.includes('\0')
    || segments.some(segment => segment === '' || segment === '.' || segment === '..'
      || /[. ]$/u.test(segment) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment))
    || (segments[0] !== DSH_ROOT_LABEL && segments[0] !== AGENTS_ROOT_LABEL)) {
    throw new BackupEngineError('INVALID_PATH', `invalid backup member path: ${rel}`)
  }
  const file = type === 'file'
  if ((segments.length === 1 && file)
    || (segments[0] === AGENTS_ROOT_LABEL && segments.length === 2 && file)
    || (segments[0] === DSH_ROOT_LABEL && segments[1]?.startsWith('.')
      && (segments.length !== 2 || !file))
    || (segments[0] === DSH_ROOT_LABEL && segments[1] === 'sessions'
      && (file ? segments.length !== 5 || !/^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/u.test(segments[4] ?? '') : segments.length > 4))
    || (segments[0] === DSH_ROOT_LABEL && segments[1] === 'profiles' && file && segments.length !== 4)) {
    throw new BackupEngineError('INVALID_PATH', `invalid backup member type or location: ${rel}`)
  }
  const label = segments[0]
  const top = segments[1]
  if (top !== undefined && (label === DSH_ROOT_LABEL ? !DSH_ENTRIES.includes(top) : top !== 'skills')) {
    throw new BackupEngineError('INVALID_PATH', `backup member is outside the data whitelist: ${rel}`)
  }
  if (isExcludedRel(rel)
    || (top === 'profiles' && segments.length > 3 && (segments.length !== 4 || !PROFILE_FILES.has(segments[3] ?? '')))
    || (top === 'storages' && segments[2] !== undefined && STORAGE_EXCLUDED.has(segments[2]))) {
    throw new BackupEngineError('INVALID_PATH', `backup member is excluded from restore: ${rel}`)
  }
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
  private fileStream: FileHandle | null = null
  private zeroBlocks = 0
  private fileTarget: string | null = null
  private fileMtimeSec = 0
  private pendingPad = 0
  /** @param dir - staging directory receiving extracted members. */
  constructor(private readonly dir: string) {}

  private async onHeader(header: Buffer): Promise<void> {
    if (header.every(byte => byte === 0)) {
      this.zeroBlocks += 1
      this.state = 'header'
      this.need = 512
      return
    }
    const checksum = Number.parseInt(header.toString('ascii', 148, 156).replace(/\0.*$/u, '').trim(), 8)
    const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0)
    if (checksum !== actual || this.zeroBlocks > 0) throw new BackupEngineError('INVALID_ARCHIVE', 'invalid tar header or data after end marker')
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const size = Number.parseInt(header.toString('utf8', 124, 136).replace(/\0.*$/, '').trim(), 8)
    if (!Number.isSafeInteger(size) || size < 0) throw new BackupEngineError('INVALID_ARCHIVE', 'invalid tar member size')
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
    validateArchivePath(rel, type === '5' ? 'dir' : 'file')
    if (hasLinkedAncestor(this.dir, rel)) throw new BackupEngineError('SYMLINK', `staging path crosses a symlink: ${rel}`)
    const pad = (512 - (size % 512)) % 512
    this.pendingPad = pad
    if (type === '5') {
      if (size !== 0) throw new BackupEngineError('INVALID_ARCHIVE', 'directory entry carries file content')
      fs.mkdirSync(path.join(this.dir, rel), { recursive: true })
      this.state = pad > 0 ? 'pad' : 'header'
      this.need = pad || 512
      return
    }
    const write = type === '0' || type === '\0'
    if (write) {
      const target = path.join(this.dir, rel)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      this.fileStream = await fs.promises.open(target, 'wx', 0o600)
      this.fileTarget = target
      this.fileMtimeSec = mtimeSec
      this.restored.push({ rel, type: 'file', bytes: size })
    } else {
      throw new BackupEngineError('INVALID_ARCHIVE', `unsupported tar member type: ${type}`)
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
        await this.onHeader(header)
      } else if (this.state === 'content') {
        if (this.need === 0) {
          if (this.longSink !== null) {
            this.longName = Buffer.concat(this.longSink).toString('utf8').replace(/\0.*$/, '')
            this.longSink = null
          }
          if (this.fileStream !== null) {
            const closing = this.fileStream
            await closing.close()
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
            await target.writeFile(piece)
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

  /** Close any incomplete member after extraction fails. */
  async close(): Promise<void> {
    await this.fileStream?.close()
    this.fileStream = null
  }

  /** Refuse a truncated tar stream even when its gzip and volume hashes are valid. */
  finish(): void {
    if (this.state !== 'header' || this.buffer.length !== 0 || this.zeroBlocks < 2 || this.longName !== null) {
      throw new BackupEngineError('INVALID_ARCHIVE', 'incomplete tar archive; select an intact backup set')
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
 * @throws BackupEngineError for invalid manifests, linked volumes, unsafe member
 * paths, mismatched hashes, or malformed tar content. Failed extraction closes
 * file handles and removes staging without applying any live data.
 */
export async function extractBackup(backupDir: string, stagingDir: string): Promise<ExtractResult> {
  const manifest = readManifest(backupDir)
  for (const part of manifest.parts) {
    const abs = path.join(backupDir, part.name)
    if (hasLinkedAncestor(backupDir, part.name)) throw new BackupEngineError('SYMLINK', `volume crosses a symlink: ${part.name}`)
    const size = fs.statSync(abs).size
    if (size !== part.bytes) throw new BackupEngineError('PART_CORRUPT', `volume ${part.name} size mismatch (expected ${part.bytes}, found ${size})`)
    if (await sha256File(abs) !== part.sha256) throw new BackupEngineError('PART_CORRUPT', `volume ${part.name} failed its sha256 check; the backup may be damaged`)
  }
  if (lstatIfPresent(stagingDir)?.isSymbolicLink()) throw new BackupEngineError('SYMLINK', 'restore staging is a symlink')
  fs.rmSync(stagingDir, { recursive: true, force: true })
  fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 })
  const extractor = new TarExtractor(stagingDir)
  try {
    await pipeline(
      partsConcat(backupDir, manifest.parts),
      createGunzip(),
      async (source) => {
        for await (const chunk of source as AsyncIterable<Buffer>) await extractor.push(chunk)
      },
    )
    extractor.finish()
  } catch (error) {
    await extractor.close()
    fs.rmSync(stagingDir, { recursive: true, force: true })
    throw error
  }
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

/** Existing Session directories retain every generation, including when a backup adds another version. */
function sessionDirectory(localRoot: string, rel: string): string | undefined {
  const segments = rel.split('/')
  return segments[0] === DSH_ROOT_LABEL && segments[1] === 'sessions' && segments.length >= 5
    ? path.join(localRoot, ...segments.slice(1, 4)) : undefined
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
  const sessionDir = sessionDirectory(localRoot, rel)
  if (hasLinkedAncestor(localRoot, rel.split('/').slice(1).join('/'))) return sessionDir !== undefined ? 'keepLocal' : 'takeBackup'
  const local = lstatIfPresent(localAbs)
  if (ATOMIC_RELS.has(rel)) return local !== null ? 'takeBackup' : 'new'
  if (local === null) return sessionDir !== undefined && lstatIfPresent(sessionDir) !== null ? 'keepLocal' : 'new'
  if (local.isSymbolicLink() || !local.isFile()) return sessionDir !== undefined ? 'keepLocal' : 'takeBackup'
  if (await filesIdentical(stagingAbs, localAbs)) return 'identical'
  if (sessionDir !== undefined) return 'keepLocal'
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

/** Complete cross-volume moves before removing their source. */
function moveFile(source: string, target: string): void {
  try {
    fs.renameSync(source, target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    fs.cpSync(source, target, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true })
    fs.rmSync(source, { recursive: true })
  }
}

function moveIntoSafeCopy(abs: string, rel: string, safeCopyRoot: string): void {
  const safeAbs = path.join(safeCopyRoot, ...rel.split('/'))
  if (hasLinkedAncestor(safeCopyRoot, rel)) throw new BackupEngineError('SYMLINK', `safe-copy path crosses a symlink: ${rel}`)
  fs.mkdirSync(path.dirname(safeAbs), { recursive: true })
  const prior = lstatIfPresent(safeAbs)
  if (prior !== null) fs.rmSync(safeAbs, { recursive: !prior.isSymbolicLink(), force: true })
  moveFile(abs, safeAbs)
}

/** Disposition counts reported by merge restore and preview. */
export interface MergeStats {
  /** Files only in the backup; restored. */
  newFiles: number
  /** Byte-identical files; skipped on both sides. */
  identical: number
  /** Local was newer or belongs to an existing Session; backup saved separately. */
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
 * identical files skip, and ordinary conflicts keep the newer side in place.
 * Existing Session directories retain all local generations; conflicting or
 * additional backup generations go to the safe copy. New Session files publish
 * exclusively. Credentials swap whole; displaced files go to the safe copy.
 * @param input - staging, live roots, and safe-copy destination.
 * @returns applied top-level entries, the safe-copy root, and counts.
 * @throws BackupEngineError for invalid archive paths or linked restore paths.
 * I/O failures may leave a partial merge; the original backup remains available.
 */
export async function mergeRestore(input: MergeRestoreInput): Promise<MergeResult> {
  const { stagingDir, roots, safeCopyRoot } = input
  for (const root of [stagingDir, safeCopyRoot, ...Object.values(roots)]) {
    if (lstatIfPresent(root)?.isSymbolicLink() ?? false) throw new BackupEngineError('SYMLINK', 'a restore root is a symlink')
  }
  for (const rel of walkFiles(stagingDir, '')) validateArchivePath(rel, 'file')
  fs.mkdirSync(safeCopyRoot, { recursive: true, mode: 0o700 })
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
    moveFile(stagingAbs, targetAbs)
    // Restored credentials must remain owner-only for the credential provider.
    if (ATOMIC_RELS.has(rel)) fs.chmodSync(targetAbs, 0o600)
  }
  const mergeSession = async (stagingAbs: string, rel: string, targetAbs: string): Promise<void> => {
    const dshRoot = roots[DSH_ROOT_LABEL]
    if (dshRoot === undefined) throw new BackupEngineError('INVALID_PATH', 'Harness restore root is missing')
    const files = walkFiles(stagingAbs, rel)
    try {
      fs.mkdirSync(targetAbs, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      // Existing Sessions retain their log generations and native write ownership.
      for (const member of files) {
        const source = path.join(stagingDir, member)
        const local = path.join(dshRoot, ...member.split('/').slice(1))
        const action = await decideRestoreAction(source, local, member, dshRoot)
        count(action)
        if (action !== 'identical') moveIntoSafeCopy(source, member, safeCopyRoot)
      }
      return
    }
    for (const member of files) {
      const source = path.join(stagingDir, member)
      const target = path.join(dshRoot, ...member.split('/').slice(1))
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
      // Copy beside the destination before exclusive publication; staging may be on another volume.
      const temp = path.join(path.dirname(target), `.hemi-restore-${randomUUID()}`)
      try {
        fs.copyFileSync(source, temp, fs.constants.COPYFILE_EXCL)
        fs.chmodSync(temp, 0o600)
        const stats = fs.statSync(source)
        fs.utimesSync(temp, stats.atime, stats.mtime)
        try {
          fs.linkSync(temp, target)
          count('new')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          count('keepLocal')
          moveIntoSafeCopy(source, member, safeCopyRoot)
        }
      } finally {
        fs.rmSync(temp, { force: true })
      }
    }
  }
  const mergeDir = async (stagingAbs: string, relPrefix: string): Promise<void> => {
    const { root, inner } = rootOf(relPrefix)
    const targetAbs = path.join(root, inner)
    if (hasLinkedAncestor(root, inner)) throw new BackupEngineError('SYMLINK', `restore target parent crosses a symlink: ${relPrefix}`)
    const target = lstatIfPresent(targetAbs)
    if (relPrefix.startsWith('dsh/sessions/') && relPrefix.split('/').length === 4) {
      await mergeSession(stagingAbs, relPrefix, targetAbs)
      return
    }
    if (target !== null && !target.isDirectory() && (relPrefix === 'dsh/sessions' || relPrefix.startsWith('dsh/sessions/'))) {
      throw new BackupEngineError('INVALID_PATH', `Session directory is not a directory: ${relPrefix}`)
    }
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
