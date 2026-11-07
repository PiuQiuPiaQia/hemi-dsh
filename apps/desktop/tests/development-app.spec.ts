/** Development bundle preparation and the cold-start launcher, with macOS packaging tools stubbed per command. */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { developmentLauncher, prepareDevelopmentApp } from '../scripts/development-app.ts'

const signing = vi.hoisted(() => ({ fail: false, sawSidecars: undefined as boolean | undefined }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawnSync: vi.fn(actual.spawnSync),
    // ditto stays a real copy (physical `._` files included); plutil/codesign/lsregister are observed no-ops.
    execFileSync: vi.fn(actual.execFileSync).mockImplementation((...args) => {
      const [command, argv] = args
      if (command === '/usr/bin/ditto') {
        cpSync(String(argv?.[2]), String(argv?.[3]), { recursive: true, verbatimSymlinks: true })
        return ''
      }
      if (command === '/usr/bin/plutil' || command.endsWith('lsregister')) return ''
      if (command === '/usr/bin/codesign' && argv?.[0] === '--force') {
        const bundle = String(argv.at(-1))
        signing.sawSidecars = existsSync(join(bundle, '._Contents'))
          || existsSync(join(bundle, 'Contents', 'Resources', '._nested'))
        if (signing.fail) throw new Error('code object is invalid (unsealed contents)')
        return ''
      }
      return actual.execFileSync(...args)
    }),
  }
})

/** Real AppleDouble header: magic 0x00051607, version 0x00020000, then entry filler. */
const APPLE_DOUBLE = Buffer.of(0x00, 0x05, 0x16, 0x07, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00)

/** Assemble an Electron.app source carrying exFAT AppleDouble sidecars and one prefix-only resource. */
function electronSource(root: string) {
  const app = join(root, 'Electron.app')
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
  mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true })
  writeFileSync(join(app, 'Contents', 'MacOS', 'Electron'), 'electron bytes', { mode: 0o755 })
  writeFileSync(join(app, 'Contents', 'Info.plist'), 'development plist')
  writeFileSync(join(app, '._Contents'), APPLE_DOUBLE)
  writeFileSync(join(app, 'Contents', 'Resources', '._nested'), APPLE_DOUBLE)
  writeFileSync(join(app, 'Contents', 'Resources', '._template.txt'), 'bundle resource\n')
  return app
}

function developmentOptions(root: string, app: string) {
  return {
    electron: join(app, 'Contents', 'MacOS', 'Electron'), appRoot: root, directory: join(root, 'dev'),
    home: join(root, 'home'), primaryRuntime: join(root, 'runtime'), userData: join(root, 'browser data'),
    mainPort: 9229, rendererPort: 9222, hostPort: 9230, openDevtools: '0',
  }
}

it.skipIf(process.platform === 'win32')('passes literal workspace paths and cold-start settings to Electron', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-development-app-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const bundle = join(root, "Harness ' $(false).app")
  const binary = join(bundle, 'Contents', 'MacOS', 'Electron')
  mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
  const primaryRuntime = join(root, "runtime ' $(false)")
  writeFileSync(binary, '#!/bin/sh\nprintf "%s\\n" "$DSH_HOME" "$DSH_DESKTOP_PRIMARY_RUNTIME_DIR" "$DSH_DESKTOP_DEV_APP" "$DSH_DESKTOP_OPEN_DEVTOOLS" "${ELECTRON_RUN_AS_NODE-UNSET}" "$@"\n', { mode: 0o755 })
  const launcher = join(root, 'launcher')
  const home = join(root, "home ' $(false)")
  writeFileSync(launcher, developmentLauncher({ electron: binary, appRoot: root, directory: root,
    home, primaryRuntime, userData: join(root, 'browser data'), mainPort: 9229, rendererPort: 9222, hostPort: 9230, openDevtools: '0' }, bundle))
  // The GUI host exports ELECTRON_RUN_AS_NODE for its tool processes; the launcher must unset it before Electron starts.
  const result = execFileSync('/bin/sh', [launcher, '--test-launch-argument'],
    { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
  expect(result.trimEnd().split('\n')).toEqual([home, primaryRuntime, '1', '0', 'UNSET', '--inspect=127.0.0.1:9229',
    '--remote-debugging-port=9222', `--user-data-dir=${join(root, 'browser data')}`, root, '--test-launch-argument'])
})

it.skipIf(process.platform === 'win32')('signs the copied bundle only after physical AppleDouble sidecars are removed', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-development-prepare-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  vi.mocked(execFileSync).mockClear()
  signing.fail = false
  signing.sawSidecars = undefined
  const app = electronSource(root)
  const outside = join(root, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, '._outside'), APPLE_DOUBLE)
  symlinkSync(outside, join(app, 'Contents', 'Resources', 'linked'), 'dir')
  const options = developmentOptions(root, app)
  const executable = prepareDevelopmentApp(options)
  const bundle = join(options.directory, 'Harness Dev.app')
  expect(signing.sawSidecars).toBe(false)
  expect(existsSync(join(bundle, '._Contents'))).toBe(false)
  expect(existsSync(join(bundle, 'Contents', 'Resources', '._nested'))).toBe(false)
  expect(readFileSync(join(bundle, 'Contents', 'Resources', '._template.txt'), 'utf8')).toBe('bundle resource\n')
  expect(existsSync(join(outside, '._outside'))).toBe(true)
  expect(lstatSync(join(bundle, 'Contents', 'Resources', 'linked')).isSymbolicLink()).toBe(true)
  expect(readFileSync(executable, 'utf8')).toContain('Harness Dev.app/Contents/MacOS/Electron')
  expect(existsSync(join(bundle, 'Contents', 'Resources', 'dsh-development.json'))).toBe(true)
  expect(execFileSync).toHaveBeenCalledWith(expect.stringContaining('lsregister'), ['-f', bundle])
})

it.skipIf(process.platform === 'win32')('keeps the swept bundle without a stamp when ad-hoc signing fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-development-prepare-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  vi.mocked(execFileSync).mockClear()
  signing.fail = true
  signing.sawSidecars = undefined
  const app = electronSource(root)
  const options = developmentOptions(root, app)
  expect(() => prepareDevelopmentApp(options)).toThrow('code object is invalid')
  const bundle = join(options.directory, 'Harness Dev.app')
  expect(signing.sawSidecars).toBe(false)
  expect(existsSync(join(bundle, '._Contents'))).toBe(false)
  expect(existsSync(join(bundle, 'Contents', 'Resources', 'dsh-development.json'))).toBe(false)
  expect(execFileSync).not.toHaveBeenCalledWith(expect.stringContaining('lsregister'), expect.anything())
})
