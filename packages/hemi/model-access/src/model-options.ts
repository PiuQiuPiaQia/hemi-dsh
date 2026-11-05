/** Model field edits over existing settings, preserving all other adapter options. */
import type { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ModelOptions, ModelOptionsView } from './types.ts'
import { asObject } from './response.ts'

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
  const ns = ownBigModel && provider === 'bigmodel' ? 'hemi-model-access' : 'llm-pi-ai'
  const section = ctx.settings.describe().find(item => item.ns === ns)
  if (section === undefined) throw modelSettingsFailure('Model settings are unavailable.')
  const root = asObject(section.value)
  const route = asObject(asObject(root?.providers)?.[provider])
  const models: unknown[] = Array.isArray(route?.models) ? route.models : []
  const previous: unknown = ns === 'hemi-model-access'
    ? asObject(asObject(root?.subscriptionModelOptions)?.[provider])?.[model]
    : models.find(value => asObject(value)?.id === model)
  return { ns, section, models, previous }
}

/**
 * Read overrides for a model currently offered by its adapter.
 * @param ctx - Host context providing settings and model services.
 * @param provider - Configured provider ID.
 * @param model - Available model ID.
 * @param ownBigModel - Whether the Hemi plugin owns the GLM adapter.
 * @returns the explicit model overrides and current settings revision.
 */
export async function readModelOptions(ctx: Context, provider: string, model: string, ownBigModel: boolean): Promise<ModelOptionsView> {
  if (!(await ctx.llm.listModels(provider)).some(item => item.id === model)) throw modelSettingsFailure('This model is no longer available.')
  const { section, previous } = configuration(ctx, provider, model, ownBigModel)
  return { revision: section.revision, options: modelOptionsOf(previous) }
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
  const { ns, models, previous } = configuration(ctx, provider, model, ownBigModel)
  const updated = applyModelOptions(previous, options)
  const path = ns === 'hemi-model-access' ? ['subscriptionModelOptions', provider, model] : ['providers', provider, 'models']
  const catalog = models.length === 0 ? available.map(item => ({ id: item.id })) : models
  const value = ns === 'hemi-model-access' ? updated : catalog.map(item => asObject(item)?.id === model ? { ...updated, id: model } : item)
  await ctx.settings.mutate(ns, [{ op: 'set', path, value }], revision)
}
