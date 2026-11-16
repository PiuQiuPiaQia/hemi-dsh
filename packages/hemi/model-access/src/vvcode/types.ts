/** VVCode subscription protocol DTOs, options, and stable failure codes. */
import type { VvcodeUsage } from '../types.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The VVCode browser login or one-shot code exchange failed; no grant exists. */
    'hemi/vvcode-login-failed': { readonly reason: VvcodeLoginFailure }
    /** The scoped PAT no longer authorizes VVCode management requests. */
    'hemi/vvcode-management-auth-expired': {}
    /** The model API key no longer authorizes VVCode relay requests. */
    'hemi/vvcode-model-auth-expired': {}
    /** VVCode refused a request, returned an unusable response, or never answered. */
    'hemi/vvcode-request-failed': { readonly operation: VvcodeOperation; readonly status?: number }
    /** A token creation was sent whose outcome was never observed; recover through `uniqueName`. */
    'hemi/vvcode-token-unknown': { readonly uniqueName: string; readonly group: string }
    /** VVCode answered the creation request itself with a definite refusal; no pending record is needed. */
    'hemi/vvcode-token-refused': { readonly status?: number }
  }
}

/** Why a VVCode login failed; the error message carries the user-facing detail. */
export type VvcodeLoginFailure = 'callback' | 'timeout' | 'exchange'

/** The client operation a VVCode request failure belongs to. */
export type VvcodeOperation =
  | 'list-groups'
  | 'group-models'
  | 'list-tokens'
  | 'find-token'
  | 'create-token'
  | 'token-key'
  | 'delete-token'
  | 'token-detail'
  | 'list-models'
  | 'model-candidates'
  | 'self'
  | 'usage-status'
  | 'usage-balance'
  | 'usage-subscriptions'

/** Successful VVCode OAuth 2.0 + PKCE S256 login. */
export interface VvcodeGrant {
  /** Scoped personal access token (`nap_…`) that authorizes VVCode management APIs. */
  accessToken: string
  /** Numeric VVCode account ID that confirmed the authorization. */
  userId: number
  /** Absolute PAT expiry in epoch milliseconds. */
  expiresAt: number
  /** Granted scopes in server order; callers verify the scopes they require. */
  scopes: string[]
}

/** Inputs for one VVCode browser login. */
export interface VvcodeLoginInput {
  /** Deployment site origin (`https://…`) hosting the login page and token endpoint. */
  origin: string
  /** Whole-login deadline in milliseconds, covering the browser wait and the code exchange. */
  timeoutMs: number
  /** Byte budget for the token endpoint's JSON response. */
  maxResponseBytes: number
  /**
   * Called once with the browser start URL after the loopback listener is bound; the caller opens
   * the browser. Absent means the caller starts the browser itself or drives the callback directly.
   */
  notifyURL?: (startUrl: string) => void
  /** Caller cancellation; aborting closes the listener and rejects the login with the reason. */
  signal?: AbortSignal
}

/** One VVCode group the signed-in account may use. */
export interface VvcodeGroup {
  /** Group identifier to send in token and relay requests. */
  name: string
  /** Billing multiplier, or `'auto'` for the server-managed auto group. */
  ratio: number | 'auto'
  /** Server-provided description; display only, never a group identifier. */
  desc: string
}

/** The signed-in account identity behind the scoped PAT. */
export interface VvcodeSelf {
  /** Numeric VVCode account ID; re-login with a different ID requires disconnecting first. */
  id: number
  /** Account login name. */
  username: string
  /** Display name; empty when the account has none. */
  displayName: string
}

/** One account API token as VVCode reports it; the raw key never appears in views. */
export interface VvcodeTokenView {
  /** Server token ID used by the key, delete, and detail operations. */
  id: number
  /** Owning VVCode account ID. */
  userId: number
  /** Token name; creation uses a unique name so an unknown outcome stays re-checkable. */
  name: string
  /** Bound group; empty when the token inherits the account's own group. */
  group: string
  /** Whether the token currently passes relay requests. */
  enabled: boolean
  /** Absolute expiry in epoch milliseconds; absent means the token never expires. */
  expiresAt?: number
}

/** One pricing-catalog entry that listed the requested group. */
export interface VvcodePricingCandidate {
  /** Model identifier as relay requests must spell it. */
  modelName: string
  /** Groups whose tokens can call this model; always includes the requested group. */
  enableGroups: string[]
  /** Server-declared endpoint types (`openai`, `openai-response`, `anthropic`, …); empty when unlisted. */
  supportedEndpointTypes: string[]
}

/** One relay-catalog model with the endpoint metadata VVCode declares for it. */
export interface VvcodeCatalogModel {
  /** Model identifier as relay requests must spell it. */
  id: string
  /** Server-declared endpoint types (`openai`, `openai-response`, `anthropic`, …); empty when unlisted. */
  supportedEndpointTypes: string[]
}

