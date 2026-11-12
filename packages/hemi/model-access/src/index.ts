/** Owner-only Host operations for the separate Model Connections page. */
import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import { subscriptionCatalog } from './subscription-models.ts'
import type { SubscriptionDiscoveryConfig } from './subscription-models.ts'
import { keyDirectory, discoverKeyModels, saveKeyProfile, removeKeyProfile } from './key-profiles.ts'
import type { KeyDirectory, KeyProfileInput } from './types.ts'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { AuthorizationPrompt } from '@deepseek-ai/dsh-authorization/types'
import type {} from '@deepseek-ai/dsh-authorization'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-llm'
import { principalOf, Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { browserImportReady, commitBrowserImport, findBrowserReceipt } from './browser-route-commit.ts'
import { importToken, listTokens } from './new-api.ts'
import { codexQuota } from './quota.ts'
import { BIGMODEL_PROVIDER, bigModelQuota, mountBigModel } from './bigmodel/index.ts'
import { asObject } from './response.ts'
import { readKeyModelDefaults, readModelOptions, writeModelOptions } from './model-options.ts'
import type { ModelOptions, ModelOptionsView } from './types.ts'
import { mountProtocolReasoning, PROTOCOL_REASONING_DEFAULTS } from './protocol-reasoning.ts'
import type { ProtocolReasoningDefault } from './protocol-reasoning.ts'
import { mountTransportLog } from './transport-log.ts'

import type { LoginState, NewApiBrowserCommit, NewApiBrowserCommitResult, NewApiImportReceipt, NewApiLogin, NewApiToken, QuotaWindow, Subscription } from './types.ts'

const SUBSCRIPTIONS = [
  { id: BIGMODEL_PROVIDER, name: 'GLM Coding Plan', hosts: ['bigmodel.cn', 'www.bigmodel.cn'] },
  { id: 'openai-codex', name: 'ChatGPT Codex', hosts: ['auth.openai.com'] },
  { id: 'anthropic', name: 'Claude', hosts: ['claude.ai', 'console.anthropic.com', 'platform.claude.com'] },
  { id: 'github-copilot', name: 'GitHub Copilot', hosts: ['github.com'] },
]

interface ModelAccessConfig {
  /** Protocol offers used only when the configured and installed catalogs have no reasoning information. */
  reasoningFallbacks: Record<string, ProtocolReasoningDefault>
  /** Saved model IDs enabled for each subscription provider. */
  subscriptionModels: Volatile<Record<string, string[]>>
  /** Model capability overrides for Hemi-owned subscription adapters. */
  subscriptionModelOptions: Volatile<Record<string, Record<string, ModelOptions>>>
  /** Request limits and client versions for live subscription model listings. */
  subscriptionDiscovery: SubscriptionDiscoveryConfig
}

interface Attempt {
  state: LoginState
  controller: AbortController
  answer?: (value: string) => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    hemiModelAccess: HemiModelAccess
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'hemi/model-access-forbidden': {}
    'hemi/model-access-failed': {}
    'hemi/subscription-discovery-failed': {}
  }
}

function failure(message: string): RemoteError<'hemi/model-access-failed'> {
  return new RemoteError('hemi/model-access-failed', message, {})
}

const reasoningFallbacks = z.dict(z.object({
  efforts: z.dict(z.union([z.string(), z.const(null)]), z.union(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])),
  defaultEffort: z.union(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).required(),
})) as z<Record<string, ProtocolReasoningDefault>>

/** Reuse the adapter's authorization flow and credential record rather than storing another grant. */
export default class HemiModelAccess extends TypertRemoteService {
  static Config = z.object({
    reasoningFallbacks: reasoningFallbacks.default(PROTOCOL_REASONING_DEFAULTS),
    subscriptionModels: z.dict(z.array(z.string())).default({}).volatile(),
    subscriptionModelOptions: z.dict(z.dict(z.object({
      name: z.string(), contextWindow: z.number().step(1).min(1), maxTokens: z.number().step(1).min(1),
      input: z.array(z.union(['text', 'image'])),
    }))).default({}).volatile(),
    subscriptionDiscovery: z.object({
      timeoutMs: z.number().step(1).min(1).default(30_000),
      maxModels: z.number().step(1).min(1).default(500),
      codexClientVersion: z.string().default('0.164.0'),
      zcodeAppVersion: z.string().default('3.17.2'),
    }),
  })

