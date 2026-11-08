// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { HemiSessionUsage } from '../src/client/usage/SessionUsage.tsx'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en, zh } from '../src/client/locales.ts'
import type { ConversationUsage, ModelUsageRow } from '@deepseek-ai/dsh-hemi-routing/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { loadConversationUsage } from '../src/client/usage/conversation-usage.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })
const root: ModelUsageRow = { provider: 'test', model: 'main', calls: 2, reportedCalls: 2, totalReports: 2,
  uncachedInputTokens: 10, outputTokens: 20, totalTokens: 130,
  cacheReadTokens: 0, cacheWriteTokens: 0, cacheReadReports: 0, cacheWriteReports: 0,
  reasoningTokens: 0, reasoningReports: 0 }
const child: ModelUsageRow = { ...root, model: 'oracle', calls: 1, reportedCalls: 1, totalReports: 1,
  totalTokens: 185, uncachedInputTokens: 100, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 25,
  cacheReadReports: 1, cacheWriteReports: 1 }

it('shows all model rows, exact aggregate inputs and separately reported cache counters', async () => {
  type Props = Parameters<typeof HemiSessionUsage>[0]
  const own = { models: [root] }
  const catalog = [{ id: 'child' }]
  const props = {
    t: makeTranslate(zh),
    useProjection: (key: string) => key === 'hemiModelUsage' ? own : catalog,
    loadUsage: async () => ({ models: [root, child], sessions: 2, unavailableSessions: 0 }),
  } as Props
  render(<HemiSessionUsage {...props} />)
  fireEvent.click(screen.getByRole('button', { name: '会话用量' }))
  const dialog = within(screen.getByRole('dialog'))
  expect(await dialog.findByText('315')).toBeTruthy()
  const main = within(dialog.getByRole('row', { name: /main/ }))
  expect(main.getByText('110')).toBeTruthy()
  expect(main.getByText('0%')).toBeTruthy()
  expect(main.getAllByText('0')).toHaveLength(2)
  expect(main.queryByText('—')).toBeNull()
  const oracle = within(dialog.getByRole('row', { name: /oracle/ }))
  expect(oracle.getByText('175')).toBeTruthy()
  expect(oracle.getByText('50')).toBeTruthy()
  expect(oracle.getByText('25')).toBeTruthy()
  expect(dialog.getByRole('columnheader', { name: '调用次数' })).toBeTruthy()
  expect(dialog.getByText('main (test)')).toBeTruthy()
  expect(dialog.queryByText('未缓存输入')).toBeNull()
})

it('shows recorded values and zero cache counters without requiring complete reports', () => {
  type Props = Parameters<typeof HemiSessionUsage>[0]
  const row = { ...root, calls: 1, reportedCalls: 1, totalReports: 0, totalTokens: 12, outputTokens: 2 }
  const own = { models: [row] }
  const props = { t: makeTranslate(zh), useProjection: (key: string) => key === 'hemiModelUsage' ? own : undefined,
    loadUsage: async () => ({ models: [row], sessions: 1, unavailableSessions: 0 }),
  } as Props
  render(<HemiSessionUsage {...props} />)
  fireEvent.click(screen.getByRole('button', { name: '会话用量' }))
  const dialog = within(screen.getByRole('dialog'))
  expect(dialog.getByText('12')).toBeTruthy()
  expect(within(dialog.getByRole('row', { name: /main/ })).getAllByRole('cell').map(cell => cell.textContent))
    .toEqual(['1', '10', '2', '0%', '0', '0'])
  expect(dialog.queryByText('—')).toBeNull()
})

it('refreshes the whole-tree cache rate while the popover is closed', async () => {
  vi.useFakeTimers()
  type Props = Parameters<typeof HemiSessionUsage>[0]
  const own = { models: [root] }
  const catalog = [{ id: 'child' }]
  let cacheRead = 25
  const props = { t: makeTranslate(zh), useProjection: (key: string) => key === 'hemiModelUsage' ? own : catalog,
    loadUsage: async () => ({ models: [{ ...root, totalTokens: 120, cacheReadTokens: cacheRead, cacheReadReports: 2 }],
      sessions: 2, unavailableSessions: 0 }),
  } as Props
  render(<HemiSessionUsage {...props} />)
  await act(async () => { await Promise.resolve() })
  expect(screen.getByRole('button', { name: '会话用量' }).textContent).toBe('缓存命中 25%')
  expect(screen.queryByRole('dialog')).toBeNull()
  cacheRead = 75
  await act(async () => { await vi.advanceTimersByTimeAsync(8000) })
  expect(screen.getByRole('button', { name: '会话用量' }).textContent).toBe('缓存命中 75%')
})

