/** Fixed-certificate helper staging keeps native receipts valid and removes only owned partial builds. */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { stageHemiComputerUse } from '../release/cua.mjs'
import { verifyHemiMacApplication } from '../release/signing.mjs'

const { child } = vi.hoisted(() => ({ child: vi.fn<(command: string, args: string[]) => Promise<void>>() }))
vi.mock('execa', () => ({ execa: child }))
vi.mock('../release/signing.mjs', async importOriginal => ({
  ...await importOriginal<typeof import('../release/signing.mjs')>(), verifyHemiMacApplication: vi.fn(),
}))
const roots: string[] = []
const environment = { DSH_DESKTOP_APP_ID: 'ai.hemi.dsh.desktop', DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
  HEMI_DESKTOP_GITHUB_REPOSITORY: 'example/hemi-dsh', HEMI_DESKTOP_UPDATE_POLICY: 'disabled',
  HEMI_DESKTOP_SIGNING_MODE: 'community', CSC_KEYCHAIN: '/fixture/keychain' }

async function checkout(): Promise<{ root: string; output: string }> {
  const root = await mkdtemp(join(tmpdir(), 'hemi-cua-stage-'))
  roots.push(root)
  const native = join(root, 'packages/experimental/cua-macos/native')
  await mkdir(native, { recursive: true })
  await writeFile(join(native, 'Info.plist'), '<plist><dict><key>CFBundleIdentifier</key><string>com.example.helper</string></dict></plist>')
  return { root, output: join(native, 'bin') }
}

afterEach(async () => {
  vi.resetAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('signs both helper architectures before reading their completed receipts', async () => {
  const { root, output } = await checkout()
  child.mockResolvedValue(undefined)
  const read = vi.fn((directory: string) => ({ application: join(directory, 'Helper.app'), bundle: 'fixture' }))
  await stageHemiComputerUse(root, environment, read)
  expect(read.mock.calls.map(([directory]) => directory)).toEqual([join(output, 'darwin-arm64'), join(output, 'darwin-x64')])
  expect(child).toHaveBeenCalledTimes(2)
  const args = child.mock.calls[0]![1]
  expect(args).toContain('--requirements')
  expect(args).toContain('--timestamp')
  expect(args).toContain('none')
  expect(args.some(argument => argument.startsWith('=designated => identifier "com.example.helper" and certificate leaf = H"'))).toBe(true)
  expect(verifyHemiMacApplication).toHaveBeenCalledTimes(2)
})

it('removes its partial output only after a helper build rejects', async () => {
  const { root, output } = await checkout()
  child.mockImplementation(async () => { throw new Error('native compilation failed') })
  const read = vi.fn()
  await expect(stageHemiComputerUse(root, environment, read)).rejects.toThrow('native compilation failed')
  expect(read).not.toHaveBeenCalled()
  expect(existsSync(output)).toBe(false)
})

it('refuses an existing helper output and missing signing keychain before starting a child', async () => {
  const { root, output } = await checkout()
  await mkdir(output)
  await writeFile(join(output, 'retained'), 'keep')
  await expect(stageHemiComputerUse(root, environment, vi.fn())).rejects.toThrow('empty native/bin')
  await expect(stageHemiComputerUse(root, { ...environment, CSC_KEYCHAIN: undefined }, vi.fn())).rejects.toThrow('scoped')
  expect(existsSync(join(output, 'retained'))).toBe(true)
  expect(child).not.toHaveBeenCalled()
})
