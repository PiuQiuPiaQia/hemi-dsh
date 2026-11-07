/** Hemi's shipped Client roster keeps skins while replacing product artwork and unused upstream controls. */
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { readClientBuildRecord } from '../../../scripts/client-build-environment.ts'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { ZH_BROWSER_LOCALE, connectFreshWorkspaceZh } from './support.ts'
import { ScriptedAdapter, textResponse } from '../../../packages/hemi/routing/tests/mock-llm.ts'

/** Local, declared model for observing the running presentation without external inference. */
class BrandingAdapter extends ScriptedAdapter {
  override providerInfo() { return { id: 'hemi-brand-test', name: 'Hemi brand test' } }
  override async listModels() { return [{ provider: 'hemi-brand-test', id: 'local', name: 'Local' }] }
}

it('renders monochrome Hemi marks with skins and hides upstream feedback and upload controls', async () => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: fileURLToPath(new URL('./hemi-branding.overlay.yml', import.meta.url)),
  })
  onTestFinished(() => scaffold.close())
  expect(scaffold.ctx.get('messageFeedback')).toBeUndefined()
  expect(scaffold.ctx.get('sessionFeedback')).toBeUndefined()
  expect(scaffold.ctx.get('sessionLogDeepSeek')).toBeUndefined()
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1280, height: 820 } })
  await page.addInitScript('globalThis.dshDesktop = { protocolVersion: 1 }')
  const tripwire = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  const sidebarName = page.locator('[data-hemi-sidebar-name]')
  await sidebarName.waitFor()
  const edition = sidebarName.getByText('dsh', { exact: true })
  expect(await sidebarName.textContent()).toBe('Hemidsh')
  expect(await page.locator('[data-slot="sidebar.brand.mark"]').isVisible()).toBe(false)
  expect(await page.locator('[data-slot="sidebar.brand.mark"] [data-hemi-brand-mark]').count()).toBe(0)
  expect(await page.locator('[data-slot="conversation.hero.brand.mark"] [data-hemi-brand-mark]').count()).toBe(1)
  expect(await page.getByText('DeepSeek Harness', { exact: true }).count()).toBe(0)
  const manifest: unknown = JSON.parse(await page.evaluate(async () => (await fetch('/manifest.webmanifest')).text()))
  const build = readClientBuildRecord(fileURLToPath(new URL('../../..', import.meta.url)))
  const packagedAsHemi = build.environment.DSH_CLIENT_TITLE === 'Hemi'
  expect(manifest).toMatchObject(packagedAsHemi
    ? { name: 'Hemi', short_name: 'Hemi' }
    : { name: 'DeepSeek Harness', short_name: 'DSH' })
  await mkdir('.artifacts/hemi-branding', { recursive: true })
  for (const dark of [false, true]) {
    await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' })
    await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(dark)
    expect(await edition.evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgb(0, 0, 0)')
    expect(await edition.evaluate(node => getComputedStyle(node).color)).toBe('rgb(255, 255, 255)')
    await page.screenshot({ path: `.artifacts/hemi-branding/workspace-${dark ? 'dark' : 'light'}.png`, animations: 'disabled' })
  }
  await page.getByRole('button', { name: '收起侧边栏', exact: true }).click()
  const expand = page.getByRole('button', { name: '打开侧边栏', exact: true })
  await expand.waitFor()
  await expect.poll(() => expand.locator('svg').evaluate(node => getComputedStyle(node).display)).not.toBe('none')
  await expand.click()
  await sidebarName.waitFor()
  const lead = scaffold.ctx.agents.list().find(agent => agent.session.header.origin !== 'subagent')
  if (lead === undefined) throw new Error('Missing Hemi workspace session')
  const response = Promise.withResolvers<ReturnType<typeof textResponse>>()
  scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter(['hemi-brand-test'], new BrandingAdapter([() => response.promise])))
  await scaffold.ctx.sessionController.selectModel({ sessionId: lead.id, provider: 'hemi-brand-test', model: 'local' })
  const settled = scaffold.whenTurnSettled()
  try {
    const composer = page.locator('[data-composer-input]').first()
    await composer.fill('Show the Hemi running mark.')
    await composer.press('Enter')
    await page.locator('[data-chat-running] [data-hemi-brand-mark]').waitFor()
    expect(await page.locator('[data-chat-running] svg').count()).toBe(0)
    await page.screenshot({ path: '.artifacts/hemi-branding/running-dark.png', animations: 'disabled' })
  } finally {
    response.resolve(textResponse('Hemi is ready.'))
  }
  await settled
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.waitFor()
  expect(await settings.getByText('帮助改进 DeepSeek 模型与产品', { exact: true }).count()).toBe(0)
  await settings.getByRole('button', { name: '皮肤', exact: true }).click()
  const skinSection = settings.getByRole('region', { name: '皮肤', exact: true })
  await skinSection.getByRole('heading', { name: '皮肤', level: 2, exact: true }).waitFor()
  const skins = skinSection.locator('button[aria-pressed]')
  await skins.first().waitFor()
  expect(await skins.count()).toBe(6)
  const presetRects = await skins.evaluateAll(nodes => nodes.map((node) => {
    const { width, top } = node.getBoundingClientRect()
    return { width, top }
  }))
  expect(new Set(presetRects.map(rect => Math.round(rect.width))).size).toBe(1)
  expect(new Set(presetRects.map(rect => rect.top)).size).toBe(2)
  await skins.nth(1).click()
  expect(await skins.nth(1).getAttribute('aria-pressed')).toBe('true')
  expect(await page.evaluate(() => localStorage.getItem('hemi-skin'))).toBeTruthy()
  await mkdir(fileURLToPath(new URL('./expected/hemi-branding/', import.meta.url)), { recursive: true })
  await compareOrRefreshGolden(fileURLToPath(new URL('./expected/hemi-branding/skins.expected.md', import.meta.url)),
    await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})
