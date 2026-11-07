/** Hemi's shipped Client roster keeps skins while replacing product artwork and unused upstream controls. */
import { mkdir, mkdtemp } from 'node:fs/promises'
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

async function openHemiWorkspace() {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: fileURLToPath(new URL('./hemi-branding.overlay.yml', import.meta.url)),
  })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1280, height: 820 } })
  await page.addInitScript('globalThis.dshDesktop = { protocolVersion: 1 }')
  const tripwire = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  return { scaffold, page, tripwire }
}

it('keeps Hemi branding with skins and hides upstream controls', async () => {
  const { scaffold, page, tripwire } = await openHemiWorkspace()
  expect(scaffold.ctx.get('messageFeedback')).toBeUndefined()
  expect(scaffold.ctx.get('sessionFeedback')).toBeUndefined()
  expect(scaffold.ctx.get('sessionLogDeepSeek')).toBeUndefined()
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
  await mkdir('.artifacts', { recursive: true })
  const screenshots = await mkdtemp('.artifacts/hemi-branding-')
  console.log(`Hemi branding screenshots: ${screenshots}`)
  for (const dark of [false, true]) {
    await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' })
    await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(dark)
    expect(await edition.evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgb(0, 0, 0)')
    expect(await edition.evaluate(node => getComputedStyle(node).color)).toBe('rgb(255, 255, 255)')
    const tagSize = await edition.evaluate(node => ({
      transform: getComputedStyle(node).transform,
      width: node.getBoundingClientRect().width,
      height: node.getBoundingClientRect().height,
      bottomGap: node.parentElement!.getBoundingClientRect().bottom - node.getBoundingClientRect().bottom,
    }))
    expect(tagSize.transform).toBe('matrix(0.5, 0, 0, 0.5, 0, 0)')
    expect(tagSize.width).toBeLessThan(20)
    expect(tagSize.height).toBeLessThanOrEqual(11)
    expect(tagSize.bottomGap).toBeCloseTo(0, 2)
    await page.screenshot({ path: `${screenshots}/workspace-${dark ? 'dark' : 'light'}.png`, animations: 'disabled' })
  }
  await page.getByRole('button', { name: '收起侧边栏', exact: true }).click()
  const expand = page.getByRole('button', { name: '打开侧边栏', exact: true })
  await expand.waitFor()
  await expect.poll(() => expand.locator('svg').evaluate(node => getComputedStyle(node).display)).not.toBe('none')
  await expand.click()
  await sidebarName.waitFor()
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

it('renders a text-only running status with a live clock', async () => {
  const { scaffold, page, tripwire } = await openHemiWorkspace()
  await mkdir('.artifacts', { recursive: true })
  const screenshots = await mkdtemp('.artifacts/hemi-running-')
  console.log(`Hemi running screenshots: ${screenshots}`)
  const lead = scaffold.ctx.agents.list().find(agent => agent.session.header.origin !== 'subagent')
  if (lead === undefined) throw new Error('Missing Hemi workspace session')
  const response = Promise.withResolvers<ReturnType<typeof textResponse>>()
  scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter(['hemi-brand-test'], new BrandingAdapter([() => response.promise])))
  await scaffold.ctx.sessionController.selectModel({ sessionId: lead.id, provider: 'hemi-brand-test', model: 'local' })
  const settled = scaffold.whenTurnSettled()
  try {
    const composer = page.locator('[data-composer-input]').first()
    await composer.fill('Show the running status.')
    await composer.press('Enter')
    const running = page.locator('[data-chat-running]')
    await running.waitFor()
    const label = running.locator('[data-shimmer]')
    await expect.poll(() => label.innerText()).toMatch(/^深度求索中，用时 .+ ···$/)
    expect(await running.getByRole('status').textContent()).toBe('深度求索中')
    expect(await running.locator('[data-slot="conversation.chat.running.mark"]').innerHTML()).toBe('')
    expect(await running.locator('svg, img, [data-hemi-brand-mark]').count()).toBe(0)
    const initialLabel = await label.innerText()
    // Two one-second ticks separate the clamped initial label from its first visible change.
    await expect.poll(() => label.innerText(), { timeout: 5_000 }).not.toBe(initialLabel)
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 820 })
      for (const dark of [false, true]) {
        await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' })
        await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(dark)
        expect(await label.evaluate((node) => {
          const text = node.getBoundingClientRect()
          const content = node.parentElement!.getBoundingClientRect()
          return { inset: text.left - content.left, insideViewport: text.left >= 0 && text.right <= innerWidth }
        })).toEqual({ inset: 0, insideViewport: true })
        await page.screenshot({
          path: `${screenshots}/running-${width}-${dark ? 'dark' : 'light'}.png`, animations: 'disabled',
        })
      }
    }
  } finally {
    response.resolve(textResponse('Hemi is ready.'))
  }
  await settled
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})
