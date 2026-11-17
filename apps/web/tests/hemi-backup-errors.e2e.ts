/** Real backup and workspace failures render localized summaries without server diagnostics. */
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import type { Locator, Page, Route } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-hemi-backup'
import { compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { openSettings, REPO_ROOT } from './support.ts'

const xml = '<?xml version="1.0"?><d:error xmlns:d="DAV:" xmlns:s="http://ns.jianguoyun.com"><s:exception>TrafficRateExhausted</s:exception><s:message>private-server-diagnostic</s:message></d:error>'

/** Server-side diagnostic payload a real gateway failure may carry; never user-renderable. */
const INTERNAL_DIAGNOSTICS = '<xml>/private/path token=secret</xml>'
const INTERNAL_DIAGNOSTICS_PATTERN = /\/private\/path|token=secret|gateway\/internal|<xml>/u

/**
 * Answer one unary Remote POST at the network boundary with a legal RPC error
 * envelope: the caller's rpcId echoed, a `gateway/internal` failure carrying
 * server-only diagnostics. The Host method never executes, so the browser
 * exercises exactly the untrusted-response path.
 */
async function fulfillGatewayInternal(route: Route): Promise<void> {
  const rpcId = (route.request().postDataJSON() as { rpcId?: unknown }).rpcId
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      type: 'server-response',
      rpcId: typeof rpcId === 'string' ? rpcId : '',
      result: { ok: false, error: { code: 'gateway/internal', message: INTERNAL_DIAGNOSTICS, details: {} } },
    }),
  })
}

/** New light/dark, 1280/390 evidence for one failed-operation scene; `frame` runs before each shot. */
async function captureEvidence(
  page: Page,
  name: string,
  frame: (width: number) => Promise<void>,
): Promise<string> {
  await mkdir(join(REPO_ROOT, '.artifacts'), { recursive: true })
  const evidence = await mkdtemp(join(REPO_ROOT, `.artifacts/${name}-`))
  for (const [width, theme] of [[1280, 'light'], [390, 'dark']] as const) {
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(theme === 'dark')
    await frame(width)
    await page.screenshot({ path: join(evidence, `${name}-${width}-${theme}.png`), animations: 'disabled' })
  }
  console.log(`${name} evidence: ${evidence}`)
  return evidence
}

it.each([
  { locale: 'zh' as const, browserLocale: 'zh-CN', nav: '备份', run: '立即备份', failed: '上次备份失败', generic: '无法确认操作结果，请先核对当前状态，再决定是否重试', quota: '云端可用流量不足，请等待额度恢复或升级云端套餐后重试' },
  { locale: 'en' as const, browserLocale: 'en-US', nav: 'Backup', run: 'Back up now', failed: 'Last backup failed', generic: 'The outcome could not be confirmed. Check the current state before trying again.', quota: 'The cloud service has insufficient transfer quota. Wait for it to reset or upgrade your plan, then try again.' },
])('hides old raw errors and explains a fresh WebDAV quota failure in $locale', async (copy) => {
  const home = await mkdtemp(join(tmpdir(), 'hemi-backup-errors-'))
  onTestFinished(() => rm(home, { recursive: true, force: true }))
  let uploads = 0
  const server = createServer((request, response) => {
    request.resume()
    if (request.method === 'PUT') {
      uploads += 1
      response.writeHead(403, { 'content-type': 'application/xml' })
      response.end(xml)
    } else if (request.method === 'PROPFIND') {
      response.writeHead(207, { 'content-type': 'application/xml' })
      response.end('<d:multistatus xmlns:d="DAV:"/>')
    } else {
      response.writeHead(201)
      response.end()
    }
  })
  onTestFinished(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections()
    server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('WebDAV fixture did not bind')
  const settingsPath = join(home, 'backup-settings.json')
  await writeFile(settingsPath, JSON.stringify({
    schemaVersion: 1, target: { kind: 'webdav', url: `http://127.0.0.1:${address.port}/dav/`, username: 'fixture-user', remoteDir: 'private-backups' },
    schedule: { enabled: false, interval: 'daily' }, keep: 5,
    lastRun: { at: '2026-11-16T12:14:27Z', ok: false, trigger: 'scheduled', message: `PUT private-backups/part-0000.gz: HTTP 403 ${xml}` },
  }))
  const scaffold = await launchWebScaffold({ developerTools: false, harnessHome: home })
  onTestFinished(() => scaffold.close())
  await scaffold.ctx.credentials.set(credentialRef('HEMI_BACKUP_WEBDAV_PASSWORD'), 'fixture-application-password')
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ locale: copy.browserLocale, timezoneId: 'Asia/Shanghai', viewport: { width: 1280, height: 900 }, colorScheme: 'light' })
  const tripwire = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await openSettings(page, copy.locale)
  await page.getByRole('button', { name: copy.nav, exact: true }).click()
  const section = page.getByRole('region', { name: copy.nav, exact: true })
  const lastRun = section.getByText(new RegExp(copy.failed))
  await lastRun.waitFor()
  expect(await lastRun.textContent()).toContain(copy.generic)
  expect(await section.innerText()).not.toMatch(/TrafficRateExhausted|private-server-diagnostic|HTTP 403|<d:error>/u)
  const run = section.getByRole('button', { name: copy.run, exact: true })
  await expect.poll(() => run.isEnabled()).toBe(true)
  await run.click()
  const notice = section.getByRole('status').filter({ hasText: copy.quota })
  await notice.waitFor()
  await expect.poll(() => lastRun.textContent()).toContain(copy.quota)
  expect(uploads).toBe(1)
  const persisted: unknown = JSON.parse(await readFile(settingsPath, 'utf8'))
  expect(persisted).toMatchObject({ lastRun: { ok: false, code: 'TRAFFIC_EXHAUSTED' } })
  await compareOrRefreshGolden(join(import.meta.dirname, 'expected/hemi-backup-errors', `${copy.locale}.expected.md`),
    await notice.ariaSnapshot(), webSnapshotMode())
  await captureEvidence(page, `backup-errors-${copy.locale}`, async () => {
    await lastRun.scrollIntoViewIfNeeded()
    expect(await section.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect(await section.innerText()).not.toMatch(/TrafficRateExhausted|private-server-diagnostic|HTTP 403|<d:error>/u)
  })
  expect(tripwire.pageErrors).toEqual([])
})

