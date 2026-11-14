/** Effect-owned execution registrations and leases, independent of Agent scope creation. */
import type { Context } from '@deepseek-ai/cordis'
import type { ExecutionProviderId, SessionExecutionTarget } from './types.ts'
import type { AgentExecutionLease, AgentExecutionProvider } from './execution-types.ts'

/** A recorded execution environment cannot be supplied; the caller must not fall back. */
export class ExecutionTargetUnavailableError extends Error {
  /** Stable identity for unavailable explicit execution targets. */
  readonly code = 'EXECUTION_TARGET_UNAVAILABLE'

  // Hemi fork: execution providers can report a failed connection without losing its cause.
  constructor(
    readonly target: SessionExecutionTarget,
    readonly reason: 'provider-unavailable' | 'provider-withdrawn' | 'acquisition-failed',
    options?: ErrorOptions,
  ) {
    super(`execution target is unavailable: ${target.provider}/${target.id} (${reason})`, options)
    this.name = 'ExecutionTargetUnavailableError'
  }
}

interface RetainedLease {
  readonly released: Promise<void>
}

interface ProviderEntry {
  readonly provider: AgentExecutionProvider
  readonly lifetime: AbortController
  readonly leases: Set<RetainedLease>
  readonly pending: Set<Promise<void>>
  readonly failures: unknown[]
  readonly reportCleanupFailure: (error: unknown) => void
}

/** Registry owned by SessionStore; registrations retain their provider until leases drain. */
export class ExecutionProviders {
  private readonly entries = new Map<ExecutionProviderId, ProviderEntry>()

  /**
   * Add a provider in the registering fiber's lifetime.
   * @param ctx - caller-bound registration owner.
   * @param id - provider's durable identity.
   * @param provider - acquisition implementation.
   * @returns the exact effect disposer; withdrawal aborts consumers before awaiting their leases.
   */
  register(ctx: Context, id: ExecutionProviderId, provider: AgentExecutionProvider): () => Promise<void> {
    return ctx.effect(() => {
      if (this.entries.has(id)) throw new Error(`execution provider is already registered: ${id}`)
      const entry: ProviderEntry = {
        provider, lifetime: new AbortController(), leases: new Set(), pending: new Set(), failures: [],
        reportCleanupFailure: (error) => { ctx.logger.warn(`execution provider "${id}": late lease cleanup failed: ${String(error)}`) },
      }
      this.entries.set(id, entry)
      return async () => {
        this.entries.delete(id)
        entry.lifetime.abort(new Error(`execution provider was withdrawn: ${id}`))
        await Promise.all(entry.pending)
        await Promise.all([...entry.leases].map(lease => lease.released))
        if (entry.failures.length > 0) throw new AggregateError(entry.failures, `execution provider cleanup failed: ${id}`)
      }
    }, `sessions.executionProvider(${id})`)
  }

  /**
   * Acquire through an exact registered provider; cancellation does not retain the caller.
   * @param target - validated immutable Session or Workspace reference.
   * @param signal - operation owner cancellation.
   * @returns the retained lease; the caller must await close after its consumers settle.
   */
  acquire(target: SessionExecutionTarget, signal: AbortSignal): Promise<AgentExecutionLease> {
    signal.throwIfAborted()
    const entry = this.entries.get(target.provider)
    if (entry === undefined) return Promise.reject(new ExecutionTargetUnavailableError(target, 'provider-unavailable'))
    const lifetime = AbortSignal.any([signal, entry.lifetime.signal])
    const result = Promise.withResolvers<AgentExecutionLease>()
    const settled = Promise.withResolvers<void>()
    entry.pending.add(settled.promise)
    const onAbort = (): void => { result.reject(lifetime.reason) }
    lifetime.addEventListener('abort', onAbort, { once: true })
    if (lifetime.aborted) onAbort()
    void Promise.resolve().then(() => {
      lifetime.throwIfAborted()
      return entry.provider.acquire(target.id, lifetime)
    }).then(async (raw) => {
      if (lifetime.aborted) {
        try { await raw.close() } catch (error: unknown) {
          entry.failures.push(error)
          entry.reportCleanupFailure(error)
        }
        return
      }
      const released = Promise.withResolvers<void>()
      const retained: RetainedLease = { released: released.promise }
      const closing = new AbortController()
      const leaseSignal = AbortSignal.any([lifetime, raw.signal, closing.signal])
      let disposal: Promise<void> | undefined
      const lease: AgentExecutionLease = {
        realm: raw.realm,
        signal: leaseSignal,
        bind(base) {
          leaseSignal.throwIfAborted()
          return raw.bind(base)
        },
        close: () => disposal ??= Promise.resolve().then(async () => {
          closing.abort(new Error('execution lease was released'))
          try { await raw.close() } catch (error: unknown) {
            entry.failures.push(error)
            throw error
          } finally {
            entry.leases.delete(retained)
            released.resolve()
          }
        }),
      }
      entry.leases.add(retained)
      result.resolve(lease)
    }, (error: unknown) => { result.reject(error) }).finally(() => {
      lifetime.removeEventListener('abort', onAbort)
      entry.pending.delete(settled.promise)
      settled.resolve()
    })
    return result.promise
  }
}
