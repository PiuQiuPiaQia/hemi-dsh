import type { KeyDirectory, KeyProfileInput, LoginState, ModelOptions, ModelOptionsView, NewApiLogin, NewApiToken, QuotaWindow, Subscription, VvcodeDirectory, VvcodeModelSelection, VvcodeUsage } from '@deepseek-ai/dsh-hemi-model-access/types'

/** A failed model-row operation announced outside the connection page. */
export interface ModelActionFailure {
  operation: 'test' | 'remove'
  model: string
}

/** Remote connection operations and app-wide model-row feedback. */
export interface ModelAccessActions {
  /** Announce a settled failure without replacing the model row. */
  reportModelFailure: (failure: ModelActionFailure) => void
  keyDirectory: () => Promise<KeyDirectory>
  getModelOptions: (provider: string, model: string) => Promise<ModelOptionsView>
  getModelDefaults: (api: string, model: string, provider?: string) => Promise<ModelOptions>
  saveModelOptions: (provider: string, model: string, options: ModelOptions, revision: number) => Promise<void>
  discoverKeyModels: (input: KeyProfileInput, signal: AbortSignal) => Promise<string[]>
  saveKeyProfile: (input: KeyProfileInput) => Promise<void>
  removeKeyProfile: (id: string, revision: number) => Promise<void>
  subscriptionCandidates: (provider: string, signal: AbortSignal) => Promise<string[]>
  subscriptionModels: (provider: string, signal: AbortSignal) => Promise<string[]>
  changeSubscriptionModel: (provider: string, model: string, add: boolean) => Promise<void>
  /** Read normalized balance and per-subscription quotas; preserves structured Remote errors and caller-owned cancellation. */
  vvcodeUsage: (signal: AbortSignal) => Promise<VvcodeUsage>
  /** Read all authorized groups and their saved model enablement, without creating keys. */
  vvcodeDirectory: (signal: AbortSignal) => Promise<VvcodeDirectory>
  /** Prepare calling keys for newly enabled groups, then atomically replace changed selections; never revokes remote keys. */
  saveVvcodeModels: (selections: VvcodeModelSelection[], signal: AbortSignal) => Promise<void>
  subscriptions: () => Promise<Subscription[]>
  state: () => Promise<LoginState | null>
  start: (id: string) => Promise<LoginState>
  answer: (id: string, prompt: string, value: string) => Promise<void>
  cancel: (id: string) => Promise<void>
  disconnect: (provider: string) => Promise<void>
  quota: (provider: string, signal: AbortSignal) => Promise<QuotaWindow[]>
  listNewApi: (login: NewApiLogin, signal: AbortSignal) => Promise<NewApiToken[]>
  importNewApi: (login: NewApiLogin, token: number, signal: AbortSignal) => Promise<number>
}

/**
 * Independent model connection test, with caller-owned cancellation.
 */
export type ModelTest = (provider: string, model: string, signal: AbortSignal) => Promise<boolean>
