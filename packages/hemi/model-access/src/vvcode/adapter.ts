/** VVCode model routing keeps management PATs out of inference and freezes each group's key reference. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Api, Model, ModelThinkingLevel, Provider } from '@earendil-works/pi-ai'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import { authContextFrom, credentialStoreFrom, PiAiAdapter, resolveProfiles } from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiProviderProfile, ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ModelOptions } from '../types.ts'
import { withProtocolReasoning } from '../protocol-reasoning.ts'
import type { ProtocolReasoningDefault } from '../protocol-reasoning.ts'

/** Protocols supported by the VVCode subscription transport. */
export type VvcodeApi = 'openai-completions' | 'openai-responses' | 'anthropic-messages'

/** Provider route of the migrated legacy group; every other group owns a `vvcode-group-…` route. */
export const VVCODE_PROVIDER = 'vvcode'

/**
 * Derive the stable provider route for one group binding. The derivation names only the site
 * origin, account, and group — never the token — so recreating a group's token keeps the same
 * route and its recorded provider:model choices.
 * @param origin - HTTPS site origin that issued the key.
 * @param userId - VVCode account ID owning the binding.
 * @param group - Exact application-authorized group name.
 * @returns the stable provider route ID.
 */
export function vvcodeProviderId(origin: string, userId: string | number, group: string): string {
  const hash = createHash('sha256').update(JSON.stringify([origin, String(userId), group])).digest('hex')
  return `${VVCODE_PROVIDER}-group-${hash.slice(0, 16)}`
}

/**
 * Identify the provider namespace reserved for VVCode group routes, including the legacy route.
 * @param provider - Native LLM provider route ID.
 * @returns whether the ID belongs to the reserved VVCode namespace.
 */
export function isVvcodeProvider(provider: string): boolean {
  return provider === VVCODE_PROVIDER || provider.startsWith(`${VVCODE_PROVIDER}-group-`)
}

/** Non-secret binding of one group: its route, key reference, catalog, and selection. */
export interface VvcodeGroupConnection {
  /** HTTPS origin that issued the model API key. */
  origin: string
  /** Exact application-authorized group; the settings key names the same group. */
  group: string
  /** Account ID owning the group's model token. */
  userId: string
  /** Server-side model token ID used for exact key lookup. */
  tokenId: number
  /** Credential reference containing the group's model API key, never its literal value. */
  apiKeyRef: string
  /** Stable provider route derived from origin, account, and group. */
  provider: string
  /** Models advertised to the group's key with supported site-declared protocols. */
  models: readonly {
    /** Gateway model identifier. */
    id: string
    /** Site-declared protocol used for this model. */
    api: VvcodeApi
  }[]
  /** Model IDs the owner enabled for this group. */
  selected: readonly string[]
  /** Last advertised billing multiplier; absent until a read reports one. */
  ratio?: number | 'auto'
  /** Last advertised description; absent until a read reports one. */
  desc?: string
  /** Set when a successful authorized-group read confirmed the group is no longer authorized. */
  revoked?: boolean
}

/** The legacy single-group binding, kept readable until its one-time migration lands. */
export type VvcodeLegacyConnection = {
  /** HTTPS origin that issued the single group's key. */
  origin: string
  /** Exact group name adopted by the multi-group collection. */
  group: string
  /** Account ID owning the legacy group token. */
  userId: string
  /** Server token ID retained during adoption. */
  tokenId: number
  /** Existing credential reference, retained without copying its secret. */
  apiKeyRef: string
  /** Previously advertised model protocols for the single group. */
  models: readonly {
    /** Gateway model ID, retained in saved Session references. */
    id: string
    /** Site-declared protocol for this model. */
    api: VvcodeApi
  }[]
}

/** One published provider route: the adapter reads only these routing facts. */
export interface VvcodeRoute {
  /** Stable provider route ID. */
  provider: string
  /** Owning group name, used for the visible model-name suffix. */
  group: string
  /** Credential reference for the group's key; absent publishes a route with no models. */
  apiKeyRef: string | undefined
  /** Models advertised to the group's key. */
  models: readonly { id: string; api: VvcodeApi }[]
  /** Model IDs the owner enabled for this group. */
  selected: readonly string[]
  /** Per-model capability overrides for this route. */
  options: Record<string, ModelOptions>
}

