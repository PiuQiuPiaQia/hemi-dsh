// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  BrowserImportAction, BrowserImportInput, BrowserImportResponse, BrowserImportState, NewApiDesktopBridge,
} from '@deepseek-ai/dsh-hemi-model-access/desktop-import'
import { ModelAccessPage } from '../src/client/ModelAccessPage.tsx'
import { en, zh } from '../src/client/copy.ts'
import type { ModelAccessActions } from '../src/client/types.ts'

const site = 'https://newapi.example.test'
const importedProfile = { id: 'connection/imported', name: 'Imported API', baseUrl: `${site}/v1`,
  api: 'openai-completions', models: ['deepseek-chat'], hasKey: true, modelOptions: {} }

function actions(): ModelAccessActions {
  return {
    keyDirectory: vi.fn(async () => ({ revision: 1, profiles: [] })),
    getModelOptions: vi.fn(async () => ({ revision: 1, options: {}, effective: { name: 'deepseek-chat', input: ['text'] as const } })),
    getModelDefaults: vi.fn(async (_api: string, id: string) => ({ name: id, input: ['text'] as const })),
    saveModelOptions: vi.fn(async () => {}), discoverKeyModels: vi.fn(async () => []),
    saveKeyProfile: vi.fn(async () => {}), removeKeyProfile: vi.fn(async () => {}),
    subscriptionCandidates: vi.fn(async () => []), changeSubscriptionModel: vi.fn(async () => {}),
    subscriptionModels: vi.fn(async () => []),
    subscriptions: vi.fn(async () => []), state: vi.fn(async () => null),
    start: vi.fn(async (id: string) => ({ id, provider: id, phase: 'pending' as const })),
    answer: vi.fn(async () => {}), cancel: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
    quota: vi.fn(async () => []), listNewApi: vi.fn(async () => []), importNewApi: vi.fn(async () => 0),
  }
}

function loginState(revision = 1): BrowserImportState {
  return { operationId: 'op-1', revision, phase: 'login', control: 'site', siteOrigin: site,
    accountLabel: 'user@example.test', tokenName: null, groups: [], candidates: [], candidatesGroup: null,
    can: { checkLogin: true, cancel: true } }
}

function selectingState(revision = 2): BrowserImportState {
  return { operationId: 'op-1', revision, phase: 'selecting', control: 'idle', siteOrigin: site,
    accountLabel: 'user@example.test', tokenName: null, groups: [{ name: 'default', desc: 'Default group' }],
    candidates: [{ modelName: 'deepseek-chat', apis: ['anthropic-messages', 'openai-completions'], unsupported: [] },
      { modelName: 'image-only', apis: [], unsupported: ['image-generation'] }],
    candidatesGroup: 'default', can: { setSelection: true, pause: true, cancel: true } }
}

const stuckState: BrowserImportState = { operationId: 'op-9', revision: 3, phase: 'cleanup-pending', control: 'idle',
  siteOrigin: site, accountLabel: null, tokenName: 'stuck-token', groups: [], candidates: [], candidatesGroup: null,
  cleanupPending: { siteOrigin: site, tokenName: 'stuck-token', tokenId: 7 }, can: {} }

const failedState: BrowserImportState = { ...loginState(4), operationId: 'op-7', revision: 4, phase: 'failed',
  error: { code: 'login-timeout', message: 'Sign-in timed out', retryTarget: 'login' }, can: { retry: true, cancel: true } }

