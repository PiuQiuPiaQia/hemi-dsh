/** Desktop shell control of system idle sleep, persisted in the shared settings document. */
import { powerSaveBlocker } from 'electron'
import { DesktopSettingsFile } from './settings-file.ts'

/**
 * Observed keep-awake state; reads never touch disk again after startup.
 * `prevent-app-suspension` keeps the system awake while the display may still sleep;
 * lid close and manual sleep stay outside an application's control.
 */
export interface DesktopKeepAwakeState {
  readonly enabled: boolean
  /** The persisted choice could not be read; the blocker stays off until a new choice applies. */
  readonly error?: 'read'
}

/**
 * Own the power-save assertion for the shell: one assertion at a time, held only while the
 * persisted choice is enabled, and published after every commit.
 */
export class DesktopKeepAwake {
  private blocker: number | null = null
  private current: DesktopKeepAwakeState = { enabled: false }
  private readonly file: DesktopSettingsFile

  /**
   * @param userData - Electron userData holding the shared settings document.
   * @param publish - Receives every committed state, including startup reads.
   */
  constructor(userData: string, private readonly publish: (state: DesktopKeepAwakeState) => void) {
    this.file = new DesktopSettingsFile(userData)
  }

  /** @returns The last committed state, without reading disk again. */
  get state(): DesktopKeepAwakeState { return this.current }

  /**
   * Read the persisted choice at startup and hold the assertion when it is enabled.
   * A missing file and an absent field stay off; an invalid explicit field reports 'read'.
   */
  async load(): Promise<void> {
    const result = await this.file.read()
    if (result.kind === 'error') { this.settle({ enabled: false, error: 'read' }); return }
    if (result.kind !== 'ready') return
    const enabled = result.fields.keepAwake.enabled
    if (enabled.kind === 'invalid') { this.settle({ enabled: false, error: 'read' }); return }
    if (enabled.kind === 'valid') this.reconcile(enabled.value)
  }

  /**
   * Persist an explicit choice and hold the assertion only after a confirmed write.
   * @param enabled - Explicit user choice from an owning window.
   * @returns The committed state; a failed save rejects and leaves state untouched.
   */
  async set(enabled: boolean): Promise<DesktopKeepAwakeState> {
    if (this.current.enabled === enabled && this.current.error === undefined) return this.current
    await this.file.saveKeepAwake({ enabled })
    this.reconcile(enabled)
    return this.current
  }

  /** Hold exactly one power-save assertion while enabled and release it otherwise. */
  private reconcile(enabled: boolean): void {
    if (enabled && this.blocker === null) this.blocker = powerSaveBlocker.start('prevent-app-suspension')
    if (!enabled && this.blocker !== null) {
      powerSaveBlocker.stop(this.blocker)
      this.blocker = null
    }
    this.settle({ enabled })
  }

  private settle(state: DesktopKeepAwakeState): void {
    this.current = state
    this.publish(state)
  }
}
