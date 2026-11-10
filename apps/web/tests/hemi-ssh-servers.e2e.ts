/** Saved connections and remote folders, without execution setup controls, over the shipped profile and recorded history. */
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createPasswordSshFixture } from '../../../packages/hemi/ssh-servers/tests/support/password-ssh.ts'
import { createOpenSshFixture } from '../../../packages/hemi/ssh-servers/tests/support/openssh.ts'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { chromium, type Locator, type Page } from 'playwright'
import { afterAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import type {} from '@deepseek-ai/dsh-hemi-ssh-servers'
import type {} from '@deepseek-ai/dsh-hemi-ssh-servers/workspaces'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

const MODE = webSnapshotMode()
const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/hemi-ssh-servers/', import.meta.url))
const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))

describe.skipIf(MODE === 'record')('Hemi saved SSH connections', () => {
  it('retains connections in the composer picker and asks for a real remote folder without adding sidebar servers', async () => {
    const scaffold = await launchWebScaffold({
      extraOverlayPath: fileURLToPath(new URL('./hemi-ssh-servers.overlay.yml', import.meta.url)),
      // This scenario drives a fixed Loader composition, not config-file hot reload.
      profile: { hmr: false, packages: [] },
    })
    onTestFinished(() => scaffold.close())
    expect(scaffold.ctx.get('hemiSshWorkspaces')).toBeDefined()
    await seedSession(scaffold, await readFile(SEED, 'utf8'), 'hemi-ssh-server-history')
    const browser = await chromium.launch()
    onTestFinished(() => browser.close())
    const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2 })
    const tripwire = watchConsole(page)
    const screenshots = await mkdtemp(join(tmpdir(), 'hemi-ssh-connections-'))
    console.log(`SSH connection screenshots: ${screenshots}`)
    captureFailure(page, screenshots, () => ({ pageErrors: tripwire.pageErrors }))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const group = page.getByRole('treeitem').first()
    await group.waitFor()
    if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
    await page.getByRole('treeitem').nth(1).click()
    await page.getByText('DONE', { exact: true }).waitFor()
    await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd, 'hemi-dsh')
    const secondPath = join(scaffold.workspaceCwd, 'second')
    await mkdir(secondPath)
    await scaffold.ctx.workspaceRegistry.create(secondPath, '默认工作区')
    const workspaces = scaffold.ctx.workspaceRegistry.list().map(row => row.path)
    const nativeWorkspace = page.getByRole('treeitem', { name: 'hemi-dsh', exact: true })
    await nativeWorkspace.click({ button: 'right' })
    const contextMenu = page.locator('[data-context-menu][role="menu"]')
    await contextMenu.waitFor()
    const nativeMaterial = await menuMaterial(contextMenu)
    await page.keyboard.press('Escape')
    await contextMenu.waitFor({ state: 'hidden' })
    const menu = page.getByRole('menu')
    await page.getByRole('button', { name: '添加工作区', exact: true }).click()
    await menu.getByRole('menuitem', { name: '添加 SSH', exact: true }).waitFor()
    expect(await menu.getByRole('menuitem').allTextContents()).toEqual(['添加工作区…', '添加 SSH'])
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'add-menu.expected.md'),
      await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd), MODE)
    await menu.getByRole('menuitem', { name: '添加 SSH', exact: true }).click()
    const add = page.getByRole('dialog', { name: '添加 SSH 服务器', exact: true })
    await add.getByLabel('显示名称', { exact: true }).fill('生产服务器')
    await add.getByLabel('SSH 地址', { exact: true }).fill('deploy@prod.example.com')
    await add.getByLabel('端口', { exact: true }).fill('2222')
    await add.getByRole('button', { name: '保存', exact: true }).click()
    await add.waitFor({ state: 'hidden' })
    expect(await page.locator('[data-hemi-ssh-servers]').count()).toBe(0)
    expect(scaffold.ctx.workspaceRegistry.list().map(row => row.path)).toEqual(workspaces)
    await page.getByRole('button', { name: '新建会话', exact: true }).filter({ hasText: '新会话' }).click()
    const picker = page.getByRole('button', { name: '选择工作区', exact: true })
    await picker.waitFor()
    const selectedTitle = await picker.textContent()
    await picker.click()
    const connections = menu.getByRole('group', { name: 'SSH 连接', exact: true })
    await connections.getByRole('menuitem', { name: '生产服务器 deploy@prod.example.com:2222', exact: true }).waitFor()
    expect((await menu.getByRole('menuitem').allTextContents()).slice(-2)).toEqual(['添加工作区…', '添加 SSH'])
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'connections.expected.md'),
      await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd), MODE)
    expect(await menu.getByRole('menuitem', { name: '管理 SSH 连接…', exact: true }).count()).toBe(0)
    const connectionRow = connections.getByRole('menuitem', { name: '生产服务器 deploy@prod.example.com:2222', exact: true })
    const rowBounds = await connectionRow.boundingBox()
    if (rowBounds === null) throw new Error('Expected a visible connection row')
    await connectionRow.click({ button: 'right', position: { x: rowBounds.width / 2, y: rowBounds.height / 2 } })
    await page.getByRole('menuitem', { name: '编辑', exact: true }).waitFor()
    expect(await connectionRow.isVisible()).toBe(true)
    expect(await picker.textContent()).toBe(selectedTitle)
    expect(await menuMaterial(contextMenu)).toEqual(nativeMaterial)
    const popup = await contextMenu.boundingBox()
    if (popup === null) throw new Error('Expected the connection context popup')
    const viewport = page.viewportSize()!
    const pointX = Math.min(Math.max(rowBounds.x + rowBounds.width / 2, 12), viewport.width - popup.width - 12)
    const pointY = Math.min(Math.max(rowBounds.y + rowBounds.height / 2 + 4, 12), viewport.height - popup.height - 12)
    expect(Math.abs(popup.x - pointX)).toBeLessThan(4)
    expect(Math.abs(popup.y - pointY)).toBeLessThan(4)
    await page.screenshot({ path: join(screenshots, 'connection-context-1280-light.png'), animations: 'disabled' })
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'connection-actions.expected.md'),
      await captureStableAria(page, '[data-context-menu][role="menu"]', scaffold.workspaceCwd), MODE)
    await page.keyboard.press('Escape')
    await page.locator('[data-context-menu][role="menu"]').waitFor({ state: 'hidden' })
    expect(await connectionRow.isVisible()).toBe(true)
    expect(await connectionRow.evaluate(node => node === document.activeElement)).toBe(true)
    await connectionRow.press('Shift+F10')
    await page.getByRole('menuitem', { name: '编辑', exact: true }).click()
    const edit = page.getByRole('dialog', { name: '编辑 SSH 服务器', exact: true })
    await edit.waitFor()
    expect(await edit.getByLabel('SSH 地址', { exact: true }).inputValue()).toBe('deploy@prod.example.com')
    await edit.getByLabel('显示名称', { exact: true }).fill('部署服务器')
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'editor.expected.md'),
      await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), MODE)
    const directory = scaffold.ctx.get('hemiSshServers')!
    const { id, revision, ...fields } = directory.list(new AbortController().signal)[0]!
    await directory.update(id, revision, { ...fields, name: '后台更新' }, new AbortController().signal)
    await edit.getByRole('button', { name: '保存', exact: true }).click()
    await edit.getByRole('alert').waitFor()
    await edit.getByRole('button', { name: '关闭并刷新', exact: true }).click()
    await edit.waitFor({ state: 'hidden' })
    await picker.click()
    await connections.getByRole('menuitem', { name: '后台更新 deploy@prod.example.com:2222', exact: true }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '编辑', exact: true }).click()
    await edit.getByLabel('显示名称', { exact: true }).fill('部署服务器')
    await edit.getByRole('button', { name: '保存', exact: true }).click()
    await edit.waitFor({ state: 'hidden' })
    await picker.click()
    await connections.getByRole('menuitem', { name: '部署服务器 deploy@prod.example.com:2222', exact: true }).waitFor()
    await connections.getByRole('menuitem', { name: '部署服务器 deploy@prod.example.com:2222', exact: true }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '删除', exact: true }).click()
    const remove = page.getByRole('dialog', { name: '移除 SSH 服务器？', exact: true })
    await remove.getByRole('button', { name: '移除', exact: true }).click()
    await remove.waitFor({ state: 'hidden' })
    await expect.poll(() => directory.list(new AbortController().signal)).toEqual([])
    await picker.click()
    await menu.getByRole('menuitem', { name: '添加 SSH', exact: true }).waitFor()
    await expect.poll(() => connections.count()).toBe(0)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'picker-add-menu.expected.md'),
      await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd), MODE)
    expect(scaffold.ctx.workspaceRegistry.list().map(row => row.path)).toEqual(workspaces)
    expect(await page.locator('[data-hemi-ssh-servers]').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])

  })
})

