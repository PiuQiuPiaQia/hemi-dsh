/** Shipped preset + browser integration; all inference is a local scripted adapter. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '../../../packages/hemi/routing/src/settings.ts'
import { ScriptedAdapter, textResponse, toolCallResponse } from '../../../packages/hemi/routing/tests/mock-llm.ts'
import {
  assertFixtureInventory, compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole, webSnapshotMode,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

function withReportedTotal(chunks: StreamChunk[]): StreamChunk[] {
  return chunks.map(chunk => chunk.type === 'usage' ? { ...chunk, usage: { ...chunk.usage,
    totalTokens: chunk.usage.inputTokens + chunk.usage.outputTokens
      + (chunk.usage.cacheReadTokens ?? 0) + (chunk.usage.cacheWriteTokens ?? 0),
  } } : chunk)
}

it('runs four native role presets on their configured routes and receives their results through native completion notices', async () => {
  const roles = ['explorer', 'oracle', 'fixer', 'designer'] as const
  const scaffold = await launchWebScaffold()
  onTestFinished(() => scaffold.close())
  const gates = roles.map(() => Promise.withResolvers<StreamChunk[]>())
  const adapter = new ScriptedAdapter(roles.flatMap((role, index) => {
    const afterStart = (options: Parameters<ScriptedAdapter['stream']>[0]) => {
      const agent = options.sessionId === undefined ? undefined : scaffold.ctx.agents.get(options.sessionId)
      return agent?.session.header.origin === 'subagent'
        ? gates[index]!.promise : withReportedTotal(textResponse(`Started ${role}`))
    }
    return [
      withReportedTotal(toolCallResponse(`role-${role}`, 'subagent', {
        agent_preset: role, description: `Check ${role}`, prompt: `Report the ${role} result`,
      })),
      afterStart, afterStart,
      withReportedTotal(textResponse(`Verified ${role}`)),
    ]
  }))
  scaffold.ctx.llm.registerAdapter(['hemi-native-test'], adapter)
  await scaffold.ctx.settings.mutate('hemi-routing-settings', [
    { op: 'set', path: ['main'], value: { provider: 'hemi-native-test', model: 'main' } },
    { op: 'set', path: ['roles'], value: Object.fromEntries(roles.map(role => [role, { provider: 'hemi-native-test', model: `${role}-model` }])) },
  ])
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ locale: 'en-US' })
  const errors: Error[] = []
  page.on('pageerror', (error) => { errors.push(error) })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  const lead = scaffold.ctx.agents.list().find(agent => agent.session.header.origin !== 'subagent')
  if (lead === undefined) throw new Error('Missing lead agent')
  const roster = await scaffold.ctx.agentPresets.list()
  for (const role of roles) {
    const preset = roster.find(entry => entry.id === role)
    expect(preset).toBeDefined()
    expect(preset?.broken).toBeUndefined()
  }
  await scaffold.ctx.hemiRoutingSettings.setEnabled(lead, true)
  await scaffold.ctx.agentTeams.setEnabled(lead, true)
  const task = await scaffold.ctx.agentTeams.createTask(lead, { subject: 'Shared role task', description: 'All roles share the native board' })
  try {
    for (const [index, role] of roles.entries()) {
      const start = index * 4
      const composer = page.locator('[data-composer-input]').first()
      await composer.fill(`Run ${role}`)
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      await expect.poll(() => adapter.requests.length).toBe(start + 3)
      const child = scaffold.ctx.agents.list().find(agent => agent.session.header.agentPreset === role)
      if (child === undefined) throw new Error(`Missing native ${role} child`)
      expect(child.session.header.origin).toBe('subagent')
      expect(scaffold.ctx.agentPresets.presetForSession(child.session)).toBe(role)
      expect(scaffold.ctx.subagents.rootOf(child)).toBe(lead)
      expect(scaffold.ctx.agentTeams.isEnabled(child)).toBe(true)
      expect(scaffold.ctx.agentTeams.getTask(child, task.id)).toMatchObject({ id: task.id })
      expect(adapter.requests[start]).toMatchObject({ provider: 'hemi-native-test', model: 'main' })
      expect(adapter.requests.slice(start + 1, start + 3).find(request => request.model === `${role}-model`))
        .toMatchObject({ provider: 'hemi-native-test', model: `${role}-model` })
      const header = lead.session.snapshotEvents().find(event => event.type === 'request/header')
      const tools = (header?.data as { header?: { tools?: { name: string }[] } }).header?.tools ?? []
      expect(tools.some(tool => tool.name === 'subagent')).toBe(true)
      expect(tools.some(tool => tool.name === 'hemi_delegate')).toBe(false)
      expect(JSON.stringify(child.session.snapshotEvents().filter(event => event.type === 'system/message'))).toContain(`Role: ${role}`)
      await lead.whenIdle()
      expect(lead.status).toBe('idle')
      expect(lead.session.snapshotEvents().filter(event => event.type === 'turn/end')).toHaveLength(index * 2 + 1)
      const receipt = lead.session.snapshotEvents().filter(event => event.type === 'tool/result').at(-1)
      expect(JSON.stringify(receipt?.data.message.content)).toContain('started subagent')
      expect(receipt?.data.meta).toHaveProperty('kind', 'activation')
      expect(receipt?.data.meta).not.toHaveProperty('completed')
      const reply = textResponse(`${role} result`).map(chunk => chunk.type === 'usage' && role === 'oracle'
        ? { ...chunk, usage: { ...chunk.usage, cacheReadTokens: 500, cacheWriteTokens: 25, reasoningTokens: 4 } } : chunk)
      gates[index]!.resolve(withReportedTotal(reply))
      await lead.whenIdle()
      await page.getByText(`Verified ${role}`, { exact: true }).waitFor()
      const results = lead.session.snapshotEvents().filter(event => event.type === 'tool/result')
      expect(JSON.stringify(results.at(-1)?.data.message.content)).toContain('started subagent')
      expect(JSON.stringify(lead.session.snapshotEvents().filter(event => event.type === 'user/message'
        && event.data.source.kind === 'subagent-settled'))).toContain(`${role} result`)
    }
  } finally {
    gates.forEach((gate) => { gate.resolve(textResponse('fixture cleanup')) })
  }
  await page.getByRole('button', { name: 'Conversation usage', exact: true }).click()
  const usage = page.getByRole('dialog', { name: 'Conversation usage', exact: true })
  const modelTable = usage.getByRole('table', { name: 'Recorded usage by model' })
  await expect.poll(() => modelTable.getByRole('row').count()).toBe(6)
  for (const role of roles) await modelTable.getByText(`${role}-model (hemi-native-test)`, { exact: true }).waitFor()
  await modelTable.getByText('main (hemi-native-test)', { exact: true }).waitFor()
  await expect.poll(() => page.getByRole('button', { name: 'Conversation usage', exact: true }).textContent()).toContain('Cache hit 73%')
  const oracleRow = modelTable.getByRole('row', { name: /oracle-model/ })
  expect(await oracleRow.getByRole('cell', { name: '500', exact: true }).count()).toBe(1)
  expect(await oracleRow.getByRole('cell', { name: '25', exact: true }).count()).toBe(1)
  expect(await usage.getByText('882', { exact: true }).count()).toBe(1)
  await page.screenshot({ path: '/tmp/hemi-conversation-usage-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(() => usage.evaluate(element => ({ fits: element.scrollWidth <= element.clientWidth,
    onScreen: element.getBoundingClientRect().left >= 0 && element.getBoundingClientRect().right <= window.innerWidth })))
    .toEqual({ fits: true, onScreen: true })
  await page.screenshot({ path: '/tmp/hemi-conversation-usage-mobile.png' })
  await page.reload({ waitUntil: 'load' })
  await page.getByRole('button', { name: 'Conversation usage', exact: true }).click()
  await page.getByRole('dialog', { name: 'Conversation usage', exact: true })
    .getByText('oracle-model (hemi-native-test)', { exact: true }).waitFor()
  expect(errors).toEqual([])
})

const DIR = fileURLToPath(new URL('../../../snapshots/web/hemi-cache-rate', import.meta.url))

it('shows weighted model cache rates when recorded calls omit zero cache counters', async () => {
  const scaffold = await launchWebScaffold()
  onTestFinished(() => scaffold.close())
  await seedSession(scaffold, await readFile(join(DIR, 'session.v4.jsonl'), 'utf8'), 'hemi-cache-rate')
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  const tripwire = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.locator('[role="treeitem"]').first().click()
  await page.locator('[role="treeitem"]').nth(1).click()
  for (const reopened of [false, true]) {
    if (reopened) await page.reload({ waitUntil: 'load' })
    const trigger = page.getByRole('button', { name: 'Conversation usage', exact: true })
    await expect.poll(() => trigger.textContent()).toBe('Cache hit 32%')
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: 'Conversation usage', exact: true })
    await compareOrRefreshGolden(join(DIR, 'usage.expected.md'), await dialog.ariaSnapshot(), webSnapshotMode())
    await trigger.click()
  }
  expect(tripwire.pageErrors).toEqual([])
  await assertFixtureInventory(DIR, ['session.v4.jsonl', 'usage.expected.md'])
})