/** The subscription owns selection and credentials; this module only adapts model requests. */
export interface VvcodeAdapterState {
  origin: string
  /** Current routes by provider ID; identity-stable between committed changes. */
  routes: () => readonly VvcodeRoute[]
  /** Verify the account and the exact route before a request resolves its key. */
  requireAccount: (provider: string) => Promise<void>
  /**
   * Deployment reasoning offers for route models the installed catalog cannot describe; absent
   * publishes referenced capabilities alone. The same decoration rules as the configured-profile
   * listener, so VVCode routes never carry a parallel effort policy.
   */
  reasoningDefaults?: Readonly<Record<string, ProtocolReasoningDefault>>
}

/** Group label appended to every published model name so pickers distinguish same-named models. */
function groupSuffix(group: string): string {
  return ` · ${group}`
}

/**
 * Append the group label to one model name exactly once; a stale name already carrying the
 * label loses it first, so the published name always names its group once.
 */
function withGroupSuffix(name: string, group: string): string {
  const suffix = groupSuffix(group)
  const base = name.endsWith(suffix) ? name.slice(0, -suffix.length) : name
  return `${base}${suffix}`
}

/**
 * Register the VVCode provider routes with immutable per-protocol model snapshots. An unclaimed
 * route holds the model-less account placeholder, without taking over existing API connections.
 * Saved groups publish their own routes, including `vvcode` for an adopted legacy binding.
 * @param ctx - Owning Hemi plugin context.
 * @param state - Current non-secret routes and the account authorization check.
 * @returns a callback that republishes the routes after committed changes.
 */
export function mountVvcodeAdapter(ctx: Context, state: VvcodeAdapterState): () => void {
  const occupied = new Set(ctx.llm.listProviders().map(provider => provider.id))
  let placeholder = VVCODE_PROVIDER
  for (let suffix = 0; occupied.has(placeholder); suffix += 1) {
    placeholder = `vvcode-group-empty-${suffix}`
  }
  const fetchVvcode: typeof fetch = (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.origin !== state.origin || url.username || url.password) {
      throw new LlmError('VVCode model requests must stay on the configured site.', 'INVALID_CONFIG')
    }
    return fetch(request, { redirect: 'error' })
  }
  let previous: readonly VvcodeRoute[] | undefined
  let profiles = resolveProfiles({ [placeholder]: {
    displayName: 'VVCode', api: 'openai-completions', baseURL: `${state.origin}/v1`, models: [],
  } }, 'deferred')
  const providerIds = (routes: readonly VvcodeRoute[]): string[] =>
    [placeholder, ...routes.map(route => route.provider).filter(id => id !== placeholder)]
  const adapter = new PiAiAdapter({
    profiles: () => {
      const routes = state.routes()
      if (previous === routes) return profiles
      previous = routes
      const draft: Record<string, PiAiProviderProfile> = { [placeholder]: {
        displayName: 'VVCode', api: 'openai-completions', baseURL: `${state.origin}/v1`, models: [],
      } }
      for (const route of routes) {
        draft[route.provider] = {
          displayName: `VVCode · ${route.group}`, api: 'openai-completions',
          baseURL: `${state.origin}/v1`, models: [], headers: { 'X-AI-App': 'hemi-dsh' },
          ...route.apiKeyRef === undefined ? {} : { apiKeyEnv: route.apiKeyRef },
        }
      }
      const resolved = resolveProfiles(withProtocolReasoning(draft, state.reasoningDefaults ?? {}), 'deferred')
      for (const route of routes) {
        const base = resolved.get(route.provider)
        if (base === undefined) throw new Error('The VVCode subscription could not be resolved.')
        // A route whose selection is empty publishes its model-less base profile, like the legacy route did.
        const merged = mergeRouteProtocols(state.origin, route, fetchVvcode, state.reasoningDefaults ?? {})
        if (merged !== undefined) resolved.set(route.provider, { ...base, ...merged })
      }
      profiles = resolved
      return profiles
    },
    auth: { credentials: credentialStoreFrom(ctx), authContext: authContextFrom(ctx) },
    async resolveApiKey(provider, profile) {
      await state.requireAccount(provider)
      if (profile.apiKeyEnv === undefined) throw new LlmError('Choose a VVCode group first.', 'MISSING_CREDENTIAL')
      const key = await ctx.credentials.resolve(credentialRef(profile.apiKeyEnv))
      if (key === undefined) throw new LlmError('Reconnect the VVCode group to restore its API key.', 'MISSING_CREDENTIAL')
      return key.value
    },
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments, path => ctx.get('fs')?.processPathFromHostPath(path), ref,
    ),
  })
  const registration = ctx.llm.registerAdapter(providerIds(state.routes()), adapter)
  return () => { registration.replace(providerIds(state.routes())) }
}

