// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-hemi-model-access/remote'
import type { Subscription, VvcodeDirectory, VvcodeGroupView, VvcodeModelSelection, VvcodeUsage } from '@deepseek-ai/dsh-hemi-model-access/types'
import { SubscriptionSection } from '../src/client/SubscriptionSection.tsx'
import { VvcodeSubscription } from '../src/client/VvcodeSubscription.tsx'
import { en, zh } from '../src/client/copy.ts'
import type { ModelAccessActions } from '../src/client/types.ts'

const groups: VvcodeGroupView[] = [
  { name: 'standard', desc: 'Standard access', ratio: 1.5, provider: 'vvcode/group/standard', state: 'ready', hasConnection: true, catalogError: false,
    models: [{ id: 'model/a', enabled: true }, { id: 'model/b', enabled: false }] },
  { name: 'auto', desc: 'Automatic routing', ratio: 'auto', provider: 'vvcode/group/auto', state: 'not-synced', hasConnection: false, catalogError: false, models: [] },
]
const directory: VvcodeDirectory = { state: 'ready', groups }
const saved: Subscription = { id: 'vvcode', name: 'VVCode', connected: true, models: ['must-not-render'], quota: false,
  vvcode: { expiresAt: 1900000000000, expired: false } }

function actions(row: Subscription = saved): ModelAccessActions {
  let current = directory
  return {
    reportModelFailure: vi.fn(), keyDirectory: vi.fn(async () => ({ revision: 1, profiles: [] })),
    getModelOptions: vi.fn(async () => ({ revision: 1, options: {}, effective: { name: 'model/a', input: ['text'] as const } })),
    getModelDefaults: vi.fn(async () => ({ name: 'model/a', input: ['text'] as const })),
    saveModelOptions: vi.fn(async () => {}), discoverKeyModels: vi.fn(async () => []),
    saveKeyProfile: vi.fn(async () => {}), removeKeyProfile: vi.fn(async () => {}),
    subscriptionCandidates: vi.fn(async () => ['model/b']), subscriptionModels: vi.fn(async () => row.models),
    changeSubscriptionModel: vi.fn(async () => {}), subscriptions: vi.fn(async () => [row]),
    vvcodeUsage: vi.fn(async () => ({ unit: { kind: 'currency' as const, symbol: '$' }, balance: { state: 'ready' as const, remaining: 12 }, subscriptions: { state: 'ready' as const, items: [{ id: 1, total: 100, used: 20, remaining: 80, expiresAt: 1900000000000, resetAt: null }] } })),
    vvcodeDirectory: vi.fn(async () => current),
    saveVvcodeModels: vi.fn(async (selections: VvcodeModelSelection[]) => {
      current = { ...current, groups: current.groups.map((group) => {
        const selected = selections.find(selection => selection.provider === group.provider)
        return selected === undefined ? group : { ...group,
          models: group.models.map(model => ({ ...model, enabled: selected.models.includes(model.id) })),
        }
      }) }
    }),
    state: vi.fn(async () => null), start: vi.fn(async () => ({ id: 'login', provider: 'vvcode', phase: 'pending' as const })),
    answer: vi.fn(async () => {}), cancel: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
    quota: vi.fn(async () => []), listNewApi: vi.fn(async () => []), importNewApi: vi.fn(async () => 0),
  }
}

function mount(row = saved, api = actions(row), dictionary = zh) {
  const t = makeTranslate(dictionary)
  const changed = vi.fn(async () => {})
  const test = vi.fn(async () => true)
  const view = render(<VvcodeSubscription row={row} actions={api} test={test} t={t} pending={false}
    connect={vi.fn()} disconnect={vi.fn()} modelsChanged={changed} />)
  return { api, t, changed, test, ...view }
}
function group(name: string): HTMLElement {
  return screen.getByRole('region', { name: new RegExp(`^VVCode (?:group|分组) ${name}$`) })
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

async function manage(dictionary = zh): Promise<void> {
  const trigger = screen.getByRole('button', { name: dictionary.vvcodeManage })
  trigger.focus()
  fireEvent.click(trigger)
  await act(async () => {})
}
function twoGroups(): VvcodeDirectory {
  return { ...directory, groups: [groups[0]!, { ...groups[1]!, state: 'ready', hasConnection: true,
    models: [{ id: 'model/a', enabled: true }, { id: 'model/c', enabled: false }] }] }
}

it.each([zh, en])('keeps the account compact and opens all groups only in the management dialog', async (dictionary) => {
  const { api, t } = mount(saved, actions(), dictionary)
  await act(async () => {})
  expect(screen.getByText(t('vvcodeModelSummary', { models: 1, groups: 1 }))).toBeTruthy()
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(screen.queryByRole('region', { name: t('vvcodeGroupRegion', { group: 'standard' }) })).toBeNull()
  expect(screen.queryByText('must-not-render')).toBeNull()
  await manage(dictionary)
  expect(screen.getByRole('dialog', { name: t('vvcodeManage') })).toBeTruthy()
  expect(screen.getAllByRole('checkbox')).toHaveLength(2)
  expect(screen.queryByText(groups[0]!.desc)).toBeNull()
  expect(screen.queryByText(groups[1]!.desc)).toBeNull()
  expect(screen.getByRole('button', { name: t('cancel') }).parentElement?.children).toHaveLength(2)
  expect(within(group('auto')).getByText(t('vvcodeEnabledCount', { enabled: 0, total: 0 }))).toBeTruthy()
  expect(screen.queryByRole('button', { name: t('deleteModel') })).toBeNull()
  expect(api.vvcodeDirectory).toHaveBeenCalledOnce()
  expect(api.vvcodeUsage).toHaveBeenCalledOnce()
  for (const name of ['standard', 'auto']) {
    const toggle = within(group(name)).getByRole('button', { expanded: name === 'standard' })
    expect(within(toggle.parentElement!).getAllByRole('button')).toEqual([toggle])
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).toHaveProperty('hidden', name !== 'standard')
  }
})

it.each(['cancel', 'close', 'escape', 'outside'] as const)('discards checkbox changes on %s and returns focus without selection writes', async (method) => {
  const { api, t } = mount()
  await act(async () => {})
  const trigger = screen.getByRole('button', { name: t('vvcodeManage') })
  await manage()
  fireEvent.click(screen.getByRole('checkbox', { name: t('vvcodeEnableModel', { group: 'standard', model: 'model/b' }) }))
  if (method === 'escape') fireEvent.keyDown(document, { key: 'Escape' })
  else if (method === 'outside') {
    const overlay = screen.getByRole('dialog').parentElement!
    fireEvent.click(overlay.firstElementChild!)
  } else fireEvent.click(within(screen.getByRole('dialog', { name: t('vvcodeManage') })).getByRole('button', { name: t(method) }))
  await act(async () => {})
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  expect(api.saveVvcodeModels).not.toHaveBeenCalled()
  expect(api.changeSubscriptionModel).not.toHaveBeenCalled()
  await manage()
  expect(screen.getByRole('checkbox', { name: t('vvcodeEnableModel', { group: 'standard', model: 'model/b' }) })).toHaveProperty('checked', false)
  expect(api.vvcodeUsage).toHaveBeenCalledOnce()
  expect(api.vvcodeDirectory).toHaveBeenCalledOnce()
})

