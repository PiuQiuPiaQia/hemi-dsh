// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ModelConnectionTest } from '../src/client/ModelConnectionTest.tsx'
import { ModelAccessPage } from '../src/client/ModelAccessPage.tsx'
import { KeyProfiles } from '../src/client/KeyProfiles.tsx'
import { ModelOptionsEditor } from '../src/client/ModelOptionsEditor.tsx'
import { SubscriptionCard } from '../src/client/SubscriptionCard.tsx'
import { en, zh } from '../src/client/copy.ts'
import type { ModelAccessActions, ModelTest } from '../src/client/types.ts'

const t = makeTranslate(zh)
const provider = 'connection/a'
const model = 'model/a'
const profile = { id: provider, name: 'Connection A', baseUrl: 'https://example.com/v1', api: 'openai-completions', models: [model], hasKey: true, modelOptions: {} }

function actions(): ModelAccessActions {
  return {
    reportModelFailure: vi.fn(),
    keyDirectory: vi.fn(async () => ({ revision: 1, profiles: [profile] })),
    getModelOptions: vi.fn(async () => ({ revision: 1, options: {}, effective: { name: model, input: ['text'] as const } })),
    getModelDefaults: vi.fn(async (_api: string, id: string) => ({ name: id, input: ['text'] as const })),
    saveModelOptions: vi.fn(async () => {}), discoverKeyModels: vi.fn(async () => []),
    saveKeyProfile: vi.fn(async () => {}), removeKeyProfile: vi.fn(async () => {}),
    subscriptionCandidates: vi.fn(async () => []), changeSubscriptionModel: vi.fn(async () => {}),
    subscriptionModels: vi.fn(async () => []),
    subscriptions: vi.fn(async () => []), state: vi.fn(async () => null),
    start: vi.fn(async (id: string) => ({ id, provider, phase: 'pending' as const })),
    answer: vi.fn(async () => {}), cancel: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
    quota: vi.fn(async () => []), listNewApi: vi.fn(async () => []), importNewApi: vi.fn(async () => 0),
  }
}

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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it.each([zh, en])('switches between subscription and API connections by keyboard', async (dictionary) => {
  const translate = makeTranslate(dictionary)
  const api = actions()
  render(<ModelAccessPage actions={api} test={vi.fn()} t={translate} renderFactorySlot={() => null} />)
  await act(async () => {})
  const subscriptions = screen.getByRole('tab', { name: translate('subscriptionsMethod') })
  expect(screen.getAllByRole('tab')).toHaveLength(2)
  expect(subscriptions.getAttribute('aria-selected')).toBe('true')
  expect(api.keyDirectory).not.toHaveBeenCalled()
  subscriptions.focus()
  fireEvent.keyDown(subscriptions, { key: 'ArrowRight' })
  await act(async () => {})
  const keys = screen.getByRole('tab', { name: translate('keyMethod') })
  expect(document.activeElement).toBe(keys)
  expect(screen.getByRole('tabpanel', { name: translate('keyMethod') }).id).toBe(keys.getAttribute('aria-controls'))
  expect(api.keyDirectory).toHaveBeenCalledOnce()
  expect(screen.getByRole('button', { name: translate('connectNewApi') })).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.keyDown(keys, { key: 'Home' })
  expect(document.activeElement).toBe(subscriptions)
  expect(api.subscriptions).toHaveBeenCalledOnce()
})

