import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it, onTestFinished, vi } from 'vitest'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { createBigModelTestProvider } from './fixtures/hemi/bigmodel-peer.mjs'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, webSnapshotMode } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

it('authorizes a subscription, shows its quota, and imports a New API token from the API dialog', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'hemi-model-access-test-'))
  onTestFinished(() => rm(scratch, { recursive: true, force: true }))
  const patch = join(scratch, 'hemi.patch.yml')
  await writeFile(patch, '- id: hemi-model-settings\n  disabled: false\n- id: hemi-model-settings-ui\n  disabled: false\n'
    + '- id: hemi-model-access\n  disabled: false\n- id: hemi-model-access-ui\n  disabled: false\n'
    + '- id: ui-settings-models\n  config:\n    showSettingsSection: false\n')
  const realFetch = globalThis.fetch
  const bigmodel = createBigModelTestProvider()
  bigmodel.state.pending = 1
  const access = `test.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } })).toString('base64url')}.test`
  let codexModels = ['codex-live-only-a', 'organization/model-with-a-long-name-and-extended-context-window-2026-11',
    ...Array.from({ length: 18 }, (_, index) => `catalog-model-${index + 1}`)]
  let catalogUnavailable = false
  let codexCatalogRequests = 0
  let glmCatalogRequests = 0
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.href === 'https://auth.openai.com/oauth/token') {
      expect(request.method).toBe('POST')
      expect(await request.text()).toContain('code=test-code')
      return Response.json({ access_token: access, refresh_token: 'test-refresh', expires_in: 3600 })
    }
    if (url.href === 'https://chatgpt.com/backend-api/wham/usage') {
      expect(request.headers.get('authorization')).toBe(`Bearer ${access}`)
      expect(request.headers.get('chatgpt-account-id')).toBe('test-account')
      return Response.json({ rate_limit: { primary_window: { limit_window_seconds: 604800, used_percent: 25 } } })
    }
    if (url.origin === 'https://chatgpt.com' && url.pathname === '/backend-api/codex/models') {
      codexCatalogRequests += 1
      expect(request.headers.get('authorization')).toBe(`Bearer ${access}`)
      expect(request.headers.get('chatgpt-account-id')).toBe('test-account')
      expect(request.cache).toBe('no-store')
      expect(url.searchParams.get('client_version')).toBeTruthy()
      if (catalogUnavailable) return new Response(null, { status: 503 })
      return Response.json({ models: [...codexModels.map(slug => ({ slug, visibility: 'list' })), { slug: 'hidden-model', visibility: 'hide' }] })
    }
    if (url.origin === 'https://zcode.z.ai' && url.pathname === '/api/v1/client/configs') {
      expect(request.headers.has('authorization')).toBe(false)
      return Response.json({ code: 0, data: { configs: { builtin_provider_config_json: 'https://cdn-zcode.z.ai/live-test-catalog.json' } } })
    }
    if (url.href === 'https://cdn-zcode.z.ai/live-test-catalog.json') {
      glmCatalogRequests += 1
      expect(request.headers.has('authorization')).toBe(false)
      expect(request.headers.has('x-api-key')).toBe(false)
      return Response.json({ config: { providerConfigRules: { providerRules: [{ config: {
        access: { accountType: 'bigmodel', mode: 'individual-coding-plan' },
        builtinModelIds: ['GLM-5.3', 'GLM-5.3-Flash', 'GLM-Live-New'],
      } }] } } })
    }
    if (['bigmodel.cn', 'open.bigmodel.cn', 'zcode.z.ai'].includes(url.hostname)) {
      const verified = bigmodel.reply(url.href, {
        headers: request.headers,
        body: await request.text(),
        method: request.method,
      })
      if (verified !== null) return verified
      if (url.pathname === '/api/monitor/usage/quota/limit') {
        expect(request.headers.get('authorization')).toMatch(/synthetic-project-1$/)
        return Response.json({ data: { limits: [{ type: 'CREDIT_LIMIT', unit: 3, usage: 100, remaining: 72 },
          { type: 'CREDIT_LIMIT', unit: 6, usage: 500, remaining: 300 }] } })
      }
      if (url.pathname === '/api/v1/ultra/anthropic/v1/messages') {
        const frames = [
          { type: 'message_start', message: { id: 'glm-test', model: 'glm-5.3', content: [], usage: { input_tokens: 3, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Signed GLM response' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
          { type: 'message_stop' },
        ]
        return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''), {
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      throw new Error('Unexpected GLM test endpoint.')
    }
    if (url.origin === 'https://newapi.example.test') {
      if (url.pathname === '/v1/models') {
        expect(request.headers.get('authorization')).toBe('Bearer sk-test-model-token')
        return Response.json({ data: [{ id: 'imported-model' }] })
      }
      expect(request.headers.get('authorization')).toBe('Bearer test-management-token')
      expect(request.headers.get('new-api-user')).toBe('42')
      switch (url.pathname) {
        case '/api/user/self':
          return Response.json({ success: true, data: { id: 42 } })
        case '/api/token/':
          return Response.json({ success: true, data: { items: [{ id: 8, name: 'Hemi key', group: 'team', status: 1 }], total: 1 } })
        case '/api/token/8/key':
          expect(request.method).toBe('POST')
          return Response.json({ success: true, data: { key: 'test-model-token' } })
        default:
          return new Response(null, { status: 404 })
      }
    }
    return realFetch(input, init)
  })
  onTestFinished(() => { fetch.mockRestore() })
  const scaffold = await launchWebScaffold({ developerTools: false, extraOverlayPath: patch })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE })
  const errors: Error[] = []
  page.on('pageerror', (error) => { errors.push(error) })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('button', { name: '模型接入', exact: true }).click()
  const panel = settings.getByRole('region', { name: '模型接入', exact: true })
  const codex = panel.getByRole('region', { name: 'ChatGPT Codex', exact: true })
  await codex.getByRole('button', { name: '登录授权', exact: true }).click()
  await panel.getByLabel('Select OpenAI Codex login method:').selectOption('browser')
  await panel.getByRole('button', { name: '继续', exact: true }).click()
  const authUrl = await panel.getByRole('link', { name: '打开授权页面' }).getAttribute('href')
  expect(new URL(authUrl ?? '').hostname).toBe('auth.openai.com')
  await panel.getByLabel(/paste the authorization code/).fill('test-code')
  await panel.getByRole('button', { name: '继续', exact: true }).click()
  await codex.getByText('剩余 75%', { exact: true }).waitFor()
  expect(await codex.getByRole('progressbar', { name: '周限' }).getAttribute('value')).toBe('75')
  const grant = await scaffold.ctx.credentials.describeRecord(credentialKey('llm-pi-ai', 'openai-codex'))
  expect(grant.kind).toBe('grant')
  expect(scaffold.ctx.llm.listProviders().some(provider => provider.id === 'openai-codex')).toBe(true)
  await codex.getByRole('button', { name: '拉取添加型号' }).click()
  const livePicker = page.getByRole('dialog', { name: '选择模型', exact: true })
  await livePicker.getByRole('checkbox', { name: 'codex-live-only-a', exact: true }).waitFor()
  expect(await livePicker.getByRole('checkbox', { name: 'hidden-model', exact: true }).count()).toBe(0)
  expect(await livePicker.getByText('从服务端获取当前型号列表，保留已有接入').count()).toBe(0)
  await livePicker.getByRole('checkbox', { name: 'codex-live-only-a', exact: true }).check()
  expect(await livePicker.getByRole('status').innerText()).toBe('已选 1 个')
  // Hemi fork: the shared Web scaffold verifies the model-access picker through the shipped composition.
  const pickerExpected = join(import.meta.dirname, 'expected/hemi-model-access/model-picker.expected.md')
  await compareOrRefreshGolden(pickerExpected,
    await captureStableAria(page, '[role="dialog"][aria-label="选择模型"]', scaffold.workspaceCwd), webSnapshotMode())
  const artifactRoot = join(import.meta.dirname, '../../../.artifacts')
  await mkdir(artifactRoot, { recursive: true })
  const pickerScreenshots = await mkdtemp(join(artifactRoot, 'model-picker-'))
  console.log(`Model picker screenshots: ${pickerScreenshots}`)
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
    await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(colorScheme === 'dark')
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 800, height: 390 }]) {
      await page.setViewportSize(viewport)
      const bounds = await livePicker.boundingBox()
      expect(bounds).not.toBeNull()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.y).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width)
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height)
      for (const action of ['取消', '添加选中型号']) {
        const button = await livePicker.getByRole('button', { name: action, exact: true }).boundingBox()
        expect(button).not.toBeNull()
        expect(button!.y + button!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height)
      }
      expect(await livePicker.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      const primaryContrast = await livePicker.getByRole('button', { name: '添加选中型号', exact: true }).evaluate((element) => {
        const style = getComputedStyle(element)
        const canvas = document.createElement('canvas')
        canvas.width = 1; canvas.height = 1
        const context = canvas.getContext('2d')!
        const luminance = (color: string): number => {
          context.fillStyle = color
          context.fillRect(0, 0, 1, 1)
          const channels = Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3).map((value) => {
            const normalized = value / 255
            return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
          })
          return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
        }
        const ink = luminance(style.color)
        const fill = luminance(style.backgroundColor)
        return (Math.max(ink, fill) + 0.05) / (Math.min(ink, fill) + 0.05)
      })
      expect(primaryContrast).toBeGreaterThanOrEqual(4.5)
      await page.screenshot({ path: join(pickerScreenshots, `${colorScheme}-${viewport.width}x${viewport.height}.png`) })
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.emulateMedia({ colorScheme: 'light' })
  codexModels = ['codex-live-only-b']
  await livePicker.getByRole('button', { name: '刷新', exact: true }).click()
  await livePicker.getByRole('checkbox', { name: 'codex-live-only-b', exact: true }).waitFor()
  expect(await livePicker.getByRole('checkbox', { name: 'codex-live-only-a', exact: true }).count()).toBe(0)
  await livePicker.getByRole('checkbox', { name: 'codex-live-only-b', exact: true }).check()
  await livePicker.getByRole('button', { name: '添加选中型号' }).click()
  await livePicker.waitFor({ state: 'detached' })
  expect((await scaffold.ctx.llm.listModels('openai-codex')).some(model => model.id === 'codex-live-only-b')).toBe(true)
  expect(codexCatalogRequests).toBe(3)
  catalogUnavailable = true
  await codex.getByRole('button', { name: '拉取添加型号' }).click()
  await livePicker.getByRole('alert').waitFor()
  expect(await livePicker.getByRole('checkbox').count()).toBe(0)
  await livePicker.getByRole('button', { name: '取消', exact: true }).click()
  catalogUnavailable = false

  const glm = panel.getByRole('region', { name: 'GLM Coding Plan', exact: true })
  await glm.getByRole('button', { name: '登录授权' }).click()
  const glmLink = await glm.getByRole('link', { name: '打开授权页面' }).getAttribute('href')
  expect(new URL(glmLink ?? '').hostname).toBe('bigmodel.cn')
  await glm.getByText('剩余 72%', { exact: true }).waitFor()
  const refreshQuota = glm.getByRole('button', { name: '刷新额度', exact: true })
  expect(await refreshQuota.innerText()).toBe('')
  expect(await refreshQuota.locator('svg').count()).toBe(1)
  await refreshQuota.hover()
  await page.getByRole('tooltip', { name: '刷新额度', exact: true }).waitFor()
  await refreshQuota.click()
  await expect.poll(() => refreshQuota.getAttribute('aria-busy')).toBe('false')
  expect(await glm.getByRole('progressbar', { name: '周限' }).getAttribute('value')).toBe('60')
  expect(await glm.getByRole('progressbar', { name: '5h' }).getAttribute('value')).toBe('72')
  expect((await scaffold.ctx.llm.listModels('bigmodel')).map(model => model.id)).toEqual(['glm-5.3', 'glm-5.3-flash'])
  const modelRow = glm.getByRole('group', { name: 'glm-5.3', exact: true })
  for (const name of ['模型设置', '测试', '删除型号']) {
    const action = modelRow.getByRole('button', { name, exact: true })
    expect(await action.innerText()).toBe('')
    expect(await action.locator('svg').count()).toBe(1)
  }
  await modelRow.getByRole('button', { name: '模型设置', exact: true }).hover()
  await page.getByRole('tooltip', { name: '模型设置', exact: true }).waitFor()
  await modelRow.getByRole('button', { name: '模型设置', exact: true }).click()
  const modelOptions = page.getByRole('dialog', { name: '模型设置', exact: true })
  await modelOptions.getByLabel('显示名称').fill('GLM Custom')
  await modelOptions.getByLabel('上下文长度（token）').fill('128000')
  await modelOptions.getByLabel('最大输出（token）').fill('2048')
  await modelOptions.getByRole('checkbox', { name: '图片', exact: true }).uncheck()
  await modelOptions.getByRole('button', { name: '保存模型设置', exact: true }).click()
  await modelOptions.waitFor({ state: 'detached' })
  expect(await scaffold.ctx.llm.resolveModelInfo('bigmodel', 'glm-5.3')).toMatchObject({
    name: 'GLM Custom', context: { contextWindow: 128000 }, defaultMaxTokens: 2048, inputModalities: ['text'],
  })
  expect((await scaffold.ctx.llm.listModels('bigmodel')).map(model => model.id)).toEqual(['glm-5.3', 'glm-5.3-flash'])
  for (const model of ['glm-5.3', 'glm-5.3-flash']) {
    page.once('dialog', (dialog) => { void dialog.accept() })
    await glm.getByRole('group', { name: model, exact: true }).getByRole('button', { name: '删除型号' }).click()
    await glm.getByRole('group', { name: model, exact: true }).waitFor({ state: 'detached' })
  }
  expect(await scaffold.ctx.llm.listModels('bigmodel')).toEqual([])
  expect((await scaffold.ctx.credentials.describeRecord(credentialKey('llm-pi-ai', 'bigmodel'))).kind).toBe('grant')
  await glm.getByRole('button', { name: '拉取添加型号' }).click()
  const modelPicker = page.getByRole('dialog', { name: '选择模型', exact: true })
  await modelPicker.getByRole('checkbox', { name: 'glm-5.3', exact: true }).check()
  await modelPicker.getByRole('checkbox', { name: 'glm-5.3-flash', exact: true }).check()
  await modelPicker.getByRole('checkbox', { name: 'GLM-Live-New', exact: true }).check()
  await modelPicker.getByRole('button', { name: '添加选中型号' }).click()
  await modelPicker.waitFor({ state: 'detached' })
  await glm.getByRole('group', { name: 'glm-5.3-flash', exact: true }).waitFor()
  expect((await scaffold.ctx.llm.listModels('bigmodel')).map(model => model.id)).toEqual(['glm-5.3', 'glm-5.3-flash', 'GLM-Live-New'])
  expect(await scaffold.ctx.llm.resolveModelInfo('bigmodel', 'GLM-Live-New')).toMatchObject({ id: 'GLM-Live-New', provider: 'bigmodel' })
  expect(glmCatalogRequests).toBe(4)
  const chunks = []
  for await (const chunk of scaffold.ctx.llm.stream({
    provider: 'bigmodel', model: 'glm-5.3', messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
  })) chunks.push(chunk)
  expect(chunks).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'finish', reason: { kind: 'stop' } })]))
  expect(bigmodel.state).toMatchObject({ issued: 1, handshakes: 1, modelCalls: 1 })

  expect(await panel.getByRole('tab').count()).toBe(2)
  await panel.getByRole('tab', { name: 'API', exact: true }).click()
  await panel.getByRole('button', { name: '接入 New API', exact: true }).click()
  const newApi = page.getByRole('dialog', { name: '接入 New API', exact: true })
  const expected = join(import.meta.dirname, 'expected/hemi-model-access')
  await mkdir(expected, { recursive: true })
  await compareOrRefreshGolden(join(expected, 'existing-token.expected.md'),
    await captureStableAria(page, '[role="dialog"][aria-label="接入 New API"]', scaffold.workspaceCwd), webSnapshotMode())
  await newApi.getByLabel('HTTPS 站点地址').fill('https://newapi.example.test')
  await newApi.getByLabel('New API 用户 ID').fill('42')
  await newApi.getByLabel('系统访问令牌').fill('test-management-token')
  await newApi.getByRole('button', { name: '读取 API 令牌' }).click()
  const token = newApi.getByRole('combobox')
  await token.selectOption('8', { timeout: 5000 }).catch(async (error: unknown) => {
    throw new Error(await newApi.innerText(), { cause: error })
  })
  await newApi.getByRole('button', { name: '导入模型' }).click()
  await newApi.getByText('已导入 1 个模型，可在「模型接入」中管理。').waitFor()
  expect(await newApi.getByLabel('系统访问令牌').inputValue()).toBe('')
  await newApi.getByRole('button', { name: '完成', exact: true }).click()
  await newApi.waitFor({ state: 'detached' })
  await panel.getByRole('group', { name: 'imported-model', exact: true }).waitFor()
  const imported = scaffold.ctx.llm.listProviders().find(provider => provider.id.startsWith('new-api-'))
  expect(imported).toBeDefined()
  expect(await scaffold.ctx.llm.listModels(imported!.id)).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'imported-model' })]))
  const config = await readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')
  expect(config).not.toMatch(/test-management-token|test-model-token|test-refresh/)
  expect(errors).toEqual([])
})