// The real transport needs POSIX OpenSSH and Unix control sockets; other platforms retain the saved-connection replay above.
describe.skipIf(MODE === 'record' || process.platform === 'win32' || !existsSync('/usr/sbin/sshd'))('Hemi real SSH directory picker', () => {
  it('opens two real remote folders from one retained connection and keeps only directory Workspaces in the sidebar', async () => {
    const ssh = await createOpenSshFixture({ env: { HOME: '${root}', XDG_CACHE_HOME: '${root}/cache' } })
    const owned: {
      scaffold?: Awaited<ReturnType<typeof launchWebScaffold>>
      browser?: Awaited<ReturnType<typeof chromium.launch>>
    } = {}
    onTestFinished(async () => {
      try { await owned.browser?.close(); await owned.scaffold?.close() } finally { await ssh.close(); vi.unstubAllEnvs() }
    })
    await symlink(process.execPath, join(ssh.bin, 'node'))
    vi.stubEnv('PATH', ssh.bin + ':' + (process.env.PATH ?? '/usr/bin:/bin'))
    const one = join(ssh.root, 'remote-project-one'), two = join(ssh.root, 'remote-project-two')
    await mkdir(one); await mkdir(two)
    await writeFile(join(ssh.root, 'not-a-folder.txt'), 'not a directory')
    for (let index = 0; index < 12; index++) await mkdir(join(ssh.root, 'folder-' + String(index).padStart(2, '0')))
    const scaffold = await launchWebScaffold({
      extraOverlayPath: fileURLToPath(new URL('./hemi-ssh-real.overlay.yml', import.meta.url)),
      profile: { hmr: false, packages: [] },
    })
    owned.scaffold = scaffold
    const app = scaffold
    await seedSession(app, await readFile(SEED, 'utf8'), 'hemi-ssh-real-history')
    const browser = await chromium.launch()
    owned.browser = browser
    const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2 })
    const tripwire = watchConsole(page)
    const screenshots = await mkdtemp(join(tmpdir(), 'hemi-ssh-real-picker-'))
    console.log('Real SSH directory screenshots: ' + screenshots)
    captureFailure(page, screenshots, () => ({ sshd: ssh.diagnostics() }))
    await page.goto(app.authenticatedUrl, { waitUntil: 'load' })
    const group = page.getByRole('treeitem').first()
    await group.waitFor()
    if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
    await page.getByRole('treeitem').nth(1).click()
    await page.getByText('DONE', { exact: true }).waitFor()
    const sameNameLocal = join(app.workspaceCwd, 'remote-project-one')
    await mkdir(sameNameLocal)
    await app.ctx.workspaceRegistry.create(sameNameLocal)
    await page.getByRole('button', { name: '添加工作区', exact: true }).click()
    await page.getByRole('menuitem', { name: '添加 SSH', exact: true }).click()
    const add = page.getByRole('dialog', { name: '添加 SSH 服务器', exact: true })
    await add.getByLabel('显示名称', { exact: true }).fill('测试 SSH')
    await add.getByLabel('SSH 地址', { exact: true }).fill(ssh.username + '@' + ssh.host)
    await add.getByLabel('端口', { exact: true }).fill(String(ssh.port))
    await add.getByRole('button', { name: '保存', exact: true }).click()
    await add.waitFor({ state: 'hidden' })
    const signal = new AbortController().signal
    const server = app.ctx.get('hemiSshServers')!.list(signal)[0]!
    expect(app.ctx.get('hemiSshWorkspaces')!.getRuntime(server.id, signal)).toBeUndefined()
    const connectionLabel = '测试 SSH ' + ssh.username + '@' + ssh.host + ':' + String(ssh.port)
    const showConnection = async () => {
      await page.getByRole('button', { name: '新建会话', exact: true }).filter({ hasText: '新会话' }).click()
      await page.getByRole('button', { name: '选择工作区', exact: true }).click()
      const row = page.getByRole('group', { name: 'SSH 连接', exact: true }).getByRole('menuitem', { name: connectionLabel, exact: true })
      await row.waitFor()
      return row
    }
    await (await showConnection()).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '编辑', exact: true }).click()
    const editor = page.getByRole('dialog', { name: '编辑 SSH 服务器', exact: true })
    const folder = page.getByRole('dialog', { name: '选择远端文件夹', exact: true })
    const location = folder.getByRole('textbox', { name: '远端绝对路径', exact: true })
    const useFolder = folder.getByRole('button', { name: '使用此文件夹', exact: true })
    const waitDirectory = async (path: string) => {
      await expect.poll(() => location.inputValue()).toBe(path)
      await expect.poll(() => useFolder.isEnabled()).toBe(true)
    }
    const remoteWorkspaces = () => app.ctx.workspaceRegistry.list().filter(row => row.executionTarget !== undefined)
    await editor.getByLabel('远端目录', { exact: true }).fill(ssh.root)
    await editor.getByRole('button', { name: '选择目录', exact: true }).click()
    await folder.getByRole('button', { name: '浏览 remote-project-one', exact: true }).waitFor()
    await waitDirectory(ssh.root)
    expect(await editor.getByRole('region', { name: '选择远端文件夹', exact: true }).count()).toBe(0)
    expect(app.ctx.get('hemiSshWorkspaces')!.getRuntime(server.id, signal)).toBeUndefined()
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'editor-folders.expected.md'),
      await captureStableAria(page, '[role="dialog"][aria-label="选择远端文件夹"]', ssh.root, {
        replacements: [[ssh.username + '@' + ssh.host + ':' + String(ssh.port), '{{ssh-address}}']],
      }), MODE)
    await folder.getByRole('button', { name: '浏览 remote-project-one', exact: true }).press('Enter')
    await waitDirectory(one)
    await location.fill(two)
    expect(await useFolder.isEnabled()).toBe(false)
    await location.press('Enter')
    await waitDirectory(two)
    expect(await editor.isVisible()).toBe(true)
    expect(app.ctx.get('hemiSshServers')!.list(signal)[0]!.directory).toBeUndefined()
    expect(remoteWorkspaces()).toEqual([])
    await folder.getByRole('button', { name: '主目录', exact: true }).click()
    await waitDirectory(ssh.root)
    await folder.getByRole('button', { name: '首选目录', exact: true }).click()
    await waitDirectory(ssh.root)
    await folder.getByRole('navigation', { name: '常用目录', exact: true }).getByRole('button', { name: 'remote-project-two', exact: true }).click()
    await waitDirectory(two)
    await page.keyboard.press('Escape')
    await folder.waitFor({ state: 'hidden' })
    expect(await editor.isVisible()).toBe(true)
    expect(await editor.getByLabel('远端目录', { exact: true }).inputValue()).toBe(ssh.root)
    expect(await editor.getByRole('button', { name: '选择目录', exact: true }).evaluate(node => node === document.activeElement)).toBe(true)
    expect(app.ctx.get('hemiSshServers')!.list(signal)[0]!.directory).toBeUndefined()
    expect(remoteWorkspaces()).toEqual([])
    await editor.getByRole('button', { name: '选择目录', exact: true }).press('Enter')
    await waitDirectory(ssh.root)
    await folder.getByRole('button', { name: '浏览 remote-project-one', exact: true }).press('Enter')
    await waitDirectory(one)
    await useFolder.press('Enter')
    await folder.waitFor({ state: 'hidden' })
    expect(await editor.getByLabel('远端目录', { exact: true }).inputValue()).toBe(one)
    expect(app.ctx.get('hemiSshServers')!.list(signal)[0]!.directory).toBeUndefined()
    await page.screenshot({ path: join(screenshots, 'editor-selected-directory.png'), animations: 'disabled' })
    await editor.getByRole('button', { name: '保存', exact: true }).click()
    await editor.waitFor({ state: 'hidden' })
    expect(app.ctx.get('hemiSshServers')!.list(signal)[0]!.directory).toBe(one)
    await (await showConnection()).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '编辑', exact: true }).click()
    expect(await editor.getByLabel('远端目录', { exact: true }).inputValue()).toBe(one)
    await editor.getByRole('button', { name: '取消', exact: true }).click()
    const chooseConnection = async () => {
      await (await showConnection()).click()
      await folder.waitFor()
      await waitDirectory(one)
    }
    await chooseConnection()
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'remote-path.expected.md'),
      await captureStableAria(page, '[role="dialog"][aria-label="选择远端文件夹"]', ssh.root, {
        replacements: [[ssh.username + '@' + ssh.host + ':' + String(ssh.port), '{{ssh-address}}']],
      }), MODE)
    await location.fill(two)
    expect(await useFolder.isEnabled()).toBe(false)
    expect(remoteWorkspaces()).toEqual([])
    await location.press('Enter')
    await waitDirectory(two)
    expect(remoteWorkspaces()).toEqual([])
    await folder.getByRole('button', { name: '首选目录', exact: true }).click()
    await waitDirectory(one)
    await location.fill(two + '/..')
    await folder.getByRole('button', { name: '前往', exact: true }).click()
    await waitDirectory(ssh.root)
    await folder.getByRole('button', { name: '浏览 remote-project-one', exact: true }).waitFor()
    expect(await folder.getByText('not-a-folder.txt', { exact: true }).count()).toBe(0)
    const replacements: readonly (readonly [string, string])[] = [
      [ssh.username + '@' + ssh.host + ':' + String(ssh.port), '{{ssh-address}}'],
      [app.workspaceCwd, '{{native-cwd}}'],
    ]
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'remote-folders.expected.md'),
      await captureStableAria(page, '[role="dialog"][aria-label="选择远端文件夹"]', ssh.root, { replacements }), MODE)
    await folder.getByRole('button', { name: '取消', exact: true }).click()
    await folder.waitFor({ state: 'hidden' })
    expect(remoteWorkspaces()).toEqual([])
    expect(app.ctx.get('hemiSshServers')!.list(signal)[0]!.directory).toBe(one)
    await chooseConnection()
    await folder.getByRole('button', { name: '主目录', exact: true }).click()
    await waitDirectory(ssh.root)
    await location.focus()
    await page.keyboard.press('Tab')
    expect(await folder.getByRole('button', { name: '前往', exact: true }).evaluate(node => node === document.activeElement)).toBe(true)
    await page.keyboard.press('Shift+Tab')
    expect(await location.evaluate(node => node === document.activeElement)).toBe(true)
    for (const viewport of [{ width: 1280, height: 820 }, { width: 390, height: 820 }, { width: 390, height: 360 }]) {
      await page.setViewportSize(viewport)
      for (const dark of [false, true]) {
        await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' })
        await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(dark)
        expect(await location.evaluate(node => node === document.activeElement)).toBe(true)
        await expectPickerFits(folder)
        await page.screenshot({ path: join(screenshots, 'folders-' + String(viewport.width) + '-' + String(viewport.height) + '-' + (dark ? 'dark' : 'light') + '.png'), animations: 'disabled' })
      }
    }
    const compactRow = folder.getByRole('button', { name: '浏览 remote-project-one', exact: true })
    await compactRow.scrollIntoViewIfNeeded()
    expect(await compactRow.evaluate((node) => {
      const box = node.getBoundingClientRect()
      const points = [box.top + 1, box.top + box.height / 2, box.bottom - 1]
      return box.top >= 0 && box.bottom <= innerHeight
        && points.every(y => node.contains(document.elementFromPoint(box.left + box.width / 2, y)))
    })).toBe(true)
    await expectPickerFits(folder)
    await page.screenshot({ path: join(screenshots, 'folders-390-360-dark-scrolled.png'), animations: 'disabled' })
    await compactRow.click()
    await waitDirectory(one)
    expect(remoteWorkspaces()).toEqual([])
    await folder.getByRole('button', { name: '主目录', exact: true }).click()
    await waitDirectory(ssh.root)
    await page.setViewportSize({ width: 1280, height: 820 })
    await page.emulateMedia({ colorScheme: 'light' })
    await folder.getByRole('button', { name: '浏览 remote-project-one', exact: true }).press('Enter')
    await waitDirectory(one)
    await useFolder.press('Enter')
    await folder.waitFor({ state: 'hidden' })
    await expect.poll(() => remoteWorkspaces().length).toBe(1)
    await expect.poll(() => page.getByRole('button', { name: '选择工作区', exact: true }).textContent()).toContain('remote-project-one')
    await expect.poll(() => page.getByRole('treeitem', { name: 'remote-project-one（测试 SSH）', exact: true }).getAttribute('aria-expanded')).toBe('true')
    await chooseConnection()
    await folder.getByRole('navigation', { name: '常用目录', exact: true }).getByRole('button', { name: 'remote-project-two', exact: true }).press('Enter')
    await waitDirectory(two)
    await useFolder.click()
    await folder.waitFor({ state: 'hidden' })
    const remote = app.ctx.workspaceRegistry.list().filter(row => row.executionTarget !== undefined)
    expect(remote.map(row => row.path).sort()).toEqual([one, two].sort())
    expect(remote[0]!.id).not.toBe(remote[1]!.id)
    expect(await page.locator('[data-hemi-ssh-servers]').count()).toBe(0)
    await page.getByRole('treeitem').filter({ hasText: 'remote-project-one' }).first().waitFor()
    await page.getByRole('treeitem').filter({ hasText: 'remote-project-two' }).first().waitFor()
    await expect.poll(() => page.getByRole('button', { name: '选择工作区', exact: true }).textContent()).toContain('remote-project-two')
    await expect.poll(() => page.getByRole('treeitem', { name: 'remote-project-two（测试 SSH）', exact: true }).getAttribute('aria-expanded')).toBe('true')
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'remote-workspaces.expected.md'),
      await captureStableAria(page, '[role="tree"]', app.workspaceCwd, { normalizeAge: true,
        replacements: [[ssh.root, '{{ssh-root}}']] }), MODE)
    expect(await page.getByRole('treeitem', { name: 'remote-project-two（测试 SSH）', exact: true })
      .locator('[data-icon="dsw-icon-globe-outline-regular"]').count()).toBe(1)
    expect(await page.getByRole('treeitem', { name: 'remote-project-one', exact: true })
      .locator('[data-icon*="folder-"]').count()).toBe(1)
    await page.screenshot({ path: join(screenshots, 'opened-workspaces.png'), animations: 'disabled' })
    const remoteRow = page.getByRole('treeitem', { name: 'remote-project-one（测试 SSH）', exact: true })
    await remoteRow.click({ button: 'right' })
    const workspaceActions = page.locator('[data-context-menu][role="menu"]')
    await workspaceActions.waitFor()
    expect(await workspaceActions.getByRole('menuitem', { name: /Finder|在文件夹显示|在应用中打开/ }).count()).toBe(0)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'remote-workspace-actions.expected.md'),
      await captureStableAria(page, '[data-context-menu][role="menu"]', app.workspaceCwd), MODE)
    await page.screenshot({ path: join(screenshots, 'remote-workspace-actions.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')
    const picker = page.getByRole('button', { name: '选择工作区', exact: true })
    expect(await picker.textContent()).toContain('remote-project-two（测试 SSH）')
    expect(await picker.locator('[data-icon="dsw-icon-globe-outline-regular"]').count()).toBe(1)
    await picker.click()
    const workspaceChoices = page.getByRole('menu')
    await workspaceChoices.getByRole('menuitem', { name: 'remote-project-one（测试 SSH）', exact: true }).waitFor()
    expect(await workspaceChoices.getByRole('menuitem', { name: 'remote-project-one', exact: true }).count()).toBe(1)
    expect(await workspaceChoices.getByRole('menuitem', { name: 'remote-project-one（测试 SSH）', exact: true })
      .locator('[data-icon="dsw-icon-globe-outline-regular"]').count()).toBe(1)
    expect(await workspaceChoices.getByRole('menuitem', { name: 'remote-project-one', exact: true })
      .locator('[data-icon="dsw-icon-folder-close-regular"]').count()).toBe(1)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'remote-workspace-choices.expected.md'),
      await captureStableAria(page, '[role="menu"]', app.workspaceCwd, { replacements }), MODE)
    await page.setViewportSize({ width: 390, height: 820 })
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(true)
    await page.screenshot({ path: join(screenshots, 'remote-workspace-choices-390-dark.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')
    const { id: connectionId, revision: connectionRevision, ...savedFields } = app.ctx.get('hemiSshServers')!.list(signal)[0]!
    const longName = '测试 SSH · ' + '远程开发服务器'.repeat(8)
    const renamedConnection = await app.ctx.get('hemiSshServers')!.update(connectionId, connectionRevision,
      { ...savedFields, name: longName }, signal)
    const touchPage = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 390, height: 820 },
      deviceScaleFactor: 2, hasTouch: true, colorScheme: 'dark' })
    const touchTripwire = watchConsole(touchPage)
    await touchPage.goto(app.authenticatedUrl, { waitUntil: 'load' })
    await touchPage.getByRole('button', { name: '选择工作区', exact: true }).click()
    for (const name of ['选择工作区', '标准模式']) {
      expect(await touchPage.getByRole('button', { name, exact: true }).evaluate((node) => {
        const box = node.getBoundingClientRect()
        return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight
      })).toBe(true)
    }
    const longTitle = 'remote-project-one（' + longName + '）'
    const touchChoice = touchPage.getByRole('menuitem', { name: longTitle, exact: true })
    await touchChoice.waitFor()
    expect(await touchPage.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true)
    expect(await touchChoice.evaluate((node, title) => {
      const text = [...node.querySelectorAll<HTMLElement>('span[title]')].find(part => part.title === title)
      return text !== undefined && text.scrollHeight <= text.clientHeight && text.scrollWidth <= text.clientWidth
        && getComputedStyle(text).whiteSpace === 'normal'
    }, longTitle)).toBe(true)
    expect(await touchPage.getByRole('menu').evaluate((node) => {
      const box = node.getBoundingClientRect()
      return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight
    })).toBe(true)
    await touchPage.screenshot({ path: join(screenshots, 'remote-workspace-long-title-390-touch.png'), animations: 'disabled' })
    expect(touchTripwire.pageErrors).toEqual([])
    expect(touchTripwire.warnings).toEqual([])
    await touchPage.close()
    await app.ctx.get('hemiSshServers')!.update(renamedConnection.id, renamedConnection.revision, savedFields, signal)
    expect(app.ctx.get('hemiSshServers')!.list(signal).map(row => row.id)).toEqual([server.id])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})

