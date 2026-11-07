/** Register the Hemi Model Connections page as its own settings section. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-account/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import accessRemote from '@deepseek-ai/dsh-hemi-model-access/remote'
import type {} from '@deepseek-ai/dsh-hemi-model-settings/remote'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { en, NS, zh } from './copy.ts'
import { ModelAccessPage } from './ModelAccessPage.tsx'
import { AccountSubscriptionCard, type AccountSubscriptionInput } from './AccountSubscriptionCard.tsx'
import type { ModelAccessActions, ModelTest } from './types.ts'
import { createModelActionFeedback, ModelActionToast } from './ModelActionToast.tsx'

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
  const feedback = createModelActionFeedback()
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'hemi.model-action-toast', locale: NS,
    inject: () => ({ hooks: feedback.hooks, dismiss: feedback.dismiss }),
  }, ModelActionToast))
  const actions: ModelAccessActions = {
    reportModelFailure: feedback.reportModelFailure,
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
