/**
 * Reject the summary that still contains the recorded runtime-context message.
 * Smaller requests consume the normal recorded replay entries.
 */

import type { Context } from '@deepseek-ai/cordis'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

/** Loader entry for the segmented compaction snapshot. */
export const name = 'compaction-summary-overflow'

/** Install the scenario's deterministic summary rejection. @param ctx - fixture context. */
export function apply(ctx: Context): void {
  ctx.on('llm/stream', (options, next) => {
    if (options.purpose !== 'compaction' || !options.messages.some(message => message.content.some(
      block => block.type === 'text' && block.text.startsWith('Current runtime context.'),
    ))) return next()
    return rejectSummary()
  }, { prepend: true })
}

async function* rejectSummary(): AsyncIterable<StreamChunk> {
  yield {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: { message: 'snapshot summary exceeded the model context window', code: CONTEXT_WINDOW_EXCEEDED_CODE },
    },
  }
}
