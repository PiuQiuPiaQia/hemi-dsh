/** Hemi identity is explicit and selects independent defaults without moving legacy data. */
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { configureHemiDesktopIdentity } from '@deepseek-ai/dsh-hemi-customizations/src/desktop-identity.ts'
import { hemiDesktopMessages, resolveHemiDesktopIdentity } from '@deepseek-ai/dsh-hemi-customizations/desktop-branding'
import { resolveDesktopLocale } from '../src/locale.ts'
import { resolveDesktopProduct } from '../scripts/desktop-product.mjs'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it.each([{ override: undefined, preferences: '' }, { override: '/explicit/home', preferences: '' },
  { override: undefined, preferences: '/explicit/preferences' }])('preserves explicit identity paths %o', async ({ override, preferences }) => {
  const root = await mkdtemp(join(tmpdir(), 'hemi-identity-'))
  roots.push(root)
  await writeFile(join(root, 'package.json'), JSON.stringify({ hemiDesktopProduct: 'hemi-dsh' }))
  const legacy = join(root, '.dsh')
  await mkdir(legacy)
  await writeFile(join(legacy, 'keep'), 'original data')
  const application = { isPackaged: true, commandLine: { getSwitchValue: () => preferences },
    getAppPath: () => root, getPath: () => root, setName: vi.fn(), setPath: vi.fn() }
  const environment = { DSH_HOME: override }
  configureHemiDesktopIdentity(application, environment, root)
  expect(application.setName).toHaveBeenCalledWith('hemi-dsh')
  if (preferences) expect(application.setPath).not.toHaveBeenCalled()
  else {
    expect(application.setPath).toHaveBeenCalledWith('userData', join(root, 'hemi-dsh'))
    expect(application.setPath).toHaveBeenCalledWith('sessionData', join(root, 'hemi-dsh'))
  }
  expect(environment.DSH_HOME).toBe(override ?? join(root, '.hemi-dsh'))
  expect(await readFile(join(legacy, 'keep'), 'utf8')).toBe('original data')
})

it('leaves unbranded packages untouched and rejects unknown fork markers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hemi-identity-'))
  roots.push(root)
  await writeFile(join(root, 'package.json'), '{}')
  const application = { isPackaged: true, commandLine: { getSwitchValue: () => '' }, getAppPath: () => root, getPath: vi.fn(), setName: vi.fn(), setPath: vi.fn() }
  const environment = {}
  expect(configureHemiDesktopIdentity(application, environment, root)).toBeUndefined()
  expect(application.getPath).not.toHaveBeenCalled()
  expect(environment).toEqual({})
  expect(() => resolveHemiDesktopIdentity(null)).toThrow('manifest object')
  expect(() => resolveHemiDesktopIdentity({ hemiDesktopProduct: 'unexpected' })).toThrow('unsupported')
})

it.each(['en', 'zh-CN', 'ja', 'es', 'fr', 'de', 'ru', 'pt'])('keeps %s wording and dictionary keys while naming the fork', (id) => {
  const original = resolveDesktopLocale(id).messages
  const messages = hemiDesktopMessages(original)
  expect(Object.keys(messages)).toEqual(Object.keys(original))
  expect(messages.aboutProduct).toBe('hemi-dsh')
  expect(messages.quitApplication).toContain('hemi-dsh')
  expect(messages.welcomeBrand).toBe('hemi-dsh')
  expect(original.aboutProduct).toBe('DeepSeek Harness')
})

it('uses matching bundle, artifact and external protocol names for the GitHub fork only', () => {
  const environment = { DSH_DESKTOP_APP_ID: 'ai.hemi.dsh.desktop', DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
    HEMI_DESKTOP_GITHUB_REPOSITORY: 'example/hemi-dsh', HEMI_DESKTOP_UPDATE_POLICY: 'disabled', HEMI_DESKTOP_SIGNING_MODE: 'community' }
  const product = resolveDesktopProduct(environment)
  const config = createElectronBuilderConfig(environment, 'darwin', 'arm64')
  expect(product.productName).toBe('hemi-dsh')
  expect(config.productName).toBe('hemi-dsh')
  expect(config.extraMetadata.hemiDesktopProduct).toBe('hemi-dsh')
  expect(config.protocols).toEqual([{ name: 'hemi-dsh', schemes: ['hemi-dsh'] }])
  expect(config.artifactName).toMatch(/^hemi-dsh-/)
  expect(resolveDesktopProduct({}).productName).toBe('DeepSeek Harness')
})
