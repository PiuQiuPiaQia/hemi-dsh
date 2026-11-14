/** One shell-owned keep-awake subscription behind the General settings switch. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { DesktopKeepAwakeBridge, DesktopKeepAwakeState } from '../types.ts'

/** Actual shell state, an optimistic toggle position and an initial-read failure. */
export interface DesktopKeepAwakeSnapshot {
  state?: DesktopKeepAwakeState
  failed: boolean
  pending?: boolean
}

/** Client observation; no Host service or configuration file is read here. */
export class DesktopKeepAwakeSource {
  /** Stable observation shared by mounted General views. */
  readonly store = createSnapshotStore<DesktopKeepAwakeSnapshot>({ failed: false })
  private live = true
  private revision = 0
  private readonly unsubscribe: () => void

  /** @param bridge - Isolated shell API, present only in Desktop. */
  constructor(private readonly bridge: DesktopKeepAwakeBridge) {
    this.unsubscribe = bridge.subscribe((state) => {
      if (!this.live) return
      this.revision++
      this.receive(state)
    })
    void bridge.get().then((state) => {
      if (this.live && this.revision === 0) this.receive(state)
    }, () => {
      if (this.live && this.revision === 0) this.store.set({ ...this.store.getSnapshot(), failed: true })
    })
  }

  private receive(state: DesktopKeepAwakeState): void {
    this.store.set({ ...this.store.getSnapshot(), state, failed: false })
  }

  /**
   * Show a pending toggle until the shell reports the committed state.
   * @param enabled - Requested switch position.
   * @returns After the shell reports the result; a rejection restores the last known
   * state first, then propagates so the owning row can report the failure.
   */
  async setEnabled(enabled: boolean): Promise<void> {
    if (!this.isLive() || this.store.getSnapshot().pending !== undefined) return
    const revision = this.revision
    this.store.set({ ...this.store.getSnapshot(), pending: enabled })
    let state: DesktopKeepAwakeState | undefined
    try {
      state = await this.bridge.set(enabled)
    } catch (error) {
      // An IPC failure has no reliable user-facing detail; revert and let the row report it.
      if (!this.isLive()) return
      const { pending: _pending, ...current } = this.store.getSnapshot()
      this.store.set(current)
      throw error
    }
    if (!this.isLive()) return
    const accept = revision === this.revision
    if (accept) this.revision++
    const { pending: _pending, ...current } = this.store.getSnapshot()
    this.store.set(accept ? { ...current, state, failed: false } : current)
  }

  /** Detach the shell subscription and ignore late IPC responses. */
  dispose(): void { this.live = false; this.unsubscribe() }

  private isLive(): boolean { return this.live }
}
