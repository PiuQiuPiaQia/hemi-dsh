/** Hemi role routing settings section over the `hemi-routing-settings` namespace. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type { RoutingSectionInjected } from './RoutingSection.tsx'
import { RoutingSection } from './RoutingSection.tsx'
import { en, zh, type RoutingLocaleKey } from './locales.ts'

/** Settings namespace owned by the hemi-routing settings service. */
export const ROUTING_NS = 'hemi-routing-settings'

/** Shape of the settings snapshot carrying the role table. */
interface RoutingSettingsSnapshot {
  value?: { roles?: Record<string, { provider: string; model: string; reasoningEffort?: string }> } | null
  base?: { roles?: Record<string, { provider: string; model: string; reasoningEffort?: string }> } | null
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'hemi-routing': RoutingLocaleKey }
}

/** Services: slot registry, locale, config forms, and the model catalog remote. */
export const inject = ['slots', 'locale', 'configForms', 'remote']

/**
 * Register the model routing settings section: one model picker per preset
 * role (research, review, execution, design), persisted through the settings
 * pipeline. Saved routes reach `hemi_delegate` delegations in sessions
 * created after the app restarts.
 * @param ctx - client plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('hemi-routing', { en, zh }), 'hemi-routing-ui: dictionaries')
  const form = ctx.configForms.get(ROUTING_NS)
  ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
    name: 'settings.models.footer',
    id: 'hemi-routing',
    order: 60,
    locale: 'hemi-routing',
    inject: (): RoutingSectionInjected => ({
      getRoutes: () => {
        const snapshot = form.getSnapshot() as RoutingSettingsSnapshot
        const current = snapshot.value !== undefined && snapshot.value !== null && snapshot.value.roles !== undefined
          ? snapshot.value.roles
          : snapshot.base !== undefined && snapshot.base !== null && snapshot.base.roles !== undefined ? snapshot.base.roles : {}
        return current
      },
      saveRoutes: roles => form.set('roles', roles),
      loadCatalog: async () => {
        const catalog = await ctx.remote.session.modelCatalog()
        if (!catalog.ok) throw new Error(catalog.error.message)
        const value = catalog.value
        return value.groups.map(group => ({
          id: group.id,
          name: group.name,
          models: group.models.map(model => ({ provider: group.id, model: model.id, name: model.name })),
        }))
      },
    }),
  }, RoutingSection))
}
