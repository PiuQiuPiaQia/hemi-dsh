/**
 * Bind-group pooling for the mobile TLS listener: one factory-built listener
 * per candidate LAN address of one start, all sharing one port and one
 * certificate. The pool owns bind order, port sharing, rollback, and
 * teardown only; admission, credentials, and the service group epoch stay
 * with the caller.
 */

import type { MobileTlsMaterial } from './internal/tls.ts'

/**
 * One pooled listener member; {@link MobileTlsListener} satisfies this
 * without changes, so the service factory constructs real listeners.
 */
export interface PoolListener {
  /**
   * Bind one address with the given TLS material.
   * @param host - concrete IPv4 address to bind.
   * @param port - requested port; 0 asks the OS to assign one.
   * @param tls - certificate and key covering `host` as a SAN.
   * @throws the underlying listen error, so the pool can classify it.
   */
  start(host: string, port: number, tls: MobileTlsMaterial): Promise<void>
  /** Close the listener and every connection it tracks; idempotent, and valid after a failed bind. */
  stop(): Promise<void>
  /** The bound port while listening. */
  readonly port?: number | undefined
  /** The listener origin `https://<IPv4>:<port>` while listening. */
  readonly listenerOrigin?: string | undefined
}

/** Group lifecycle: idle, one start in flight, serving, or closed forever. */
type PoolPhase = 'idle' | 'starting' | 'running' | 'retired'

/**
 * Whether a member bind failure means the address left this Host — a stale
 * candidate to skip — rather than an unusable port or listener.
 * @param error - the rejection from `PoolListener.start`.
 * @returns true for `EADDRNOTAVAIL` and `ENETDOWN` rejections.
 */
function isAbsentAddressFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EADDRNOTAVAIL' || code === 'ENETDOWN'
}

/**
 * One single-use bind group of {@link PoolListener}s. One instance serves
 * exactly one group: a second {@link start}, or any start after {@link stop}
 * or after a failed start, is refused, and the service constructs a new pool
 * for the next group. Every constructed member stays owned until its stop
 * succeeds; a member that fails to close stays owned for the next stop.
 */
export class MobileListenerPool {
  private phase: PoolPhase = 'idle'
  private starting: Promise<void> | undefined
  private members: PoolListener[] = []
  private boundPort: number | undefined
  private primaryOrigin: string | undefined
  private readonly boundOrigins: string[] = []

  /**
   * @param factory - constructs one listener per candidate address; the
   * service passes `() => new MobileTlsListener(deps)`.
   */
  constructor(private readonly factory: () => PoolListener) {}

  /** The port every member of the running group shares, or undefined while not running. */
  get port(): number | undefined {
    return this.boundPort
  }

  /** The first successfully bound member's origin, or undefined while not running. */
  get listenerOrigin(): string | undefined {
    return this.primaryOrigin
  }

  /** Every bound member's origin in bind order; empty while not running. */
  get origins(): readonly string[] {
    return this.boundOrigins
  }

  /**
   * Bind the deduplicated candidate addresses in order on one shared port:
   * the first successful bind with `port` 0 reads the OS-assigned port from
   * that member, every later member binds the same port and must report it
   * back, and each member — skipped, bound, or failed — is stopped before
   * the group ends. A candidate failing with `EADDRNOTAVAIL` or `ENETDOWN`
   * is skipped; any other failure, a mismatched reported port, or binding
   * zero candidates rolls the group back.
   * @param hosts - candidate IPv4 addresses; duplicates bind once.
   * @param port - requested port; 0 asks the OS to assign one.
   * @param tls - certificate and key covering every candidate as SANs.
   * @throws the triggering failure once every member closed; a rollback
   * cleanup error, carrying the triggering failure and the close failures
   * under `cause`, while members remain open; or a zero-success error whose
   * `cause` is the last skipped failure.
   */
  async start(hosts: readonly string[], port: number, tls: MobileTlsMaterial): Promise<void> {
    if (this.phase === 'starting' || this.phase === 'running') {
      throw new Error('mobile-access: listener pool is already started')
    }
    if (this.phase === 'retired') {
      throw new Error('mobile-access: listener pool is retired')
    }
    this.phase = 'starting'
    const bind = this.bindMembers([...new Set(hosts)], port, tls)
    this.starting = bind
    try {
      await bind
    } catch (error) {
      this.phase = 'retired'
      throw error
    } finally {
      this.starting = undefined
    }
    // A stop that retired the pool mid-bind owns the final phase.
    this.publishStarted()
  }