it.each([
  { dictionary: zh, balance: true }, { dictionary: en, balance: true },
  { dictionary: zh, balance: false }, { dictionary: en, balance: false },
])('refreshes usage with a localized icon-only button ($balance)', async ({ dictionary, balance }) => {
  const translate = makeTranslate(dictionary)
  const api = actions()
  const pending = Promise.withResolvers<undefined>()
  const refreshBalance = vi.fn(() => pending.promise)
  render(<SubscriptionCard row={{ id: provider, name: 'Subscription', connected: true, models: [], quota: !balance }}
    actions={api} test={vi.fn()} t={translate} pending={false} connect={vi.fn()} disconnect={vi.fn()} modelsChanged={vi.fn()}
    {...(balance ? { balance: { rows: [], unavailable: false }, refreshBalance } : {})} />)
  await act(async () => {})
  vi.mocked(api.quota).mockImplementation(async () => { await pending.promise; return [] })
  const button = screen.getByRole('button', { name: translate(balance ? 'refreshBalance' : 'quota') }) as HTMLButtonElement
  expect(button.textContent).toBe('')
  expect(button.querySelector('svg')).not.toBeNull()
  fireEvent.keyDown(window, { key: 'Tab' })
  fireEvent.focus(button)
  expect(await screen.findByRole('tooltip')).toHaveProperty('textContent', translate(balance ? 'refreshBalance' : 'quota'))
  fireEvent.blur(button)
  fireEvent.click(button)
  expect(button.disabled).toBe(true)
  expect(button.getAttribute('aria-busy')).toBe('true')
  if (balance) expect(refreshBalance).toHaveBeenCalledOnce()
  else expect(api.quota).toHaveBeenCalledTimes(2)
  await act(async () => { pending.resolve(undefined) })
  expect(button.disabled).toBe(false)
  expect(button.getAttribute('aria-busy')).toBe('false')
})

it.each([zh, en])('offers header model discovery as an icon-only localized action on both cards', async (dictionary) => {
  const translate = makeTranslate(dictionary)
  const keyView = render(<KeyProfiles actions={actions()} test={vi.fn()} t={translate} />)
  let card = await screen.findByRole('region', { name: profile.name })
  const names = (region: HTMLElement): string[] => within(region).getAllByRole('button')
    .map(button => button.getAttribute('aria-label') ?? button.textContent ?? '')
  expect(names(card).slice(0, 3)).toEqual([translate('fetchModels'), translate('editConnection'), translate('removeConnection')])
  const keyDiscovery = within(card).getByRole('button', { name: translate('fetchModels') })
  expect(keyDiscovery.textContent).toBe('')
  expect(keyDiscovery.querySelector('svg')).not.toBeNull()
  expect(keyDiscovery.getAttribute('title')).toBeNull()
  fireEvent.keyDown(window, { key: 'Tab' })
  fireEvent.focus(keyDiscovery)
  expect(await screen.findByRole('tooltip')).toHaveProperty('textContent', translate('fetchModels'))
  fireEvent.blur(keyDiscovery)
  expect(screen.queryByRole('tooltip')).toBeNull()
  keyView.unmount()
  render(<SubscriptionCard row={{ id: provider, name: 'Subscription', connected: true, models: [model], quota: false }}
    actions={actions()} test={vi.fn()} t={translate} pending={false} connect={vi.fn()} disconnect={vi.fn()} modelsChanged={vi.fn()} />)
  card = screen.getByRole('region', { name: 'Subscription' })
  expect(names(card).slice(0, 3)).toEqual([translate('fetchModels'), translate('reconnect'), translate('disconnect')])
  const subscriptionDiscovery = within(card).getByRole('button', { name: translate('fetchModels') })
  expect(subscriptionDiscovery.textContent).toBe('')
  expect(subscriptionDiscovery.querySelector('svg')).not.toBeNull()
  fireEvent.keyDown(window, { key: 'Tab' })
  fireEvent.focus(subscriptionDiscovery)
  expect(await screen.findByRole('tooltip')).toHaveProperty('textContent', translate('fetchModels'))
})

it('adds and removes subscription models through the native subscription actions', async () => {
  const api = actions()
  vi.mocked(api.subscriptionCandidates).mockResolvedValue(['model/b'])
  const modelsChanged = vi.fn(async () => {})
  render(<SubscriptionCard row={{ id: provider, name: 'Subscription', connected: true, models: [model], quota: false }}
    actions={api} test={vi.fn()} t={t} pending={false} connect={vi.fn()} disconnect={vi.fn()} modelsChanged={modelsChanged} />)
  const card = screen.getByRole('region', { name: 'Subscription' })
  fireEvent.click(within(card).getByRole('button', { name: t('fetchModels') }))
  const dialog = await screen.findByRole('dialog', { name: t('chooseModels') })
  fireEvent.click(await within(dialog).findByRole('checkbox', { name: 'model/b' }))
  expect(api.subscriptionCandidates).toHaveBeenCalledWith(provider, expect.any(AbortSignal))
  fireEvent.click(within(dialog).getByRole('button', { name: t('addModels') }))
  await act(async () => {})
  expect(api.changeSubscriptionModel).toHaveBeenCalledWith(provider, 'model/b', true)
  expect(modelsChanged).toHaveBeenCalledOnce()
  expect(screen.queryByRole('dialog')).toBeNull()
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
  fireEvent.click(within(card).getByRole('button', { name: t('deleteModel') }))
  expect(confirm).toHaveBeenCalledWith(t('confirmDeleteModel', { model }))
  await act(async () => {})
  expect(api.changeSubscriptionModel).toHaveBeenCalledWith(provider, model, false)
})