it.each([true, false])('saves a changed provider once with its complete final selection (%s)', async (add) => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  const { api, t } = mount()
  await act(async () => {})
  await manage()
  const model = add ? 'model/b' : 'model/a'
  fireEvent.click(screen.getByRole('checkbox', { name: t('vvcodeEnableModel', { group: 'standard', model }) }))
  expect(api.saveVvcodeModels).not.toHaveBeenCalled()
  expect(screen.getByText(t('vvcodeModelSummary', { models: 1, groups: 1 }))).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: t('vvcodeSaveSelection') }))
  await act(async () => {})
  expect(api.saveVvcodeModels).toHaveBeenCalledExactlyOnceWith([{ provider: groups[0]!.provider, models: add ? ['model/a', 'model/b'] : [] }], expect.any(AbortSignal))
  expect(confirm).not.toHaveBeenCalled()
  expect(api.changeSubscriptionModel).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByText(t('vvcodeModelSummary', { models: add ? 2 : 0, groups: add ? 1 : 0 }))).toBeTruthy()
})

it('collects independent same-name model drafts into one multi-group save and omits unchanged providers', async () => {
  const api = actions()
  vi.mocked(api.vvcodeDirectory).mockResolvedValue(twoGroups())
  const { t } = mount(saved, api)
  await act(async () => {})
  await manage()
  fireEvent.click(within(group('standard')).getByRole('checkbox', { name: t('vvcodeEnableModel', { group: 'standard', model: 'model/a' }) }))
  fireEvent.click(within(group('auto')).getByRole('checkbox', { name: t('vvcodeEnableModel', { group: 'auto', model: 'model/c' }) }))
  fireEvent.click(screen.getByRole('button', { name: t('vvcodeSaveSelection') }))
  await act(async () => {})
  expect(api.saveVvcodeModels).toHaveBeenCalledExactlyOnceWith([
    { provider: groups[0]!.provider, models: [] }, { provider: groups[1]!.provider, models: ['model/a', 'model/c'] },
  ], expect.any(AbortSignal))
})

it.each([zh, en])('confirms only newly enabled unconnected groups on save and keeps cancelled confirmation drafts', async (dictionary) => {
  const api = actions()
  vi.mocked(api.vvcodeDirectory).mockResolvedValue({ ...directory, groups: [groups[0]!,
    { ...groups[1]!, models: [{ id: 'model/c', enabled: false }] },
    { ...groups[1]!, name: 'untouched', provider: 'vvcode/group/untouched', state: 'ready', models: [{ id: 'model/d', enabled: false }] },
  ] })
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  const { t } = mount(saved, api, dictionary)
  await act(async () => {})
  await manage(dictionary)
  fireEvent.click(within(group('auto')).getByRole('button', { expanded: false }))
  const added = within(group('auto')).getByRole('group', { name: 'model/c' })
  const checkbox = within(added).getByRole('checkbox')
  expect(checkbox).toHaveProperty('disabled', false)
  fireEvent.click(checkbox)
  fireEvent.click(within(group('standard')).getByRole('checkbox', { name: t('vvcodeEnableModel', { group: 'standard', model: 'model/b' }) }))
  expect(within(added).getByRole('button', { name: t('testModel') })).toHaveProperty('disabled', true)
  expect(within(added).getByRole('button', { name: t('modelSettings') })).toHaveProperty('disabled', true)
  expect(confirm).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: t('vvcodeSaveSelection') }))
  expect(confirm).toHaveBeenCalledExactlyOnceWith(t('vvcodeConfirmSave', { groups: 'auto' }))
  expect(api.saveVvcodeModels).not.toHaveBeenCalled()
  expect(checkbox).toHaveProperty('checked', true)
  confirm.mockClear().mockReturnValue(true)
  fireEvent.click(screen.getByRole('button', { name: t('vvcodeSaveSelection') }))
  await act(async () => {})
  expect(confirm).toHaveBeenCalledOnce()
  expect(api.saveVvcodeModels).toHaveBeenCalledExactlyOnceWith([
    { provider: groups[0]!.provider, models: ['model/a', 'model/b'] }, { provider: groups[1]!.provider, models: ['model/c'] },
  ], expect.any(AbortSignal))
})

it('does not confirm key preparation for pure removals without a saved connection', async () => {
  const api = actions()
  vi.mocked(api.vvcodeDirectory).mockResolvedValue({ ...directory, groups: [{ ...groups[0]!, hasConnection: false }] })
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  const { t } = mount(saved, api)
  await act(async () => {})
  await manage()
  fireEvent.click(screen.getByRole('checkbox', { name: t('vvcodeEnableModel', { group: 'standard', model: 'model/a' }) }))
  fireEvent.click(screen.getByRole('button', { name: t('vvcodeSaveSelection') }))
  await act(async () => {})
  expect(confirm).not.toHaveBeenCalled()
  expect(api.saveVvcodeModels).toHaveBeenCalledWith([{ provider: groups[0]!.provider, models: [] }], expect.any(AbortSignal))
})

it('shows a local catalog failure instead of no models and retries it through the unified refresh', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  const api = actions()
  vi.mocked(api.vvcodeDirectory).mockResolvedValue({ ...directory, groups: [groups[0]!, { ...groups[1]!, state: 'ready', catalogError: true }] })
  const { t } = mount(saved, api)
  await act(async () => {})
  await manage()
  fireEvent.click(within(group('auto')).getByRole('button', { expanded: false }))
  expect(screen.getByText(t('vvcodeGroupSyncFailed'))).toBeTruthy()
  expect(screen.queryByText(t('vvcodeNoModels'))).toBeNull()
  expect(within(group('standard')).queryByText(t('vvcodeGroupSyncFailed'))).toBeNull()
  const checkbox = within(group('standard')).getByRole('checkbox', { name: t('vvcodeEnableModel', { group: 'standard', model: 'model/b' }) })
  fireEvent.click(checkbox)
  vi.mocked(api.vvcodeDirectory).mockResolvedValue({ ...directory,
    groups: [groups[0]!, { ...groups[1]!, state: 'ready', models: [{ id: 'model/c', enabled: false }] }] })
  fireEvent.click(screen.getByRole('button', { name: t('vvcodeRefreshDirectory') }))
  await act(async () => {})
  expect(screen.queryByText(t('vvcodeGroupSyncFailed'))).toBeNull()
  expect(within(group('auto')).getByRole('checkbox')).toHaveProperty('disabled', false)
  expect(checkbox).toHaveProperty('checked', true)
  expect(confirm).not.toHaveBeenCalled()
  expect(api.saveVvcodeModels).not.toHaveBeenCalled()
})

