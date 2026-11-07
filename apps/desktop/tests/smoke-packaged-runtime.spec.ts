/** Hemi fork: the packaged-runtime smoke keeps artifact-directory selection separate from the Windows signing policy. */
import { sep } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { smokePackagedRuntime } from '../scripts/smoke-packaged-runtime.ts'
import { verifyWindowsCode } from '../scripts/windows-runtime-signature.mjs'
import { smokePreparedRuntime } from '../scripts/smoke-prepared-runtime.ts'
import { verifyDesktopRuntime } from '../src/runtime-tree.ts'

vi.mock('../scripts/package-target.ts', () => ({ resolveDesktopPackageTarget: vi.fn() }))
vi.mock('../src/runtime-tree.ts', () => ({
  readDesktopRuntime: vi.fn(() => ({ release: { version: '0.2.2-alpha.3' } })),
  verifyDesktopRuntime: vi.fn(async () => ({ platform: 'win32', arch: 'x64' })),
}))
vi.mock('../scripts/windows-runtime-signature.mjs', () => ({ verifyWindowsCode: vi.fn() }))
vi.mock('../scripts/smoke-prepared-runtime.ts', () => ({ smokePreparedRuntime: vi.fn() }))

const portable = (path: string): string => path.split(sep).join('/')
const release = { unsigned: false, skipNotarization: false } as const
const COMMUNITY_WINDOWS = { DSH_DESKTOP_TARGET_PLATFORM: 'win32', DSH_DESKTOP_TARGET_ARCH: 'x64',
  DSH_DESKTOP_APP_ID: 'ai.hemi.dsh.desktop', DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
  HEMI_DESKTOP_GITHUB_REPOSITORY: 'example/hemi-dsh', HEMI_DESKTOP_SIGNING_MODE: 'community' }
const SIGNED_WINDOWS = { DSH_DESKTOP_TARGET_PLATFORM: 'win32', DSH_DESKTOP_TARGET_ARCH: 'x64',
  DSH_DESKTOP_APP_ID: 'com.example.test', DSH_DESKTOP_AUTO_UPDATE_ENV: 'test' }

afterEach(() => vi.clearAllMocks())

it('smokes a community Windows release from the release artifacts without requiring Authenticode', async () => {
  await smokePackagedRuntime(release, COMMUNITY_WINDOWS)
  expect(verifyWindowsCode).not.toHaveBeenCalled()
  expect(verifyDesktopRuntime).toHaveBeenCalledOnce()
  expect(smokePreparedRuntime).toHaveBeenCalledOnce()
  const [root, node, runtime] = vi.mocked(smokePreparedRuntime).mock.calls[0]!
  expect(portable(root)).toMatch(/win-x64\/artifacts\/win-unpacked\/resources\/app\.asar\/dsh$/)
  expect(portable(node)).toMatch(/win-x64\/artifacts\/win-unpacked\/Hemi\.exe$/)
  expect(portable(runtime)).toMatch(/win-x64\/artifacts\/win-unpacked\/resources\/runtime$/)
})

it('verifies Authenticode on the release artifacts before smoking a formally signed Windows build', async () => {
  await smokePackagedRuntime(release, SIGNED_WINDOWS)
  expect(verifyWindowsCode).toHaveBeenCalledOnce()
  expect(portable(vi.mocked(verifyWindowsCode).mock.calls[0]![0])).toMatch(/win-x64\/artifacts\/win-unpacked$/)
  expect(smokePreparedRuntime).toHaveBeenCalledOnce()
  const [root] = vi.mocked(smokePreparedRuntime).mock.calls[0]!
  expect(portable(root)).toMatch(/win-x64\/artifacts\/win-unpacked\/resources\/app\.asar\/dsh$/)
})

it('keeps explicit --unsigned debug builds on unsigned-artifacts without Authenticode', async () => {
  await smokePackagedRuntime({ unsigned: true, skipNotarization: false }, SIGNED_WINDOWS)
  expect(verifyWindowsCode).not.toHaveBeenCalled()
  expect(smokePreparedRuntime).toHaveBeenCalledOnce()
  const [root] = vi.mocked(smokePreparedRuntime).mock.calls[0]!
  expect(portable(root)).toMatch(/win-x64\/unsigned-artifacts\/win-unpacked\/resources\/app\.asar\/dsh$/)
})

it('rejects a signed release and skips its payload smoke when Windows verification fails', async () => {
  vi.mocked(verifyWindowsCode).mockRejectedValueOnce(new Error('refusing NotSigned signature'))
  await expect(smokePackagedRuntime(release, SIGNED_WINDOWS)).rejects.toThrow('refusing NotSigned signature')
  expect(smokePreparedRuntime).not.toHaveBeenCalled()
})