  static inject = ['authorization', 'credentials', 'settings', 'llm']
  private active?: Attempt
  private disconnecting = false
  private browserImporting = false
  private changingModels = false
  private readonly refreshBigModel: (() => void) | undefined

  constructor(ctx: Context, private readonly config: ModelAccessConfig) {
    super(ctx, 'hemiModelAccess', { namespace: 'hemiModelAccess' })
    mountProtocolReasoning(ctx, config.reasoningFallbacks)
    mountTransportLog(ctx)
    this.refreshBigModel = mountBigModel(ctx, () => this.config.subscriptionModels.get().bigmodel,
      () => this.config.subscriptionModelOptions.get().bigmodel)
    ctx.effect(() => () => this.active?.controller.abort(), 'cancel model authorization on unload')
  }

  private assertIdle(): void {
    if (this.disconnecting || this.active?.state.phase === 'pending') throw failure('Complete the current account operation first.')
  }

  private assertOwner(): void {
    if (principalOf(this.ctx.invocation) !== undefined) {
      throw new RemoteError('hemi/model-access-forbidden', 'Only the profile owner can manage model connections.', {})
    }
  }

  /**
   * Available subscription sign-ins and redacted grant presence.
   * @returns registered subscription accounts, connection state and selected models.
   */
  @Remote
  async subscriptions(): Promise<Subscription[]> {
    this.assertOwner()
    const subscriptions: Subscription[] = []
    for (const provider of SUBSCRIPTIONS) {
      const key = credentialKey('llm-pi-ai', provider.id)
      if (!this.ctx.authorization.describe(key)?.methods.some(method => method.id === 'oauth')) continue
      const stored = await this.ctx.credentials.describeRecord(key)
      subscriptions.push({ id: provider.id, name: provider.name, connected: stored.kind === 'grant',
        models: stored.kind === 'grant' ? (await this.ctx.llm.listModels(provider.id)).map(model => model.id) : [],
        quota: provider.id === 'openai-codex' || provider.id === BIGMODEL_PROVIDER })
    }
    return subscriptions
  }

  /**
   * Read the subscription model catalog; DeepSeek uses its native account adapter catalog.
   * @param provider - Configured subscription provider ID.
   * @param signal - Caller cancellation for authentication and model-list requests.
   * @returns available IDs; GLM uses the live Coding Plan catalog and DeepSeek retains native model admission.
   */
  @Remote
  async subscriptionCandidates(provider: string, signal: AbortSignal): Promise<string[]> {
    this.assertOwner()
    return subscriptionCatalog(this.ctx, provider, this.config.subscriptionDiscovery,
      AbortSignal.any([signal, AbortSignal.timeout(this.config.subscriptionDiscovery.timeoutMs)]))
  }

  /**
   * Read the models currently selected for a connected subscription.
   * @param provider - Subscription provider ID.
   * @param signal - Caller cancellation while the adapter reads its catalog.
   * @returns selected model IDs; an empty array also covers a signed-out account.
   */
  @Remote
  async subscriptionModels(provider: string, signal: AbortSignal): Promise<string[]> {
    this.assertOwner()
    if (provider !== 'deepseek-account' && !SUBSCRIPTIONS.some(entry => entry.id === provider)) {
      throw failure('Subscription sign-in is unavailable.')
    }
    signal.throwIfAborted()
    const models = await this.ctx.llm.listModels(provider)
    signal.throwIfAborted()
    return models.map(model => model.id)
  }