it('keeps dirty selections through directory and model refreshes, with newly discovered models unchecked', async () => {
  const { api, t } = mount()
  await act(async () => {})
  await manage()
  const checkbox = screen.getByRole('checkbox', { name: t('vvcodeEnableModel', { group: 'standard', model: 'model/b' }) })
  fireEvent.click(checkbox)
  vi.mocked(api.vvcodeDirectory).mockResolvedValue({ ...directory, groups: [{ ...groups[0]!, models: [...groups[0]!.models, { id: 'new-model', enabled: false }] }, groups[1]!] })
  fireEvent.click(screen.getByRole('button', { name: t('vvcodeRefreshDirectory') }))
  await act(async () => {})
  expect(screen.getByRole('checkbox', { name: t('vvcodeEnableModel', { group: 'standard', model: 'model/b' }) })).toBe(checkbox)
  expect(checkbox).toHaveProperty('checked', true)
  expect(screen.getByRole('checkbox', { name: t('vvcodeEnableModel', { group: 'standard', model: 'new-model' }) })).toHaveProperty('checked', false)
  fireEvent.click(screen.getByRole('button', { name: t('vvcodeRefreshDirectory') }))
  await act(async () => {})
  expect(checkbox).toHaveProperty('checked', true)
  expect(api.saveVvcodeModels).not.toHaveBeenCalled()
})

it('does not submit draft models that disappeared from the refreshed directory', async () => {
  const { api, t } = mount()
  await act(async () => {})
  await manage()
  fireEvent.click(screen.getByRole('checkbox', { name: t('vvcodeEnableModel', { group: 'standard', model: 'model/b' }) }))
  vi.mocked(api.vvcodeDirectory).mockResolvedValue({ ...directory, groups: [{ ...groups[0]!, models: [groups[0]!.models[0]!] }] })
  fireEvent.click(screen.getByRole('button', { name: t('vvcodeRefreshDirectory') }))
  await act(async () => {})
  expect(screen.getByRole('button', { name: t('vvcodeSaveSelection') })).toHaveProperty('disabled', true)
})

it('keeps failed save drafts open for retry and does not close before directory confirmation', async () => {
  const { api, t } = mount()
  await act(async () => {})
  await manage()
  const checkbox = screen.getByRole('checkbox', { name: t('vvcodeEnableModel', { group: 'standard', model: 'model/b' }) })
  fireEvent.click(checkbox)
  vi.mocked(api.saveVvcodeModels).mockRejectedValueOnce(new Error('busy'))
  fireEvent.click(screen.getByRole('button', { name: t('vvcodeSaveSelection') }))
  await act(async () => {})
  expect(screen.getByText(t('vvcodeSelectionFailed'))).toBeTruthy()
  expect(checkbox).toHaveProperty('checked', true)
  vi.mocked(api.vvcodeDirectory).mockRejectedValueOnce(new Error('offline'))
  fireEvent.click(screen.getByRole('button', { name: t('vvcodeSaveSelection') }))
  await act(async () => {})
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(screen.getByText(t('vvcodeSelectionFailed'))).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: t('vvcodeSaveSelection') }))
  await act(async () => {})
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(api.saveVvcodeModels).toHaveBeenCalledTimes(3)
})

it('reads once for card and dialog open while reading blocks repeat clicks until the cycle settles', async () => {
  const api = actions()
  const pending = Promise.withResolvers<VvcodeDirectory>()
  vi.mocked(api.vvcodeDirectory).mockImplementationOnce(() => pending.promise)
  const { t } = mount(saved, api)
  await manage()
  expect(api.vvcodeDirectory).toHaveBeenCalledOnce()
  const refreshing = screen.getByRole('button', { name: t('loading') })
  expect(refreshing).toHaveProperty('disabled', true)
  expect(refreshing.getAttribute('aria-busy')).toBe('true')
  expect(within(screen.getByRole('dialog')).queryByRole('status')).toBeNull()
  await act(async () => { pending.resolve(directory) })
  expect(screen.getByRole('button', { name: t('vvcodeRefreshDirectory') })).toHaveProperty('disabled', false)
  fireEvent.click(screen.getByRole('button', { name: t('vvcodeRefreshDirectory') }))
  await act(async () => {})
  expect(api.vvcodeDirectory).toHaveBeenCalledTimes(2)
})

it('confirms a save with one fresh post-write directory read, the updated summary, and then closes', async () => {
  const { api, t, changed } = mount()
  await manage()
  fireEvent.click(screen.getByRole('checkbox', { name: t('vvcodeEnableModel', { group: 'standard', model: 'model/b' }) }))
  fireEvent.click(screen.getByRole('button', { name: t('vvcodeSaveSelection') }))
  await act(async () => {})
  expect(api.saveVvcodeModels).toHaveBeenCalledOnce()
  expect(api.vvcodeDirectory).toHaveBeenCalledTimes(2)
  expect(changed).toHaveBeenCalledOnce()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByText(t('vvcodeModelSummary', { models: 2, groups: 1 }))).toBeTruthy()
})

it('routes saved model settings through the mutation queue and confirms with one fresh read', async () => {
  const { api, t, changed } = mount()
  await act(async () => {})
  await manage()
  fireEvent.click(within(group('standard')).getAllByRole('button', { name: t('modelSettings') })[0]!)
  await act(async () => {})
  fireEvent.click(within(screen.getByRole('dialog', { name: t('modelSettings') })).getByRole('button', { name: t('saveModel') }))
  await act(async () => {})
  expect(api.saveModelOptions).toHaveBeenCalledExactlyOnceWith(groups[0]!.provider, 'model/a', {}, 1)
  expect(api.vvcodeDirectory).toHaveBeenCalledTimes(2)
  expect(changed).toHaveBeenCalledOnce()
  expect(screen.queryByRole('dialog', { name: t('modelSettings') })).toBeNull()
  expect(screen.getByRole('dialog', { name: t('vvcodeManage') })).toBeTruthy()
})

