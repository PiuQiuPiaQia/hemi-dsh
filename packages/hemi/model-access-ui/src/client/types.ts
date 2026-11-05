import type { KeyDirectory, KeyProfileInput, LoginState, ModelOptions, ModelOptionsView, NewApiLogin, NewApiToken, QuotaWindow, Subscription } from '@deepseek-ai/dsh-hemi-model-access/types'

/**
 * Client operations supplied by the model-access Remote namespace.
 */
export interface ModelAccessActions {
  keyDirectory: () => Promise<KeyDirectory>
  getModelOptions: (provider: string, model: string) => Promise<ModelOptionsView>
  saveModelOptions: (provider: string, model: string, options: ModelOptions, revision: number) => Promise<void>
  discoverKeyModels: (input: KeyProfileInput, signal: AbortSignal) => Promise<string[]>
  saveKeyProfile: (input: KeyProfileInput) => Promise<void>
  removeKeyProfile: (id: string, revision: number) => Promise<void>
  subscriptionCandidates: (provider: string, signal: AbortSignal) => Promise<string[]>
  changeSubscriptionModel: (provider: string, model: string, add: boolean) => Promise<void>
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
 * Explicit model connection test, with caller cancellation.
 */
export type ModelTest = (provider: string, model: string, signal: AbortSignal) => Promise<boolean>
