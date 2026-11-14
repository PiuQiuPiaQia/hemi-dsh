/** Two authenticated clients operate one Host; the phone never starts another runtime. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { TLSSocket } from 'node:tls'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { describe, expect, it, onTestFinished } from 'vitest'
import type {} from '@deepseek-ai/dsh-hemi-mobile-access'
import type { MobileAccessState, MobileInvitation } from '@deepseek-ai/dsh-hemi-mobile-access/types'
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole, webSnapshotMode,
} from './scaffold.ts'
import { openSettings, ZH_BROWSER_LOCALE } from './support.ts'
import { ScriptedAdapter, textResponse } from '../../../packages/hemi/routing/tests/mock-llm.ts'

const MODE = webSnapshotMode()
const DIR = fileURLToPath(new URL('../../../snapshots/web/hemi-mobile-access/', import.meta.url))
const SEED = new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url)
const OVERLAY = fileURLToPath(new URL('./hemi-mobile-access.overlay.yml', import.meta.url))
const HAS_LAN = Object.values(networkInterfaces()).flat().some(address => address !== undefined
  && !address.internal && address.family === 'IPv4' && privateIpv4(address.address))

/** The recorded history's model switch needs an explicit target capacity, even with a scripted provider. */
class PhoneAdapter extends ScriptedAdapter {
  override providerInfo() { return { id: 'hemi-mobile-test', name: 'Phone test' } }
  override async listModels() { return [{ provider: 'hemi-mobile-test', id: 'test-model', name: 'Phone test' }] }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { ...await super.resolveModel(provider, model), context: { contextWindow: 1_000_000 }, defaultMaxTokens: 4096 }
  }
}

function privateIpv4(address: string): boolean {
  const [a, b] = address.split('.').map(Number)
  return a === 10 || (a === 172 && b !== undefined && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 169 && b === 254)
}

async function setScheme(page: Page, dark: boolean): Promise<void> {
  await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' })
  await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(dark)
}

async function openRecordedHistory(page: Page): Promise<void> {
  if ((page.viewportSize()?.width ?? 1280) < 760) await page.locator('[data-sidebar-opener]').click()
  const workspace = page.getByRole('treeitem').first()
  await workspace.waitFor()
  if (await workspace.getAttribute('aria-expanded') !== 'true') await workspace.click()
  await page.getByRole('treeitem').nth(1).click()
  await page.getByText('DONE', { exact: true }).waitFor()
}

