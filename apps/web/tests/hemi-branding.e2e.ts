/** Hemi's shipped Client roster keeps skins while replacing product artwork and unused upstream controls. */
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { readClientBuildRecord } from '../../../scripts/client-build-environment.ts'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  seedSession, watchConsole, webSnapshotMode,
} from './scaffold.ts'
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
    const presentation = await edition.evaluate((node) => {
      const suffix = getComputedStyle(node)
      const name = getComputedStyle(node.parentElement!)
      return {
        transform: suffix.transform,
        background: suffix.backgroundColor,
        borderWidth: suffix.borderWidth,
        padding: suffix.padding,
        fontSize: suffix.fontSize,
        lineHeight: suffix.lineHeight,
        fontWeight: suffix.fontWeight,
        nameSize: name.fontSize,
        nameWeight: name.fontWeight,
        alignment: name.alignItems,
        gap: name.columnGap,
        secondaryColor: suffix.color !== name.color,
        height: node.getBoundingClientRect().height,
      }
    })
    expect(presentation).toEqual({
      transform: 'none', background: 'rgba(0, 0, 0, 0)', borderWidth: '0px', padding: '0px',
      fontSize: '11px', lineHeight: '14px', fontWeight: '400', nameSize: '18px', nameWeight: '500',
      alignment: 'baseline', gap: '6px', secondaryColor: true, height: 14,
    })
    await page.screenshot({ path: `${screenshots}/workspace-${dark ? 'dark' : 'light'}.png`, animations: 'disabled' })
  }
  await page.getByRole('button', { name: '收起侧边栏', exact: true }).click()
  const expand = page.getByRole('button', { name: '打开侧边栏', exact: true })
  await expand.waitFor()
  await expect.poll(() => expand.locator('svg').evaluate(node => getComputedStyle(node).display)).not.toBe('none')
  await expand.click()
  await sidebarName.waitFor()
  await page.setViewportSize({ width: 390, height: 820 })
  await page.locator('[data-sidebar-opener]').click()
  await sidebarName.waitFor({ state: 'visible' })
  for (const dark of [false, true]) {
    await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' })
    await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(dark)
    expect(await sidebarName.evaluate((node) => {
      const rect = node.getBoundingClientRect()
      return rect.left >= 0 && rect.right <= innerWidth
    })).toBe(true)
    expect(await edition.evaluate(node => getComputedStyle(node).fontSize)).toBe('11px')
    await page.screenshot({ path: `${screenshots}/workspace-390-${dark ? 'dark' : 'light'}.png`, animations: 'disabled' })
  }
  await page.setViewportSize({ width: 1280, height: 820 })
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

