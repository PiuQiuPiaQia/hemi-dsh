/** Automatic routing levels select offered efforts without asserting unsupported capabilities. */
import { expect, it } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { routingReasoningEffort } from '../src/reasoning.ts'

it.each(['low', 'medium', 'high', 'max'] as const)('preserves the %s level on OpenAI and Anthropic offers', (level) => {
  for (const efforts of [['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], ['low', 'medium', 'high', 'xhigh', 'max']]) {
    expect(routingReasoningEffort(level, { provider: 'fixture', id: 'model', name: 'Model',
      reasoning: { efforts: efforts.map(id => ({ id: ReasoningEffortId(id), name: id })) },
    })).toBe(level)
  }
})

it('maps maximum to xhigh when max is unavailable and omits effort for non-reasoning models', () => {
  expect(routingReasoningEffort('max', { provider: 'fixture', id: 'm', name: 'Model',
    reasoning: { efforts: ['low', 'high', 'xhigh'].map(id => ({ id: ReasoningEffortId(id), name: id })) },
  })).toBe('xhigh')
  expect(routingReasoningEffort('high', { provider: 'fixture', id: 'm', name: 'Model' })).toBeUndefined()
})
