/** Provider-neutral Desktop composition remains usable with the DeepSeek account plugins absent. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-hemi-model-settings'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, webSnapshotMode } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

it('opens the generic introduction and connection settings without a DeepSeek account service', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'hemi-desktop-startup-'))
  onTestFinished(() => rm(scratch, { recursive: true, force: true }))
  const patch = join(scratch, 'desktop.patch.yml')
  await writeFile(patch, [
    '- id: hemi-model-settings\n  disabled: false\n  config:\n    desktopStartup: true',
    ...['hemi-model-settings-ui', 'hemi-model-access', 'hemi-model-access-ui'].map(id => `- id: ${id}\n  disabled: false`),
    '- id: system-prompt\n  config:\n    includeHarnessIdentity: false',
    '- id: agent-default-model\n  config:\n    provider: null\n    model: null',
    ...['deepseek-account', 'account-controller', 'ui-settings-account', 'llm-deepseek-account'].map(id => `- id: ${id}\n  disabled: true`),
    '- id: ui-settings-models\n  config:\n    credentialOnboarding: false\n    showSettingsSection: false',
  ].join('\n') + '\n')
  const scaffold = await launchWebScaffold({ developerTools: false, extraOverlayPath: patch, deepSeekMissingCredential: true })
  onTestFinished(() => scaffold.close())
  expect(scaffold.ctx.get('deepseekAccount')).toBeUndefined()
  expect(scaffold.ctx.agentDefaultModel.currentSelection()).toBeUndefined()
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE })
  await page.addInitScript('globalThis.dshDesktop = { protocolVersion: 1 }')
  const errors: Error[] = []
  const accountRequests: string[] = []
  page.on('pageerror', error => errors.push(error))
  page.on('request', (request) => { if (new URL(request.url()).pathname.startsWith('/api/account/')) accountRequests.push(request.url()) })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const welcome = page.getByRole('dialog', { name: '欢迎使用 Hemi', exact: true })
  await welcome.waitFor({ timeout: 30_000 })
  expect(await welcome.getByRole('button', { name: '配置模型', exact: true }).count()).toBe(1)
  expect(await welcome.getByRole('button', { name: '进入工作区', exact: true }).count()).toBe(1)
  expect(await welcome.getByText('DeepSeek', { exact: true }).count()).toBe(0)
  const golden = fileURLToPath(new URL('./expected/hemi-desktop-startup/welcome.expected.md', import.meta.url))
  await mkdir(join(golden, '..'), { recursive: true })
  await compareOrRefreshGolden(golden, await captureStableAria(page, '[role="dialog"][aria-label="欢迎使用 Hemi"]', scaffold.workspaceCwd), webSnapshotMode())
  await mkdir('.artifacts/hemi-desktop-neutral', { recursive: true })
  const viewports = [{ width: 1280, height: 820 }, { width: 1024, height: 660 }, { width: 600, height: 600 }, { width: 360, height: 640 }]
  for (const viewport of viewports) {
    await page.setViewportSize(viewport)
    expect(await welcome.boundingBox()).toEqual({ x: 0, y: 0, ...viewport })
    const configure = await welcome.getByRole('button', { name: '配置模型', exact: true }).boundingBox()
    const enter = await welcome.getByRole('button', { name: '进入工作区', exact: true }).boundingBox()
    expect(configure).toMatchObject({ width: 240, height: 44 })
    expect(enter).toMatchObject({ x: configure!.x, width: 240, height: 44, y: configure!.y + 60 })
    expect(enter!.y + enter!.height).toBeLessThan(viewport.height)
    expect(await welcome.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: `.artifacts/hemi-desktop-neutral/welcome-${viewport.width}.png`, animations: 'disabled' })
  }
  await page.setViewportSize({ width: 1280, height: 820 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(true)
  await page.screenshot({ path: '.artifacts/hemi-desktop-neutral/welcome-dark.png', animations: 'disabled' })
  await welcome.getByRole('button', { name: '配置模型', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.waitFor()
  const connections = settings.getByRole('region', { name: '模型接入', exact: true })
  await connections.getByRole('region', { name: 'ChatGPT Codex', exact: true }).waitFor()
  expect(await connections.getByRole('region', { name: 'DeepSeek', exact: true }).count()).toBe(0)
  expect(scaffold.ctx.hemiModelSettings.desktopWelcome()).toEqual({ enabled: true, completed: true })
  const created = await scaffold.ctx.sessionController.create({})
  const catalog = await scaffold.ctx.sessionController.modelCatalog()
  expect(catalog.default).toBeNull()
  const admitted: string[] = []
  const stopObserving = scaffold.ctx.on('session/event', (session, event) => {
    if (session.id === created.sessionId && event.type === 'user/message') admitted.push(event.type)
  })
  onTestFinished(() => { stopObserving() })
  await expect(scaffold.ctx.sessionController.prompt({
    sessionId: created.sessionId, requestId: 'unconfigured-desktop-prompt' as SessionRequestId, mode: 'queue',
    content: [{ type: 'text', text: 'This prompt must not be sent to any provider' }],
  }, new AbortController().signal)).rejects.toMatchObject({ code: 'session/model-not-selected' })
  expect(admitted).toEqual([])
  const twin = await scaffold.ctx.sessionController.create({})
  scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter(['neutral-test'], new class extends LlmAdapter {
    override providerInfo(provider: string) { return { id: provider, name: 'Neutral test provider' } }
    override async listModels() { return [{ provider: 'neutral-test', id: 'local-model', name: 'Local model' }] }
    override async resolveModel(provider: string, model: string) { return { provider, id: model, name: 'Local model' } }
    override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> { throw new Error('No model request is expected in setup') }
  }()))
  await scaffold.ctx.sessionController.selectModel({ sessionId: created.sessionId, provider: 'neutral-test', model: 'local-model' })
  await expect.poll(() => scaffold.ctx.agentDefaultModel.currentSelection()).toMatchObject({ provider: 'neutral-test', model: 'local-model' })
  expect(scaffold.ctx.agents.get(twin.sessionId)!.model.current()).toMatchObject({ provider: 'neutral-test', model: 'local-model' })

  expect(accountRequests).toEqual([])
  await page.reload({ waitUntil: 'load' })
  await page.getByRole('button', { name: '设置', exact: true }).waitFor()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('dialog', { name: '设置', exact: true }).waitFor()
  expect(await page.getByRole('dialog', { name: '欢迎使用 Hemi', exact: true }).count()).toBe(0)
  expect(errors).toEqual([])
})
