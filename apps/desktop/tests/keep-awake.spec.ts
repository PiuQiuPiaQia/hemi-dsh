import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { DesktopKeepAwake, type DesktopKeepAwakeState } from '../src/keep-awake.ts'
import { DesktopSettingsFileError } from '../src/settings-file.ts'

const powerSaveBlocker = vi.hoisted(() => ({ start: vi.fn(() => 7), stop: vi.fn() }))
vi.mock('electron', () => ({ powerSaveBlocker }))

afterEach(() => { vi.clearAllMocks() })

async function fixture(raw?: string) {
  const root = await mkdtemp(join(tmpdir(), 'desktop-keep-awake-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  if (raw !== undefined) {
    await mkdir(join(root, 'desktop'), { recursive: true })
    await writeFile(join(root, 'desktop', 'settings.json'), raw)
  }
  const states: DesktopKeepAwakeState[] = []
  return { root, states, path: join(root, 'desktop', 'settings.json'),
    keepAwake: new DesktopKeepAwake(root, (state) => { states.push(state) }) }
}

it('keeps a missing document and an absent field off without creating a file', async () => {
  const missing = await fixture()
  await missing.keepAwake.load()
  expect(missing.keepAwake.state).toEqual({ enabled: false })
  expect(missing.states).toEqual([])
  expect(powerSaveBlocker.start).not.toHaveBeenCalled()
  await expect(readFile(missing.path)).rejects.toMatchObject({ code: 'ENOENT' })

  const absent = await fixture('{"updates":{"channel":"nightly"}}')
  await absent.keepAwake.load()
  expect(absent.keepAwake.state).toEqual({ enabled: false })
  expect(absent.states).toEqual([])
})

it.each([[true, 1], [false, 0]])('reconciles the persisted choice at startup: %s', async (enabled, expectedStarts) => {
  const f = await fixture(JSON.stringify({ keepAwake: { enabled } }))
  await f.keepAwake.load()
  expect(f.keepAwake.state).toEqual({ enabled })
  expect(f.states).toEqual([{ enabled }])
  expect(powerSaveBlocker.start).toHaveBeenCalledTimes(expectedStarts)
})

it('reports an invalid persisted choice without holding an assertion', async () => {
  const f = await fixture('{"keepAwake":{"enabled":"yes"}}')
  await f.keepAwake.load()
  expect(f.keepAwake.state).toEqual({ enabled: false, error: 'read' })
  expect(f.states).toEqual([{ enabled: false, error: 'read' }])
  expect(powerSaveBlocker.start).not.toHaveBeenCalled()
})

it('persists an explicit choice before holding the assertion and releases it afterwards', async () => {
  const f = await fixture('{"updates":{"channel":"nightly"},"keep":true}')
  await f.keepAwake.load()
  expect(await f.keepAwake.set(true)).toEqual({ enabled: true })
  expect(JSON.parse(await readFile(f.path, 'utf8'))).toEqual({
    updates: { channel: 'nightly' }, keep: true, keepAwake: { enabled: true },
  })
  expect(powerSaveBlocker.start).toHaveBeenCalledWith('prevent-app-suspension')
  expect(powerSaveBlocker.stop).not.toHaveBeenCalled()
  expect(await f.keepAwake.set(false)).toEqual({ enabled: false })
  expect(powerSaveBlocker.stop).toHaveBeenCalledWith(7)
  expect(JSON.parse(await readFile(f.path, 'utf8'))).toMatchObject({ keepAwake: { enabled: false } })
})

it('answers an unchanged choice without writing and clears a read error through an explicit save', async () => {
  const f = await fixture()
  await f.keepAwake.load()
  expect(await f.keepAwake.set(false)).toEqual({ enabled: false })
  await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' })

  const invalid = await fixture('{"keepAwake":{"enabled":"bad"}}')
  await invalid.keepAwake.load()
  expect(await invalid.keepAwake.set(false)).toEqual({ enabled: false })
  expect(invalid.keepAwake.state).toEqual({ enabled: false })
  expect(JSON.parse(await readFile(invalid.path, 'utf8'))).toEqual({ keepAwake: { enabled: false } })
})

it('rejects a save on an unusable document and leaves state and assertion untouched', async () => {
  const f = await fixture('{broken')
  await f.keepAwake.load()
  await expect(f.keepAwake.set(true)).rejects.toBeInstanceOf(DesktopSettingsFileError)
  expect(f.keepAwake.state).toEqual({ enabled: false, error: 'read' })
  expect(powerSaveBlocker.start).not.toHaveBeenCalled()
  expect(await readFile(f.path, 'utf8')).toBe('{broken')
})
