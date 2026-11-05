// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { HemiSessionUsage } from '../src/client/usage/SessionUsage.tsx'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh } from '../src/client/locales.ts'
import type { ModelUsageRow } from '@deepseek-ai/dsh-hemi-routing/client'

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
  expect(main.getAllByText('—')).toHaveLength(3)
  const oracle = within(dialog.getByRole('row', { name: /oracle/ }))
  expect(oracle.getByText('175')).toBeTruthy()
  expect(oracle.getByText('50')).toBeTruthy()
  expect(oracle.getByText('25')).toBeTruthy()
  expect(dialog.getByRole('columnheader', { name: '调用次数' })).toBeTruthy()
  expect(dialog.getByText('main (test)')).toBeTruthy()
  expect(dialog.queryByText('未缓存输入')).toBeNull()
})

it('leaves incomplete values blank without showing estimates, symbols or explanatory clutter', async () => {
  type Props = Parameters<typeof HemiSessionUsage>[0]
  const row = { ...root, calls: 1, reportedCalls: 1, totalReports: 0, totalTokens: 12, outputTokens: 2 }
  const own = { models: [row] }
  const props = { t: makeTranslate(zh), useProjection: (key: string) => key === 'hemiModelUsage' ? own : undefined,
    loadUsage: async () => ({ models: [row], sessions: 1, unavailableSessions: 0 }),
  } as Props
  render(<HemiSessionUsage {...props} />)
  fireEvent.click(screen.getByRole('button', { name: '会话用量' }))
  const dialog = within(screen.getByRole('dialog'))
  expect(dialog.queryByText('12')).toBeNull()
  expect(within(dialog.getByRole('row', { name: /main/ })).getAllByText('—')).toHaveLength(4)
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
