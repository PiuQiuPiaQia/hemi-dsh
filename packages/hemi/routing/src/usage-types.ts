/** Client-safe, provider-reported model usage for one session's own calls. */
import type { SessionProjectionSummaryExcluded } from '@deepseek-ai/dsh-session-projection/types'

/**
 * Provider/model usage totals and counts of available reports.
 */
export interface ModelUsageRow {
  provider: string
  model: string
  calls: number
  reportedCalls: number
  totalReports: number
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Calls with an explicit read count or a zero determined by the exact total. */
  cacheReadReports: number
  /** Calls with an explicit write count or a zero determined by the exact total. */
  cacheWriteReports: number
  reasoningTokens: number
  reasoningReports: number
  totalTokens: number
}

/**
 * Recorded model usage for one Session, excluding inherited history.
 */
export interface ModelUsageProjection {
  models: ModelUsageRow[]
}

/**
 * Aggregated Session-tree usage with unreadable branch counts.
 */
export interface ConversationUsage extends ModelUsageProjection {
  sessions: number
  unavailableSessions: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Actual own-call usage grouped by provider/model; excludes fork-inherited calls. */
    hemiModelUsage: SessionProjectionSummaryExcluded<ModelUsageProjection>
  }
}
