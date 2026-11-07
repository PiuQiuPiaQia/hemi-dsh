// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ModelPicker } from '../src/client/ModelPicker.tsx'
import { en, zh } from '../src/client/copy.ts'

const t = makeTranslate(zh)

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

/** Open the discovery dialog from its trigger and wait until the read settles. */
async function openDialog(
  load: (signal: AbortSignal) => Promise<string[]>,
  current: string[] = [],
  translate: ReturnType<typeof makeTranslate> = t,
): Promise<{ dialog: HTMLElement; add: (models: string[]) => Promise<void> }> {
  const add = vi.fn(async (_models: string[]) => {})
  render(<ModelPicker current={current} load={load} add={add} t={translate} />)
  fireEvent.click(screen.getByRole('button', { name: translate('fetchModels') }))
  const dialog = await screen.findByRole('dialog', { name: translate('chooseModels') })
  await act(async () => {})
  return { dialog, add }
}

it.each([zh, en])('keeps slim dialog copy: no description, labeled search, live selection count', async (dictionary) => {
  const translate = makeTranslate(dictionary)
  const load = vi.fn(async (_signal: AbortSignal) => ['model/a', 'model/b', 'model/b', 'DeepSeek-Chat'])
  const { dialog } = await openDialog(load, ['model/a'], translate)
  const search = within(dialog).getByRole('searchbox', { name: translate('searchModels') }) as HTMLInputElement
  expect(search).toHaveProperty('placeholder', translate('searchModels'))
  expect(dialog.querySelectorAll('p')).toHaveLength(0)
  const status = within(dialog).getByRole('status')
  expect(status.textContent).toBe(translate('selectedModels', { count: 0 }))
  expect(within(dialog).getAllByRole('checkbox')).toHaveLength(2)
  expect(within(dialog).queryByRole('checkbox', { name: 'model/a' })).toBeNull()
  fireEvent.change(search, { target: { value: 'CHAT' } })
  expect(within(dialog).queryByRole('checkbox', { name: 'model/b' })).toBeNull()
  expect(within(dialog).getByRole('checkbox', { name: 'DeepSeek-Chat' })).toBeTruthy()
  fireEvent.change(search, { target: { value: '' } })
  fireEvent.click(within(dialog).getByRole('checkbox', { name: 'model/b' }))
  expect(status.textContent).toBe(translate('selectedModels', { count: 1 }))
  fireEvent.change(search, { target: { value: 'nothing' } })
  expect(within(dialog).getByText(translate('noMatches'))).toBeTruthy()
  expect(within(dialog).getByRole('button', { name: translate('selectAll') })).toHaveProperty('disabled', true)
})

it('shows the all-added empty state and keeps the confirm action disabled', async () => {
  const { dialog, add } = await openDialog(vi.fn(async (_signal: AbortSignal) => ['model/a', 'model/b']), ['model/a', 'model/b'])
  expect(within(dialog).getByText(t('noNewModels'))).toBeTruthy()
  expect(within(dialog).queryByRole('checkbox')).toBeNull()
  expect(within(dialog).getByRole('button', { name: t('selectAll') })).toHaveProperty('disabled', true)
  expect(within(dialog).getByRole('button', { name: t('addModels') })).toHaveProperty('disabled', true)
  expect(add).not.toHaveBeenCalled()
})

it('selects and deselects only the visible rows while hidden selections survive', async () => {
  const { dialog } = await openDialog(vi.fn(async (_signal: AbortSignal) => ['model/a', 'model/b', 'model/c']))
  fireEvent.click(within(dialog).getByRole('checkbox', { name: 'model/a' }))
  const search = within(dialog).getByRole('searchbox', { name: t('searchModels') })
  fireEvent.change(search, { target: { value: 'b' } })
  fireEvent.click(within(dialog).getByRole('button', { name: t('selectAll') }))
  expect(within(dialog).getByRole('status').textContent).toBe(t('selectedModels', { count: 2 }))
  fireEvent.change(search, { target: { value: '' } })
  expect(within(dialog).getByRole('checkbox', { name: 'model/a' })).toHaveProperty('checked', true)
  expect(within(dialog).getByRole('checkbox', { name: 'model/b' })).toHaveProperty('checked', true)
  expect(within(dialog).getByRole('checkbox', { name: 'model/c' })).toHaveProperty('checked', false)
  fireEvent.change(search, { target: { value: 'c' } })
  fireEvent.click(within(dialog).getByRole('button', { name: t('selectAll') }))
  expect(within(dialog).getByRole('status').textContent).toBe(t('selectedModels', { count: 3 }))
  fireEvent.click(within(dialog).getByRole('button', { name: t('deselectAll') }))
  expect(within(dialog).getByRole('status').textContent).toBe(t('selectedModels', { count: 2 }))
  fireEvent.change(search, { target: { value: '' } })
  expect(within(dialog).getByRole('checkbox', { name: 'model/a' })).toHaveProperty('checked', true)
  expect(within(dialog).getByRole('checkbox', { name: 'model/b' })).toHaveProperty('checked', true)
  expect(within(dialog).getByRole('checkbox', { name: 'model/c' })).toHaveProperty('checked', false)
})

