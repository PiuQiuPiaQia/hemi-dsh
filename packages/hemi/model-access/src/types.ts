/** Wire-safe model access DTOs. */
export interface Subscription {
  id: string
  name: string
  connected: boolean
  quota: boolean
  models: string[]
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
