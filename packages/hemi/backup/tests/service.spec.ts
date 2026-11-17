/** Host outcomes for failure-code persistence, failed packing, staged restore admission, and untrusted set names. */
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import HemiBackupService from '../src/service.ts'
import { createBackup } from '../src/engine.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'

/** The quota-exception shape reported by cloud WebDAV providers, with the exact field value. */
const trafficXml = '<?xml version="1.0" encoding="UTF-8"?><D:error xmlns:D="DAV:"><D:exception>TrafficRateExhausted</D:exception></D:error>'

const webdavTarget = { kind: 'webdav', url: 'https://dav.example/dav/', username: 'user', remoteDir: 'hemi-backups' } as const

let root: string
let ctx: Context
let service: HemiBackupService
let backups: string
/** Restarted host contexts reading the same persisted settings; disposed with the suite. */
const restarts: Context[] = []

/** A fresh host context over the same `DSH_HOME`, like an app restart. */
async function restart(): Promise<HemiBackupService> {
  const ctx = new Context()
  restarts.push(ctx)
  await ctx.plugin(MemoryCredentials)
  return new HemiBackupService(ctx, { skillMaxBytes: 5242880 })
}

beforeEach(async () => {
  root = fs.mkdtempSync(join(tmpdir(), 'hemi-backup-host-'))
  vi.stubEnv('DSH_HOME', join(root, 'home'))
  vi.stubEnv('DSH_AGENTS_HOME', join(root, 'agents'))
  fs.mkdirSync(join(root, 'home/hemi-memory'), { recursive: true })
  fs.writeFileSync(join(root, 'home/hemi-memory/MEMORY.md'), 'saved memory')
  ctx = new Context()
  await ctx.plugin(MemoryCredentials)
  service = new HemiBackupService(ctx, { skillMaxBytes: 5242880 })
  backups = join(root, 'backups')
  await service.saveSettings({ target: { kind: 'local', dir: backups } })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await service.restoreCancel()
  await ctx.fiber.dispose()
  for (const restarted of restarts.splice(0)) await restarted.fiber.dispose()
  vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
})

it('reports a failed snapshot in state and leaves existing retention sets intact', async () => {
  const input = { dshHome: join(root, 'home'), agentsHome: join(root, 'agents'), outDir: backups, appVersion: null, skillMaxBytes: 5242880 }
  await createBackup({ ...input, now: new Date('2026-11-01T00:00:00Z') })
  await createBackup({ ...input, now: new Date('2026-11-02T00:00:00Z') })
  await service.saveSettings({ keep: 1 })
  const victim = join(root, 'home/hemi-memory/MEMORY.md')
  const original = fs.createReadStream
  vi.spyOn(fs, 'createReadStream').mockImplementation((file, options) => {
    if (file === victim) fs.truncateSync(victim, 0)
    return original(file, options)
  })
  expect(await service.runNow()).toMatchObject({ ok: false, code: 'FAILED' })
  const state = await service.getState()
  expect(state.isRunning).toBe(false)
  expect(state.progress?.phase).toBe('error')
  expect(state.settings.lastRun).toMatchObject({ ok: false, trigger: 'manual', code: 'FAILED' })
  expect(fs.readdirSync(backups)).toHaveLength(2)
})

it('persists a WebDAV quota failure code, reads it back after restart, and never advances pruning', async () => {
  await service.saveSettings({ target: webdavTarget, password: 'app-pass' })
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) =>
    init?.method === 'MKCOL' ? new Response(null, { status: 201 }) : new Response(trafficXml, { status: 403 }))
  expect(await service.runNow()).toMatchObject({ ok: false, code: 'TRAFFIC_EXHAUSTED' })
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
  expect((await (await restart()).getState()).settings.lastRun).toMatchObject({ ok: false, trigger: 'manual', code: 'TRAFFIC_EXHAUSTED' })
})

it('loads a legacy lastRun without a code and drops an unknown persisted code', async () => {
  const settingsPath = join(root, 'home/backup-settings.json')
  const settings = (lastRun: Record<string, unknown>): string => `${JSON.stringify({
    schemaVersion: 1,
    target: { kind: 'local', dir: backups },
    schedule: { enabled: false, interval: 'daily' },
    keep: 5,
    lastRun,
  }, null, 2)}\n`
  fs.writeFileSync(settingsPath, settings({ at: '2026-10-01T00:00:00.000Z', ok: false, trigger: 'scheduled', message: 'old failure' }))
  expect((await (await restart()).getState()).settings.lastRun).toEqual({ at: '2026-10-01T00:00:00.000Z', ok: false, trigger: 'scheduled', message: 'old failure' })
  fs.writeFileSync(settingsPath, settings({ at: '2026-10-01T00:00:00.000Z', ok: false, trigger: 'scheduled', message: 'damaged', code: 'MYSTERY' }))
  expect((await (await restart()).getState()).settings.lastRun?.code).toBeUndefined()
})

