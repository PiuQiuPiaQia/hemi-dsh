import { expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ModelUsageRow } from '@deepseek-ai/dsh-hemi-routing/client'
import { loadConversationUsage, conversationCacheHit, formatCacheHit } from '../src/client/usage/conversation-usage.ts'

const usageRow = (model = 'main', provider = 'test'): ModelUsageRow => ({
  provider, model, calls: 1, reportedCalls: 1, totalReports: 1, uncachedInputTokens: 10, outputTokens: 20,
  cacheReadTokens: 0, cacheWriteTokens: 0, cacheReadReports: 0, cacheWriteReports: 0,
  reasoningTokens: 0, reasoningReports: 0, totalTokens: 130,
})

it('includes nested children and repeated models once, keeps providers distinct and reports unavailable branches', async () => {
  const read = vi.fn(async (id: SessionId) => {
    if (id === 'missing') throw new Error('missing child file')
    return { usage: { models: [usageRow('main', id === 'grandchild' ? 'other-provider' : 'test')] },
      children: id === 'root' ? [{ id: SessionId('child'), mode: 'continuable' }, { id: SessionId('missing'), mode: 'unknown' },
        { id: SessionId('external'), mode: 'external' }]
        : id === 'child' ? [{ id: SessionId('grandchild'), mode: 'continuable' }, { id: SessionId('root'), mode: 'continuable' }]
          : [],
    }
  })
  const result = await loadConversationUsage(SessionId('root'), read, new AbortController().signal)
  expect(result).toMatchObject({ sessions: 3, unavailableSessions: 2, models: [
    { model: 'main', provider: 'test', calls: 2, totalTokens: 260 },
    { model: 'main', provider: 'other-provider', calls: 1, totalTokens: 130 },
  ] })
  expect(read).toHaveBeenCalledTimes(4)
})

it('propagates cancellation instead of reporting an incomplete successful result', async () => {
  const abort = new AbortController()
  const read = async () => { abort.abort(); throw new Error('cancelled') }
  await expect(loadConversationUsage(SessionId('root'), read, abort.signal)).rejects.toThrow()
})

it('weights cache hits by full input tokens and withholds rates when the source counters are incomplete', () => {
  const small = { ...usageRow(), totalTokens: 30, outputTokens: 20, cacheReadTokens: 9, cacheReadReports: 1 }
  const large = { ...usageRow(), totalTokens: 110, outputTokens: 20, cacheReadTokens: 1, cacheReadReports: 1 }
  expect(formatCacheHit(conversationCacheHit([small, large]))).toBe('10%')
  const missing = { ...large, cacheReadReports: 0, cacheReadTokens: 0 }
  expect(formatCacheHit(conversationCacheHit([small, missing]))).toBe('—')
  expect(formatCacheHit(conversationCacheHit([{ ...small, totalReports: 0 }]))).toBe('—')
  expect(formatCacheHit(conversationCacheHit([small], 1))).toBe('—')
})