function captureFailure(page: Page, directory: string, transport: () => object, redact: readonly string[] = []): void {
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 2000))
  })
  onTestFinished(async ({ task }) => {
    if (task.result?.state !== 'fail' || page.isClosed()) return
    let aria = await page.locator('body').ariaSnapshot()
    for (const value of redact) aria = aria.replaceAll(value, '[fixture response]')
    await Promise.all([
      page.screenshot({ path: join(directory, 'failure.png'), animations: 'disabled' }),
      writeFile(join(directory, 'failure.aria.yml'), `${aria}\n`),
      writeFile(join(directory, 'failure.transport.json'), `${JSON.stringify({ ...transport(), consoleErrors }, null, 2)}\n`),
    ])
    console.log(`SSH failure evidence: ${directory}`)
  })
}

async function menuMaterial(menu: Locator) {
  return menu.evaluate((node) => {
    const style = getComputedStyle(node)
    return { background: style.backgroundColor, blur: style.backdropFilter, radius: style.borderRadius,
      shadow: style.boxShadow, padding: style.padding, minWidth: style.minWidth }
  })
}

async function expectPickerFits(folder: Locator): Promise<void> {
  expect(await folder.evaluate((node) => {
    const box = node.getBoundingClientRect()
    return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight
      && node.scrollWidth <= node.clientWidth
  })).toBe(true)
  for (const name of ['取消', '使用此文件夹']) {
    expect(await folder.getByRole('button', { name, exact: true }).evaluate((node) => {
      const box = node.getBoundingClientRect()
      return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight
    })).toBe(true)
  }
}

