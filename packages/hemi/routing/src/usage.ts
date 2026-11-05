/** Hemi's own model-usage projection; no changes to DSH's token-meter are required. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm-retry/types'
import type {} from '@deepseek-ai/dsh-compaction/types'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { ModelUsageRow } from './usage-types.ts'
export type { ModelUsageProjection, ModelUsageRow } from './usage-types.ts'

const counter = z.number().nonnegative()
const rowSchema = z.object({
  provider: z.string(), model: z.string(), calls: counter, reportedCalls: counter, totalReports: counter,
  uncachedInputTokens: counter, outputTokens: counter, cacheReadTokens: counter, cacheWriteTokens: counter,
  cacheReadReports: counter, cacheWriteReports: counter, reasoningTokens: counter, reasoningReports: counter,
  totalTokens: counter,
}).strict()
const memoryRequestSchema = z.object({ config: z.object({ provider: z.string(), model: z.string() }) })
const memoryResultSchema = z.object({ requestSeq: z.number(), usage: z.object({
  inputTokens: counter, outputTokens: counter, totalTokens: counter.optional(),
  cacheReadTokens: counter.optional(), cacheWriteTokens: counter.optional(), reasoningTokens: counter.optional(),
}).optional() })
const viewSchema = z.object({ models: z.array(rowSchema) }).strict()
const stateSchema = z.object({
  inheritedCount: z.number(),
  route: z.object({ provider: z.string(), model: z.string() }).nullable(),
  models: z.array(rowSchema),
  memoryRequests: z.record(z.string(), z.object({ provider: z.string(), model: z.string() })),
  last: z.object({ turn: z.number(), step: z.number(), row: rowSchema }).nullable(),
}).strict()
type State = z.infer<typeof stateSchema>
const COUNTERS = ['calls', 'reportedCalls', 'totalReports', 'uncachedInputTokens', 'outputTokens', 'cacheReadTokens',
  'cacheWriteTokens', 'cacheReadReports', 'cacheWriteReports', 'reasoningTokens', 'reasoningReports', 'totalTokens'] as const

function sampleRow(
  provider: string, model: string,
  usage: (Pick<TokenUsage, 'inputTokens' | 'outputTokens'> & { [K in keyof TokenUsage]: TokenUsage[K] | undefined }) | undefined,
): ModelUsageRow {
  // Disjoint token buckets exhaust an exact total only when omitted cache counters are zero.
  const cacheComplete = usage !== undefined && usage.totalTokens !== undefined
    && usage.totalTokens === usage.inputTokens + usage.outputTokens
      + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  return {
    provider, model, calls: 1, reportedCalls: usage === undefined ? 0 : 1,
    totalReports: usage !== undefined && (usage.totalTokens !== undefined
      || (usage.cacheReadTokens !== undefined && usage.cacheWriteTokens !== undefined)) ? 1 : 0,
    uncachedInputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0,
    cacheReadTokens: usage?.cacheReadTokens ?? 0, cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
    cacheReadReports: usage?.cacheReadTokens !== undefined || cacheComplete ? 1 : 0,
    cacheWriteReports: usage?.cacheWriteTokens !== undefined || cacheComplete ? 1 : 0,
    reasoningTokens: usage?.reasoningTokens ?? 0, reasoningReports: usage?.reasoningTokens === undefined ? 0 : 1,
    totalTokens: usage?.totalTokens ?? ((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)
      + (usage?.cacheReadTokens ?? 0) + (usage?.cacheWriteTokens ?? 0)),
  }
}

function adjust(rows: ModelUsageRow[], delta: ModelUsageRow, sign: 1 | -1): ModelUsageRow[] {
  const index = rows.findIndex(row => row.provider === delta.provider && row.model === delta.model)
  const row = rows[index] ?? sampleRow(delta.provider, delta.model, undefined)
  const next = { ...row }
  for (const key of COUNTERS) next[key] = (index < 0 ? 0 : row[key]) + sign * delta[key]
  if (index < 0) return [...rows, next]
  return rows.flatMap((entry, position) => position !== index ? [entry] : next.calls > 0 ? [next] : [])
}

/** Model accounting including retries, corrected settlements and cache zeros determined by exact totals. */
export const modelUsageProjection = {
  key: 'hemiModelUsage', stateVersion: 4, stateSchema,
  init: (_header, inheritedCount): State => ({ inheritedCount, route: null, models: [], memoryRequests: {}, last: null }),
  apply: (state, event) => {
    if (event.type === 'request/context') {
      const { provider, model } = event.data
      if (state.route?.provider === provider && state.route.model === model) return state
      return { ...state, route: { provider, model } }
    }
    if (event.seq < state.inheritedCount) return state
    // The optional Hemi memory plugin records its own auxiliary model calls.
    // Read its versioned data structurally without making routing depend on memory.
    const auxiliary: { type: string; data: unknown } = event
    if (auxiliary.type === 'hemi-memory/summary-request') {
      const request = memoryRequestSchema.safeParse(event.data)
      if (!request.success) return state
      return { ...state, memoryRequests: { ...state.memoryRequests, [event.seq]: request.data.config } }
    }
    if (auxiliary.type === 'hemi-memory/summary-result') {
      const result = memoryResultSchema.safeParse(event.data)
      if (!result.success) return state
      const { [result.data.requestSeq]: route, ...memoryRequests } = state.memoryRequests
      const row = sampleRow(route?.provider ?? 'unknown', route?.model ?? 'unknown', result.data.usage)
      return { ...state, memoryRequests, models: adjust(state.models, row, 1) }
    }
    if (event.type === 'compaction/summary' && (event.data.llmStreamCall === true || event.data.usage !== undefined)) {
      const row = sampleRow(event.data.provider, event.data.model, event.data.usage)
      return { ...state, models: adjust(state.models, row, 1) }
    }
    if (event.type === 'llm/retry-started') {
      return state.last?.turn === event.data.turn && state.last.step === event.data.step
        ? { ...state, last: null } : state
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state
    const usage = event.type === 'assistant/message' && event.data.usage !== undefined ? event.data.usage
      : lastAssistantStreamChunk(event.data.stream, 'usage')?.usage
    const source = event.type === 'assistant/message' ? event.data.message.source : state.route
    const row = sampleRow(source?.provider ?? 'unknown', source?.model ?? 'unknown', usage)
    const { turn, step } = event.data
    const previous = state.last?.turn === turn && state.last.step === step ? state.last.row : undefined
    const rows = previous === undefined ? state.models : adjust(state.models, previous, -1)
    return { ...state, models: adjust(rows, row, 1), last: { turn, step, row } }
  },
  wire: { viewSchema, view: state => ({ models: state.models }), summary: false },
} satisfies ProjectionDefinition<'hemiModelUsage', State>

export const name = 'hemi-model-usage'
export const inject = ['sessionProjections']
/** Register Hemi's projection through the native extension point. */
export async function apply(ctx: Context): Promise<void> {
  await ctx.sessionProjections.register(modelUsageProjection)
}