it.skipIf(webSnapshotMode() === 'record')('defaults to monochrome in both schemes and preserves explicit skin choices', async () => {
  const mode = webSnapshotMode()
  const dir = fileURLToPath(new URL('../../../snapshots/web/hemi-default-skin/', import.meta.url))
  const scaffold = await launchWebScaffold({
    extraOverlayPath: fileURLToPath(new URL('./hemi-branding.overlay.yml', import.meta.url)),
  })
  const resources: { browser?: Browser } = {}
  onTestFinished(async () => {
    try { await resources.browser?.close() } finally { await scaffold.close() }
  })
  await seedSession(scaffold, await readFile(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url), 'utf8'), 'hemi-default-skin')
  const browser = await chromium.launch()
  resources.browser = browser
  const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1280, height: 820 }, colorScheme: 'light' })
  await page.addInitScript('globalThis.dshDesktop = { protocolVersion: 1 }')
  const tripwire = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const group = page.getByRole('treeitem').first()
  await group.waitFor()
  if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
  await page.getByRole('treeitem').nth(1).click()
  await page.getByText('DONE', { exact: true }).waitFor()
  expect(await page.evaluate(() => localStorage.getItem('hemi-skin'))).toBeNull()
  const input = page.locator('[data-composer-input]').first()
  await input.fill('Preview only')
  const send = page.getByRole('button', { name: '发送消息', exact: true, includeHidden: true })
  await expect.poll(() => send.isEnabled()).toBe(true)
  await mkdir('.artifacts', { recursive: true })
  const screenshots = await mkdtemp('.artifacts/hemi-default-skin-')
  console.log(`Hemi monochrome screenshots: ${screenshots}`)
  const palettes: Record<string, string>[] = []
  for (const dark of [false, true]) {
    await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' })
    await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(dark)
    await expect.poll(() => send.evaluate(node =>
      getComputedStyle(node).backgroundColor === getComputedStyle(document.body).color)).toBe(true)
    const colors = await send.evaluate((node) => {
      const button = getComputedStyle(node)
      const body = getComputedStyle(document.body)
      return {
        background: body.backgroundColor, text: body.color, sendFill: button.backgroundColor, sendInk: button.color,
        bubble: getComputedStyle(document.querySelector('[data-message-bubble]')!).backgroundColor,
        brand: body.getPropertyValue('--dsw-alias-brand-primary').trim(),
        focus: body.getPropertyValue('--dsw-focus-ring-color').trim(),
      }
    })
    const luminance = (color: string) => color.match(/[\d.]+/g)!.slice(0, 3)
      .map(Number).map(channel => channel / 255)
      .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
      .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0)
    const contrast = (Math.max(luminance(colors.sendFill), luminance(colors.sendInk)) + 0.05)
      / (Math.min(luminance(colors.sendFill), luminance(colors.sendInk)) + 0.05)
    expect(contrast).toBeGreaterThanOrEqual(4.5)
    expect(colors.sendFill).toBe(colors.text)
    expect(colors.focus).toBe(colors.brand)
    expect(colors.bubble).toBe(dark ? 'rgb(44, 44, 46)' : 'rgb(245, 246, 247)')
    palettes.push({ mode: dark ? 'dark' : 'light', ...colors })
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 820 })
      await page.screenshot({ path: `${screenshots}/chat-${width}-${dark ? 'dark' : 'light'}.png`, animations: 'disabled' })
    }
  }
  await compareOrRefreshGolden(`${dir}/palette.expected.json`, JSON.stringify(palettes, null, 2), mode)
  await page.setViewportSize({ width: 1280, height: 820 })
  await compareOrRefreshGolden(`${dir}/chat.expected.md`, await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd), mode)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('button', { name: '皮肤', exact: true }).click()
  const section = settings.getByRole('region', { name: '皮肤', exact: true })
  const classic = section.getByRole('button', { name: '经典', exact: true })
  expect(await classic.getAttribute('aria-pressed')).toBe('true')
  await classic.press('Tab')
  await page.keyboard.press('Shift+Tab')
  for (const dark of [false, true]) {
    await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' })
    await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(dark)
    await page.screenshot({ path: `${screenshots}/settings-${dark ? 'dark' : 'light'}.png`, animations: 'disabled' })
  }
  await compareOrRefreshGolden(`${dir}/skins.expected.md`, await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), mode)
  for (const name of ['晴海蓝', '月见紫', '焦糖橙', '蜜糖金', '围巾红']) {
    await section.getByRole('button', { name, exact: true }).click()
    expect(await page.evaluate(() => document.body.style.getPropertyValue('--dsh-composer-primary-foreground'))).toBe('')
    expect(await send.evaluate(node => getComputedStyle(node).color)).toBe('rgb(255, 255, 255)')
  }
  await page.reload({ waitUntil: 'load' })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await settings.getByRole('button', { name: '皮肤', exact: true }).click()
  expect(await section.getByRole('button', { name: '围巾红', exact: true }).getAttribute('aria-pressed')).toBe('true')
  await classic.click()
  expect(await page.evaluate(() => localStorage.getItem('hemi-skin'))).toBe('classic')
  await page.reload({ waitUntil: 'load' })
  await page.getByText('DONE', { exact: true }).waitFor()
  expect(await send.evaluate(node => getComputedStyle(node).backgroundColor)).toBe(palettes[1]!.sendFill)
  expect(await page.locator('body > div[aria-hidden="true"] img[src]').count()).toBe(0)
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
  await assertFixtureInventory(dir, ['palette.expected.json', 'chat.expected.md', 'skins.expected.md'])
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