it('distinguishes unknown creation, unavailable access and unknown multiplier notices', async () => {
  const api = actions()
  vi.mocked(api.vvcodeDirectory).mockResolvedValue({ ...directory, groups: [
    { ...groups[0]!, name: 'blocked', provider: 'vvcode/group/blocked', state: 'creation-unknown', ratio: null,
      hasConnection: false, models: [{ id: 'model/k', enabled: false }] },
    { ...groups[1]!, name: 'off', provider: 'vvcode/group/off', state: 'unavailable', ratio: 2,
      hasConnection: false, models: [{ id: 'model/u', enabled: false }] },
  ] })
  const { t } = mount(saved, api)
  await act(async () => {})
  await manage()
  const blocked = group('blocked')
  expect(within(blocked).getByText(t('vvcodeCreationBlocked'))).toBeTruthy()
  fireEvent.click(within(blocked).getByRole('button', { expanded: false }))
  expect(within(blocked).getByText(t('vvcodeCreationUnknown'))).toBeTruthy()
  expect(within(blocked).getByRole('checkbox')).toHaveProperty('disabled', true)
  expect(within(blocked).getByText(t('vvcodeUnknownRatio'))).toBeTruthy()
  const off = group('off')
  expect(within(off).getByText(t('vvcodeAccessUnavailable'))).toBeTruthy()
  fireEvent.click(within(off).getByRole('button', { expanded: false }))
  expect(within(off).getByText(t('vvcodeGroupUnavailable'))).toBeTruthy()
  expect(within(off).getByText(t('vvcodeRatio', { ratio: 2 }))).toBeTruthy()
})

it('aborts an in-flight directory read on authorization change without reporting failure', async () => {
  const api = actions()
  vi.mocked(api.vvcodeDirectory).mockImplementationOnce(signal => new Promise<VvcodeDirectory>((_resolve, reject) => {
    signal.addEventListener('abort', () => { reject(new Error('read aborted')) })
  }))
  const t = makeTranslate(zh)
  const props = { row: saved, actions: api, test: vi.fn(), t, pending: false,
    connect: vi.fn(), disconnect: vi.fn(), modelsChanged: vi.fn(async () => {}) }
  const view = render(<VvcodeSubscription {...props} />)
  const signal = vi.mocked(api.vvcodeDirectory).mock.calls[0]![0]
  view.rerender(<VvcodeSubscription {...props} attempt={{ id: 'next', provider: 'vvcode', phase: 'connected' }} />)
  expect(signal.aborted).toBe(true)
  await act(async () => {})
  await manage()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(api.vvcodeDirectory).toHaveBeenCalledTimes(2)
})

it('does not let a superseded saved() closure abort or delay the new authorization read', async () => {
  const api = actions()
  const t = makeTranslate(zh)
  const changed = Promise.withResolvers<undefined>()
  const props = { row: saved, actions: api, test: vi.fn(), t, pending: false,
    connect: vi.fn(), disconnect: vi.fn(), modelsChanged: () => changed.promise }
  const view = render(<VvcodeSubscription {...props} />)
  await act(async () => {})
  await manage()
  fireEvent.click(screen.getByRole('checkbox', { name: t('vvcodeEnableModel', { group: 'standard', model: 'model/b' }) }))
  fireEvent.click(screen.getByRole('button', { name: t('vvcodeSaveSelection') }))
  await act(async () => {})
  const next = Promise.withResolvers<VvcodeDirectory>()
  vi.mocked(api.vvcodeDirectory).mockImplementationOnce(() => next.promise)
  view.rerender(<VvcodeSubscription {...props} attempt={{ id: 'next', provider: 'vvcode', phase: 'connected' }} />)
  await act(async () => {})
  const freshSignal = vi.mocked(api.vvcodeDirectory).mock.calls[1]![0]
  await act(async () => { changed.resolve(undefined) })
  await act(async () => {})
  expect(freshSignal.aborted).toBe(false)
  expect(api.vvcodeDirectory).toHaveBeenCalledTimes(2)
  await act(async () => { next.resolve(directory) })
})

it('blocks dismissal while an atomic save is pending and aborts it on account unmount', async () => {
  const { api, t, unmount } = mount()
  await act(async () => {})
  await manage()
  fireEvent.click(screen.getByRole('checkbox', { name: t('vvcodeEnableModel', { group: 'standard', model: 'model/b' }) }))
  const pending = Promise.withResolvers<undefined>()
  vi.mocked(api.saveVvcodeModels).mockImplementationOnce(() => pending.promise)
  fireEvent.click(screen.getByRole('button', { name: t('vvcodeSaveSelection') }))
  await act(async () => {})
  fireEvent.keyDown(document, { key: 'Escape' })
  fireEvent.click(screen.getByRole('button', { name: t('close') }))
  fireEvent.click(screen.getByRole('dialog').parentElement!.firstElementChild!)
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(screen.getByRole('button', { name: t('cancel') })).toHaveProperty('disabled', true)
  const signal = vi.mocked(api.saveVvcodeModels).mock.calls[0]![1]
  unmount()
  expect(signal.aborted).toBe(true)
  await act(async () => { pending.resolve(undefined) })
})

it('uses saved enablement for tests/settings and disables newly checked or dirty-unchecked routes', async () => {
  const { api, t, test } = mount()
  await act(async () => {})
  await manage()
  const added = screen.getByRole('group', { name: 'model/b' })
  fireEvent.click(within(added).getByRole('checkbox'))
  expect(within(added).getByRole('button', { name: t('testModel') })).toHaveProperty('disabled', true)
  expect(within(added).getByRole('button', { name: t('modelSettings') })).toHaveProperty('disabled', true)
  const kept = screen.getByRole('group', { name: 'model/a' })
  fireEvent.click(within(kept).getByRole('button', { name: t('testModel') }))
  await act(async () => {})
  expect(test).toHaveBeenCalledWith(groups[0]!.provider, 'model/a', expect.any(AbortSignal))
  fireEvent.click(within(kept).getByRole('checkbox'))
  expect(within(kept).getByRole('button', { name: t('modelSettings') })).toHaveProperty('disabled', true)
  expect(api.getModelOptions).not.toHaveBeenCalled()
})

it.each([zh, en])('filters groups/models without replacing search focus or the staged checkbox', async (dictionary) => {
  const { t } = mount(saved, actions(), dictionary)
  await act(async () => {})
  await manage(dictionary)
  const search = screen.getByRole('textbox', { name: t('vvcodeSearch') })
  const checkbox = screen.getByRole('checkbox', { name: t('vvcodeEnableModel', { group: 'standard', model: 'model/b' }) })
  fireEvent.click(checkbox)
  search.focus()
  fireEvent.change(search, { target: { value: 'model/b' } })
  expect(document.activeElement).toBe(search)
  expect(screen.getByRole('checkbox', { name: checkbox.getAttribute('aria-label')! })).toBe(checkbox)
  fireEvent.change(search, { target: { value: 'auto' } })
  expect(screen.getByRole('region', { name: t('vvcodeGroupRegion', { group: 'auto' }) })).toBeTruthy()
  fireEvent.change(search, { target: { value: 'not-found' } })
  expect(screen.getByText(t('noMatches'))).toBeTruthy()
  fireEvent.change(search, { target: { value: '' } })
  expect(checkbox).toHaveProperty('checked', true)
})