it('sums reported usage without missing-call counts or unavailable totals', () => {
  type Props = Parameters<typeof HemiSessionUsage>[0]
  const row = { ...root, calls: 3, totalTokens: 220, cacheReadTokens: 80, cacheReadReports: 2 }
  const own = { models: [row] }
  const props = { t: makeTranslate(zh), useProjection: (key: string) => key === 'hemiModelUsage' ? own : undefined,
    loadUsage: async () => ({ ...own, sessions: 1, unavailableSessions: 0 }),
  } as Props
  render(<HemiSessionUsage {...props} />)
  const trigger = screen.getByRole('button', { name: '会话用量' })
  expect(trigger.textContent).toBe('缓存命中 40%')
  expect(trigger.getAttribute('aria-description')).toBe(trigger.textContent)
  fireEvent.click(trigger)
  const dialog = within(screen.getByRole('dialog'))
  expect(dialog.queryByText(/次调用|仅.*有用量/)).toBeNull()
  const model = within(dialog.getByRole('row', { name: /main/ }))
  expect(model.getAllByRole('cell').map(cell => cell.textContent)).toEqual(['3', '200', '20', '40%', '80', '0'])
  expect(dialog.queryByText('—')).toBeNull()
  expect(dialog.getByText('220')).toBeTruthy()
})

it.each([
  { dictionary: zh, title: '会话用量', label: '缓存命中 0%' },
  { dictionary: en, title: 'Conversation usage', label: 'Cache hit 0%' },
])('shows zero values when no calls returned usage ($title)', ({ dictionary, title, label }) => {
  type Props = Parameters<typeof HemiSessionUsage>[0]
  const row = { ...root, reportedCalls: 0, totalReports: 0, uncachedInputTokens: 0, outputTokens: 0, totalTokens: 0 }
  const own = { models: [row] }
  const props = { t: makeTranslate(dictionary), useProjection: (key: string) => key === 'hemiModelUsage' ? own : undefined,
    loadUsage: async () => ({ ...own, sessions: 1, unavailableSessions: 0 }),
  } as Props
  render(<HemiSessionUsage {...props} />)
  const trigger = screen.getByRole('button', { name: title })
  expect(trigger.textContent).toBe(label)
  fireEvent.click(trigger)
  const dialog = within(screen.getByRole('dialog'))
  const model = within(dialog.getByRole('row', { name: /main/ }))
  expect(model.getAllByRole('cell').map(cell => cell.textContent)).toEqual(['2', '0', '0', '0%', '0', '0'])
  expect(dialog.queryByText(/次调用|calls returned usage|—/)).toBeNull()
})

it.each([
  { dictionary: zh, title: '会话用量', label: '缓存命中 40%' },
  { dictionary: en, title: 'Conversation usage', label: 'Cache hit 40%' },
])('keeps the footer label unchanged when report coverage changes ($title)', ({ dictionary, title, label }) => {
  type Props = Parameters<typeof HemiSessionUsage>[0]
  let own = { models: [{ ...root, calls: 3, totalTokens: 220, cacheReadTokens: 80, cacheReadReports: 2 }] }
  const props = { t: makeTranslate(dictionary),
    useProjection: (key: string) => key === 'hemiModelUsage' ? own : undefined,
    loadUsage: async () => ({ ...own, sessions: 1, unavailableSessions: 0 }),
  } as Props
  const view = render(<HemiSessionUsage {...props} />)
  const trigger = screen.getByRole('button', { name: title })
  expect(trigger.textContent).toBe(label)
  own = { models: [{ ...own.models[0]!, calls: 3, reportedCalls: 3, totalReports: 3,
    totalTokens: 330, outputTokens: 30, cacheReadTokens: 120, cacheReadReports: 3 }] }
  view.rerender(<HemiSessionUsage {...props} />)
  expect(screen.getByRole('button', { name: title })).toBe(trigger)
  expect(trigger.textContent).toBe(label)
})