/**
 * Build one route's per-protocol transport merge: every advertised protocol with selected
 * models becomes its own native pi-ai provider, and the published route dispatches by the
 * model's declared protocol while each request carries that group's key. Route profiles pass
 * through the shared Hemi profile decoration, so referenced catalog capabilities resolve the
 * same way as on configured routes.
 * @param origin - HTTPS site origin for every protocol endpoint.
 * @param route - The group route to publish.
 * @param fetchVvcode - Origin-checked fetch the transports must use.
 * @param reasoningDefaults - Deployment reasoning offers for models the catalog cannot describe.
 * @returns the profile overrides for this route, or undefined when no protocol could resolve.
 */
function mergeRouteProtocols(
  origin: string, route: VvcodeRoute, fetchVvcode: typeof fetch,
  reasoningDefaults: Readonly<Record<string, ProtocolReasoningDefault>>,
): Pick<ResolvedPiAiProviderProfile, 'piProvider' | 'configuredMaxTokens' | 'configuredReasoningEfforts'> | undefined {
  const routes = new Map<VvcodeApi, Provider>()
  const configuredReasoningEfforts = new Map<string, ModelThinkingLevel>()
  for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages'] as const) {
    const models = route.models.filter(model => model.api === api && route.selected.includes(model.id))
      .map((model) => {
        const { input, ...override } = route.options[model.id] ?? {}
        return { id: model.id, ...override, ...input === undefined ? {} : { input: [...input] } }
      })
    if (models.length === 0) continue
    const profile = resolveProfiles(withProtocolReasoning({ [route.provider]: {
      displayName: `VVCode · ${route.group}`, api,
      baseURL: api === 'anthropic-messages' ? origin : `${origin}/v1`,
      models, headers: { 'X-AI-App': 'hemi-dsh' },
      ...route.apiKeyRef === undefined ? {} : { apiKeyEnv: route.apiKeyRef },
    } }, reasoningDefaults)).get(route.provider)
    if (profile?.piProvider === undefined) throw new Error('The VVCode model protocol could not be resolved.')
    routes.set(api, profile.piProvider)
    // Explicit request defaults materialized inside the protocol providers stay
    // effective on the published route: the adapter reads them from the outer
    // profile, whose own model-less resolution carries none.
    for (const [id, level] of profile.configuredReasoningEfforts) configuredReasoningEfforts.set(id, level)
  }
  if (routes.size === 0) return undefined
  const profile = routes.values().next().value
  if (profile === undefined) throw new Error('The VVCode subscription could not be resolved.')
  const models: Model<Api>[] = [...routes.values()].flatMap(protocol =>
    [...protocol.getModels()].map(model => ({ ...model, name: withGroupSuffix(model.name, route.group) })))
  const routeFor = (api: Api): Provider => {
    const protocol = routes.get(api as VvcodeApi)
    if (protocol === undefined) throw new LlmError('The VVCode model protocol is unavailable.', 'INVALID_CONFIG')
    return protocol
  }
  return {
    piProvider: {
      ...profile, getModels: () => models,
      stream: (model, context, request) => routeFor(model.api).stream(model, context, Object.assign({}, request, { fetch: fetchVvcode })),
      streamSimple: (model, context, request) => routeFor(model.api).streamSimple(
        model, context, Object.assign({}, request, { fetch: fetchVvcode })),
    },
    configuredMaxTokens: new Map(Object.entries(route.options).flatMap(([id, value]) =>
      value.maxTokens === undefined ? [] : [[id, value.maxTokens]])),
    configuredReasoningEfforts,
  }
}
