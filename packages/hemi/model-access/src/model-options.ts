/** Model field edits over existing settings, preserving all other adapter options. */
import type { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ModelOptions, ModelOptionsView } from './types.ts'
import { asObject } from './response.ts'
import { draftModelDefaults, importedCatalogModel } from './model-catalog.ts'
import { catalogModels } from '@deepseek-ai/dsh-llm-pi-ai'

function modelSettingsFailure(message: string): RemoteError<'hemi/model-access-failed'> {
  return new RemoteError('hemi/model-access-failed', message, {})
}

/**
 * Extract only the fields owned by the model options editor.
 * @param value - Redacted model configuration from the settings service.
 * @returns the explicit editable overrides, without adapter defaults.
 */
export function modelOptionsOf(value: unknown): ModelOptions {
  const model = asObject(value)
  return {
    ...typeof model?.name === 'string' ? { name: model.name } : {},
    ...typeof model?.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {},
    ...typeof model?.maxTokens === 'number' ? { maxTokens: model.maxTokens } : {},
    ...Array.isArray(model?.input) && model.input.length > 0
      ? { input: model.input.filter((item): item is 'text' | 'image' => item === 'text' || item === 'image') } : {},
  }
}

/**
 * Read inherited capabilities for a draft, excluding saved per-model editor overrides.
 * @param ctx - Host settings context.
 * @param api - Draft wire protocol.
 * @param model - Exact model id.
 * @param provider - Existing connection id, when editing its draft.
 * @returns catalog capabilities and route fallbacks without per-request overrides.
 */
export function readKeyModelDefaults(ctx: Context, api: string, model: string, provider?: string): ModelOptions {
  const section = ctx.settings.describe().find(item => item.ns === 'llm-pi-ai')
  if (section === undefined) throw modelSettingsFailure('Model settings are unavailable.')
  const route = provider === undefined ? undefined : asObject(asObject(asObject(section.value)?.providers)?.[provider])
  if (provider !== undefined && route === undefined) throw modelSettingsFailure('This connection was removed.')
  const models: unknown[] = Array.isArray(route?.models) ? route.models : []
  const entry = asObject(models.find(value => asObject(value)?.id === model))
  const reference = entry?.catalogProvider
  const referenced = catalogModels(typeof reference === 'string' ? reference : provider ?? '').get(model)
  if (typeof reference === 'string' && referenced === undefined) throw modelSettingsFailure('The referenced catalog model is unavailable.')
  const base = referenced ?? importedCatalogModel(api, model)
  const fallback = draftModelDefaults(api, model)
  return { name: base?.name ?? model,
    contextWindow: base?.contextWindow ?? (typeof route?.defaultContextWindow === 'number' ? route.defaultContextWindow : fallback.contextWindow),
    maxTokens: base?.maxTokens ?? (typeof route?.defaultMaxTokens === 'number' ? route.defaultMaxTokens : fallback.maxTokens),
    input: base?.input ?? modelOptionsOf({ input: route?.defaultInput }).input ?? fallback.input,
  }
}

/**
 * Replace editable fields while retaining protocol, reasoning and other model settings.
 * @param previous - Existing model configuration, if any.
 * @param options - Explicit overrides; omitted fields return to adapter defaults.
 * @returns a model configuration containing the validated edits.
 */
export function applyModelOptions(previous: unknown, options: ModelOptions): Record<string, unknown> {
  if (options.name !== undefined && options.name.trim() === '') throw modelSettingsFailure('Model display name cannot be empty.')
  for (const value of [options.contextWindow, options.maxTokens]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw modelSettingsFailure('Model token limits must be positive integers.')
  }
  if (options.input !== undefined && options.input.length === 0) {
    throw modelSettingsFailure('Choose at least one supported input type.')
  }
  const result = { ...asObject(previous) }
  delete result.name
  delete result.contextWindow
  delete result.maxTokens
  delete result.input
  return { ...result, ...options, ...options.name === undefined ? {} : { name: options.name.trim() } }
}

