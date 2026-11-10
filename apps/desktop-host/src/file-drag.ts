/** Resolve desktop-only file references through the active Host filesystem and Session. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path'

/** Private Host-to-main answer; never exposed to renderer JavaScript. */
export interface LocalDragResource {
  readonly path: string
  readonly sha256: string
  readonly size: number
}

/**
 * Authorize one file through its execution filesystem's actual read operations.
 * @param fs - filesystem of the Session's selected execution environment, never a Host substitute.
 * @param path - Session-scoped resource path.
 * @param header - authoritative Session header owning the execution world.
 * @param workspaceRoot - deployment workspace root for headers without a cwd.
 * @param signal - caller cancellation combined with the execution lease lifetime.
 * @returns verified Host-openable path and content identity, or null for nonlocal resources.
 */
async function authorizeDragFile(
  fs: FileSystem, path: string, header: SessionHeader, workspaceRoot: string, signal: AbortSignal,
): Promise<LocalDragResource | null> {
  signal.throwIfAborted()
  const cwd = header.cwd ?? workspaceRoot
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
 * Authorize an unmodified local file through the Session header's actual execution filesystem.
 * Headers without an explicit execution target keep the deployment's Host filesystem; a targeted
 * header reads only through its retained execution lease and never falls back to Host files.
 * @param ctx - booted Desktop Host.
 * @param address - Session-scoped resource reference.
 * @param cancellation - caller cancellation, combined with the read deadline.
 * @returns verified Host-openable path and content identity, or null for nonlocal resources.
 */
export async function localDragResource(ctx: Context, address: string, cancellation?: AbortSignal): Promise<LocalDragResource | null> {
  const resource = parseFileAddress(address)
  if (resource?.scope !== 'session') throw new Error('File drag requires a Session resource')
  const sessions = ctx.get('sessions')
  const policy = ctx.get('sandboxPolicy')
  if (sessions === undefined || policy === undefined) throw new Error('File access unavailable')
  const sessionId = resource.sessionId as SessionId
  const signal = cancellation === undefined ? AbortSignal.timeout(10_000) : AbortSignal.any([cancellation, AbortSignal.timeout(10_000)])
  signal.throwIfAborted()
  const header = sessions.get(sessionId)?.header ?? (await ctx.get('sessionPersistence')?.stat(sessionId, { signal }))?.header
  signal.throwIfAborted()
  if (header === undefined) throw new Error('File drag Session unavailable')
  if (header.executionTarget === undefined) {
    const fs = ctx.get('fs')
    if (fs === undefined) throw new Error('File access unavailable')
    return authorizeDragFile(fs, resource.path, header, policy.workspaceRoot, signal)
  }
  // Hemi fork: same-spelled Host paths are not mappings; the drag borrows a native file only when the
  // Session's own execution filesystem resolves, authorizes, and maps the resource. Mirrors
  // withSessionFileSystem in packages/api/session-controller/src/file-system.ts.
  const lease = await sessions.acquireExecution(header.executionTarget, signal).catch((cause: unknown) => {
    signal.throwIfAborted()
    throw new Error('File drag execution environment unavailable; reconnect the Session before dragging its files', { cause })
  })
  try {
    const lifetime = AbortSignal.any([signal, lease.signal])
    lifetime.throwIfAborted()
    const fs = lease.bind(ctx).get('fs')
    if (fs === undefined) throw new Error('File drag execution filesystem unavailable')
    return await authorizeDragFile(fs, resource.path, header, policy.workspaceRoot, lifetime)
  } catch (cause: unknown) {
    if (lease.signal.aborted && !signal.aborted) {
      throw new Error('File drag execution environment disconnected; reconnect the Session before dragging its files', { cause })
    }
    throw cause
  } finally { await lease.close() }
}