describe.skipIf(MODE === 'record')('Hemi phone connection', () => {
  it('keeps phone access closed until the desktop owner enables it', async () => {
    const app = await launchWebScaffold({ extraOverlayPath: OVERLAY, profile: { hmr: false, packages: [] } })
    onTestFinished(() => app.close())
    const browser = await chromium.launch()
    onTestFinished(() => browser.close())
    const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE })
    await page.goto(app.authenticatedUrl, { waitUntil: 'load' })
    await openSettings(page, 'zh')
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await settings.getByRole('button', { name: '手机连接', exact: true }).click()
    const section = settings.getByRole('region', { name: '手机连接', exact: true })
    await section.getByText('未开启', { exact: true }).waitFor()
    expect(await section.getByRole('img', { name: '一次性手机配对二维码', exact: true }).count()).toBe(0)
    const state = await app.ctx.typertGateway.invoke({ namespace: 'hemiMobileAccess', method: 'getState', args: {}, peer: app.ctx.connection.browserPeer }) as MobileAccessState
    expect(state.listening).toBe(false)
    expect(state.origin).toBeNull()
    expect(state.devices).toEqual([])
  })

  it('shows native computer controls in settings without desktop pairing actions', async () => {
    const app = await launchWebScaffold({ extraOverlayPath: OVERLAY, profile: { hmr: false, packages: [] } })
    onTestFinished(() => app.close())
    const browser = await chromium.launch()
    onTestFinished(() => browser.close())
    const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 390, height: 844 } })
    await page.addInitScript(() => {
      Object.defineProperty(window, '__HEMI_MOBILE__', { value: Object.freeze({
        version: 1,
        serverName: '这台已连接的电脑，完整名称应在窄屏正常换行',
        disconnect: () => {
          const key = 'native-disconnect-count'
          sessionStorage.setItem(key, String(Number(sessionStorage.getItem(key) ?? '0') + 1))
        },
      }) })
    })
    await page.goto(app.authenticatedUrl, { waitUntil: 'load' })
    await openSettings(page, 'zh')
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await settings.getByRole('button', { name: '手机连接', exact: true }).click()
    const section = settings.getByRole('region', { name: '手机连接', exact: true })
    await section.getByRole('heading', { name: '连接的电脑', exact: true }).waitFor()
    expect(await section.getByRole('button', { name: '开启手机连接', exact: true }).count()).toBe(0)
    expect(await section.getByRole('img', { name: '一次性手机配对二维码', exact: true }).count()).toBe(0)
    expect(await section.getByRole('button', { name: '断开连接', exact: true }).isEnabled()).toBe(true)
    await section.getByRole('button', { name: '断开连接', exact: true }).click()
    expect(await page.evaluate(() => sessionStorage.getItem('native-disconnect-count'))).toBe('1')
  })

  // The production listener intentionally refuses loopback/public/wildcard binds. The full network case needs a private interface.
  it.skipIf(!HAS_LAN)('pairs a phone and shares recorded history, live input and revocation with the desktop', async () => {
    const app = await launchWebScaffold({ extraOverlayPath: OVERLAY, profile: { hmr: false, packages: [] } })
    onTestFinished(() => app.close())
    const seed = await seedSession(app, await readFile(SEED, 'utf8'), 'hemi-mobile-history')
    const browser = await chromium.launch()
    onTestFinished(() => browser.close())
    const desktop = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1280, height: 820 } })
    const desktopConsole = watchConsole(desktop)
    await mkdir('.artifacts', { recursive: true })
    const screenshots = await mkdtemp('.artifacts/hemi-mobile-access-')
    console.log(`Phone connection screenshots: ${screenshots}`)
    await desktop.goto(app.authenticatedUrl, { waitUntil: 'load' })
    await openRecordedHistory(desktop)
    await openSettings(desktop, 'zh')
    const settings = desktop.getByRole('dialog', { name: '设置', exact: true })
    await settings.getByRole('button', { name: '手机连接', exact: true }).click()
    const section = settings.getByRole('region', { name: '手机连接', exact: true })
    const state = await app.ctx.typertGateway.invoke({ namespace: 'hemiMobileAccess', method: 'getState', args: {}, peer: app.ctx.connection.browserPeer }) as MobileAccessState
    expect(state.addresses.length).toBeGreaterThan(0)
    expect(await section.getByRole('button', { name: '网络地址', exact: true }).count()).toBe(0)
    expect(await section.getByRole('combobox').count()).toBe(0)
    await section.getByRole('button', { name: '开启手机连接', exact: true }).click()
    await section.getByRole('img', { name: '一次性手机配对二维码', exact: true }).waitFor()
    await section.getByText('手动配对', { exact: true }).click()
    const invitation = JSON.parse(await section.getByRole('textbox', { name: '复制配对内容', exact: true }).inputValue()) as MobileInvitation
    expect(invitation.kind).toBe('hemi-dsh-mobile')
    expect(invitation.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    const origins = invitation.origins ?? [invitation.origin]
    expect(origins[0]).toBe(invitation.origin)
    expect(new Set(origins).size).toBe(origins.length)
    expect(new Set(origins.map(origin => new URL(origin).port)).size).toBe(1)
    const phoneInvitation = { ...invitation, origin: origins.at(-1) ?? invitation.origin }
    for (const origin of origins) {
      const probe = await fixtureRequest({ ...invitation, origin }, '/mobile/session', {})
      expect(probe.status).toBe(401)
      expect(probe.cookies).toEqual([])
    }
    await desktop.getByRole('heading', { name: '手机连接', exact: true }).scrollIntoViewIfNeeded()
    await desktop.screenshot({ path: join(screenshots, 'invitation-1280-light.png'), animations: 'disabled' })
    await desktop.setViewportSize({ width: 390, height: 844 })
    await setScheme(desktop, true)
    await desktop.getByRole('heading', { name: '手机连接', exact: true }).scrollIntoViewIfNeeded()
    await desktop.screenshot({ path: join(screenshots, 'invitation-390-dark.png'), animations: 'disabled' })
    await desktop.setViewportSize({ width: 1280, height: 820 })
    const deviceSecret = randomBytes(32).toString('base64url')
    const requestId = randomUUID()
    const before = await fixtureRequest(phoneInvitation, '/api/session/list', { body: {} })
    expect(before.status).toBe(401)
    const pairing = await fixtureRequest(phoneInvitation, '/mobile/pair', { body: {
      version: 1, invitationToken: invitation.token, requestId, deviceName: '测试 iPhone', secret: deviceSecret,
    } })
    expect(pairing.status).toBe(200)
    const claim = JSON.parse(pairing.body) as { verificationCode: string }
    expect(claim.verificationCode).toMatch(/^\d{6}$/)
    await section.getByText(claim.verificationCode, { exact: true }).waitFor()
    await expect.poll(() => section.getByRole('img', { name: '一次性手机配对二维码', exact: true }).count()).toBe(0)
    await section.getByText(claim.verificationCode, { exact: true }).scrollIntoViewIfNeeded()
    await desktop.screenshot({ path: join(screenshots, 'pending-1280-dark.png'), animations: 'disabled' })
    await desktop.setViewportSize({ width: 390, height: 844 })
    await setScheme(desktop, false)
    await section.getByText(claim.verificationCode, { exact: true }).scrollIntoViewIfNeeded()
    await desktop.screenshot({ path: join(screenshots, 'pending-390-light.png'), animations: 'disabled' })
    await desktop.setViewportSize({ width: 1280, height: 820 })
    const allow = section.getByRole('button', { name: '号码一致，允许连接', exact: true })
    expect(await section.getByRole('checkbox').count()).toBe(0)
    expect(await section.getByText('连接请求', { exact: true }).count()).toBe(0)
    expect(await section.getByRole('button', { name: '重新生成邀请', exact: true }).count()).toBe(0)
    expect(await allow.isEnabled()).toBe(true)
    await allow.click()
    await section.getByRole('button', { name: '撤销访问', exact: true }).waitFor()
    expect(await section.getByRole('heading', { name: '确认连接 测试 iPhone', exact: true }).count()).toBe(0)
    const outcome = await fixtureRequest(phoneInvitation, '/mobile/pair/status', { body: { requestId, secret: deviceSecret } })
    const approved = JSON.parse(outcome.body) as { status: string; deviceId: string }
    expect(approved.status).toBe('approved')
    const credential = `${approved.deviceId}.${deviceSecret}`
    const session = await fixtureRequest(phoneInvitation, '/mobile/session', { credential })
    expect(session.status).toBe(200)
    expect(session.cookies.join(';')).toContain('HttpOnly')
    expect(session.cookies.join(';')).toContain('Secure')
    expect(session.body).not.toContain(deviceSecret)
    const phoneContext = await browser.newContext({ ignoreHTTPSErrors: true, locale: ZH_BROWSER_LOCALE,
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    await phoneContext.addCookies([{ name: '__Host-hemi-mobile', value: credential, url: phoneInvitation.origin,
      httpOnly: true, secure: true, sameSite: 'Strict' }])
    const phone = await phoneContext.newPage()
    const phoneConsole = watchConsole(phone)
    await phone.goto(phoneInvitation.origin, { waitUntil: 'load' })
    try { await openRecordedHistory(phone) } catch (error) {
      await mkdir('.artifacts', { recursive: true })
      const diagnostics = await mkdtemp('.artifacts/hemi-mobile-open-failure-')
      await phone.screenshot({ path: join(diagnostics, 'phone.png'), animations: 'disabled' })
      console.log('Phone open diagnostics:', diagnostics, await phone.locator('body').innerText(), phoneConsole.pageErrors)
      throw error
    }
    expect(await phone.evaluate(() => document.cookie)).not.toContain(deviceSecret)
    await compareOrRefreshGolden(join(DIR, 'phone-history.expected.md'),
      await captureStableAria(phone, '[class*="centerCol"]', app.workspaceCwd), MODE)
    for (const dark of [false, true]) {
      await setScheme(phone, dark)
      await phone.screenshot({ path: join(screenshots, `phone-390-${dark ? 'dark' : 'light'}.png`), animations: 'disabled' })
      await setScheme(desktop, dark)
      await desktop.screenshot({ path: join(screenshots, `settings-1280-${dark ? 'dark' : 'light'}.png`), animations: 'disabled' })
    }
    const manage = await fixtureRequest(phoneInvitation, '/api/hemiMobileAccess/getState', {
      credential, body: { type: 'client-request', rpcId: 'phone-management', method: 'hemiMobileAccess/getState', payload: { args: {} } },
    })
    expect(manage.body).toContain('hemi-mobile/unauthorized')
    const adapter = new PhoneAdapter([textResponse('PHONE_ACCEPTED')])
    app.ctx.llm.registerAdapter(['hemi-mobile-test'], adapter)
    const agent = app.ctx.agents.list().find(candidate => candidate.session.id === seed)
    if (agent === undefined) throw new Error('seeded Host Agent is unavailable')
    agent.model.select({ provider: 'hemi-mobile-test', model: 'test-model' })
    const beforeIds = app.ctx.agents.list().map(candidate => candidate.session.id)
    await phone.locator('[data-composer-input]').first().fill('Continue from the phone')
    const settled = app.whenTurnSettled()
    await phone.getByRole('button', { name: '发送消息', exact: true }).click()
    await settled
    if (adapter.requests.length !== 1) console.log('Phone send diagnostic:', {
      requests: adapter.requests.length, model: agent.model.current(),
      events: agent.session.snapshotEvents().slice(-8).map(event => ({ type: event.type, data: event.data })),
      page: await phone.locator('body').innerText(),
    })
    expect(adapter.requests).toHaveLength(1)
    await phone.getByText('PHONE_ACCEPTED', { exact: true }).waitFor()
    await desktop.keyboard.press('Escape')
    await settings.waitFor({ state: 'hidden' })
    await desktop.getByText('PHONE_ACCEPTED', { exact: true }).waitFor()
    expect(app.ctx.agents.list().map(candidate => candidate.session.id)).toEqual(beforeIds)
    expect(adapter.requests).toHaveLength(1)
    await openSettings(desktop, 'zh')
    await settings.getByRole('button', { name: '手机连接', exact: true }).click()
    await section.getByRole('button', { name: '撤销访问', exact: true }).click()
    await section.getByText('已撤销设备访问', { exact: true }).waitFor()
    for (const origin of origins) {
      expect((await fixtureRequest({ ...invitation, origin }, '/mobile/session', { credential })).status).toBe(401)
    }
    await section.getByRole('button', { name: '关闭手机连接', exact: true }).click()
    await section.getByText('未开启', { exact: true }).waitFor()
    expect(desktopConsole.pageErrors).toEqual([])
    expect(phoneConsole.pageErrors).toEqual([])
  })
})

