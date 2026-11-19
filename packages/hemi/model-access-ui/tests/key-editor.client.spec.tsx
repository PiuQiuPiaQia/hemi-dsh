// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { KeyDirectory, KeyProfile, KeyProfileInput } from '@deepseek-ai/dsh-hemi-model-access/types'
import { KeyProfiles } from '../src/client/KeyProfiles.tsx'
import { en, zh } from '../src/client/copy.ts'
import type { ModelAccessActions } from '../src/client/types.ts'

const t = makeTranslate(zh)

const emptyDirectory: KeyDirectory = { revision: 1, profiles: [] }

const savedProfile: KeyProfile = { id: 'hemi-key-1', name: 'Saved API', baseUrl: 'http://127.0.0.1:9/v1',
  api: 'openai-completions', models: ['kept-model'], hasKey: true, modelOptions: {} }

function actions(discover: (input: KeyProfileInput, signal: AbortSignal) => Promise<string[]>,
  directory: KeyDirectory = emptyDirectory): ModelAccessActions {
  return {
    reportModelFailure: vi.fn(),
    keyDirectory: vi.fn(async () => directory),
    getModelOptions: vi.fn(async () => ({ revision: 1, options: {}, effective: { name: 'm', input: ['text'] as const } })),
    getModelDefaults: vi.fn(async (_api: string, id: string) => ({ name: id, input: ['text'] as const })),
    saveModelOptions: vi.fn(async () => {}), discoverKeyModels: vi.fn(discover),
    saveKeyProfile: vi.fn(async () => {}), removeKeyProfile: vi.fn(async () => {}),
    subscriptionCandidates: vi.fn(async () => []), changeSubscriptionModel: vi.fn(async () => {}),
    subscriptionModels: vi.fn(async () => []),
    vvcodeUsage: vi.fn(async () => ({ unit: { kind: 'currency' as const, symbol: '$' }, balance: { state: 'unavailable' as const }, subscriptions: { state: 'unavailable' as const } })),
    vvcodeDirectory: vi.fn(async () => ({ state: 'ready' as const, groups: [] })),
    saveVvcodeModels: vi.fn(async () => {}),
    subscriptions: vi.fn(async () => []), state: vi.fn(async () => null),
    start: vi.fn(async (id: string) => ({ id, provider: id, phase: 'pending' as const })),
    answer: vi.fn(async () => {}), cancel: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
    quota: vi.fn(async () => []), listNewApi: vi.fn(async () => []), importNewApi: vi.fn(async () => 0),
  }
}

function renderProfiles(discover: (input: KeyProfileInput, signal: AbortSignal) => Promise<string[]>,
  directory: KeyDirectory = emptyDirectory): void {
  render(<KeyProfiles actions={actions(discover, directory)} test={vi.fn(async () => true)} t={t} />)
}

