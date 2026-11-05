/** Model-independent automatic routing levels mapped onto each resolved model's offer. */
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type { HemiRoutingEffort } from './types.ts'

const candidates: Record<HemiRoutingEffort, readonly string[]> = {
  low: ['low', 'minimal', 'medium', 'high', 'xhigh', 'max'],
  medium: ['medium', 'low', 'high', 'minimal', 'xhigh', 'max'],
  high: ['high', 'xhigh', 'medium', 'max', 'low', 'minimal'],
  max: ['max', 'xhigh', 'high', 'medium', 'low', 'minimal'],
}

/**
 * Choose an offered effort, keeping non-reasoning models free of effort parameters.
 * @param level - saved automatic routing level.
 * @param model - exact resolved model capabilities.
 * @returns the mapped effort, or undefined when the model offers no thinking level.
 */
export function routingReasoningEffort(level: HemiRoutingEffort, model: LlmResolvedModelInfo): string | undefined {
  const offered = new Set<string>(model.reasoning?.efforts.map(effort => effort.id))
  return candidates[level].find(effort => offered.has(effort))
    ?? model.reasoning?.efforts.find(effort => effort.id !== 'off')?.id
}
