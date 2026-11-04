/** Skin picker row store: the selected Hemi skin id. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/** Store state for the skin row. */
export interface SkinRowState {
  /** Selected Hemi skin id (config order; `cafe-blue` default). */
  skinId: string
  /** Local revision; -1 until first sync. */
  revision: number
}

/** Declared action shape. */
type SkinRowActions = {
  sync: (draft: SkinRowState, skinId: string, revision: number) => void
}

/**
 * Declares the skin row state and write surface.
 * @returns the store handle.
 */
export function createSkinRowStore(): EngineStoreHandle<SkinRowState, SkinRowActions> {
  return defineStore({
    init: (): SkinRowState => ({ skinId: 'cafe-blue', revision: -1 }),
    actions: {
      sync: (d, skinId: string, revision: number) => {
        if (revision <= d.revision) return
        d.skinId = skinId
        d.revision = revision
      },
    },
  })
}