/** Stateful desktop coordinator double: getState reflects the current state every command produced. */
function desktopCoordinator(initial: BrowserImportState | null = null) {
  let state = initial
  let pending: NonNullable<BrowserImportResponse['pending']> = []
  const invoke = vi.fn(async (action: BrowserImportAction, payload?: BrowserImportInput): Promise<BrowserImportResponse> => {
    if (action === 'getState') return { ok: true, state }
    if (action === 'listPending') return { ok: true, pending }
    if (action === 'start') { state = loginState(); return { ok: true, state } }
    if (action === 'setBrowserBounds' || action === 'focusBrowser') return { ok: true }
    if (action === 'checkLogin') { state = selectingState(); return { ok: true, state } }
    if (action === 'setSelection') {
      const selection = payload?.selection
      const models = selection?.models.map(row => ({ ...row, api: 'openai-completions' })) ?? []
      state = { ...state!, revision: state!.revision + 1, selection: selection === undefined ? null : { ...selection, models },
        preview: models.length === 0 ? null : { planHash: 'plan-1', providers: [{
          name: 'default', api: 'openai-completions', baseUrl: `${site}/v1`, models: models.map(row => row.modelName) }] } }
      return { ok: true, state }
    }
    if (action === 'submit') {
      const models = state?.selection?.models ?? []
      state = { ...state!, phase: 'success', revision: state!.revision + 1, control: 'idle', tokenName: 'hemi-token',
        cleanupPending: null, error: null, preview: null,
        result: { providerIds: ['connection/imported'], modelKeys: models.map(row => row.modelName) }, can: {} }
      return { ok: true, state }
    }
    if (action === 'pause') { state = { ...state!, control: 'paused', can: { resume: true, cancel: true } }; return { ok: true, state } }
    if (action === 'resume') { state = selectingState((state?.revision ?? 0) + 1); return { ok: true, state } }
    if (action === 'retry') { state = loginState((state?.revision ?? 0) + 1); return { ok: true, state } }
    if (action === 'cancel') { state = { ...state!, phase: 'cancelled', can: {} }; return { ok: true, state } }
    if (action === 'resumePending') { state = selectingState(9); return { ok: true, state } }
    return { ok: false }
  })
  return {
    invoke,
    recoveries: (rows: NonNullable<BrowserImportResponse['pending']>) => { pending = rows },
    /** The native transaction settles on its own, so only polling observes it. */
    forceSuccess: () => {
      state = { ...(state ?? loginState()), phase: 'success', control: 'idle', tokenName: 'hemi-token',
        cleanupPending: null, error: null, preview: null,
        result: { providerIds: ['connection/imported'], modelKeys: ['deepseek-chat'] }, can: {} }
    },
  }
}

type Desktop = ReturnType<typeof desktopCoordinator>

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class implements ResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element): void {
      const size = { inlineSize: 100, blockSize: 24 }
      this.callback([{ target, borderBoxSize: [size], contentBoxSize: [size], devicePixelContentBoxSize: [size],
        contentRect: new DOMRect(0, 0, 100, 24) }], this)
    }
    unobserve(): void {}
    disconnect(): void {}
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function mountPage(translate: ReturnType<typeof makeTranslate>, api: ModelAccessActions, desktop?: Desktop): void {
  if (desktop) vi.stubGlobal('dshDesktop', { newApiImport: { invoke: desktop.invoke } satisfies NewApiDesktopBridge })
  render(<ModelAccessPage actions={api} test={vi.fn()} t={translate} renderFactorySlot={() => null} />)
}

async function openApiPanel(translate: ReturnType<typeof makeTranslate>): Promise<void> {
  fireEvent.click(screen.getByRole('tab', { name: translate('keyMethod') }))
  await screen.findByRole('region', { name: translate('apiConnections') })
}

function stepList(dialog: HTMLElement, translate: ReturnType<typeof makeTranslate>): HTMLElement[] {
  return within(within(dialog).getByRole('list', { name: translate('newApiSetup') })).getAllByRole('listitem')
}

function currentStep(items: HTMLElement[]): number {
  return items.findIndex(item => item.getAttribute('aria-current') === 'step')
}

/** The dialog header also owns an icon-only close button with the same accessible name. */
function footerButton(dialog: HTMLElement, label: string): HTMLElement {
  const match = within(dialog).getAllByRole('button', { name: label }).filter(button => button.textContent === label)
  expect(match).toHaveLength(1)
  return match[0]!
}

type InvokeCall = Parameters<NewApiDesktopBridge['invoke']>

function invokeCalls({ invoke }: Desktop, action: BrowserImportAction): InvokeCall[] {
  return invoke.mock.calls.filter(([called]) => called === action)
}

