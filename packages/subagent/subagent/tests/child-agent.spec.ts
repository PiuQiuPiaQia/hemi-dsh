import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm/types'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { ExecutionProviderId, ExecutionTargetId } from '@deepseek-ai/dsh-session'
import { childSessionMeta, resolveChildAgentOptions, resolveChildDepth } from '../src/child-agent.ts'

function parentAgent(): Agent {
  const id = brandString<SessionId>('parent')
  return {
    id,
    options: {
      provider: 'parent-provider',
      model: 'parent-model',
      reasoningEffort: brandString<ReasoningEffortId>('high'),
      maxTokens: 512,
    },
    session: Session.create(id),
  } as Agent
}

describe('child Agent options', () => {
  it('inherits the execution environment even when the child selects another preset', () => {
    const id = SessionId('remote-parent')
    const executionTarget = { provider: 'ssh' as ExecutionProviderId, id: 'folder-1' as ExecutionTargetId }
    const parent = { ...parentAgent(), session: Session.create(id, undefined, {
      version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false, cwd: '/project', executionTarget,
    }) }
    expect(childSessionMeta(parent, 1, false, 'oracle')).toMatchObject({
      executionTarget, cwd: '/project', agentPreset: 'oracle', parentSession: id,
    })
  })

  it('inherits the parent effort when no route is supplied', () => {
    expect(resolveChildAgentOptions(parentAgent(), undefined, 1)).toEqual({
      provider: 'parent-provider',
      model: 'parent-model',
      reasoningEffort: 'high',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('clears parent effort through an explicit undefined override', () => {
    const parent = parentAgent()
    const child = resolveChildAgentOptions(parent, {
      provider: 'parent-provider', model: 'parent-model', reasoningEffort: undefined,
    }, 1)
    expect(child.reasoningEffort).toBeUndefined()
    expect(parent.options.reasoningEffort).toBe('high')
  })

  it('inherits compatible effort when only one route field is overridden', () => {
    expect(resolveChildAgentOptions(parentAgent(), { model: 'parent-model' }, 1).reasoningEffort).toBe('high')
  })

  it('clears an inherited effort when the child route changes', () => {
    expect(resolveChildAgentOptions(parentAgent(), { model: 'child-model' }, 1)).toEqual({
      provider: 'parent-provider',
      model: 'child-model',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('keeps an explicit child effort when the child route changes', () => {
    expect(resolveChildAgentOptions(parentAgent(), {
      provider: 'child-provider',
      model: 'child-model',
      reasoningEffort: brandString<ReasoningEffortId>('max'),
    }, 1)).toEqual({
      provider: 'child-provider',
      model: 'child-model',
      reasoningEffort: 'max',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('inherits the latest logged request selection over creation-time values', () => {
    const parent = parentAgent()
    parent.session.append('request/header', {
      header: {
        config: {
          provider: 'current-provider',
          model: 'current-model',
          reasoningEffort: brandString<ReasoningEffortId>('low'),
        },
      },
      reason: 'initial',
    })

    expect(resolveChildAgentOptions(parent, undefined, 1)).toEqual({
      provider: 'current-provider',
      model: 'current-model',
      reasoningEffort: 'low',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })
})

describe('delegation depth limits', () => {
  it.each([-1, -0, 0.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects an invalid runtime depth %s', (depth) => {
    const parent = parentAgent()
    parent.options.subagentDepth = depth
    expect(() => resolveChildDepth(parent, undefined)).toThrow(expect.objectContaining({
      name: 'SubagentError', code: 'INVALID_DEPTH', message: 'agent subagentDepth must be a non-negative safe integer',
    }))
  })

  it('rejects a child depth beyond the exact integer range', () => {
    const parent = parentAgent()
    parent.options.subagentDepth = Number.MAX_SAFE_INTEGER
    expect(() => resolveChildDepth(parent, undefined)).toThrow(expect.objectContaining({
      name: 'SubagentError', code: 'INVALID_DEPTH', message: 'subagent child depth exceeds the safe-integer range',
    }))
  })
})
