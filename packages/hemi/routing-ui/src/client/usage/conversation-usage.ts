/** Read recorded model usage from the selected session and its entire native child catalog. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConversationUsage, ModelUsageProjection, ModelUsageRow } from '@deepseek-ai/dsh-hemi-routing/client'

/**
 * Recorded usage and native children read from one Session.
 */
export interface UsageSessionRead {
  usage: ModelUsageProjection
  children: readonly { id: SessionId; mode: string }[]
}
/**
 * Read-only Session projection operation with caller cancellation.
 */
export type ReadUsageSession = (id: SessionId, signal: AbortSignal) => Promise<UsageSessionRead>

/**
 * A missing branch remains visible; opening usage never resumes an agent or makes model calls.
 * @param root - Root Session whose native child catalog is traversed.
 * @param read - Read-only projection reader for each reachable Session.
 * @param signal - Caller cancellation for this asynchronous operation.
 * @returns the aggregated usage and count of unavailable branches.
 */
export async function loadConversationUsage(root: SessionId, read: ReadUsageSession, signal: AbortSignal): Promise<ConversationUsage> {
  const visited = new Set<SessionId>()
  const pending = [root]
  const models = new Map<string, ModelUsageRow>()
  let sessions = 0
  let unavailableSessions = 0
  while (pending.length > 0) {
    signal.throwIfAborted()
    const id = pending.shift()
    if (id === undefined) break
    if (visited.has(id)) continue
    visited.add(id)
    try {
      const snapshot = await read(id, signal)
      sessions += 1
      for (const row of snapshot.usage.models) {
        const key = JSON.stringify([row.provider, row.model])
        const previous = models.get(key)
        if (previous === undefined) models.set(key, { ...row })
        else {
          const next = { ...previous }
          for (const field of Object.keys(row) as (keyof ModelUsageRow)[]) {
            if (field !== 'provider' && field !== 'model') next[field] += row[field]
          }
          models.set(key, next)
        }
      }
      for (const child of snapshot.children) {
        if (child.mode === 'external') {
          if (!visited.has(child.id)) { visited.add(child.id); unavailableSessions += 1 }
        } else pending.push(child.id)
      }
    } catch (_error) {
      signal.throwIfAborted()
      unavailableSessions += 1
    }
  }
  return { models: [...models.values()], sessions, unavailableSessions }
}

/**
 * Cache hits are weighted by recorded input tokens across all models, never averaged percentages.
 * Missing usage and counters contribute zero to this display without changing recorded reports.
 * @param models - Available usage rows, including rows with incomplete reports.
 * @returns the recorded cache-read share, zero without input, or undefined when cache reads exceed input.
 */
export function conversationCacheHit(models: readonly ModelUsageRow[]): number | undefined {
  const input = models.reduce((sum, row) => sum + row.totalTokens - row.outputTokens, 0)
  const read = models.reduce((sum, row) => sum + row.cacheReadTokens, 0)
  if (read > input) return undefined
  return input > 0 ? read / input : 0
}

/**
 * Display the recorded ratio with ordinary percentage rounding.
 * @param value - Recorded cache-read share, or undefined while unavailable.
 * @returns the localized percentage, or an em dash when the rate is unavailable.
 */
export function formatCacheHit(value: number | undefined): string {
  if (value === undefined) return '—'
  return new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 }).format(value)
}
