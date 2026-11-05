/** Register the Hemi Model Connections page as its own settings section. */
import { useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-account/client'
import type { InjectFace, PropsLocale, PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import accessRemote from '@deepseek-ai/dsh-hemi-model-access/remote'
import type {} from '@deepseek-ai/dsh-hemi-model-settings/remote'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { en, NS, zh } from './copy.ts'
import type { NewApiDesktopBridge } from '@deepseek-ai/dsh-hemi-model-access/desktop-import'
import { KeyProfiles } from './KeyProfiles.tsx'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { BrowserImportSection } from './BrowserImportSection.tsx'
import { NewApiSection } from './NewApiSection.tsx'
import { SubscriptionSection } from './SubscriptionSection.tsx'
import { AccountSubscriptionCard, type AccountSubscriptionInput } from './AccountSubscriptionCard.tsx'
import type { ModelAccessActions, ModelTest } from './types.ts'
import css from './page.module.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotFactoryMap {
    'hemi.models.connections': { scope: 'root'; props: { test: ModelTest }; inject: { actions: ModelAccessActions } & PropsLocale<typeof NS> }
    'hemi.models.account-subscription': {
      scope: 'root'
      props: AccountSubscriptionInput
      inject: { actions: ModelAccessActions; test: ModelTest } & PropsLocale<typeof NS>
    }
  }
}

function ModelAccessPage({ actions, test, t, renderFactorySlot }: InjectFace<{ actions: ModelAccessActions }> & PropsLocale<typeof NS>
  & PropsRenderFactories & { test: ModelTest }) {
  const [method, setMethod] = useState<'subscriptionsMethod' | 'newApiMethod' | 'keyMethod'>('subscriptionsMethod')
  const desktop = (globalThis as { dshDesktop?: { newApiImport?: NewApiDesktopBridge } }).dshDesktop?.newApiImport
  return (
    <section className={css.page}>
      <h2>{t('title')}</h2>
      <nav className={css.methods} aria-label={t('nav')}>
        {(['subscriptionsMethod', 'newApiMethod', 'keyMethod'] as const).map(id => (
          <Button key={id} variant={method === id ? 'outline' : 'ghost'} size="sm" aria-pressed={method === id}
            onClick={() => { setMethod(id) }}>{t(id)}</Button>
        ))}
      </nav>
      <div hidden={method !== 'subscriptionsMethod'}>
        <SubscriptionSection actions={actions} test={test} t={t} renderFactorySlot={renderFactorySlot} />
      </div>
      <div hidden={method !== 'newApiMethod'}>
        {desktop === undefined ? <NewApiSection actions={actions} t={t} /> : <BrowserImportSection bridge={desktop} t={t} />}
      </div>
      {method === 'keyMethod' && <KeyProfiles actions={actions} test={test} t={t} />}
    </section>
  )
}

/** Services needed to register the section and its Remote contribution. */
export const inject = ['slots', 'locale', 'remote']

async function unwrap<T>(request: Promise<RemoteResult<T>>): Promise<T> {
  const result = await request
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/** Bind operations for the independent settings entry. */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const unmount = await ctx.remote.$mount(accessRemote)
  const features = ctx.inject(['remote.hemiModelAccess'], register)
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

function register(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'hemi-model-access: dictionaries')
  const t = ctx.locale.bind(NS)
  const remote = ctx.remote.hemiModelAccess
  const actions: ModelAccessActions = {
    keyDirectory: () => unwrap(remote.keyDirectory()),
    getModelOptions: (provider, model) => unwrap(remote.getModelOptions(provider, model)),
    getModelDefaults: (api, model, provider) => unwrap(remote.getModelDefaults(api, model, provider)),
    saveModelOptions: (provider, model, options, revision) => unwrap(remote.saveModelOptions(provider, model, options, revision)),
    discoverKeyModels: (input, signal) => unwrap(remote.discoverKeyModels(input, signal)),
    saveKeyProfile: input => unwrap(remote.saveKeyProfile(input)),
    removeKeyProfile: (id, revision) => unwrap(remote.removeKeyProfile(id, revision)),
    subscriptionCandidates: (provider, signal) => unwrap(remote.subscriptionCandidates(provider, signal)),
    subscriptionModels: (provider, signal) => unwrap(remote.subscriptionModels(provider, signal)),
    changeSubscriptionModel: (provider, model, add) => unwrap(remote.changeSubscriptionModel(provider, model, add)),
    subscriptions: () => unwrap(remote.subscriptions()),
    state: () => unwrap(remote.state()),
    start: provider => unwrap(remote.start(provider)),
    answer: (id, prompt, value) => unwrap(remote.answer(id, prompt, value)),
    cancel: id => unwrap(remote.cancel(id)),
    disconnect: provider => unwrap(remote.disconnect(provider)),
    quota: (provider, signal) => unwrap(remote.quota(provider, signal)),
    listNewApi: (login, signal) => unwrap(remote.listNewApi(login, signal)),
    importNewApi: (login, token, signal) => unwrap(remote.importNewApi(login, token, signal)),
  }
  ctx.slots.registerFactory({
    name: 'hemi.models.connections', scope: 'root', inject: () => ({ actions, t }),
  }, ModelAccessPage)
  ctx.inject(['remote.hemiModelSettings'], (probes) => {
    const test: ModelTest = (provider, model, signal) => unwrap(probes.remote.hemiModelSettings.testModel(provider, model, signal))
    probes.slots.registerFactory({
      name: 'hemi.models.account-subscription', scope: 'root', inject: () => ({ actions, test, t }),
    }, AccountSubscriptionCard)
  })
}
