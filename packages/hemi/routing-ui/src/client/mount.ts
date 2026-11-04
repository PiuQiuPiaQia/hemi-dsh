/** Mount the routing Remote contribution before activating its UI extensions. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type {} from '@deepseek-ai/dsh-hemi-routing/remote'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createRoutingEditor, ROUTING_NS } from './editor-state.ts'
import { RoutingDialog, type RoutingDialogInjected } from './RoutingDialog.tsx'
import { RoutingModeChoice, RoutingModeToggle, type RoutingModeInjected } from './RoutingModeToggle.tsx'
import { RoutingModelLabel, type RoutingLabelInjected } from './RoutingModelLabel.tsx'
import { RoutingSettingsEntry, type RoutingSettingsEntryInjected } from './RoutingSettingsEntry.tsx'
import type { RoutingConfig } from './types.ts'
import { NS, en, zh, type RoutingLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Model routing controls and their shared configuration dialog. */
    'hemi-routing': RoutingLocaleKey
  }
}

/**
 * Register the routing namespace and retain it until all dependent UI effects stop.
 * @param ctx - Client context holding the Remote, settings, locale and slots services.
 * @param contribution - generated routing Remote descriptors.
 * @returns disposer withdrawing the UI before its Remote namespace.
 */
export async function mountRouting(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const unmount = await ctx.remote.$mount(contribution)
  const features = ctx.inject(['remote.hemiRoutingSettings'], registerRouting)
  try {
    await features.await()
  } catch (error) {
    await features.dispose()
    await unmount()
    throw error
  }
  return async () => {
    await features.dispose()
    await unmount()
  }
}

/** Register controls only while the routing Remote namespace is available. */
function registerRouting(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'hemi-routing-ui: dictionaries')
  const form = ctx.configForms.get<RoutingConfig>(ROUTING_NS)
  const editor = createRoutingEditor(form, async () => {
    const response = await ctx.remote.session.modelCatalog()
    if (!response.ok) throw new Error(response.error.message)
    return response.value
  })
  ctx.effect(() => () => editor.dispose(), 'hemi-routing-ui: editor operations')
  ctx.slots.inject('conversation.input.model.label', () => ctx.slots.register({
    name: 'conversation.input.model.label', locale: NS,
    inject: (): RoutingLabelInjected => ({
      hooks: { routingSettings: form },
      resolveText: text => ctx.locale.resolveText(text),
    }),
  }, RoutingModelLabel))
  ctx.slots.inject('shell.overlay', function* () {
    const routingOpen = createSnapshotStore(false)
    const openConfiguration = (): void => {
      editor.injected.refreshCatalog()
      routingOpen.set(true)
    }
    const modeFor = (sessionId: SessionId): RoutingModeInjected => ({
      hooks: { routingSettings: form },
      openConfiguration,
      setEnabled: async (enabled) => {
        const response = await ctx.remote.hemiRoutingSettings.setEnabled(sessionId, enabled)
        return response.ok ? null : response.error.message
      },
    })
    yield () => { routingOpen.set(false) }
    yield ctx.slots.register({
      name: 'shell.overlay', id: 'hemi-routing', locale: NS,
      inject: (): RoutingDialogInjected => ({
        ...editor.injected,
        modelChoiceMenu: ctx.get('modelDirectories')?.menuMode !== undefined,
        hooks: { ...editor.injected.hooks, routingOpen },
        closeConfiguration: () => { routingOpen.set(false) },
      }),
    }, RoutingDialog)
    yield ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
      name: 'settings.models.footer', id: 'hemi-routing', order: 60, locale: NS,
      inject: (): RoutingSettingsEntryInjected => ({ openConfiguration }),
    }, RoutingSettingsEntry))
    yield ctx.slots.inject('conversation.input.model.options', () => ctx.slots.register({
      name: 'conversation.input.model.options', id: 'hemi-routing', order: 60, locale: NS,
      inject: modeFor,
    }, RoutingModeToggle))
    yield ctx.slots.inject('conversation.input.model.alternative', function* () {
      const menuMode = ctx.get('modelDirectories')?.menuMode
      if (menuMode === undefined) return
      yield menuMode.register({ en: en.auto, zh: zh.auto }, {
        getSnapshot: () => {
          const snapshot = form.getSnapshot()
          return snapshot.status === 'ready' ? snapshot.value?.sessionModes : undefined
        },
        subscribe: listener => form.subscribe(listener),
      })
      yield ctx.slots.register({
        name: 'conversation.input.model.alternative', locale: NS,
        inject: modeFor,
      }, RoutingModeChoice)
    })
  })
}
