/** Original third-party bundles over the managed Desktop composition, without registry installation or a public tunnel. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FiberState } from '@deepseek-ai/cordis'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole, webSnapshotMode,
} from './scaffold.ts'
import { openSettings, ZH_BROWSER_LOCALE } from './support.ts'

const EXPECTED = fileURLToPath(new URL('./expected/hemi-preinstalled-plugins/', import.meta.url))
const HISTORY = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const PACKAGES = ['dsh-pocket', 'dsh-mnemon'] as const

it('loads the original preinstalled bundles and keeps their bundled switches available without installation', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'hemi-preinstalled-'))
  onTestFinished(() => rm(scratch, { recursive: true, force: true }))
  const overlay = join(scratch, 'desktop.patch.yml')
  // The upstream proxy accepts port 0, so the OS owns allocation rather than a shared CI port.
  await writeFile(overlay, '- id: dsh-pocket\n  config:\n    port: 0\n- id: hemi-model-settings\n  config:\n    desktopStartup: false\n'
    + '- id: ui-settings-account\n  config:\n    showLauncher: false\n')
  const scaffold = await launchWebScaffold({
    developerTools: false, extraOverlayPath: overlay,
    profile: { name: 'desktop', packages: [], bundles: PACKAGES, hmr: false },
  })
  onTestFinished(() => scaffold.close())
  const inventory = await scaffold.ctx.pluginManager.listBundles()
  for (const name of PACKAGES) {
    expect(inventory.find(bundle => bundle.name === name)).toMatchObject({
      availability: 'installation', installed: false, official: false, enabled: true, removable: false, updatable: false,
    })
  }
  const originalHistory = await readFile(HISTORY, 'utf8')
  await seedSession(scaffold, originalHistory, 'preinstalled-history')
  const response = await scaffold.hostFetch('/dsh-pocket/pocket.status', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rpcId: 'preinstalled-status', method: 'pocket.status', payload: {} }),
  })
  expect(response.status).toBe(200)
  const status = await response.json() as { result: { ok: boolean; value: { tunnelRunning: boolean; tunnelUrl: string | null } } }
  expect({ ok: status.result.ok, running: status.result.value.tunnelRunning, url: status.result.value.tunnelUrl })
    .toEqual({ ok: true, running: false, url: null })

  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1280, height: 820 }, reducedMotion: 'reduce' })
  const tripwire = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const group = page.locator('[data-row-key^="workspace:"]').filter({ hasText: '未分组' })
  await group.waitFor()
  if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
  await page.locator('[data-row-key="session:preinstalled-history"]').click()
  await page.getByText('DONE', { exact: true }).waitFor()
  await openSettings(page, 'zh')
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  expect(await settings.getByRole('button', { name: '手机访问', exact: true }).count()).toBe(1)
  expect(await settings.getByRole('button', { name: '手机连接', exact: true }).count()).toBe(0)
  await page.keyboard.press('Escape')
  await settings.waitFor({ state: 'hidden' })
  await page.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '插件', exact: true }).click()
  const panel = page.locator('[data-plugin-panel]')
  await mkdir(EXPECTED, { recursive: true })
  const screenshots = await mkdtemp(join(tmpdir(), 'hemi-preinstalled-ui-'))
  console.log(`Preinstalled plugin screenshots: ${screenshots}`)
  for (const name of PACKAGES) {
    const selector = `[data-plugin-package="${name}"]`
    const card = panel.locator(selector)
    await card.waitFor()
    expect(await card.getByRole('switch').count()).toBe(1)
    expect(await card.getByRole('switch').isEnabled()).toBe(true)
    await compareOrRefreshGolden(join(EXPECTED, `${name}.expected.md`),
      await captureStableAria(page, selector, scaffold.workspaceCwd), webSnapshotMode())
  }
  await panel.locator('[data-plugin-package="dsh-pocket"]').scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(screenshots, 'plugins-light.png'), animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(true)
  await page.screenshot({ path: join(screenshots, 'plugins-dark.png'), animations: 'disabled' })
  await page.setViewportSize({ width: 390, height: 844 })
  await panel.locator('[data-plugin-package="dsh-pocket"]').scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(screenshots, 'plugins-390.png'), animations: 'disabled' })
  expect(tripwire.pageErrors).toEqual([])
  expect(await readFile(HISTORY, 'utf8')).toBe(originalHistory)
})

it('loads the preinstalled Browser bundle without setup', async () => {
  const bundleName = 'dsh-native-browser'
  const scratch = await mkdtemp(join(tmpdir(), 'hemi-preinstalled-browser-'))
  onTestFinished(() => rm(scratch, { recursive: true, force: true }))
  const harnessHome = join(scratch, 'home')
  // The scaffold stores its process overlay under profiles/scaffold even for the Desktop profile.
  await mkdir(join(harnessHome, 'profiles', 'scaffold'), { recursive: true })
  const overlay = join(scratch, 'desktop.patch.yml')
  await writeFile(overlay, [
    '- id: hemi-model-settings',
    '  config:',
    '    desktopStartup: false',
    '- id: native-browser',
    '  config:',
    `    runtimeDirectory: ${JSON.stringify(join(scratch, 'browser'))}`,
    '',
  ].join('\n'))
  const scaffold = await launchWebScaffold({
    developerTools: false, extraOverlayPath: overlay, harnessHome,
    profile: { name: 'desktop', packages: [], bundles: [bundleName], hmr: false },
  })
  onTestFinished(() => scaffold.close())
  const bundle = (await scaffold.ctx.pluginManager.listBundles()).find(candidate => candidate.name === bundleName)
  expect(bundle).toMatchObject({
    availability: 'installation', installed: false, official: false, enabled: true, removable: false,
  })
  expect(bundle).not.toHaveProperty('update')
  const host = [...scaffold.ctx.loader.entries()].find(entry => entry.options.id === 'native-browser')
  expect(host?.fiber?.state).toBe(FiberState.ACTIVE)

  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1280, height: 820 }, reducedMotion: 'reduce' })
  const tripwire = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const sidebar = page.getByRole('navigation', { name: '全局面板' })
  // Opening Browser would read Chrome's native-host manifest outside the test runtime directory.
  await sidebar.getByRole('button', { name: '浏览器', exact: true }).waitFor()
  await sidebar.getByRole('button', { name: '插件', exact: true }).click()
  const selector = `[data-plugin-package="${bundleName}"]`
  const card = page.locator('[data-plugin-panel]').locator(selector)
  await card.waitFor()
  expect(await card.getByRole('switch').isEnabled()).toBe(true)
  await compareOrRefreshGolden(join(EXPECTED, `${bundleName}.expected.md`),
    await captureStableAria(page, selector, scaffold.workspaceCwd), webSnapshotMode())
  expect(tripwire.pageErrors).toEqual([])
})
