/** Built Hemi composer controls over a declared catalog; no inference requests. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, webkit } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { ZH_BROWSER_LOCALE, connectFreshWorkspaceZh } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./declared-reasoning.overlay.yml', import.meta.url))
const GOLDEN = fileURLToPath(new URL('./expected/hemi-effort-picker/menu.expected.md', import.meta.url))

it.each([{ name: 'Chromium', engine: chromium }, { name: 'WebKit', engine: webkit }])(
  'separates Hemi effort selection and fits themes and viewports ($name)', async ({ engine }) => {
    const scratch = await mkdtemp(join(tmpdir(), 'hemi-reasoning-'))
    onTestFinished(() => rm(scratch, { recursive: true, force: true }))
    const patch = join(scratch, 'reasoning.patch.yml')
    await writeFile(patch, `${await readFile(OVERLAY, 'utf8')}\n- id: hemi-model-access\n  disabled: false\n`)
    const scaffold = await launchWebScaffold({ extraOverlayPath: patch })
    onTestFinished(() => scaffold.close())
    await scaffold.ctx.settings.update('llm-pi-ai', { providers: {
      'acme-gateway': {
        displayName: 'Acme Gateway', api: 'openai-completions', baseURL: 'https://gateway.acme.example/v1',
        models: [
          { id: 'acme-think', name: 'Acme Think', reasoningEfforts: { off: null, high: 'high', max: 'ultra' } },
          { id: 'acme-plain', name: 'Acme Plain' },
        ],
      },
      'anthropic-gateway': {
        displayName: 'Anthropic Gateway', api: 'anthropic-messages', baseURL: 'https://anthropic.example/v1',
        models: [{ id: 'claude-unknown', name: 'Unknown Claude' }],
      },
    } })
    const browser = await engine.launch()
    onTestFinished(() => browser.close())
    const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1280, height: 900 } })
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
    const model = page.getByRole('button', { name: '选择模型，当前 Acme Think', exact: true })
    const effort = page.getByRole('button', { name: '推理等级', exact: true })
    await effort.waitFor()
    expect(await effort.textContent()).toBe('Default')
    await effort.click()
    await expect.poll(() => page.getByRole('menuitem').allTextContents()).toEqual(['Default', 'Off', 'High', 'Max'])
    await compareOrRefreshGolden(GOLDEN, await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd), webSnapshotMode())
    await page.getByRole('menuitem', { name: 'High', exact: true }).click()
    await expect.poll(() => effort.textContent()).toBe('High')
    await expect.poll(async () => readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8'))
      .toContain('reasoningEffort: high')
    await expect.poll(() => effort.evaluate(node => node === document.activeElement)).toBe(true)

    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 })
      for (const dark of [false, true]) {
        await page.evaluate(value => document.body.toggleAttribute('data-ds-dark-theme', value), dark)
        await expect.poll(async () => {
          const [modelBox, effortBox] = await Promise.all([model.boundingBox(), effort.boundingBox()])
          if (modelBox === null || effortBox === null) return false
          return effortBox.x >= modelBox.x + modelBox.width && Math.abs(effortBox.y - modelBox.y) < 2
            && effortBox.x + effortBox.width <= width
        }).toBe(true)
        await effort.click()
        const menu = page.getByRole('menu')
        await menu.waitFor({ state: 'visible' })
        await expect.poll(() => menu.evaluate((node) => {
          const box = node.getBoundingClientRect()
          return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight
        })).toBe(true)
        expect(await page.getByRole('menuitem', { name: 'High', exact: true }).isVisible()).toBe(true)
        await page.screenshot({ path: `/tmp/hemi-effort-${engine.name()}-${width}-${dark ? 'dark' : 'light'}.png` })
        await page.keyboard.press('Escape')
        await expect.poll(() => menu.count()).toBe(0)
        await expect.poll(() => effort.evaluate(node => node === document.activeElement)).toBe(true)
      }
    }
    await model.click()
    expect(await page.getByRole('menuitem', { name: /推理等级/ }).count()).toBe(0)
    await page.getByRole('menuitemradio', { name: 'Acme Plain', exact: true }).click()
    await expect.poll(() => effort.textContent()).toBe('Medium')
    await effort.click()
    await expect.poll(() => page.getByRole('menuitem').allTextContents()).toEqual(['Off', 'Minimal', 'Low', 'Medium', 'High', 'Xhigh', 'Max'])
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '选择模型，当前 Acme Plain', exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'Unknown Claude', exact: true }).click()
    await expect.poll(() => effort.textContent()).toBe('High')
    await effort.click()
    await expect.poll(() => page.getByRole('menuitem').allTextContents()).toEqual(['Low', 'Medium', 'High', 'Xhigh', 'Max'])
    await page.keyboard.press('Escape')

    const lead = scaffold.ctx.agents.list().find(agent => agent.session.header.origin !== 'subagent')
    if (lead === undefined) throw new Error('Missing fixture conversation')
    await scaffold.ctx.settings.mutate('hemi-routing-settings', [
      { op: 'set', path: ['main'], value: { provider: 'acme-gateway', model: 'acme-plain' } },
    ])
    await scaffold.ctx.hemiRoutingSettings.setEnabled(lead, true)
    const routingEffort = page.getByRole('button', { name: '推理强度', exact: true })
    await routingEffort.waitFor()
    await routingEffort.click()
    await expect.poll(() => page.getByRole('menuitem').allTextContents()).toEqual(['低', '中', '高', '最高'])
    await compareOrRefreshGolden(fileURLToPath(new URL('./expected/hemi-effort-picker/auto.expected.md', import.meta.url)),
      await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd), webSnapshotMode())
    await page.getByRole('menuitem', { name: '最高', exact: true }).click()
    await expect.poll(() => routingEffort.textContent()).toBe('最高')
    expect(scaffold.ctx.hemiRoutingSettings.modeOf(lead)).toBe('auto')
    await page.reload({ waitUntil: 'load' })
    await expect.poll(() => routingEffort.textContent()).toBe('最高')
    expect(tripwire.pageErrors).toEqual([])
  },
)
