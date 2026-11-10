// Hemi fork: native action presentation needs execution metadata before offering deployment-only path operations.
/** Native controls only address the deployment filesystem; explicit execution targets keep their paths in that environment. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

/**
 * Read a known Session's eligibility for deployment-native path controls; unknown metadata is not local access.
 * @param sessions - authoritative Client Session summary snapshot.
 * @param sessionId - captured Session identity, never inferred from a directory path.
 * @returns true only for a known default-environment Session.
 */
export function sessionHasNativePaths(sessions: SessionListState, sessionId: SessionId): boolean {
  const session = sessions.byId[sessionId]
  return session !== undefined && session.executionTarget === undefined
}

/**
 * Project native-control eligibility through the existing Session source without caching its metadata.
 * @param sessions - existing Client Session source.
 * @param sessionId - the contribution's captured Session identity.
 * @returns a narrow observable for framework hook injection, retaining no independent subscription.
 */
export function nativePathSource(
  sessions: ObservableSnapshot<SessionListState>, sessionId: SessionId,
): ObservableSnapshot<boolean> {
  return {
    getSnapshot: () => sessionHasNativePaths(sessions.getSnapshot(), sessionId),
    subscribe: listener => sessions.subscribe(listener),
  }
}
