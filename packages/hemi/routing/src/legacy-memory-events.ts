/**
 * Session events the removed Hemi memory plugin published. Committed Sessions
 * still carry them, so the declarations stay here for typed readers; routing's
 * usage projection folds them read-only and no producer appends them.
 * @module @deepseek-ai/dsh-hemi-routing/legacy-memory-events
 */

import type { LlmCallConfig, RequestMessage, TokenUsage } from '@deepseek-ai/dsh-llm'
// The alias prevents the augmented module's own SessionSeq export from shadowing this import.
import type { SessionSeq as LegacySessionSeq } from '@deepseek-ai/dsh-session/types'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Exact auxiliary request sent to produce an automatic memory summary.
     */
    'hemi-memory/summary-request': {
      throughSeq: LegacySessionSeq
      config: LlmCallConfig
      system: string
      messages: RequestMessage[]
    }
    /**
     * Outcome and provider-reported usage of the preceding memory summary request.
     */
    'hemi-memory/summary-result': {
      requestSeq: LegacySessionSeq
      throughSeq: LegacySessionSeq
      outcome: 'saved' | 'empty' | 'failed'
      failure?: 'timeout' | 'model' | 'output' | 'storage'
      text: string
      usage?: TokenUsage
    }
  }
}