it.each([zh, en])('refreshes the whole directory with one request, no per-group sync and no key confirmation', async (dictionary) => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  const api = actions()
  vi.mocked(api.vvcodeDirectory).mockResolvedValue({ ...directory, groups: [...groups,
    { ...groups[1]!, name: 'third', provider: 'vvcode/group/third', state: 'ready', hasConnection: true, models: [{ id: 'model/x', enabled: false }] }] })
  const { t, changed } = mount(saved, api, dictionary)
  await act(async () => {})
  await manage(dictionary)
  expect(api.vvcodeDirectory).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: t('vvcodeRefreshDirectory') }))
  await act(async () => {})
  expect(api.vvcodeDirectory).toHaveBeenCalledTimes(2)
  fireEvent.click(within(group('third')).getByRole('button', { expanded: false }))
  expect(screen.getAllByRole('checkbox')).toHaveLength(3)
  expect(confirm).not.toHaveBeenCalled()
  expect(api.saveVvcodeModels).not.toHaveBeenCalled()
  expect(changed).not.toHaveBeenCalled()
})

it('shows one reading state on the refresh button while keeping model drafts editable', async () => {
  const { api, t } = mount()
  await act(async () => {})
  await manage()
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
  const pending = Promise.withResolvers<VvcodeDirectory>()
  vi.mocked(api.vvcodeDirectory).mockImplementationOnce(() => pending.promise)
  fireEvent.click(screen.getByRole('button', { name: t('vvcodeRefreshDirectory') }))
  await act(async () => {})
  expect(confirm).not.toHaveBeenCalled()
  const refreshing = screen.getByRole('button', { name: t('loading') })
  expect(refreshing).toHaveProperty('disabled', true)
  expect(refreshing.getAttribute('aria-busy')).toBe('true')
  const checkbox = screen.getByRole('checkbox', { name: t('vvcodeEnableModel', { group: 'standard', model: 'model/b' }) })
  expect(checkbox).toHaveProperty('disabled', false)
  fireEvent.click(checkbox)
  expect(screen.getByRole('checkbox', { name: t('vvcodeEnableModel', { group: 'standard', model: 'model/b' }) })).toBe(checkbox)
  expect(checkbox).toHaveProperty('checked', true)
  expect(screen.getByRole('button', { name: t('reconnect') })).toHaveProperty('disabled', false)
  await act(async () => { pending.resolve(directory) })
  expect(api.saveVvcodeModels).not.toHaveBeenCalled()
  const refresh = screen.getByRole('button', { name: t('vvcodeRefreshDirectory') })
  expect(refresh).toHaveProperty('disabled', false)
  expect(refresh.getAttribute('aria-busy')).toBe('false')
})

it.each([zh, en].flatMap(dictionary => [
  { dictionary, failure: new RemoteError('hemi/vvcode-request-failed', 'offline', { operation: 'model-candidates' }) },
  { dictionary, failure: new RemoteError('hemi/vvcode-failed', 'unavailable', { reason: 'operation-failed' }) },
]))('keeps a failed directory read visible, not zero, and retryable without any key creation confirmation', async ({ dictionary, failure }) => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  const api = actions()
  const { t, changed } = mount(saved, api, dictionary)
  await act(async () => {})
  expect(screen.getByText(t('vvcodeModelSummary', { models: 1, groups: 1 }))).toBeTruthy()
  await manage(dictionary)
  expect(api.vvcodeDirectory).toHaveBeenCalledOnce()
  vi.mocked(api.vvcodeDirectory).mockRejectedValueOnce(failure)
  fireEvent.click(screen.getByRole('button', { name: t('vvcodeRefreshDirectory') }))
  await act(async () => {})
  expect(screen.getByRole('alert')).toHaveProperty('textContent', t('vvcodeGroupsFailed'))
  expect(screen.getByText(t('vvcodeModelSummary', { models: 1, groups: 1 }))).toBeTruthy()
  const retry = screen.getByRole('button', { name: t('vvcodeRefreshDirectory') })
  expect(retry).toHaveProperty('disabled', false)
  const checkbox = screen.getByRole('checkbox', { name: t('vvcodeEnableModel', { group: 'standard', model: 'model/b' }) })
  fireEvent.click(retry)
  await act(async () => {})
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('checkbox', { name: t('vvcodeEnableModel', { group: 'standard', model: 'model/b' }) })).toBe(checkbox)
  expect(confirm).not.toHaveBeenCalled()
  expect(api.saveVvcodeModels).not.toHaveBeenCalled()
  expect(changed).not.toHaveBeenCalled()
})

it.each([zh, en])('shows a pending selection summary before the first directory result, not a read failure', async (dictionary) => {
  const api = actions()
  const pending = Promise.withResolvers<VvcodeDirectory>()
  vi.mocked(api.vvcodeDirectory).mockReturnValueOnce(pending.promise)
  const { t } = mount(saved, api, dictionary)
  expect(screen.getByText(t('vvcodeSummaryLoading'))).toBeTruthy()
  expect(screen.queryByText(t('vvcodeSummaryUnknown'))).toBeNull()
  expect(screen.queryByText(t('vvcodeModelSummary', { models: 0, groups: 0 }))).toBeNull()
  await act(async () => { pending.resolve({ state: 'ready', groups: [] }) })
  expect(screen.queryByText(t('vvcodeSummaryLoading'))).toBeNull()
  expect(screen.getByText(t('vvcodeModelSummary', { models: 0, groups: 0 }))).toBeTruthy()
})

it.each(['reject', 'unavailable', 'empty', 'sign-in-required'] as const)('distinguishes directory %s in the management dialog', async (state) => {
  const api = actions()
  if (state === 'reject') vi.mocked(api.vvcodeDirectory).mockRejectedValueOnce(new Error('offline'))
  else vi.mocked(api.vvcodeDirectory).mockResolvedValueOnce({ state: state === 'empty' ? 'ready' : state, groups: [] })
  const { t } = mount(saved, api)
  await act(async () => {})
  if (state === 'reject') {
    expect(screen.getByText(t('vvcodeSummaryUnknown'))).toBeTruthy()
    await manage()
    await act(async () => {})
    expect(screen.queryByRole('alert')).toBeNull()
  } else {
    await manage()
    expect(screen.getByText(t(state === 'empty' ? 'vvcodeNoGroups' : state === 'sign-in-required' ? 'vvcodeExpired' : 'vvcodeGroupsFailed'))).toBeTruthy()
  }
  fireEvent.click(screen.getByRole('button', { name: t('vvcodeRefreshDirectory') }))
  await act(async () => {})
  expect(screen.getAllByRole('checkbox')).toHaveLength(2)
})