it.each([zh, en])('reaches the New API dialog only through the API tab', async (dictionary) => {
  const translate = makeTranslate(dictionary)
  mountPage(translate, actions())
  await act(async () => {})
  expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual([translate('subscriptionsMethod'), translate('keyMethod')])
  expect(screen.queryByRole('tab', { name: /New API/ })).toBeNull()
  expect(screen.queryByRole('button', { name: translate('connectNewApi') })).toBeNull()
  await openApiPanel(translate)
  const entry = screen.getByRole('button', { name: translate('connectNewApi') })
  entry.focus()
  fireEvent.click(entry)
  const dialog = screen.getByRole('dialog', { name: translate('newApiSetup') })
  expect(dialog.contains(document.activeElement)).toBe(true)
  expect(within(dialog).getByText(translate('newApiWebHelp'))).toBeTruthy()
  expect(within(dialog).getByLabelText(translate('site'))).toBeTruthy()
  expect(within(dialog).queryByLabelText(translate('browserSite'))).toBeNull()
  expect(within(dialog).queryByRole('list')).toBeNull()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(entry)
})

it.each([zh, en])('keeps the manual draft across closes and refreshes the API list after import', async (dictionary) => {
  const translate = makeTranslate(dictionary)
  const api = actions()
  vi.mocked(api.keyDirectory)
    .mockResolvedValueOnce({ revision: 1, profiles: [] })
    .mockResolvedValue({ revision: 2, profiles: [importedProfile] })
  vi.mocked(api.listNewApi)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue([{ id: 1, name: 'token-a', group: 'default' }])
  vi.mocked(api.importNewApi).mockResolvedValue(2)
  mountPage(translate, api)
  await act(async () => {})
  await openApiPanel(translate)
  const entry = screen.getByRole('button', { name: translate('connectNewApi') })
  fireEvent.click(entry)
  let dialog = screen.getByRole('dialog', { name: translate('newApiSetup') })
  fireEvent.change(within(dialog).getByLabelText(translate('site')), { target: { value: site } })
  fireEvent.change(within(dialog).getByLabelText(translate('userId')), { target: { value: '42' } })
  fireEvent.change(within(dialog).getByLabelText(translate('accessToken')), { target: { value: 'management-token' } })
  fireEvent.click(footerButton(dialog, translate('close')))
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(entry)
  dialog = screen.getByRole('dialog', { name: translate('newApiSetup') })
  expect(within(dialog).getByLabelText(translate('site'))).toHaveProperty('value', site)
  expect(within(dialog).getByLabelText(translate('userId'))).toHaveProperty('value', '42')
  expect(within(dialog).getByLabelText(translate('accessToken'))).toHaveProperty('value', 'management-token')
  fireEvent.click(within(dialog).getByRole('button', { name: translate('listTokens') }))
  expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', translate('failed'))
  fireEvent.click(within(dialog).getByRole('button', { name: translate('listTokens') }))
  fireEvent.change(await within(dialog).findByLabelText(translate('token')), { target: { value: '1' } })
  const importButton = within(dialog).getByRole('button', { name: translate('import') }) as HTMLButtonElement
  await waitFor(() => { expect(importButton.disabled).toBe(false) })
  fireEvent.click(importButton)
  expect(await within(dialog).findByText(translate('imported', { count: 2 }))).toBeTruthy()
  expect(footerButton(dialog, translate('done'))).toBeTruthy()
  expect(api.importNewApi).toHaveBeenCalledWith({ site, userId: '42', accessToken: 'management-token' }, 1, expect.any(AbortSignal))
  await screen.findByRole('region', { name: importedProfile.name })
  expect(api.keyDirectory).toHaveBeenCalledTimes(2)
})

