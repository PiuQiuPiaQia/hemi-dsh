/** Hemi fork: fixed self-signing must retain update sources and leave DSH commercial signing requirements intact. */
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { createHemiMacRuntimeSigner, resolveHemiCommunitySigning, hemiMacRequirement, verifyHemiMacApplication } from '@deepseek-ai/dsh-hemi-customizations/github-community-signing'
import { setupHemiCommunitySigning, cleanupHemiCommunitySigning } from '@deepseek-ai/dsh-hemi-customizations/github-community-setup'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'
import { loadDesktopPackageEnvironment, validateDesktopPackageEnvironment } from '../scripts/desktop-package-environment.mjs'
import { withMacOSSigningKeychain } from '../scripts/macos-signing-keychain.mjs'

const roots: string[] = []
const COMMUNITY = { DSH_DESKTOP_APP_ID: 'ai.hemi.dsh.desktop', DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
  HEMI_DESKTOP_GITHUB_REPOSITORY: 'example/hemi-dsh', HEMI_DESKTOP_UPDATE_POLICY: 'disabled', HEMI_DESKTOP_SIGNING_MODE: 'community' }

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'hemi-community-'))
  roots.push(path)
  return path
}

afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

it('uses one committed public certificate and refuses implicit or partial community modes', () => {
  expect(resolveHemiCommunitySigning({}, 'darwin')).toBeUndefined()
  expect(() => resolveHemiCommunitySigning({ HEMI_DESKTOP_SIGNING_MODE: 'community' }, 'darwin')).toThrow('GitHub')
  expect(() => resolveHemiCommunitySigning({ ...COMMUNITY, HEMI_DESKTOP_SIGNING_MODE: 'ad-hoc' }, 'darwin')).toThrow()
  expect(() => resolveHemiCommunitySigning({ ...COMMUNITY, DSH_DESKTOP_UNSIGNED: '1' }, 'darwin')).toThrow('debug mode')
  const signing = resolveHemiCommunitySigning(COMMUNITY, 'darwin')
  if (signing?.kind !== 'mac-self-signed') throw new Error('expected fixed certificate')
  expect(() => createHemiMacRuntimeSigner(signing, undefined)).toThrow('scoped signing keychain')
  const certificate = new X509Certificate(readFileSync(signing.certificate))
  expect(signing.sha256).toBe(certificate.fingerprint256.replaceAll(':', '').toLowerCase())
  expect(hemiMacRequirement('ai.hemi.dsh.desktop', signing.identity)).toContain('certificate leaf = H"')
  expect(resolveHemiCommunitySigning(COMMUNITY, 'win32')).toEqual({ kind: 'windows-unsigned' })
})

it('requires a certificate-bound designated requirement and checks every nested architecture', () => {
  const signing = resolveHemiCommunitySigning(COMMUNITY, 'darwin')
  if (signing?.kind !== 'mac-self-signed') throw new Error('expected fixed certificate')
  const requirement = hemiMacRequirement('ai.hemi.dsh.desktop', signing.identity)
  const calls: string[][] = []
  verifyHemiMacApplication('/fixture/App.app', signing, 'ai.hemi.dsh.desktop', (_command, args) => {
    calls.push(args)
    return args[0] === '--display' ? `designated => ${requirement}\n` : ''
  })
  expect(calls[0]).toContain('--deep')
  expect(calls[0]).toContain('--all-architectures')
  expect(() => {
    verifyHemiMacApplication('/fixture/App.app', signing, 'ai.hemi.dsh.desktop', () => 'designated => cdhash H"bad"\n')
  })
    .toThrow('fixed certificate')
})

it('builds update-enabled Mac packages with a mandatory custom signer and no notary credentials', () => {
  const config = createElectronBuilderConfig(COMMUNITY, 'darwin', 'arm64')
  expect(typeof config.mac.sign).toBe('function')
  expect(config.mac.forceCodeSigning).toBe(true)
  expect(config.mac.notarize).toBe(false)
  expect(config.mac.target).toEqual(['dmg', 'zip'])
  expect(config.publish?.[0]?.url).toContain('raw.githubusercontent.com/example/hemi-dsh/')
  expect(config.extraMetadata.hemiDesktopSigning).toBe('mac-self-signed')
  expect(() => createElectronBuilderConfig({ ...COMMUNITY, HEMI_DESKTOP_SIGNING_MODE: undefined }, 'darwin', 'arm64')).toThrow()
})

it('builds update-enabled Windows packages without EV hardware only in explicit community mode', () => {
  const config = createElectronBuilderConfig(COMMUNITY, 'win32', 'x64')
  expect(config.win.forceCodeSigning).toBe(false)
  expect(config.win.verifyUpdateCodeSignature).toBe(false)
  expect(config.win.signtoolOptions.sign).toBeUndefined()
  expect(config.publish?.[0]?.url).toContain('raw.githubusercontent.com/example/hemi-dsh/')
  expect(config.extraMetadata.hemiDesktopSigning).toBe('windows-unsigned')
  expect(() => createElectronBuilderConfig({ ...COMMUNITY, HEMI_DESKTOP_SIGNING_MODE: undefined }, 'win32', 'x64')).toThrow()
})

