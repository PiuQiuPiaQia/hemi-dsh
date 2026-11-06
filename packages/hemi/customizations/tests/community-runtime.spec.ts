/** Fixed native signing retains entitlements and releases private temporary plist files after every child outcome. */
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createHemiMacRuntimeSigner, hemiMacRequirement, resolveHemiCommunitySigning } from '../release/signing.mjs'

const { child, verify } = vi.hoisted(() => ({
  child: vi.fn<(command: string, args: string[]) => Promise<void>>(),
  verify: vi.fn<(command: string, args: string[]) => string>(() => ''),
}))
vi.mock('execa', () => ({ execa: child }))
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), execFileSync: verify,
}))
const roots: string[] = []
const signing = resolveHemiCommunitySigning({ DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
  HEMI_DESKTOP_GITHUB_REPOSITORY: 'example/hemi-dsh', HEMI_DESKTOP_SIGNING_MODE: 'community' }, 'darwin')
if (signing?.kind !== 'mac-self-signed') throw new Error('expected fixed certificate')
const policy = createHemiMacRuntimeSigner(signing, '/fixture/keychain')

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hemi-runtime-signing-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  vi.clearAllMocks()
  child.mockReset()
  verify.mockImplementation(() => '')
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it.each([false, true])('cleans merged entitlements after a child failure of %s', async (failure) => {
  const root = await directory()
  const original = join(root, 'jit.plist')
  await writeFile(original, '<plist><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/></dict></plist>')
  let temporary = ''
  child.mockImplementation(async (_command, args) => {
    const path = args[args.indexOf('--entitlements') + 1]!
    temporary = dirname(path)
    const contents = readFileSync(path, 'utf8')
    for (const key of ['allow-jit', 'allow-unsigned-executable-memory', 'disable-library-validation']) {
      expect(contents).toMatch(new RegExp(`<key>com\\.apple\\.security\\.cs\\.${key}</key>\\s*<true\\s*/>`))
    }
    expect(args).toContain(signing.identity)
    expect(args).toContain('--timestamp=none')
    if (failure) throw new Error('fixture signer failed')
  })
  const result = policy.signFile(join(root, 'runtime'), 'ai.hemi.runtime.probe', original)
  if (failure) await expect(result).rejects.toThrow('fixed-certificate native signing failed')
  else await expect(result).resolves.toBeUndefined()
  expect(temporary).not.toBe('')
  expect(existsSync(temporary)).toBe(false)
  expect(existsSync(original)).toBe(true)
  expect(verify).toHaveBeenCalledTimes(failure ? 0 : 1)
})

it.each(['<array><string>invalid</string></array>', '<date>2026-11-06T00:00:00Z</date>'])('rejects non-dictionary entitlements %s before starting a signer', async (value) => {
  const root = await directory()
  const invalid = join(root, 'invalid.plist')
  await writeFile(invalid, `<plist>${value}</plist>`)
  await expect(policy.signFile(join(root, 'runtime'), 'ai.hemi.runtime.probe', invalid)).rejects.toThrow('plist dictionary')
  expect(child).not.toHaveBeenCalled()
})

it('verifies a sealed helper with its own bundle identifier and the fixed certificate', async () => {
  const application = await directory()
  await mkdir(join(application, 'Contents'))
  await writeFile(join(application, 'Contents/Info.plist'), '<plist><dict><key>CFBundleIdentifier</key><string>com.example.helper</string></dict></plist>')
  const requirement = hemiMacRequirement('com.example.helper', signing.identity)
  verify.mockImplementation((_command, args) => args[0] === '--display' ? `designated => ${requirement}\n` : '')
  policy.verifyApplication(application)
  expect(verify.mock.calls[0]![1]).toContain('--deep')
  expect(verify.mock.calls[0]![1]).toContain('--all-architectures')
})