interface PinnedResponse { status: number; body: string; cookies: string[] }

/** Read a controlled fixture listener and check its response leaf; production admission uses the native pin gate. */
function fixtureRequest(
  invitation: MobileInvitation, path: string, options: { body?: object; credential?: string },
): Promise<PinnedResponse> {
  const body = options.body === undefined ? undefined : JSON.stringify(options.body)
  return new Promise((resolve, reject) => {
    const request = httpsRequest(new URL(path, invitation.origin), {
      method: body === undefined ? 'GET' : 'POST', rejectUnauthorized: false,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }),
        ...(options.credential === undefined ? {} : { authorization: `Bearer ${options.credential}` }),
      },
    }, (response) => {
      const socket = response.socket
      if (!(socket instanceof TLSSocket)) {
        response.destroy(); reject(new Error('fixture did not use TLS')); return
      }
      const certificate = socket.getPeerCertificate()
      if (createHash('sha256').update(certificate.raw).digest('hex') !== invitation.fingerprint) {
        response.destroy(); reject(new Error('invited certificate mismatch')); return
      }
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      response.on('error', reject)
      response.on('end', () => { resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), cookies: response.headers['set-cookie'] ?? [] }) })
    })
    request.on('error', reject)
    request.setTimeout(15_000, () => { request.destroy(new Error('fixture request timed out')) })
    request.end(body)
  })
}
