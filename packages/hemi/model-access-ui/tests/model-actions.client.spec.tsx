// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ModelConnectionTest } from '../src/client/ModelConnectionTest.tsx'
import { KeyProfiles } from '../src/client/KeyProfiles.tsx'
import { en, zh } from '../src/client/copy.ts'
import type { ModelAccessActions, ModelTest } from '../src/client/types.ts'

const t = makeTranslate(zh)
const provider = 'connection/a'
const model = 'model/a'
const profile = { id: provider, name: 'Connection A', baseUrl: 'https://example.com/v1', api: 'openai-completions', models: [model], hasKey: true, modelOptions: {} }

function actions(): ModelAccessActions {
  return {
    keyDirectory: vi.fn(async () => ({ revision: 1, profiles: [profile] })),
    getModelOptions: vi.fn(async () => ({ revision: 1, options: {} })),
    saveModelOptions: vi.fn(async () => {}), discoverKeyModels: vi.fn(async () => []),
    saveKeyProfile: vi.fn(async () => {}), removeKeyProfile: vi.fn(async () => {}),
    subscriptionCandidates: vi.fn(async () => []), changeSubscriptionModel: vi.fn(async () => {}),
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
  let resolve!: (value: { revision: number; options: {} }) => void
  vi.mocked(api.getModelOptions).mockImplementation(() => new Promise((done) => { resolve = done }))
  render(<ModelConnectionTest provider={provider} model={model} actions={api} test={vi.fn()} t={t} />)
  const settings = screen.getByRole('button', { name: t('modelSettings') }) as HTMLButtonElement
  fireEvent.click(settings)
  expect(settings.disabled).toBe(true)
  expect(settings.getAttribute('aria-busy')).toBe('true')
  expect(api.getModelOptions).toHaveBeenCalledWith(provider, model)
  await act(async () => { resolve({ revision: 1, options: {} }) })
  expect(await screen.findByRole('dialog', { name: t('modelSettings') })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: t('cancel') }))
  expect(api.saveModelOptions).not.toHaveBeenCalled()
})

it.each([true, false])('keeps testing status visible and disables all row actions until the test settles (%s)', async (toolCall) => {
  let resolve!: (value: boolean) => void
  const test: ModelTest = vi.fn(() => new Promise<boolean>((done) => { resolve = done }))
  render(<ModelConnectionTest provider={provider} model={model} actions={actions()} test={test} remove={vi.fn()} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: t('testModel') }))
  expect(screen.getByRole('status').textContent).toBe(t('testingModel'))
  expect(screen.getByRole('button', { name: t('testingModel') }).getAttribute('aria-busy')).toBe('true')
  for (const button of screen.getAllByRole('button')) expect((button as HTMLButtonElement).disabled).toBe(true)
  expect(test).toHaveBeenCalledWith(provider, model, expect.any(AbortSignal))
  await act(async () => { resolve(toolCall) })
  expect(screen.getByRole('status').textContent).toBe(t(toolCall ? 'modelToolOk' : 'modelResponseOk'))
  for (const button of screen.getAllByRole('button')) expect((button as HTMLButtonElement).disabled).toBe(false)
})

it('reports test failure in the row and aborts an active test on unmount', async () => {
  const test = vi.fn<ModelTest>().mockRejectedValueOnce(new Error('offline'))
  const view = render(<ModelConnectionTest provider={provider} model={model} actions={actions()} test={test} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: t('testModel') }))
  expect(await screen.findByRole('status')).toBeTruthy()
  await act(async () => {})
  expect(screen.getByRole('status').textContent).toBe(t('modelTestFailed'))
  test.mockImplementation(() => new Promise(() => {}))
  fireEvent.click(screen.getByRole('button', { name: t('testModel') }))
  const signal = test.mock.calls[1]![2]
  view.unmount()
  expect(signal.aborted).toBe(true)
})

it('requires confirmation to remove a model and disables the actions during removal', async () => {
  let reject!: (error: Error) => void
  const remove = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail }))
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  render(<ModelConnectionTest provider={provider} model={model} actions={actions()} test={vi.fn()} remove={remove} t={t} />)
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
  expect(screen.getByRole('status').textContent).toBe(t('modelTestFailed'))
  expect((button as HTMLButtonElement).disabled).toBe(false)
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
  expect(screen.getByRole('dialog', { name: t('modelSettings') })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: t('cancel') }))
  fireEvent.click(within(row).getByRole('checkbox'))
  expect(settings.disabled).toBe(true)
  expect(api.saveKeyProfile).not.toHaveBeenCalled()
})
