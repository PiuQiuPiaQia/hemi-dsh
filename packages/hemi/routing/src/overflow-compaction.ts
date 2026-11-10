/**
 * Bounded recovery when an automatic compaction summary exceeds its context window.
 * @module @deepseek-ai/dsh-hemi-routing/overflow-compaction
 */

import type { Context, Events } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import { CONTEXT_WINDOW_EXCEEDED_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import type { TokenSurfaceNode } from '@deepseek-ai/dsh-token-meter'
import { estimateToolsTokens } from '@deepseek-ai/dsh-token-meter/estimate'

/** Cordis plugin name. */
export const name = 'hemi-overflow-compaction'

/** Services used by the recovery listener in the compaction group. */
export const inject = ['compaction', 'llm', 'tokenMeter']

/** Limits for one segmented recovery. */
export interface Config {
  /** Maximum summary requests across successful and rejected segments. */
  maxAttempts: number
}

/** Require a finite number of summary attempts. */
export const Config: z<Config> = z.object({
  maxAttempts: z.number().min(1).max(Number.MAX_SAFE_INTEGER).step(1).default(4),
})

/** Take the longest affordable prefix that ends after all of its tool results. */
function selectSegment(
  session: Session,
  nodes: readonly TokenSurfaceNode[],
  from: number,
  through: number,
  budget: number,
): { end: SessionSeq; next: number; tokens: number } | undefined {
  let tokens = 0
  let index = from
  for (; index <= through; index += 1) {
    const node = nodes[index]
    if (node === undefined || tokens + node.tokens > budget) break
    tokens += node.tokens
  }
  for (const node of nodes.slice(from, index).reverse()) {
    if (toolPairingBalancedAfter(session, node.seq)) return { end: node.seq, next: index, tokens }
    index -= 1
    tokens -= node.tokens
  }
  return undefined
}

/** Recover with smaller transactions while leaving the conversation retry with the engine. */
async function recoverOverflow(
  ctx: Context,
  config: Config,
  input: Parameters<Events['compaction/overflow-recovery']>[0],
  next: () => Promise<CompactionResult | null>,
): Promise<CompactionResult | null> {
  const { agent, request, summary, start, end, signal } = input
  signal.throwIfAborted()

  const requestModel = await ctx.llm.resolveModelInfo(request.config.provider, request.config.model, signal)
  const sameRoute = summary.provider === request.config.provider && summary.model === request.config.model
  const summaryModel = sameRoute
    ? requestModel
    : await ctx.llm.resolveModelInfo(summary.provider, summary.model, signal)
  if (requestModel.context === undefined || summaryModel.context === undefined) return next()

  const requestBudget = Math.floor((requestModel.context.contextWindow
    - (request.config.maxTokens ?? requestModel.defaultMaxTokens ?? 0)) * summary.thresholdRatio)
  const summaryHeader = sameRoute ? request : {
    ...request,
    config: { ...request.config, provider: summary.provider, model: summary.model },
  }
  const { session } = agent
  const measurement = ctx.tokenMeter.measure(session, summaryHeader)
  const { nodes } = measurement
  let from = nodes.findIndex(node => node.seq === start)
  const through = nodes.findIndex(node => node.seq === end)
  if (from < 0 || through < from) return next()

  // Native summaries replay the system head and tools. Leave room for the
  // summary directive and token estimation error before selecting any history.
  const systemTokens = from === 0 ? 0 : (nodes[0]?.tokens ?? 0)
  const summaryBudget = Math.floor((summaryModel.context.contextWindow - summary.maxTokens)
    * summary.thresholdRatio) - systemTokens - estimateToolsTokens(summaryHeader)
  const failedTokens = nodes.slice(from, through + 1).reduce((total, node) => total + node.tokens, 0)
  let last = through - 1
  let preferredBudget = Math.min(summaryBudget, Math.floor(failedTokens / 2))
  let result: CompactionResult | undefined
  for (let attempt = 0; attempt < config.maxAttempts; attempt += 1) {
    signal.throwIfAborted()
    const first = nodes[from]
    if (first === undefined || summaryBudget <= 0) break
    // A provider overflow can mean the meter underpriced the failed input.
    // Prefer a substantial first reduction and fall back to the longest safe cut.
    const segment = selectSegment(session, nodes, from, last, preferredBudget) ?? (preferredBudget < summaryBudget
      ? selectSegment(session, nodes, from, last, summaryBudget)
      : undefined)
    if (segment === undefined) break
    try {
      result = await ctx.compaction.compactRegion(first.seq, segment.end, agent, signal)
    } catch (error: unknown) {
      if (!(error instanceof LlmError) || error.code !== CONTEXT_WINDOW_EXCEEDED_CODE) throw error
      last = segment.next - 2
      preferredBudget = Math.floor(segment.tokens / 2)
      continue
    }
    signal.throwIfAborted()
    if (ctx.tokenMeter.measure(session, request).totalTokens <= requestBudget) return result
    from = segment.next
    last = through
    preferredBudget = summaryBudget
  }
  signal.throwIfAborted()
  return result ?? next()
}

/**
 * Register recovery in the native engine's isolation group.
 * @param ctx - context sharing the compaction engine and token meter.
 * @param config - resolved summary attempt limit.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.on('compaction/overflow-recovery', (input, next) =>
    recoverOverflow(ctx, config, input, next)), 'hemi: segmented recovery after summary overflow')
}
