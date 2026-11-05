/** Hemi-owned alternative choice in its composer picker. */
import type { ModelOptionsOwner } from '@deepseek-ai/dsh-client-ui-model-selection/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Independent effort control contributed by the active alternative selection. */
    'conversation.input.model.effort': { kind: 'single'; scope: 'session'; owner: ModelOptionsOwner }
    /** Alternative to choosing a concrete model, shown before catalog rows. */
    'conversation.input.model.alternative': {
      kind: 'single'
      scope: 'session'
      owner: ModelOptionsOwner & {
        /** Run one selection, closing only after the plugin accepts it. */
        selectAlternative: (select: () => Promise<string | null>) => void
      }
    }
  }
}