/** Open the API connection editor and fill a draft with the endpoint and key already present. */
async function openEditorWithDraft(
  discover: (input: KeyProfileInput, signal: AbortSignal) => Promise<string[]>,
  directory: KeyDirectory = emptyDirectory,
): Promise<HTMLElement> {
  renderProfiles(discover, directory)
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: t('addKey') }))
  const editor = screen.getByRole('region', { name: t('keyEditor') })
  fireEvent.change(within(editor).getByLabelText(t('providerName')), { target: { value: 'Local API' } })
  fireEvent.change(within(editor).getByLabelText(t('apiEndpoint')), { target: { value: 'http://127.0.0.1:9/v1' } })
  return editor
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
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it.each([zh, en])('reads the provider list once the endpoint and key are present and lists candidates unchecked', async (dictionary) => {
  const translate = makeTranslate(dictionary)
  vi.useFakeTimers()
  const read = Promise.withResolvers<string[]>()
  const discover = vi.fn((_input: KeyProfileInput, _signal: AbortSignal) => read.promise)
  render(<KeyProfiles actions={actions(discover)} test={vi.fn(async () => true)} t={translate} />)
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: translate('addKey') }))
  const editor = screen.getByRole('region', { name: translate('keyEditor') })
  fireEvent.change(within(editor).getByLabelText(translate('providerName')), { target: { value: 'Local API' } })
  fireEvent.change(within(editor).getByLabelText(translate('apiEndpoint')), { target: { value: 'http://127.0.0.1:9/v1' } })
  await act(async () => { vi.advanceTimersByTime(1200) })
  expect(discover).not.toHaveBeenCalled()
  fireEvent.change(within(editor).getByLabelText(translate('apiKey')), { target: { value: 'test-key' } })
  await act(async () => { vi.advanceTimersByTime(600) })
  expect(within(editor).getByRole('status').textContent).toBe(translate('loading'))
  expect(discover).toHaveBeenCalledOnce()
  expect(discover).toHaveBeenCalledWith(expect.objectContaining({
    baseUrl: 'http://127.0.0.1:9/v1', api: 'openai-completions', apiKey: 'test-key',
  }), expect.any(AbortSignal))
  await act(async () => { read.resolve(['m/a', 'm/b', 'm/a']) })
  const first = within(editor).getByRole('checkbox', { name: 'm/a' }) as HTMLInputElement
  expect(first).toHaveProperty('checked', false)
  expect(within(editor).getByRole('checkbox', { name: 'm/b' })).toBeTruthy()
  expect(within(editor).getByRole('button', { name: translate('saveConnection') })).toHaveProperty('disabled', true)
  fireEvent.click(first)
  expect(within(editor).getByRole('button', { name: translate('saveConnection') })).toHaveProperty('disabled', false)
})

it('reads on open through the saved credential and keeps the selection drafts untouched', async () => {
  vi.useFakeTimers()
  const read = Promise.withResolvers<string[]>()
  const discover = vi.fn((_input: KeyProfileInput, _signal: AbortSignal) => read.promise)
  renderProfiles(discover, { revision: 1, profiles: [savedProfile] })
  await act(async () => {})
  const card = screen.getByRole('region', { name: 'Saved API' })
  fireEvent.click(within(card).getByRole('button', { name: t('editConnection') }))
  const editor = screen.getByRole('region', { name: t('keyEditor') })
  await act(async () => { vi.advanceTimersByTime(600) })
  expect(discover).toHaveBeenCalledOnce()
  const input = discover.mock.calls[0]![0]
  expect(input).toStrictEqual(expect.objectContaining({ id: 'hemi-key-1', baseUrl: 'http://127.0.0.1:9/v1' }))
  expect(input).not.toHaveProperty('apiKey')
  await act(async () => { read.resolve(['remote-model']) })
  expect(within(editor).getByRole('checkbox', { name: 'kept-model' })).toHaveProperty('checked', true)
  expect(within(editor).getByRole('checkbox', { name: 'remote-model' })).toHaveProperty('checked', false)
})

it('aborts a superseded read when the key changes and reads the new draft once', async () => {
  vi.useFakeTimers()
  const read = Promise.withResolvers<string[]>()
  const discover = vi.fn((_input: KeyProfileInput, _signal: AbortSignal) => read.promise)
  const editor = await openEditorWithDraft(discover)
  fireEvent.change(within(editor).getByLabelText(t('apiKey')), { target: { value: 'first-key' } })
  await act(async () => { vi.advanceTimersByTime(600) })
  expect(discover).toHaveBeenCalledOnce()
  const firstSignal = discover.mock.calls[0]![1]
  fireEvent.change(within(editor).getByLabelText(t('apiKey')), { target: { value: 'second-key' } })
  expect(firstSignal.aborted).toBe(true)
  await act(async () => { vi.advanceTimersByTime(1200) })
  expect(discover).toHaveBeenCalledTimes(2)
  expect(discover.mock.calls[1]![0]).toMatchObject({ apiKey: 'second-key' })
  await act(async () => { read.resolve(['m/a']) })
  expect(within(editor).getByRole('checkbox', { name: 'm/a' })).toBeTruthy()
})

