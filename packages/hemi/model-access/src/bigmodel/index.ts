/** Expose the Hemi Coding Plan provider to the Harness LLM and authorization registries. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-authorization'
import type {} from '@deepseek-ai/dsh-fs'
import { LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import { authContextFrom, credentialStoreFrom, PiAiAdapter, recordKeyFor, resolveProfiles } from '@deepseek-ai/dsh-llm-pi-ai'
import type { Api, Model, ModelThinkingLevel, OAuthCredential, Provider } from '@earendil-works/pi-ai'
import { BIGMODEL_ORIGIN, bigModelCodingProvider, codingAuthKey, ensureCodingCredential } from '#bigmodel-protocol'
import { withProtocolReasoning } from '../protocol-reasoning.ts'
import type { ProtocolReasoningDefault } from '../protocol-reasoning.ts'
import { asObject, readJson } from '../response.ts'
import type { ModelOptions, QuotaWindow } from '../types.ts'

/** Stable route and credential identity used by the Hemi Coding Plan transport. */
export const BIGMODEL_PROVIDER = 'bigmodel'

/** Anthropic Messages endpoint every shipped and service-advertised Coding Plan model speaks. */
const BIGMODEL_BASE_URL = 'https://open.bigmodel.cn/api/anthropic'

const DEVICE_KEY = credentialKey('hemi-model-access', 'glm-device')

async function deviceId(ctx: Context): Promise<string> {
  const record = await ctx.credentials.modifyRecord(DEVICE_KEY, current => Promise.resolve(
    current === undefined ? { kind: 'grant', payload: randomUUID() } : undefined,
  ))
  if (record?.kind !== 'grant' || typeof record.payload !== 'string') throw new Error('GLM device identity is unavailable.')
  return record.payload
}

/** Models one Coding Plan selection publishes, with the request defaults that belong to them. */
export interface BigModelCatalog {
  /** Selected models in selection order, explicit capability edits applied. */
  readonly models: readonly Model<Api>[]
  /** Request reasoning defaults chosen for IDs the shipped catalog does not list. */
  readonly configuredReasoningEfforts: ReadonlyMap<string, ModelThinkingLevel>
}

/**
 * Resolve the selected Coding Plan models over the shipped catalog. A selected ID the catalog
 * lists keeps the capabilities the provider ships. A service-advertised ID it has not caught up
 * with resolves on this route's Anthropic Messages protocol through the protocol reasoning
 * fallback, the same reasoning defaults every other route reads, so its effort selector and
 * request default exist before the catalog lists it.
 * @param shipped - Models the Coding Plan provider ships.
 * @param selected - Selected model IDs; undefined selects every shipped model.
 * @param overrides - Explicit per-model capability edits.
 * @param reasoningDefaults - Deployment reasoning offers for models the catalog cannot describe.
 * @returns the publishable models and the fallback request defaults that belong to them.
 * @throws LlmError - A selected ID resolves to no model.
 */
export function bigModelCatalog(
  shipped: readonly Model<Api>[], selected: readonly string[] | undefined,
  overrides: Record<string, ModelOptions> | undefined,
  reasoningDefaults: Readonly<Record<string, ProtocolReasoningDefault>>,
): BigModelCatalog {
  const installed = new Map(shipped.map(model => [model.id, model]))
  const selectedIds = selected ?? [...installed.keys()]
  const missing = selectedIds.filter(id => !installed.has(id))
  let configuredReasoningEfforts: ReadonlyMap<string, ModelThinkingLevel> = new Map()
  if (missing.length > 0) {
    const fallback = resolveProfiles(withProtocolReasoning({ [BIGMODEL_PROVIDER]: {
      api: 'anthropic-messages', baseURL: BIGMODEL_BASE_URL, models: missing.map(id => ({ id })),
    } }, reasoningDefaults)).get(BIGMODEL_PROVIDER)
    for (const model of fallback?.piProvider?.getModels() ?? []) installed.set(model.id, model)
    configuredReasoningEfforts = fallback?.configuredReasoningEfforts ?? configuredReasoningEfforts
  }
  const models = selectedIds.map((id) => {
    const model = installed.get(id)
    if (model === undefined) throw new LlmError('The selected subscription model could not be configured.', 'INVALID_CONFIG')
    const override = overrides?.[id]
    return { ...model, ...override, input: [...(override?.input?.length ? override.input : model.input)] }
  })
  return { models, configuredReasoningEfforts }
}

/**
 * Mount the legacy protocol over the same store and Pi adapter used for Harness inference.
 * @param ctx - Owning Host or Client context providing the required services.
 * @param selection - Read the currently configured subscription model IDs.
 * @param overrides - Read explicit per-model capability overrides.
 * @param reasoningDefaults - Deployment reasoning offers for models the shipped catalog cannot describe.
 * @returns a model-directory refresh callback, or undefined when the provider is not mounted.
 */