it.each([zh, en])('guides the desktop sign-in through selection to import inside one dialog', async (dictionary) => {
  const translate = makeTranslate(dictionary)
  const api = actions()
  vi.mocked(api.keyDirectory)
    .mockResolvedValueOnce({ revision: 1, profiles: [] })
    .mockResolvedValue({ revision: 2, profiles: [importedProfile] })
  const desktop = desktopCoordinator()
  mountPage(translate, api, desktop)
  await act(async () => {})
  await openApiPanel(translate)
  fireEvent.click(screen.getByRole('button', { name: translate('connectNewApi') }))
  const dialog = screen.getByRole('dialog', { name: translate('newApiSetup') })
  expect(currentStep(stepList(dialog, translate))).toBe(0)
  const address = within(dialog).getByLabelText(translate('browserSite')) as HTMLInputElement
  await waitFor(() => { expect(address.disabled).toBe(false) })
  expect(within(dialog).getByLabelText(translate('siteProtocol'))).toHaveProperty('value', 'https')
  fireEvent.change(address, { target: { value: new URL(site).host } })
  fireEvent.click(within(dialog).getByRole('button', { name: translate('browserLogin') }))
  await act(async () => {})
  expect(within(dialog).getByText(translate('browserLoginHelp'))).toBeTruthy()
  expect(within(dialog).getByText(`${site} · user@example.test`)).toBeTruthy()
  expect(currentStep(stepList(dialog, translate))).toBe(0)
  fireEvent.click(within(dialog).getByRole('button', { name: translate('checkBrowserLogin') }))
  await act(async () => {})
  expect(currentStep(stepList(dialog, translate))).toBe(1)
  expect(within(dialog).getByLabelText(translate('group'))).toHaveProperty('value', 'default')
  expect(within(dialog).getByRole('checkbox', { name: /image-only/ })).toHaveProperty('disabled', true)
  fireEvent.click(within(dialog).getByRole('checkbox', { name: 'deepseek-chat' }))
  fireEvent.change(within(dialog).getByLabelText(translate('budget')), { target: { value: '5' } })
  fireEvent.click(within(dialog).getByRole('button', { name: translate('import') }))
  expect(await within(dialog).findByText(translate('imported', { count: 1 }))).toBeTruthy()
  expect(within(dialog).getByText(translate('createdToken', { token: 'hemi-token' }))).toBeTruthy()
  const done = stepList(dialog, translate)
  expect(currentStep(done)).toBe(2)
  for (const item of done) expect(item.getAttribute('data-complete')).toBe('true')
  expect(footerButton(dialog, translate('done'))).toBeTruthy()
  expect(invokeCalls(desktop, 'start')).toEqual([['start', { siteUrl: site }]])
  expect(invokeCalls(desktop, 'checkLogin')).toEqual([['checkLogin', { operationId: 'op-1', revision: 1 }]])
  expect(invokeCalls(desktop, 'setSelection').at(-1)![1]!.selection).toEqual({
    group: 'default', models: [{ modelName: 'deepseek-chat' }],
    budgetMode: 'usd', budgetUsd: 5, expiryMode: 'never',
  })
  expect(invokeCalls(desktop, 'submit')).toEqual([['submit', { planHash: 'plan-1', operationId: 'op-1', revision: 3 }]])
  expect(invokeCalls(desktop, 'cancel')).toEqual([])
  await screen.findByRole('region', { name: importedProfile.name })
  expect(api.keyDirectory).toHaveBeenCalledTimes(2)
})

it('keeps the native import across closes and cancels it only on an explicit click', async () => {
  const translate = makeTranslate(zh)
  const desktop = desktopCoordinator()
  mountPage(translate, actions(), desktop)
  await act(async () => {})
  await openApiPanel(translate)
  const entry = screen.getByRole('button', { name: translate('connectNewApi') })
  fireEvent.click(entry)
  let dialog = screen.getByRole('dialog', { name: translate('newApiSetup') })
  const address = within(dialog).getByLabelText(translate('browserSite')) as HTMLInputElement
  await waitFor(() => { expect(address.disabled).toBe(false) })
  fireEvent.change(address, { target: { value: site } })
  fireEvent.click(within(dialog).getByRole('button', { name: translate('browserLogin') }))
  await act(async () => {})
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(invokeCalls(desktop, 'cancel')).toEqual([])
  fireEvent.click(entry)
  dialog = screen.getByRole('dialog', { name: translate('newApiSetup') })
  expect(within(dialog).getByRole('button', { name: translate('checkBrowserLogin') })).toBeTruthy()
  expect(within(dialog).getByText(`${site} · user@example.test`)).toBeTruthy()
  expect(invokeCalls(desktop, 'start')).toHaveLength(1)
  fireEvent.click(within(dialog).getByRole('button', { name: translate('cancel') }))
  await act(async () => {})
  expect(within(dialog).getByText(translate('browserCancelled'))).toBeTruthy()
  expect(invokeCalls(desktop, 'cancel')).toEqual([['cancel', { operationId: 'op-1', revision: 1 }]])
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(invokeCalls(desktop, 'cancel')).toHaveLength(1)
})

