/** Real Hemi model selection and persistence with synthetic credentials and inference responses. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, webkit } from 'playwright'
import { expect, it, onTestFailed, onTestFinished, vi } from 'vitest'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { normalizeSessionSnapshots } from '@deepseek-ai/dsh-session-snapshot'
import type {} from '@deepseek-ai/dsh-hemi-model-access'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, normalizeWebSessionVolatiles,
  rawSessionLog, readPersistedEvents, recordFixture, watchConsole, webSnapshotMode,
} from './scaffold.ts'
import { connectFreshWorkspaceZh, REPO_ROOT, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const CUSTOM = 'reasoning-custom'
const DISABLED = 'reasoning-disabled'
const MODEL = 'deepseek-flash'
const GROUP = '满血国模-deepseek'
const ORIGIN = 'https://cf.vvcode.top'
const CUSTOM_ORIGIN = 'https://reasoning.example.test'
const GROUP_PROVIDER = `vvcode-group-${createHash('sha256').update(JSON.stringify([ORIGIN, '42', GROUP])).digest('hex').slice(0, 16)}`
const GROUP_KEY = 'sk-synthetic-deepseek-group-key'
const CUSTOM_KEY = 'sk-synthetic-custom-key'
const GROUP_REF = credentialRef('HEMI_REASONING_GROUP_TEST_KEY')
const CUSTOM_REF = credentialRef('HEMI_REASONING_CUSTOM_TEST_KEY')
const EXPECTED = join(import.meta.dirname, 'expected/hemi-model-reasoning')
const SESSION = join(REPO_ROOT, 'snapshots/web/hemi-model-reasoning/session.v4.jsonl')
const NATIVE_LEVELS = ['Default', 'Off', 'Low', 'High', 'Max']
const OPENAI_LEVELS = ['Off', 'Minimal', 'Low', 'Medium', 'High', 'Xhigh', 'Max']

interface InferenceRequest {
  origin: string
  key: string | null
  app: string | null
  model: string
  reasoning_effort?: string
  thinking?: { type: string }
}

it.skipIf(webSnapshotMode() === 'record').each([
  { name: 'Chromium', engine: chromium },
  { name: 'WebKit', engine: webkit },
])('inherits model reasoning into the shipped Hemi picker and saves the selected effort ($name)', async ({ engine }) => {
  const scratch = await mkdtemp(join(tmpdir(), 'hemi-model-reasoning-'))
  onTestFinished(() => rm(scratch, { recursive: true, force: true }))
  const patch = join(scratch, 'reasoning.patch.yml')
  await writeFile(patch, '- id: hemi-model-access\n  disabled: false\n- id: hemi-routing-ui\n  disabled: false\n'
    + '- id: ui-model-selection\n  config:\n    showComposer: false\n'
    + `- id: agent-default-model\n  config:\n    provider: ${CUSTOM}\n    model: ${MODEL}\n`)

  const fixture = await readFile(SESSION, 'utf8')
  const recorded = parseSessionLog(fixture)
  const user = recorded.find(event => event.type === 'user/message')
  const assistant = recorded.find(event => event.type === 'assistant/message')
  if (user === undefined || assistant === undefined) throw new Error('The reasoning Session requires a user and assistant message')
  const prompt = user.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
  const answer = assistant.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
  const requests: InferenceRequest[] = []
  const unexpected: string[] = []
  const realFetch = globalThis.fetch
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init)
    if ([ORIGIN, CUSTOM_ORIGIN].includes(url.origin) && url.pathname === '/v1/chat/completions') {
      expect(request.method).toBe('POST')
      const body = await request.json() as Pick<InferenceRequest, 'model' | 'reasoning_effort' | 'thinking'>
      const key = request.headers.get('authorization')
      expect(key).toBe(`Bearer ${url.origin === ORIGIN ? GROUP_KEY : CUSTOM_KEY}`)
      const app = request.headers.get('x-ai-app')
      if (url.origin === ORIGIN) expect(app).toBe('hemi-dsh')
      requests.push({ origin: url.origin, key, app, ...body })
      const base = { id: `chatcmpl-reasoning-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: body.model }
      return new Response([
        { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
      ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    unexpected.push(`${request.method} ${url.origin}${url.pathname}`)
    throw new Error(`The reasoning fixture refuses external traffic: ${request.method} ${url.origin}${url.pathname}`)
  })
  onTestFinished(() => { fetchSpy.mockRestore() })

  const scaffold = await launchWebScaffold({ developerTools: false, extraOverlayPath: patch })
  onTestFinished(() => scaffold.close())
  const access = scaffold.ctx.get('hemiModelAccess')
  if (access === undefined) throw new Error('The shipped Hemi model-access row did not mount')
  await scaffold.ctx.credentials.set(CUSTOM_REF, CUSTOM_KEY)
  await scaffold.ctx.credentials.set(GROUP_REF, GROUP_KEY)
  await scaffold.ctx.credentials.modifyRecord(credentialKey('hemi-model-access', 'vvcode'), () => Promise.resolve({
    kind: 'grant', payload: {
      version: 2, origin: ORIGIN, accessToken: 'nap_synthetic_reasoning_account', userId: 42,
      expiresAt: Date.now() + 3_600_000, scopes: ['profile:read', 'api_key:read', 'api_key:write', 'api_key:reveal'], pending: {},
    },
  }))
  await scaffold.ctx.settings.update('llm-pi-ai', { providers: {
    [CUSTOM]: {
      displayName: 'Custom gateway', api: 'openai-completions', baseURL: `${CUSTOM_ORIGIN}/v1`, apiKeyEnv: CUSTOM_REF,
      models: [
        { id: MODEL, name: 'DeepSeek custom' },
        { id: 'reasoning-unknown-fixture', name: 'Unknown model' },
        { id: 'gpt-4o', name: 'Catalog non-reasoning' },
      ],
    },
    [DISABLED]: {
      displayName: 'Disabled gateway', api: 'openai-completions', baseURL: `${CUSTOM_ORIGIN}/v1`, apiKeyEnv: CUSTOM_REF,
      models: [{ id: MODEL, name: 'Explicitly disabled', reasoningEfforts: false }],
    },
  } })
  // Saved group bindings are fixture input; no account, directory, or token-creation request runs.
  await scaffold.ctx.settings.update('hemi-model-access', { vvcodeConnections: { [GROUP]: {
    origin: ORIGIN, group: GROUP, userId: '42', tokenId: 8, provider: GROUP_PROVIDER, apiKeyRef: GROUP_REF,
    models: [{ id: MODEL, api: 'openai-completions' }], selected: [MODEL], ratio: 1, desc: 'Synthetic group',
  } } })
  await access.saveVvcodeModels([{ provider: GROUP_PROVIDER, models: [MODEL] }], new AbortController().signal)
  const customModel = await scaffold.ctx.llm.resolveModelInfo(CUSTOM, MODEL)
  const groupModel = await scaffold.ctx.llm.resolveModelInfo(GROUP_PROVIDER, MODEL)
  for (const model of [customModel, groupModel]) {
    expect(model.reasoning?.efforts.map(level => level.id), model.provider).toEqual(['off', 'low', 'high', 'max'])
  }
  expect(groupModel.name.endsWith(` · ${GROUP}`)).toBe(true)

  const browser = await engine.launch()
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, timezoneId: 'Asia/Shanghai', viewport: { width: 1280, height: 900 } })
  onTestFailed(() => saveFailureShot(page, `hemi-model-reasoning-${engine.name()}`))
  const tripwire = watchConsole(page)
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin === scaffold.baseUrl || !['http:', 'https:'].includes(url.protocol)) await route.continue()
    else {
      unexpected.push(`browser ${url.origin}${url.pathname}`)
      await route.abort('blockedbyclient')
    }
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  const modelButton = page.getByRole('button', { name: /^选择模型/ })
  const effortButton = page.getByRole('button', { name: '推理等级', exact: true })
  const menu = page.getByRole('menu')
  const golden = async (name: string, selector = '[role="menu"]'): Promise<void> => {
    await compareOrRefreshGolden(join(EXPECTED, `${name}.expected.md`),
      await captureStableAria(page, selector, scaffold.workspaceCwd), webSnapshotMode())
  }
  const selectModel = async (name: string): Promise<void> => {
    await modelButton.click()
    await page.getByRole('menuitemradio', { name, exact: true }).click()
    await menu.waitFor({ state: 'detached' })
    await expect.poll(() => modelButton.textContent(), { timeout: 10_000 }).toBe(name)
  }
  const openEfforts = async (levels: string[]): Promise<void> => {
    await effortButton.click()
    await expect.poll(() => menu.getByRole('menuitem').allTextContents()).toEqual(levels)
  }
  await mkdir(EXPECTED, { recursive: true })
  await effortButton.waitFor()
  await openEfforts(NATIVE_LEVELS)
  await golden('custom-efforts')
  await page.getByRole('menuitem', { name: 'Low', exact: true }).click()
  await expect.poll(() => scaffold.ctx.agentDefaultModel.currentSelection(), { timeout: 10_000 })
    .toEqual({ provider: CUSTOM, model: MODEL, reasoningEffort: 'low' })
  await expect.poll(() => effortButton.evaluate(node => node === document.activeElement)).toBe(true)

  await selectModel('Unknown model')
  await expect.poll(() => effortButton.textContent()).toBe('Medium')
  await openEfforts(OPENAI_LEVELS)
  await golden('unknown-efforts')
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'detached' })
  for (const name of ['Catalog non-reasoning', 'Explicitly disabled']) {
    await selectModel(name)
    await expect.poll(() => effortButton.count()).toBe(0)
    const provider = name === 'Catalog non-reasoning' ? CUSTOM : DISABLED
    const id = name === 'Catalog non-reasoning' ? 'gpt-4o' : MODEL
    expect((await scaffold.ctx.llm.resolveModelInfo(provider, id)).reasoning).toBeUndefined()
  }

  await selectModel(groupModel.name)
  await openEfforts(NATIVE_LEVELS)
  await golden('group-efforts')
  await page.getByRole('menuitem', { name: 'High', exact: true }).click()
  await expect.poll(() => scaffold.ctx.agentDefaultModel.currentSelection(), { timeout: 10_000 })
    .toEqual({ provider: GROUP_PROVIDER, model: MODEL, reasoningEffort: 'high' })
  await expect.poll(async () => readFile(join(scaffold.harnessHome, 'profiles/scaffold/cordis.patch.yml'), 'utf8'), { timeout: 10_000 })
    .toContain('reasoningEffort: high')

  const input = page.locator('[data-composer-input][contenteditable="true"]').first()
  const settled = scaffold.whenTurnSettled()
  await input.fill(prompt)
  await input.press('Enter')
  const sessionId = await settled
  await page.getByText(answer, { exact: true }).waitFor()
  const persisted = await readPersistedEvents(scaffold, sessionId)
  const header = persisted.filter(event => event.type === 'request/header').at(-1)
  expect(header?.data.header.config).toMatchObject({ provider: GROUP_PROVIDER, model: MODEL, reasoningEffort: 'high' })
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({ origin: ORIGIN, model: MODEL, reasoning_effort: 'high', key: `Bearer ${GROUP_KEY}`, app: 'hemi-dsh' })
  const agent = scaffold.ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error('The reasoning Session must remain available after settlement')
  if (webSnapshotMode() === 'refresh') await recordFixture(scaffold, sessionId, SESSION)
  const expectedSession = await readFile(SESSION, 'utf8')
  const actualSnapshot = normalizeSessionSnapshots([normalizeWebSessionVolatiles(rawSessionLog(agent.session))], {
    sessionIds: [String(sessionId)], cwd: scaffold.workspaceCwd,
  })[0]?.split(scaffold.harnessHome).join('{{harnessHome}}')
  const expectedSnapshot = normalizeSessionSnapshots([normalizeWebSessionVolatiles(expectedSession)], {
    sessionIds: ['{{session:1}}'], cwd: '{{cwd}}',
  })[0]
  expect(actualSnapshot).toBe(expectedSnapshot)
  await page.reload({ waitUntil: 'load' })
  await page.getByText(answer, { exact: true }).waitFor()
  await expect.poll(() => effortButton.textContent()).toBe('High')
  await openEfforts(NATIVE_LEVELS)
  await golden('saved-group-efforts')
  await page.keyboard.press('Escape')
  await mkdir(join(REPO_ROOT, '.artifacts'), { recursive: true })
  const screenshots = await mkdtemp(join(REPO_ROOT, '.artifacts/hemi-model-reasoning-'))
  console.log(`Hemi reasoning screenshots (${engine.name()}): ${screenshots}`)
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 })
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
      await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(colorScheme === 'dark')
      await openEfforts(NATIVE_LEVELS)
      await expect.poll(() => menu.evaluate((node) => {
        const box = node.getBoundingClientRect()
        return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight
          && node.scrollWidth <= node.clientWidth
      })).toBe(true)
      await page.mouse.move(0, 0)
      await page.screenshot({ path: join(screenshots, `group-${colorScheme}-${width}.png`), animations: 'disabled' })
      await page.keyboard.press('Escape')
      await menu.waitFor({ state: 'detached' })
      await expect.poll(() => effortButton.evaluate(node => node === document.activeElement)).toBe(true)
    }
  }
  expect(unexpected).toEqual([])
  expect(tripwire.pageErrors).toEqual([])
})
