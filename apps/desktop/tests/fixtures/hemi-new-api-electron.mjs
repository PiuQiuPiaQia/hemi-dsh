/** Run the built Electron preload and native import bridge against an isolated site. */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain, protocol } from 'electron'
import { desktopNewApiImport } from '@deepseek-ai/dsh-hemi-customizations'
import { assertDesktopSender, DESKTOP_IPC, SCHEME } from '../../lib/types/ipc.js'

const { HEMI_TEST_DESKTOP_DATA, HEMI_TEST_NEW_API_SITE, HEMI_TEST_HOST_URL, HEMI_TEST_HOST_COOKIE } = process.env
app.setPath('userData', HEMI_TEST_DESKTOP_DATA)
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true } }])
await app.whenReady()

protocol.handle(SCHEME, () => new Response('<!doctype html><title>Model access test</title>', {
  headers: { 'content-type': 'text/html' },
}))
const parent = new BrowserWindow({
  show: false,
  webPreferences: { preload: fileURLToPath(new URL('../../lib/preload-app.cjs', import.meta.url)), sandbox: true },
})
const createService = () => desktopNewApiImport(
  () => parent,
  () => ({ url: HEMI_TEST_HOST_URL, cookie: HEMI_TEST_HOST_COOKIE }),
  join(HEMI_TEST_DESKTOP_DATA, 'imports'),
)
let service = createService()
ipcMain.handle(DESKTOP_IPC.newApiImport, (event, action, input) => {
  assertDesktopSender(event, ['app'])
  assert.equal(event.sender, parent.webContents)
  assert.equal(event.senderFrame, parent.webContents.mainFrame)
  return service.invoke(event, action, input)
})
await parent.loadURL(`${SCHEME}://app/`)

async function invoke(action, input) {
  return parent.webContents.executeJavaScript(`window.dshDesktop.newApiImport.invoke(...${JSON.stringify([action, input ?? {}])})`)
}

function version(state) {
  return { operationId: state.operationId, revision: state.revision }
}

async function waitForPhase(phases) {
  const deadline = Date.now() + 20_000
  let state
  while (Date.now() < deadline) {
    state = (await invoke('getState')).state
    if (phases.includes(state?.phase)) return state
    await delay(100)
  }
  assert.fail(`Timed out in ${state?.phase ?? 'no state'}`)
}

async function login(opened) {
  assert.equal(opened.phase, 'login')
  const browser = BrowserWindow.getAllWindows().find(window => window.id !== parent.id)
  assert.ok(browser)
  assert.equal(await browser.webContents.executeJavaScript('typeof window.dshDesktop'), 'undefined')
  await browser.webContents.executeJavaScript('document.querySelector("button").click()')
  for (let tries = 0; tries < 50; tries += 1) {
    if (await browser.webContents.executeJavaScript('document.body.dataset.signedIn === "yes"')) break
    await delay(100)
  }
  return invoke('checkLogin', version(opened))
}

async function start() {
  const opened = await invoke('start', { siteUrl: HEMI_TEST_NEW_API_SITE })
  const verified = await login(opened.state)
  assert.equal(verified.state.phase, 'selecting')
  assert.equal(verified.state.accountLabel, 'fixture-user（#42）')
  const prepared = await invoke('setSelection', {
    ...version(verified.state),
    selection: { group: 'team', budgetMode: 'usd', budgetUsd: 5, expiryMode: 'days', expiryDays: 7,
      models: [{ modelName: 'fixture-model', api: 'openai-completions' }] },
  })
  assert.ok(prepared.state.preview.planHash)
  const submitted = await invoke('submit', { ...version(prepared.state), planHash: prepared.state.preview.planHash })
  assert.equal(submitted.ok, true)
  return waitForPhase(['success', 'failed'])
}

try {
  const result = await start()
  assert.equal(result.phase, 'success', JSON.stringify(result.error))
  assert.equal(result.result.providerIds.length, 1)
  assert.doesNotMatch(JSON.stringify(result), /fixture-browser-grant|fixture-model-key/)

  const failed = await start()
  assert.equal(failed.phase, 'failed')
  assert.equal(failed.error.code, 'VERIFY_FAILED')
  await invoke('cancel', version(failed))
  const cleanup = await waitForPhase(['cleanup-pending'])
  const pending = await invoke('listPending')
  assert.ok(pending.pending.some(item => item.operationId === cleanup.operationId))

  await service.dispose()
  service = createService()
  const recovered = await invoke('resumePending', { operationId: cleanup.operationId })
  assert.equal(recovered.state.phase, 'login')
  assert.equal(recovered.state.error.retryTarget, 'cancelling')
  const opened = await invoke('showBrowser')
  await login(opened.state)
  await waitForPhase(['cancelled'])
  assert.equal((await invoke('listPending')).pending.length, 0)
  console.log(`HEMI_NEW_API_RESULT=${JSON.stringify(result.result)}`)
  await service.dispose()
  parent.destroy()
  app.exit(0)
} catch (error) {
  console.error(error.message)
  await service.dispose()
  parent.destroy()
  app.exit(1)
}
