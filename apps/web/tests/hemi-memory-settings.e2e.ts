/** Removal guard: the shipped composition offers no Hemi memory surface, and legacy memory stores survive byte-for-byte. */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { ScriptedAdapter, textResponse } from '../../../packages/hemi/routing/tests/mock-llm.ts'
import { launchWebScaffold } from './scaffold.ts'
import { connectFreshWorkspaceZh, openSettings, ZH_BROWSER_LOCALE } from './support.ts'

const REMOVED_MEMORY_TOOLS = ['memory_write', 'memory_read', 'memory_search', 'memory_forget'] as const

it('keeps the removed Hemi memory feature absent while legacy memory store files stay byte-identical', async () => {
  // Committed installations keep the three legacy stores under $DSH_HOME; the
  // removed plugin was their only writer, so the remaining composition must
  // expose none of its surface and leave the files untouched.
  const home = await mkdtemp(join(tmpdir(), 'hemi-memory-removed-'))
  onTestFinished(() => rm(home, { recursive: true, force: true }))
  const memoryRoot = join(home, 'hemi-memory')
  const legacyStores = [
    { path: join(memoryRoot, 'MEMORY.md'), content: '# LEGACY_LONG_TERM\n' },
    { path: join(memoryRoot, 'daily', '2026-04-03.md'), content: 'LEGACY_DAILY\n' },
    { path: join(memoryRoot, 'SCRATCHPAD.md'), content: 'LEGACY_SCRATCHPAD\n' },
  ]
  await mkdir(join(memoryRoot, 'daily'), { recursive: true })
  const seededBytes = new Map<string, Buffer>()
  for (const store of legacyStores) {
    await writeFile(store.path, store.content)
    seededBytes.set(store.path, await readFile(store.path))
  }

  // The desktop settings entry is the fallback sidebar button, so the overlay
  // hides the account launcher the web default would otherwise mount.
  const overlay = join(home, 'hemi.patch.yml')
  await writeFile(overlay, '- id: ui-settings-account\n  config:\n    showLauncher: false\n')
  const scaffold = await launchWebScaffold({ developerTools: false, harnessHome: home, extraOverlayPath: overlay })
  onTestFinished(() => scaffold.close())
  const pluginIds = [...scaffold.ctx.loader.entries()].map(entry => entry.options.id)
  expect(pluginIds).not.toContain('hemi-memory')
  expect(pluginIds).not.toContain('hemi-memory-ui')
  const adapter = new ScriptedAdapter([textResponse('Noted')])
  scaffold.ctx.llm.registerAdapter(['hemi-memory-test'], adapter)
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE })
  const pageErrors: string[] = []
  page.on('pageerror', (error) => { pageErrors.push(error.message) })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })

  await openSettings(page, 'zh')
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('button', { name: '通用设置', exact: true }).waitFor()
  expect(await settings.getByRole('button', { name: '记忆', exact: true }).count()).toBe(0)
  expect(await settings.getByRole('region', { name: '记忆', exact: true }).count()).toBe(0)
  const evidence = await mkdtemp(join(tmpdir(), 'hemi-memory-removed-evidence-'))
  console.log(`Memory removal evidence screenshots: ${evidence}`)
  await page.screenshot({ path: join(evidence, 'settings-zh-no-memory.png'), fullPage: true })
  await page.keyboard.press('Escape')
  await settings.waitFor({ state: 'hidden' })

  await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  const lead = scaffold.ctx.agents.list().find(agent => agent.session.header.origin !== 'subagent')
  if (lead === undefined) throw new Error('Main agent was not created')
  lead.model.select({ provider: 'hemi-memory-test', model: 'test-model' })
  const settled = scaffold.whenTurnSettled()
  await page.locator('[data-composer-input]').first().fill('请记住这次的决定')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await settled
  await page.getByText('Noted', { exact: true }).waitFor()
  expect(pageErrors).toEqual([])

  // The removed lifecycle issued its summary request during whole-app close,
  // so request-count and store assertions only hold after scaffold.close().
  await browser.close()
  await scaffold.close()

  expect(adapter.requests).toHaveLength(1)
  const request = adapter.requests[0]
  if (request === undefined) throw new Error('Conversation request was not recorded')
  expect(request).toMatchObject({ provider: 'hemi-memory-test', model: 'test-model' })
  expect(request.purpose).toBeUndefined()
  const toolNames = (request.tools ?? []).map(tool => tool.name)
  expect(toolNames.length).toBeGreaterThan(0)
  expect(toolNames).toContain('subagent')
  for (const removed of REMOVED_MEMORY_TOOLS) expect(toolNames).not.toContain(removed)
  const requestText = JSON.stringify(request.messages)
  expect(requestText).not.toContain('Saved memory for reference')
  for (const store of legacyStores) expect(requestText).not.toContain(store.content.trim())
  expect(lead.session.snapshotEvents().filter(event => event.type.startsWith('hemi-memory/'))).toEqual([])

  expect((await readdir(memoryRoot)).sort()).toEqual(['MEMORY.md', 'SCRATCHPAD.md', 'daily'])
  expect((await readdir(join(memoryRoot, 'daily'))).sort()).toEqual(['2026-04-03.md'])
  for (const store of legacyStores) {
    expect(await readFile(store.path), `${store.path} keeps its seeded bytes`).toEqual(seededBytes.get(store.path))
  }
})
