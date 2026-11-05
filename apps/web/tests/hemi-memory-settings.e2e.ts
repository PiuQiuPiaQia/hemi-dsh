import { mkdir, mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold } from './scaffold.ts'
import { ScriptedAdapter, textResponse } from '../../../packages/hemi/routing/tests/mock-llm.ts'
import { connectFreshWorkspace, openSettings, ZH_BROWSER_LOCALE } from './support.ts'

it('edits the Hemi memory files through an independent settings tab and rejects stale saves', async () => {
  const scaffold = await launchWebScaffold({ developerTools: false })
  onTestFinished(() => scaffold.close())
  const memoryRoot = join(scaffold.harnessHome, 'hemi-memory')
  const longTerm = join(memoryRoot, 'MEMORY.md')
  const date = '2026-04-03'
  const log = join(memoryRoot, 'daily', `${date}.md`)
  await mkdir(join(memoryRoot, 'daily'), { recursive: true })
  await writeFile(longTerm, '# 已有记忆\n')
  await writeFile(log, '已有日志\n')

  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await openSettings(page, 'zh')
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('button', { name: '记忆', exact: true }).click()
  const memory = settings.getByRole('region', { name: '记忆', exact: true })
  const content = memory.getByRole('textbox', { name: '记忆内容' })
  const store = memory.getByRole('combobox', { name: '记忆类型' })
  const save = memory.getByRole('button', { name: '保存', exact: true })
  const status = memory.getByRole('status')

  await expect.poll(() => content.inputValue()).toBe('# 已有记忆\n')
  await content.fill('# 用户编辑\n')
  expect(await store.isDisabled()).toBe(true)
  await save.click()
  await status.getByText('已保存', { exact: true }).waitFor()
  expect(await readFile(longTerm, 'utf8')).toBe('# 用户编辑\n')

  await content.fill('# 尚未保存\n')
  await writeFile(longTerm, '# 外部更新\n')
  await save.click()
  await status.getByText('打开后，文件已被更新。请先复制你的修改，再重新加载。').waitFor()
  expect(await content.inputValue()).toBe('# 尚未保存\n')
  expect(await readFile(longTerm, 'utf8')).toBe('# 外部更新\n')
  await memory.getByRole('button', { name: '放弃修改并重新加载', exact: true }).click()
  await expect.poll(() => content.inputValue()).toBe('# 外部更新\n')

  await store.selectOption('daily')
  await memory.getByLabel('日志日期').fill(date)
  await expect.poll(() => content.inputValue()).toBe('已有日志\n')
  await content.fill('更新日志\n')
  await save.click()
  await status.getByText('已保存', { exact: true }).waitFor()
  expect(await readFile(log, 'utf8')).toBe('更新日志\n')

  await store.selectOption('scratchpad')
  await expect.poll(() => content.isEnabled()).toBe(true)
  await content.fill('临时便签')
  await save.click()
  await status.getByText('已保存', { exact: true }).waitFor()
  expect(await readFile(join(memoryRoot, 'SCRATCHPAD.md'), 'utf8')).toBe('临时便签')
  await store.selectOption('long_term')
  await expect.poll(() => content.inputValue()).toBe('# 外部更新\n')
})

it('loads memory and saves an exit summary through the shipped browser composition', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hemi-memory-browser-'))
  onTestFinished(() => rm(home, { recursive: true, force: true }))
  const memoryRoot = join(home, 'hemi-memory')
  await mkdir(memoryRoot)
  await writeFile(join(memoryRoot, 'MEMORY.md'), 'BROWSER_SAVED_FACT')
  const scaffold = await launchWebScaffold({ developerTools: false, harnessHome: home })
  onTestFinished(() => scaffold.close())
  const adapter = new ScriptedAdapter([textResponse('Memory checked'), textResponse('BROWSER_EXIT_DECISION')])
  scaffold.ctx.llm.registerAdapter(['hemi-memory-test'], adapter)
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ locale: 'en-US' })
  const pageErrors: string[] = []
  page.on('pageerror', (error) => { pageErrors.push(error.message) })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  const lead = scaffold.ctx.agents.list().find(agent => agent.session.header.origin !== 'subagent')
  if (lead === undefined) throw new Error('Main agent was not created')
  lead.model.select({ provider: 'hemi-memory-test', model: 'test-model' })
  await page.locator('[data-composer-input]').first().fill('Remember the chosen browser decision')
  const settled = scaffold.whenTurnSettled()
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await settled
  expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('BROWSER_SAVED_FACT')
  await page.getByText('Memory checked', { exact: true }).waitFor()
  await openSettings(page, 'en')
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await settings.getByRole('button', { name: 'Memory', exact: true }).click()
  await settings.getByText('Automatic summaries use the most recently used model.', { exact: false }).waitFor()
  await page.screenshot({ path: '/tmp/hemi-memory-automatic-settings.png' })
  await browser.close()
  await scaffold.close()
  const logs = await readdir(join(memoryRoot, 'daily'))
  expect(logs).toHaveLength(1)
  const log = logs[0]
  if (log === undefined) throw new Error('Daily summary was not saved')
  expect(await readFile(join(memoryRoot, 'daily', log), 'utf8')).toContain('BROWSER_EXIT_DECISION')
  expect(lead.session.snapshotEvents().at(-1)?.data).toMatchObject({ outcome: 'saved' })
  expect(pageErrors).toEqual([])
})
