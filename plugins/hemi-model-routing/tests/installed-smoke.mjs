/** Keyless real-profile installation, browser, request-routing, and restart regression. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')
const area = resolve(process.argv[2] ?? join(root, '.artifacts/model-routing/installed-smoke'))
const requireWeb = createRequire(join(root, 'apps/web/package.json'))
const { chromium } = requireWeb('playwright')
mkdirSync(area, { recursive: true })
const commandLog = join(area, 'commands.log')
const checks = []
const note = (check, data = {}) => { checks.push({ check, ...data }); console.log(`PASS ${check}`) }
const sleep = milliseconds => new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds))

async function until(read, label, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (true) {
    const result = await read()
    if (result) return result
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`)
    await sleep(100)
  }
}

async function run(args, env = process.env) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
    appendFileSync(commandLog, data, { mode: 0o600 })
    output = (output + data).slice(-20000)
  })
  const status = await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolveExit({ code, signal }))
  })
  assert.equal(status.code, 0, `${args.join(' ')} failed (${status.signal ?? status.code})\n${output}`)
  return output
}

async function launch(state, port = 0) {
  const log = join(area, port === 0 ? 'server-first.log' : 'server-restored.log')
  const child = spawn(process.execPath, [
    '--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'web',
    '--patch', state.overlay, '--patch', 'apps/web/tests/pin-browse-picker.overlay.yml',
    '--no-open', '--port', String(port),
  ], { cwd: root, env: { ...process.env, DSH_HOME: state.home }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  let url
  const ended = new Promise(resolveExit => child.once('close', (code, signal) => resolveExit({ code, signal })))
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
    appendFileSync(log, data, { mode: 0o600 })
    output = (output + data).slice(-100000)
    url ??= /^dsh web: (https?:\/\/\S+)/m.exec(output)?.[1]
  })
  child.on('error', error => { output += `\n${error.stack}` })
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return ended
    child.kill('SIGTERM')
    let timer
    try {
      return await Promise.race([
        ended,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Test Host did not stop within 15 seconds')), 15000) }),
      ])
    } catch (error) {
      child.kill('SIGKILL')
      await ended
      throw error
    } finally { clearTimeout(timer) }
  }
  try {
    await until(() => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Test Host exited before readiness\n${output}`)
      return url
    }, 'official Web profile readiness', 90000)
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
    assert.ok([200, 302, 303].includes(response.status), `Host readiness returned ${response.status}`)
    return { child, url, stop }
  } catch (error) {
    await stop()
    throw error
  }
}

function calls(state) {
  return readFileSync(state.calls, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

async function connectWorkspace(page, state) {
  await page.addLocatorHandler(page.getByRole('dialog', { name: '预览版说明', exact: true }), async (dialog) => {
    await dialog.getByRole('button', { name: '继续', exact: true }).click()
  })
  const composer = page.locator('[data-conversation-session] [data-composer-input][contenteditable="true"]')
  if (await composer.isVisible()) return
  const workspace = join(state.home, 'workspace')
  mkdirSync(workspace, { recursive: true })
  await page.getByRole('button', { name: '添加工作区', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '选择工作区目录', exact: true })
  await dialog.getByRole('button', { name: '编辑路径', exact: true }).click()
  const input = dialog.getByRole('textbox', { name: '编辑路径', exact: true })
  await input.fill(workspace)
  await input.press('Enter')
  await dialog.getByRole('button', { name: '打开', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  await composer.and(page.locator('[data-placeholder="描述你想要构建的内容, / 调用指令, @ 文件或对话"]')).waitFor()
}

const modelButton = page => page.getByRole('button', { name: /^选择模型/ }).first()
async function openMode(page) {
  const trigger = modelButton(page)
  const row = page.locator('[data-routing-mode]')
  // The initial workspace handoff can replace the composer after its first render.
  await until(async () => await trigger.locator('[data-model-id]').count() > 0
    || /自动路由/.test(await trigger.innerText()), 'model trigger ready')
  await until(async () => {
    if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click()
    return row.isVisible()
  }, 'routing row in the native model menu')
  return row
}
async function configure(page) {
  await openMode(page)
  await page.getByRole('menuitem', { name: '配置模型路由', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '模型路由', exact: true })
  await dialog.locator('[data-routing-editor]').waitFor()
  return dialog
}
async function selectRoute(page, dialog, field, name) {
  await dialog.getByRole('button', { name: new RegExp(`^${field}：`) }).click()
  await page.getByRole('menu').last().getByText(name, { exact: true }).click()
  const saved = dialog.getByRole('button', { name: `${field}：${name}`, exact: true })
  await saved.waitFor()
  await until(() => saved.isEnabled(), `saved ${field}`)
}
async function enable(page) {
  const row = await openMode(page)
  await row.getByRole('menuitemradio', { name: '自动路由', exact: true }).click()
  await row.waitFor({ state: 'detached' })
  await until(async () => /自动路由/.test(await modelButton(page).innerText()), 'automatic routing selected')
}
async function chooseNativeModel(page, name) {
  await openMode(page)
  const option = page.getByRole('menuitemradio', { name, exact: true })
  await option.click()
  await option.waitFor({ state: 'detached' })
}
async function sendProbe(page, state, role, caseId, main, child) {
  const composer = page.locator('[data-composer-input][contenteditable="true"]').first()
  await composer.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type(`ROUTING_SMOKE:${role}:${caseId}`)
  await composer.press('Enter')
  await until(() => calls(state).find(entry => entry.kind === 'child' && entry.caseId === caseId), `child request ${caseId}`)
  const stop = page.getByRole('button', { name: '停止生成', exact: true })
  if (caseId === 'auto-fixer') {
    try {
      await stop.waitFor()
      assert.equal(calls(state).filter(entry => entry.caseId === caseId && entry.kind === 'parent').length, 1)
    } finally {
      writeFileSync(`${state.calls}.release-fixer`, '', { mode: 0o600 })
    }
    await page.getByText(`路由验证：主请求使用 routing-probe/${main}，已收到 fixer 子任务结果`, { exact: true }).waitFor()
    note('foreground fixer keeps the composer running until the parent receives its tool result')
  }
  await stop.waitFor({ state: 'hidden' })
  const matching = calls(state).filter(entry => entry.caseId === caseId)
  assert.ok(matching.some(entry => entry.kind === 'parent'))
  assert.deepEqual([...new Set(matching.filter(entry => entry.kind === 'parent').map(entry => entry.model))], [main])
  assert.deepEqual([...new Set(matching.filter(entry => entry.kind === 'child').map(entry => entry.model))], [child])
  note(`request binding ${caseId}`, { role, main, child })
}
async function captureDialog(page, name) {
  await page.screenshot({ path: join(area, `${name}.png`), fullPage: true })
  const bounds = await page.getByRole('dialog', { name: '模型路由', exact: true }).evaluate(element => {
    const rect = element.getBoundingClientRect()
    return { left: rect.left, right: rect.right, scroll: element.scrollWidth, client: element.clientWidth, viewport: innerWidth, page: document.documentElement.scrollWidth }
  })
  assert.ok(bounds.left >= -1 && bounds.right <= bounds.viewport + 1, JSON.stringify(bounds))
  assert.ok(bounds.scroll <= bounds.client + 1 && bounds.page <= bounds.viewport + 1, JSON.stringify(bounds))
}

async function reopenConversation(page, sessionId) {
  const conversation = page.locator(`[data-conversation-session=${JSON.stringify(sessionId)}]:visible`)
  if (!await conversation.isVisible()) {
    await page.locator(`[data-row-key=${JSON.stringify(`session:${sessionId}`)}]`).click()
  }
  await conversation.waitFor()
}

async function main() {
  const reuseInstallation = process.argv.includes('--reuse-installation')
  if (!reuseInstallation) writeFileSync(commandLog, '', { mode: 0o600 })
  const state = reuseInstallation
    ? JSON.parse(readFileSync(join(area, 'profile/state.json'), 'utf8'))
    : JSON.parse(await run([join(here, 'prepare-profile.mjs'), join(area, 'profile')]))
  if (reuseInstallation) {
    assert.equal(readFileSync(state.calls, 'utf8'), '', 'reuse is limited to installations with no probe requests yet')
    appendFileSync(commandLog, '\nResuming the installed profile after a pre-request startup failure.\n')
  } else {
    const packed = join(area, 'packages')
    await run([join(root, 'plugins/hemi-model-routing/pack.mjs'), packed])
    const archives = JSON.parse(readFileSync(join(packed, 'packages.json'), 'utf8')).packages.map(entry => join(packed, entry.file))
    await run(['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'plugin', '--profile', 'web', 'add', state.cleanBundle, ...archives, '--offline', '--ignore-scripts'], { ...process.env, DSH_HOME: state.home })
  }
  const profile = JSON.parse(readFileSync(join(state.profile, 'package.json'), 'utf8'))
  assert.ok(profile.dsh.profile.bundles.includes('@hemi/model-routing'))
  assert.ok(!profile.dsh.profile.bundles.includes('@deepseek-ai/dsh-web-app'))
  note('independent bundle installation without legacy Hemi rows')
  let server
  let browser
  let page
  const pageErrors = []
  try {
    server = await launch(state)
    browser = await chromium.launch({ headless: true, channel: process.env.HEMI_ROUTING_BROWSER_CHANNEL })
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' })
    context.setDefaultTimeout(15000)
    page = await context.newPage()
    page.on('pageerror', error => { pageErrors.push(error.message) })
    await page.goto(server.url, { waitUntil: 'load' })
    const html = await page.content()
    assert.ok(html.includes('@deepseek-ai/dsh-hemi-routing-ui'), 'installed Client must be in the boot roster')
    assert.ok(!html.includes('@deepseek-ai/dsh-client-ui-hemi-skins'), 'clean composition must not inherit the fork skin row')
    note('real Host ready with installed Client boot roster')
    await connectWorkspace(page, state)
    const firstRow = await openMode(page)
    assert.equal(await firstRow.getByRole('menuitemradio', { name: '自动路由', exact: true }).isEnabled(), false)
    note('installed model menu shows routing controls before configuration')
    await page.getByRole('menuitem', { name: '配置模型路由', exact: true }).click()
    let dialog = page.getByRole('dialog', { name: '模型路由', exact: true })
    await dialog.locator('[data-routing-editor]').waitFor()
    for (const [field, label] of [['主模型', '主模型'], ['研究', '研究模型'], ['评审', '评审模型'], ['执行', '执行模型'], ['设计', '设计模型']]) {
      await selectRoute(page, dialog, field, `验证 · ${label}`)
    }
    await captureDialog(page, 'configuration-light-1280')
    await page.setViewportSize({ width: 390, height: 844 })
    await captureDialog(page, 'configuration-light-390')
    await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
    await captureDialog(page, 'configuration-dark-390')
    await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'))
    await page.setViewportSize({ width: 1280, height: 900 })
    await dialog.getByRole('button', { name: '完成', exact: true }).click()
    await page.getByRole('button', { name: '账号菜单', exact: true }).click()
    await page.getByRole('menuitem', { name: '设置', exact: true }).click()
    const settingsDialog = page.getByRole('dialog', { name: '设置', exact: true })
    await settingsDialog.getByRole('button', { name: '模型', exact: true }).click()
    await settingsDialog.getByRole('button', { name: '配置模型路由', exact: true }).click()
    dialog = page.getByRole('dialog', { name: '模型路由', exact: true })
    await dialog.getByRole('button', { name: '主模型：验证 · 主模型', exact: true }).waitFor()
    await captureDialog(page, 'configuration-over-settings')
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    await settingsDialog.waitFor()
    await page.keyboard.press('Escape')
    await settingsDialog.waitFor({ state: 'detached' })
    note('Models settings opens the shared editor with independent modal dismissal')
    await enable(page)
    await openMode(page)
    const menu = page.getByRole('menu')
    const radios = menu.getByRole('menuitemradio')
    const catalog = menu.getByRole('group', { name: '模型', exact: true })
    assert.equal(await radios.first().getAttribute('aria-label'), '自动路由')
    assert.equal(await menu.getByRole('menuitemradio', { checked: true }).count(), 1)
    assert.ok(await menu.getByRole('switch', { name: /智能体团队协作/ }).isVisible())
    assert.ok(await catalog.getByRole('menuitemradio', { name: '验证 · 主模型', exact: true }).isVisible())
    assert.equal(await catalog.evaluate(node => getComputedStyle(node).overflowY), 'auto')
    note('automatic routing is the first and only selected model choice, with catalog and team controls in one menu')
    await page.screenshot({ path: join(area, 'automatic-routing-menu.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await until(async () => {
      const rect = await menu.boundingBox()
      return rect !== null && rect.x >= 0 && rect.x + rect.width <= 390
    }, 'flat picker fits a narrow viewport')
    await page.screenshot({ path: join(area, 'automatic-routing-menu-390.png'), fullPage: true })
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.keyboard.press('Escape')
    for (const role of ['explorer', 'oracle', 'fixer', 'designer']) await sendProbe(page, state, role, `auto-${role}`, 'main', role)
    dialog = await configure(page)
    await selectRoute(page, dialog, '设计', '跟随主模型')
    await dialog.getByRole('button', { name: '完成', exact: true }).click()
    await sendProbe(page, state, 'designer', 'auto-follow-main', 'main', 'main')
    await chooseNativeModel(page, '验证 · 主模型')
    const sameModel = await openMode(page)
    await until(async () => await sameModel.getAttribute('data-routing-mode') === 'fixed', 'same model exits automatic routing')
    assert.equal(await menu.getByRole('menuitemradio', { name: '验证 · 主模型', exact: true }).getAttribute('aria-checked'), 'true')
    await page.keyboard.press('Escape')
    note('selecting the already effective main model switches the session to fixed mode')
    await sendProbe(page, state, 'explorer', 'fixed-current-model', 'main', 'main')
    await enable(page)
    await chooseNativeModel(page, '验证 · 固定型号')
    await openMode(page)
    await page.locator('[data-routing-mode="fixed"]').waitFor()
    await page.keyboard.press('Escape')
    await sendProbe(page, state, 'oracle', 'fixed-new-model', 'fixed', 'fixed')
    await enable(page)
    await sendProbe(page, state, 'explorer', 'auto-before-restart', 'main', 'explorer')
    const rootId = calls(state).find(entry => entry.caseId === 'auto-before-restart' && entry.kind === 'parent').sessionId
    const otherContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' })
    otherContext.setDefaultTimeout(15000)
    const other = await otherContext.newPage()
    await other.goto(server.url, { waitUntil: 'load' })
    await other.locator('[data-conversation-session] [data-composer-input][contenteditable="true"]').waitFor()
    await connectWorkspace(other, state)
    const otherConversation = other.locator('[data-conversation-session]:visible').first()
    if (await otherConversation.getAttribute('data-conversation-session') === rootId) {
      await other.getByRole('button', { name: '新建会话', exact: true }).filter({ hasText: '新会话' }).click()
    }
    await until(async () => {
      const id = await otherConversation.getAttribute('data-conversation-session')
      return id !== null && id !== rootId
    }, 'another conversation takes ownership of the composer')
    await other.locator('[data-composer-input][contenteditable="true"]').waitFor()
    const isolated = await openMode(other)
    assert.equal(await isolated.getAttribute('data-routing-mode'), 'fixed')
    const original = await openMode(page)
    assert.equal(await original.getAttribute('data-routing-mode'), 'auto')
    await page.keyboard.press('Escape')
    await otherContext.close()
    note('routing mode is isolated between conversations')
    await page.reload({ waitUntil: 'load' })
    await reopenConversation(page, rootId)
    await until(async () => /自动路由/.test(await modelButton(page).innerText()), 'mode survives document reload')
    note('mode and configuration survive document reload')
    const port = Number(new URL(server.url).port)
    await server.stop()
    server = undefined
    server = await launch(state, port)
    await page.goto(server.url, { waitUntil: 'load' })
    await reopenConversation(page, rootId)
    await until(async () => /自动路由/.test(await modelButton(page).innerText()), 'mode survives real Host restart')
    assert.equal(await page.locator('[data-conversation-session]:visible').first().getAttribute('data-conversation-session'), rootId)
    await sendProbe(page, state, 'explorer', 'auto-after-restart', 'main', 'explorer')
    dialog = await configure(page)
    await dialog.getByRole('button', { name: '主模型：验证 · 主模型', exact: true }).waitFor()
    await dialog.getByRole('button', { name: '研究：验证 · 研究模型', exact: true }).waitFor()
    await dialog.getByRole('button', { name: '设计：跟随主模型', exact: true }).waitFor()
    await dialog.getByRole('button', { name: '完成', exact: true }).click()
    note('saved routing works after a real Host restart')
    assert.deepEqual(pageErrors, [])
    const normalized = checks.filter(entry => entry.check.startsWith('request binding ')).map(({ check, role, main, child }) => ({ case: check.slice('request binding '.length), role, main, child }))
    const expected = JSON.parse(readFileSync(join(here, 'expected/installed-routes.json'), 'utf8'))
    assert.deepEqual(normalized, expected)
    writeFileSync(join(area, 'result.json'), JSON.stringify({ status: 'passed', checks, profile: state.profile, calls: state.calls, pageErrors }, null, 2) + '\n')
    console.log(`Installed routing smoke passed; evidence: ${area}`)
  } catch (error) {
    if (page !== undefined) {
      await page.screenshot({ path: join(area, 'failure.png'), fullPage: true }).catch((_screenshotError) => { /* Preserve the original smoke failure if the page already closed. */ })
      writeFileSync(join(area, 'failure-body.txt'), await page.locator('body').innerText().catch((_bodyReadError) => 'unavailable'))
    }
    writeFileSync(join(area, 'result.json'), JSON.stringify({ status: 'failed', checks, error: error instanceof Error ? error.stack : String(error), pageErrors }, null, 2) + '\n')
    throw error
  } finally {
    await browser?.close()
    await server?.stop()
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})
