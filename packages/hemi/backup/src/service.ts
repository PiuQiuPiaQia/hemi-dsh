/**
 * Host-owned Hemi backup service. Root-scope Remote owner (`hemiBackup`
 * namespace) orchestrating the snapshot engine: target configuration (local
 * folder or WebDAV), manual and scheduled runs with retention pruning, and
 * staged merge restore. The WebDAV application password lives in the
 * credential store, never in the settings file.
 *
 * @module @deepseek-ai/dsh-hemi-backup
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { expandHomePath, resolveAgentsHome, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  BACKUP_DIR_PREFIX,
  createBackup,
  estimateMerge,
  extractBackup,
  listLocalBackups,
  mergeRestore,
  readManifest,
  type BackupManifest,
} from './engine.ts'
import { createWebdavClient, type WebdavClient } from './webdav.ts'

/** Credential reference holding the WebDAV application password. */
const WEBDAV_PASSWORD_REF = credentialRef('HEMI_BACKUP_WEBDAV_PASSWORD')
/** Default remote directory name under a WebDAV target. */
const DEFAULT_REMOTE_DIR = 'hemi-backups'
/** Schedule tick; the interval itself is compared against the last run. */
const SCHEDULE_TICK_MS = 60 * 60 * 1000
const INTERVAL_MS: Readonly<Record<BackupScheduleInterval, number>> = { daily: 24 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000 }
/** Default skill threshold: 5 MiB collected bytes per skill directory. */
export const DEFAULT_SKILL_MAX_BYTES = 5 * 1024 * 1024

/** Plugin config. */
export interface Config {
  /** Skill directories whose collected size exceeds this are skipped whole. */
  skillMaxBytes: number
}

/** Runtime schema. */
export const Config = z.object({
  skillMaxBytes: z.number().default(DEFAULT_SKILL_MAX_BYTES),
})

/** Backup schedule choice. */
export type BackupScheduleInterval = 'daily' | 'weekly'

/** Where backup sets are written and listed from. */
export type BackupTarget =
  | { readonly kind: 'local'; readonly dir: string }
  | { readonly kind: 'webdav'; readonly url: string; readonly username: string; readonly remoteDir: string }

/** Persisted orchestrator state; the password is not part of it. */
export interface BackupSettings {
  /** Always 1. */
  readonly schemaVersion: 1
  /** Configured target, or null before the first setup. */
  readonly target: BackupTarget | null
  /** Schedule preferences. */
  readonly schedule: { readonly enabled: boolean; readonly interval: BackupScheduleInterval }
  /** Retention count clamped to 1–50. */
  readonly keep: number
  /** Last completed run attempt. */
  readonly lastRun: BackupLastRun | null
}

/** One finished or failed run attempt. */
export interface BackupLastRun {
  /** ISO completion time. */
  readonly at: string
  /** Whether the run produced a backup set. */
  readonly ok: boolean
  /** What started the run. */
  readonly trigger: 'manual' | 'scheduled'
  /** Packed bytes on success. */
  readonly packedBytes?: number
  /** Archived file count on success. */
  readonly files?: number
  /** Failure message on error. */
  readonly message?: string
}

/** Client-safe settings view: the password reduces to its presence. */
export interface BackupStateView {
  /** Persisted settings without any secret. */
  readonly settings: BackupSettings
  /** Whether a WebDAV application password is stored. */
  readonly hasPassword: boolean
  /** Whether a run or restore is executing right now. */
  readonly isRunning: boolean
  /** Live progress of the executing run, or the last phase before it ended. */
  readonly progress: BackupProgress | null
}

/** Coarse run progress for the UI; polled through {@linkcode HemiBackupService.getState}. */
export interface BackupProgress {
  /** Execution phase. */
  readonly phase: 'pack' | 'upload' | 'prune' | 'done' | 'error'
  /** Human-readable detail for the phase. */
  readonly detail?: string
}

