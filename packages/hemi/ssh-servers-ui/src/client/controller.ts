/** React-free request ownership for the saved-server resource and revision-checked writes. */
import { RemoteError, type RemoteFailure, type RemoteResult, type TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import type { SshServer, SshServerInput } from '@deepseek-ai/dsh-hemi-ssh-servers/types'
import type {} from '@deepseek-ai/dsh-hemi-ssh-servers/remote'
import type { Notice, Problem, ServerDraft } from './types.ts'
import { FIELDS } from './draft.ts'

/** Generated SSH namespace, including the carrier-owned final AbortSignal argument. */
export type ServerRemote = TypertClientRemote['hemiSshServers']

/** Write results distinguish durable success, localized failure or incomplete password cleanup, and withdrawn ownership. */
export type WriteOutcome =
  | { kind: 'complete'; notice: Notice }
  | { kind: 'failed'; problem: Problem; field: keyof ServerDraft | null }
  | { kind: 'withdrawn' }

type Reader = { refresh: () => Promise<boolean> }
type Action = 'create' | 'update' | 'remove'

/** One directory controller; it owns no duplicate list cache and never changes a Session or execution target. */
export class ServerController {
  private readonly lifetime = new AbortController()
  private readonly readers = new Set<Reader>()
  private readonly pending = new Set<Promise<unknown>>()
  private writing = false
  private generation = 0

  /**
   * Bind the mounted namespace and current write grants.
   * @param remote - Mounted server namespace.
   * @param allowed - Live, locally observed global write grants.
   */
  constructor(private readonly remote: ServerRemote, private readonly allowed: (action: Action) => boolean) {}

  /**
   * Create the saved-directory resource provider.
   * @returns Provider whose reads stop with its holders or this controller.
   */
  provider(): ResourceProvider<'hemi-ssh-servers'> {
    return { protocol: 'hemi-ssh-servers', open: (_address, context) => this.follow(context.signal) }
  }

  /**
   * Reread currently held resources; failed frames retain their previous values.
   * @returns Whether every held resource refreshed successfully.
   */
  async refresh(): Promise<boolean> {
    if (this.lifetime.signal.aborted) return false
    const results = await Promise.all([...this.readers].map(reader => reader.refresh()))
    return results.every(Boolean)
  }

  /** Discard old-generation responses and reread held resources after connection recovery. */
  reset(): void {
    this.generation += 1
    void this.refresh()
  }

  /**
   * Create or revision-check a saved server entry.
   * @param server - Captured edit revision, or null for creation.
   * @param input - Validated form fields.
   * @returns Durable outcome or localized failure; a cleanup failure leaves the new connection details saved.
   */
  save(server: SshServer | null, input: SshServerInput): Promise<WriteOutcome> {
    return this.write(server === null ? 'create' : 'update', () => server === null
      ? this.remote.create(input, this.lifetime.signal)
      : this.remote.update(server.id, server.revision, input, this.lifetime.signal), 'saved', 'savedRefreshFailed')
  }

  /**
   * Remove only a revision-checked saved entry.
   * @param server - Captured removal revision.
   * @returns Durable outcome without deleting remote files; cleanup failure means the entry is removed but its password may remain.
   */
  remove(server: SshServer): Promise<WriteOutcome> {
    return this.write('remove', () => this.remote.removeServer(server.id, server.revision, this.lifetime.signal), 'removed', 'removedRefreshFailed')
  }

  /** Abort requests, stop resource streams and await already dispatched work before unmounting the namespace. */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    await Promise.allSettled([...this.pending])
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation)
    const settled = (): void => { this.pending.delete(operation) }
    void operation.then(settled, settled)
    return operation
  }

  private async *follow(holder: AbortSignal): AsyncIterable<RemoteResult<readonly SshServer[]>> {
    const signal = AbortSignal.any([holder, this.lifetime.signal])
    if (signal.aborted) return
    const frames: RemoteResult<readonly SshServer[]>[] = []
    let wake: (() => void) | undefined
    let tail = Promise.resolve(true)
    const refresh = (): Promise<boolean> => {
      tail = tail.then(async () => {
        if (signal.aborted) return false
        const generation = this.generation
        const result = await this.track(this.read(signal))
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- Cancellation can change during the awaited read.
        if (signal.aborted || generation !== this.generation) return false
        frames.push(result)
        wake?.()
        return result.ok
      })
      return tail
    }
    const reader = { refresh }
    const stop = (): void => { wake?.() }
    this.readers.add(reader)
    signal.addEventListener('abort', stop, { once: true })
    void refresh()
    try {
      while (!signal.aborted) {
        const frame = frames.shift()
        if (frame !== undefined) yield frame
        else await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      this.readers.delete(reader)
      signal.removeEventListener('abort', stop)
      await tail
    }
  }

  private async read(signal: AbortSignal): Promise<RemoteResult<readonly SshServer[]>> {
    try {
      return await this.remote.list(signal)
    } catch (error) {
      console.error('SSH server list request failed:', error)
      return { ok: false, error: new RemoteError('gateway/internal', 'Saved SSH server list is unavailable', {}) }
    }
  }

  private write<T>(action: Action, run: () => Promise<RemoteResult<T>>, saved: Notice, stale: Notice): Promise<WriteOutcome> {
    if (this.lifetime.signal.aborted || this.writing) return Promise.resolve({ kind: 'withdrawn' })
    if (!this.allowed(action)) return Promise.resolve({ kind: 'failed', problem: 'failed', field: null })
    this.writing = true
    return this.track((async (): Promise<WriteOutcome> => {
      try {
        const result = await run()
        if (this.lifetime.signal.aborted) return { kind: 'withdrawn' }
        if (!result.ok) {
          if (result.error.code !== 'hemi-ssh/credential-cleanup-failed') return classify(result.error)
          await this.refresh()
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- Disposal can occur during the awaited refresh.
          return this.lifetime.signal.aborted ? { kind: 'withdrawn' }
            : { kind: 'failed', problem: 'credentialCleanupFailed', field: null }
        }
        const refreshed = await this.refresh()
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- Disposal can occur during the awaited refresh.
        return this.lifetime.signal.aborted ? { kind: 'withdrawn' } : { kind: 'complete', notice: refreshed ? saved : stale }
      } catch (error) {
        console.error('SSH server write request failed:', error)
        return this.lifetime.signal.aborted ? { kind: 'withdrawn' } : { kind: 'failed', problem: 'failed', field: null }
      } finally {
        this.writing = false
      }
    })())
  }
}

/**
 * Classify structured failures without displaying internal diagnostics.
 * @param failure - Structured Remote failure.
 * @returns Display kind without internal messages or paths.
 */
function classify(failure: RemoteFailure): Extract<WriteOutcome, { kind: 'failed' }> {
  switch (failure.code) {
    case 'hemi-ssh/conflict': return { kind: 'failed', problem: 'conflict', field: null }
    case 'hemi-ssh/not-found': return { kind: 'failed', problem: 'notFound', field: null }
    case 'hemi-ssh/invalid-input': return {
      kind: 'failed', problem: 'invalid',
      field: failure.details.field === 'host' || failure.details.field === 'username'
        ? 'address' : FIELDS.find(field => field === failure.details.field) ?? null,
    }
    default: return { kind: 'failed', problem: 'failed', field: null }
  }
}