it('keeps pause and resume on the native commands', async () => {
  const translate = makeTranslate(zh)
  const desktop = desktopCoordinator(selectingState())
  mountPage(translate, actions(), desktop)
  await act(async () => {})
  await openApiPanel(translate)
  fireEvent.click(screen.getByRole('button', { name: translate('connectNewApi') }))
  const dialog = screen.getByRole('dialog', { name: translate('newApiSetup') })
  await within(dialog).findByLabelText(translate('group'))
  expect(within(dialog).queryByLabelText(translate('browserSite'))).toBeNull()
  fireEvent.click(within(dialog).getByRole('button', { name: translate('pauseImport') }))
  await act(async () => {})
  expect(within(dialog).getByText(translate('browserPaused'))).toBeTruthy()
  expect(invokeCalls(desktop, 'pause')).toEqual([['pause', { operationId: 'op-1', revision: 2 }]])
  fireEvent.click(within(dialog).getByRole('button', { name: translate('resumeImport') }))
  await act(async () => {})
  expect(within(dialog).queryByText(translate('browserPaused'))).toBeNull()
  expect(within(dialog).getByRole('button', { name: translate('pauseImport') })).toBeTruthy()
  expect(invokeCalls(desktop, 'resume')).toEqual([['resume', { operationId: 'op-1', revision: 2 }]])
})

it('reports a failed step and retries it through the native command', async () => {
  const translate = makeTranslate(zh)
  const desktop = desktopCoordinator(failedState)
  mountPage(translate, actions(), desktop)
  await act(async () => {})
  await openApiPanel(translate)
  fireEvent.click(screen.getByRole('button', { name: translate('connectNewApi') }))
  const dialog = screen.getByRole('dialog', { name: translate('newApiSetup') })
  expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', 'Sign-in timed out')
  expect(currentStep(stepList(dialog, translate))).toBe(0)
  fireEvent.click(within(dialog).getByRole('button', { name: translate('retryImport') }))
  await act(async () => {})
  expect(within(dialog).queryByRole('alert')).toBeNull()
  expect(within(dialog).getByRole('button', { name: translate('checkBrowserLogin') })).toBeTruthy()
  expect(currentStep(stepList(dialog, translate))).toBe(0)
  expect(invokeCalls(desktop, 'retry')).toEqual([['retry', { target: 'login', operationId: 'op-7', revision: 4 }]])
})

it('surfaces a pending cleanup and resumes the recorded import', async () => {
  const translate = makeTranslate(zh)
  const desktop = desktopCoordinator(stuckState)
  desktop.recoveries([{ operationId: 'op-9', siteOrigin: site, phase: 'cleanup-pending', readable: true }])
  mountPage(translate, actions(), desktop)
  await act(async () => {})
  await openApiPanel(translate)
  fireEvent.click(screen.getByRole('button', { name: translate('connectNewApi') }))
  const dialog = screen.getByRole('dialog', { name: translate('newApiSetup') })
  expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', translate('cleanupPending'))
  expect(within(dialog).getByRole('heading', { name: translate('pendingImports') })).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: translate('resumeImport') }))
  await act(async () => {})
  expect(within(dialog).getByLabelText(translate('group'))).toBeTruthy()
  expect(invokeCalls(desktop, 'resumePending')).toEqual([['resumePending', { operationId: 'op-9', revision: 3 }]])
})

it('stops polling a settled import while the dialog stays closed', async () => {
  const translate = makeTranslate(zh)
  const desktop = desktopCoordinator(stuckState)
  mountPage(translate, actions(), desktop)
  await act(async () => {})
  await openApiPanel(translate)
  vi.useFakeTimers()
  fireEvent.click(screen.getByRole('button', { name: translate('connectNewApi') }))
  await act(async () => {})
  const opened = invokeCalls(desktop, 'getState').length
  expect(opened).toBeGreaterThan(0)
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(invokeCalls(desktop, 'getState')).toHaveLength(opened + 2)
  fireEvent.keyDown(document, { key: 'Escape' })
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(invokeCalls(desktop, 'getState')).toHaveLength(opened + 2)
  fireEvent.click(screen.getByRole('button', { name: translate('connectNewApi') }))
  await act(async () => {})
  expect(invokeCalls(desktop, 'getState')).toHaveLength(opened + 3)
})