/** One backup set listed for the UI. */
export interface BackupSetView {
  /** Set directory name. */
  readonly name: string
  /** ISO creation time, or null when unreadable. */
  readonly createdAt: string | null
  /** Packed bytes, or null when unreadable. */
  readonly packedBytes: number | null
  /** Producing application version, or null. */
  readonly appVersion: string | null
  /** Where the set was listed from. */
  readonly source: 'local' | 'webdav'
  /** True when the manifest could not be read or validated. */
  readonly broken?: boolean
  /** Skills the set excluded by the size threshold. */
  readonly skipped?: readonly { name: string; bytes: number }[]
}

/** Restore preview returned by {@linkcode HemiBackupService.restorePrepare}. */
export interface RestorePreview {
  /** Extracted file count. */
  readonly files: number
  /** Files under `dsh/sessions/`. */
  readonly sessions: number
  /** Files under `agents/skills/`. */
  readonly skills: number
  /** Merge estimate through the same per-file authority. */
  readonly estimate: { readonly newFiles: number; readonly identical: number; readonly conflicts: number }
}

/** Manifest summary carried by a successful run result. */
export interface RunManifestSummary {
  /** Optional manifest summary on success. */
  manifest?: { createdAt: string; files: number; packedBytes: number; skipped: readonly { name: string; bytes: number }[] }
}

/** Stable outcome shape for operations that only succeed or explain themselves. */
export interface BackupOperationResult {
  readonly ok: boolean
  readonly code?: 'BUSY' | 'NO_TARGET' | 'NO_RESTORE' | 'INVALID_NAME' | 'FAILED'
  readonly message?: string
}

/** Applied restore summary. */
export interface RestoreApplyResult extends BackupOperationResult {
  /** Displacement counts of the merge. */
  readonly stats?: { readonly newFiles: number; readonly identical: number; readonly keepLocal: number; readonly takeBackup: number }
  /** Directory holding displaced local losers. */
  readonly safeCopyRoot?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Hemi backup orchestrator and `hemiBackup` Remote owner. */
    hemiBackup: HemiBackupService
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The WebDAV target has no stored application password. */
    'hemi-backup/no-password': {}
  }
}

/** Normalize raw persisted settings into a complete value. */
function normalizeSettings(raw: unknown): BackupSettings {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<BackupSettings> & { target?: Partial<BackupTarget> & { kind?: string } | null }
  const target: BackupTarget | null = (() => {
    const candidate = source.target
    if (candidate === undefined || candidate === null) return null
    if (candidate.kind === 'local' && typeof candidate.dir === 'string' && candidate.dir !== '') return { kind: 'local', dir: expandHomePath(candidate.dir) }
    if (candidate.kind === 'webdav' && typeof candidate.url === 'string' && typeof candidate.username === 'string') {
      const remoteDir = typeof candidate.remoteDir === 'string' && candidate.remoteDir !== '' ? candidate.remoteDir : DEFAULT_REMOTE_DIR
      return { kind: 'webdav', url: candidate.url, username: candidate.username, remoteDir }
    }
    return null
  })()
  const scheduleSource = source.schedule ?? { enabled: false, interval: 'daily' }
  const interval: BackupScheduleInterval = scheduleSource.interval === 'weekly' ? 'weekly' : 'daily'
  return {
    schemaVersion: 1,
    target,
    schedule: { enabled:  scheduleSource.enabled, interval },
    keep: Math.min(Math.max(Number(source.keep) || 5, 1), 50),
    lastRun: source.lastRun ?? null,
  }
}

/**
 * Hemi backup orchestrator: settings, runs, retention, and staged restore,
 * exposed to the client as the `hemiBackup` Remote namespace.
 */
export default class HemiBackupService extends TypertRemoteService {
  /** Host services: the credential store owns the WebDAV application password. */
  static inject = ['credentials']
  /** Runtime schema. */
  static Config = Config

  private settings: BackupSettings | null = null
  private running = false
  private progress: BackupProgress | null = null
  private currentRestore: { stagingDir: string; setName: string } | null = null