it('hides discovery and model rows for a signed-out subscription', () => {
  render(<SubscriptionCard row={{ id: provider, name: 'Subscription', connected: false, models: [model], quota: false }}
    actions={actions()} test={vi.fn()} t={t} pending={false} connect={vi.fn()} disconnect={vi.fn()} modelsChanged={vi.fn()} />)
  const card = screen.getByRole('region', { name: 'Subscription' })
  expect(within(card).queryByRole('button', { name: t('fetchModels') })).toBeNull()
  expect(within(card).queryByRole('group', { name: model })).toBeNull()
  expect(within(card).queryByRole('dialog')).toBeNull()
  expect(within(card).getByRole('button', { name: t('connect') })).toBeTruthy()
  expect(within(card).queryByRole('button', { name: t('disconnect') })).toBeNull()
  expect(card.textContent).toContain(t('disconnected'))
})

it.each([zh, en])('gives three icon-only actions localized accessible names and a focus tooltip', async (dictionary) => {
  const translate = makeTranslate(dictionary)
  render(<ModelConnectionTest provider={provider} model={model} actions={actions()} test={vi.fn()} remove={vi.fn()} t={translate} />)
  const row = screen.getByRole('group', { name: model })
  const buttons = within(row).getAllByRole('button')
  expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual([
    translate('modelSettings'), translate('testModel'), translate('deleteModel'),
  ])
  for (const button of buttons) {
    expect(button.textContent).toBe('')
    expect(button.querySelector('svg')).not.toBeNull()
    expect(button.getAttribute('title')).toBeNull()
  }
  fireEvent.keyDown(window, { key: 'Tab' })
  fireEvent.focus(buttons[0]!)
  expect(await screen.findByRole('tooltip')).toHaveProperty('textContent', translate('modelSettings'))
  fireEvent.blur(buttons[0]!)
  expect(screen.queryByRole('tooltip')).toBeNull()
})

it('opens saved settings from the icon and retains its loading disable state', async () => {
  const api = actions()
  let resolve!: (value: Awaited<ReturnType<ModelAccessActions['getModelOptions']>>) => void
  vi.mocked(api.getModelOptions).mockImplementation(() => new Promise((done) => { resolve = done }))
  render(<ModelConnectionTest provider={provider} model={model} actions={api} test={vi.fn()} t={t} />)
  const settings = screen.getByRole('button', { name: t('modelSettings') }) as HTMLButtonElement
  fireEvent.click(settings)
  expect(settings.disabled).toBe(true)
  expect(settings.getAttribute('aria-busy')).toBe('true')
  expect(api.getModelOptions).toHaveBeenCalledWith(provider, model)
  await act(async () => { resolve({ revision: 1, options: {}, effective: { name: model, input: ['text'] } }) })
  expect(await screen.findByRole('dialog', { name: t('modelSettings') })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: t('cancel') }))
  expect(api.saveModelOptions).not.toHaveBeenCalled()
})

