/** Exact-id capability inheritance for imported gateway models. */
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
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
 * Preserve a unanimous non-reasoning declaration even when other capabilities disagree.
 * @param id - Exact model id returned by discovery or entered by the owner.
 * @returns whether every matching catalog entry explicitly marks the model non-reasoning.
 */
export function isKnownNonReasoningModel(id: string): boolean {
  const candidates = [...installed.values()].flatMap((models) => {
    const entry = models.get(id)
    return entry === undefined ? [] : [entry]
  })
  return candidates.length > 0 && candidates.every(entry => !entry.reasoning)
}

/**
 * Find intrinsic capabilities without guessing from model names or importing vendor transport.
 * @param api - Target protocol, used only to select an equivalent parameter encoding.
 * @param id - Exact model id returned by discovery or entered by the owner.
 * @returns an agreeing capability record, or undefined for unknown or conflicting identities.
 */
export function importedCatalogModel(api: string, id: string): Model<Api> | undefined {
  const candidates = [...installed.values()].flatMap((models) => {
    const entry = models.get(id)
    return entry === undefined ? [] : [entry]
  })
  // A missing level map supplies no evidence against an explicit, agreeing offer.
  const described = candidates.filter(entry => !entry.reasoning || entry.thinkingLevelMap !== undefined)
  const first = described[0] ?? candidates[0]
  if (first === undefined) return undefined
  if (!candidates.every(entry => entry.contextWindow === first.contextWindow && entry.maxTokens === first.maxTokens
    && entry.input.length === first.input.length && entry.input.every(type => first.input.includes(type))
    && entry.reasoning === first.reasoning)) return undefined
  const levels = getSupportedThinkingLevels(first)
  if (!described.every(entry => getSupportedThinkingLevels(entry).join(',') === levels.join(','))) return undefined
  const transports = (described.length === 0 ? candidates : described).filter(entry => entry.api === api)
  const transport = transports[0]
  if (transport === undefined) return first
  const encoding = (entry: Model<Api>): string => JSON.stringify({
    format: entry.compat !== undefined && 'thinkingFormat' in entry.compat ? entry.compat.thinkingFormat : undefined,
    levels: getSupportedThinkingLevels(entry).map(level => [level, entry.thinkingLevelMap?.[level]]),
  })
  return transports.every(entry => encoding(entry) === encoding(transport)) ? transport : undefined
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