it.each([zh, en])('allows expired users to stage only local removals and save them explicitly', async (dictionary) => {
  const row = { ...saved, vvcode: { ...saved.vvcode!, expired: true } }
  const api = actions(row)
  vi.mocked(api.vvcodeDirectory).mockResolvedValue({ ...directory, state: 'sign-in-required' })
  const { t } = mount(row, api, dictionary)
  await act(async () => {})
  await manage(dictionary)
  expect(screen.getByRole('checkbox', { name: t('vvcodeEnableModel', { group: 'standard', model: 'model/b' }) })).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('checkbox', { name: t('vvcodeEnableModel', { group: 'standard', model: 'model/a' }) }))
  expect(api.saveVvcodeModels).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: t('vvcodeSaveSelection') }))
  await act(async () => {})
  expect(api.saveVvcodeModels).toHaveBeenCalledWith([{ provider: groups[0]!.provider, models: [] }], expect.any(AbortSignal))
})

it('keeps usage mounted only once while opening, cancelling and reopening management', async () => {
  const { api, t } = mount()
  await act(async () => {})
  await manage()
  fireEvent.click(screen.getByRole('button', { name: t('cancel') }))
  await act(async () => {})
  await manage()
  expect(api.vvcodeUsage).toHaveBeenCalledOnce()
  expect(screen.getAllByText(t('vvcodeBalance'))).toHaveLength(1)
})

it('keeps account usage refresh independent of draft editing', async () => {
  const { api, t } = mount()
  await act(async () => {})
  const pending = Promise.withResolvers<VvcodeUsage>()
  vi.mocked(api.vvcodeUsage).mockImplementationOnce(() => pending.promise)
  fireEvent.click(screen.getByRole('button', { name: t('refreshBalance') }))
  await manage()
  expect(screen.getByRole('checkbox', { name: t('vvcodeEnableModel', { group: 'standard', model: 'model/b' }) })).toHaveProperty('disabled', false)
  await act(async () => { pending.resolve(usage) })
})

it('reuses sign-in, cancellation and local disconnect confirmation', async () => {
  const row: Subscription = { id: 'vvcode', name: 'VVCode', connected: false, models: [], quota: false }
  const api = actions(row)
  const t = makeTranslate(zh)
  render(<SubscriptionSection actions={api} test={vi.fn()} t={t} renderFactorySlot={() => null} />)
  fireEvent.click(await screen.findByRole('button', { name: t('connect') }))
  await act(async () => {})
  expect(api.start).toHaveBeenCalledWith('vvcode')
  fireEvent.click(screen.getByRole('button', { name: t('cancel') }))
  await act(async () => {})
  expect(api.cancel).toHaveBeenCalledWith('login')
  expect(api.vvcodeDirectory).not.toHaveBeenCalled()
})

it('reuses confirmed local disconnect and refreshes subscriptions', async () => {
  const api = actions()
  const t = makeTranslate(zh)
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  render(<SubscriptionSection actions={api} test={vi.fn()} t={t} renderFactorySlot={() => null} />)
  const disconnect = await screen.findByRole('button', { name: t('disconnect') })
  fireEvent.click(disconnect)
  expect(confirm).toHaveBeenCalledWith(t('vvcodeConfirmDisconnect'))
  await act(async () => {})
  confirm.mockReturnValue(true)
  fireEvent.click(disconnect)
  await act(async () => {})
  expect(api.disconnect).toHaveBeenCalledWith('vvcode')
  expect(api.subscriptions).toHaveBeenCalledTimes(2)
})

it('does not save a draft restored to its original checkbox state', async () => {
  const { api, t } = mount()
  await act(async () => {})
  await manage()
  const checkbox = screen.getByRole('checkbox', { name: t('vvcodeEnableModel', { group: 'standard', model: 'model/b' }) })
  fireEvent.click(checkbox)
  fireEvent.click(checkbox)
  expect(screen.getByRole('button', { name: t('vvcodeSaveSelection') })).toHaveProperty('disabled', true)
  expect(api.saveVvcodeModels).not.toHaveBeenCalled()
})

it('keeps identical model tests and nested settings bound to their own group provider', async () => {
  const api = actions()
  vi.mocked(api.vvcodeDirectory).mockResolvedValue(twoGroups())
  const { t, test } = mount(saved, api)
  await act(async () => {})
  await manage()
  fireEvent.click(within(group('auto')).getAllByRole('button', { name: t('testModel') })[0]!)
  await act(async () => {})
  expect(test).toHaveBeenCalledWith(groups[1]!.provider, 'model/a', expect.any(AbortSignal))
  fireEvent.click(within(group('auto')).getAllByRole('button', { name: t('modelSettings') })[0]!)
  await act(async () => {})
  expect(api.getModelOptions).toHaveBeenCalledWith(groups[1]!.provider, 'model/a')
  fireEvent.click(within(screen.getByRole('dialog', { name: t('modelSettings') })).getByRole('button', { name: t('cancel') }))
  await act(async () => {})
  expect(screen.getByRole('dialog', { name: t('vvcodeManage') })).toBeTruthy()
})

it('aborts the directory read on unmount and reads a fresh cycle on remount', async () => {
  const api = actions()
  const read = Promise.withResolvers<VvcodeDirectory>()
  vi.mocked(api.vvcodeDirectory).mockImplementationOnce(() => read.promise)
  const first = mount(saved, api)
  const signal = vi.mocked(api.vvcodeDirectory).mock.calls[0]![0]
  first.unmount()
  expect(signal.aborted).toBe(true)
  await act(async () => { read.resolve(directory) })
  const second = mount(saved, api)
  await act(async () => {})
  expect(api.vvcodeDirectory).toHaveBeenCalledTimes(2)
  expect(second.changed).not.toHaveBeenCalled()
  await manage()
  expect(api.vvcodeDirectory).toHaveBeenCalledTimes(2)
})

it('discards the open editing draft when the authorization epoch changes', async () => {
  const api = actions()
  const t = makeTranslate(zh)
  const props = { row: saved, actions: api, test: vi.fn(), t, pending: false,
    connect: vi.fn(), disconnect: vi.fn(), modelsChanged: vi.fn(async () => {}) }
  const view = render(<VvcodeSubscription {...props} />)
  await act(async () => {})
  await manage()
  fireEvent.click(screen.getByRole('checkbox', { name: t('vvcodeEnableModel', { group: 'standard', model: 'model/b' }) }))
  view.rerender(<VvcodeSubscription {...props} pending attempt={{ id: 'new-authorization', provider: 'vvcode', phase: 'pending' }} />)
  expect(screen.queryByRole('dialog')).toBeNull()
  view.rerender(<VvcodeSubscription {...props} attempt={{ id: 'new-authorization', provider: 'vvcode', phase: 'connected' }} />)
  await act(async () => {})
  await manage()
  expect(screen.getByRole('checkbox', { name: t('vvcodeEnableModel', { group: 'standard', model: 'model/b' }) })).toHaveProperty('checked', false)
  expect(api.saveVvcodeModels).not.toHaveBeenCalled()
})