it('shows effective image and token capabilities without persisting untouched defaults', async () => {
  const save = vi.fn(async () => {})
  render(<ModelOptionsEditor model={model} options={{}} effective={{ name: 'Vision model', contextWindow: 128000,
    maxTokens: 8192, input: ['text', 'image'] }} save={save} close={vi.fn()} t={t} />)
  expect(screen.getByLabelText(t('modelDisplayName'))).toHaveProperty('value', 'Vision model')
  expect(screen.getByLabelText(t('contextWindow'))).toHaveProperty('value', '128000')
  expect(screen.getByLabelText(t('maxTokens'))).toHaveProperty('value', '8192')
  expect(screen.getByRole('checkbox', { name: t('imageInput') })).toHaveProperty('checked', true)
  expect(screen.getAllByRole('checkbox')).toHaveLength(2)
  expect(screen.getByRole('dialog').textContent).not.toContain('适配器')
  fireEvent.click(screen.getByRole('button', { name: t('saveModel') }))
  await act(async () => {})
  expect(save).toHaveBeenCalledWith({})
})

it('preserves explicit input overrides and saves only edited effective fields', async () => {
  const save = vi.fn(async () => {})
  render(<ModelOptionsEditor model={model} options={{ input: ['text'] }} effective={{ name: model, contextWindow: 128000,
    maxTokens: 8192, input: ['text'] }} save={save} close={vi.fn()} t={t} />)
  expect(screen.getByRole('checkbox', { name: t('imageInput') })).toHaveProperty('checked', false)
  fireEvent.change(screen.getByLabelText(t('modelDisplayName')), { target: { value: 'Renamed' } })
  fireEvent.click(screen.getByRole('button', { name: t('saveModel') }))
  await act(async () => {})
  expect(save).toHaveBeenCalledWith({ name: 'Renamed', input: ['text'] })
})

it.each([true, false])('spins the test icon without adding status text until the test settles (%s)', async (toolCall) => {
  const pending = Promise.withResolvers<boolean>()
  const test = vi.fn<ModelTest>(() => pending.promise)
  render(<ModelConnectionTest provider={provider} model={model} actions={actions()} test={test} remove={vi.fn()} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: t('testModel') }))
  const button = screen.getByRole('button', { name: t('testingModel') })
  expect(button.getAttribute('aria-busy')).toBe('true')
  expect(button.querySelector('[data-icon="dsw-icon-loading-outline-regular"]')).not.toBeNull()
  expect(screen.queryByRole('status')).toBeNull()
  for (const action of screen.getAllByRole('button')) expect((action as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(button)
  expect(test).toHaveBeenCalledExactlyOnceWith(provider, model, expect.any(AbortSignal))
  await act(async () => { pending.resolve(toolCall) })
  expect(screen.getByRole('status').textContent).toBe(t(toolCall ? 'modelToolOk' : 'modelResponseOk'))
  expect(button.querySelector('[data-icon="dsw-icon-play-outline-regular"]')).not.toBeNull()
  for (const action of screen.getAllByRole('button')) expect((action as HTMLButtonElement).disabled).toBe(false)
})

it('ignores a second test activation before the loading state is committed', async () => {
  const pending = Promise.withResolvers<boolean>()
  const test = vi.fn<ModelTest>(() => pending.promise)
  render(<ModelConnectionTest provider={provider} model={model} actions={actions()} test={test} t={t} />)
  const button = screen.getByRole('button', { name: t('testModel') })
  act(() => {
    fireEvent.click(button)
    fireEvent.click(button)
  })
  expect(test).toHaveBeenCalledOnce()
  await act(async () => { pending.resolve(true) })
  expect(screen.getByRole('status').textContent).toBe(t('modelToolOk'))
})

it('reports test failure outside the row and aborts an active test on unmount', async () => {
  const api = actions()
  const test = vi.fn<ModelTest>().mockRejectedValueOnce(new Error('offline'))
  const view = render(<ModelConnectionTest provider={provider} model={model} actions={api} test={test} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: t('testModel') }))
  await act(async () => {})
  expect(api.reportModelFailure).toHaveBeenCalledExactlyOnceWith({ operation: 'test', model })
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.getByRole('group', { name: model }).textContent).toBe(model)
  const pending = Promise.withResolvers<boolean>()
  test.mockImplementation(() => pending.promise)
  fireEvent.click(screen.getByRole('button', { name: t('testModel') }))
  const signal = test.mock.calls[1]![2]
  view.unmount()
  expect(signal.aborted).toBe(true)
  await act(async () => { pending.reject(new Error('cancelled')) })
  expect(api.reportModelFailure).toHaveBeenCalledOnce()
})

