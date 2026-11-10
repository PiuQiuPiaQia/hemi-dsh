import { expect, it, vi } from 'vitest'
import { SessionId, type SessionExecutionTarget } from '@deepseek-ai/dsh-session/types'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { nativePathSource, sessionHasNativePaths } from '../src/client/native-paths.ts'

const id = SessionId('captured')
const target = { provider: 'fixture-remote', id: 'target' } as SessionExecutionTarget
function snapshot(executionTarget?: SessionExecutionTarget): SessionListState {
  return {
    ids: [id], phase: 'ready', projectionsBySession: {}, byId: {
      [id]: { id, displayTitle: 'Captured', cwd: '/shared', updatedAt: 1, running: false, blank: false, retainedBy: {},
        ...executionTarget === undefined ? {} : { executionTarget } },
    },
  }
}

it('uses execution identity rather than the directory spelling for native actions', () => {
  expect(sessionHasNativePaths(snapshot(), id)).toBe(true)
  expect(sessionHasNativePaths(snapshot(target), id)).toBe(false)
  expect(sessionHasNativePaths(snapshot(), SessionId('unknown'))).toBe(false)
})

it('projects live metadata without a second cache or independent subscription', async () => {
  const sessions = createSnapshotStore<SessionListState>({ ids: [], byId: {}, phase: 'pending', projectionsBySession: {} })
  const source = nativePathSource(sessions, id)
  expect(source.getSnapshot()).toBe(false)
  const changed = vi.fn()
  const unsubscribe = source.subscribe(changed)
  try {
    sessions.set(snapshot())
    expect(source.getSnapshot()).toBe(true)
    await vi.waitFor(() => { expect(changed).toHaveBeenCalled() })
    sessions.set(snapshot(target))
    expect(source.getSnapshot()).toBe(false)
    const remote = source.getSnapshot()
    expect(source.getSnapshot()).toBe(remote)
  } finally { unsubscribe() }
})