const usage: VvcodeUsage = {
  unit: { kind: 'currency', symbol: '¥' }, balance: { state: 'ready', remaining: 12.34 },
  subscriptions: { state: 'ready', items: [
    { id: 7, total: 100, used: 20, remaining: 80, expiresAt: 1900000000000, resetAt: 1890000000000 },
    { id: 9, total: 25, used: 5, remaining: 20, expiresAt: 1950000000000, resetAt: null },
  ] },
}

it.each([zh, en])('shows the wallet and each subscription separately with expiry, using the existing refresh control', async (dictionary) => {
  const api = actions()
  vi.mocked(api.vvcodeUsage).mockResolvedValue(usage)
  const { t } = mount(saved, api, dictionary)
  await act(async () => {})
  expect(screen.getByText('¥12.34')).toBeTruthy()
  for (const item of usage.subscriptions.state === 'ready' ? usage.subscriptions.items : []) {
    expect(screen.getByText(t('vvcodeSubscription', { id: item.id }))).toBeTruthy()
    expect(screen.getByText(t('vvcodeSubscriptionQuota', { remaining: `¥${item.remaining}`, total: `¥${item.total}` }))).toBeTruthy()
    expect(screen.getByText(t('vvcodeExpires', { at: new Date(item.expiresAt).toLocaleString() }))).toBeTruthy()
  }
  expect(screen.queryByText('¥112.34')).toBeNull()
  expect(screen.getAllByRole('button', { name: t('refreshBalance') })).toHaveLength(1)
  expect(api.vvcodeUsage).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal))
})

it.each([0.001, 0.000002])('keeps a fractional currency balance of %s visible instead of rounding it to zero', async (remaining) => {
  const api = actions()
  vi.mocked(api.vvcodeUsage).mockResolvedValue({ ...usage, unit: { kind: 'currency', symbol: '$' }, balance: { state: 'ready', remaining } })
  mount(saved, api)
  await act(async () => {})
  expect(screen.getByText(`$${remaining}`)).toBeTruthy()
  expect(screen.queryByText('$0')).toBeNull()
})

it.each([zh, en])('distinguishes zero balance, no active subscriptions and unlimited subscription amounts', async (dictionary) => {
  const api = actions()
  vi.mocked(api.vvcodeUsage).mockResolvedValueOnce({ ...usage, balance: { state: 'ready', remaining: 0 },
    subscriptions: { state: 'ready', items: [] } })
    .mockResolvedValueOnce({ ...usage, unit: { kind: 'tokens', symbol: 'TOKENS' }, subscriptions: { state: 'ready', items: [
      { id: 7, total: null, used: 50, remaining: null, expiresAt: 1900000000000, resetAt: null },
    ] } })
  const { t } = mount(saved, api, dictionary)
  await act(async () => {})
  expect(screen.getByText('¥0')).toBeTruthy()
  expect(screen.getByText(t('vvcodeNoSubscriptions'))).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: t('refreshBalance') }))
  await act(async () => {})
  expect(screen.getByText(t('vvcodeSubscriptionQuota', { remaining: t('vvcodeUnlimited'), total: t('vvcodeUnlimited') }))).toBeTruthy()
  expect(screen.getByText('12 TOKENS')).toBeTruthy()
  expect(screen.queryByText(t('vvcodeNoSubscriptions'))).toBeNull()
})

it.each([zh, en].flatMap(dictionary => [
  { dictionary, state: 'unavailable' as const, key: 'vvcodeSubscriptionsUnavailable' as const },
  { dictionary, state: 'reauthorize' as const, key: 'vvcodeUsageReauthorize' as const },
]))('keeps the wallet visible when subscriptions are $state', async ({ dictionary, state, key }) => {
  const api = actions()
  vi.mocked(api.vvcodeUsage).mockResolvedValue({ ...usage, subscriptions: { state } })
  const { t } = mount(saved, api, dictionary)
  await act(async () => {})
  expect(screen.getByText('¥12.34')).toBeTruthy()
  expect(screen.getByText(t(key))).toBeTruthy()
  expect(screen.queryByText(t('vvcodeNoSubscriptions'))).toBeNull()
  expect(screen.queryByText(t('vvcodeSubscription', { id: 7 }))).toBeNull()
  expect(screen.getByRole('button', { name: t('reconnect') })).toHaveProperty('disabled', false)
})

it('never displays unavailable wallet or subscription data as zero on first load', async () => {
  const api = actions()
  vi.mocked(api.vvcodeUsage).mockResolvedValue({ ...usage, balance: { state: 'unavailable' }, subscriptions: { state: 'unavailable' } })
  const { t } = mount(saved, api)
  await act(async () => {})
  expect(screen.getByText(t('vvcodeBalanceUnavailable'))).toBeTruthy()
  expect(screen.getByText(t('vvcodeSubscriptionsUnavailable'))).toBeTruthy()
  expect(screen.queryByText('¥0')).toBeNull()
  expect(screen.queryByText(t('vvcodeNoSubscriptions'))).toBeNull()
})

it.each(['reject', 'partial'] as const)('retains prior values and shows a visible failure on $0 refresh failure, then recovers', async (failure) => {
  const api = actions()
  vi.mocked(api.vvcodeUsage).mockResolvedValue(usage)
  const { t } = mount(saved, api)
  await act(async () => {})
  const deferred = Promise.withResolvers<VvcodeUsage>()
  vi.mocked(api.vvcodeUsage).mockImplementationOnce(() => deferred.promise)
  const refresh = screen.getByRole('button', { name: t('refreshBalance') })
  fireEvent.click(refresh)
  expect(refresh).toHaveProperty('disabled', true)
  expect(screen.getByText('¥12.34')).toBeTruthy()
  await act(async () => {
    if (failure === 'reject') deferred.reject(new RemoteError('hemi/vvcode-request-failed', 'offline', { operation: 'self' }))
    else deferred.resolve({ ...usage, balance: { state: 'unavailable' }, subscriptions: { state: 'unavailable' } })
  })
  expect(screen.getByText('¥12.34')).toBeTruthy()
  expect(screen.getByText(t('vvcodeSubscriptionQuota', { remaining: '¥80', total: '¥100' }))).toBeTruthy()
  expect(screen.getByText(t(failure === 'reject' ? 'vvcodeUsageFailed' : 'vvcodeSubscriptionsUnavailable')).getAttribute('role')).toBe('alert')
  expect(refresh).toHaveProperty('disabled', false)
  fireEvent.click(refresh)
  await act(async () => {})
  expect(screen.queryByRole('alert')).toBeNull()
})

