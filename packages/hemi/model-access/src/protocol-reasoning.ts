/** Catalog capability inheritance and protocol effort defaults for configured models. */
import type { Context } from '@deepseek-ai/cordis'
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { Config, PiAiModelProfile, PiAiProviderProfile, PiAiReasoningEfforts } from '@deepseek-ai/dsh-llm-pi-ai'
import { installedCatalogModel, withCatalogCapabilities } from './model-catalog.ts'

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
  'anthropic-messages': { efforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }, defaultEffort: 'high' },
}

/**
 * Fill unknown model efforts without replacing configured or installed capabilities.
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
    const models = profile.models?.map((entry): PiAiModelProfile => {
      const base = installedCatalogModel(provider, entry.id)
      const api = profile.api ?? base?.api
      const fallback = api === undefined ? undefined : defaults[api]
      if (fallback === undefined || base !== undefined || entry.reasoningEfforts !== undefined
        || (entry.compat?.supportsReasoningEffort ?? profile.compat?.supportsReasoningEffort) === false) return entry
      return {
        ...entry, reasoningEfforts: { ...fallback.efforts },
        defaultReasoningEffort: entry.defaultReasoningEffort ?? fallback.defaultEffort,
        ...api === 'anthropic-messages'
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