it('selecting a candidate does not re-read or abort the pending read', async () => {
  vi.useFakeTimers()
  const read = Promise.withResolvers<string[]>()
  const discover = vi.fn((_input: KeyProfileInput, _signal: AbortSignal) => read.promise)
  renderProfiles(discover, { revision: 1, profiles: [savedProfile] })
  await act(async () => {})
  fireEvent.click(within(screen.getByRole('region', { name: 'Saved API' }))
    .getByRole('button', { name: t('editConnection') }))
  await act(async () => { vi.advanceTimersByTime(600) })
  const pendingSignal = discover.mock.calls[0]![1]
  fireEvent.click(within(screen.getByRole('region', { name: t('keyEditor') })).getByRole('checkbox', { name: 'kept-model' }))
  await act(async () => { vi.advanceTimersByTime(1200) })
  expect(discover).toHaveBeenCalledOnce()
  expect(pendingSignal.aborted).toBe(false)
  await act(async () => { read.resolve([]) })
  expect(within(screen.getByRole('region', { name: t('keyEditor') })).queryByRole('status')).toBeNull()
})

it('reports a failed read with retry and recovers through the retry action', async () => {
  vi.useFakeTimers()
  const first = Promise.withResolvers<string[]>()
  const second = Promise.withResolvers<string[]>()
  const reads = [first.promise, second.promise]
  const discover = vi.fn((_input: KeyProfileInput, _signal: AbortSignal) => reads.shift()!)
  const editor = await openEditorWithDraft(discover)
  fireEvent.change(within(editor).getByLabelText(t('apiKey')), { target: { value: 'test-key' } })
  await act(async () => { vi.advanceTimersByTime(600) })
  await act(async () => { first.reject(new Error('offline')) })
  const alert = within(editor).getByRole('alert')
  expect(alert.textContent).toContain(t('fetchModelsFailed'))
  fireEvent.click(within(alert).getByRole('button', { name: t('retryImport') }))
  await act(async () => { vi.advanceTimersByTime(600) })
  expect(discover).toHaveBeenCalledTimes(2)
  expect(within(editor).getByRole('status').textContent).toBe(t('loading'))
  await act(async () => { second.resolve(['m/a']) })
  expect(within(editor).queryByRole('alert')).toBeNull()
  expect(within(editor).getByRole('checkbox', { name: 'm/a' })).toBeTruthy()
})

it('stays inert while the endpoint is partially typed and reads once the address completes', async () => {
  vi.useFakeTimers()
  const discover = vi.fn(async (_input: KeyProfileInput, _signal: AbortSignal) => ['m/a'])
  const editor = await openEditorWithDraft(discover)
  fireEvent.change(within(editor).getByLabelText(t('apiKey')), { target: { value: 'test-key' } })
  fireEvent.change(within(editor).getByLabelText(t('apiEndpoint')), { target: { value: 'http://' } })
  await act(async () => { vi.advanceTimersByTime(1200) })
  expect(discover).not.toHaveBeenCalled()
  fireEvent.change(within(editor).getByLabelText(t('apiEndpoint')), { target: { value: 'http://127.0.0.1:9/v1' } })
  await act(async () => { vi.advanceTimersByTime(600) })
  expect(discover).toHaveBeenCalledOnce()
})

it('fills the Magpie local gateway preset into the editor draft and reads its models', async () => {
  vi.useFakeTimers()
  const discover = vi.fn(async (_input: KeyProfileInput, _signal: AbortSignal) => [])
  renderProfiles(discover)
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: t('addKey') }))
  const editor = screen.getByRole('region', { name: t('keyEditor') })
  fireEvent.change(within(editor).getByLabelText(t('providerPreset')), { target: { value: 'magpie' } })
  expect((within(editor).getByLabelText(t('providerName')) as HTMLInputElement).value).toBe('Magpie')
  expect((within(editor).getByLabelText(t('apiEndpoint')) as HTMLInputElement).value).toBe('http://127.0.0.1:3425/v1')
  expect((within(editor).getByLabelText(t('apiKey')) as HTMLInputElement).value).toBe('magpie')
  await act(async () => { vi.advanceTimersByTime(600) })
  expect(discover).toHaveBeenCalledOnce()
})
