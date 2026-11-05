/** Exact-id capability inheritance for imported gateway models. */
import type { Api, Model } from '@earendil-works/pi-ai'
import { getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all'
import type { PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_INPUT, DEFAULT_MAX_TOKENS } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ModelOptions } from './types.ts'

const installed: ReadonlyMap<string, ReadonlyMap<string, Model<Api>>> = new Map(getBuiltinProviders().map(id => (
  [id, new Map(getBuiltinModels(id).map(model => [model.id, model]))]
)))

/**
 * Read an exact model from a named installed provider.
 * @param provider - Installed provider id.
 * @param model - Exact model id.
 * @returns the installed model, when present on that provider.
 */
export function installedCatalogModel(provider: string, model: string): Model<Api> | undefined {
  return installed.get(provider)?.get(model)
}

/**
 * Find intrinsic capabilities without guessing from model names or importing vendor transport.
 * @param api - Connection wire protocol.
 * @param id - Exact model id returned by discovery or entered by the owner.
 * @returns the canonical vendor entry, or an unambiguous matching protocol entry.
 */
export function importedCatalogModel(api: string, id: string): Model<Api> | undefined {
  const canonical = api === 'anthropic-messages' ? 'anthropic'
    : ['openai-completions', 'openai-responses', 'openai-codex-responses', 'azure-openai-responses'].includes(api) ? 'openai' : undefined
  const preferred = canonical === undefined ? undefined : installed.get(canonical)?.get(id)
  if (preferred !== undefined) return preferred
  const vendors = ['openai', 'anthropic'].flatMap((provider) => {
    const entry = installed.get(provider)?.get(id)
    return entry === undefined ? [] : [entry]
  })
  if (vendors.length === 1) return vendors[0]
  const candidates = [...installed.values()].flatMap((models) => {
    const entry = models.get(id)
    return entry?.api === api ? [entry] : []
  })
  const first = candidates[0]
  if (first === undefined) return undefined
  return candidates.every(entry => entry.contextWindow === first.contextWindow && entry.maxTokens === first.maxTokens
    && entry.input.length === first.input.length && entry.input.every(type => first.input.includes(type))) ? first : undefined
}

/**
 * Reference installed capabilities on custom routes while preserving every explicit override.
 * @param provider - Connection route id.
 * @param profile - Validated connection profile.
 * @returns a detached profile when a model can inherit exact-id catalog capabilities.
 */
export function withCatalogCapabilities(provider: string, profile: PiAiProviderProfile): PiAiProviderProfile {
  const api = profile.api
  if (api === undefined || profile.models === undefined) return profile
  return { ...profile, models: profile.models.map((entry) => {
    if (installed.get(provider)?.has(entry.id) === true || entry.catalogProvider !== undefined) return entry
    const match = importedCatalogModel(api, entry.id)
    return match === undefined ? entry : { ...entry, catalogProvider: match.provider }
  }) }
}

/**
 * Display catalog capabilities for an unsaved model, using the adapter's own fallback constants.
 * @param api - Draft connection wire protocol.
 * @param model - Exact model id.
 * @returns capabilities to display without making them explicit request overrides.
 */
export function draftModelDefaults(api: string, model: string): Required<ModelOptions> {
  const base = importedCatalogModel(api, model)
  return { name: base?.name ?? model, contextWindow: base?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: base?.maxTokens ?? DEFAULT_MAX_TOKENS, input: base?.input ?? DEFAULT_INPUT }
}
