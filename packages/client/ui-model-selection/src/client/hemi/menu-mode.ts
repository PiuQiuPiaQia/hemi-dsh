/** Session mode reported by an optional alternative to a concrete model. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelLabelOwner } from '../slots.ts'

/** Localized caption shared by the alternative and the model trigger. */
export type ModelMenuModeLabel = NonNullable<ModelLabelOwner['model']['badge']>['text']

/** Alternative selection observed by the custom composer menu. */
export interface ModelMenuModeSnapshot {
  readonly label: ModelMenuModeLabel
  readonly sessions: Readonly<Record<string, boolean>> | undefined
}

/** Owns the current alternative contribution for the model picker. */
export class ModelMenuMode {
  private readonly store = createSnapshotStore<ModelMenuModeSnapshot | null>(null)

  /** Source bound to the composer through its injected hooks. */
  readonly state: HostObservable<ModelMenuModeSnapshot | null> = this.store

  /**
   * Publish a plugin's saved selection state for the duration of its slot registration.
   * @param label - localized caption for the selected alternative.
   * @param source - saved mode preference by Session id.
   * @returns disposer releasing the contribution and its subscription.
   */
  register(label: ModelMenuModeLabel, source: HostObservable<Readonly<Record<string, boolean>> | undefined>): () => void {
    if (this.store.getSnapshot() !== null) throw new Error('the model menu already has an alternative selection')
    const publish = (): void => { this.store.set({ label, sessions: source.getSnapshot() }) }
    const stop = source.subscribe(publish)
    publish()
    let active = true
    return () => {
      if (!active) return
      active = false
      stop()
      this.store.set(null)
    }
  }
}