  /**
   * Retire the group synchronously, then close every owned member and await
   * the closures. A start still in flight settles first, so stop never races
   * a member it has not seen; that start's rejection stays with its caller
   * because rollback has already closed everything it could. Idempotent, and
   * valid before any start.
   * @throws an error whose `cause` lists the close failures, leaving the
   * unclosed members owned so a repeated stop retries them.
   */
  async stop(): Promise<void> {
    this.phase = 'retired'
    const starting = this.starting
    if (starting !== undefined) {
      // A failed bind has already rolled every member back; its rejection stays with the start caller.
      await starting.catch(() => undefined)
    }
    this.unpublish()
    const closeFailures = await this.closeMembers([...this.members])
    if (closeFailures.length > 0) {
      throw new Error('mobile-access: listener pool stop left a member open', { cause: closeFailures })
    }
  }

  /** A concurrent stop owns retirement even when a prior bind finishes later. */
  private publishStarted(): void {
    if (this.phase === 'starting') this.phase = 'running'
  }

  /** Bind each candidate in order, publishing each member's facts at its own bind. */
  private async bindMembers(hosts: readonly string[], port: number, tls: MobileTlsMaterial): Promise<void> {
    let lastSkip: unknown
    for (const host of hosts) {
      const member = this.factory()
      this.members.push(member)
      try {
        await member.start(host, this.boundPort ?? port, tls)
      } catch (error) {
        if (isAbsentAddressFailure(error)) {
          lastSkip = error
          // The never-bound listener still converges; stop is a no-op after a failed bind.
          await this.closeMembers([member])
          continue
        }
        throw await this.rollback(error)
      }
      const boundPort = member.port
      const origin = member.listenerOrigin
      /* v8 ignore next 3 -- a started listener always reports its port and origin. */
      if (boundPort === undefined || origin === undefined) {
        throw await this.rollback(new Error('mobile-access: pool member bound without a port or origin'))
      }
      if (this.boundPort === undefined) {
        this.boundPort = boundPort
        this.primaryOrigin = origin
      } else if (boundPort !== this.boundPort) {
        throw await this.rollback(new Error(`mobile-access: pool member bound port ${String(boundPort)}, expected ${String(this.boundPort)}`))
      }
      this.boundOrigins.push(origin)
    }
    if (this.boundOrigins.length === 0) {
      throw new Error('mobile-access: no candidate address could be bound', lastSkip === undefined ? {} : { cause: lastSkip })
    }
  }

  /**
   * Unpublish the group, close every owned member, and report which error
   * the failed start rejects with.
   * @param failure - the failure that triggered the rollback.
   * @returns `failure` once every member closed; otherwise a cleanup error
   * carrying the failure and the close failures under `cause`, with the
   * unclosed members still owned for the next stop.
   */
  private async rollback(failure: unknown): Promise<unknown> {
    this.unpublish()
    const closeFailures = await this.closeMembers([...this.members])
    if (closeFailures.length > 0) {
      return new Error('mobile-access: listener pool rollback left a member open', { cause: { bind: failure, close: closeFailures } })
    }
    return failure
  }

  /**
   * Stop the given owned members and drop each one that closed; a member
   * whose stop failed stays owned so a later close retries it.
   * @param targets - owned members to close now.
   * @returns the close failures that occurred.
   */
  private async closeMembers(targets: readonly PoolListener[]): Promise<unknown[]> {
    const closed: PoolListener[] = []
    const failures: unknown[] = []
    await Promise.all(targets.map(async (member) => {
      try {
        await member.stop()
        closed.push(member)
      } catch (error) {
        failures.push(error)
      }
    }))
    const closedSet = new Set(closed)
    this.members = this.members.filter(member => !closedSet.has(member))
    return failures
  }

  /** Stop advertising the group's port and origins; members stay owned until closed. */
  private unpublish(): void {
    this.boundPort = undefined
    this.primaryOrigin = undefined
    this.boundOrigins.length = 0
  }
}
