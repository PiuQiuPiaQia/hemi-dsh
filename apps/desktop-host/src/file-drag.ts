/** Resolve desktop-only file references through the active Host filesystem and Session. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-workspace-files'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path'

/** Private Host-to-main answer; never exposed to renderer JavaScript. */
export interface LocalDragResource {
  readonly path: string
  readonly sha256: string
  readonly size: number
}

/**
 * Authorize an unmodified local file through one filesystem's actual read operations.
 * @param fs - filesystem of the Session's execution environment, never a Host substitute for a targeted Session.
 * @param path - Session-scoped resource path, resolved from the Session's workspace root.
 * @param cwd - workspace root the workspace file service resolved for the Session.
 * @param signal - caller cancellation combined with the read deadline and, for a targeted Session, the execution lease lifetime.
 * @returns verified Host-openable path and content identity, or null for nonlocal resources.
 */
async function authorizeDragFile(
  fs: FileSystem, path: string, cwd: string, signal: AbortSignal,
): Promise<LocalDragResource | null> {
  signal.throwIfAborted()
  const entry = await fs.lstat(path, { cwd }, signal)
  if (entry?.type !== 'file') return null
  const target = await fs.resolve(path, { cwd, signal })
  const processPath = fs.processPath(target)
  const mapped = fs.processPathFromHostPath(processPath)
  if (mapped === undefined) return null
  const roundTrip = await fs.resolve(mapped, { signal })
  if (roundTrip.targetKey !== target.targetKey) return null
  const info = await fs.stat(target, signal)
  if (info?.type !== 'file' || info.size === undefined) return null
  const hash = createHash('sha256')
  let size = 0
  while (size < info.size) {
    signal.throwIfAborted()
    const data = await fs.readByteRange(target, { offset: size, length: Math.min(64 * 1024, info.size - size) }, signal)
    if (data.length === 0) return null
    hash.update(data)
    size += data.length
  }
  // Even empty files require a read authorization check.
  if (size === 0) await fs.readByteRange(target, { offset: 0, length: 1 }, signal)
  const after = await fs.stat(target, signal)
  signal.throwIfAborted()
  if (after?.version !== info.version || after.size !== size) return null
  return { path: processPath, size, sha256: hash.digest('hex') }
}

/**
 * Authorize an unmodified local file through the composed filesystem's actual read operations.
 * Relative paths resolve from the same workspace root the workspace file service uses for the Session.
 * @param ctx - booted Desktop Host.
 * @param address - Session-scoped resource reference.
 * @param cancellation - caller cancellation, combined with the read deadline.
 * @returns verified Host-local path and content identity, or null for nonlocal resources.
 */
export async function localDragResource(ctx: Context, address: string, cancellation?: AbortSignal): Promise<LocalDragResource | null> {
  const resource = parseFileAddress(address)
  if (resource?.scope !== 'session') throw new Error('File drag requires a Session resource')
  const fs = ctx.get('fs')
  const workspaceFiles = ctx.get('workspaceFiles')
  if (fs === undefined || workspaceFiles === undefined) throw new Error('File access unavailable')
  const signal = cancellation === undefined ? AbortSignal.timeout(10_000) : AbortSignal.any([cancellation, AbortSignal.timeout(10_000)])
  signal.throwIfAborted()
  const scope = await workspaceFiles.scopeOf(resource.sessionId as SessionId, signal)
  if (scope === undefined) throw new Error('File drag Session unavailable')
  const cwd = scope.workspaceRoot
  // Hemi fork: same-spelled Host paths are not mappings; a Session with an explicit execution target borrows a
  // native file only when its own execution filesystem resolves, authorizes, and maps the resource. Mirrors the
  // scoped read binding in packages/api/workspace-files/src/index.ts.
  if (scope.executionTarget === undefined) return authorizeDragFile(fs, resource.path, cwd, signal)
  const sessions = ctx.get('sessions')
  if (sessions === undefined) throw new Error('File access unavailable')
  const lease = await sessions.acquireExecution(scope.executionTarget, signal).catch((cause: unknown) => {
    signal.throwIfAborted()
    throw new Error('File drag execution environment unavailable; reconnect the Session before dragging its files', { cause })
  })
  try {
    const lifetime = AbortSignal.any([signal, lease.signal])
    lifetime.throwIfAborted()
    const executionFs = lease.bind(ctx).get('fs')
    if (executionFs === undefined) throw new Error('File drag execution filesystem unavailable')
    return await authorizeDragFile(executionFs, resource.path, cwd, lifetime)
  } catch (cause: unknown) {
    if (lease.signal.aborted && !signal.aborted) {
      throw new Error('File drag execution environment disconnected; reconnect the Session before dragging its files', { cause })
    }
    throw cause
  } finally { await lease.close() }
}
