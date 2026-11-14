/** React-free phone management requests; resource holders own polling and cancellation. */
import { RemoteError, type RemoteFailure, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import type { MobileAccessRemote, MobileAccessState, MobileDeviceId, MobileRequestId } from '../types.ts'
import type { CommandOutcome, MobileProblem, MobileResourceView } from './types.ts'

/** One resource address; the settings section is its only production holder. */
export const MOBILE_ADDRESS = 'dsh-resource://hemi-mobile-access/settings'

type Reader = {
  signal: AbortSignal
  refresh: () => void
  publish: (frame: RemoteResult<MobileResourceView>) => void
}

/** One mounted namespace's commands and live reads; invitation secrets are never retained here. */
export class MobileController {
  private readonly lifetime = new AbortController()
  private readonly readers = new Set<Reader>()
  private readonly pending = new Set<Promise<unknown>>()
  private generation = 0
  private writing = false

  /** @param remote - The mounted, generated phone management namespace. */
  constructor(private readonly remote: MobileAccessRemote) {}

  /**
   * Expose settings reads through the resource lifecycle.
   * @returns A provider that reads only while a settings component holds its resource.
   */
  provider(): ResourceProvider<'hemi-mobile-access'> {
    return { protocol: 'hemi-mobile-access', open: (_address, { signal }) => this.follow(signal) }
  }

  /** Refresh only active holders; this never opens a background settings reader. */
  refresh(): void { for (const reader of this.readers) reader.refresh() }

  /** Discard earlier reads after transport recovery, then refresh active holders. */
  reset(): void { this.generation += 1; this.refresh() }

  /**
   * Start the current desktop's listener and generate a single-use invitation.
   * @returns Confirmed state, invitation failure after a successful start, or an unconfirmed outcome.
   */
  start(): Promise<CommandOutcome> {
    return this.write(async (signal) => {
      const result = await this.remote.start(signal)
      if (signal.aborted) return { kind: 'withdrawn' }
      if (!result.ok) return this.failed(result.error)
      this.publish(result.value)
      if (!result.value.listening) return { kind: 'failed', problem: 'unknown' }
      const cancelled = (): boolean => signal.aborted
      const invitation = await this.remote.createInvitation(signal)
      if (cancelled()) return { kind: 'withdrawn' }
      if (!invitation.ok) return { kind: 'failed', problem: 'invitationFailed' }
      this.publish(invitation.value.state)
      return { kind: 'complete', invitation: invitation.value.invitation }
    })
  }

  /**
   * Close the phone listener without removing pairings or stopping Agent tasks.
   * @returns Success only after the Host returns a state with its listener closed.
   */
  stop(): Promise<CommandOutcome> {
    return this.stateCommand(signal => this.remote.stop(signal), state => !state.listening)
  }

  /**
   * Generate a single-use invitation without retaining its token in the controller.
   * @returns A fresh invitation for local component state; failed generation leaves prior display data intact.
   */
  createInvitation(): Promise<CommandOutcome> {
    return this.write(async (signal) => {
      const result = await this.remote.createInvitation(signal)
      if (signal.aborted) return { kind: 'withdrawn' }
      if (!result.ok) return this.failed(result.error)
      this.publish(result.value.state)
      return { kind: 'complete', invitation: result.value.invitation }
    })
  }

  /**
   * Approve a request only after explicit user comparison in the component.
   * @param requestId - Opaque Host request identity.
   * @param code - The six-digit code shown on both devices.
   * @returns Success only when the authoritative request is approved.
   */
  approve(requestId: MobileRequestId, code: string): Promise<CommandOutcome> {
    return this.stateCommand(signal => this.remote.approve(requestId, code, signal), state =>
      state.requests.some(request => request.requestId === requestId && request.status === 'approved'))
  }

  /**
   * Reject one pending request.
   * @param requestId - Opaque Host request identity.
   * @returns Success only when the authoritative request is rejected.
   */
  reject(requestId: MobileRequestId): Promise<CommandOutcome> {
    return this.stateCommand(signal => this.remote.reject(requestId, signal), state =>
      state.requests.some(request => request.requestId === requestId && request.status === 'rejected'))
  }

  /**
   * Revoke one paired device without changing active Agent tasks.
   * @param deviceId - Opaque Host device identity.
   * @returns Success only when the authoritative device list omits the device.
   */
  revoke(deviceId: MobileDeviceId): Promise<CommandOutcome> {
    return this.stateCommand(signal => this.remote.revoke(deviceId, signal), state =>
      !state.devices.some(device => device.deviceId === deviceId))
  }

  /** Abort holders and requests, then join admitted work before unmounting the Remote namespace. */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    await Promise.allSettled([...this.pending])
  }

  private stateCommand(run: (signal: AbortSignal) => Promise<RemoteResult<MobileAccessState>>,
    confirmed: (state: MobileAccessState) => boolean): Promise<CommandOutcome> {
    return this.write(async (signal) => {
      const result = await run(signal)
      if (signal.aborted) return { kind: 'withdrawn' }
      if (!result.ok) return this.failed(result.error)
      this.publish(result.value)
      return confirmed(result.value) ? { kind: 'complete', invitation: null } : { kind: 'failed', problem: 'unknown' }
    })
  }

  private failed(error: RemoteFailure): CommandOutcome {
    if (error.code === 'hemi-mobile/unauthorized') this.deny()
    return { kind: 'failed', problem: classify(error) }
  }

  private deny(): void {
    this.generation += 1
    for (const reader of this.readers) reader.publish({ ok: true, value: { kind: 'unauthorized' } })
  }

  private publish(state: MobileAccessState): void {
    if (this.lifetime.signal.aborted) return
    this.generation += 1
    for (const reader of this.readers) reader.publish({ ok: true, value: { kind: 'state', state } })
  }

  private track<T>(request: Promise<T>): Promise<T> {
    this.pending.add(request)
    const settled = (): void => { this.pending.delete(request) }
    void request.then(settled, settled)
    return request
  }

  private write(run: (signal: AbortSignal) => Promise<CommandOutcome>): Promise<CommandOutcome> {
    const reader = [...this.readers].find(reader => !reader.signal.aborted)
    if (this.lifetime.signal.aborted || this.writing || reader === undefined) return Promise.resolve({ kind: 'withdrawn' })
    this.writing = true
    this.generation += 1
    return this.track((async (): Promise<CommandOutcome> => {
      try {
        const outcome = await run(reader.signal)
        return reader.signal.aborted ? { kind: 'withdrawn' } : outcome
      } catch (_error: unknown) {
        // Carrier errors can leave a dispatched mutation committed; never turn uncertainty into success.
        return reader.signal.aborted ? { kind: 'withdrawn' } : { kind: 'failed', problem: 'unknown' }
      } finally {
        this.writing = false
        this.refresh()
      }
    })())
  }

  private async *follow(holder: AbortSignal): AsyncIterable<RemoteResult<MobileResourceView>> {
    const signal = AbortSignal.any([holder, this.lifetime.signal])
    if (signal.aborted) return
    const frames: RemoteResult<MobileResourceView>[] = []
    let wake: (() => void) | undefined
    let activeRead: Promise<void> | undefined
    let again = false
    const needsRead = (): boolean => again
    const publish: Reader['publish'] = (frame) => {
      if (signal.aborted) return
      frames.splice(0, frames.length, frame)
      wake?.()
    }
    const refresh = (): void => {
      if (signal.aborted || this.writing) return
      if (activeRead !== undefined) { again = true; return }
      activeRead = this.track((async () => {
        do {
          again = false
          const generation = this.generation
          const result = await this.read(signal)
          if (!signal.aborted && generation === this.generation) publish(result)
        } while (needsRead() && !signal.aborted && !this.writing)
      })().finally(() => { activeRead = undefined }))
    }
    const reader: Reader = { signal, refresh, publish }
    const stop = (): void => { wake?.() }
    this.readers.add(reader)
    const timer = setInterval(refresh, 1000)
    signal.addEventListener('abort', stop, { once: true })
    refresh()
    try {
      while (!signal.aborted) {
        const frame = frames.shift()
        if (frame !== undefined) yield frame
        else await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      clearInterval(timer)
      this.readers.delete(reader)
      signal.removeEventListener('abort', stop)
      await activeRead
    }
  }

  private async read(signal: AbortSignal): Promise<RemoteResult<MobileResourceView>> {
    try {
      const result = await this.remote.getState(signal)
      if (result.ok) return { ok: true, value: { kind: 'state', state: result.value } }
      if (result.error.code === 'hemi-mobile/unauthorized') return { ok: true, value: { kind: 'unauthorized' } }
      return result
    } catch (_error: unknown) {
      // Do not log exceptions: the same namespace carries invitation secrets and private Host details.
      return { ok: false, error: new RemoteError('gateway/internal', 'Phone connection state is unavailable', {}) }
    }
  }
}

function classify(error: RemoteFailure): MobileProblem {
  switch (error.code) {
    case 'hemi-mobile/unauthorized': return 'localOnly'
    case 'hemi-mobile/no-network': return 'noNetwork'
    case 'hemi-mobile/not-listening': return 'notListening'
    case 'hemi-mobile/request-not-found': return 'requestGone'
    case 'hemi-mobile/wrong-code': return 'wrongCode'
    case 'hemi-mobile/device-not-found': return 'deviceGone'
    case 'hemi-mobile/credentials-unavailable': return 'credentialsFailed'
    case 'hemi-mobile/listen-failed': return 'listenFailed'
    default: return 'failed'
  }
}
