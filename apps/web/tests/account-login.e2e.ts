// Real-composition acceptance for DeepSeek account sign-in from a plain browser. The
// scaffold boots the shipped Web Loader tree, so the real account provider drives
// auth_init, the loopback OAuth callback, and auth_exchange against a loopback Platform
// double, while a real Chromium follows the tab the Web UI preopens.
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, onTestFinished } from 'vitest'
import { compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const OVERLAY_TEMPLATE = fileURLToPath(new URL('./fixtures/account-login/cordis.patch.yml', import.meta.url))
const MODE = webSnapshotMode()
const TOKEN = 'dsh_web_login_test'
const CODE = 'web-login-code'
const AVATAR_EXPECTED = fileURLToPath(new URL('./expected/account-login/avatar-retry.expected.md', import.meta.url))
const HEMI_EXPECTED = fileURLToPath(new URL('./expected/account-login/hemi-connection.expected.md', import.meta.url))

/** Loopback Platform double: authorization handoff, code exchange, and the signed-in profile reads. */
async function mockPlatform() {
  const inits: Record<string, unknown>[] = []
  const pages: string[] = []
  let state: string | undefined
  let redirectUri: string | undefined
  let avatarRequests = 0
  let modelListings = 0
  let listingUnavailable = false
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const reply = (payload: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: payload } }))
    }
    if (url.pathname === '/dsh/authorize') {
      pages.push(url.href)
      // The user approves at once: Platform returns the browser to the Host callback.
      const callback = new URL(redirectUri ?? '/')
      callback.searchParams.set('code', CODE)
      callback.searchParams.set('state', state ?? '')
      res.writeHead(302, { location: callback.href }).end()
      return
    }
    if (url.pathname === '/dsh/authorized') {
      pages.push(url.href)
      res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Authorized</title>')
      return
    }
    if (req.method === 'POST' && url.pathname.startsWith('/auth-api/v0/dsh/')) {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => { body += chunk })
      req.on('end', () => {
        const payload = JSON.parse(body) as Record<string, unknown>
        if (url.pathname === '/auth-api/v0/dsh/auth_init') {
          inits.push(payload)
          state = String(payload.state)
          redirectUri = String(payload.redirect_uri)
          reply({ authorize_url: `${origin}/dsh/authorize?authorize_id=web`, authorize_id: 'web', expires_in: 300 })
          return
        }
        if (url.pathname === '/auth-api/v0/dsh/auth_exchange' && payload.code === CODE) {
          reply({ token: TOKEN, authorized_url: `${origin}/dsh/authorized` })
          return
        }
        res.writeHead(404).end()
      })
      return
    }
    if (url.pathname === '/avatar.svg') {
      avatarRequests++
      if (avatarRequests < 3) { res.writeHead(503, { 'cache-control': 'no-store' }).end(); return }
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=3600' })
        .end('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="16" fill="blue"/></svg>')
      return
    }
    if (req.headers['x-dsh-auth-token'] !== TOKEN) { res.writeHead(401).end(); return }
    if (url.pathname === '/models') {
      modelListings++
      if (listingUnavailable) { res.writeHead(503).end('listing unavailable'); return }
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ data: ['deepseek-flash', 'deepseek-v4-pro'].map(id => ({ id,
          api_capabilities: { anthropic_messages: {} } })) }))
      return
    }
    if (url.pathname === '/anthropic/v1/messages') {
      const frames = [
        { type: 'message_start', message: { id: 'connection-test', model: 'deepseek-flash', content: [],
          usage: { input_tokens: 3, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-test',
          name: 'model_connection_test', input: {} } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]
      res.writeHead(200, { 'content-type': 'text/event-stream' })
        .end(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''))
      return
    }
    if (url.pathname === '/auth-api/v0/users/current') {
      // `email` is required by the provider's profile schema even when the account has none.
      reply({ id: 'web-user', email: '', id_profile: { name: 'Web User', picture: `${origin}/avatar.svg` } })
      return
    }
    if (url.pathname === '/api/v0/users/get_user_summary') {
      reply({ normal_wallets: [{ currency: 'CNY', balance: '1.00' }], bonus_wallets: [] })
      return
    }
    if (url.pathname === '/api/v0/users/get_unnotified_bonuses') { reply([]); return }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('account login: missing mock listener')
  const origin = `http://127.0.0.1:${String(address.port)}`
  return {
    origin, inits, pages, avatarRequests: () => avatarRequests, modelListings: () => modelListings,
    setListingUnavailable: (value: boolean) => { listingUnavailable = value },
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }),
  }
}