it('tests different model rows independently and keeps out-of-order results on their own rows', async () => {
  const first = Promise.withResolvers<boolean>()
  const second = Promise.withResolvers<boolean>()
  const test = vi.fn<ModelTest>((_provider, id) => id === model ? first.promise : second.promise)
  const api = actions()
  render(<>
    <ModelConnectionTest provider={provider} model={model} actions={api} test={test} t={t} />
    <ModelConnectionTest provider={provider} model="model/b" actions={api} test={test} t={t} />
  </>)
  const firstRow = within(screen.getByRole('group', { name: model }))
  const secondRow = within(screen.getByRole('group', { name: 'model/b' }))
  fireEvent.click(firstRow.getByRole('button', { name: t('testModel') }))
  fireEvent.click(secondRow.getByRole('button', { name: t('testModel') }))
  expect(test).toHaveBeenCalledTimes(2)
  expect(screen.getAllByRole('button', { name: t('testingModel') })).toHaveLength(2)
  await act(async () => { second.resolve(false) })
  expect(secondRow.getByRole('status').textContent).toBe(t('modelResponseOk'))
  expect(firstRow.getByRole('button', { name: t('testingModel') }).getAttribute('aria-busy')).toBe('true')
  expect(firstRow.queryByRole('status')).toBeNull()
  await act(async () => { first.resolve(true) })
  expect(firstRow.getByRole('status').textContent).toBe(t('modelToolOk'))
  expect(secondRow.getByRole('status').textContent).toBe(t('modelResponseOk'))
  expect(api.reportModelFailure).not.toHaveBeenCalled()
})

it('requires confirmation to remove a model and disables the actions during removal', async () => {
  let reject!: (error: Error) => void
  const remove = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail }))
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  const api = actions()
  render(<ModelConnectionTest provider={provider} model={model} actions={api} test={vi.fn()} remove={remove} t={t} />)
  const button = screen.getByRole('button', { name: t('deleteModel') })
  fireEvent.click(button)
  expect(confirm).toHaveBeenCalledWith(t('confirmDeleteModel', { model }))
  expect(remove).not.toHaveBeenCalled()
  confirm.mockReturnValue(true)
  fireEvent.click(button)
  expect(remove).toHaveBeenCalledOnce()
  for (const action of screen.getAllByRole('button')) expect((action as HTMLButtonElement).disabled).toBe(true)
  await act(async () => { reject(new Error('failed')) })
  expect(screen.getByRole('group', { name: model })).toBeTruthy()
  expect(api.reportModelFailure).toHaveBeenCalledExactlyOnceWith({ operation: 'remove', model })
  expect(screen.queryByRole('status')).toBeNull()
  expect((button as HTMLButtonElement).disabled).toBe(false)
})

it('retries a failed connection-list read from its shared action', async () => {
  const api = actions()
  vi.mocked(api.keyDirectory).mockRejectedValueOnce(new Error('offline'))
  render(<KeyProfiles actions={api} test={vi.fn()} t={t} />)
  fireEvent.click(await screen.findByRole('button', { name: t('retryImport') }))
  await screen.findByRole('region', { name: profile.name })
  expect(api.keyDirectory).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('alert')).toBeNull()
})

it('uses the same settings icon for draft models and disables it for unselected models', async () => {
  const api = actions()
  render(<KeyProfiles actions={api} test={vi.fn()} t={t} />)
  fireEvent.click(await screen.findByRole('button', { name: t('editConnection') }))
  const row = screen.getByRole('group', { name: model })
  const settings = within(row).getByRole('button', { name: t('modelSettings') }) as HTMLButtonElement
  expect(settings.textContent).toBe('')
  expect(settings.querySelector('svg')).not.toBeNull()
  fireEvent.click(settings)
  expect(await screen.findByRole('dialog', { name: t('modelSettings') })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: t('cancel') }))
  fireEvent.click(within(row).getByRole('checkbox'))
  expect(settings.disabled).toBe(true)
  expect(api.saveKeyProfile).not.toHaveBeenCalled()
})

