/** Host outcomes for failed packing, staged restore admission, and untrusted set names. */
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import HemiBackupService from '../src/service.ts'
import { createBackup } from '../src/engine.ts'

let root: string
let ctx: Context
let service: HemiBackupService
let backups: string
beforeEach(async () => {
  root = fs.mkdtempSync(join(tmpdir(), 'hemi-backup-host-'))
  vi.stubEnv('DSH_HOME', join(root, 'home'))
  vi.stubEnv('DSH_AGENTS_HOME', join(root, 'agents'))
  fs.mkdirSync(join(root, 'home/hemi-memory'), { recursive: true })
  fs.writeFileSync(join(root, 'home/hemi-memory/MEMORY.md'), 'saved memory')
  ctx = new Context()
  service = new HemiBackupService(ctx, { skillMaxBytes: 5242880 })
  backups = join(root, 'backups')
  await service.saveSettings({ target: { kind: 'local', dir: backups } })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await service.restoreCancel()
  await ctx.fiber.dispose()
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
  expect(state.settings.lastRun).toMatchObject({ ok: false, trigger: 'manual' })
  expect(fs.readdirSync(backups)).toHaveLength(2)
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