function configuration(ctx: Context, provider: string, model: string, ownBigModel: boolean) {
  const account = provider === 'deepseek-account'
    ? ctx.llm.listConfigurableProviders().find(entry => entry.provider === provider) : undefined
  if (provider === 'deepseek-account' && account === undefined) throw modelSettingsFailure('Model settings are unavailable.')
  const ns = account?.settingsNs ?? (ownBigModel && provider === 'bigmodel' ? 'hemi-model-access' : 'llm-pi-ai')
  const section = ctx.settings.describe().find(item => item.ns === ns)
  if (section === undefined) throw modelSettingsFailure('Model settings are unavailable.')
  const basePath = account?.settingsPath ?? []
  const root = basePath.reduce<unknown>((value, key) => asObject(value)?.[key], section.value)
  const settings = asObject(root)
  const route = asObject(asObject(settings?.providers)?.[provider])
  const models: unknown[] = Array.isArray(route?.models) ? route.models : []
  const previous: unknown = account !== undefined ? asObject(settings?.modelOverrides)?.[model] : ns === 'hemi-model-access'
    ? asObject(asObject(settings?.subscriptionModelOptions)?.[provider])?.[model]
    : models.find(value => asObject(value)?.id === model)
  return { ns, section, models, previous, account: account !== undefined, basePath }
}

/**
 * Read overrides for a model currently offered by its adapter.
 * @param ctx - Host context providing settings and model services.
 * @param provider - Configured provider ID.
 * @param model - Available model ID.
 * @param ownBigModel - Whether the Hemi plugin owns the GLM adapter.
 * @returns explicit overrides, effective editable values and current settings revision.
 */
export async function readModelOptions(ctx: Context, provider: string, model: string, ownBigModel: boolean): Promise<ModelOptionsView> {
  if (!(await ctx.llm.listModels(provider)).some(item => item.id === model)) throw modelSettingsFailure('This model is no longer available.')
  const { ns, section, previous, account } = configuration(ctx, provider, model, ownBigModel)
  const options = modelOptionsOf(account ? { ...asObject(previous), input: asObject(previous)?.inputModalities } : previous)
  const info = await ctx.llm.resolveModelInfo(provider, model)
  const route = asObject(asObject(asObject(section.value)?.providers)?.[provider])
  const fallback = ns === 'llm-pi-ai' ? readKeyModelDefaults(ctx, typeof route?.api === 'string' ? route.api : '', model, provider) : {}
  const maxTokens = options.maxTokens ?? info.defaultMaxTokens ?? fallback.maxTokens
  return { revision: section.revision, options, effective: {
    name: info.name,
    ...info.context === undefined ? {} : { contextWindow: info.context.contextWindow },
    ...maxTokens === undefined ? {} : { maxTokens },
    ...info.inputModalities === undefined ? {} : { input: [...info.inputModalities] },
  } }
}

/**
 * Save model overrides without replacing account credentials or connection settings.
 * @param ctx - Host context providing settings and model services.
 * @param provider - Configured provider ID.
 * @param model - Available model ID.
 * @param options - Editable overrides; omitted fields restore defaults.
 * @param revision - Settings revision observed when the editor opened.
 * @param ownBigModel - Whether the Hemi plugin owns the GLM adapter.
 */
export async function writeModelOptions(
  ctx: Context, provider: string, model: string, options: ModelOptions, revision: number, ownBigModel: boolean,
): Promise<void> {
  const available = await ctx.llm.listModels(provider)
  if (!available.some(item => item.id === model)) throw modelSettingsFailure('This model is no longer available.')
  const { ns, models, previous, account, basePath } = configuration(ctx, provider, model, ownBigModel)
  const updated = applyModelOptions(previous, options)
  if (account) {
    delete updated.input
    delete updated.inputModalities
    if (options.input !== undefined) updated.inputModalities = [...options.input]
    await ctx.settings.mutate(ns, [{ op: 'set', path: [...basePath, 'modelOverrides', model], value: updated }], revision)
    return
  }
  const path = ns === 'hemi-model-access' ? ['subscriptionModelOptions', provider, model] : ['providers', provider, 'models']
  const catalog = models.length === 0 ? available.map(item => ({ id: item.id })) : models
  const value = ns === 'hemi-model-access' ? updated : catalog.map(item => asObject(item)?.id === model ? { ...updated, id: model } : item)
  await ctx.settings.mutate(ns, [{ op: 'set', path, value }], revision)
}
