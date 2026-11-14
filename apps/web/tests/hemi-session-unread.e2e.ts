/** Manual unread reminders over the shipped browser composition and borrowed recorded history. */
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole, webSnapshotMode,
} from './scaffold.ts'

const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/hemi-session-unread/', import.meta.url))

it.each([
  { locale: 'en-US', language: 'en', group: 'Ungrouped', mark: 'Mark as unread', unread: 'Unread' },
  { locale: 'zh-CN', language: 'zh', group: '未分组', mark: '标记为未读', unread: '未读' },
])('marks the captured Session unread without navigation and acknowledges reopening ($language)', async (copy) => {
  const scaffold = await launchWebScaffold()
  onTestFinished(() => scaffold.close())
  const recorded = await readFile(SEED, 'utf8')
  await seedSession(scaffold, recorded, 'unread-first')
  await seedSession(scaffold, recorded, 'unread-second')
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ locale: copy.locale, viewport: { width: 1280, height: 820 }, reducedMotion: 'reduce' })
  const tripwire = watchConsole(page)
  const screenshots = await mkdtemp(join(tmpdir(), `hemi-unread-${copy.language}-`))
  console.log(`Unread screenshots: ${screenshots}`)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const group = page.locator('[data-row-key^="workspace:"]').filter({ hasText: copy.group })
  await group.waitFor()
  if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
  const first = page.locator('[data-row-key="session:unread-first"]')
  const second = page.locator('[data-row-key="session:unread-second"]')
  await first.click()
  await page.getByText('DONE', { exact: true }).waitFor()
  await second.click({ button: 'right' })
  const menu = page.locator('[data-context-menu][role="menu"]')
  const mark = menu.getByRole('menuitem', { name: copy.mark, exact: true })
  await mark.waitFor()
  await compareOrRefreshGolden(join(EXPECTED, `menu-${copy.language}.expected.md`),
    await captureStableAria(page, '[data-context-menu][role="menu"]', scaffold.workspaceCwd), webSnapshotMode())
  expect(await first.getAttribute('aria-selected')).toBe('true')
  expect(await second.getAttribute('aria-selected')).toBe('false')
  await page.screenshot({ path: join(screenshots, 'menu-light.png'), animations: 'disabled' })
  await mark.click()
  await menu.waitFor({ state: 'hidden' })
  await second.getByText(copy.unread, { exact: true }).waitFor()
  await expect.poll(() => page.locator('[data-context-menu], [data-menu-backing]').count()).toBe(0)
  expect(await first.getAttribute('aria-selected')).toBe('true')
  await page.screenshot({ path: join(screenshots, 'unread-light.png'), animations: 'disabled' })

  await second.click()
  await expect.poll(() => second.getByText(copy.unread, { exact: true }).count()).toBe(0)
  await second.click({ button: 'right' })
  await mark.click()
  await second.getByText(copy.unread, { exact: true }).waitFor()
  // A Host catalog update is not a new visit to the already open conversation.
  await scaffold.ctx.sessionController.rename({ sessionId: SessionId('unread-second'), title: 'Unread reminder retained' })
  await second.getByText('Unread reminder retained', { exact: true }).waitFor()
  expect(await second.getByText(copy.unread, { exact: true }).count()).toBe(1)
  await first.click()
  await second.getByText(copy.unread, { exact: true }).waitFor()
  await second.click()
  await expect.poll(() => second.getByText(copy.unread, { exact: true }).count()).toBe(0)

  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(() => page.locator('body').evaluate(node => node.hasAttribute('data-ds-dark-theme'))).toBe(true)
  await first.click({ button: 'right' })
  await mark.waitFor()
  await page.screenshot({ path: join(screenshots, 'menu-dark.png'), animations: 'disabled' })
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'hidden' })
  expect(await first.evaluate(node => node === document.activeElement)).toBe(true)
  await first.press('Shift+F10')
  await mark.waitFor()
  await page.mouse.click(1000, 600)
  await menu.waitFor({ state: 'hidden' })
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})