it('reopens a cleared draft name with its inherited value before the connection is saved', async () => {
  const api = actions()
  vi.mocked(api.keyDirectory).mockResolvedValue({ revision: 1, profiles: [
    { ...profile, modelOptions: { [model]: { name: 'Saved name' } } },
  ] })
  render(<KeyProfiles actions={api} test={vi.fn()} t={t} />)
  fireEvent.click(await screen.findByRole('button', { name: t('editConnection') }))
  const settings = within(screen.getByRole('group', { name: model })).getByRole('button', { name: t('modelSettings') })
  fireEvent.click(settings)
  await screen.findByRole('dialog', { name: t('modelSettings') })
  expect(screen.getByLabelText(t('modelDisplayName'))).toHaveProperty('value', 'Saved name')
  fireEvent.change(screen.getByLabelText(t('modelDisplayName')), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: t('saveModel') }))
  await act(async () => {})
  fireEvent.click(settings)
  await screen.findByRole('dialog', { name: t('modelSettings') })
  expect(screen.getByLabelText(t('modelDisplayName'))).toHaveProperty('value', model)
  expect(api.getModelDefaults).toHaveBeenCalledWith(profile.api, model, provider)
  fireEvent.click(screen.getByRole('button', { name: t('cancel') }))
  expect(api.saveKeyProfile).not.toHaveBeenCalled()
})

it('discovers models for a model-less key connection from the shared header dialog', async () => {
  const api = actions()
  vi.mocked(api.keyDirectory).mockResolvedValue({ revision: 7, profiles: [{ ...profile, models: [] }] })
  vi.mocked(api.discoverKeyModels).mockResolvedValue(['model/b'])
  render(<KeyProfiles actions={api} test={vi.fn()} t={t} />)
  const card = await screen.findByRole('region', { name: profile.name })
  expect(card.textContent).toContain(t('modelCount', { count: 0 }))
  const discovery = within(card).getByRole('button', { name: t('fetchModels') }) as HTMLButtonElement
  expect(discovery.disabled).toBe(false)
  fireEvent.click(discovery)
  const dialog = await screen.findByRole('dialog', { name: t('chooseModels') })
  fireEvent.click(await within(dialog).findByRole('checkbox', { name: 'model/b' }))
  expect(api.discoverKeyModels).toHaveBeenCalledWith(expect.objectContaining({ id: provider, revision: 7 }), expect.any(AbortSignal))
  fireEvent.click(within(dialog).getByRole('button', { name: t('addModels') }))
  await act(async () => {})
  expect(api.saveKeyProfile).toHaveBeenCalledWith(expect.objectContaining({ id: provider, revision: 7, models: ['model/b'] }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('removes a model from a key connection only after confirmation', async () => {
  const api = actions()
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  render(<KeyProfiles actions={api} test={vi.fn()} t={t} />)
  const card = await screen.findByRole('region', { name: profile.name })
  fireEvent.click(within(card).getByRole('button', { name: t('deleteModel') }))
  expect(confirm).toHaveBeenCalledWith(t('confirmDeleteModel', { model }))
  expect(api.saveKeyProfile).not.toHaveBeenCalled()
  confirm.mockReturnValue(true)
  fireEvent.click(within(card).getByRole('button', { name: t('deleteModel') }))
  await act(async () => {})
  expect(api.saveKeyProfile).toHaveBeenCalledWith(expect.objectContaining({ id: provider, revision: 1, models: [] }))
})

it('edits and removes a key connection from the header actions', async () => {
  const api = actions()
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
  render(<KeyProfiles actions={api} test={vi.fn()} t={t} />)
  const card = await screen.findByRole('region', { name: profile.name })
  fireEvent.click(within(card).getByRole('button', { name: t('editConnection') }))
  expect(await screen.findByRole('region', { name: t('keyEditor') })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: t('back') }))
  expect(screen.queryByRole('region', { name: t('keyEditor') })).toBeNull()
  fireEvent.click(within(screen.getByRole('region', { name: profile.name })).getByRole('button', { name: t('removeConnection') }))
  expect(confirm).toHaveBeenCalledWith(t('confirmRemove'))
  await act(async () => {})
  expect(api.removeKeyProfile).toHaveBeenCalledWith(provider, 1)
})
