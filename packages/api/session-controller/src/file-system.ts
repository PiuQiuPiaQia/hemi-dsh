/** Session-header file execution for media reads and native path verification. */
import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type {} from './types.ts'

/**
 * Retain the Session's execution services until its file operation settles.
 * Missing or unavailable explicit targets never use deployment providers.
 * @param ctx - file, Session and optional persisted-header services.
 * @param sessionId - authoritative Session identity, not a path-derived selection.
 * @param signal - caller lifetime.
 * @param operation - bounded file work using only the supplied filesystem and signal.
 * @returns the completed operation after releasing its execution lease.
 */
export async function withSessionFileSystem<T>(
  ctx: Context, sessionId: SessionId, signal: AbortSignal,
  operation: (fs: FileSystem, header: SessionHeader, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted()
  const sessions = ctx.get('sessions')
  if (sessions === undefined) throw new RemoteError('session/execution-unavailable', 'Session file access is unavailable', { sessionId })
  const header = sessions.get(sessionId)?.header ?? (await ctx.get('sessionPersistence')?.stat(sessionId, { signal }))?.header
  signal.throwIfAborted()
  if (header === undefined) throw new RemoteError('session/not-found', `session "${sessionId}" not found`, { sessionId })
  if (header.executionTarget === undefined) {
    const fs = ctx.get('fs')
    if (fs === undefined) throw new RemoteError('session/execution-unavailable', 'Session file access is unavailable', { sessionId })
    return operation(fs, header, signal)
  }
  // Hemi fork: keep the selected execution environment through cold-header reads and native mapping checks.
  const lease = await sessions.acquireExecution(header.executionTarget, signal).catch((cause: unknown) => {
    signal.throwIfAborted()
    throw new RemoteError('session/execution-unavailable', 'Reconnect the Session execution environment before accessing its files', { sessionId }, { cause })
  })
  try {
    const lifetime = AbortSignal.any([signal, lease.signal])
    lifetime.throwIfAborted()
    const fs = lease.bind(ctx).get('fs')
    if (fs === undefined) throw new RemoteError('session/execution-unavailable', 'Session file access is unavailable', { sessionId })
    const result = await operation(fs, header, lifetime)
    lifetime.throwIfAborted()
    return result
  } catch (cause: unknown) {
    if (lease.signal.aborted && !signal.aborted) throw new RemoteError('session/execution-unavailable', 'The Session execution environment disconnected; reconnect before accessing its files', { sessionId }, { cause })
    throw cause
  } finally { await lease.close() }
}
