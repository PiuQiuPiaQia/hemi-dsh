/** Resolve native directory handoffs without interpreting another execution world's path on the Host. */
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SessionExecutionTarget } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type { OpenInAppOpenPayload } from './shared.ts'

/** Expected HTTP refusal before a native handoff. */
export class DirectoryPathRefusal extends Error {
  constructor(readonly status: number, readonly code: string, message: string, options?: ErrorOptions) { super(message, options) }
}

/**
 * Retain the named Session or Workspace execution environment through a native operation.
 * Unscoped requests explicitly name Host paths; scoped requests require a verified Host mapping.
 * @param ctx - authoritative Session, Workspace and filesystem services.
 * @param request - wire-validated launch request.
 * @param signal - request lifetime.
 * @param operation - native directory inspection and handoff using only the verified Host path.
 * @returns the native operation's completed result, after execution lease release.
 */
export async function withDirectoryPath<T>(
  ctx: Context, request: OpenInAppOpenPayload, signal: AbortSignal,
  operation: (path: string, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted()
  if (request.sessionId === undefined && request.workspaceId === undefined) return operation(request.path, signal)
  let target: SessionExecutionTarget | undefined
  let path = request.path
  if (request.sessionId !== undefined) {
    const sessions = ctx.get('sessions')
    if (sessions === undefined) throw new DirectoryPathRefusal(503, 'environment-unavailable', 'Session file access is unavailable')
    const header = sessions.get(request.sessionId)?.header
      ?? (await ctx.get('sessionPersistence')?.stat(request.sessionId, { signal }))?.header
    if (header === undefined) throw new DirectoryPathRefusal(404, 'not-found', 'Session not found')
    target = header.executionTarget
  } else if (request.workspaceId !== undefined) {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined) throw new DirectoryPathRefusal(503, 'environment-unavailable', 'Workspace file access is unavailable')
    const workspace = registry.get(request.workspaceId)
    if (workspace === undefined) throw new DirectoryPathRefusal(404, 'not-found', 'Workspace not found')
    target = workspace.executionTarget
    path = workspace.path
  }
  const inspect = async (fs: FileSystem): Promise<T> => {
    signal.throwIfAborted()
    const hostPath = resolve(path)
    const mapped = fs.processPathFromHostPath(hostPath)
    if (mapped === undefined || fs.processPath(await fs.resolve(mapped, { signal })) !== hostPath) {
      throw new DirectoryPathRefusal(403, 'path-unavailable', 'This directory has no verified Host mapping; open it in its execution environment')
    }
    signal.throwIfAborted()
    return operation(hostPath, signal)
  }
  if (target === undefined) {
    const fs = ctx.get('fs')
    if (fs === undefined) throw new DirectoryPathRefusal(503, 'environment-unavailable', 'File access is unavailable')
    return inspect(fs)
  }
  // Hemi fork: selecting a remote directory never authorizes a same-spelled Host directory.
  const sessions = ctx.get('sessions')
  if (sessions === undefined) throw new DirectoryPathRefusal(503, 'environment-unavailable', 'Execution services are unavailable')
  const lease = await sessions.acquireExecution(target, signal).catch((cause: unknown) => {
    signal.throwIfAborted()
    throw new DirectoryPathRefusal(503, 'environment-unavailable', 'Reconnect the execution environment before opening its directory', { cause })
  })
  const caller = signal
  try {
    signal = AbortSignal.any([signal, lease.signal])
    signal.throwIfAborted()
    const fs = lease.bind(ctx).get('fs')
    if (fs === undefined) throw new DirectoryPathRefusal(503, 'environment-unavailable', 'File access is unavailable')
    return await inspect(fs)
  } catch (cause: unknown) {
    if (lease.signal.aborted && !caller.aborted) throw new DirectoryPathRefusal(503, 'environment-unavailable', 'The execution environment disconnected; reconnect before opening its directory', { cause })
    throw cause
  } finally { await lease.close() }
}