describe.skipIf(MODE === 'record')('web e2e: DeepSeek account sign-in in a plain browser', () => {
  let root: string | undefined
  let scaffold: WebScaffold
  let browser: Browser
  let platform: Awaited<ReturnType<typeof mockPlatform>>

  beforeAll(async () => {
    platform = await mockPlatform()
    root = await mkdtemp(join(tmpdir(), 'dsh-web-account-login-'))
    const overlay = join(root, 'account-login.overlay.yml')
    await writeFile(overlay, (await readFile(OVERLAY_TEMPLATE, 'utf8')).replaceAll('{{origin}}', platform.origin)
      + '\n- id: hemi-model-settings\n  disabled: false\n- id: hemi-model-settings-ui\n  disabled: false\n'
      + '- id: hemi-model-access\n  disabled: false\n- id: hemi-model-access-ui\n  disabled: false\n')
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
    await scaffold.ctx.settings.mutate('llm-deepseek-account', [
      { op: 'set', path: ['baseURL'], value: `${platform.origin}/anthropic` },
    ])
    browser = await chromium.launch()
  })

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await platform?.close()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  })

  it('signs in from Hemi subscriptions, shows balances, and recovers both avatars on a later Settings entry', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'en-US', colorScheme: 'dark' })
    onTestFinished(() => context.close())
    const page = await context.newPage()
    const console = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-account-login'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const menu = page.getByRole('button', { name: 'Account menu', exact: true })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const initialSettings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await initialSettings.getByRole('button', { name: 'Model connections', exact: true }).click()
    const deepseek = initialSettings.getByRole('region', { name: 'DeepSeek', exact: true })
    const codex = initialSettings.getByRole('region', { name: 'ChatGPT Codex', exact: true })
    await expect.poll(() => initialSettings.innerText(), { timeout: 10_000 }).toContain('ChatGPT Codex')
    const cardStyle = (element: HTMLElement | SVGElement) => {
      const style = getComputedStyle(element)
      return [style.padding, style.borderRadius, style.backgroundColor, style.border]
    }
    expect(await deepseek.evaluate(cardStyle)).toEqual(await codex.evaluate(cardStyle))
    const connectionStates = [`Signed out\n${await deepseek.innerText()}`]
    const tab = context.waitForEvent('page')
    await deepseek.getByRole('button', { name: 'Sign in', exact: true }).click()
    const authorization = await tab
    await authorization.waitForURL(url => url.pathname === '/dsh/authorized', { timeout: 30_000 })
    expect(await authorization.evaluate(() => window.opener === null)).toBe(true)
    await expect.poll(() => menu.textContent(), { timeout: 30_000 }).toBe('Web User')
    await deepseek.getByText('¥1.00', { exact: true }).waitFor()
    const fetchModels = deepseek.getByRole('button', { name: 'Fetch models', exact: true })
    expect(await fetchModels.innerText()).toBe('')
    expect(await fetchModels.locator('svg').count()).toBe(1)
    const fetchBounds = await fetchModels.boundingBox()
    const reconnectBounds = await deepseek.getByRole('button', { name: 'Sign in again', exact: true }).boundingBox()
    expect(fetchBounds!.x + fetchBounds!.width).toBeLessThanOrEqual(reconnectBounds!.x)
    const refreshBalance = deepseek.getByRole('button', { name: 'Refresh balance', exact: true })
    expect(await refreshBalance.innerText()).toBe('')
    expect(await refreshBalance.locator('svg').count()).toBe(1)
    await refreshBalance.hover()
    await page.getByRole('tooltip', { name: 'Refresh balance', exact: true }).waitFor()
    const model = deepseek.getByRole('group', { name: 'deepseek-flash', exact: true })
    await model.waitFor()
    await deepseek.getByRole('group', { name: 'deepseek-v4-pro', exact: true }).waitFor()
    expect(platform.modelListings()).toBeGreaterThan(0)
    await model.getByRole('button', { name: 'Test', exact: true }).click()
    await model.getByText('Connected · tool calling supported', { exact: true }).waitFor()
    await model.getByRole('button', { name: 'Model settings', exact: true }).click()
    const modelSettings = page.getByRole('dialog', { name: 'Model settings', exact: true })
    await modelSettings.getByLabel('Display name', { exact: true }).fill('My DeepSeek')
    await modelSettings.getByRole('button', { name: 'Save model settings', exact: true }).click()
    await modelSettings.waitFor({ state: 'detached' })
    expect(scaffold.ctx.settings.describe().find(entry => entry.ns === 'llm-deepseek-account')?.value)
      .toMatchObject({ modelOverrides: { 'deepseek-flash': { name: 'My DeepSeek' } } })
    const listingCount = platform.modelListings()
    await deepseek.getByRole('button', { name: 'Fetch models', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Choose models', exact: true })
    await picker.getByText('All available models have been added.', { exact: true }).waitFor()
    expect(platform.modelListings()).toBeGreaterThan(listingCount)
    await picker.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(await deepseek.getByRole('progressbar').count()).toBe(0)
    connectionStates.push(`Signed in\n${await deepseek.innerText()}`)
    for (const id of ['deepseek-v4-pro', 'deepseek-flash']) {
      const confirmation = page.waitForEvent('dialog').then(dialog => dialog.accept())
      const row = deepseek.getByRole('group', { name: id, exact: true })
      await row.getByRole('button', { name: 'Remove model', exact: true }).click()
      await confirmation
      await row.waitFor({ state: 'detached' })
    }
    expect(await scaffold.ctx.llm.listModels('deepseek-account')).toEqual([])
    expect(scaffold.ctx.settings.describe().find(entry => entry.ns === 'llm-deepseek-account')?.value)
      .toMatchObject({ selectedModels: [], modelOverrides: { 'deepseek-flash': { name: 'My DeepSeek' } } })
    await initialSettings.getByRole('button', { name: 'General', exact: true }).click()
    await initialSettings.getByRole('button', { name: 'Model connections', exact: true }).click()
    expect(await deepseek.getByRole('group').count()).toBe(0)
    await deepseek.getByRole('button', { name: 'Disconnect', exact: true }).waitFor()
    connectionStates.push(`All models removed\n${await deepseek.innerText()}`)
    platform.setListingUnavailable(true)
    await deepseek.getByRole('button', { name: 'Fetch models', exact: true }).click()
    await picker.getByRole('alert').waitFor()
    expect(await picker.getByRole('checkbox').count()).toBe(0)
    expect(await scaffold.ctx.llm.listModels('deepseek-account')).toEqual([])
    platform.setListingUnavailable(false)
    await picker.getByRole('button', { name: 'Refresh', exact: true }).click()
    await picker.getByRole('checkbox', { name: 'deepseek-flash', exact: true }).check()
    await picker.getByRole('button', { name: 'Add selected models', exact: true }).click()
    await picker.waitFor({ state: 'detached' })
    await model.waitFor()
    expect((await scaffold.ctx.llm.listModels('deepseek-account')).map(item => item.id)).toEqual(['deepseek-flash'])
    await deepseek.getByRole('button', { name: 'Fetch models', exact: true }).click()
    expect(await picker.getByRole('checkbox', { name: 'deepseek-flash', exact: true }).count()).toBe(0)
    await picker.getByRole('checkbox', { name: 'deepseek-v4-pro', exact: true }).check()
    await picker.getByRole('button', { name: 'Add selected models', exact: true }).click()
    await picker.waitFor({ state: 'detached' })
    await deepseek.getByRole('group', { name: 'deepseek-v4-pro', exact: true }).waitFor()
    connectionStates.push(`Models added back\n${await deepseek.innerText()}`)
    await page.screenshot({ path: '.artifacts/hemi-deepseek-subscription.png', fullPage: true })
    await initialSettings.getByRole('button', { name: 'Close', exact: true }).click()
    await initialSettings.waitFor({ state: 'detached' })

    const pageOrigin = new URL(scaffold.authenticatedUrl).origin
    expect(platform.inits).toHaveLength(1)
    expect(platform.inits[0]).toMatchObject({ login_source: 'web', redirect_uri: `${pageOrigin}/oauth/callback` })
    const [authorize, authorized] = platform.pages.map(href => new URL(href))
    expect(authorize?.searchParams.get('theme')).toBe('dark')
    expect(authorized?.searchParams.get('login_source')).toBe('web')
    await expect.poll(platform.avatarRequests).toBe(1)
    await menu.locator('[data-avatar-status="failed"]').waitFor()
    expect(await menu.locator('img').count()).toBe(0)
    const states: string[] = []
    const capture = async (stage: string): Promise<void> => {
      const sidebar = menu.locator('[data-avatar-status]')
      const account = page.getByRole('region', { name: 'Account', exact: true })
      const mounted = await account.count() > 0
      const settingsStatus = mounted
        ? await account.locator('[data-avatar-status]').getAttribute('data-avatar-status') : 'unmounted'
      states.push(`${stage}: sidebar=${await sidebar.getAttribute('data-avatar-status')}, settings=${settingsStatus}, `
        + `sidebarImages=${await menu.locator('img').count()}, settingsImages=${mounted ? await account.locator('img').count() : 0}, `
        + `requests=${platform.avatarRequests()}`)
    }
    await capture('Initial load')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    const account = settings.getByRole('region', { name: 'Account', exact: true })
    await expect.poll(platform.avatarRequests).toBe(2)
    await account.locator('[data-avatar-status="failed"]').waitFor()
    expect(await menu.locator('img').count()).toBe(0)
    expect(await account.locator('img').count()).toBe(0)
    await capture('First Settings entry')
    await settings.getByRole('button', { name: 'Close', exact: true }).click()
    await settings.waitFor({ state: 'detached' })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect.poll(() => menu.locator('img').count()).toBe(1)
    await expect.poll(() => account.locator('img').count()).toBe(1)
    for (const image of [menu.locator('img'), account.locator('img')]) {
      await expect.poll(() => image.evaluate(element =>
        element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0)).toBe(true)
      expect(await image.getAttribute('src')).toBe(`${platform.origin}/avatar.svg`)
    }
    await capture('Second Settings entry')
    await settings.getByRole('button', { name: 'Close', exact: true }).click()
    await settings.waitFor({ state: 'detached' })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await account.waitFor()
    expect(await menu.locator('img').count()).toBe(1)
    expect(await account.locator('img').count()).toBe(1)
    expect(platform.avatarRequests()).toBe(3)
    await capture('Third Settings entry')
    await menu.locator('img').dispatchEvent('error')
    await menu.locator('[data-avatar-status="failed"]').waitFor()
    await account.locator('[data-avatar-status="failed"]').waitFor()
    expect(await menu.locator('img').count()).toBe(0)
    expect(await account.locator('img').count()).toBe(0)
    await capture('Rendered image failure')
    await settings.getByRole('button', { name: 'Close', exact: true }).click()
    await settings.waitFor({ state: 'detached' })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect.poll(() => menu.locator('img').count()).toBe(1)
    await expect.poll(() => account.locator('img').count()).toBe(1)
    await capture('Settings entry after rendered failure')
    await compareOrRefreshGolden(AVATAR_EXPECTED, states.join('\n'), MODE)
    for (const id of ['ui-settings-account', 'ui-settings-models']) {
      const entry = [...scaffold.ctx.loader.entries()].find(row => row.options.id === id)
      if (entry === undefined) throw new Error(`Missing native settings entry: ${id}`)
      const config: unknown = entry.options.config
      if (config === null || typeof config !== 'object' || Array.isArray(config)) throw new Error(`Invalid native settings config: ${id}`)
      await entry.update({ config: { ...config, showSettingsSection: false,
        ...id === 'ui-settings-account' ? { showLauncher: false } : {},
      } })
    }
    await scaffold.ctx.loader.await()
    await page.reload({ waitUntil: 'load' })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    expect(await settings.getByRole('button', { name: 'Account', exact: true }).count()).toBe(0)
    expect(await settings.getByRole('button', { name: 'Models', exact: true }).count()).toBe(0)
    expect(await menu.count()).toBe(0)
    await settings.getByRole('button', { name: 'Model connections', exact: true }).click()
    await deepseek.getByText('¥1.00', { exact: true }).waitFor()
    connectionStates.push(`Native navigation hidden\nAccount tab: ${await settings.getByRole('button', { name: 'Account', exact: true }).count()}`
      + `\nModels tab: ${await settings.getByRole('button', { name: 'Models', exact: true }).count()}\nAccount menu: ${await menu.count()}`
      + `\nModel connections tab: ${await settings.getByRole('button', { name: 'Model connections', exact: true }).count()}`)
    await compareOrRefreshGolden(HEMI_EXPECTED, connectionStates.join('\n\n'), MODE)
    await page.setViewportSize({ width: 390, height: 844 })
    await deepseek.waitFor()
    await refreshBalance.click()
    await expect.poll(() => refreshBalance.getAttribute('aria-busy')).toBe('false')
    await model.waitFor()
    await deepseek.getByRole('button', { name: 'Fetch models', exact: true }).waitFor()
    expect(await deepseek.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: '.artifacts/hemi-deepseek-subscription-mobile.png', fullPage: true })
    const declined = page.waitForEvent('dialog').then(dialog => dialog.dismiss())
    await deepseek.getByRole('button', { name: 'Disconnect', exact: true }).click()
    await declined
    expect(await deepseek.getByText('¥1.00', { exact: true }).count()).toBe(1)
    const accepted = page.waitForEvent('dialog').then(dialog => dialog.accept())
    await deepseek.getByRole('button', { name: 'Disconnect', exact: true }).click()
    await accepted
    await deepseek.getByRole('button', { name: 'Sign in', exact: true }).waitFor()
    expect(await deepseek.getByText('¥1.00', { exact: true }).count()).toBe(0)
    expect(console.pageErrors).toEqual([])
    await context.close()
  }, 90_000)
})
