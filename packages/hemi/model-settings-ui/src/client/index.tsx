/** Register the separate Hemi Model Connections settings page. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-hemi-model-access-ui/client'
import type { InjectFace, PropsLocale, PropsRenderFactories, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import modelSettingsRemote from '@deepseek-ai/dsh-hemi-model-settings/remote'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

import css from './ConnectionTest.module.css'
import { DesktopWelcome } from './DesktopWelcome.tsx'

/** Locale namespace for the settings page. */
type ModelTestActions = { test: (provider: string, model: string, signal: AbortSignal) => Promise<boolean> }

import { NS, en, zh } from './locales.ts'

export { NS } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Append root-scoped routing controls below model connections; an empty list leaves no extra controls. */
    'hemi.models.routing': { kind: 'list'; scope: 'root' }
  }
  interface LocaleNamespaceMap {
    'hemi-model-settings': keyof typeof en
  }
}

function ModelSettingsPage({ actions, renderFactorySlot, renderSlot, t }: PropsRenderFactories & PropsRenderSlots<'hemi.models.routing'>
  & PropsLocale<typeof NS> & InjectFace<{ actions: ModelTestActions }>) {
  return (
    <section className={css.page} aria-label={t('title')}>
      {renderFactorySlot('hemi.models.connections', { test: actions.test })}
      {renderSlot('hemi.models.routing', {})}
    </section>
  )
}

/** Services used to bind the settings contribution and the probe operations. */
export const inject = ['slots', 'locale', 'remote']

async function unwrap<T>(response: Promise<RemoteResult<T>>): Promise<T> {
  const result = await response
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/** Contribute the independent Hemi model connection entry. */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const unmount = await ctx.remote.$mount(modelSettingsRemote)
  const features = ctx.inject(['remote.hemiModelSettings'], registerPage)
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

async function registerPage(ctx: Context): Promise<void> {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'hemi-model-settings: dictionaries')
  const t = ctx.locale.bind(NS)
  const actions: ModelTestActions = {
    test: (provider, model, signal) => unwrap(ctx.remote.hemiModelSettings.testModel(provider, model, signal)),
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'hemi-model-access',
    order: 10,
    children: { 'hemi.models.routing': { kind: 'list', scope: 'root' } },
    label: () => t('nav'),
    locale: NS,
    inject: () => ({ actions }),
  }, ModelSettingsPage))
  if (!('dshDesktop' in globalThis)) return
  let loadFailed = false
  try {
    const state = await unwrap(ctx.remote.hemiModelSettings.desktopWelcome())
    if (!state.enabled || state.completed) return
  } catch (_error: unknown) {
    loadFailed = true
  }
  ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
    name: 'settings.onboarding', id: 'hemi-desktop-welcome', order: -200, locale: NS,
    inject: () => ({ loadFailed, t,
      reload: () => unwrap(ctx.remote.hemiModelSettings.desktopWelcome()),
      acknowledge: () => unwrap(ctx.remote.hemiModelSettings.completeDesktopWelcome()),
    }),
  }, DesktopWelcome))
}
