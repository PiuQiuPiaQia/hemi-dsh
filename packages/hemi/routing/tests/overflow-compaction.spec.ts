import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { CONTEXT_WINDOW_EXCEEDED_CODE, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { expect, it } from 'vitest'
import * as OverflowCompaction from '../src/overflow-compaction.ts'
import { ScriptedAdapter, textResponse } from './mock-llm.ts'

const overflow: StreamChunk = {
  type: 'finish',
  reason: { kind: 'error', failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE, message: 'context exceeded' } },
}

class BudgetAdapter extends ScriptedAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, context: { contextWindow: model === 'summary' ? 2400 : 700 } }
  }
}

it('retains a committed segment when the next summary exceeds its window', async () => {
  const adapter = new BudgetAdapter([
    [overflow],
    [overflow],
    textResponse('Recovery checkpoint.'),
    [overflow],
    textResponse('Continued.'),
  ])
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(TokenMeter)
    ctx.llm.registerAdapter(['mock'], adapter)
    await ctx.plugin(BasicCompactionEngine, {
      headroomTokens: 0, retainTokens: 0, maxTokens: 64,
      summarizationProvider: 'mock', summarizationModel: 'summary',
    })
    await ctx.plugin(OverflowCompaction, { maxAttempts: 2 })

    const history = Session.create(SessionId('history'))
    history.append('turn/start', { turn: 1 })
    const seed = [0, 1, 2, 3].map(index => history.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `History ${index}: ${'work done '.repeat(260)}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' }))
    history.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const { agent } = await ctx.agentLoop.createAgent(ctx, {
      sessionId: SessionId('overflow-recovery'),
      seed: history.snapshotEvents(),
      agentOptions: { provider: 'mock', model: 'conversation' },
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue.' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests.map(request => request.model)).toEqual([
      'conversation', 'summary', 'summary', 'summary', 'conversation',
    ])
    const retry = JSON.stringify(adapter.requests.at(-1)?.messages)
    expect(retry).toContain('Recovery checkpoint.')
    expect(retry).not.toContain('History 0:')
    expect(retry).toContain('History 3:')
    expect(retry).toContain('Continue.')
    const events = agent.session.snapshotEvents()
    const summaries = events.filter(event => event.type === 'compaction/summary')
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.data.shadowedSeqs).toContain(seed[0]?.seq)
    expect(events.filter(event => event.type === 'compaction/end').map(event => event.data.error))
      .toEqual(['context exceeded', undefined, 'context exceeded'])
    expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  } finally {
    await ctx.fiber.dispose()
  }
})
