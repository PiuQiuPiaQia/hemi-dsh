import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { RetryId } from '@deepseek-ai/dsh-llm-retry'
import type {} from '../../memory/src/lifecycle.ts'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { modelUsageProjection } from '../src/usage.ts'

async function harness() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(Projections)
  const handle = await ctx.sessionProjections.register(modelUsageProjection)
  const session = ctx.sessions.create()
  return { ctx, session, read: () => handle.stateOf(session) }
}

function settle(session: Session, model: string, step: number, usage?: TokenUsage) {
  session.append('assistant/message', { turn: 1, step, stream: [],
    message: createAssistantMessage({ content: [], source: { provider: 'test', model } }),
    ...usage === undefined ? {} : { usage },
  }, { surfaceOp: 'append' })
}

it('groups actual model calls, preserves full provider totals and distinguishes missing cache fields', async () => {
  const { session, read } = await harness()
  settle(session, 'main', 1, { inputTokens: 10, outputTokens: 20, totalTokens: 130 })
  settle(session, 'other', 2, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 25, reasoningTokens: 4 })
  settle(session, 'main', 3, { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 })
  expect(read().models).toMatchObject([
    { provider: 'test', model: 'main', calls: 2, reportedCalls: 2, uncachedInputTokens: 15, outputTokens: 22,
      totalTokens: 137, totalReports: 2, cacheReadReports: 1, cacheWriteReports: 1 },
    { model: 'other', calls: 1, totalTokens: 185, cacheReadTokens: 50, cacheWriteTokens: 25, reasoningTokens: 4 },
  ])
})

it('replaces the same attempt but counts a retry separately, including missing-usage attempts', async () => {
  const { session, read } = await harness()
  settle(session, 'main', 1)
  settle(session, 'main', 1, { inputTokens: 10, outputTokens: 5 })
  expect(read().models[0]).toMatchObject({ calls: 1, reportedCalls: 1, totalTokens: 15 })
  session.append('llm/retry-started', { turn: 1, step: 1, retryId: RetryId('retry'), retry: 1 })
  settle(session, 'main', 1, { inputTokens: 20, outputTokens: 2 })
  settle(session, 'main', 2)
  expect(read().models[0]).toMatchObject({ calls: 3, reportedCalls: 2, totalTokens: 37 })
})

it('excludes fork-inherited calls while retaining inherited route metadata for later attempts', async () => {
  const { session } = await harness()
  session.append('request/context', { provider: 'test', model: 'inherited' })
  settle(session, 'inherited', 1, { inputTokens: 999, outputTokens: 999 })
  session.append('assistant/attempt', { turn: 2, step: 1,
    stream: [{ type: 'chunk', time: 1, chunk: { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } } }] })
  const events = session.snapshotEvents()
  const initial = modelUsageProjection.init(session.header, SessionLogOffset(2))
  const folded = events.reduce((state, event) => modelUsageProjection.apply(state, event), initial)
  expect(folded.models).toMatchObject([{ model: 'inherited', calls: 1, totalTokens: 7 }])
  expect(modelUsageProjection.stateSchema.parse(folded)).toEqual(folded)
})

it('includes recorded compaction and memory summary calls without altering the active assistant attempt', async () => {
  const { session, read } = await harness()
  settle(session, 'main', 1, { inputTokens: 10, outputTokens: 5 })
  session.append('compaction/summary', { compactionId: CompactionId('summary'), provider: 'test', model: 'summary',
    shadowedRange: { start: SessionSeq(0), end: SessionSeq(0) }, shadowedSeqs: [SessionSeq(0)],
    shadowedTokenCount: 10, summary: [], rawOutput: [], llmStreamCall: true,
    usage: { inputTokens: 20, outputTokens: 3, cacheReadTokens: 100 } })
  const request = session.append('hemi-memory/summary-request', { throughSeq: SessionSeq(0),
    config: { provider: 'test', model: 'memory' }, system: 'summarize', messages: [] })
  session.append('hemi-memory/summary-result', { requestSeq: request.seq, throughSeq: SessionSeq(0),
    outcome: 'saved', text: 'remember', usage: { inputTokens: 7, outputTokens: 2 } })
  settle(session, 'main', 1, { inputTokens: 10, outputTokens: 6 })
  expect(read().models).toMatchObject([
    { model: 'summary', calls: 1, totalTokens: 123 },
    { model: 'memory', calls: 1, totalTokens: 9 },
    { model: 'main', calls: 1, totalTokens: 16 },
  ])
})

it('does not claim an exact total when neither a full total nor a complete cache breakdown was reported', async () => {
  const { session, read } = await harness()
  settle(session, 'missing-cache', 1, { inputTokens: 10, outputTokens: 2 })
  settle(session, 'known-zero-cache', 2, { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 })
  expect(read().models).toMatchObject([
    { model: 'missing-cache', reportedCalls: 1, totalReports: 0 },
    { model: 'known-zero-cache', reportedCalls: 1, totalReports: 1 },
  ])
})

it.each([
  { usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }, readReports: 1, writeReports: 1 },
  { usage: { inputTokens: 10, outputTokens: 2, totalTokens: 17, cacheWriteTokens: 5 }, readReports: 1, writeReports: 1 },
  { usage: { inputTokens: 10, outputTokens: 2, totalTokens: 17, cacheReadTokens: 5 }, readReports: 1, writeReports: 1 },
  { usage: { inputTokens: 10, outputTokens: 2, totalTokens: 17 }, readReports: 0, writeReports: 0 },
  { usage: { inputTokens: 10, outputTokens: 2, totalTokens: 11 }, readReports: 0, writeReports: 0 },
])('recognizes omitted cache counters only when the exact total determines zero: $usage', async ({ usage, readReports, writeReports }) => {
  const { session, read } = await harness()
  settle(session, 'main', 1, usage)
  expect(read().models[0]).toMatchObject({ cacheReadReports: readReports, cacheWriteReports: writeReports })
})

it('rebuilds old cache checkpoints and preserves zero-cache accounting through suffix replay', async () => {
  const { ctx, session, read } = await harness()
  settle(session, 'main', 1, { inputTokens: 10, outputTokens: 2, totalTokens: 12 })
  const rows = ctx.sessionProjections.checkpoint(session)
  const stale = { hemiModelUsage: { ver: 3, seq: SessionSeq(0), val: {
    ...read(), models: [{ ...read().models[0]!, cacheReadReports: 0, cacheWriteReports: 0 }],
  } } }
  expect(ctx.sessionProjections.restoreFloor(stale)).toBe(0)
  const rebuilt = ctx.sessionProjections.restore(stale, session.snapshotEvents(), SessionLogOffset(0),
    session.header, SessionLogOffset(0))
  expect(rebuilt.checkpoint).toEqual(rows)
  settle(session, 'main', 2, { inputTokens: 5, outputTokens: 3, totalTokens: 28, cacheReadTokens: 20 })
  const restored = ctx.sessionProjections.restore(rows, session.snapshotEvents().slice(1), SessionLogOffset(1),
    session.header, SessionLogOffset(0))
  expect(restored.checkpoint).toEqual(ctx.sessionProjections.checkpoint(session))
  expect(restored.snapshot.values.hemiModelUsage).toMatchObject({ models: [
    { calls: 2, cacheReadTokens: 20, cacheWriteTokens: 0, cacheReadReports: 2, cacheWriteReports: 2 },
  ] })
})