  /**
   * Add or remove one model while retaining account authorization and other selections.
   * @param provider - Configured subscription provider ID.
   * @param model - Model ID within the selected provider.
   * @param add - True adds this model; false removes it while retaining authorization.
   */
  @Remote
  async changeSubscriptionModel(provider: string, model: string, add: boolean): Promise<void> {
    this.assertOwner()
    this.assertIdle()
    if (this.changingModels) throw failure('Wait for the current model change to finish.')
    this.changingModels = true
    try {
      if (provider === 'deepseek-account') {
        const current = (await this.ctx.llm.listModels(provider)).map(item => item.id)
        const available = add ? await subscriptionCatalog(this.ctx, provider, this.config.subscriptionDiscovery,
          AbortSignal.timeout(this.config.subscriptionDiscovery.timeoutMs)) : current
        if (!available.includes(model)) throw failure('This model is unavailable for the subscription.')
        const entry = this.ctx.llm.listConfigurableProviders().find(item => item.provider === provider)
        const section = this.ctx.settings.describe().find(item => item.ns === entry?.settingsNs)
        if (entry === undefined || section === undefined) throw failure('Model settings are unavailable.')
        const models = add ? [...new Set([...current, model])] : current.filter(id => id !== model)
        await this.ctx.settings.mutate(entry.settingsNs, [{ op: 'set', path: [...entry.settingsPath, 'selectedModels'], value: models }],
          section.revision)
        return
      }
      if (!SUBSCRIPTIONS.some(entry => entry.id === provider)
        || (await this.ctx.credentials.describeRecord(credentialKey('llm-pi-ai', provider))).kind !== 'grant') {
        throw failure('Connect this subscription first.')
      }
      const current = (await this.ctx.llm.listModels(provider)).map(item => item.id)
      const available = add ? await subscriptionCatalog(this.ctx, provider, this.config.subscriptionDiscovery,
        AbortSignal.timeout(this.config.subscriptionDiscovery.timeoutMs)) : current
      if (add && !available.includes(model)) throw failure('This model is unavailable for the subscription.')
      const models = add ? [...new Set([...current, model])] : current.filter(id => id !== model)
      const ns = provider === BIGMODEL_PROVIDER ? 'hemi-model-access' : 'llm-pi-ai'
      const section = this.ctx.settings.describe().find(item => item.ns === ns)
      if (section === undefined) throw failure('Model settings are unavailable.')
      const path = provider === BIGMODEL_PROVIDER ? ['subscriptionModels', provider] : ['providers', provider, 'models']
      const existing = asObject(asObject(section.value)?.providers)
      const configured = asObject(existing?.[provider])?.models
      const overrides = Array.isArray(configured) ? configured : []
      const value = provider === BIGMODEL_PROVIDER ? models : models.length === 0 ? overrides : models.map(id => ({
        ...asObject(overrides.find(model => asObject(model)?.id === id)), id,
      }))
      await this.ctx.settings.mutate(ns, [
        { op: 'set', path, value },
        ...provider === BIGMODEL_PROVIDER ? [] : [{
          op: 'set' as const, path: ['providers', provider, 'hiddenModels'],
          value: models.length === 0 ? [...new Set([...available, ...current])] : [],
        }],
      ], section.revision)
      if (provider === BIGMODEL_PROVIDER) this.refreshBigModel?.()
    } finally {
      this.changingModels = false
    }
  }

  /**
   * Start an authorization attempt using the catalog's registered OAuth method.
   * @param providerId - Registered subscription provider ID.
   * @returns the initial authorization state; subsequent progress is read through state().
   */
  @Remote
  async start(providerId: string): Promise<LoginState> {
    this.assertOwner()
    const provider = SUBSCRIPTIONS.find(entry => entry.id === providerId)
    if (provider === undefined) throw failure('Subscription sign-in is unavailable.')
    this.assertIdle()
    const key = credentialKey('llm-pi-ai', providerId)
    if (!this.ctx.authorization.describe(key)?.methods.some(method => method.id === 'oauth')) throw failure('Subscription sign-in is unavailable.')
    if (providerId !== BIGMODEL_PROVIDER) this.checkRoute(providerId)
    if ((await this.ctx.credentials.describeRecord(key)).kind === 'api-key') {
      throw failure('This provider already has a saved API-key credential.')
    }
    this.assertIdle()
    const attempt: Attempt = { state: { id: randomUUID(), provider: providerId, phase: 'pending' }, controller: new AbortController() }
    this.active = attempt
    const signal = AbortSignal.any([attempt.controller.signal, AbortSignal.timeout(10 * 60_000)])
    void this.ctx.authorization.begin({
      key, method: 'oauth', signal,
      interaction: {
        notify: (notice) => {
          if (signal.aborted || notice.url === undefined) return
          const url = URL.parse(notice.url)
          if (url === null) return
          if (url.protocol !== 'https:' || url.username || url.password || !provider.hosts.includes(url.hostname)) return
          attempt.state.url = url.href
          if (notice.code !== undefined) attempt.state.code = notice.code
        },
        prompt: prompt => this.prompt(attempt, prompt, signal),
      },
    }).then(async (result) => {
      if (result.status !== 'authorized') { this.finish(attempt, 'cancelled'); return }
      try {
        if (providerId !== BIGMODEL_PROVIDER) await this.ensureRoute(providerId)
        this.finish(attempt, 'connected')
      } catch {
        this.finish(attempt, 'route-failed')
      }
    }, () => { this.finish(attempt, 'failed') })
    return structuredClone(attempt.state)
  }