  /**
   * @param ctx - Host root context.
   * @param config - plugin config carrying the skill size threshold.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'hemiBackup', { namespace: 'hemiBackup' })
    // One hourly tick decides whether the schedule is due; the effect
    // disposer clears the timer with the service.
    const timer = setInterval(() => { void this.scheduleTick() }, SCHEDULE_TICK_MS)
    ctx.effect(() => () => {
      clearInterval(timer)
    }, 'hemi-backup: schedule tick')
  }

  /** @returns resolved roots the engine packs from and restores into. */
  private roots(): { dshHome: string; agentsHome: string } {
    return { dshHome: resolveDshHome(), agentsHome: resolveAgentsHome() }
  }

  private settingsPath(): string {
    return path.join(this.roots().dshHome, 'backup-settings.json')
  }

  private loadSettings(): BackupSettings {
    if (this.settings !== null) return this.settings
    try {
      this.settings = normalizeSettings(JSON.parse(fs.readFileSync(this.settingsPath(), 'utf8')))
    } catch {
      this.settings = normalizeSettings(null)
    }
    return this.settings
  }

  private persistSettings(): void {
    const target = this.settingsPath()
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, `${JSON.stringify(this.loadSettings(), null, 2)}\n`)
  }

  private async storedPassword(): Promise<string | undefined> {
    const resolved = await this.ctx.credentials.resolve(WEBDAV_PASSWORD_REF)
    return resolved?.value
  }

  /** Build a WebDAV client, preferring the password saved in this process. */
  private async clientFor(target: Extract<BackupTarget, { kind: 'webdav' }>): Promise<WebdavClient> {
    const password = this.pendingPassword ?? await this.storedPassword()
    if (password === undefined || password === '') throw new RemoteError('hemi-backup/no-password', 'no WebDAV application password is stored', {})
    return createWebdavClient({ baseUrl: target.url, username: target.username, password })
  }

  /** The freshly saved password, kept in memory so a credential-file write that lags never breaks the next run. */
  private pendingPassword: string | undefined

  private tmpRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-backup-run-'))
  }

  private rootsMap(): Record<string, string> {
    const { dshHome, agentsHome } = this.roots()
    return { dsh: dshHome, agents: agentsHome }
  }

  /**
   * Read the client-safe state: settings, password presence, run flag, progress.
   * @returns current state view without secrets.
   */
  @Remote
  async getState(): Promise<BackupStateView> {
    const settings = this.loadSettings()
    return {
      settings,
      hasPassword: settings.target?.kind === 'webdav' && (await this.storedPassword()) !== undefined,
      isRunning: this.running,
      progress: this.progress,
    }
  }

  /**
   * Persist settings changes; a fresh password goes to the credential store.
   * @param input - partial settings plus an optional plaintext password.
   * @returns the state view after saving.
   */
  @Remote
  async saveSettings(input: Partial<Omit<BackupSettings, 'lastRun'>> & { password?: string }): Promise<BackupStateView> {
    const previous = this.loadSettings()
    const next = normalizeSettings({
      ...previous,
      ...('target' in input ? { target: input.target } : {}),
      ...('schedule' in input ? { schedule: input.schedule } : {}),
      ...('keep' in input ? { keep: input.keep } : {}),
      lastRun: previous.lastRun,
    })
    this.settings = next
    this.persistSettings()
    if (typeof input.password === 'string' && input.password !== '') {
      await this.ctx.credentials.set(WEBDAV_PASSWORD_REF, input.password)
      this.pendingPassword = input.password
    }
    return this.getState()
  }

  /**
   * Probe a target without saving it; the saved password is used when the
   * caller provides none.
   * @param target - target to probe; defaults to the saved one.
   * @returns success or a typed failure the UI can phrase.
   */
  @Remote
  async testConnection(target?: (BackupTarget & { password?: string })): Promise<BackupOperationResult & { message?: string }> {
    const saved = this.loadSettings().target
    const spec: (BackupTarget & { password?: string }) | null = target ?? saved
    if (spec === null) return { ok: false, code: 'NO_TARGET', message: 'no backup target is configured' }
    if (spec.kind === 'local') {
      try {
        fs.mkdirSync(spec.dir, { recursive: true })
        const probe = path.join(spec.dir, `.hemi-probe-${randomUUID()}`)
        fs.writeFileSync(probe, 'ok')
        fs.rmSync(probe, { force: true })
        return { ok: true }
      } catch (error) {
        return { ok: false, code: 'FAILED', message: error instanceof Error ? error.message : String(error) }
      }
    }
    const password = spec.password ?? this.pendingPassword ?? await this.storedPassword()
    if (password === undefined) return { ok: false, code: 'FAILED', message: 'no WebDAV application password is stored' }
    const client = createWebdavClient({ baseUrl: spec.url, username: spec.username, password })
    const result = await client.testConnection()
    if (!result.ok) return { ok: false, code: 'FAILED', message: result.message }
    try {
      await client.ensureDir(spec.remoteDir === '' ? DEFAULT_REMOTE_DIR : spec.remoteDir)
    } catch (error) {
      return { ok: false, code: 'FAILED', message: error instanceof Error ? error.message : String(error) }
    }
    return { ok: true }
  }

  /**
   * Run one backup now.
   * @returns the manifest summary on success or a typed failure.
   */
  @Remote
  runNow(): Promise<BackupOperationResult & RunManifestSummary> {
    return this.runBackup('manual')
  }

  /**
   * Run one backup: pack locally, upload when the target is WebDAV, prune
   * retention, and record the attempt under the given trigger.
   * @param trigger - what started the run.
   * @returns the manifest summary on success or a typed failure.
   */
  private async runBackup(trigger: 'manual' | 'scheduled'): Promise<BackupOperationResult & RunManifestSummary> {
    if (this.running) return { ok: false, code: 'BUSY', message: 'a backup or restore is already running' }
    const settings = this.loadSettings()
    const target = settings.target
    if (target === null) return { ok: false, code: 'NO_TARGET', message: 'no backup target is configured' }
    this.running = true
    const startedAt = Date.now()
    const report = (progress: BackupProgress): void => {
      this.progress = progress
    }
    try {
      const { dshHome, agentsHome } = this.roots()
      report({ phase: 'pack', detail: 'packing' })
      let backupDir: string
      let manifest: BackupManifest
      if (target.kind === 'local') {
        const packed = await createBackup({
          dshHome,
          agentsHome,
          outDir: target.dir,
          appVersion: null,
          skillMaxBytes: this.config.skillMaxBytes,
        })
        backupDir = packed.backupDir
        manifest = packed.manifest
      } else {
        const tmp = this.tmpRoot()
        try {
          const packed = await createBackup({
            dshHome,
            agentsHome,
            outDir: tmp,
            appVersion: null,
            skillMaxBytes: this.config.skillMaxBytes,
          })
          backupDir = packed.backupDir
          manifest = packed.manifest
          const client = await this.clientFor(target)
          const setName = path.basename(backupDir)
          report({ phase: 'upload', detail: `uploading ${setName}` })
          await client.ensureDir(`${target.remoteDir}/${setName}`)
          for (const part of fs.readdirSync(backupDir).sort()) {
            if (!part.startsWith('part-')) continue
            report({ phase: 'upload', detail: `uploading ${part}` })
            await client.uploadFile(`${target.remoteDir}/${setName}/${part}`, path.join(backupDir, part))
          }
          await client.uploadFile(`${target.remoteDir}/${setName}/manifest.json`, path.join(backupDir, 'manifest.json'))
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true })
        }
      }
      report({ phase: 'prune', detail: 'pruning old backups' })
      const keep = this.loadSettings().keep
      if (target.kind === 'local') {
        for (const stale of listLocalBackups(target.dir).slice(keep)) fs.rmSync(stale.dir, { recursive: true, force: true })
      } else {
        const client = await this.clientFor(target)
        const children = await client.listDir(target.remoteDir)
        const sets = children
          .filter(child => child.isDir && child.name.startsWith(BACKUP_DIR_PREFIX))
          .sort((a, b) => (a.name < b.name ? 1 : -1))
        for (const stale of sets.slice(keep)) await client.deleteFile(`${target.remoteDir}/${stale.name}`)
      }
      this.settings = {
        ...this.loadSettings(),
        lastRun: {
          at: new Date().toISOString(),
          ok: true,
          trigger,
          packedBytes: manifest.totals.packedBytes,
          files: manifest.entries.files,
        },
      }
      this.persistSettings()
      report({ phase: 'done', detail: `${manifest.totals.packedBytes} bytes in ${Date.now() - startedAt}ms` })
      return {
        ok: true,
        manifest: {
          createdAt: manifest.createdAt,
          files: manifest.entries.files,
          packedBytes: manifest.totals.packedBytes,
          skipped: manifest.skipped,
        },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.settings = { ...this.loadSettings(), lastRun: { at: new Date().toISOString(), ok: false, trigger, message } }
      this.persistSettings()
      report({ phase: 'error', detail: message })
      this.ctx.logger.warn(`hemi-backup: run failed: ${message}`)
      return { ok: false, code: 'FAILED', message }
    } finally {
      this.running = false
    }
  }

  /**
   * List backup sets on the configured target, newest first.
   * @returns local sets directly and WebDAV sets through their manifests.
   */
  @Remote
  async listBackups(): Promise<readonly BackupSetView[]> {
    const target = this.loadSettings().target
    if (target === null) return []
    if (target.kind === 'local') {
      return listLocalBackups(target.dir).map(set => ({ name: set.name, createdAt: set.createdAt, packedBytes: set.packedBytes, appVersion: set.appVersion, source: 'local' as const, broken: set.broken }))
    }
    const client = await this.clientFor(target)
    const children = await client.listDir(target.remoteDir)
    const views: BackupSetView[] = []
    for (const child of children) {
      if (!child.isDir || !child.name.startsWith(BACKUP_DIR_PREFIX)) continue
      const tmp = this.tmpRoot()
      try {
        await client.downloadToFile(`${target.remoteDir}/${child.name}/manifest.json`, path.join(tmp, 'manifest.json'))
        const manifest = readManifest(tmp)
        views.push({ name: child.name, createdAt: manifest.createdAt, packedBytes: manifest.totals.packedBytes, appVersion: manifest.appVersion, source: 'webdav', skipped: manifest.skipped })
      } catch {
        views.push({ name: child.name, createdAt: null, packedBytes: null, appVersion: null, source: 'webdav', broken: true })
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true })
      }
    }
    return views.sort((a, b) => ((b.createdAt ?? '') < (a.createdAt ?? '') ? -1 : (b.createdAt ?? '') > (a.createdAt ?? '') ? 1 : 0))
  }

  /**
   * Delete one backup set; the name must be a plain backup-set name.
   * @param setName - set directory name on the target.
   * @returns success or a typed failure.
   */
  @Remote
  async deleteSet(setName: string): Promise<BackupOperationResult> {
    if (!setName.startsWith(BACKUP_DIR_PREFIX) || setName.includes('..') || setName.includes('/')) {
      return { ok: false, code: 'INVALID_NAME', message: 'not a valid backup set name' }
    }
    const target = this.loadSettings().target
    if (target === null) return { ok: false, code: 'NO_TARGET', message: 'no backup target is configured' }
    if (target.kind === 'local') {
      fs.rmSync(path.join(target.dir, setName), { recursive: true, force: true })
      return { ok: true }
    }
    try {
      await (await this.clientFor(target)).deleteFile(`${target.remoteDir}/${setName}`)
      return { ok: true }
    } catch (error) {
      return { ok: false, code: 'FAILED', message: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Stage one set and produce the restore preview; the staging stays until
   * applied or cancelled.
   * @param setName - set directory name on the target.
   * @returns the preview on success or a typed failure.
   */
  @Remote
  async restorePrepare(setName: string): Promise<BackupOperationResult & { preview?: RestorePreview }> {
    if (this.currentRestore !== null) return { ok: false, code: 'BUSY', message: 'a restore is already staged' }
    const target = this.loadSettings().target
    if (target === null) return { ok: false, code: 'NO_TARGET', message: 'no backup target is configured' }
    const stagingDir = path.join(os.tmpdir(), `hemi-restore-${randomUUID()}`)
    const tmp = this.tmpRoot()
    try {
      let backupDir: string
      if (target.kind === 'local') {
        backupDir = path.join(target.dir, setName)
      } else {
        const client = await this.clientFor(target)
        await client.downloadToFile(`${target.remoteDir}/${setName}/manifest.json`, path.join(tmp, 'manifest.json'))
        const manifest = readManifest(tmp)
        for (const part of manifest.parts) await client.downloadToFile(`${target.remoteDir}/${setName}/${part.name}`, path.join(tmp, part.name))
        backupDir = tmp
      }
      const { entries } = await extractBackup(backupDir, stagingDir)
      const estimate = await estimateMerge(stagingDir, this.rootsMap())
      this.currentRestore = { stagingDir, setName }
      return {
        ok: true,
        preview: {
          files: entries.length,
          sessions: entries.filter(entry => entry.rel.startsWith('dsh/sessions/')).length,
          skills: entries.filter(entry => entry.rel.startsWith('agents/skills/')).length,
          estimate,
        },
      }
    } catch (error) {
      fs.rmSync(stagingDir, { recursive: true, force: true })
      return { ok: false, code: 'FAILED', message: error instanceof Error ? error.message : String(error) }
    } finally {
      if (target.kind !== 'local') fs.rmSync(tmp, { recursive: true, force: true })
    }
  }

  /**
   * Apply the staged restore as a merge; displaced local files survive in a
   * timestamped safe-copy directory under the Harness home.
   * @returns the merge counts and safe-copy location on success.
   */
  @Remote
  async restoreApply(): Promise<RestoreApplyResult> {
    const staged = this.currentRestore
    if (staged === null) return { ok: false, code: 'NO_RESTORE', message: 'no restore is staged' }
    const safeCopyRoot = path.join(this.roots().dshHome, 'restore-safety', `${Date.now()}`)
    try {
      const { stats } = await mergeRestore({ stagingDir: staged.stagingDir, roots: this.rootsMap(), safeCopyRoot })
      return { ok: true, stats, safeCopyRoot }
    } catch (error) {
      return { ok: false, code: 'FAILED', message: error instanceof Error ? error.message : String(error) }
    } finally {
      fs.rmSync(staged.stagingDir, { recursive: true, force: true })
      this.currentRestore = null
    }
  }

  /**
   * Discard the staged restore without touching live data.
   * @returns success or `NO_RESTORE` when nothing is staged.
   */
  @Remote
  restoreCancel(): Promise<BackupOperationResult> {
    const staged = this.currentRestore
    if (staged === null) return Promise.resolve({ ok: false, code: 'NO_RESTORE', message: 'no restore is staged' })
    fs.rmSync(staged.stagingDir, { recursive: true, force: true })
    this.currentRestore = null
    return Promise.resolve({ ok: true })
  }

  /** Decide whether the schedule is due and run it; failures only update `lastRun`. */
  private async scheduleTick(): Promise<void> {
    const settings = this.loadSettings()
    if (!settings.schedule.enabled || settings.target === null || this.running) return
    const lastRun = settings.lastRun
    if (lastRun?.ok === true && Date.now() - Date.parse(lastRun.at) < INTERVAL_MS[settings.schedule.interval]) return
    await this.runBackup('scheduled')
  }
}
