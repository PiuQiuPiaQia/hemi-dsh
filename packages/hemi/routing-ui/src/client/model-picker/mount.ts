/** Register Hemi's composer picker over the native directory service. */
import type {} from './slots.ts'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import { HemiModelSelect, type HemiModelSelectInjected } from './ModelSelect.tsx'
import type { ModelMenuMode } from './menu-mode.ts'

/**
 * Mount the Hemi menu while native model directories and its composer slot are available.
 * @param ctx - routing UI plugin scope; disposal withdraws the picker and child slots.
 * @param menuMode - plugin-owned alternative selection state.
 */
export function mountModelPicker(ctx: Context, menuMode: ModelMenuMode): void {
  ctx.inject(['modelDirectories', 'sessions'], (scope) => {
    scope.slots.inject('conversation.input.model', () => scope.slots.register({
      name: 'conversation.input.model',
      // Older official clients lack showComposer; the documented slot priority shadows their picker.
      priority: -1,
      locale: 'model',
      children: {
        ...scope.slots.spec('conversation.input.model.label') === undefined ? {
          'conversation.input.model.label': { kind: 'single' as const, scope: 'session' as const, inline: true },
        } : {},
        ...scope.slots.spec('conversation.input.model.options') === undefined ? {
          'conversation.input.model.options': { kind: 'list' as const, scope: 'session' as const },
        } : {},
        'conversation.input.model.alternative': { kind: 'single', scope: 'session' },
      },
      inject: (sessionId): HemiModelSelectInjected => {
        const directory = scope.modelDirectories.directoryFor(sessionId)
        const available = scope.sessions.subagentAddress(sessionId) === undefined
        return {
          available,
          hooks: { directory: directory.store, menuMode: menuMode.state },
          load: () => {
            if (available) directory.load().catch((_error: unknown) => { /* The native directory exposes the failure. */ })
          },
          resolveText: text => scope.locale.resolveText(text),
          select: (selection: ModelSelection) => available ? directory.select(selection) : Promise.resolve(undefined),
        }
      },
    }, HemiModelSelect))
  })
}
