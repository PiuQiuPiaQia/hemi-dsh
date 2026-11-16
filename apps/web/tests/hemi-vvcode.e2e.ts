import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Locator } from 'playwright'
import { expect, it, onTestFinished, vi } from 'vitest'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
// Type-only import: carries the Context merge that types `ctx.get('hemiModelAccess')`.
import type {} from '@deepseek-ai/dsh-hemi-model-access'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, webSnapshotMode } from './scaffold.ts'
import { REPO_ROOT, ZH_BROWSER_LOCALE } from './support.ts'

const VVCODE_ORIGIN = 'https://cf.vvcode.top'
const VVCODE_RECORD = credentialKey('hemi-model-access', 'vvcode')
const VVCODE_APP = 'hemi-dsh'
const TEAM_MODEL_KEY = 'sk-vvcode-team-model-key'
const SOLO_MODEL_KEY = 'sk-vvcode-solo-model-key'
const MANUAL_MODEL_KEY = 'sk-manual-connection-key'
const TEAM_GROUP_DESC = '团队共享额度池，按当月合约价统一结算，覆盖全部旗舰与实验模型；管理员可在控制台为每位成员分配预算上限，超额后自动回落到成员的个人额度，不影响团队内其他成员的使用。'
// The save confirm names the dirty unconnected groups in directory order (solo, team).
const SAVE_CONFIRM = '保存启用以下 VVCode 分组的模型：solo, team？将为这些分组创建或复用 Hemi 专用调用 Key，不设独立额度和期限，仍受账号余额与分组权限限制'
const DISCONNECT_CONFIRM = '从 Hemi 移除此 VVCode 连接？如需撤销账号授权，请前往 VVCode 网页管理授权令牌'
const CARD_SELECTOR = 'section[aria-label="VVCode"]'
const MANAGE_TITLE = '管理分组与模型'
const MODAL_SELECTOR = `[role="dialog"][aria-label="${MANAGE_TITLE}"]`
// UI copy pinned by the model-access-ui singleflight directory change (vvcodeRefreshDirectory,
// the reused loading key, vvcodeGroupSyncFailed, vvcodeGroupUnavailable); move these only with
// that source's frozen strings, never through a snapshot normalizer edit.
const REFRESH_DIRECTORY = '刷新目录'
const REFRESHING_DIRECTORY = '正在读取…'
const GROUP_CATALOG_RETRY_HINT = '此分组目录读取失败，其他分组不受影响；请点击「刷新目录」重试'
const GROUP_REVOKED_HINT = '此分组已无授权，请向 VVCode 确认分组权限后刷新目录'

/**
 * Directory row view mirrored from `@deepseek-ai/dsh-hemi-model-access/types`; the host
 * assertions pin this wire contract, including the read-only catalog facts.
 */
interface DirectoryGroupRow {
  name: string
  desc: string
  ratio: number | 'auto' | null
  provider: string
  state: 'not-synced' | 'ready' | 'unavailable' | 'creation-unknown'
  /** Whether a saved binding with the group's calling key exists. */
  hasConnection: boolean
  /** Whether the read-only model read failed in the latest directory pass. */
  catalogError: boolean
  models: { id: string; enabled: boolean }[]
}

/** Directory view mirrored from `@deepseek-ai/dsh-hemi-model-access/types`. */
interface DirectoryRow {
  state: 'ready' | 'unavailable' | 'sign-in-required'
  groups: DirectoryGroupRow[]
}

/** One application token VVCode issued for a selected group. */
interface FixtureToken {
  id: number
  name: string
  group: string
  userId: number
  key: string
}

/**
 * Synthetic VVCode peer: answers only `https://cf.vvcode.top` and asserts every
 * request's credential discipline (management PAT never reaches `/v1`, the
 * model key never reaches management endpoints, `X-AI-App` marks app traffic).
 * Group browsing is fully read-only: `/api/desktop/groups` lists metadata and
 * `/api/user/models?group=…` lists each group's model IDs under the scoped PAT,
 * so opening the dialog never creates or reveals a key. Calling keys are only
 * prepared when a save enables a not-yet-connected group, and `/v1/models` per
 * group key stays the relay metadata authority. The team and solo keys both
 * advertise `vv-model-a` so the same model id can be enabled per group.
 */