it('aborts usage reads on reauthorization and expiry, hides old values and refreshes even for the same account expiry', async () => {
  const api = actions()
  vi.mocked(api.vvcodeUsage).mockResolvedValue(usage)
  const t = makeTranslate(zh)
  const props = { row: saved, actions: api, test: vi.fn(), t, pending: false,
    connect: vi.fn(), disconnect: vi.fn(), modelsChanged: vi.fn(async () => {}) }
  const view = render(<VvcodeSubscription {...props} />)
  await act(async () => {})
  const deferred = Promise.withResolvers<VvcodeUsage>()
  vi.mocked(api.vvcodeUsage).mockImplementationOnce(() => deferred.promise)
  fireEvent.click(screen.getByRole('button', { name: t('refreshBalance') }))
  const signal = vi.mocked(api.vvcodeUsage).mock.calls[1]![0]
  view.rerender(<VvcodeSubscription {...props} pending attempt={{ id: 'reauth', provider: 'vvcode', phase: 'pending' }} />)
  expect(signal.aborted).toBe(true)
  expect(screen.queryByText('¥12.34')).toBeNull()
  expect(api.vvcodeUsage).toHaveBeenCalledTimes(2)
  await act(async () => { deferred.resolve(usage) })
  expect(screen.queryByText('¥12.34')).toBeNull()
  const next = Promise.withResolvers<VvcodeUsage>()
  vi.mocked(api.vvcodeUsage).mockImplementationOnce(() => next.promise)
  view.rerender(<VvcodeSubscription {...props} attempt={{ id: 'reauth', provider: 'vvcode', phase: 'connected' }} />)
  expect(api.vvcodeUsage).toHaveBeenCalledTimes(3)
  expect(screen.queryByText('¥12.34')).toBeNull()
  const nextSignal = vi.mocked(api.vvcodeUsage).mock.calls[2]![0]
  view.rerender(<VvcodeSubscription {...props} row={{ ...saved, vvcode: { ...saved.vvcode!, expired: true } }} />)
  expect(nextSignal.aborted).toBe(true)
  await act(async () => { next.resolve(usage) })
  expect(screen.queryByText('¥12.34')).toBeNull()
  expect(screen.queryByRole('button', { name: t('refreshBalance') })).toBeNull()
  expect(api.vvcodeUsage).toHaveBeenCalledTimes(3)
})

it('discards old balances after authentication expires and stops requests until authorization changes', async () => {
  const api = actions()
  vi.mocked(api.vvcodeUsage).mockResolvedValueOnce(usage)
    .mockRejectedValueOnce(new RemoteError('hemi/vvcode-management-auth-expired', 'expired', {}))
  const { t, changed } = mount(saved, api)
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: t('refreshBalance') }))
  await act(async () => {})
  expect(screen.queryByText('¥12.34')).toBeNull()
  expect(screen.getByText(t('vvcodeExpired'))).toBeTruthy()
  expect(screen.queryByRole('button', { name: t('refreshBalance') })).toBeNull()
  expect(changed).toHaveBeenCalledOnce()
  expect(api.vvcodeUsage).toHaveBeenCalledTimes(2)
})

it('aborts usage on disconnect and unmount, and does not restore a prior account balance on a new login', async () => {
  const api = actions()
  vi.mocked(api.vvcodeUsage).mockResolvedValueOnce(usage)
  const t = makeTranslate(zh)
  const props = { row: saved, actions: api, test: vi.fn(), t, pending: false,
    connect: vi.fn(), disconnect: vi.fn(), modelsChanged: vi.fn(async () => {}) }
  const view = render(<VvcodeSubscription {...props} />)
  await act(async () => {})
  view.rerender(<VvcodeSubscription {...props} row={{ ...saved, connected: false }} />)
  expect(screen.queryByText('¥12.34')).toBeNull()
  const deferred = Promise.withResolvers<VvcodeUsage>()
  vi.mocked(api.vvcodeUsage).mockImplementationOnce(() => deferred.promise)
  view.rerender(<VvcodeSubscription {...props} />)
  expect(screen.queryByText('¥12.34')).toBeNull()
  const signal = vi.mocked(api.vvcodeUsage).mock.calls[1]![0]
  view.unmount()
  expect(signal.aborted).toBe(true)
  await act(async () => { deferred.resolve(usage) })
})

it.each([{ kind: 'currency' as const, symbol: '$' }, { kind: 'tokens' as const, symbol: 'TOKENS' }])(
  'does not relabel cached amounts with changed site units ($kind/$symbol)', async (unit) => {
    const api = actions()
    vi.mocked(api.vvcodeUsage).mockResolvedValueOnce(usage)
      .mockResolvedValueOnce({ unit, balance: { state: 'unavailable' }, subscriptions: { state: 'unavailable' } })
    const { t } = mount(saved, api)
    await act(async () => {})
    expect(screen.getByText('¥12.34')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('refreshBalance') }))
    await act(async () => {})
    expect(screen.queryByText('¥12.34')).toBeNull()
    expect(screen.queryByText('$12.34')).toBeNull()
    expect(screen.queryByText('12 TOKENS')).toBeNull()
    expect(screen.queryByText(t('vvcodeSubscription', { id: 7 }))).toBeNull()
    expect(screen.getByText(t('vvcodeBalanceUnavailable'))).toBeTruthy()
    expect(screen.getByText(t('vvcodeSubscriptionsUnavailable'))).toBeTruthy()
  },
)

it.each(['reject', 'partial'] as const)('does not present expired cached subscriptions as active or confirmed empty after $0 failure', async (failure) => {
  vi.useFakeTimers()
  vi.setSystemTime(1899999999000)
  const api = actions()
  vi.mocked(api.vvcodeUsage).mockResolvedValueOnce({ ...usage, subscriptions: { state: 'ready', items: [
    { id: 7, total: 100, used: 20, remaining: 80, expiresAt: 1900000000000, resetAt: null },
  ] } })
  if (failure === 'reject') vi.mocked(api.vvcodeUsage).mockRejectedValueOnce(new Error('offline'))
  else vi.mocked(api.vvcodeUsage).mockResolvedValueOnce({ ...usage, subscriptions: { state: 'unavailable' } })
  const { t } = mount(saved, api)
  await act(async () => {})
  expect(screen.getByText(t('vvcodeSubscription', { id: 7 }))).toBeTruthy()
  vi.setSystemTime(1900000000000)
  fireEvent.click(screen.getByRole('button', { name: t('refreshBalance') }))
  await act(async () => {})
  expect(screen.queryByText(t('vvcodeSubscription', { id: 7 }))).toBeNull()
  expect(screen.queryByText(t('vvcodeNoSubscriptions'))).toBeNull()
  expect(screen.getByText(t('vvcodeSubscriptionsUnavailable'))).toBeTruthy()
  expect(screen.getByText('¥12.34')).toBeTruthy()
})