/** Required, validated request budgets for a protocol client; production values come from config. */
export interface VvcodeClientOptions {
  /** Deployment site origin (`https://…`); management and relay requests live here. */
  origin: string
  /** Scoped PAT (`nap_…`) from a completed VVCode login. */
  accessToken: string
  /** Expected account ID; when present, created tokens are re-checked against it. */
  userId?: number
  /** Per-request deadline in milliseconds. */
  timeoutMs: number
  /** Byte budget for every JSON response body. */
  maxResponseBytes: number
  /** Maximum pages scanned by one token list read. */
  tokenPageLimit: number
  /** Maximum advertised model IDs accepted from one model or pricing read. */
  maxModels: number
}

/**
 * Typed VVCode protocol client for one validated site origin. Management methods use the scoped
 * PAT and never touch `/v1`; `listModels` is the only relay method and never sends the PAT.
 */
export interface VvcodeClient {
  /** Groups the account may use, sorted by name; an empty result means no configured group. */
  listGroups(signal?: AbortSignal): Promise<VvcodeGroup[]>
  /**
   * Read-only directory of the model IDs the server enables for one authorized group under the
   * signed-in account, bounded by `maxModels`. The read needs only the PAT's `profile:read`
   * scope, creates no token or key, and never reaches `/v1`; it is for browsing and selection
   * only, and the group's own key catalog stays the protocol authority at connection time.
   * @param group - Exact application-authorized group name.
   * @param signal - Caller cancellation, when supplied.
   */
  groupModels(group: string, signal?: AbortSignal): Promise<string[]>
  /** The signed-in account identity, for verifying an existing binding before reconnecting. */
  self(signal?: AbortSignal): Promise<VvcodeSelf>
  /**
   * Wallet balance and active subscriptions in the site's configured display unit, without
   * invoking a model. The public status read carries no credential and decides the unit: its
   * failure fails the whole read. The balance and subscription reads use the scoped PAT and
   * fail independently into their own `unavailable` state, while a 401 throws the
   * account-expired failure. A grant without the `wallet:read` scope, or a server-side
   * refusal of the subscription read, reports subscriptions as `reauthorize` without sending
   * it or marking the account expired; subscription records naming another account fail the
   * subscription read, and totals are never accumulated.
   * @param scopes - Scopes of the credential in use; decides whether subscriptions are queried.
   * @param signal - Caller cancellation, when supplied.
   */
  usage(scopes: readonly string[], signal?: AbortSignal): Promise<VvcodeUsage>
  /**
   * Ordinary account tokens, newest first. VVCode hides application-exclusive tokens from this
   * list; exclusive tokens are only reachable by the ID returned at their creation.
   */
  listTokens(signal?: AbortSignal): Promise<VvcodeTokenView[]>
  /**
   * Exact-name token lookup among ordinary tokens; undefined when absent. VVCode hides
   * application-exclusive tokens from search, so an unknown exclusive creation cannot be
   * found by name and must stay reported as unknown instead of being re-sent.
   */
  findToken(uniqueName: string, signal?: AbortSignal): Promise<VvcodeTokenView | undefined>
  /** Detail lookup by token ID, including application-exclusive tokens. */
  getToken(id: number, signal?: AbortSignal): Promise<VvcodeTokenView>
  /**
   * Create one never-expiring, unlimited-quota token pinned to `group`, then verify it by exact
   * name, group, and account. One request; refusals and unobserved outcomes never retry.
   * @param uniqueName - Caller-chosen unique token name; the recovery key for unknown outcomes.
   * @param group - Group the token is pinned to.
   * @param signal - Caller cancellation.
   * @param onCreatedId - Called with the server token ID as soon as it is known — from the
   * creation response before verification, or from the exact-name search when the creation
   * carried no ID — so the caller can persist it before any later step can fail.
   */
  createToken(
    uniqueName: string,
    group: string,
    signal?: AbortSignal,
    onCreatedId?: (id: number) => Promise<void>,
  ): Promise<VvcodeTokenView>
  /** Reveal the stored API key for one token; requires the `api_key:reveal` PAT scope. */
  tokenKey(id: number, signal?: AbortSignal): Promise<string>
  /** Delete one token by ID; an unobserved outcome throws instead of reporting success. */
  deleteToken(id: number, signal?: AbortSignal): Promise<void>
  /** Model IDs the key advertises on `/v1/models`, bounded by `maxModels`. */
  listModels(apiKey: string, signal?: AbortSignal): Promise<string[]>
  /**
   * Relay-catalog rows with the endpoint metadata each model declares on `/v1/models`,
   * bounded by `maxModels`. Unlisted endpoint metadata is empty, never guessed.
   */
  modelCatalog(apiKey: string, signal?: AbortSignal): Promise<VvcodeCatalogModel[]>
  /** Pricing entries that listed `group`, sorted by model name, bounded by `maxModels`. */
  modelCandidates(group: string, signal?: AbortSignal): Promise<VvcodePricingCandidate[]>
}
