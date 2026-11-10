/** Directory identity and leased filesystem validation, independent of Workspace bookkeeping. */
import { stat } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { ExecutionTargetUnavailableError } from '@deepseek-ai/dsh-session'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SessionExecutionTarget } from '@deepseek-ai/dsh-session'
import { fullyQualifiedWorkspacePath, realpathNormalize } from './paths.ts'

/**
 * Compare execution references without treating the deployment default as any explicit target.
 * @param left - first reference.
 * @param right - second reference.
 * @returns whether both select the same immutable environment.
 */
export function sameExecutionTarget(left: SessionExecutionTarget | undefined, right: SessionExecutionTarget | undefined): boolean {
  return left?.provider === right?.provider && left?.id === right?.id
}

/**
 * Index one directory without changing the independently generated Workspace identity.
 * @param path - canonical physical path.
 * @param executionTarget - explicit execution reference, or deployment default.
 * @returns an unambiguous private index key.
 */
export function directoryKey(path: string, executionTarget?: SessionExecutionTarget): string {
  return JSON.stringify([executionTarget?.provider ?? null, executionTarget?.id ?? null, path])
}

/** Registry-owned directory operations retain execution leases through their last filesystem use. */
export class WorkspaceDirectories {
  private readonly lifecycle = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()

  /** @param owner - registry dependency context, never an Agent or arbitrary caller shadow. */
  constructor(private readonly owner: Context) {}

  /**
   * Resolve and validate a physical existing directory in its execution environment.
   * @param path - fully qualified input path.
   * @param target - explicit execution environment.
   * @param signal - caller cancellation before the registry write.
   * @returns the canonical existing directory path.
   */
  async canonical(path: string, target?: SessionExecutionTarget, signal?: AbortSignal): Promise<string> {
    const control = this.control(signal)
    if (target === undefined) {
      const canonical = await realpathNormalize(path)
      if (!(await stat(canonical)).isDirectory()) {
        throw new FsError(`cannot create a workspace at '${canonical}': path is not a directory`, 'FS_NOT_DIRECTORY')
      }
      control.throwIfAborted()
      return canonical
    }
    if (!fullyQualifiedWorkspacePath(path)) throw new TypeError(`Workspace path is not fully qualified: '${path}'`)
    return this.withFilesystem(target, control, async (fs, active) => {
      const resolved = await fs.resolve(path, { signal: active })
      const info = await fs.stat(resolved, active)
      if (info === undefined) throw new FsError(`Workspace directory does not exist: ${path}`, 'FS_NOT_FOUND')
      if (info.type !== 'directory') throw new FsError(`Workspace path is not a directory: ${path}`, 'FS_NOT_DIRECTORY')
      active.throwIfAborted()
      return fs.processPath(resolved)
    })
  }

  /**
   * Check an existing registration without inventing a Host fallback.
   * @param path - stored canonical path.
   * @param target - stored execution reference.
   * @returns ok or missing-dir; unavailable providers and other remote failures reject.
   */
  async status(path: string, target?: SessionExecutionTarget): Promise<'ok' | 'missing-dir'> {
    if (target === undefined) {
      try { return (await stat(path)).isDirectory() ? 'ok' : 'missing-dir' }
      catch (_error: unknown) { return 'missing-dir' } // Native status preserves its existing unusable-directory semantics.
    }
    try {
      await this.canonical(path, target)
      return 'ok'
    } catch (error: unknown) {
      if (error instanceof FsError && (error.code === 'FS_NOT_FOUND' || error.code === 'FS_NOT_DIRECTORY')) return 'missing-dir'
      throw error
    }
  }

  /** Stop admission, cancel remote operations and wait before closing the Workspace domain. */
  async close(): Promise<void> {
    this.lifecycle.abort(new Error('Workspace directory owner is closing'))
    await Promise.allSettled(this.operations)
  }

  private control(signal?: AbortSignal): AbortSignal {
    const control = signal === undefined ? this.lifecycle.signal : AbortSignal.any([this.lifecycle.signal, signal])
    control.throwIfAborted()
    return control
  }

  private withFilesystem<T>(
    target: SessionExecutionTarget, signal: AbortSignal, action: (fs: FileSystem, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const operation = (async () => {
      const sessions = this.owner.get('sessions')
      if (sessions === undefined) throw new ExecutionTargetUnavailableError(target, 'provider-unavailable')
      const lease = await sessions.acquireExecution(target, signal)
      try {
        const control = AbortSignal.any([signal, lease.signal])
        control.throwIfAborted()
        const fs = lease.bind(this.owner).get('fs')
        if (fs === undefined) throw new ExecutionTargetUnavailableError(target, 'provider-unavailable')
        return await action(fs, control)
      } finally { await lease.close() }
    })()
    const settled = operation.finally(() => { this.operations.delete(settled) })
    this.operations.add(settled)
    return settled
  }
}