it('clears a status warning after the next successful poll', async () => {
  const translate = makeTranslate(zh)
  const desktop = desktopCoordinator(selectingState())
  desktop.invoke.mockRejectedValueOnce(new Error('bridge unavailable'))
  mountPage(translate, actions(), desktop)
  await openApiPanel(translate)
  vi.useFakeTimers()
  fireEvent.click(screen.getByRole('button', { name: translate('connectNewApi') }))
  const dialog = screen.getByRole('dialog', { name: translate('newApiSetup') })
  await act(async () => {})
  expect(within(dialog).getByRole('alert').textContent).toContain(translate('browserStatusFailed'))
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(within(dialog).queryByRole('alert')).toBeNull()
  expect(within(dialog).getByRole('checkbox', { name: 'deepseek-chat' })).toBeTruthy()
})

it('announces a background success and starts fresh after the result is dismissed', async () => {
  const translate = makeTranslate(zh)
  const api = actions()
  vi.mocked(api.keyDirectory)
    .mockResolvedValueOnce({ revision: 1, profiles: [] })
    .mockResolvedValue({ revision: 2, profiles: [importedProfile] })
  const desktop = desktopCoordinator()
  mountPage(translate, api, desktop)
  await act(async () => {})
  await openApiPanel(translate)
  vi.useFakeTimers()
  fireEvent.click(screen.getByRole('button', { name: translate('connectNewApi') }))
  let dialog = screen.getByRole('dialog', { name: translate('newApiSetup') })
  const address = within(dialog).getByLabelText(translate('browserSite')) as HTMLInputElement
  await act(async () => {})
  fireEvent.change(address, { target: { value: site } })
  fireEvent.click(within(dialog).getByRole('button', { name: translate('browserLogin') }))
  await act(async () => {})
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  desktop.forceSuccess()
  await act(async () => { await vi.advanceTimersByTimeAsync(1100) })
  await act(async () => {})
  expect(screen.getByRole('status')).toHaveProperty('textContent', translate('imported', { count: 1 }))
  expect(api.keyDirectory).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('region', { name: importedProfile.name })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: translate('connectNewApi') }))
  dialog = screen.getByRole('dialog', { name: translate('newApiSetup') })
  expect(within(dialog).getByText(translate('imported', { count: 1 }))).toBeTruthy()
  expect(within(dialog).queryByLabelText(translate('browserSite'))).toBeNull()
  fireEvent.click(footerButton(dialog, translate('done')))
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: translate('connectNewApi') }))
  dialog = screen.getByRole('dialog', { name: translate('newApiSetup') })
  await act(async () => {})
  const nextAddress = within(dialog).getByLabelText(translate('browserSite'))
  expect(nextAddress).toHaveProperty('value', '')
  fireEvent.change(nextAddress, { target: { value: site } })
  fireEvent.click(within(dialog).getByRole('button', { name: translate('browserLogin') }))
  await act(async () => {})
  expect(within(dialog).getByRole('button', { name: translate('checkBrowserLogin') })).toBeTruthy()
  expect(currentStep(stepList(dialog, translate))).toBe(0)
  expect(invokeCalls(desktop, 'start')).toHaveLength(2)
})

it('reports a failed start in the closed summary without cancelling', async () => {
  const translate = makeTranslate(zh)
  const desktop = desktopCoordinator()
  const start = Promise.withResolvers<BrowserImportResponse>()
  const commands = desktop.invoke.getMockImplementation()!
  desktop.invoke.mockImplementation(async (action, payload) => action === 'start' ? await start.promise : commands(action, payload))
  mountPage(translate, actions(), desktop)
  await act(async () => {})
  await openApiPanel(translate)
  fireEvent.click(screen.getByRole('button', { name: translate('connectNewApi') }))
  const dialog = screen.getByRole('dialog', { name: translate('newApiSetup') })
  const address = within(dialog).getByLabelText(translate('browserSite')) as HTMLInputElement
  await waitFor(() => { expect(address.disabled).toBe(false) })
  fireEvent.change(address, { target: { value: site } })
  fireEvent.click(within(dialog).getByRole('button', { name: translate('browserLogin') }))
  await act(async () => {})
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
  await act(async () => { start.reject(new Error('bridge unavailable')) })
  expect(screen.getByRole('alert')).toHaveProperty('textContent', translate('browserFailed'))
  expect(invokeCalls(desktop, 'start')).toHaveLength(1)
  expect(invokeCalls(desktop, 'cancel')).toEqual([])
})