it.each([
  { locale: 'zh' as const, browserLocale: 'zh-CN', nav: '备份', test: '测试连接', generic: '无法确认操作结果，请先核对当前状态，再决定是否重试', quota: '云端可用流量不足，请等待额度恢复或升级云端套餐后重试' },
  { locale: 'en' as const, browserLocale: 'en-US', nav: 'Backup', test: 'Test connection', generic: 'The outcome could not be confirmed. Check the current state before trying again.', quota: 'The cloud service has insufficient transfer quota. Wait for it to reset or upgrade your plan, then try again.' },
])('answers a test-connection gateway failure with only the common summary in $locale', async (copy) => {
  const home = await mkdtemp(join(tmpdir(), 'hemi-backup-errors-'))
  onTestFinished(() => rm(home, { recursive: true, force: true }))
  const scaffold = await launchWebScaffold({ developerTools: false, harnessHome: home })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ locale: copy.browserLocale, timezoneId: 'Asia/Shanghai', viewport: { width: 1280, height: 900 }, colorScheme: 'light' })
  const tripwire = watchConsole(page)
  let failures = 0
  await page.route('**/api/hemiBackup/testConnection', async (route) => {
    failures += 1
    await fulfillGatewayInternal(route)
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await openSettings(page, copy.locale)
  await page.getByRole('button', { name: copy.nav, exact: true }).click()
  const section = page.getByRole('region', { name: copy.nav, exact: true })
  const test = section.getByRole('button', { name: copy.test, exact: true })
  await test.waitFor()
  await expect.poll(() => test.isEnabled()).toBe(true)
  await test.click()
  const notice = section.getByRole('status').filter({ hasText: copy.generic })
  await notice.waitFor()
  expect(await notice.textContent()).toBe(copy.generic)
  await expect.poll(() => section.innerText()).not.toMatch(INTERNAL_DIAGNOSTICS_PATTERN)
  expect(await section.innerText()).not.toContain(copy.quota)
  expect(failures).toBe(1)
  await compareOrRefreshGolden(
    join(import.meta.dirname, 'expected/hemi-backup-errors', `${copy.locale}-test-connection.expected.md`),
    await notice.ariaSnapshot(), webSnapshotMode(),
  )
  await captureEvidence(page, `backup-test-connection-${copy.locale}`, async () => {
    await notice.scrollIntoViewIfNeeded()
    expect(await section.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect(await test.isEnabled()).toBe(true)
    expect(await section.innerText()).not.toMatch(INTERNAL_DIAGNOSTICS_PATTERN)
  })
  expect(tripwire.pageErrors).toEqual([])
})

/** Reveal and click a row action, re-hovering if a projection update replaces the row before its hover-only button shows. */
async function clickRowAction(row: Locator, name: string): Promise<void> {
  const button = row.getByRole('button', { name })
  await expect.poll(async () => {
    await row.hover()
    return await button.isVisible()
  }, { timeout: 10_000 }).toBe(true)
  await button.click()
}

it.each([
  {
    locale: 'zh' as const, browserLocale: 'zh-CN', title: 'rename-errors-zh',
    draft: 'rename-errors-zh-renamed', actions: '工作区“rename-errors-zh”的操作', menu: '重命名',
    dialog: '重命名工作区', field: '工作区名称', confirm: '重命名', cancel: '取消',
    generic: '无法确认操作结果，请先核对当前状态，再决定是否重试',
  },
  {
    locale: 'en' as const, browserLocale: 'en-US', title: 'rename-errors-en',
    draft: 'rename-errors-en-renamed', actions: 'Workspace actions for rename-errors-en', menu: 'Rename',
    dialog: 'Rename workspace', field: 'Workspace name', confirm: 'Rename', cancel: 'Cancel',
    generic: 'The outcome could not be confirmed. Check the current state before trying again.',
  },
])('keeps the workspace rename dialog on the common summary when the wire refuses in $locale', async (copy) => {
  const home = await mkdtemp(join(tmpdir(), 'hemi-backup-errors-'))
  onTestFinished(() => rm(home, { recursive: true, force: true }))
  const scaffold = await launchWebScaffold({ developerTools: false, harnessHome: home })
  onTestFinished(() => scaffold.close())
  const workspaceDir = join(scaffold.workspaceCwd, copy.title)
  await mkdir(workspaceDir, { recursive: true })
  await scaffold.ctx.workspaceRegistry.create(workspaceDir, copy.title)
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ locale: copy.browserLocale, timezoneId: 'Asia/Shanghai', viewport: { width: 1280, height: 900 }, colorScheme: 'light' })
  const tripwire = watchConsole(page)
  let failures = 0
  await page.route('**/api/workspace/rename', async (route) => {
    failures += 1
    await fulfillGatewayInternal(route)
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const row = page.locator('[role="treeitem"]').filter({ hasText: copy.title }).first()
  await row.waitFor({ timeout: 10_000 })
  await clickRowAction(row, copy.actions)
  await page.getByRole('menuitem', { name: copy.menu, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: copy.dialog })
  await dialog.waitFor({ timeout: 10_000 })
  const input = dialog.getByLabel(copy.field)
  await input.fill(copy.draft)
  const confirm = dialog.getByRole('button', { name: copy.confirm, exact: true })
  const cancel = dialog.getByRole('button', { name: copy.cancel, exact: true })
  const alert = dialog.getByRole('alert').filter({ hasText: copy.generic })
  const refused = async (): Promise<void> => {
    await alert.waitFor()
    expect(await alert.textContent()).toBe(copy.generic)
    expect(await input.inputValue()).toBe(copy.draft)
    expect(await dialog.innerText()).not.toMatch(INTERNAL_DIAGNOSTICS_PATTERN)
    expect(await confirm.isEnabled()).toBe(true)
  }
  await expect.poll(() => confirm.isEnabled()).toBe(true)
  await confirm.click()
  await refused()
  expect(failures).toBe(1)
  // Retry is reachable: the dialog stays open, the draft survives, and the same
  // unary call refires through the same wire route.
  await confirm.click()
  await expect.poll(() => failures, { timeout: 10_000 }).toBe(2)
  await expect.poll(async () => await alert.textContent(), { timeout: 10_000 }).toBe(copy.generic)
  expect(await input.inputValue()).toBe(copy.draft)
  await compareOrRefreshGolden(
    join(import.meta.dirname, 'expected/hemi-backup-errors', `${copy.locale}-rename-dialog.expected.md`),
    await dialog.ariaSnapshot(), webSnapshotMode(),
  )
  await captureEvidence(page, `workspace-rename-${copy.locale}`, async () => {
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect(await confirm.isEnabled()).toBe(true)
    expect(await cancel.isEnabled()).toBe(true)
    expect(await dialog.innerText()).not.toMatch(INTERNAL_DIAGNOSTICS_PATTERN)
  })
  // Close is reachable and commits nothing further.
  await cancel.click()
  await dialog.waitFor({ state: 'detached', timeout: 10_000 })
  expect(failures).toBe(2)
  expect(tripwire.pageErrors).toEqual([])
})