it('guides desktop New API sign-in and token creation in one responsive dialog', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'hemi-newapi-dialog-test-'))
  onTestFinished(() => rm(scratch, { recursive: true, force: true }))
  const patch = join(scratch, 'hemi.patch.yml')
  await writeFile(patch, '- id: hemi-model-settings\n  disabled: false\n- id: hemi-model-settings-ui\n  disabled: false\n'
    + '- id: hemi-model-access\n  disabled: false\n- id: hemi-model-access-ui\n  disabled: false\n')
  const scaffold = await launchWebScaffold({ developerTools: false, extraOverlayPath: patch })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1280, height: 820 }, hasTouch: true })
  const login = {
    operationId: 'dialog-import', revision: 1, phase: 'login', control: 'user', siteOrigin: 'https://newapi.example.test',
    accountLabel: null, tokenName: null, groups: [], candidates: [], candidatesGroup: null, can: { checkLogin: true, cancel: true },
  }
  const selecting = {
    ...login, revision: 2, phase: 'selecting', accountLabel: 'Fixture user',
    groups: [{ name: 'team', desc: 'Team' }], candidatesGroup: 'team',
    candidates: [{ modelName: 'fixture-model', apis: ['openai-completions'], unsupported: [] }],
    selection: { group: 'team', budgetMode: 'unlimited', expiryMode: 'never', models: [] },
    can: { setSelection: true, submit: true, cancel: true },
  }
  const preview = {
    ...selecting, revision: 3,
    preview: { planHash: 'fixture-plan', providers: [{ name: 'New API team', api: 'openai-completions',
      baseUrl: 'https://newapi.example.test/v1', models: ['fixture-model'] }] },
  }
  const creating = { ...preview, revision: 4, phase: 'creating', tokenName: 'Hemi-fixture', can: { pause: true, cancel: true } }
  const success = { ...creating, revision: 5, phase: 'success', result: { providerIds: ['new-api-fixture'], modelKeys: ['fixture-model'] }, can: {} }
  let current: object | null = null
  let finish = false
  const calls: { action: string; fields: Record<string, unknown> }[] = []
  await page.exposeFunction('hemiNewApiInvoke', async (action: string, fields: Record<string, unknown> = {}) => {
    calls.push({ action, fields })
    if (action === 'start') current = login
    else if (action === 'checkLogin') current = selecting
    else if (action === 'setSelection') current = preview
    else if (action === 'submit') current = creating
    else if (action === 'getState' && finish) current = success
    return { ok: true, state: current, pending: [] }
  })
  // Only the native IPC endpoint is replaced; settings, Modal, forms and Host composition are real.
  await page.addInitScript('globalThis.dshDesktop = { protocolVersion: 1, newApiImport: { invoke: (...args) => globalThis.hemiNewApiInvoke(...args) } }')
  const errors: Error[] = []
  page.on('pageerror', (error) => { errors.push(error) })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('button', { name: '模型接入', exact: true }).click()
  const panel = settings.getByRole('region', { name: '模型接入', exact: true })
  await panel.getByRole('tab', { name: 'API', exact: true }).click()
  const entry = panel.getByRole('button', { name: '接入 New API', exact: true })
  await entry.click()
  const dialog = page.getByRole('dialog', { name: '接入 New API', exact: true })
  expect(await dialog.getByLabel('站点协议').inputValue()).toBe('https')
  await dialog.getByLabel('New API 站点地址').fill('newapi.example.test')
  await dialog.getByRole('button', { name: '打开站点登录', exact: true }).click()
  await dialog.getByRole('button', { name: '登录完成，继续', exact: true }).waitFor()
  expect(await dialog.locator('li[aria-current="step"]').innerText()).toBe('登录站点')
  const expected = join(import.meta.dirname, 'expected/hemi-model-access')
  await mkdir(expected, { recursive: true })
  await compareOrRefreshGolden(join(expected, 'desktop-sign-in.expected.md'),
    await captureStableAria(page, '[role="dialog"][aria-label="接入 New API"]', scaffold.workspaceCwd), webSnapshotMode())
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 820 })
    await expect.poll(() => {
      const bounds = calls.filter(call => call.action === 'setBrowserBounds').at(-1)?.fields.bounds
      if (bounds === null || typeof bounds !== 'object') return false
      const { x, y, width: viewWidth, height } = bounds as { x: number; y: number; width: number; height: number }
      return x >= 24 && y >= 24 && x + viewWidth <= width - 24 && height >= 300
    }).toBe(true)
    expect(await dialog.getByRole('button', { name: '登录完成，继续', exact: true }).isVisible()).toBe(true)
  }
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })
  await expect.poll(() => calls.filter(call => call.action === 'setBrowserBounds').at(-1)?.fields.bounds).toBe(null)
  expect(await entry.evaluate(element => element === document.activeElement)).toBe(true)
  expect(calls.some(call => call.action === 'cancel')).toBe(false)
  await entry.click()
  await dialog.getByRole('button', { name: '登录完成，继续', exact: true }).click()
  await dialog.getByRole('checkbox', { name: 'fixture-model', exact: true }).check({ timeout: 5000 }).catch(async (error: unknown) => {
    throw new Error(`${await dialog.innerText()}\n${JSON.stringify(calls)}`, { cause: error })
  })
  await dialog.getByLabel('额度（美元，留空则不限）').fill('8')
  await dialog.getByLabel('有效期（天，留空则长期有效）').fill('7')
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })
  await entry.click()
  expect(await dialog.getByLabel('额度（美元，留空则不限）').inputValue()).toBe('8')
  expect(await dialog.getByRole('checkbox', { name: 'fixture-model', exact: true }).isChecked()).toBe(true)
  const importModels = dialog.getByRole('button', { name: '导入模型', exact: true })
  await importModels.waitFor()
  expect(calls.some(call => call.action === 'submit')).toBe(false)
  await compareOrRefreshGolden(join(expected, 'desktop-selection.expected.md'),
    await captureStableAria(page, '[role="dialog"][aria-label="接入 New API"]', scaffold.workspaceCwd), webSnapshotMode())
  const artifactsRoot = join(import.meta.dirname, '../../../.artifacts')
  await mkdir(artifactsRoot, { recursive: true })
  const shots = await mkdtemp(join(artifactsRoot, 'newapi-dialog-'))
  console.log(`New API dialog screenshots: ${shots}`)
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 820 })
    for (const dark of [false, true]) {
      await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light', reducedMotion: 'reduce' })
      await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(dark)
      const geometry = await dialog.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
          overflow: element.scrollWidth - element.clientWidth, pageOverflow: document.documentElement.scrollWidth - innerWidth,
          inputFont: parseFloat(getComputedStyle(element.querySelector('input[type="number"]')!).fontSize) }
      })
      expect(geometry.left).toBeGreaterThanOrEqual(23)
      expect(geometry.right).toBeLessThanOrEqual(width - 23)
      expect(geometry.top).toBeGreaterThanOrEqual(23)
      expect(geometry.bottom).toBeLessThanOrEqual(797)
      expect(geometry.overflow).toBeLessThanOrEqual(1)
      expect(geometry.pageOverflow).toBeLessThanOrEqual(1)
      expect(geometry.inputFont).toBeGreaterThanOrEqual(16)
      await page.screenshot({ path: join(shots, `selection-${width}-${dark ? 'dark' : 'light'}.png`), animations: 'disabled' })
    }
  }
  await importModels.click()
  await dialog.getByText('正在创建令牌、验证模型并保存接入…', { exact: true }).waitFor()
  expect(await dialog.locator('li[aria-current="step"]').innerText()).toBe('创建并导入')
  finish = true
  await dialog.getByRole('button', { name: '完成', exact: true }).waitFor()
  expect(await dialog.getByLabel('New API 站点地址').count()).toBe(0)
  await compareOrRefreshGolden(join(expected, 'desktop-success.expected.md'),
    await captureStableAria(page, '[role="dialog"][aria-label="接入 New API"]', scaffold.workspaceCwd), webSnapshotMode())
  await dialog.getByRole('button', { name: '完成', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  expect(calls.filter(call => call.action === 'start')).toHaveLength(1)
  expect(calls.find(call => call.action === 'start')?.fields).toMatchObject({ siteUrl: 'https://newapi.example.test' })
  expect(calls.find(call => call.action === 'setSelection')?.fields).toMatchObject({ selection: {
    group: 'team', models: [{ modelName: 'fixture-model' }], budgetUsd: 8, expiryDays: 7,
  } })
  expect(calls.filter(call => call.action === 'submit')).toEqual([{
    action: 'submit', fields: { planHash: 'fixture-plan', operationId: 'dialog-import', revision: 3 },
  }])
  await entry.click()
  await dialog.getByLabel('站点协议').selectOption('http')
  await dialog.getByLabel('New API 站点地址').fill('another.example.test:8080')
  finish = false
  await dialog.getByRole('button', { name: '打开站点登录', exact: true }).click()
  await dialog.getByRole('button', { name: '登录完成，继续', exact: true }).waitFor()
  expect(calls.filter(call => call.action === 'start')).toHaveLength(2)
  expect(calls.filter(call => call.action === 'start')[1]?.fields).toMatchObject({ siteUrl: 'http://another.example.test:8080' })
  expect(errors).toEqual([])
})