export function mountBigModel(ctx: Context, selection: () => readonly string[] | undefined,
  overrides: () => Record<string, ModelOptions> | undefined,
  reasoningDefaults: Readonly<Record<string, ProtocolReasoningDefault>>): (() => void) | undefined {
  // A manually configured route should retain ownership of its provider ID.
  if (ctx.llm.listProviders().some(provider => provider.id === BIGMODEL_PROVIDER)) return
  const credentials = credentialStoreFrom(ctx)
  const provider: Provider = bigModelCodingProvider(credentials)
  const oauth = provider.auth.oauth
  if (oauth === undefined) throw new Error('The GLM Coding Plan provider has no authorization flow.')
  const profiles = resolveProfiles({
    [BIGMODEL_PROVIDER]: {
      api: 'anthropic-messages',
      baseURL: BIGMODEL_BASE_URL,
      displayName: provider.name,
      models: provider.getModels().map(model => ({
        id: model.id, input: [...model.input], contextWindow: model.contextWindow, maxTokens: model.maxTokens,
      })),
      retryPolicy: { mode: 'normal', maxRetries: 0 },
    },
  })
  const profile = profiles.get(BIGMODEL_PROVIDER)
  if (profile === undefined) throw new Error('The GLM Coding Plan profile was not resolved.')
  profiles.set(BIGMODEL_PROVIDER, { ...profile, piProvider: provider, configuredMaxTokens: new Map() })
  const key = recordKeyFor(BIGMODEL_PROVIDER)
  let lastSelection: readonly string[] | undefined
  let lastOverrides: Record<string, ModelOptions> | undefined
  let currentProfiles = profiles
  const adapter = new PiAiAdapter({
    profiles: () => {
      const selected = selection()
      const options = overrides()
      if (selected === lastSelection && options === lastOverrides) return currentProfiles
      lastSelection = selected
      lastOverrides = options
      const catalog = bigModelCatalog(provider.getModels(), selected, options, reasoningDefaults)
      currentProfiles = new Map([[BIGMODEL_PROVIDER, {
        ...profile, piProvider: {
          ...provider, getModels: () => catalog.models,
        }, configuredMaxTokens: new Map(Object.entries(options ?? {}).flatMap(([id, value]) =>
          value.maxTokens === undefined ? [] : [[id, value.maxTokens]])),
        configuredReasoningEfforts: new Map([...profile.configuredReasoningEfforts, ...catalog.configuredReasoningEfforts]),
      }]])
      return currentProfiles
    },
    auth: { credentials, authContext: authContextFrom(ctx) },
    async resolveApiKey() {
      if ((await ctx.credentials.describeRecord(key)).kind !== 'grant') {
        throw new LlmError('请先在「模型接入」中授权 GLM Coding Plan。', 'MISSING_CREDENTIAL')
      }
      return undefined
    },
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments, path => ctx.get('fs')?.processPathFromHostPath(path), ref,
    ),
  })
  const registration = ctx.llm.registerAdapter([BIGMODEL_PROVIDER], adapter)
  ctx.authorization.registerFlow({
    key, label: provider.name, methods: [{ id: 'oauth', label: 'GLM Coding Plan' }],
    async run(session) {
      const device = await deviceId(ctx)
      session.signal.throwIfAborted()
      const grant = await oauth.login({
        signal: session.signal,
        notify: (event) => {
          if (event.type === 'auth_url') session.notify({ url: event.url, message: '在浏览器完成智谱账号授权。' })
          else if (event.type === 'progress') session.notify({ message: event.message })
        },
        prompt: () => Promise.reject(new Error('Unexpected GLM Coding Plan prompt.')),
      }, { getDeviceId: () => device, agentName: 'Hemi' })
      await session.commit({ kind: 'grant', payload: grant })
    },
  })
  return () => { registration.replace([BIGMODEL_PROVIDER]) }
}

/**
 * Read Coding Plan pool windows with the current short-lived project grant.
 * @param ctx - Owning Host or Client context providing the required services.
 * @param signal - Caller cancellation for this asynchronous operation.
 * @returns the provider-reported quota windows.
 */
export async function bigModelQuota(ctx: Context, signal: AbortSignal): Promise<QuotaWindow[]> {
  const credentials = credentialStoreFrom(ctx)
  const grant = await credentials.read(BIGMODEL_PROVIDER)
  if (grant?.type !== 'oauth') throw new Error('Connect GLM Coding Plan first.')
  const current: OAuthCredential = await ensureCodingCredential(credentials, { authKey: codingAuthKey(grant), signal })
  const response = await fetch(`${BIGMODEL_ORIGIN}/api/monitor/usage/quota/limit`, {
    headers: { Authorization: `Bearer ${current.access}`, Accept: 'application/json' }, redirect: 'error', signal,
  })
  const body = asObject(await readJson(response))
  const limits = (asObject(body?.data) ?? body)?.limits
  const windows: QuotaWindow[] = []
  if (Array.isArray(limits)) for (const raw of limits) {
    const pool = asObject(raw)
    if (pool?.type !== 'CREDIT_LIMIT') continue
    const seconds = pool.unit === 3 ? 18_000 : pool.unit === 6 ? 604_800 : 0
    if (seconds === 0 || windows.some(window => window.seconds === seconds)) continue
    const { remaining, usage, percentage, nextResetTime } = pool
    const percent = typeof remaining === 'number' && typeof usage === 'number' && usage > 0
      ? 100 * remaining / usage : typeof percentage === 'number' ? 100 - percentage : undefined
    if (percent === undefined || !Number.isFinite(percent)) continue
    windows.push({ seconds, remainingPercent: Math.max(0, Math.min(100, percent)),
      ...typeof remaining === 'number' && Number.isFinite(remaining) ? { remainingCredits: remaining } : {},
      ...typeof usage === 'number' && Number.isFinite(usage) ? { totalCredits: usage } : {},
      ...typeof nextResetTime === 'number' && nextResetTime > 0 && Number.isSafeInteger(nextResetTime)
        ? { resetAt: nextResetTime < 1e12 ? nextResetTime * 1000 : nextResetTime } : {} })
  }
  if (windows.length === 0) throw new Error('No GLM Coding Plan quota windows were returned.')
  return windows.sort((a, b) => a.seconds - b.seconds)
}