it('keeps WebDAV codes through deleteSet and restorePrepare', async () => {
  await service.saveSettings({ target: webdavTarget, password: 'app-pass' })
  const fetchMock = vi.spyOn(globalThis, 'fetch')
  fetchMock.mockResolvedValue(new Response('denied by server policy', { status: 403 }))
  expect(await service.deleteSet('hemi-backup-20261105-000000')).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  fetchMock.mockResolvedValue(new Response('missing', { status: 404 }))
  expect(await service.restorePrepare('hemi-backup-20261105-000000')).toMatchObject({ ok: false, code: 'NOT_FOUND' })
  expect((await service.getState()).isRunning).toBe(false)
})

it('reports a missing or empty WebDAV password as NO_PASSWORD without contacting the server', async () => {
  await service.saveSettings({ target: webdavTarget })
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 207 }))
  expect(await service.testConnection()).toMatchObject({ ok: false, code: 'NO_PASSWORD' })
  expect(await service.testConnection({ ...webdavTarget, password: '' })).toMatchObject({ ok: false, code: 'NO_PASSWORD' })
  expect(await service.deleteSet('hemi-backup-20261105-000000')).toMatchObject({ ok: false, code: 'NO_PASSWORD' })
  expect(fetchMock).not.toHaveBeenCalled()
})

it('classifies WebDAV probe failures with the stable codes', async () => {
  await service.saveSettings({ target: webdavTarget, password: 'app-pass' })
  const fetchMock = vi.spyOn(globalThis, 'fetch')
  fetchMock.mockResolvedValue(new Response(trafficXml, { status: 403 }))
  expect(await service.testConnection()).toMatchObject({ ok: false, code: 'TRAFFIC_EXHAUSTED' })
  fetchMock.mockResolvedValue(new Response('blocked', { status: 403 }))
  expect(await service.testConnection()).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  fetchMock.mockResolvedValue(new Response('', { status: 401 }))
  expect(await service.testConnection()).toMatchObject({ ok: false, code: 'AUTH_FAILED' })
})

it('reports a failed merge as PARTIAL_RESTORE and keeps the safe-copy root', async () => {
  expect((await service.runNow()).ok).toBe(true)
  // The backup alone now holds MEMORY.md, so the merge must move a staged file.
  fs.rmSync(join(root, 'home/hemi-memory/MEMORY.md'))
  const [set] = await service.listBackups()
  if (set === undefined) throw new Error('backup set missing')
  expect((await service.restorePrepare(set.name)).ok).toBe(true)
  const original = fs.renameSync
  vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
    if (String(source).startsWith(join(tmpdir(), 'hemi-restore-'))) throw Object.assign(new Error('denied'), { code: 'EACCES' })
    original(source, target)
  })
  const result = await service.restoreApply()
  expect(result).toMatchObject({ ok: false, code: 'PARTIAL_RESTORE' })
  if (result.safeCopyRoot === undefined) throw new Error('safe-copy root missing')
  expect(fs.existsSync(result.safeCopyRoot)).toBe(true)
  expect(await service.restoreCancel()).toMatchObject({ ok: false, code: 'NO_RESTORE' })
})

it.each(['../hemi-backup-20261105-000000', 'hemi-backup-20261105-000000/../../outside', 'hemi-backup-20261105-000000\\..\\outside', '/hemi-backup-20261105-000000'])(
  'rejects untrusted set name %s through both Remote operations', async (name) => {
    expect(await service.restorePrepare(name)).toMatchObject({ ok: false, code: 'INVALID_NAME' })
    expect(await service.deleteSet(name)).toMatchObject({ ok: false, code: 'INVALID_NAME' })
    expect((await service.getState()).isRunning).toBe(false)
  },
)

it('blocks overlapping restore and backup operations while preparing or holding a preview', async () => {
  expect((await service.runNow()).ok).toBe(true)
  const [set] = await service.listBackups()
  expect(set).toBeDefined()
  if (set === undefined) throw new Error('backup set missing')
  const prepare = service.restorePrepare(set.name)
  expect(await service.restorePrepare(set.name)).toMatchObject({ ok: false, code: 'BUSY' })
  expect(await service.runNow()).toMatchObject({ ok: false, code: 'BUSY' })
  expect(await service.restoreCancel()).toMatchObject({ ok: false, code: 'BUSY' })
  expect((await prepare).ok).toBe(true)
  expect(await service.runNow()).toMatchObject({ ok: false, code: 'BUSY' })
  expect((await service.restoreApply()).ok).toBe(true)
  expect((await service.getState()).isRunning).toBe(false)
})