// Native OpenSSH prompts and the password-only peer remain loopback-owned; no operator credentials are used.
describe.skipIf(MODE === 'record' || process.platform === 'win32' || !existsSync('/usr/bin/ssh'))('Hemi SSH password sign-in', () => {
  it('remembers an opted-in password across disconnections and clears it when removing the saved connection', async () => {
    const ssh = await createPasswordSshFixture()
    const owned: { app?: Awaited<ReturnType<typeof launchWebScaffold>>; browser?: Awaited<ReturnType<typeof chromium.launch>> } = {}
    onTestFinished(async () => {
      try { await owned.browser?.close(); await owned.app?.close() } finally { await ssh.close(); vi.unstubAllEnvs() }
    })
    vi.stubEnv('PATH', ssh.bin + ':' + (process.env.PATH ?? '/usr/bin:/bin'))
    await mkdir(join(ssh.home, 'password-project'))
    const app = await launchWebScaffold({
      extraOverlayPath: fileURLToPath(new URL('./hemi-ssh-real.overlay.yml', import.meta.url)), profile: { hmr: false, packages: [] },
    })
    owned.app = app
    await seedSession(app, await readFile(SEED, 'utf8'), 'hemi-password-history')
    const browser = await chromium.launch()
    owned.browser = browser
    const page = await browser.newPage({
      locale: ZH_BROWSER_LOCALE, viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, hasTouch: true,
    })
    const tripwire = watchConsole(page)
    const screenshots = await mkdtemp(join(tmpdir(), 'hemi-password-picker-'))
    console.log('SSH password screenshots: ' + screenshots)
    captureFailure(page, screenshots, () => ssh.stats(), [ssh.password])
    await page.goto(app.authenticatedUrl, { waitUntil: 'load' })
    const group = page.getByRole('treeitem').first()
    await group.waitFor()
    if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
    await page.getByRole('treeitem').nth(1).click()
    await page.getByText('DONE', { exact: true }).waitFor()
    await page.getByRole('button', { name: '添加工作区', exact: true }).click()
    await page.getByRole('menuitem', { name: '添加 SSH', exact: true }).click()
    const editor = page.getByRole('dialog', { name: '添加 SSH 服务器', exact: true })
    await editor.getByLabel('显示名称', { exact: true }).fill('密码服务器')
    await editor.getByLabel('SSH 地址', { exact: true }).fill(ssh.username + '@' + ssh.host)
    await editor.getByLabel('端口', { exact: true }).fill(String(ssh.port))
    await editor.getByRole('button', { name: '保存', exact: true }).click()
    await editor.waitFor({ state: 'hidden' })
    const choose = async () => {
      await page.getByRole('button', { name: '新建会话', exact: true }).filter({ hasText: '新会话' }).click()
      await page.getByRole('button', { name: '选择工作区', exact: true }).click()
      await page.getByRole('group', { name: 'SSH 连接', exact: true }).getByRole('menuitem', {
        name: '密码服务器 ' + ssh.username + '@' + ssh.host + ':' + String(ssh.port), exact: true,
      }).click()
    }
    await choose()
    const login = page.getByRole('dialog', { name: 'SSH 登录', exact: true })
    await login.getByText(/SHA256:/).waitFor()
    expect(await login.getByRole('checkbox', { name: '记住密码', exact: true }).count()).toBe(0)
    expect(ssh.stats().passwordAttempts).toBe(0)
    expect(await readFile(ssh.knownHosts, 'utf8')).toBe('')
    for (const height of [820, 360]) {
      await page.setViewportSize({ width: 390, height })
      for (const dark of [false, true]) {
        await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' })
        await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(dark)
        expect(await login.evaluate((node) => {
          const box = node.getBoundingClientRect()
          return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight
            && node.scrollWidth <= node.clientWidth
        })).toBe(true)
        expect(await login.getByRole('button', { name: '继续', exact: true }).evaluate((node) => {
          const box = node.getBoundingClientRect()
          return box.height >= 44 && box.top >= 0 && box.bottom <= innerHeight
        })).toBe(true)
        await page.screenshot({ path: join(screenshots, 'host-key-390-' + String(height) + '-' + (dark ? 'dark' : 'light') + '.png'), animations: 'disabled' })
      }
    }
    await login.getByLabel('SSH 验证内容', { exact: true }).scrollIntoViewIfNeeded()
    expect(await login.getByLabel('SSH 验证内容', { exact: true }).evaluate(node => getComputedStyle(node).fontSize)).toBe('16px')
    await page.setViewportSize({ width: 1280, height: 820 })
    await page.emulateMedia({ colorScheme: 'light' })
    await login.getByLabel('SSH 验证内容', { exact: true }).fill('yes')
    await login.getByRole('button', { name: '继续', exact: true }).click()
    await login.getByText(/password:/).waitFor()
    const remember = login.getByRole('checkbox', { name: '记住密码', exact: true })
    await remember.waitFor()
    expect(await remember.isChecked()).toBe(false)
    expect(await readFile(ssh.knownHosts, 'utf8')).toContain(ssh.hostPublicKey)
    const replacements: readonly (readonly [string, string])[] = [
      [ssh.username + '@' + ssh.host + ':' + String(ssh.port), '{{ssh-address}}'],
      [ssh.username + '@' + ssh.host, '{{ssh-login}}'],
    ]
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'password-login.expected.md'),
      await captureStableAria(page, '[role="dialog"][aria-label="SSH 登录"]', ssh.home, { replacements }), MODE)
    await page.screenshot({ path: join(screenshots, 'native-password-login.png'), animations: 'disabled' })
    for (const dark of [false, true]) {
      await page.setViewportSize({ width: 390, height: 360 })
      await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' })
      await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(dark)
      expect(await login.evaluate((node) => {
        const box = node.getBoundingClientRect()
        return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight
          && node.scrollWidth <= node.clientWidth
      })).toBe(true)
      await remember.scrollIntoViewIfNeeded()
      expect(await remember.isVisible()).toBe(true)
      await page.screenshot({ path: join(screenshots, 'remember-password-390-' + (dark ? 'dark' : 'light') + '.png'), animations: 'disabled' })
    }
    await page.setViewportSize({ width: 1280, height: 820 })
    await page.emulateMedia({ colorScheme: 'light' })
    await remember.check()
    await login.getByLabel('SSH 验证内容', { exact: true }).fill(ssh.password)
    await login.getByRole('button', { name: '继续', exact: true }).click()
    await login.waitFor({ state: 'hidden' })
    const folder = page.getByRole('dialog', { name: '选择远端文件夹', exact: true })
    const location = folder.getByRole('textbox', { name: '远端绝对路径', exact: true })
    await folder.getByRole('button', { name: '浏览 password-project', exact: true }).waitFor()
    await expect.poll(() => location.inputValue()).toBe(ssh.home)
    expect(await location.evaluate(node => node === document.activeElement)).toBe(false)
    expect(await folder.getByRole('textbox').count()).toBe(1)
    for (const name of ['SSH 验证内容', 'SSH 地址', '私钥文件路径']) {
      expect(await folder.getByLabel(name, { exact: true }).count()).toBe(0)
    }
    expect(await folder.getByRole('button', { name: '浏览', exact: true }).count()).toBe(0)
    expect(await folder.getByRole('button', { name: '重试', exact: true }).count()).toBe(0)
    expect(await folder.getByText('填写已存在的远端目录，或留空浏览远端主目录；不会创建本地文件夹', { exact: true }).count()).toBe(0)
    expect(ssh.stats()).toMatchObject({ connections: 1, passwordAttempts: 1, acceptedPasswords: 1 })
    expect(JSON.stringify(app.ctx.get('hemiSshServers')!.list(new AbortController().signal))).not.toContain(ssh.password)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'password-folders.expected.md'),
      await captureStableAria(page, '[role="dialog"][aria-label="选择远端文件夹"]', ssh.home, { replacements }), MODE)
    await page.screenshot({ path: join(screenshots, 'simple-password-folders.png'), animations: 'disabled' })
    for (const height of [820, 360]) {
      await page.setViewportSize({ width: 390, height })
      for (const dark of [false, true]) {
        await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' })
        await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(dark)
        await expectPickerFits(folder)
        for (const name of ['取消', '使用此文件夹']) {
          expect(await folder.getByRole('button', { name, exact: true }).evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44)
        }
        await page.screenshot({ path: join(screenshots, 'password-folders-390-' + String(height) + '-' + (dark ? 'dark' : 'light') + '.png'), animations: 'disabled' })
      }
    }
    await location.scrollIntoViewIfNeeded()
    expect(await location.evaluate(node => getComputedStyle(node).fontSize)).toBe('16px')
    await page.setViewportSize({ width: 1280, height: 820 })
    await page.emulateMedia({ colorScheme: 'light' })
    await folder.getByRole('button', { name: '浏览 password-project', exact: true }).press('Enter')
    await expect.poll(() => location.inputValue()).toBe(join(ssh.home, 'password-project'))
    await expect.poll(() => folder.getByRole('button', { name: '使用此文件夹', exact: true }).isEnabled()).toBe(true)
    await folder.getByRole('button', { name: '主目录', exact: true }).click()
    await expect.poll(() => location.inputValue()).toBe(ssh.home)
    await folder.getByRole('button', { name: '浏览 password-project', exact: true }).waitFor()
    await folder.getByRole('button', { name: '取消', exact: true }).click()
    await folder.waitFor({ state: 'hidden' })
    expect(app.ctx.workspaceRegistry.list().filter(row => row.executionTarget !== undefined)).toEqual([])
    await choose()
    await folder.getByRole('button', { name: '浏览 password-project', exact: true }).waitFor()
    await folder.getByRole('navigation', { name: '常用目录', exact: true }).getByRole('button', { name: 'password-project', exact: true }).press('Enter')
    await expect.poll(() => location.inputValue()).toBe(join(ssh.home, 'password-project'))
    await page.keyboard.press('Escape')
    await folder.waitFor({ state: 'hidden' })
    expect(app.ctx.workspaceRegistry.list().filter(row => row.executionTarget !== undefined)).toEqual([])
    expect(app.ctx.get('hemiSshServers')!.list(new AbortController().signal)[0]!.directory).toBeUndefined()
    expect(await login.count()).toBe(0)
    expect(ssh.stats()).toMatchObject({ connections: 1, passwordAttempts: 1, acceptedPasswords: 1 })
    const credentialsPath = join(app.harnessHome, '.credentials.yaml')
    expect(await readFile(credentialsPath, 'utf8')).toContain(ssh.password)
    expect((await stat(credentialsPath)).mode & 0o777).toBe(0o600)
    await ssh.disconnect()
    expect(ssh.stats()).toMatchObject({ activeConnections: 0, activeProcesses: 0 })
    await choose()
    await folder.getByRole('button', { name: '浏览 password-project', exact: true }).waitFor()
    expect(await login.count()).toBe(0)
    expect(ssh.stats()).toMatchObject({ connections: 2, passwordAttempts: 2, acceptedPasswords: 2 })
    expect(JSON.stringify(app.ctx.get('hemiSshServers')!.list(new AbortController().signal))).not.toContain(ssh.password)
    await page.keyboard.press('Escape')
    await folder.waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: '选择工作区', exact: true }).click()
    await page.getByRole('group', { name: 'SSH 连接', exact: true }).getByRole('menuitem', {
      name: '密码服务器 ' + ssh.username + '@' + ssh.host + ':' + String(ssh.port), exact: true,
    }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '删除', exact: true }).click()
    const remove = page.getByRole('dialog', { name: '移除 SSH 服务器？', exact: true })
    await remove.getByRole('button', { name: '移除', exact: true }).click()
    await remove.waitFor({ state: 'hidden' })
    expect(app.ctx.get('hemiSshServers')!.list(new AbortController().signal)).toEqual([])
    expect(await readFile(credentialsPath, 'utf8')).not.toContain(ssh.password)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})

afterAll(async () => {
  if (MODE === 'record') return
  await assertFixtureInventory(SNAPSHOT_DIR, [
    'add-menu.expected.md', 'connections.expected.md', 'editor-folders.expected.md', 'remote-path.expected.md',
    'picker-add-menu.expected.md', 'editor.expected.md', 'remote-folders.expected.md', 'remote-workspaces.expected.md',
    'connection-actions.expected.md', 'password-login.expected.md', 'password-folders.expected.md',
    'remote-workspace-actions.expected.md', 'remote-workspace-choices.expected.md',
  ])
})