  /**
   * Return the current attempt without its credentials.
   * @returns the current authorization state without credentials, or null.
   */
  @Remote
  state(): LoginState | null {
    this.assertOwner()
    return this.active === undefined ? null : structuredClone(this.active.state)
  }

  /**
   * Answer only the prompt currently presented for the caller's attempt.
   * @param id - Exact operation, token or connection ID selected by the caller.
   * @param promptId - ID of the currently pending authorization prompt.
   * @param value - Caller-supplied value to inspect or submit.
   */
  @Remote
  answer(id: string, promptId: string, value: string): void {
    this.assertOwner()
    const attempt = this.active
    const prompt = attempt?.state.prompt
    const answer = attempt?.answer
    if (attempt?.state.id !== id || prompt?.id !== promptId || answer === undefined || value.length > 16_000
      || (prompt.options !== undefined && !prompt.options.some(option => option.id === value))) {
      throw failure('The sign-in prompt is no longer active or the answer is invalid.')
    }
    answer(value.trim())
  }

  /**
   * Cancel the exact pending attempt.
   * @param id - Exact operation, token or connection ID selected by the caller.
   */
  @Remote
  cancel(id: string): void {
    this.assertOwner()
    if (this.active?.state.id === id && this.active.state.phase === 'pending') this.active.controller.abort()
  }

  /**
   * Remove a saved subscription grant and the models selected through it.
   * @param provider - Configured subscription provider ID.
   */
  @Remote
  async disconnect(provider: string): Promise<void> {
    this.assertOwner()
    this.assertIdle()
    if (!SUBSCRIPTIONS.some(entry => entry.id === provider)) throw failure('Subscription sign-in is unavailable.')
    const key = credentialKey('llm-pi-ai', provider)
    this.disconnecting = true
    try {
      if ((await this.ctx.credentials.describeRecord(key)).kind === 'grant') await this.ctx.credentials.deleteRecord(key)
      await this.forgetModels(provider)
      if (this.active?.state.provider === provider) delete this.active
    } finally {
      this.disconnecting = false
    }
  }

  /**
   * Drop the models a disconnected subscription selected, so its provider
   * offers none until the account is connected again. A route an API key
   * authenticates is an API connection the subscription never wrote, so its
   * models stay.
   * @param provider - Subscription provider ID whose selections to drop.
   */
  private async forgetModels(provider: string): Promise<void> {
    if (provider === BIGMODEL_PROVIDER) {
      const section = this.ctx.settings.describe().find(item => item.ns === 'hemi-model-access')
      if (section === undefined) return
      if (this.config.subscriptionModels.get()[provider] === undefined) return
      await this.ctx.settings.mutate('hemi-model-access',
        [{ op: 'unset', path: ['subscriptionModels', provider] }], section.revision)
      this.refreshBigModel?.()
      return
    }
    const section = this.ctx.settings.describe().find(item => item.ns === 'llm-pi-ai')
    if (section === undefined) return
    const profile = asObject(asObject(section.value)?.providers)?.[provider]
    if (profile === undefined) return
    // A key on this route is an API connection the subscription never wrote.
    if (typeof asObject(profile)?.apiKeyEnv === 'string') return
    await this.ctx.settings.mutate('llm-pi-ai', [{ op: 'unset', path: ['providers', provider] }], section.revision)
  }