it('validates community configuration without requiring Developer ID, notarization or a Windows token', async () => {
  const root = await directory()
  const certificate = join(root, 'dummy-test-only.p12')
  await writeFile(certificate, 'inert configuration fixture')
  const mac = { ...COMMUNITY, CSC_LINK: certificate, CSC_KEY_PASSWORD: 'test-only' }
  expect(() => { validateDesktopPackageEnvironment(mac, { platform: 'darwin', arch: 'arm64' }) }).not.toThrow()
  expect(() => { validateDesktopPackageEnvironment(COMMUNITY, { platform: 'win32', arch: 'x64' }) }).not.toThrow()
  expect(() => { validateDesktopPackageEnvironment({ ...mac, CSC_KEY_PASSWORD: undefined }, { platform: 'darwin', arch: 'arm64' }) }).toThrow('CSC_KEY_PASSWORD')
})

it('does not read Windows signing secrets in a community preset', async () => {
  const root = await directory()
  await mkdir(join(root, 'presets'))
  await writeFile(join(root, 'presets/production.env'), Object.entries(COMMUNITY).map(([name, value]) => `${name}=${value}`).join('\n') + '\n')
  const selected = loadDesktopPackageEnvironment('win32', { DSH_PACKAGING_PRESET: 'production', DSH_PACKAGING_CONFIG_DIR: root }, root)
  expect(selected.HEMI_DESKTOP_SIGNING_MODE).toBe('community')
  expect(selected.DSH_DESKTOP_WINDOWS_TOKEN_PIN).toBeUndefined()
})

it('uses the pinned key in an owned temporary keychain and never changes certificate trust', async () => {
  const signing = resolveHemiCommunitySigning(COMMUNITY, 'darwin')
  if (signing?.kind !== 'mac-self-signed') throw new Error('expected fixed certificate')
  const calls: { command: string; args: string[] }[] = []
  await withMacOSSigningKeychain({ ...COMMUNITY, CSC_LINK: '/fixture/key.p12', CSC_KEY_PASSWORD: 'test-only' }, async (environment) => {
    expect(environment.CSC_KEY_PASSWORD).toBeUndefined()
    expect(environment.CSC_KEYCHAIN).toContain('signing.keychain-db')
  }, (command, args) => {
    calls.push({ command, args })
    return args[0] === 'list-keychains' && args.length === 3 ? '"/fixture/login.keychain-db"\n' : ''
  })
  const probe = calls.find(call => call.command === '/usr/bin/codesign' && call.args[0] === '--force')!
  expect(probe.args).toContain(signing.identity)
  expect(probe.args).toContain('--timestamp=none')
  expect(calls.some(call => call.args.includes('add-trusted-cert'))).toBe(false)
  expect(calls.at(-1)?.args[0]).toBe('delete-keychain')
})

it('prepares and cleans only owned hosted-runner signing inputs; Windows needs no certificate secret', async () => {
  const root = await directory()
  const environment = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_TEMP: root,
    GITHUB_REPOSITORY: 'example/hemi-dsh' }
  expect(() => setupHemiCommunitySigning(environment, 'mac-arm64')).toThrow('HEMI_MAC_SIGNING_P12')
  const configured = setupHemiCommunitySigning(environment, 'win-x64')
  expect(await readFile(join(configured, 'presets/production.env'), 'utf8')).toContain('HEMI_DESKTOP_SIGNING_MODE=community')
  expect(() => setupHemiCommunitySigning(environment, 'win-x64')).toThrow('fresh')
  await writeFile(join(configured, '.hemi-community-signing'), 'not-owned')
  expect(() => { cleanupHemiCommunitySigning(environment, 'win-x64') }).toThrow('unowned')
  await writeFile(join(configured, '.hemi-community-signing'), '1\n')
  cleanupHemiCommunitySigning(environment, 'win-x64')
  await expect(readFile(join(configured, '.hemi-community-signing'))).rejects.toThrow()
  expect(() => setupHemiCommunitySigning({ ...environment, RUNNER_ENVIRONMENT: 'self-hosted' }, 'win-x64')).toThrow('disposable')
})

it('loads a generated Mac preset with its private input paths resolved relative to the secrets file', async () => {
  const root = await directory()
  const configured = setupHemiCommunitySigning({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_TEMP: root,
    GITHUB_REPOSITORY: 'example/hemi-dsh', HEMI_MAC_SIGNING_P12: Buffer.from('inert p12 fixture').toString('base64'),
    HEMI_MAC_SIGNING_PASSWORD: 'fixture-password' }, 'mac-arm64')
  const selected = loadDesktopPackageEnvironment('darwin', { DSH_PACKAGING_PRESET: 'production', DSH_PACKAGING_CONFIG_DIR: configured }, root)
  expect(selected.CSC_LINK).toBe(join(configured, 'secrets/identity.p12'))
  expect(selected.CSC_KEY_PASSWORD).toBe('fixture-password')
  expect(await readFile(selected.CSC_LINK!, 'utf8')).toBe('inert p12 fixture')
  expect(() => { validateDesktopPackageEnvironment(selected, { platform: 'darwin', arch: 'arm64' }) }).not.toThrow()
})