it('uses the live projection without fetching when a solo conversation opens', () => {
  type Props = Parameters<typeof HemiSessionUsage>[0]
  const own = { models: [{ ...root, totalTokens: 120, cacheReadTokens: 25, cacheReadReports: 2 }] }
  const loadUsage = vi.fn(async () => ({ ...own, sessions: 1, unavailableSessions: 0 }))
  const props = { t: makeTranslate(zh), useProjection: (key: string) => key === 'hemiModelUsage' ? own : undefined,
    loadUsage,
  } as Props
  render(<HemiSessionUsage {...props} />)
  const trigger = screen.getByRole('button', { name: '会话用量' })
  fireEvent.click(trigger)
  expect(trigger.textContent).toBe('缓存命中 25%')
  expect(screen.queryByRole('status')).toBeNull()
  expect(loadUsage).not.toHaveBeenCalled()
})

it('keeps tree figures visible while opening, closing, refreshing and retrying', async () => {
  vi.useFakeTimers()
  type Props = Parameters<typeof HemiSessionUsage>[0]
  let own = { models: [root] }
  let catalog = [{ id: 'child' }]
  const pending: ReturnType<typeof Promise.withResolvers<ConversationUsage>>[] = []
  const signals: AbortSignal[] = []
  const loadUsage = vi.fn((signal: AbortSignal) => {
    signals.push(signal)
    const request = Promise.withResolvers<ConversationUsage>()
    pending.push(request)
    return request.promise
  })
  const props = { t: makeTranslate(zh), useProjection: (key: string) => key === 'hemiModelUsage' ? own : catalog,
    loadUsage,
  } as Props
  const view = render(<HemiSessionUsage {...props} />)
  const trigger = screen.getByRole('button', { name: '会话用量' })
  fireEvent.click(trigger)
  expect(screen.getByRole('status').textContent).toBe('读取中…')
  const data = { models: [{ ...root, totalTokens: 120, cacheReadTokens: 25, cacheReadReports: 2 }],
    sessions: 2, unavailableSessions: 0 }
  await act(async () => { pending.at(-1)!.resolve(data) })
  expect(trigger.textContent).toBe('缓存命中 25%')
  expect(screen.queryByRole('status')).toBeNull()

  fireEvent.click(trigger)
  expect(trigger.textContent).toBe('缓存命中 25%')
  fireEvent.click(trigger)
  expect(trigger.textContent).toBe('缓存命中 25%')
  expect(screen.queryByRole('status')).toBeNull()
  expect(within(screen.getByRole('dialog')).getByText('main (test)')).toBeTruthy()

  own = { models: [{ ...root, calls: 3 }] }
  catalog = [...catalog, { id: 'another-child' }]
  view.rerender(<HemiSessionUsage {...props} />)
  expect(trigger.textContent).toBe('缓存命中 25%')
  expect(screen.queryByRole('status')).toBeNull()
  const latest = pending.at(-1)!
  await act(async () => { latest.reject(new Error('offline')) })
  expect(trigger.textContent).toBe('缓存命中 25%')
  expect(screen.getByRole('status').textContent).toBe('刷新失败，显示上次数据；将自动重试')
  expect(within(screen.getByRole('dialog')).getByText('main (test)')).toBeTruthy()

  await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
  expect(trigger.textContent).toBe('缓存命中 25%')
  await act(async () => {
    pending.at(-1)!.resolve({ ...data, models: [{ ...data.models[0]!, cacheReadTokens: 75 }] })
  })
  expect(trigger.textContent).toBe('缓存命中 75%')
  expect(screen.queryByRole('status')).toBeNull()
  await act(async () => { pending[0]!.resolve(data) })
  expect(trigger.textContent).toBe('缓存命中 75%')
  view.unmount()
  expect(signals.every(signal => signal.aborted)).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
  await act(async () => { pending.forEach((request) => { request.resolve(data) }) })
})

