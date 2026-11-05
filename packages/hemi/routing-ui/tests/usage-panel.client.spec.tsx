// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_CHAT_SNAPSHOT, type ChatConversationViewNode, type ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import { HemiTurnUsage } from '../src/client/usage/UsagePanel.tsx'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

type Props = Parameters<typeof HemiTurnUsage>[0]

function tool(id: string, kind: 'activation' | 'result', native: boolean): ChatConversationViewNode {
  return {
    kind: 'tool-call',
    key: id, id, target: 'chat', anchorSeq: 0, visibility: 'visible', location: { kind: 'session' },
    data: { root: { kind: 'tool-result', name: native ? 'subagent' : 'hemi_delegate', isError: false,
      meta: native ? { kind: 'activation', subagentId: id, agentPreset: 'fixer', completed: kind === 'result' }
        : { kind, subagentId: id, role: 'fixer' } } },
  }
}

function props(loadChildUsage: Props['loadChildUsage'], native: boolean): Props {
  const nodes = new Map([
    ['sync', tool('sync', 'result', native)],
    ['duplicate', tool('sync', 'result', native)],
    ['background', tool('background', 'activation', native)],
  ])
  const snapshot: ChatSnapshot = {
    ...EMPTY_CHAT_SNAPSHOT,
    nodes: { ...EMPTY_CHAT_SNAPSHOT.nodes, get: key => nodes.get(key) },
    locations: { ...EMPTY_CHAT_SNAPSHOT.locations, getTurn: () => [...nodes.keys()] },
  }
  return {
    turn: 6,
    useChat: select => select(snapshot),
    loadChildUsage,
    usage: { uncachedInputTokens: 3334, outputTokens: 1283, totalTokens: 138889 },
    t: makeTranslate(zh),
  } as Props
}

describe.each([false, true])('role usage (native=%s)', (native) => {
  it('adds a synchronous child once and retains the unsplit cache breakdown', async () => {
    const load = vi.fn(async () => ({
      uncachedInputTokens: 57211, outputTokens: 8376, cacheReadTokens: 514944, cacheWriteTokens: 0,
    }))
    render(<HemiTurnUsage {...props(load, native)} />)
    expect(load).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '本轮用量' }))
    const panel = within(screen.getByRole('dialog'))
    expect(panel.getByText('缓存（读写未拆分）')).toBeTruthy()
    expect(panel.getByText('134,272')).toBeTruthy()
    expect(await panel.findByText('719,420')).toBeTruthy()
    expect(panel.getByText('580,531')).toBeTruthy()
    expect(load).toHaveBeenCalledExactlyOnceWith('sync', expect.any(AbortSignal))
  })

  it('keeps the parent figures when the child usage is unavailable', async () => {
    render(<HemiTurnUsage {...props(async () => undefined, native)} />)
    fireEvent.click(screen.getByRole('button', { name: '本轮用量' }))
    const panel = within(screen.getByRole('dialog'))
    expect(await panel.findByText('暂无用量')).toBeTruthy()
    expect(panel.getByText('138,889')).toBeTruthy()
    expect(panel.queryByText('已记录合计')).toBeNull()
  })

})
