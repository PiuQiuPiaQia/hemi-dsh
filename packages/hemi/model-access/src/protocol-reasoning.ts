/** Catalog capability inheritance and protocol effort defaults for configured models. */
import type { Context } from '@deepseek-ai/cordis'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { Config, PiAiModelProfile, PiAiProviderProfile, PiAiReasoningEfforts } from '@deepseek-ai/dsh-llm-pi-ai'
import { effortWireFamily, sharedRouteApi } from '@deepseek-ai/dsh-llm-pi-ai'
import { installedCatalogModel, isKnownNonReasoningModel, withCatalogCapabilities } from './model-catalog.ts'

type Profiles = ReturnType<Config['providers']['get']>

/** Configurable effort offer and request default for one wire protocol. */
export interface ProtocolReasoningDefault {
  /** Internal effort ids mapped to wire values; OpenAI's none uses the internal off id. */
  efforts: PiAiReasoningEfforts
  /** Initial effort used when neither the route nor the request chooses one. */
  defaultEffort: ModelThinkingLevel
}

/** Protocol effort enums and Hemi's initial request defaults. */
export const PROTOCOL_REASONING_DEFAULTS: Record<string, ProtocolReasoningDefault> = {
  'openai-completions': {
    efforts: { off: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }, defaultEffort: 'medium',
  },
  'openai-responses': {
    efforts: { off: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }, defaultEffort: 'medium',
  },
  'openai-codex-responses': {
    efforts: { off: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }, defaultEffort: 'medium',
  },
  'anthropic-messages': { efforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }, defaultEffort: 'high' },
}

/**
 * Resolve identified model efforts before using protocol defaults for unknown capabilities.
 *
 * Explicit offers and disabling settings win. Model levels remain independent of the route's
 * provider; only a matching protocol may reuse its model-specific thinking format and wire
 * values. A route without a declared api follows the protocol its installed catalog's shipped
 * models agree on — the same derivation the route resolver applies — so a subscription's bare
 * model list still names its fallback protocol. Cross-protocol offers use the target encoding
 * without importing vendor transport.
 * @param profiles - validated configured provider profiles.
 * @param defaults - protocol offers chosen by this deployment.
 * @returns detached profiles with catalog capabilities and ephemeral effort defaults for unknown models.
 */
export function withProtocolReasoning(
  profiles: Profiles, defaults: Readonly<Record<string, ProtocolReasoningDefault>>,
): Record<string, PiAiProviderProfile> {
  const detached = structuredClone(profiles) as Record<string, PiAiProviderProfile>
  return Object.fromEntries(Object.entries(detached).map(([provider, configured]) => {
    const profile = withCatalogCapabilities(provider, configured)
    const routeApi = profile.api === undefined ? sharedRouteApi(provider) : undefined
    const models = profile.models?.map((entry): PiAiModelProfile => {
      const base = installedCatalogModel(provider, entry.id)
      const api = profile.api ?? base?.api ?? routeApi
      if (base !== undefined || entry.reasoningEfforts !== undefined
        || (entry.compat?.supportsReasoningEffort ?? profile.compat?.supportsReasoningEffort) === false) return entry
      const fallback = api === undefined ? undefined : defaults[api]
      const reference = entry.catalogProvider === undefined ? undefined : installedCatalogModel(entry.catalogProvider, entry.id)
      if (reference?.reasoning === false || reference === undefined && isKnownNonReasoningModel(entry.id)) {
        return { ...entry, reasoningEfforts: false }
      }
      const declaredFormat = entry.compat?.thinkingFormat ?? profile.compat?.thinkingFormat
      const sourceFormat = reference?.compat !== undefined && 'thinkingFormat' in reference.compat
        ? reference.compat.thinkingFormat : undefined
      const sourceEffortSwitch = reference?.compat !== undefined && 'supportsReasoningEffort' in reference.compat
        ? reference.compat.supportsReasoningEffort : undefined
      // Template formats need endpoint-specific arguments, not just a format name.
      const sameEncoding = reference !== undefined && reference.api === api && sourceEffortSwitch !== false
        && sourceFormat !== 'baseten' && sourceFormat !== 'chat-template'
        && (declaredFormat === undefined || declaredFormat === sourceFormat)
      const efforts: PiAiReasoningEfforts = {}
      if (reference?.reasoning === true && reference.thinkingLevelMap !== undefined) {
        for (const level of getSupportedThinkingLevels(reference)) {
          if (sameEncoding) {
            efforts[level] = reference.thinkingLevelMap[level]
              ?? (level === 'off' ? null : api === 'anthropic-messages' && level === 'minimal' ? 'low' : level)
          } else if (api !== undefined && (effortWireFamily(api) !== undefined || api === 'anthropic-messages')) {
            efforts[level] = api === 'anthropic-messages'
              ? level === 'off' ? null : level === 'minimal' ? 'low' : level
              : level === 'off' ? 'none' : level
          }
        }
      }
      const hasModelEfforts = Object.keys(efforts).some(level => level !== 'off')
      const resolvedEfforts = hasModelEfforts ? efforts : fallback?.efforts
      if (resolvedEfforts === undefined) return entry
      const defaultEffort = entry.defaultReasoningEffort ?? (hasModelEfforts ? undefined : fallback?.defaultEffort)
      return {
        ...entry, reasoningEfforts: { ...resolvedEfforts },
        ...defaultEffort === undefined ? {} : { defaultReasoningEffort: defaultEffort },
        ...api === 'openai-completions' && sameEncoding && sourceFormat !== undefined && declaredFormat === undefined
          ? { compat: { ...entry.compat, thinkingFormat: sourceFormat } }
          : api === 'anthropic-messages'
            ? { compat: { ...entry.compat,
              forceAdaptiveThinking: entry.compat?.forceAdaptiveThinking ?? profile.compat?.forceAdaptiveThinking ?? true,
            } }
            : {},
      }
    })
    return [provider, models === undefined ? profile : { ...profile, models }]
  }))
}

/**
 * Register stable, disposable profile defaults without writing user settings.
 * @param ctx - Hemi model access plugin scope.
 * @param defaults - configured offers by protocol.
 */
export function mountProtocolReasoning(ctx: Context, defaults: Readonly<Record<string, ProtocolReasoningDefault>>): void {
  for (const [api, fallback] of Object.entries(defaults)) {
    if (!Object.hasOwn(fallback.efforts, fallback.defaultEffort)) {
      throw new Error(`reasoningFallbacks.${api}.defaultEffort must name an offered reasoning level`)
    }
  }
  const cache = new WeakMap<Profiles, Profiles>()
  ctx.on('llm-pi-ai/provider-profiles', (_profiles, next) => {
    const profiles = next()
    let resolved = cache.get(profiles)
    if (resolved === undefined) {
      resolved = withProtocolReasoning(profiles, defaults)
      cache.set(profiles, resolved)
    }
    return resolved
  })
}