function createVvcodePeer() {
  const state = {
    tokens: [] as FixtureToken[],
    nextTokenId: 8,
    groupsMode: 'ok' as 'ok' | 'empty' | 'fail',
    usageMode: 'ok' as 'ok' | 'empty' | 'fail' | 'forbidden',
    soloCatalogMode: 'ok' as 'ok' | 'fail',
    walletScope: true,
    walletQuota: 2_500_000,
    groupsGate: undefined as Promise<void> | undefined,
    releaseGroups: undefined as (() => void) | undefined,
    modelsGate: undefined as Promise<void> | undefined,
    releaseModels: undefined as (() => void) | undefined,
    loginStartUrls: [] as string[],
    grants: [] as { accessToken: string; userId: number; expiresAt: number; scopes: string[] }[],
    selfRequests: 0,
    groupListReads: 0,
    tokenCreates: 0,
    tokenKeyCalls: 0,
    tokenSearches: 0,
    tokenDetails: [] as number[],
    groupModelReads: [] as { group: string; key: string | null }[],
    relayKeyReads: [] as { key: string | null; appHeader: string | null }[],
    chatRequests: [] as { key: string | null; appHeader: string | null; model: string; tools: string[] }[],
  }
  const tokenView = (token: FixtureToken) => ({
    id: token.id, user_id: token.userId, name: token.name, group: token.group, status: 1, expired_time: -1,
  })
  const envelope = (data: unknown): Response => Response.json({ success: true, data })
  const groupCatalog = (group: string): string[] =>
    group === 'team' ? ['vv-model-a', 'vv-model-b']
      : group === 'solo' ? ['vv-model-a', 'vv-model-solo'] : []
  const relayKeyModels = (key: string): unknown[] =>
    key === TEAM_MODEL_KEY
      ? [{ id: 'vv-model-a', supported_endpoint_types: ['openai'] }, { id: 'vv-model-b', supported_endpoint_types: ['openai'] }]
      : key === SOLO_MODEL_KEY
        ? [{ id: 'vv-model-a', supported_endpoint_types: ['openai'] }, { id: 'vv-model-solo', supported_endpoint_types: ['openai'] }]
        : key === MANUAL_MODEL_KEY ? [{ id: 'manual-kept-model' }] : []
  const holdNextGroupsRead = (): void => {
    state.groupsGate = new Promise<void>((resolve) => { state.releaseGroups = resolve })
  }
  const holdNextGroupModelsRead = (): void => {
    state.modelsGate = new Promise<void>((resolve) => { state.releaseModels = resolve })
  }

  /** Hold one armed fixture gate until it is released or the caller aborts. */
  async function awaitGate(gate: Promise<void> | undefined, request: Request): Promise<void> {
    if (gate === undefined) return
    await new Promise<void>((release, rejectAborted) => {
      const onAbort = (): void => {
        rejectAborted(new Error('Fixture read aborted by the caller', { cause: request.signal.reason }))
      }
      if (request.signal.aborted) {
        onAbort()
        return
      }
      request.signal.addEventListener('abort', onAbort, { once: true })
      void gate.then(() => {
        request.signal.removeEventListener('abort', onAbort)
        release()
      }, rejectAborted)
    })
  }

  /** @param request - The host-side request about to leave the process. @returns the synthetic response, or null for other origins. */
  async function reply(request: Request): Promise<Response | null> {
    const url = new URL(request.url)
    if (url.origin !== VVCODE_ORIGIN) return null
    const authorization = request.headers.get('authorization')
    const bearer = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : null
    const appHeader = request.headers.get('x-ai-app')
    if (url.pathname === '/api/oauth/vscode/token') {
      expect(request.method).toBe('POST')
      const form = new URLSearchParams(await request.text())
      expect(form.get('grant_type')).toBe('authorization_code')
      expect(form.get('code')).toBe('test-code')
      expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/)
      expect(form.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
      const startUrl = state.loginStartUrls.map(href => new URL(href))
        .find(started => started.searchParams.get('state') === form.get('state'))
      expect(startUrl, 'the exchanged state must pair with the presented login URL').toBeDefined()
      expect(startUrl!.searchParams.get('redirect_uri')).toBe(form.get('redirect_uri'))
      expect(startUrl!.searchParams.get('code_challenge'))
        .toBe(createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url'))
      const grant = {
        accessToken: `nap_vvcode_synthetic_pat_${state.grants.length + 1}`,
        userId: 42,
        expiresAt: (Math.floor(Date.now() / 1000) + 3600) * 1000,
        scopes: ['api_key:read', 'api_key:reveal', 'api_key:write', 'profile:read',
          ...state.walletScope ? ['wallet:read'] : []],
      }
      state.grants.push(grant)
      return Response.json({
        access_token: grant.accessToken, token_type: 'Bearer', expires_at: grant.expiresAt / 1000,
        user_id: grant.userId, scope: grant.scopes.join(' '),
      })
    }
    if (url.pathname === '/api/status') {
      expect(authorization).toBeNull()
      return envelope({ quota_per_unit: 500_000, quota_display_type: 'USD' })
    }
    if (url.pathname === '/api/subscription/self') {
      expect(bearer).toMatch(/^nap_/)
      expect(appHeader).toBe(VVCODE_APP)
      if (state.usageMode === 'fail') return new Response(null, { status: 503 })
      if (state.usageMode === 'forbidden') return new Response(null, { status: 403 })
      const now = Math.floor(Date.now() / 1000)
      const ended = { id: 99, amount_total: 10_000_000, amount_used: 0, status: 'expired',
        user_id: 42, start_time: now - 7200, end_time: now - 3600, next_reset_time: 0 }
      return envelope({
        subscriptions: state.usageMode === 'empty' ? [] : [
          { subscription: { id: 1, user_id: 42, amount_total: 1_000_000, amount_used: 250_000,
            status: 'active', start_time: now - 3600, end_time: 2_000_000_000, next_reset_time: 1_900_000_000 } },
          { subscription: { id: 2, user_id: 42, amount_total: 0, amount_used: 50_000,
            status: 'active', start_time: now - 3600, end_time: 2_000_000_000, next_reset_time: 0 } },
        ],
        all_subscriptions: [{ subscription: ended }],
      })
    }
    if (url.pathname === '/api/user/self') {
      state.selfRequests += 1
      expect(request.method).toBe('GET')
      expect(bearer).toMatch(/^nap_/)
      expect(appHeader).toBe(VVCODE_APP)
      return envelope({ id: 42, username: 'vvcode-user', quota: state.walletQuota })
    }
    if (url.pathname === '/api/desktop/groups') {
      expect(request.method).toBe('GET')
      expect(bearer).toMatch(/^nap_/)
      expect(appHeader).toBe(VVCODE_APP)
      expect(url.searchParams.get('app')).toBe(VVCODE_APP)
      state.groupListReads += 1
      await awaitGate(state.groupsGate, request)
      state.groupsGate = undefined
      if (state.groupsMode === 'fail') return new Response(null, { status: 500 })
      if (state.groupsMode === 'empty') return envelope({})
      return envelope({
        team: { ratio: 'auto', desc: TEAM_GROUP_DESC },
        solo: { ratio: 2, desc: 'Solo 计划 · 独立额度，仅含团队模型的一个子集' },
      })
    }
    if (url.pathname === '/api/user/models') {
      expect(request.method).toBe('GET')
      expect(bearer).toMatch(/^nap_/)
      expect(appHeader).toBe(VVCODE_APP)
      const group = url.searchParams.get('group') ?? ''
      state.groupModelReads.push({ group, key: bearer })
      await awaitGate(state.modelsGate, request)
      state.modelsGate = undefined
      expect(group === 'team' || group === 'solo', `unexpected group catalog read ${group}`).toBe(true)
      if (group === 'solo' && state.soloCatalogMode === 'fail') {
        return new Response(null, { status: 500 })
      }
      return envelope(groupCatalog(group))
    }
    if (url.pathname === '/api/token/' && request.method === 'POST') {
      state.tokenCreates += 1
      expect(bearer).toMatch(/^nap_/)
      expect(appHeader).toBe(VVCODE_APP)
      const body = JSON.parse(await request.text()) as {
        name?: string
        group?: string
        expired_time?: number
        unlimited_quota?: boolean
      }
      expect(body.name).toMatch(/^hemi-dsh-[0-9a-f-]{36}$/)
      expect(body.name!.length).toBeLessThanOrEqual(50)
      expect(['team', 'solo']).toContain(body.group)
      expect(body.expired_time).toBe(-1)
      expect(body.unlimited_quota).toBe(true)
      expect(state.tokens.some(token => token.name === body.name)).toBe(false)
      const token: FixtureToken = {
        id: state.nextTokenId, name: body.name!, group: body.group!,
        userId: 42, key: body.group === 'team' ? TEAM_MODEL_KEY : SOLO_MODEL_KEY,
      }
      state.nextTokenId += 1
      state.tokens.push(token)
      return envelope({ id: token.id })
    }
    if (url.pathname === '/api/token/' && request.method === 'GET') {
      expect(bearer).toMatch(/^nap_/)
      return envelope({ items: state.tokens.map(tokenView), total: state.tokens.length })
    }
    if (url.pathname === '/api/token/search') {
      state.tokenSearches += 1
      expect(request.method).toBe('GET')
      expect(bearer).toMatch(/^nap_/)
      const keyword = url.searchParams.get('keyword') ?? ''
      const items = state.tokens.filter(token => token.name.includes(keyword)).map(tokenView)
      return envelope({ items, total: items.length })
    }
    const tokenDetail = url.pathname.match(/^\/api\/token\/(\d+)$/)
    if (tokenDetail !== null) {
      expect(request.method).toBe('GET')
      expect(bearer).toMatch(/^nap_/)
      const token = state.tokens.find(entry => entry.id === Number(tokenDetail[1]))
      expect(token, 'the fixture token was never created').toBeDefined()
      state.tokenDetails.push(token!.id)
      return envelope(tokenView(token!))
    }
    const tokenKey = url.pathname.match(/^\/api\/token\/(\d+)\/key$/)
    if (tokenKey !== null) {
      expect(request.method).toBe('POST')
      expect(bearer).toMatch(/^nap_/)
      expect(appHeader).toBe(VVCODE_APP)
      const token = state.tokens.find(entry => entry.id === Number(tokenKey[1]))
      expect(token, 'the fixture token was never created').toBeDefined()
      state.tokenKeyCalls += 1
      return envelope({ key: token!.key })
    }
    if (url.pathname === '/v1/models') {
      expect(request.method).toBe('GET')
      state.relayKeyReads.push({ key: bearer, appHeader })
      if (bearer === null || bearer.startsWith('nap_')) {
        return Response.json({ error: { message: 'The relay rejects the management PAT' } }, { status: 401 })
      }
      const models = relayKeyModels(bearer)
      expect(models.length, `unexpected relay key ${bearer.slice(0, 10)}…`).toBeGreaterThan(0)
      return Response.json({ object: 'list', data: models })
    }
    if (url.pathname === '/v1/chat/completions') {
      expect(request.method).toBe('POST')
      const body = JSON.parse(await request.text()) as { model?: string; tools?: { function?: { name?: string } }[] }
      state.chatRequests.push({
        key: bearer, appHeader, model: body.model ?? '',
        tools: (body.tools ?? []).map(tool => tool.function?.name ?? ''),
      })
      if (bearer === null || bearer.startsWith('nap_')) {
        return Response.json({ error: { message: 'The relay rejects the management PAT' } }, { status: 401 })
      }
      const base = { id: 'chatcmpl-vvcode-test', object: 'chat.completion.chunk', created: 1, model: body.model ?? '' }
      const toolCall = {
        role: 'assistant',
        tool_calls: [{ index: 0, id: 'vvcode-test-call', type: 'function',
          function: { name: 'model_connection_test', arguments: '{}' } }],
      }
      return new Response([
        { ...base, choices: [{ index: 0, delta: toolCall, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    throw new Error(`Unexpected VVCode fixture endpoint: ${request.method} ${url.pathname}`)
  }

  return { state, reply, holdNextGroupsRead, holdNextGroupModelsRead }
}

it('browses VVCode group catalogs read-only and prepares calling keys only on staged saves', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'hemi-vvcode-test-'))
  onTestFinished(() => rm(scratch, { recursive: true, force: true }))
  const patch = join(scratch, 'hemi.patch.yml')
  await writeFile(patch, '- id: hemi-model-settings\n  disabled: false\n- id: hemi-model-settings-ui\n  disabled: false\n'
    + '- id: hemi-model-access\n  disabled: false\n- id: hemi-model-access-ui\n  disabled: false\n'
    + '- id: ui-settings-models\n  config:\n    showSettingsSection: false\n')
  const realFetch = globalThis.fetch
  const vvcode = createVvcodePeer()
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const verified = await vvcode.reply(new Request(input, init))
    if (verified !== null) return verified
    return realFetch(input, init)
  })
  onTestFinished(() => { fetch.mockRestore() })
  const scaffold = await launchWebScaffold({ developerTools: false, extraOverlayPath: patch })
  onTestFinished(() => scaffold.close())
  const service = scaffold.ctx.get('hemiModelAccess')
  if (service === undefined) throw new Error('the scaffold composition did not mount hemiModelAccess')
  // The singleflight contract: the dialog never walks groups through the single-group RPC.
  const syncGroupRpc = vi.spyOn(service, 'syncVvcodeGroup')
  onTestFinished(() => { syncGroupRpc.mockRestore() })
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, timezoneId: 'Asia/Shanghai' })
  const errors: Error[] = []
  page.on('pageerror', (error) => { errors.push(error) })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('button', { name: '模型接入', exact: true }).click()
  const panel = settings.getByRole('region', { name: '模型接入', exact: true })
  const card = panel.getByRole('region', { name: 'VVCode', exact: true })
  const expectedDir = join(import.meta.dirname, 'expected/hemi-vvcode')
  await mkdir(expectedDir, { recursive: true })
  const goldenCard = async (name: string): Promise<void> => {
    await compareOrRefreshGolden(join(expectedDir, `${name}.expected.md`),
      // The card's region role is implicit (a named section), so select the element, not the role attribute.
      await captureStableAria(page, CARD_SELECTOR, scaffold.workspaceCwd), webSnapshotMode())
  }
  const goldenModal = async (name: string): Promise<void> => {
    await compareOrRefreshGolden(join(expectedDir, `${name}.expected.md`),
      await captureStableAria(page, MODAL_SELECTOR, scaffold.workspaceCwd), webSnapshotMode())
  }
  const confirmMessages: string[] = []
  const acceptNextConfirm = (): void => {
    page.once('dialog', (dialog) => { confirmMessages.push(dialog.message()); void dialog.accept() })
  }
  const dismissNextConfirm = (): void => {
    page.once('dialog', (dialog) => { confirmMessages.push(dialog.message()); void dialog.dismiss() })
  }

  // Host-side directory reads pin the multi-group wire contract and expose each group's provider route.
  const directory = async (): Promise<DirectoryRow> => service.vvcodeDirectory(new AbortController().signal)
  const manageButton = card.getByRole('button', { name: MANAGE_TITLE, exact: true })
  const modal = page.getByRole('dialog', { name: MANAGE_TITLE, exact: true })
  const groupRegion = (group: string) => modal.getByRole('region', { name: `VVCode 分组 ${group}`, exact: true })
  const groupToggle = (group: string) => groupRegion(group).getByRole('button', { name: new RegExp(`^${group}\\b`) })
  const modelRow = (group: string, model: string) =>
    groupRegion(group).getByRole('group', { name: model, exact: true })
  const modelCheck = (group: string, model: string) =>
    modal.getByRole('checkbox', { name: `启用 ${model} · ${group}`, exact: true })
  const searchBox = modal.getByRole('textbox', { name: '搜索分组或模型', exact: true })
  // The single top-bar directory entry: one explicit refresh reads 1 groups GET plus each
  // group's read-only catalog GET in one round.
  const refreshDirectory = modal.getByRole('button', { name: REFRESH_DIRECTORY, exact: true })
  // While that refresh is pending, the button relabels to the busy text and locks (singleflight).
  const refreshBusy = modal.getByRole('button', { name: REFRESHING_DIRECTORY, exact: true })
  const saveButton = modal.getByRole('button', { name: '保存选择', exact: true })
  const cancelButton = modal.getByRole('button', { name: '取消', exact: true })
  const refreshUsage = card.getByRole('button', { name: '刷新余额', exact: true })
  /** Open the manage dialog and expand the named groups; closing resets their expansion. */
  const openManage = async (expand: readonly string[] = []): Promise<void> => {
    await manageButton.click()
    await modal.waitFor()
    for (const group of expand) {
      await groupRegion(group).waitFor()
      const toggle = groupToggle(group)
      if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
    }
  }
  const listedModelIds = async (provider: string): Promise<string[]> => {
    try {
      return (await scaffold.ctx.llm.listModels(provider)).map(model => model.id).sort()
    } catch {
      // A provider the disconnected subscription unmounted offers no models.
      return []
    }
  }
  const settingsValue = (): unknown =>
    scaffold.ctx.settings.describe().find(row => row.ns === 'hemi-model-access')?.value
  const collectApiKeyRefs = (value: unknown, refs: string[] = []): string[] => {
    if (Array.isArray(value)) {
      for (const item of value) collectApiKeyRefs(item, refs)
      return refs
    }
    if (value === null || typeof value !== 'object') return refs
    for (const [key, item] of Object.entries(value)) {
      if (key === 'apiKeyRef' && typeof item === 'string') refs.push(item)
      collectApiKeyRefs(item, refs)
    }
    return refs
  }
  const relayReadsFor = (key: string): number =>
    vvcode.state.relayKeyReads.filter(read => read.key === key).length

  // A manual API connection exists first; every later VVCode step must leave it untouched.
  await panel.getByRole('tab', { name: 'API', exact: true }).click()
  await panel.getByRole('button', { name: '添加 API 接入', exact: true }).click()
  const editor = panel.getByRole('region', { name: 'API 接入', exact: true })
  await editor.getByLabel('连接名称').fill('Manual API')
  await editor.getByLabel('接口地址').fill(`${VVCODE_ORIGIN}/v1`)
  await editor.getByLabel('协议', { exact: true }).selectOption('openai-completions')
  await editor.getByLabel('API Key', { exact: true }).fill(MANUAL_MODEL_KEY)
  await editor.getByLabel('模型 ID', { exact: true }).fill('manual-kept-model')
  await editor.getByRole('button', { name: '添加模型', exact: true }).click()
  await editor.getByRole('button', { name: '保存接入', exact: true }).click()
  const manualCard = panel.getByRole('region', { name: 'Manual API', exact: true })
  await manualCard.getByRole('group', { name: 'manual-kept-model', exact: true }).waitFor()
  const manualProviders = () => ((scaffold.ctx.settings.describe().find(row => row.ns === 'llm-pi-ai')?.value as {
    providers?: Record<string, { displayName?: string; baseURL?: string; models?: { id?: string }[] }>
  }).providers ?? {})
  const manualProviderList = () => Object.values(manualProviders()).filter(profile => profile.displayName === 'Manual API')
  await expect.poll(manualProviderList)
    .toEqual([expect.objectContaining({ models: [expect.objectContaining({ id: 'manual-kept-model' })] })])
  await panel.getByRole('tab', { name: '订阅', exact: true }).click()
  await card.getByRole('button', { name: '登录授权', exact: true }).waitFor()

  // Sign in through the presented browser authorization page: the harness binds a
  // loopback callback, and this test plays the site by hitting it with a real fetch.
  await card.getByRole('button', { name: '登录授权', exact: true }).click()
  await card.getByRole('link', { name: '打开授权页面' }).waitFor()
  const loginHref = await card.getByRole('link', { name: '打开授权页面' }).getAttribute('href')
  const loginUrl = new URL(loginHref ?? '')
  expect(loginUrl.hostname).toBe('cf.vvcode.top')
  expect(loginUrl.pathname).toBe('/oauth/vscode/login')
  expect(loginUrl.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
  const callbackUrl = loginUrl.searchParams.get('redirect_uri') ?? ''
  expect(callbackUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
  vvcode.state.loginStartUrls.push(loginHref!)
  vvcode.holdNextGroupsRead()
  const callback = await realFetch(`${callbackUrl}?code=test-code&state=${loginUrl.searchParams.get('state')}`)
  expect(callback.status).toBe(200)
  expect(await callback.text()).toContain('Authorization received.')
  await card.getByText('已授权', { exact: true }).waitFor()
  await card.getByText('账号余额', { exact: true }).waitFor()
  await card.getByText('$5', { exact: true }).waitFor()
  await card.getByText('有效订阅 #1', { exact: true }).waitFor()
  await card.getByText('剩余 $1.5 / $2', { exact: true }).waitFor()
  await card.getByText('有效订阅 #2', { exact: true }).waitFor()
  await card.getByText('剩余 不限额 / 不限额', { exact: true }).waitFor()
  // Account facts render once for the whole card, never per group.
  expect(await card.getByText('账号余额', { exact: true }).count()).toBe(1)
  expect(await card.getByText('有效订阅 #1', { exact: true }).count()).toBe(1)
  expect(await card.getByText('有效订阅 #99', { exact: true }).count()).toBe(0)
  expect(vvcode.state.grants).toHaveLength(1)
  expect(vvcode.state.grants[0]).toMatchObject({ accessToken: 'nap_vvcode_synthetic_pat_1', userId: 42 })
  expect(await scaffold.ctx.credentials.describeRecord(VVCODE_RECORD)).toMatchObject({ kind: 'grant' })

  await card.getByText('正在读取已选型号…', { exact: true }).waitFor()
  expect(await card.getByText('暂时无法读取已选型号', { exact: true }).count()).toBe(0)
  expect(await card.getByText('已选 0 个型号（0 个分组）', { exact: true }).count()).toBe(0)
  await goldenCard('card-initial-loading')
  vvcode.state.releaseGroups?.()
  // The sign-in mount pass is exactly one directory round — 1 groups GET plus one read-only
  // catalog GET per group — and it never creates or reveals a calling key.
  await card.getByText('已选 0 个型号（0 个分组）', { exact: true }).waitFor()
  expect(vvcode.state.groupListReads).toBe(1)
  expect(vvcode.state.groupModelReads).toHaveLength(2)
  expect(vvcode.state.groupModelReads.map(read => read.group).sort()).toEqual(['solo', 'team'])
  expect(vvcode.state.groupModelReads.every(read => read.key?.startsWith('nap_'))).toBe(true)
  expect(vvcode.state.tokenCreates).toBe(0)
  expect(vvcode.state.tokenKeyCalls).toBe(0)
  expect(vvcode.state.tokenSearches).toBe(0)
  expect(syncGroupRpc).not.toHaveBeenCalled()
  await expect.poll(() => manageButton.isEnabled()).toBe(true)
  expect(await card.getByRole('combobox').count()).toBe(0)
  expect(await card.getByRole('checkbox').count()).toBe(0)
  expect(await card.getByRole('region', { name: /VVCode 分组/ }).count()).toBe(0)

  // Opening the manage dialog renders the same-auth cached directory without any request, so
  // every group's catalog is browsable before any connection exists and no loading text shows.
  await openManage()
  expect(vvcode.state.groupListReads).toBe(1)
  expect(vvcode.state.groupModelReads).toHaveLength(2)
  expect(await modal.getByText(REFRESHING_DIRECTORY, { exact: true }).count()).toBe(0)
  await groupToggle('team').getByText('已选 0 / 2', { exact: true }).waitFor()
  await groupToggle('solo').getByText('已选 0 / 2', { exact: true }).waitFor()
  await groupToggle('team').getByText('尚未连接', { exact: true }).waitFor()
  await groupToggle('solo').getByText('尚未连接', { exact: true }).waitFor()
  await groupRegion('team').getByText('用量倍率：自动', { exact: true }).waitFor()
  await groupRegion('solo').getByText('用量倍率：2 倍', { exact: true }).waitFor()
  // Group headers carry only the collapse toggle; the single directory entry lives in the top bar.
  expect(await groupRegion('team').getByRole('button', { name: /拉取|重试|刷新/ }).count()).toBe(0)
  expect(await groupRegion('solo').getByRole('button', { name: /拉取|重试|刷新/ }).count()).toBe(0)
  expect(await saveButton.isDisabled()).toBe(true)
  await groupToggle('team').click()
  await groupToggle('solo').click()
  expect(await groupRegion('team').getByText(TEAM_GROUP_DESC, { exact: true }).count()).toBe(0)
  expect(await groupRegion('solo').getByText('Solo 计划 · 独立额度，仅含团队模型的一个子集', { exact: true }).count()).toBe(0)
  await modelCheck('team', 'vv-model-a').waitFor()
  await modelCheck('solo', 'vv-model-solo').waitFor()
  await goldenModal('groups-not-synced')
  // The search box starts focused, filters whole groups, reports no matches, and restores.
  await searchBox.fill('solo')
  await expect.poll(() => groupRegion('team').isVisible()).toBe(false)
  await expect.poll(() => groupRegion('solo').isVisible()).toBe(true)
  await searchBox.fill('vv-model-a')
  await expect.poll(() => groupRegion('team').isVisible()).toBe(true)
  await expect.poll(() => groupRegion('solo').isVisible()).toBe(true)
  await expect.poll(() => modelCheck('team', 'vv-model-b').isVisible()).toBe(false)
  await expect.poll(() => modelCheck('solo', 'vv-model-solo').isVisible()).toBe(false)
  await searchBox.fill('没有此模型')
  await modal.getByText('没有匹配的模型', { exact: true }).waitFor()
  await expect.poll(() => groupRegion('solo').isVisible()).toBe(false)
  await searchBox.fill('')
  await expect.poll(() => groupRegion('team').isVisible()).toBe(true)
  await expect.poll(() => groupRegion('solo').isVisible()).toBe(true)
  expect(await searchBox.evaluate(element => element === document.activeElement)).toBe(true)

  // Closing and reopening the dialog reuses the cached snapshot without another directory round.
  await cancelButton.click()
  await expect.poll(() => modal.count()).toBe(0)
  await openManage()
  await groupToggle('team').getByText('已选 0 / 2', { exact: true }).waitFor()
  expect(vvcode.state.groupListReads).toBe(1)
  expect(vvcode.state.groupModelReads).toHaveLength(2)
  // Expand both groups: the held refresh below proves their drafts stay enabled while it runs,
  // and the expansion persists through the snapshot updates because rows never remount.
  await groupToggle('team').click()
  await groupToggle('solo').click()

  // The only next round is the explicit top-bar refresh. Holding the groups read captures the
  // single busy feedback: the button relabels once with aria-busy and locks against re-entry,
  // drafts stay enabled, and no second request is dispatched while the first round is pending.
  vvcode.holdNextGroupsRead()
  await refreshDirectory.click()
  await refreshBusy.waitFor()
  await expect.poll(() => refreshBusy.getAttribute('aria-busy')).toBe('true')
  await expect.poll(() => refreshBusy.isDisabled()).toBe(true)
  await expect.poll(() => modelCheck('team', 'vv-model-a').isEnabled()).toBe(true)
  await goldenModal('groups-loading')
  expect(await modal.getByText(REFRESHING_DIRECTORY, { exact: true }).count()).toBe(1)
  expect(vvcode.state.groupListReads).toBe(2)
  vvcode.state.releaseGroups?.()
  await expect.poll(() => vvcode.state.groupModelReads).toHaveLength(4)
  await expect.poll(() => refreshDirectory.isEnabled()).toBe(true)
  expect(await modal.getByText(REFRESHING_DIRECTORY, { exact: true }).count()).toBe(0)

  // A plain explicit refresh is one whole directory round: 1 groups GET + 2 catalog GETs, and
  // browsing it never prepares or reveals a calling key.
  const listsBeforePlain = vvcode.state.groupListReads
  const readsBeforePlain = vvcode.state.groupModelReads.length
  await refreshDirectory.click()
  await expect.poll(() => vvcode.state.groupModelReads).toHaveLength(readsBeforePlain + 2)
  await expect.poll(() => refreshDirectory.isEnabled()).toBe(true)
  expect(vvcode.state.groupListReads).toBe(listsBeforePlain + 1)
  expect(vvcode.state.tokenCreates).toBe(0)
  expect(vvcode.state.tokenKeyCalls).toBe(0)
  expect(confirmMessages).toEqual([])

  // Drafts stage instantly; an unsaved model keeps its test and settings rows disabled.
  await modelCheck('team', 'vv-model-a').click()
  await expect.poll(() => modelCheck('team', 'vv-model-a').isChecked()).toBe(true)
  await expect.poll(() => modelRow('team', 'vv-model-a').getByRole('button', { name: '测试', exact: true }).isDisabled()).toBe(true)
  await expect.poll(() => modelRow('team', 'vv-model-a').getByRole('button', { name: '模型设置', exact: true }).isDisabled()).toBe(true)
  await modelCheck('team', 'vv-model-b').click()
  await modelCheck('solo', 'vv-model-a').click()
  await expect.poll(() => modelCheck('solo', 'vv-model-a').isChecked()).toBe(true)
  await card.getByText('已选 0 个型号（0 个分组）', { exact: true }).waitFor()

  // Saving enablements for both not-yet-connected groups confirms exactly once, prepares one
  // calling key per named group, and verifies each key's relay metadata. The wire cost is the
  // save's own live authorized-groups read plus the one post-save fresh directory round that
  // publishes the new selections before the dialog closes.
  const listsBeforeSave = vvcode.state.groupListReads
  const readsBeforeSave = vvcode.state.groupModelReads.length
  acceptNextConfirm()
  await saveButton.click()
  await expect.poll(() => confirmMessages.length, { timeout: 10_000 }).toBe(1)
  expect(confirmMessages[0]).toBe(SAVE_CONFIRM)
  await expect.poll(() => modal.count()).toBe(0)
  await card.getByText('已选 3 个型号（2 个分组）', { exact: true }).waitFor()
  expect(vvcode.state.tokenCreates).toBe(2)
  expect(vvcode.state.tokenKeyCalls).toBe(2)
  expect(vvcode.state.tokenSearches).toBe(0)
  expect(vvcode.state.groupListReads).toBe(listsBeforeSave + 2)
  expect(vvcode.state.groupModelReads).toHaveLength(readsBeforeSave + 2)
  expect(vvcode.state.groupModelReads.every(read => read.key?.startsWith('nap_'))).toBe(true)
  // Each prepared token is verified through its persisted id (at least one exact-id lookup
  // per group); the relay key and directory reads never consult the ordinary token search.
  await expect.poll(() => [...new Set(vvcode.state.tokenDetails)].sort((a, b) => a - b)).toEqual([8, 9])
  expect(vvcode.state.relayKeyReads.map(read => read.key).sort()).toEqual([SOLO_MODEL_KEY, TEAM_MODEL_KEY])

  // Fresh groups own distinct native provider routes; the wire reports both connections and
  // healthy catalogs, and the raw model id stays prefix-free with one group label per route.
  const syncedRead = await directory()
  expect(syncedRead.state).toBe('ready')
  const teamGroup = syncedRead.groups.find(group => group.name === 'team')
  const soloGroup = syncedRead.groups.find(group => group.name === 'solo')
  expect(teamGroup).toMatchObject({ state: 'ready', ratio: 'auto', hasConnection: true, catalogError: false })
  expect(soloGroup).toMatchObject({ state: 'ready', ratio: 2, hasConnection: true, catalogError: false })
  const teamProvider = teamGroup?.provider ?? ''
  const soloProvider = soloGroup?.provider ?? ''
  expect(teamProvider).toMatch(/^vvcode/)
  expect(soloProvider).toMatch(/^vvcode/)
  expect(teamProvider).not.toBe(soloProvider)
  expect((await directory()).groups.find(group => group.name === 'team')?.provider).toBe(teamProvider)
  await expect.poll(async () => listedModelIds(teamProvider)).toEqual(['vv-model-a', 'vv-model-b'])
  await expect.poll(async () => listedModelIds(soloProvider)).toEqual(['vv-model-a'])
  expect(scaffold.ctx.llm.listProviders().map(provider => provider.id))
    .toEqual(expect.arrayContaining([teamProvider, soloProvider]))
  expect(await scaffold.ctx.llm.resolveModelInfo(teamProvider, 'vv-model-a'))
    .toMatchObject({ id: 'vv-model-a', name: 'vv-model-a · team' })
  expect(await scaffold.ctx.llm.resolveModelInfo(soloProvider, 'vv-model-a'))
    .toMatchObject({ id: 'vv-model-a', name: 'vv-model-a · solo' })

  // Connected groups expose test and settings; a saved display name publishes exactly one
  // group label while the editor keeps the bare name so a resave never stacks it.
  await openManage(['team', 'solo'])
  await groupToggle('team').getByText('已选 2 / 2', { exact: true }).waitFor()
  await groupToggle('solo').getByText('已选 1 / 2', { exact: true }).waitFor()
  await modelRow('team', 'vv-model-a').getByRole('button', { name: '测试', exact: true }).waitFor()
  await modelRow('team', 'vv-model-a').getByRole('button', { name: '模型设置', exact: true }).click()
  const modelOptions = page.getByRole('dialog', { name: '模型设置', exact: true })
  await modelOptions.getByLabel('显示名称').fill('VV Custom')
  await modelOptions.getByLabel('上下文长度（token）').fill('128000')
  await modelOptions.getByRole('button', { name: '保存模型设置', exact: true }).click()
  await modelOptions.waitFor({ state: 'detached' })
  expect(await scaffold.ctx.llm.resolveModelInfo(teamProvider, 'vv-model-a'))
    .toMatchObject({ name: 'VV Custom · team', context: { contextWindow: 128000 } })
  expect(await scaffold.ctx.llm.resolveModelInfo(soloProvider, 'vv-model-a'))
    .toMatchObject({ name: 'vv-model-a · solo' })
  expect(await service.getModelOptions(teamProvider, 'vv-model-a'))
    .toMatchObject({ options: { name: 'VV Custom' }, effective: { name: 'VV Custom' } })

  // The same model id under both groups tests over its own group key; bodies keep the raw id.
  await modelRow('team', 'vv-model-a').getByRole('button', { name: '测试', exact: true }).click()
  await modelRow('team', 'vv-model-a').getByRole('status').getByText('连接成功 · 支持工具调用', { exact: true }).waitFor()
  expect(vvcode.state.chatRequests.at(-1)).toMatchObject({
    key: TEAM_MODEL_KEY, appHeader: VVCODE_APP, model: 'vv-model-a', tools: ['model_connection_test'],
  })
  await modelRow('solo', 'vv-model-a').getByRole('button', { name: '测试', exact: true }).click()
  await modelRow('solo', 'vv-model-a').getByRole('status').getByText('连接成功 · 支持工具调用', { exact: true }).waitFor()
  expect(vvcode.state.chatRequests.at(-1)).toMatchObject({
    key: SOLO_MODEL_KEY, appHeader: VVCODE_APP, model: 'vv-model-a', tools: ['model_connection_test'],
  })
  expect(vvcode.state.chatRequests.every(request => !request.key?.startsWith('nap_'))).toBe(true)

  // Removing an already-connected group's model saves without a confirm or key call, and the
  // catalog row survives while chat availability drops.
  const relayReadsBeforeRemoval = relayReadsFor(TEAM_MODEL_KEY)
  const listsBeforeRemoval = vvcode.state.groupListReads
  const readsBeforeRemoval = vvcode.state.groupModelReads.length
  await modelCheck('team', 'vv-model-a').click()
  await expect.poll(() => modelCheck('team', 'vv-model-a').isChecked()).toBe(false)
  await expect.poll(() => modelRow('team', 'vv-model-a').getByRole('button', { name: '测试', exact: true }).isDisabled()).toBe(true)
  await expect.poll(() => modelCheck('solo', 'vv-model-a').isChecked()).toBe(true)
  await saveButton.click()
  await expect.poll(() => modal.count()).toBe(0)
  await card.getByText('已选 2 个型号（2 个分组）', { exact: true }).waitFor()
  expect(confirmMessages).toEqual([SAVE_CONFIRM])
  expect(vvcode.state.tokenCreates).toBe(2)
  expect(vvcode.state.tokenKeyCalls).toBe(2)
  expect(vvcode.state.groupListReads).toBe(listsBeforeRemoval + 1)
  expect(vvcode.state.groupModelReads).toHaveLength(readsBeforeRemoval + 2)
  expect(relayReadsFor(TEAM_MODEL_KEY)).toBe(relayReadsBeforeRemoval)
  await expect.poll(async () => listedModelIds(teamProvider)).toEqual(['vv-model-b'])
  await expect.poll(async () => listedModelIds(soloProvider)).toEqual(['vv-model-a'])

  // Re-enabling a model the saved key catalog already covers needs no key call: the added
  // selection only re-proves the group live (one groups read beside the fresh directory
  // round), so no confirm, create or reveal runs.
  const relayReadsBeforeReAdd = relayReadsFor(TEAM_MODEL_KEY)
  const listsBeforeReAdd = vvcode.state.groupListReads
  const readsBeforeReAdd = vvcode.state.groupModelReads.length
  await openManage(['team'])
  await modelCheck('team', 'vv-model-a').click()
  await expect.poll(() => modelCheck('team', 'vv-model-a').isChecked()).toBe(true)
  await saveButton.click()
  await expect.poll(() => modal.count()).toBe(0)
  await card.getByText('已选 3 个型号（2 个分组）', { exact: true }).waitFor()
  expect(confirmMessages).toEqual([SAVE_CONFIRM])
  expect(vvcode.state.tokenCreates).toBe(2)
  expect(vvcode.state.tokenKeyCalls).toBe(2)
  expect(vvcode.state.groupListReads).toBe(listsBeforeReAdd + 2)
  expect(vvcode.state.groupModelReads).toHaveLength(readsBeforeReAdd + 2)
  expect(relayReadsFor(TEAM_MODEL_KEY)).toBe(relayReadsBeforeReAdd)
  await expect.poll(async () => listedModelIds(teamProvider)).toEqual(['vv-model-a', 'vv-model-b'])
  await goldenCard('card-summary')

  // Screenshots: the full manage dialog with every group, then the account summary card.
  const artifactRoot = join(REPO_ROOT, '.artifacts')
  await mkdir(artifactRoot, { recursive: true })
  const screenshots = await mkdtemp(join(artifactRoot, 'hemi-vvcode-'))
  console.log(`VVCode screenshots: ${screenshots}`)
  const noHorizontalOverflow = async (scope: Locator): Promise<void> => {
    expect(await scope.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  }
  await openManage(['team', 'solo'])
  await page.mouse.move(0, 0)
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
    await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(colorScheme === 'dark')
    for (const viewport of [{ width: 1280, height: 1000 }, { width: 390, height: 1200 }]) {
      await page.setViewportSize(viewport)
      expect(await modal.boundingBox()).not.toBeNull()
      await noHorizontalOverflow(modal)
      await page.screenshot({ path: join(screenshots, `modal-${colorScheme}-${viewport.width}x${viewport.height}.png`), animations: 'disabled' })
    }
  }
  await page.setViewportSize({ width: 1280, height: 1000 })
  await cancelButton.click()
  await expect.poll(() => modal.count()).toBe(0)
  await card.evaluate((element) => { element.scrollIntoView({ block: 'start' }) })
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
    await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(colorScheme === 'dark')
    for (const viewport of [{ width: 1280, height: 1000 }, { width: 390, height: 1200 }]) {
      await page.setViewportSize(viewport)
      const bounds = await card.boundingBox()
      expect(bounds).not.toBeNull()
      // The settings panel scrolls vertically; the card must stay inside horizontally.
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width)
      await noHorizontalOverflow(card)
      await page.screenshot({ path: join(screenshots, `card-${colorScheme}-${viewport.width}x${viewport.height}.png`), animations: 'disabled' })
    }
  }
  await page.setViewportSize({ width: 1280, height: 1000 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })

  // While a held catalog read keeps the explicit refresh pending, exactly one busy feedback
  // shows and drafts remain freely editable — a read never locks the save, so a staged draft
  // stays saveable while the refresh runs; cancelling afterwards discards it without keys.
  const listsBeforePending = vvcode.state.groupListReads
  const readsBeforePending = vvcode.state.groupModelReads.length
  vvcode.holdNextGroupModelsRead()
  await openManage(['team', 'solo'])
  await refreshDirectory.click()
  await refreshBusy.waitFor()
  expect(await modal.getByText(REFRESHING_DIRECTORY, { exact: true }).count()).toBe(1)
  await expect.poll(() => refreshBusy.getAttribute('aria-busy')).toBe('true')
  await expect.poll(() => refreshBusy.isDisabled()).toBe(true)
  await modelCheck('solo', 'vv-model-solo').click()
  await expect.poll(() => modelCheck('solo', 'vv-model-solo').isChecked()).toBe(true)
  await expect.poll(() => modelCheck('solo', 'vv-model-solo').isEnabled()).toBe(true)
  await expect.poll(() => modelCheck('team', 'vv-model-a').isEnabled()).toBe(true)
  await expect.poll(() => saveButton.isEnabled()).toBe(true)
  vvcode.state.releaseModels?.()
  // One held round settles as exactly one directory round: the held first catalog plus the
  // follow-up second catalog, with the single groups read and no coalesced second round.
  await expect.poll(() => refreshDirectory.isEnabled()).toBe(true)
  await expect.poll(() => vvcode.state.groupModelReads).toHaveLength(readsBeforePending + 2)
  expect(vvcode.state.groupListReads).toBe(listsBeforePending + 1)
  await cancelButton.click()
  await expect.poll(() => modal.count()).toBe(0)
  await card.getByText('已选 3 个型号（2 个分组）', { exact: true }).waitFor()
  expect(vvcode.state.tokenCreates).toBe(2)
  expect(vvcode.state.tokenKeyCalls).toBe(2)

  // Escape discards an open draft and returns focus to the manage entry; nothing is prepared.
  await openManage(['solo'])
  await modelCheck('solo', 'vv-model-solo').click()
  await expect.poll(() => modelCheck('solo', 'vv-model-solo').isChecked()).toBe(true)
  await page.keyboard.press('Escape')
  await expect.poll(() => modal.count()).toBe(0)
  await card.getByText('已选 3 个型号（2 个分组）', { exact: true }).waitFor()
  expect(await manageButton.evaluate(element => element === document.activeElement)).toBe(true)
  expect(vvcode.state.tokenCreates).toBe(2)
  expect(vvcode.state.tokenKeyCalls).toBe(2)

  // A mask click closes the dialog the same way: the draft is dropped, nothing prepared.
  await openManage(['solo'])
  await modelCheck('solo', 'vv-model-solo').click()
  await expect.poll(() => modelCheck('solo', 'vv-model-solo').isChecked()).toBe(true)
  await page.mouse.click(8, 8)
  await expect.poll(() => modal.count()).toBe(0)
  await card.getByText('已选 3 个型号（2 个分组）', { exact: true }).waitFor()
  expect(vvcode.state.tokenCreates).toBe(2)
  expect(vvcode.state.tokenKeyCalls).toBe(2)

  // Usage reads preserve prior same-account values on failure and distinguish empty and missing permission.
  vvcode.state.usageMode = 'fail'
  await refreshUsage.click()
  await card.getByText('订阅额度暂不可用，请刷新重试', { exact: true }).waitFor()
  await card.getByText('剩余 $1.5 / $2', { exact: true }).waitFor()
  await goldenCard('usage-failed')

  vvcode.state.usageMode = 'empty'
  vvcode.state.walletQuota = 0
  await refreshUsage.click()
  await card.getByText('暂无有效订阅', { exact: true }).waitFor()
  await card.getByText('$0', { exact: true }).waitFor()
  expect(await card.getByText('有效订阅 #1', { exact: true }).count()).toBe(0)
  await goldenCard('usage-empty')

  vvcode.state.usageMode = 'forbidden'
  vvcode.state.walletQuota = 2_500_000
  await refreshUsage.click()
  await card.getByText('请重新授权以读取订阅额度，余额单独显示', { exact: true }).waitFor()
  await card.getByText('$5', { exact: true }).waitFor()
  await goldenCard('usage-reauthorize')
  vvcode.state.usageMode = 'ok'
  await refreshUsage.click()
  await card.getByText('有效订阅 #1', { exact: true }).waitFor()
  await expect.poll(() => card.getByText('请重新授权以读取订阅额度，余额单独显示', { exact: true }).count()).toBe(0)

  // A failed whole-directory read alerts inside the dialog while the cached rows, bindings,
  // keys and selections survive, and the same refresh entry retries without a fake empty state.
  vvcode.state.groupsMode = 'fail'
  await openManage(['solo'])
  const listsBeforeFailed = vvcode.state.groupListReads
  const readsBeforeFailed = vvcode.state.groupModelReads.length
  await refreshDirectory.click()
  await modal.getByText('无法读取 VVCode 分组，请检查登录状态和网络后重新读取，或重新授权', { exact: true }).waitFor()
  await expect.poll(() => refreshDirectory.isEnabled()).toBe(true)
  await expect.poll(() => modelCheck('solo', 'vv-model-a').isVisible()).toBe(true)
  await expect.poll(() => modelCheck('solo', 'vv-model-a').isChecked()).toBe(true)
  expect(vvcode.state.groupListReads).toBe(listsBeforeFailed + 1)
  expect(vvcode.state.groupModelReads).toHaveLength(readsBeforeFailed)
  await goldenModal('groups-failed')
  // Reopening keeps the failed read visible from the retained snapshot without any request:
  // the open auto-ensure re-reads only a missing or rejected snapshot, not a resolved failure.
  await cancelButton.click()
  await expect.poll(() => modal.count()).toBe(0)
  await openManage()
  await modal.getByText('无法读取 VVCode 分组，请检查登录状态和网络后重新读取，或重新授权', { exact: true }).waitFor()
  await expect.poll(() => modelCheck('solo', 'vv-model-a').isVisible()).toBe(true)
  expect(vvcode.state.groupListReads).toBe(listsBeforeFailed + 1)
  expect(vvcode.state.groupModelReads).toHaveLength(readsBeforeFailed)
  vvcode.state.groupsMode = 'ok'
  await refreshDirectory.click()
  await expect.poll(() => modal.getByText('无法读取 VVCode 分组，请检查登录状态和网络后重新读取，或重新授权', { exact: true }).count()).toBe(0)
  await expect.poll(() => groupRegion('solo').isVisible()).toBe(true)
  await cancelButton.click()
  await expect.poll(() => modal.count()).toBe(0)

  // A failed single-group catalog read degrades only that group: the explicit refresh fails
  // solo, the row keeps its previous model IDs, no key is prepared, and refreshing again
  // recovers it without touching the other group.
  vvcode.state.soloCatalogMode = 'fail'
  await openManage(['solo', 'team'])
  const listsBeforePartial = vvcode.state.groupListReads
  const readsBeforePartial = vvcode.state.groupModelReads.length
  await refreshDirectory.click()
  await groupToggle('solo').getByText('目录读取失败', { exact: true }).waitFor()
  await groupRegion('solo').getByText(GROUP_CATALOG_RETRY_HINT, { exact: true }).waitFor()
  await expect.poll(() => modelCheck('solo', 'vv-model-a').isChecked()).toBe(true)
  await expect.poll(() => modelCheck('solo', 'vv-model-solo').isVisible()).toBe(true)
  await expect.poll(() => saveButton.isDisabled()).toBe(true)
  await goldenModal('group-partial-failure')
  expect(vvcode.state.groupListReads).toBe(listsBeforePartial + 1)
  // Both catalogs are re-read; the failed solo read is the arrival that answers 500.
  expect(vvcode.state.groupModelReads).toHaveLength(readsBeforePartial + 2)
  expect(vvcode.state.tokenCreates).toBe(2)
  expect(vvcode.state.tokenKeyCalls).toBe(2)
  vvcode.state.soloCatalogMode = 'ok'
  await refreshDirectory.click()
  await expect.poll(() => groupToggle('solo').getByText('目录读取失败', { exact: true }).count()).toBe(0)
  await expect.poll(() => modelCheck('solo', 'vv-model-solo').isEnabled()).toBe(true)
  await expect.poll(() => modelCheck('team', 'vv-model-b').isChecked()).toBe(true)
  await expect.poll(() => saveButton.isDisabled()).toBe(true)
  await cancelButton.click()
  await expect.poll(() => modal.count()).toBe(0)

  // A successful read that no longer lists a connected group marks it unavailable while
  // keeping its key, catalog rows and selections; chat availability is withdrawn, the refresh
  // entry stays available, and re-reading the groups restores both rows.
  vvcode.state.groupsMode = 'empty'
  await openManage(['solo', 'team'])
  await refreshDirectory.click()
  await groupRegion('team').getByText(GROUP_REVOKED_HINT, { exact: true }).waitFor()
  await groupRegion('solo').getByText(GROUP_REVOKED_HINT, { exact: true }).waitFor()
  await expect.poll(() => modelCheck('solo', 'vv-model-a').isChecked()).toBe(true)
  await expect.poll(() => modelCheck('solo', 'vv-model-solo').isDisabled()).toBe(true)
  await expect.poll(async () => listedModelIds(soloProvider)).toEqual([])
  await expect.poll(() => refreshDirectory.isEnabled()).toBe(true)
  await goldenModal('groups-revoked')
  vvcode.state.groupsMode = 'ok'
  await refreshDirectory.click()
  await expect.poll(() => groupRegion('team').getByText(GROUP_REVOKED_HINT, { exact: true }).count()).toBe(0)
  await expect.poll(() => groupRegion('solo').getByText(GROUP_REVOKED_HINT, { exact: true }).count()).toBe(0)
  await expect.poll(() => modelCheck('solo', 'vv-model-solo').isEnabled()).toBe(true)
  await expect.poll(() => modelCheck('solo', 'vv-model-a').isChecked()).toBe(true)
  await expect.poll(async () => listedModelIds(soloProvider)).toEqual(['vv-model-a'])
  await cancelButton.click()
  await expect.poll(() => modal.count()).toBe(0)

  // An expired sign-in keeps the summary and rows, and only the explicit refresh learns the
  // expiry without any wire request; removals stay available while adds, tests and saves lock.
  const firstGrant = vvcode.state.grants[0]
  await scaffold.ctx.credentials.modifyRecord(VVCODE_RECORD, () => Promise.resolve({
    kind: 'grant',
    payload: { ...firstGrant, version: 1, origin: VVCODE_ORIGIN, expiresAt: Date.now() - 1_000 },
  }))
  await openManage(['team', 'solo'])
  const listsBeforeExpired = vvcode.state.groupListReads
  await refreshDirectory.click()
  await modal.getByRole('alert').getByText('登录已失效，请重新授权后使用 VVCode；已选模型已保留', { exact: true }).waitFor()
  expect(vvcode.state.groupListReads).toBe(listsBeforeExpired)
  await expect.poll(() => refreshDirectory.isEnabled()).toBe(true)
  await expect.poll(() => modelCheck('team', 'vv-model-a').isChecked()).toBe(true)
  // Unchecking stays available for expired accounts on every checked model; adding an
  // unchecked one does not, and neither does testing or saving.
  await expect.poll(() => modelCheck('team', 'vv-model-a').isEnabled()).toBe(true)
  await expect.poll(() => modelCheck('solo', 'vv-model-solo').isDisabled()).toBe(true)
  await expect.poll(() => modelRow('team', 'vv-model-a').getByRole('button', { name: '测试', exact: true }).isDisabled()).toBe(true)
  await expect.poll(() => saveButton.isDisabled()).toBe(true)
  await cancelButton.click()
  await expect.poll(() => modal.count()).toBe(0)
  await refreshUsage.click()
  await expect.poll(() => card.getByText('账号余额', { exact: true }).count()).toBe(0)
  expect(await card.getByText('有效订阅 #1', { exact: true }).count()).toBe(0)
  await expect.poll(() => manageButton.isEnabled()).toBe(true)
  await card.getByText('已选 3 个型号（2 个分组）', { exact: true }).waitFor()
  expect(await card.getByRole('button', { name: '重新授权', exact: true }).isEnabled()).toBe(true)
  await goldenCard('card-expired')

  await card.getByRole('button', { name: '重新授权', exact: true }).click()
  await card.getByRole('link', { name: '打开授权页面' }).waitFor()
  const secondHref = await card.getByRole('link', { name: '打开授权页面' }).getAttribute('href')
  const secondUrl = new URL(secondHref ?? '')
  expect(secondUrl.searchParams.get('state')).not.toBe(loginUrl.searchParams.get('state'))
  vvcode.state.loginStartUrls.push(secondHref!)
  expect((await realFetch(`${secondUrl.searchParams.get('redirect_uri')}?code=test-code&state=${secondUrl.searchParams.get('state')}`)).status).toBe(200)
  await card.getByText('已授权', { exact: true }).waitFor()
  await card.getByText('已选 3 个型号（2 个分组）', { exact: true }).waitFor()
  await openManage(['team', 'solo'])
  await expect.poll(() => modelCheck('solo', 'vv-model-a').isChecked()).toBe(true)
  await expect.poll(() => refreshDirectory.isEnabled()).toBe(true)
  await expect.poll(() => modelRow('team', 'vv-model-a').getByRole('button', { name: '测试', exact: true }).isEnabled()).toBe(true)
  await cancelButton.click()
  await expect.poll(() => modal.count()).toBe(0)

  // Cancelling a sign-in attempt closes the loopback listener and changes nothing.
  await card.getByRole('button', { name: '重新授权', exact: true }).click()
  await card.getByRole('link', { name: '打开授权页面' }).waitFor()
  const thirdHref = await card.getByRole('link', { name: '打开授权页面' }).getAttribute('href')
  const thirdUrl = new URL(thirdHref ?? '')
  vvcode.state.loginStartUrls.push(thirdHref!)
  await card.getByRole('button', { name: '取消', exact: true }).click()
  await card.getByText('登录已取消。', { exact: true }).waitFor()
  await expect.poll(async () => {
    try {
      const late = await realFetch(`${thirdUrl.searchParams.get('redirect_uri')}?code=late-code&state=${thirdUrl.searchParams.get('state')}`)
      return late.status
    } catch {
      // The listener is expected to be gone after cancellation.
      return 0
    }
  }, { timeout: 10_000 }).toBe(0)
  await card.getByText('已授权', { exact: true }).waitFor()
  await card.getByText('已选 3 个型号（2 个分组）', { exact: true }).waitFor()
  expect(vvcode.state.grants).toHaveLength(2)
  expect(vvcode.state.tokens.map(token => token.id).sort((a, b) => a - b)).toEqual([8, 9])

  // Collect the subscription-owned key references before disconnecting so the cleanup can be proven.
  const modelKeyRefs = collectApiKeyRefs(settingsValue())
  expect(new Set(modelKeyRefs).size).toBe(2)
  for (const ref of modelKeyRefs) {
    expect(await scaffold.ctx.credentials.describe(credentialRef(ref))).toMatchObject({ configured: true })
  }

  // Declining the disconnect confirm clears nothing; accepting it removes every owned group
  // binding, key and selection while the manual API connection stays usable.
  dismissNextConfirm()
  await card.getByRole('button', { name: '解除连接', exact: true }).click()
  expect(confirmMessages.at(-1)).toBe(DISCONNECT_CONFIRM)
  await card.getByText('已授权', { exact: true }).waitFor()
  await card.getByText('已选 3 个型号（2 个分组）', { exact: true }).waitFor()
  acceptNextConfirm()
  await card.getByRole('button', { name: '解除连接', exact: true }).click()
  await card.getByText('未授权', { exact: true }).waitFor()
  await expect.poll(() => manageButton.count()).toBe(0)
  expect(await card.getByText(/已选 \d+ 个型号/).count()).toBe(0)
  await expect.poll(() => card.getByRole('button', { name: '登录授权', exact: true }).isEnabled()).toBe(true)
  expect(await scaffold.ctx.credentials.describeRecord(VVCODE_RECORD)).toMatchObject({ configured: false })
  expect(collectApiKeyRefs(settingsValue())).toEqual([])
  for (const ref of modelKeyRefs) {
    expect(await scaffold.ctx.credentials.describe(credentialRef(ref))).toMatchObject({ configured: false })
  }
  expect(await listedModelIds(teamProvider)).toEqual([])
  expect(await listedModelIds(soloProvider)).toEqual([])
  expect((await service.subscriptions()).find(row => row.id === 'vvcode'))
    .toMatchObject({ connected: false, models: [] })

  // A fresh sign-in whose account lists no groups renders the empty dialog status from the
  // sign-in directory round itself, because no saved row exists; the revoked-group rendering
  // above covers the connected-account case.
  vvcode.state.groupsMode = 'empty'
  await card.getByRole('button', { name: '登录授权', exact: true }).click()
  await card.getByRole('link', { name: '打开授权页面' }).waitFor()
  const fourthHref = await card.getByRole('link', { name: '打开授权页面' }).getAttribute('href')
  const fourthUrl = new URL(fourthHref ?? '')
  vvcode.state.loginStartUrls.push(fourthHref!)
  expect((await realFetch(`${fourthUrl.searchParams.get('redirect_uri')}?code=test-code&state=${fourthUrl.searchParams.get('state')}`)).status).toBe(200)
  await card.getByText('已授权', { exact: true }).waitFor()
  await card.getByText('已选 0 个型号（0 个分组）', { exact: true }).waitFor()
  await openManage()
  await modal.getByText('当前账号没有可用的 VVCode 分组，请向 VVCode 确认分组权限后重新读取', { exact: true }).waitFor()
  await goldenModal('groups-empty')
  await cancelButton.click()
  await expect.poll(() => modal.count()).toBe(0)

  expect(manualProviderList())
    .toEqual([expect.objectContaining({ models: [expect.objectContaining({ id: 'manual-kept-model' })] })])
  await panel.getByRole('tab', { name: 'API', exact: true }).click()
  await manualCard.getByRole('group', { name: 'manual-kept-model', exact: true }).waitFor()
  await manualCard.getByRole('group', { name: 'manual-kept-model', exact: true })
    .getByRole('button', { name: '测试', exact: true }).click()
  await manualCard.getByRole('group', { name: 'manual-kept-model', exact: true }).getByRole('status')
    .getByText('连接成功 · 支持工具调用', { exact: true }).waitFor()
  expect(vvcode.state.chatRequests.at(-1)).toMatchObject({ key: MANUAL_MODEL_KEY, appHeader: null, model: 'manual-kept-model' })

  expect(vvcode.state.tokenCreates).toBe(2)
  expect(vvcode.state.tokenKeyCalls).toBe(2)
  expect(vvcode.state.tokenSearches).toBe(0)
  expect(syncGroupRpc).not.toHaveBeenCalled()
  expect(vvcode.state.groupModelReads.every(read => read.key?.startsWith('nap_'))).toBe(true)
  expect(vvcode.state.relayKeyReads.every(read => !read.key?.startsWith('nap_'))).toBe(true)
  const config = await readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')
  expect(config).not.toMatch(/nap_|sk-vvcode-team-model-key|sk-vvcode-solo-model-key|sk-manual-connection-key/)
  expect(JSON.stringify(settingsValue())).not.toMatch(/nap_|sk-vvcode|sk-manual/)
  expect(errors).toEqual([])
})