  /**
   * Get quota windows from the selected subscription account.
   * @param provider - Configured subscription provider ID.
   * @param signal - Caller cancellation for this asynchronous operation.
   * @returns the selected account’s quota windows.
   */
  @Remote
  async quota(provider: string, signal: AbortSignal): Promise<QuotaWindow[]> {
    this.assertOwner()
    try {
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(20_000)])
      if (provider === 'openai-codex') return await codexQuota(this.ctx, requestSignal)
      if (provider === BIGMODEL_PROVIDER) return await bigModelQuota(this.ctx, requestSignal)
      throw failure('Quota is unavailable for this provider.')
    } catch {
      throw failure('Subscription quota is unavailable. Check the account and try again.')
    }
  }

  /**
   * List the enabled New API tokens after proving the selected account identity.
   * @param login - Selected New API site identity and account credential.
   * @param signal - Caller cancellation for this asynchronous operation.
   * @returns enabled account tokens eligible for explicit import.
   */
  @Remote
  async listNewApi(login: NewApiLogin, signal: AbortSignal): Promise<NewApiToken[]> {
    this.assertOwner()
    try {
      return await listTokens(login, AbortSignal.any([signal, AbortSignal.timeout(30_000)]))
    } catch {
      throw failure('Could not read the New API account. Check the site, user ID and system access token.')
    }
  }

  /**
   * Read a selected token key and import its advertised models into Harness.
   * @param login - Selected New API site identity and account credential.
   * @param tokenId - Enabled New API token selected for import.
   * @param signal - Caller cancellation for this asynchronous operation.
   * @returns the number of model routes imported.
   */
  @Remote
  async importNewApi(login: NewApiLogin, tokenId: number, signal: AbortSignal): Promise<number> {
    this.assertOwner()
    try {
      return await importToken(this.ctx, login, tokenId, AbortSignal.any([signal, AbortSignal.timeout(40_000)]))
    } catch {
      throw failure('Could not import the New API token. Check its permissions or whether it is already imported.')
    }
  }

  /** Verify that the model store is ready before dispatching a New API token creation. */
  @Remote
  checkNewApiBrowserImport(): void {
    this.assertOwner()
    browserImportReady(this.ctx)
  }

  /**
   * Read the durable commit result for a recovered native import operation.
   * @param operationId - Recoverable desktop operation ID.
   * @returns the saved operation receipt, or null when no committed import is found.
   */
  @Remote
  async newApiBrowserReceipt(operationId: string): Promise<NewApiImportReceipt | null> {
    this.assertOwner()
    return findBrowserReceipt(this.ctx, operationId)
  }

  /**
   * Accept a validated model plan and key from the native import coordinator.
   * @param input - Validated draft or import plan including its optimistic settings revision.
   * @returns the committed model routes and durable import receipt.
   */
  @Remote
  async commitNewApiBrowserImport(input: NewApiBrowserCommit): Promise<NewApiBrowserCommitResult> {
    this.assertOwner()
    if (this.browserImporting) throw failure('Wait for the current New API import to finish.')
    this.browserImporting = true
    try {
      return await commitBrowserImport(this.ctx, input)
    } catch {
      throw failure('The New API import could not be saved.')
    } finally {
      this.browserImporting = false
    }
  }

  /**
   * Read the Hemi API connection directory.
   * @returns the configured connections and their current settings revision.
   */
  @Remote
  async keyDirectory(): Promise<KeyDirectory> {
    this.assertOwner()
    return keyDirectory(this.ctx)
  }

  /**
   * Read explicit settings for one available model.
   * @param provider - Configured provider ID.
   * @param model - Available model ID.
   * @returns editable overrides, effective values and their optimistic settings revision.
   */
  @Remote
  async getModelOptions(provider: string, model: string): Promise<ModelOptionsView> {
    this.assertOwner()
    return readModelOptions(this.ctx, provider, model, this.refreshBigModel !== undefined)
  }

  /**
   * Read installed model capabilities before saving a draft connection.
   * @param api - Draft connection wire protocol.
   * @param model - Exact model id selected by the owner.
   * @param provider - Existing connection id when editing a saved connection draft.
   * @returns catalog capabilities or adapter fallback values for an unknown id.
   */
  @Remote
  getModelDefaults(api: string, model: string, provider?: string): ModelOptions {
    this.assertOwner()
    return readKeyModelDefaults(this.ctx, api, model, provider)
  }

  /**
   * Save editable capabilities while retaining account and protocol configuration.
   * @param provider - Configured provider ID.
   * @param model - Available model ID.
   * @param options - Explicit overrides; omitted fields inherit adapter defaults.
   * @param revision - Settings revision observed when the editor opened.
   */
  @Remote
  async saveModelOptions(provider: string, model: string, options: ModelOptions, revision: number): Promise<void> {
    this.assertOwner()
    this.assertIdle()
    await writeModelOptions(this.ctx, provider, model, options, revision, this.refreshBigModel !== undefined)
    if (provider === BIGMODEL_PROVIDER) this.refreshBigModel?.()
  }

  /**
   * Read model IDs from a draft API connection.
   * @param input - Validated draft or import plan including its optimistic settings revision.
   * @param signal - Caller cancellation for this asynchronous operation.
   * @returns the discovered model IDs, deduplicated and capped at 500.
   */
  @Remote
  async discoverKeyModels(input: KeyProfileInput, signal: AbortSignal): Promise<string[]> {
    this.assertOwner()
    return discoverKeyModels(this.ctx, input, AbortSignal.any([signal, AbortSignal.timeout(30_000)]))
  }

  /**
   * Save one API connection.
   * @param input - Validated draft or import plan including its optimistic settings revision.
   */
  @Remote
  async saveKeyProfile(input: KeyProfileInput): Promise<void> {
    this.assertOwner()
    await saveKeyProfile(this.ctx, input)
  }

  /**
   * Remove one API connection.
   * @param id - Exact operation, token or connection ID selected by the caller.
   * @param revision - Settings revision observed when the edit began.
   */
  @Remote
  async removeKeyProfile(id: string, revision: number): Promise<void> {
    this.assertOwner()
    await removeKeyProfile(this.ctx, id, revision)
  }

  private checkRoute(provider: string) {
    const section = this.ctx.settings.describe().find(entry => entry.ns === 'llm-pi-ai')
    if (section === undefined) throw failure('Model settings are unavailable.')
    const current = asObject(asObject(asObject(section.value)?.providers)?.[provider])
    if (current !== undefined) {
      if (current.apiKeyEnv !== undefined || current.api !== undefined || current.baseURL !== undefined) {
        throw failure('The provider route has a custom authentication or endpoint override.')
      }
    }
    return { section, exists: current !== undefined }
  }

  private async ensureRoute(provider: string): Promise<void> {
    const { section, exists } = this.checkRoute(provider)
    if (exists) return
    await this.ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', provider], value: {} }], section.revision)
  }

  private finish(attempt: Attempt, phase: LoginState['phase']): void {
    attempt.state = { id: attempt.state.id, provider: attempt.state.provider, phase }
    delete attempt.answer
  }

  private prompt(attempt: Attempt, prompt: AuthorizationPrompt, attemptSignal: AbortSignal): Promise<string> {
    const signal = prompt.signal === undefined ? attemptSignal : AbortSignal.any([attemptSignal, prompt.signal])
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const clear = (): void => {
        signal.removeEventListener('abort', cancel)
        if (attempt.state.prompt?.id === id) {
          delete attempt.state.prompt
          delete attempt.answer
        }
      }
      const cancel = (): void => { clear(); reject(new DOMException('Authorization prompt was withdrawn.', 'AbortError')) }
      signal.addEventListener('abort', cancel, { once: true })
      attempt.state.prompt = { id, kind: prompt.kind, message: prompt.message,
        ...prompt.kind === 'select' ? { options: prompt.options.map(({ id: optionId, label }) => ({ id: optionId, label })) } : {} }
      attempt.answer = (value) => { clear(); resolve(value) }
    })
  }
}
