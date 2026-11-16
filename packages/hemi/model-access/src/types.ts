/** Wire-safe model access DTOs and subscription failure declarations. */
export type { VvcodeLoginFailure } from './vvcode/types.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** VVCode account or group operations failed; the reason determines the safe recovery action. */
    'hemi/vvcode-failed': { reason: 'sign-in-required' | 'account-changed' | 'group-unavailable' | 'creation-unknown' | 'operation-failed' | 'busy' }
  }
}

/** Redacted subscription connection facts and selected model IDs. */
export interface Subscription {
  id: string
  name: string
  connected: boolean
  quota: boolean
  models: string[]
  /** VVCode account expiry; absent for other subscriptions or signed-out accounts. Group rows render from VvcodeDirectory. */
  vvcode?: { expiresAt: number; expired: boolean }
}

/** Every application-authorized VVCode group with its saved per-group state. */
export interface VvcodeDirectory {
  /**
   * `ready` when the live authorized-group read succeeded, so the directory is browsable
   * whether or not any group is connected — the read-only model listing never creates keys.
   * Per-group model-read failures stay local to their rows and do not downgrade the state.
   * `unavailable` when that groups read failed with the grant still valid, retaining every
   * saved group, key and selection unchanged; `sign-in-required` when no grant exists or it
   * expired, retaining saved rows for local edits.
   */
  state: 'ready' | 'unavailable' | 'sign-in-required'
  /** Authorized groups with their saved rows, sorted by name. */
  groups: VvcodeGroupView[]
}

/** One VVCode group row: live metadata where available, otherwise the last saved values. */
export interface VvcodeGroupView {
  /** Group identifier; the exact sync and relay requests name it. */
  name: string
  /** Server description, or the last saved one; empty when never read. Display only, never an identifier. */
  desc: string
  /** Billing multiplier, `'auto'`, or null when no read has reported one yet. */
  ratio: number | 'auto' | null
  /** Provider route owning this group's models; `vvcode` is the migrated legacy group. */
  provider: string
  /**
   * `not-synced` when authorized without a saved binding (a pending creation that kept its
   * token ID also reports this, and saving an enable resumes verification without recreating);
   * `ready` when the saved binding serves; `unavailable` when a successful authorized-group
   * read confirmed the group is no longer authorized, keeping the key and selection saved;
   * `creation-unknown` when an unobserved token creation is recorded for this group.
   */
  state: 'not-synced' | 'ready' | 'unavailable' | 'creation-unknown'
  /** Whether a saved binding with the group's key exists, so enabling reuses it; saving an enable for false rows prepares one first. */
  hasConnection: boolean
  /**
   * Whether this group's read-only model read failed in the latest directory pass while the
   * groups read itself succeeded. The row keeps its previous model IDs instead of faking an
   * empty list; the single-group refresh or a fresh directory read retries it.
   */
  catalogError: boolean
  /** Read-only directory model IDs for browsing and selection, with each saved selection enabled. */
  models: { id: string; enabled: boolean }[]
}

/** One group provider's full enabled-model list, as a connection-modal save commits it. */
export interface VvcodeModelSelection {
  /** The legacy `vvcode` route or one `vvcode-group-…` route. */
  provider: string
  /** The complete enabled model ID list for that group; an empty list clears its selection. */
  models: string[]
}

/** Display amounts use the site's configured currency or quota units, never a client-side assumed exchange rate. */
export interface VvcodeUsage {
  unit: { kind: 'currency' | 'tokens'; symbol: string }
  balance: { state: 'ready'; remaining: number } | { state: 'unavailable' }
  subscriptions: { state: 'ready'; items: VvcodeUsageItem[] } | { state: 'unavailable' } | { state: 'reauthorize' }
}

/** One currently active subscription; null quota limits mean unlimited, and dates are epoch milliseconds. */
export interface VvcodeUsageItem {
  id: number
  total: number | null
  used: number
  remaining: number | null
  expiresAt: number
  resetAt: number | null
}

/** An application-authorized VVCode group; the name, not its description, identifies the group. */
export interface VvcodeGroup {
  name: string
  desc: string
  ratio: number | 'auto'
}

/**
 * One pending OAuth interaction addressed by its prompt ID.
 */
export interface LoginPrompt {
  id: string
  kind: 'select' | 'secret' | 'text'
  message: string
  options?: { id: string; label: string }[]
}

/**
 * Credential-free authorization progress returned to the client.
 */
export interface LoginState {
  id: string
  provider: string
  phase: 'pending' | 'connected' | 'cancelled' | 'failed' | 'route-failed'
  url?: string
  code?: string
  prompt?: LoginPrompt
}

/**
 * Selected site account identity and access credential.
 */
export interface NewApiLogin {
  site: string
  userId: string
  accessToken: string
}

/**
 * Enabled account token available for explicit import.
 */
export interface NewApiToken {
  id: number
  name: string
  group: string
}

/**
 * Remaining subscription quota for one provider reporting window.
 */
export interface QuotaWindow {
  seconds: number
  remainingPercent: number
  resetAt?: number
  remainingCredits?: number
  totalCredits?: number
}


/** Secret request from the desktop import coordinator to the owner Host. */
export interface NewApiBrowserCommit {
  operationId: string
  planHash: string
  providers: {
    deterministicId: string
    name: string
    baseUrl: string
    api: string
    models: { model: string }[]
    apiKey: string
  }[]
}

/**
 * Durable model-route commit receipt for one desktop operation.
 */
export interface NewApiImportReceipt {
  operationId: string
  planHash: string
  providerIds: string[]
  modelKeys: string[]
}

/**
 * Accepted desktop import routes and their durable receipt.
 */
export interface NewApiBrowserCommitResult {
  receipt: NewApiImportReceipt
  providers: { id: string; name: string; baseUrl: string; api: string; models: { model: string }[] }[]
}

/** Editable connection information. Saved key literals are never returned. */
export interface KeyProfile {
  id: string
  name: string
  baseUrl: string
  api: string
  models: string[]
  hasKey: boolean
  modelOptions: Record<string, ModelOptions>
}

/**
 * Saved API connections with the settings revision used for edits.
 */
export interface KeyDirectory {
  revision: number
  profiles: KeyProfile[]
}

/**
 * Draft API connection fields submitted with their settings revision.
 */
export interface KeyProfileInput {
  id?: string
  revision: number
  name: string
  baseUrl: string
  api: string
  models: string[]
  apiKey?: string
  modelOptions?: Record<string, ModelOptions>
}

/** Editable model capabilities; omitted fields inherit the adapter defaults. */
export interface ModelOptions {
  /** Display name override used by model selectors. */
  name?: string
  /** Maximum combined request and response tokens; omitted inherits adapter capacity. */
  contextWindow?: number
  /** Per-request output token cap when the caller does not specify one. */
  maxTokens?: number
  /** Explicit text/image input capabilities; omitted inherits adapter modalities. */
  input?: readonly ('text' | 'image')[]
}

/** Model overrides and effective display values with the settings revision required for a subsequent save. */
export interface ModelOptionsView {
  revision: number
  options: ModelOptions
  /** Resolved values shown by the editor; unchanged values remain inherited on save. */
  effective: ModelOptions
}
