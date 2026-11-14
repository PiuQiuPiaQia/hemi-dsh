/** Built settings UI drives the shell keep-awake bridge; persistence and the assertion stay in Desktop. */
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { openSettings } from './support.ts'

it('toggles Desktop keep-awake from Settings and reports save failures in place', async () => {
  const scaffold = await launchWebScaffold({})
  try {
    const browser = await chromium.launch()
    try {
      let state: { enabled: boolean } = { enabled: false }
      let failNext = false
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'en-US' })
      const tripwire = watchConsole(page)
      await page.exposeFunction('readKeepAwake', () => state)
      await page.exposeFunction('setKeepAwake', async (enabled: boolean): Promise<{ enabled: boolean }> => {
        if (failNext) { failNext = false; throw new Error('injected save failure') }
        state = { enabled }
        return state
      })
      await page.addInitScript(() => {
        const bridge = globalThis as typeof globalThis & {
          readKeepAwake(): Promise<{ enabled: boolean }>
          setKeepAwake(enabled: boolean): Promise<{ enabled: boolean }>
        }
        Object.assign(globalThis, { dshDesktop: { protocolVersion: 1, keepAwake: {
          get: () => bridge.readKeepAwake(), set: (enabled: boolean) => bridge.setKeepAwake(enabled),
          subscribe: () => () => {},
        } } })
      })
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await openSettings(page, 'en')
      const row = page.getByRole('group', { name: 'Keep computer awake', exact: true })
      const toggle = row.getByRole('switch', { name: 'Keep computer awake', exact: true })
      await toggle.waitFor()
      expect(await toggle.getAttribute('aria-checked')).toBe('false')
      await toggle.click()
      await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true')
      await compareOrRefreshGolden(fileURLToPath(new URL('./expected/desktop-keep-awake/enabled.expected.md', import.meta.url)),
        await captureStableAria(page, '[role="group"][aria-label="Keep computer awake"]', scaffold.workspaceCwd), webSnapshotMode())
      failNext = true
      await toggle.click()
      await page.getByRole('alert').filter({ hasText: 'Could not apply the keep-awake setting. Please try again.' }).waitFor()
      // The failed save leaves the last known shell state in force: the switch stays checked.
      await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true')
      await compareOrRefreshGolden(fileURLToPath(new URL('./expected/desktop-keep-awake/save-error.expected.md', import.meta.url)),
        await captureStableAria(page, '[role="group"][aria-label="Keep computer awake"]', scaffold.workspaceCwd) + '\n'
          + await captureStableAria(page, '[role="alert"]', scaffold.workspaceCwd), webSnapshotMode())
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    } finally { await browser.close() }
  } finally { await scaffold.close() }
})
