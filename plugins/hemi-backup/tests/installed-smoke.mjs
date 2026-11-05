/** Keyless real-profile installation and full backup→restore round trip through the installed settings section. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')
const area = resolve(process.argv[2] ?? join(root, '.artifacts/hemi-backup/installed-smoke'))
const requireWeb = createRequire(join(root, 'apps/web/package.json'))
const { chromium } = requireWeb('playwright')
mkdirSync(area, { recursive: true })
const commandLog = join(area, 'commands.log')
const checks = []
const note = check => { checks.push(check); console.log(`PASS ${check}`) }
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

async function launch(state, label, port = 0) {
  const log = join(area, `server-${label}.log`)
  const child = spawn(process.execPath, [
    '--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'web',
    '--patch', 'apps/web/tests/pin-browse-picker.overlay.yml',
    '--no-open', '--port', String(port),
  ], { cwd: root, env: { ...process.env, DSH_HOME: state.home, DSH_AGENTS_HOME: state.agentsHome }, stdio: ['ignore', 'pipe', 'pipe'] })
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

const composer0 = async page => {
  const composer = page.locator('[data-conversation-session] [data-composer-input][contenteditable="true"]')
  return await composer.isVisible().catch(() => false)
}

async function connectWorkspace(page, state) {
  const soon = locator => locator.waitFor({ state: 'visible', timeout: 800 }).then(() => true).catch(() => false)
  for (let round = 0; round < 30; round++) {
    const preview = page.getByRole('dialog', { name: '预览版说明', exact: true })
    if (await soon(preview)) {
      await preview.getByRole('button', { name: '继续', exact: true }).click()
      await preview.waitFor({ state: 'detached', timeout: 10000 }).catch(() => {})
      continue
    }
    if (await composer0(page)) break
    await sleep(300)
  }
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
  await composer.waitFor()
}

async function openBackupSection(page) {
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await until(async () => {
    const preview = page.getByRole('dialog', { name: '预览版说明', exact: true })
    if (await preview.isVisible()) {
      await preview.getByRole('button', { name: '继续', exact: true }).click()
      await preview.waitFor({ state: 'detached' })
      return false
    }
    const onboarding = page.getByRole('dialog', { name: '开始使用', exact: true })
    if (await onboarding.isVisible()) {
      await onboarding.getByRole('button', { name: '关闭', exact: true }).click()
      await onboarding.waitFor({ state: 'detached' })
      return false
    }
    try {
      if (!await settings.isVisible()) {
        const trigger = page.getByRole('button', { name: '设置', exact: true })
        if (!await trigger.isVisible()) return false
        await trigger.click({ timeout: 250 })
        return false
      }
      await settings.getByRole('button', { name: '备份', exact: true }).click({ timeout: 250 })
    } catch (error) {
      // A startup dialog can appear between its visibility check and either click.
      if (error.name !== 'TimeoutError') throw error
      return false
    }
    return true
  }, 'unobstructed backup settings')
  await settings.locator('h3', { hasText: '数据备份' }).first().waitFor()
  return settings
}

async function main() {
  writeFileSync(commandLog, '', { mode: 0o600 })
  const state = JSON.parse(await run([join(here, 'prepare-profile.mjs'), join(area, 'profile')]))
  const memoryRoot = join(state.home, 'hemi-memory')
  mkdirSync(join(memoryRoot, 'daily'), { recursive: true })
  writeFileSync(join(memoryRoot, 'MEMORY.md'), 'installed long-term memory\n')
  writeFileSync(join(memoryRoot, 'daily/2026-11-05.md'), 'installed daily memory\n')
  writeFileSync(join(memoryRoot, 'SCRATCHPAD.md'), 'installed working notes\n')
  const packed = join(area, 'packages')
  await run([join(root, 'plugins/hemi-backup/pack.mjs'), packed])
  const archives = JSON.parse(readFileSync(join(packed, 'packages.json'), 'utf8')).packages.map(entry => join(packed, entry.file))
  await run(['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'plugin', '--profile', 'web', 'add', state.cleanBundle, ...archives, '--ignore-scripts'], { ...process.env, DSH_HOME: state.home, DSH_AGENTS_HOME: state.agentsHome })
  const profile = JSON.parse(readFileSync(join(state.profile, 'package.json'), 'utf8'))
  assert.ok(profile.dsh.profile.bundles.includes('@hemi/backup'))
  note('independent bundle installation without built-in Hemi rows')

  let server
  let browser
  const pageErrors = []
  try {
    server = await launch(state, 'first')
    browser = await chromium.launch({ headless: true, channel: process.env.HEMI_BACKUP_BROWSER_CHANNEL })
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' })
    context.setDefaultTimeout(20000)
    const page = await context.newPage()
    page.on('pageerror', error => { pageErrors.push(error.message) })
    const consoleErrors = []
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
    await page.goto(server.url, { waitUntil: 'load' })
    const html = await page.content()
    assert.ok(html.includes('@deepseek-ai/dsh-hemi-backup-ui'), 'installed Client must be in the boot roster')
    note('real Host ready with installed Client boot roster')

    await connectWorkspace(page, state)
    note('workspace connected on the clean official composition')
    const settings = await openBackupSection(page)
    const section = settings.locator('section', { hasText: '数据备份' }).first()
    await section.waitFor()
    note('independent Backup tab shows the backup section')
    await page.screenshot({ path: join(area, 'backup-tab.png') })

    await page.locator('#hemi-backup-dir').fill(state.backupsDir)
    await section.getByRole('button', { name: '测试连接', exact: true }).click()
    await section.getByText('连接成功', { exact: true }).waitFor()
    note('local target connection test passes')
    await section.getByRole('button', { name: '保存目标', exact: true }).click()
    await section.getByText('已保存', { exact: true }).waitFor()
    note('target saved through the settings section')

    await section.getByRole('button', { name: '立即备份', exact: true }).click()
    await until(async () => readdirSync(state.backupsDir).some(name => name.startsWith('hemi-backup-')), 'backup set directory on disk')
    await section.getByRole('button', { name: '刷新', exact: true }).click()
    await section.getByRole('button', { name: '恢复', exact: true }).first().waitFor()
    note('manual backup produces a listed backup set')
    rmSync(memoryRoot, { recursive: true })

    await section.getByRole('button', { name: '恢复', exact: true }).first().click()
    await section.getByText(/新增 3 · 相同自动跳过 \d+ · 冲突 [01]/).waitFor()
    await section.getByText('合并恢复：已有会话保持原样，冲突的会话备份另存安全副本；其他冲突保留较新版本，落选数据另存；重启应用后完全生效。', { exact: true }).waitFor()
    note('restore preview includes all three missing Hemi memory stores and the session-preserving policy')
    await section.getByRole('button', { name: '确认恢复', exact: true }).click()
    await section.getByText('已恢复，重启应用后完全生效。', { exact: true }).waitFor()
    note('merge restore applies through the dialog')
    assert.equal(readFileSync(join(memoryRoot, 'MEMORY.md'), 'utf8'), 'installed long-term memory\n')
    assert.equal(readFileSync(join(memoryRoot, 'daily/2026-11-05.md'), 'utf8'), 'installed daily memory\n')
    assert.equal(readFileSync(join(memoryRoot, 'SCRATCHPAD.md'), 'utf8'), 'installed working notes\n')
    note('installed Host restores every Hemi memory store from the archive')

    await page.keyboard.press('Escape')
    await settings.waitFor({ state: 'detached' })
    await server.stop()

    server = await launch(state, 'restored')
    const page2 = await context.newPage()
    page2.on('pageerror', error => { pageErrors.push(error.message) })
    await page2.goto(server.url, { waitUntil: 'load' })
    const settings2 = await openBackupSection(page2)
    const section2 = settings2.locator('section', { hasText: '数据备份' }).first()
    await section2.waitFor()
    await until(async () => await page2.locator('#hemi-backup-dir').inputValue() === state.backupsDir, 'saved backup target after restart')
    assert.equal(await page2.locator('#hemi-backup-dir').inputValue(), state.backupsDir)
    note('restart keeps the saved target and the section mounted')
  } catch (error) {
    for (const [index, page] of (browser?.contexts().flatMap(context => context.pages()) ?? []).entries()) {
      writeFileSync(join(area, `failure-page-${index}.html`), await page.content())
    }
    throw error
  } finally {
    try {
      await browser?.close()
    } finally {
      await server?.stop()
    }
    assert.deepEqual(pageErrors, [])
  }
  console.log(`\n${checks.length} checks passed`)
}

await main()