it('retains the tree figures when the root projections RPC fails and recovers on retry', async () => {
  vi.useFakeTimers()
  type Props = Parameters<typeof HemiSessionUsage>[0]
  const rootId = SessionId('usage-root')
  const childId = SessionId('usage-child')
  const row = { ...root, totalTokens: 120, cacheReadTokens: 25, cacheReadReports: 2 }
  const own = { models: [row] }
  const catalog = [{ id: childId }]
  let offline = false
  const loadUsage = (signal: AbortSignal) => loadConversationUsage(rootId, async (id) => {
    if (offline && id === rootId) throw new Error('root projections RPC is offline')
    return { usage: { models: [{ ...row, model: id === rootId ? 'main' : 'oracle' }] },
      children: id === rootId ? [{ id: childId, mode: 'local' }] : [] }
  }, signal)
  const props = { t: makeTranslate(zh), useProjection: (key: string) => key === 'hemiModelUsage' ? own : catalog,
    loadUsage,
  } as Props
  render(<HemiSessionUsage {...props} />)
  const trigger = screen.getByRole('button', { name: '会话用量' })
  fireEvent.click(trigger)
  await act(async () => {})
  expect(trigger.textContent).toBe('缓存命中 25%')
  offline = true
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
  expect(trigger.textContent).toBe('缓存命中 25%')
  expect(screen.getByRole('status').textContent).toBe('刷新失败，显示上次数据；将自动重试')
  const dialog = within(screen.getByRole('dialog'))
  expect(dialog.getByText('main (test)')).toBeTruthy()
  expect(dialog.getByText('oracle (test)')).toBeTruthy()
  offline = false
  row.cacheReadTokens = 75
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
  expect(trigger.textContent).toBe('缓存命中 75%')
  expect(screen.queryByRole('status')).toBeNull()
})

it('distinguishes a first read failure from a refresh failure', async () => {
  type Props = Parameters<typeof HemiSessionUsage>[0]
  const own = { models: [root] }
  const catalog = [{ id: 'child' }]
  const props = { t: makeTranslate(zh), useProjection: (key: string) => key === 'hemiModelUsage' ? own : catalog,
    loadUsage: async () => { throw new Error('offline') },
  } as Props
  render(<HemiSessionUsage {...props} />)
  fireEvent.click(screen.getByRole('button', { name: '会话用量' }))
  await act(async () => {})
  expect(screen.getByRole('status').textContent).toBe('用量暂不可用，正在自动重试。')
  expect(screen.getByRole('button', { name: '会话用量' }).textContent).toBe('缓存命中 —')
  expect(screen.queryByRole('table')).toBeNull()
})

it('keeps available branch totals and cache rates visible beside the read failure notice', async () => {
  type Props = Parameters<typeof HemiSessionUsage>[0]
  const own = { models: [root] }
  const catalog = [{ id: 'child' }]
  const props = { t: makeTranslate(zh), useProjection: (key: string) => key === 'hemiModelUsage' ? own : catalog,
    loadUsage: async () => ({ models: [child], sessions: 1, unavailableSessions: 1 }),
  } as Props
  render(<HemiSessionUsage {...props} />)
  fireEvent.click(screen.getByRole('button', { name: '会话用量' }))
  await act(async () => {})
  const dialog = within(screen.getByRole('dialog'))
  expect(dialog.getByText('1 个会话的用量暂不可用，显示已读取数据；将自动重试')).toBeTruthy()
  expect(dialog.getByText('oracle (test)')).toBeTruthy()
  expect(dialog.getByText('185')).toBeTruthy()
  expect(screen.getByRole('button', { name: '会话用量' }).textContent).toBe('缓存命中 28.6%')
})

it('does not reuse another conversation reader’s retained figures', async () => {
  type Props = Parameters<typeof HemiSessionUsage>[0]
  const own = { models: [root] }
  const catalog = [{ id: 'child' }]
  const data = { models: [{ ...root, totalTokens: 120, cacheReadTokens: 25, cacheReadReports: 2 }],
    sessions: 2, unavailableSessions: 0 }
  const next = Promise.withResolvers<ConversationUsage>()
  const props = { t: makeTranslate(zh), useProjection: (key: string) => key === 'hemiModelUsage' ? own : catalog,
    loadUsage: async () => data,
  } as Props
  const view = render(<HemiSessionUsage {...props} />)
  await act(async () => {})
  expect(screen.getByRole('button', { name: '会话用量' }).textContent).toBe('缓存命中 25%')
  view.rerender(<HemiSessionUsage {...props} loadUsage={() => next.promise} />)
  const trigger = screen.getByRole('button', { name: '会话用量' })
  expect(trigger.textContent).toBe('缓存命中 —')
  await act(async () => { next.resolve({ ...data, models: [{ ...data.models[0]!, cacheReadTokens: 75 }] }) })
  expect(trigger.textContent).toBe('缓存命中 75%')
})
