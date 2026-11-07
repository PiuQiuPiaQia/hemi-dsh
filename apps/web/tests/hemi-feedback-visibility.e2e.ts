/** Real Desktop profile expressions hide feedback across the header, composer and message actions. */
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { ScriptedAdapter, textResponse } from '../../../packages/hemi/routing/tests/mock-llm.ts'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspaceZh, ZH_BROWSER_LOCALE } from './support.ts'

/** Declared local model keeps the feedback visibility test independent of external inference. */
class FeedbackVisibilityAdapter extends ScriptedAdapter {
  override providerInfo() { return { id: 'feedback-visibility-test', name: 'Feedback visibility test' } }
  override async listModels() { return [{ provider: 'feedback-visibility-test', id: 'local', name: 'Local' }] }
}

it('omits all upstream feedback entries using the shipped Desktop profile without a feedback-disabling overlay', async () => {
  const scaffold = await launchWebScaffold({ profile: { name: 'desktop', hmr: false, packages: [] } })
  onTestFinished(() => scaffold.close())
  expect(scaffold.ctx.profileContext.name).toBe('desktop')
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
  const composer = page.locator('[data-composer-input]').first()
  const lead = scaffold.ctx.agents.list().find(agent => agent.session.header.origin !== 'subagent')
  if (lead === undefined) throw new Error('Missing Desktop workspace session')
  scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter(['feedback-visibility-test'],
    new FeedbackVisibilityAdapter([textResponse('Feedback controls are absent.')])))
  await scaffold.ctx.sessionController.selectModel({ sessionId: lead.id, provider: 'feedback-visibility-test', model: 'local' })
  const settled = scaffold.whenTurnSettled()
  await composer.fill('Verify message actions.')
  await composer.press('Enter')
  await settled
  await page.getByText('Feedback controls are absent.', { exact: true }).waitFor()

  await page.getByRole('button', { name: '更多操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '下载 Session 日志', exact: true }).waitFor()
  expect(await page.getByRole('menuitem', { name: '反馈', exact: true }).count()).toBe(0)
  expect(await page.getByRole('menuitem', { name: '复制会话为 Markdown', exact: true }).count()).toBe(1)
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: '添加文件或调用指令', exact: true }).click()
  const suggestions = page.getByRole('listbox', { name: '触发候选建议', exact: true })
  await suggestions.waitFor()
  expect(await suggestions.innerText()).not.toMatch(/反馈|feedback/i)
  await page.keyboard.press('Escape')
  await composer.fill('/feedback')
  await expect.poll(async () => page.getByRole('listbox').allTextContents()).not.toContainEqual(expect.stringMatching(/反馈|feedback/i))
  await composer.fill('')
  await page.keyboard.press('Escape')

  expect(await page.getByRole('button', { name: /好的回答|有问题的回答|撤销评价/ }).count()).toBe(0)
  expect(await page.getByRole('dialog', { name: /反馈/ }).count()).toBe(0)
  expect(await page.getByText('联系我们', { exact: true }).count()).toBe(0)
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})