it('closes on cancel without applying any selection', async () => {
  const load = vi.fn(async (_signal: AbortSignal) => ['model/b'])
  const { dialog, add } = await openDialog(load)
  fireEvent.click(within(dialog).getByRole('checkbox', { name: 'model/b' }))
  fireEvent.click(within(dialog).getByRole('button', { name: t('cancel') }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(add).not.toHaveBeenCalled()
  expect(load).toHaveBeenCalledOnce()
})

it('refresh aborts the previous read and clears the search and selection', async () => {
  const load = vi.fn(async (_signal: AbortSignal) => ['model/a', 'model/b'])
  const { dialog, add } = await openDialog(load)
  const search = within(dialog).getByRole('searchbox', { name: t('searchModels') }) as HTMLInputElement
  fireEvent.change(search, { target: { value: 'a' } })
  fireEvent.click(within(dialog).getByRole('checkbox', { name: 'model/a' }))
  const firstSignal = load.mock.calls[0]![0]
  fireEvent.click(within(dialog).getByRole('button', { name: t('refreshModels') }))
  expect(firstSignal.aborted).toBe(true)
  expect(load).toHaveBeenCalledTimes(2)
  expect(load).toHaveBeenLastCalledWith(expect.any(AbortSignal))
  expect(search).toHaveProperty('value', '')
  await act(async () => {})
  expect(within(dialog).getByRole('status').textContent).toBe(t('selectedModels', { count: 0 }))
  expect(within(dialog).getByRole('checkbox', { name: 'model/a' })).toHaveProperty('checked', false)
  expect(add).not.toHaveBeenCalled()
})

it('locks every dialog control while saving, reports a failed save, then closes on success', async () => {
  const load = vi.fn(async (_signal: AbortSignal) => ['model/a'])
  const first = Promise.withResolvers<undefined>()
  const add = vi.fn<(models: string[]) => Promise<void>>()
    .mockImplementationOnce(() => first.promise)
    .mockImplementation(async () => {})
  render(<ModelPicker current={[]} load={load} add={add} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: t('fetchModels') }))
  const dialog = await screen.findByRole('dialog', { name: t('chooseModels') })
  await act(async () => {})
  fireEvent.click(within(dialog).getByRole('checkbox', { name: 'model/a' }))
  fireEvent.click(within(dialog).getByRole('button', { name: t('addModels') }))
  expect(add).toHaveBeenCalledOnce()
  expect(add).toHaveBeenCalledWith(['model/a'])
  expect(within(dialog).getByRole('button', { name: t('loading') })).toHaveProperty('disabled', true)
  expect(within(dialog).getByRole('button', { name: t('cancel') })).toHaveProperty('disabled', true)
  expect(within(dialog).getByRole('searchbox', { name: t('searchModels') })).toHaveProperty('disabled', true)
  for (const choice of within(dialog).getAllByRole('checkbox')) expect(choice).toHaveProperty('disabled', true)
  await act(async () => { first.reject(new Error('save failed')) })
  expect(within(dialog).getByRole('alert').textContent).toContain(t('fetchModelsFailed'))
  expect(within(dialog).getByRole('button', { name: t('cancel') })).toHaveProperty('disabled', false)
  fireEvent.click(within(dialog).getByRole('button', { name: t('addModels') }))
  await act(async () => {})
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(add).toHaveBeenCalledTimes(2)
})

it('reports a failed read, then recovers through retry', async () => {
  const retry = Promise.withResolvers<string[]>()
  const load = vi.fn(async (_signal: AbortSignal): Promise<string[]> => { throw new Error('offline') })
  const { dialog } = await openDialog(load)
  expect(within(dialog).getByRole('alert').textContent).toContain(t('fetchModelsFailed'))
  expect(within(dialog).queryByRole('checkbox')).toBeNull()
  load.mockImplementationOnce(async () => retry.promise)
  fireEvent.click(within(dialog).getByRole('button', { name: t('retryImport') }))
  expect(within(dialog).getByText(t('loading'))).toBeTruthy()
  await act(async () => { retry.resolve(['model/b']) })
  expect(within(dialog).queryByRole('alert')).toBeNull()
  expect(within(dialog).queryByRole('button', { name: t('retryImport') })).toBeNull()
  expect(within(dialog).getByRole('checkbox', { name: 'model/b' })).toBeTruthy()
})
