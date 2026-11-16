/** VVCode management and relay protocol requests over one validated site origin. */
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { asObject } from '../response.ts'
import type { VvcodeUsage } from '../types.ts'
import {
  parseActiveSubscriptions,
  parseBalance,
  parseUsageUnit,
  VVCODE_WALLET_READ_SCOPE,
} from './usage.ts'

import type {
  VvcodeCatalogModel,
  VvcodeClient,
  VvcodeClientOptions,
  VvcodeGroup,
  VvcodeOperation,
  VvcodePricingCandidate,
  VvcodeSelf,
  VvcodeTokenView,
} from './types.ts'

/** Application marker VVCode requires on every management and relay request. */
export const VVCODE_APP_ID = 'hemi-dsh'

/** Wire page size for paginated token reads; `tokenPageLimit` bounds how many pages are scanned. */
const TOKEN_PAGE_SIZE = 100

/** Largest accepted token name; VVCode refuses longer names at creation. */
const TOKEN_NAME_MAX = 50

/** Shape of every VVCode management JSON response. */
interface VvcodeEnvelope {
  success: boolean
  message?: string
  data?: unknown
}

/**
 * Parse and validate the deployment origin once, at client construction.
 * @param value - Caller-supplied origin string.
 * @returns the origin URL without credentials, path, query, or fragment.
 */
export function resolveOrigin(value: string): URL {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch (error: unknown) {
    throw new Error('The VVCode origin must be an absolute URL.', { cause: error })
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('The VVCode origin must be a plain HTTPS origin.')
  }
  return url
}

/**
 * Reject non-positive or non-integer caller budgets.
 * @param value - Caller-supplied budget.
 * @param label - Budget name used in the failure message.
 * @returns the validated value unchanged.
 */
export function positiveInt(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`The VVCode ${label} must be a positive integer.`)
  return value
}

/**
 * Read one JSON response body within the configured byte budget.
 * @param response - HTTP response whose body is read regardless of status.
 * @param maxResponseBytes - Byte budget; larger bodies cancel the stream and fail.
 * @returns the parsed JSON for the caller to validate.
 */
export async function readJsonBody(response: Response, maxResponseBytes: number): Promise<unknown> {
  const body = response.body
  if (body === null) throw new Error('The VVCode response carried no body.')
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        const value: unknown = JSON.parse(text + decoder.decode())
        return value
      }
      bytes += value.byteLength
      if (bytes > maxResponseBytes) throw new Error('The VVCode response is too large.')
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    await reader.cancel().catch((_error: unknown) => { /* The read outcome above decides the result. */ })
    reader.releaseLock()
  }
}

interface VvcodeClientState {
  origin: URL
  accessToken: string
  userId?: number
  timeoutMs: number
  maxResponseBytes: number
  tokenPageLimit: number
  maxModels: number
}

/**
 * Validate every client option eagerly so misconfiguration fails at construction.
 * @param options - Caller-supplied origin, PAT, account, and budgets.
 * @returns the resolved request state shared by all client methods.
 */
function clientState(options: VvcodeClientOptions): VvcodeClientState {
  const userId = options.userId === undefined ? undefined : positiveInt(options.userId, 'account ID')
  if (!/^nap_[A-Za-z0-9_-]{8,512}$/.test(options.accessToken)) {
    throw new Error('The VVCode access token must be a scoped PAT (nap_…).')
  }
  return {
    origin: resolveOrigin(options.origin),
    accessToken: options.accessToken,
    ...(userId === undefined ? {} : { userId }),
    timeoutMs: positiveInt(options.timeoutMs, 'request timeout'),
    maxResponseBytes: positiveInt(options.maxResponseBytes, 'response byte budget'),
    tokenPageLimit: positiveInt(options.tokenPageLimit, 'token page limit'),
    maxModels: positiveInt(options.maxModels, 'model limit'),
  }
}

/**
 * Compose the caller signal with the configured per-request deadline.
 * @param state - Validated client state carrying the deadline.
 * @param signal - Caller cancellation for this request, when supplied.
 * @returns the composed request signal.
 */
function boundedSignal(state: VvcodeClientState, signal: AbortSignal | undefined): AbortSignal {
  return signal === undefined
    ? AbortSignal.timeout(state.timeoutMs)
    : AbortSignal.any([signal, AbortSignal.timeout(state.timeoutMs)])
}

/**
 * Build the stable request failure for an HTTP error, keeping the server message when present.
 * @param response - The failed HTTP response.
 * @param state - Client state carrying the byte budget for the error body.
 * @param operation - Client operation the failure belongs to.
 * @param fallback - Message used when the body carries no readable message.
 * @returns the typed failure carrying the HTTP status.
 */
async function requestFailure(
  response: Response, state: VvcodeClientState, operation: VvcodeOperation, fallback: string,
): Promise<RemoteError<'hemi/vvcode-request-failed'>> {
  let body: unknown
  try {
    body = await readJsonBody(response, state.maxResponseBytes)
  } catch {
    // The error body is best-effort context; the typed status below carries the outcome.
    body = undefined
  }
  const envelope = asObject(body) as Partial<VvcodeEnvelope> | undefined
  const message = envelope?.message
  return new RemoteError('hemi/vvcode-request-failed',
    typeof message === 'string' && message !== '' ? message : fallback,
    { operation, status: response.status })
}

/** One parsed VVCode management envelope with the HTTP status it arrived on. */
interface VvcodeEnvelopeResult {
  status: number
  success: boolean
  message: string | undefined
  data: unknown
}

/**
 * Send one request with the credential the caller chose and parse its envelope. A scoped PAT
 * request answers 401 with the account-expired failure; the anonymous public status read
 * carries no credential and answers 401 as an ordinary refusal.
 * @param state - Validated client state.
 * @param operation - Client operation the request belongs to, reported in every failure.
 * @param path - Absolute request path with its query.
 * @param init - Method and body for the request.
 * @param signal - Caller cancellation, when supplied.
 * @param accessToken - Scoped PAT authorizing the request; undefined sends none.
 * @returns the envelope fields, with `success` distinguishing an explicit answer from a malformed one.
 */
async function requestEnvelope(
  state: VvcodeClientState, operation: VvcodeOperation, path: string, init: RequestInit,
  signal: AbortSignal | undefined, accessToken: string | undefined,
): Promise<VvcodeEnvelopeResult> {
  const requestSignal = boundedSignal(state, signal)
  let response: Response
  try {
    requestSignal.throwIfAborted()
    response = await fetch(new URL(path, state.origin), {
      ...init,
      cache: 'no-store',
      redirect: 'error',
      signal: requestSignal,
      headers: {
        Accept: 'application/json',
        ...(accessToken === undefined ? {} : { Authorization: `Bearer ${accessToken}` }),
        'X-AI-App': VVCODE_APP_ID,
        ...Object.fromEntries(new Headers(init.headers)),
      },
    })
  } catch (error: unknown) {
    if (signal?.aborted) throw signal.reason
    throw new RemoteError('hemi/vvcode-request-failed', 'Could not reach the VVCode site.',
      { operation }, { cause: error })
  }
  if (accessToken !== undefined && response.status === 401) {
    void response.body?.cancel()
    throw new RemoteError('hemi/vvcode-management-auth-expired', 'The VVCode sign-in is no longer valid. Sign in again.', {})
  }
  if (!response.ok) throw await requestFailure(response, state, operation, 'VVCode refused the request.')
  let body: unknown
  try {
    body = await readJsonBody(response, state.maxResponseBytes)
  } catch (error: unknown) {
    if (signal?.aborted) throw signal.reason
    throw new RemoteError('hemi/vvcode-request-failed', 'The VVCode response was unreadable.',
      { operation }, { cause: error })
  }
  const envelope = asObject(body) as Partial<VvcodeEnvelope> | undefined
  if (envelope?.success !== true && envelope?.success !== false) {
    throw new RemoteError('hemi/vvcode-request-failed', 'VVCode returned an invalid response.',
      { operation, status: response.status })
  }
  const message = envelope.message
  return {
    status: response.status,
    success: envelope.success,
    message: typeof message === 'string' && message !== '' ? message : undefined,
    data: envelope.data,
  }
}

/**
 * Send one management request with the scoped PAT, apply the envelope contract, and return `data`.
 * @param state - Validated client state.
 * @param operation - Client operation the request belongs to, reported in every failure.
 * @param path - Absolute request path with its query.
 * @param init - Method and body for the request.
 * @param signal - Caller cancellation, when supplied.
 * @returns the envelope `data` field for the caller to validate.
 */
async function manageRequest(
  state: VvcodeClientState, operation: VvcodeOperation, path: string, init: RequestInit,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const envelope = await requestEnvelope(state, operation, path, init, signal, state.accessToken)
  if (!envelope.success) {
    throw new RemoteError('hemi/vvcode-request-failed',
      envelope.message ?? 'VVCode refused the request.', { operation, status: envelope.status })
  }
  return envelope.data
}

/**
 * Validate one paginated token record into a view without the stored key.
 * @param value - One `items` entry from a token list or detail response.
 * @param operation - Client operation the record belongs to, reported on invalid data.
 * @returns the normalized token view.
 */
function tokenView(value: unknown, operation: VvcodeOperation): VvcodeTokenView {
  const item = asObject(value)
  const expiredTime = item?.expired_time
  const valid = item !== undefined && typeof item.id === 'number' && Number.isSafeInteger(item.id) && item.id > 0
    && typeof item.user_id === 'number' && Number.isSafeInteger(item.user_id) && item.user_id > 0
    && typeof item.name === 'string' && item.name !== ''
    && typeof item.status === 'number' && Number.isSafeInteger(item.status)
    && (expiredTime === undefined || (typeof expiredTime === 'number' && Number.isSafeInteger(expiredTime)))
  if (!valid) {
    throw new RemoteError('hemi/vvcode-request-failed', 'VVCode returned an invalid token record.',
      { operation, status: 200 })
  }
  const record = item as { id: number; user_id: number; name: string; status: number; expired_time?: number; group?: unknown }
  return {
    id: record.id,
    userId: record.user_id,
    name: record.name,
    group: typeof record.group === 'string' ? record.group : '',
    enabled: record.status === 1,
    ...(record.expired_time === undefined || record.expired_time === -1 ? {} : { expiresAt: record.expired_time * 1000 }),
  }
}

/**
 * Read the `items` array of one paginated VVCode response.
 * @param data - Envelope `data` of a list or search request.
 * @param operation - Client operation the page belongs to, reported on invalid data.
 * @returns the page items, validated as an array.
 */
function pageItems(data: unknown, operation: VvcodeOperation): unknown[] {
  const items = asObject(data)?.items
  if (!Array.isArray(items)) {
    throw new RemoteError('hemi/vvcode-request-failed', 'VVCode returned an invalid page.', { operation, status: 200 })
  }
  return items
}

async function listTokens(state: VvcodeClientState, signal: AbortSignal | undefined): Promise<VvcodeTokenView[]> {
  const tokens: VvcodeTokenView[] = []
  for (let page = 1; page <= state.tokenPageLimit; page += 1) {
    const data = await manageRequest(
      state, 'list-tokens', `/api/token/?p=${page}&page_size=${TOKEN_PAGE_SIZE}`, { method: 'GET' }, signal)
    const items = pageItems(data, 'list-tokens')
    for (const item of items) tokens.push(tokenView(item, 'list-tokens'))
    if (items.length < TOKEN_PAGE_SIZE) break
    const total = asObject(data)?.total
    if (typeof total === 'number' && Number.isSafeInteger(total) && page * TOKEN_PAGE_SIZE >= total) break
  }
  return tokens
}

async function findToken(
  state: VvcodeClientState, uniqueName: string, signal: AbortSignal | undefined,
): Promise<VvcodeTokenView | undefined> {
  const path = `/api/token/search?keyword=${encodeURIComponent(uniqueName)}&p=1&page_size=${TOKEN_PAGE_SIZE}`
  const matches = pageItems(await manageRequest(state, 'find-token', path, { method: 'GET' }, signal), 'find-token')
    .map(item => tokenView(item, 'find-token'))
    .filter(view => view.name === uniqueName)
  if (matches.length > 1) {
    throw new RemoteError('hemi/vvcode-request-failed', 'VVCode returned duplicate tokens for the unique name.',
      { operation: 'find-token', status: 200 })
  }
  return matches[0]
}

/**
 * Verify a created token matches the request before reporting it.
 * @param state - Validated client state carrying the expected account, when configured.
 * @param view - The token record VVCode returned for the new ID or unique name.
 * @param uniqueName - Name the creation requested.
 * @param group - Group the creation requested.
 * @returns the verified view unchanged.
 */
function verifyCreated(
  state: VvcodeClientState, view: VvcodeTokenView, uniqueName: string, group: string,
): VvcodeTokenView {
  const matches = view.name === uniqueName && view.group === group
    && (state.userId === undefined || view.userId === state.userId)
  if (!matches) {
    throw new RemoteError('hemi/vvcode-request-failed', 'The created VVCode token did not match the request.',
      { operation: 'create-token', status: 200 })
  }
  return view
}

async function createToken(
  state: VvcodeClientState, uniqueName: string, group: string, signal: AbortSignal | undefined,
  onCreatedId: ((id: number) => Promise<void>) | undefined,
): Promise<VvcodeTokenView> {
  if (uniqueName === '' || uniqueName.length > TOKEN_NAME_MAX || /[\u0000-\u001f\u007f]/.test(uniqueName)) {
    throw new Error('The VVCode token name must be 1–50 printable characters.')
  }
  if (group === '' || group.length > 128) throw new Error('The VVCode group must be 1–128 characters.')
  let envelope: VvcodeEnvelopeResult
  try {
    envelope = await requestEnvelope(state, 'create-token', '/api/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: uniqueName, group, expired_time: -1, remain_quota: 0, unlimited_quota: true }),
    }, signal, state.accessToken)
  } catch (error: unknown) {
    if (signal?.aborted) throw signal.reason
    // A 4xx answer from the creation request itself is a definite refusal; verification requests
    // and 5xx/transport/unreadable losses never reach this classification.
    const remote = remoteErrorOf(error)
    if (remote === undefined) {
      throw new RemoteError('hemi/vvcode-token-unknown',
        'The VVCode token creation result is unknown. Search the exact name before retrying.',
        { uniqueName, group }, { cause: error })
    }
    if (remote.code === 'hemi/vvcode-management-auth-expired') {
      throw new RemoteError('hemi/vvcode-token-refused', remote.message, { status: 401 })
    }
    if (remote.code !== 'hemi/vvcode-request-failed') throw error
    const { status } = remote.details
    if (status !== undefined && status >= 400 && status < 500) {
      throw new RemoteError('hemi/vvcode-token-refused', remote.message, { status })
    }
    throw new RemoteError('hemi/vvcode-token-unknown',
      'The VVCode token creation result is unknown. Search the exact name before retrying.',
      { uniqueName, group }, { cause: error })
  }
  // Only an explicit `success: false` is a refusal; manageEnvelope guarantees a boolean here.
  if (!envelope.success) {
    throw new RemoteError('hemi/vvcode-token-refused',
      envelope.message ?? 'VVCode refused the token creation.', { status: envelope.status })
  }
  const id = asObject(envelope.data)?.id
  if (id !== undefined) {
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) {
      throw new RemoteError('hemi/vvcode-request-failed', 'VVCode returned an invalid token ID.',
        { operation: 'create-token', status: envelope.status })
    }
    if (onCreatedId !== undefined) await onCreatedId(id)
    const detail = tokenView(
      await manageRequest(state, 'create-token', `/api/token/${id}`, { method: 'GET' }, signal), 'create-token')
    return verifyCreated(state, detail, uniqueName, group)
  }
  const found = await findToken(state, uniqueName, signal)
  if (found === undefined) {
    throw new RemoteError('hemi/vvcode-request-failed',
      'VVCode acknowledged the creation without a verifiable token record.',
      { operation: 'create-token', status: envelope.status })
  }
  if (onCreatedId !== undefined) await onCreatedId(found.id)
  return verifyCreated(state, found, uniqueName, group)
}

async function tokenKey(state: VvcodeClientState, id: number, signal: AbortSignal | undefined): Promise<string> {
  const data = asObject(await manageRequest(state, 'token-key', `/api/token/${id}/key`, { method: 'POST' }, signal))
  const key = data?.key
  if (typeof key !== 'string' || key.startsWith('nap_') || !/^[A-Za-z0-9_-]{8,512}$/.test(key)) {
    throw new RemoteError('hemi/vvcode-request-failed', 'VVCode did not return a usable API key.',
      { operation: 'token-key', status: 200 })
  }
  return key.startsWith('sk-') ? key : `sk-${key}`
}

async function deleteToken(state: VvcodeClientState, id: number, signal: AbortSignal | undefined): Promise<void> {
  await manageRequest(state, 'delete-token', `/api/token/${id}`, { method: 'DELETE' }, signal)
}

async function getToken(state: VvcodeClientState, id: number, signal: AbortSignal | undefined): Promise<VvcodeTokenView> {
  return tokenView(await manageRequest(state, 'token-detail', `/api/token/${id}`, { method: 'GET' }, signal), 'token-detail')
}

async function self(state: VvcodeClientState, signal: AbortSignal | undefined): Promise<VvcodeSelf> {
  const data = asObject(await manageRequest(state, 'self', '/api/user/self', { method: 'GET' }, signal))
  const valid = data !== undefined && typeof data.id === 'number' && Number.isSafeInteger(data.id) && data.id > 0
    && typeof data.username === 'string' && data.username !== ''
    && (data.display_name === undefined || typeof data.display_name === 'string')
  if (!valid) {
    throw new RemoteError('hemi/vvcode-request-failed', 'VVCode returned an invalid account identity.',
      { operation: 'self', status: 200 })
  }
  const identity = data as { id: number; username: string; display_name?: string }
  return { id: identity.id, username: identity.username, displayName: identity.display_name ?? '' }
}

async function listGroups(state: VvcodeClientState, signal: AbortSignal | undefined): Promise<VvcodeGroup[]> {
  const data = asObject(
    await manageRequest(state, 'list-groups', `/api/desktop/groups?app=${VVCODE_APP_ID}`, { method: 'GET' }, signal))
  if (data === undefined) {
    throw new RemoteError('hemi/vvcode-request-failed', 'VVCode returned an invalid group list.',
      { operation: 'list-groups', status: 200 })
  }
  const groups: VvcodeGroup[] = []
  for (const [name, value] of Object.entries(data)) {
    const entry = asObject(value)
    if (entry === undefined || typeof entry.desc !== 'string') {
      throw new RemoteError('hemi/vvcode-request-failed', 'VVCode returned an invalid group list.',
        { operation: 'list-groups', status: 200 })
    }
    const ratio = entry.ratio
    if (ratio === 'auto') {
      groups.push({ name, ratio, desc: entry.desc })
      continue
    }
    if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0) {
      throw new RemoteError('hemi/vvcode-request-failed', 'VVCode returned an invalid group list.',
        { operation: 'list-groups', status: 200 })
    }
    groups.push({ name, ratio, desc: entry.desc })
  }
  return groups.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * Read the server-enabled model IDs of one authorized group for the signed-in account.
 * The request carries only the scoped PAT, never a model key, and is bounded by `maxModels`.
 * @param state - Validated client state.
 * @param group - Exact application-authorized group name.
 * @param signal - Caller cancellation, when supplied.
 * @returns the enabled model IDs in server order.
 */
async function groupModels(state: VvcodeClientState, group: string, signal: AbortSignal | undefined): Promise<string[]> {
  if (group === '' || group.length > 128) throw new Error('The VVCode group must be 1–128 characters.')
  const data = await manageRequest(
    state, 'group-models', `/api/user/models?group=${encodeURIComponent(group)}`, { method: 'GET' }, signal)
  if (!Array.isArray(data)) {
    throw new RemoteError('hemi/vvcode-request-failed', 'VVCode returned an invalid model list.',
      { operation: 'group-models', status: 200 })
  }
  const ids: string[] = []
  for (const item of data) {
    if (typeof item !== 'string' || item === '') {
      throw new RemoteError('hemi/vvcode-request-failed', 'VVCode returned an invalid model list.',
        { operation: 'group-models', status: 200 })
    }
    ids.push(item)
  }
  if (ids.length > state.maxModels) {
    throw new RemoteError('hemi/vvcode-request-failed', 'The VVCode model list exceeded the configured maximum.',
      { operation: 'group-models', status: 200 })
  }
  return ids
}

/**
 * Read the relay model catalog with the endpoint metadata each row declares.
 * @param state - Validated client state.
 * @param apiKey - Model API key for the relay request; never the scoped PAT.
 * @param signal - Caller cancellation, when supplied.
 * @returns the catalog rows, bounded by `maxModels`.
 */
async function modelCatalog(
  state: VvcodeClientState, apiKey: string, signal: AbortSignal | undefined,
): Promise<VvcodeCatalogModel[]> {
  // Relay requests carry only a model API key; the scoped PAT never reaches `/v1`.
  if (!/^sk-[A-Za-z0-9_-]{8,512}$/.test(apiKey)) throw new Error('The VVCode model API key must be a sk- key.')
  const requestSignal = boundedSignal(state, signal)
  let response: Response
  try {
    requestSignal.throwIfAborted()
    response = await fetch(new URL('/v1/models', state.origin), {
      method: 'GET',
      cache: 'no-store',
      redirect: 'error',
      signal: requestSignal,
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}`, 'X-AI-App': VVCODE_APP_ID },
    })
  } catch (error: unknown) {
    if (signal?.aborted) throw signal.reason
    throw new RemoteError('hemi/vvcode-request-failed', 'Could not reach the VVCode site.',
      { operation: 'list-models' }, { cause: error })
  }
  if (response.status === 401) {
    void response.body?.cancel()
    throw new RemoteError('hemi/vvcode-model-auth-expired', 'The VVCode model API key was rejected. Create a new model token.', {})
  }
  if (!response.ok) throw await requestFailure(response, state, 'list-models', 'VVCode refused the model list.')
  let body: unknown
  try {
    body = await readJsonBody(response, state.maxResponseBytes)
  } catch (error: unknown) {
    if (signal?.aborted) throw signal.reason
    throw new RemoteError('hemi/vvcode-request-failed', 'The VVCode response was unreadable.',
      { operation: 'list-models' }, { cause: error })
  }
  const list = asObject(body)
  const data = list?.data
  if (list?.object !== 'list' || !Array.isArray(data)) {
    throw new RemoteError('hemi/vvcode-request-failed', 'VVCode returned an invalid model list.',
      { operation: 'list-models', status: response.status })
  }
  const rows: VvcodeCatalogModel[] = []
  for (const value of data) {
    const entry = asObject(value)
    const id = entry?.id
    const endpoints = entry?.supported_endpoint_types
    if (typeof id !== 'string' || id === '' || (endpoints !== undefined && !Array.isArray(endpoints))) {
      throw new RemoteError('hemi/vvcode-request-failed', 'VVCode returned an invalid model entry.',
        { operation: 'list-models', status: response.status })
    }
    const supportedEndpointTypes: string[] = []
    if (endpoints !== undefined) {
      for (const item of endpoints) {
        if (typeof item !== 'string' || item === '') {
          throw new RemoteError('hemi/vvcode-request-failed', 'VVCode returned an invalid model entry.',
            { operation: 'list-models', status: response.status })
        }
        supportedEndpointTypes.push(item)
      }
    }
    rows.push({ id, supportedEndpointTypes })
  }
  if (rows.length > state.maxModels) {
    throw new RemoteError('hemi/vvcode-request-failed', 'The VVCode model list exceeded the configured maximum.',
      { operation: 'list-models', status: response.status })
  }
  return rows
}

async function listModels(
  state: VvcodeClientState, apiKey: string, signal: AbortSignal | undefined,
): Promise<string[]> {
  return (await modelCatalog(state, apiKey, signal)).map(row => row.id)
}

async function modelCandidates(
  state: VvcodeClientState, group: string, signal: AbortSignal | undefined,
): Promise<VvcodePricingCandidate[]> {
  if (group === '' || group.length > 128) throw new Error('The VVCode group must be 1–128 characters.')
  const data = await manageRequest(state, 'model-candidates', '/api/pricing', { method: 'GET' }, signal)
  if (!Array.isArray(data)) {
    throw new RemoteError('hemi/vvcode-request-failed', 'VVCode returned an invalid pricing list.',
      { operation: 'model-candidates', status: 200 })
  }
  const candidates: VvcodePricingCandidate[] = []
  for (const value of data) {
    const entry = asObject(value)
    const enableGroups = entry?.enable_groups
    const modelName = entry?.model_name
    const endpoints = entry?.supported_endpoint_types
    // An entry that cannot express group membership is skipped; a matched entry must be complete.
    if (entry === undefined || !Array.isArray(enableGroups)) continue
    if (typeof modelName !== 'string' || modelName === ''
      || (endpoints !== undefined && !Array.isArray(endpoints))) {
      throw new RemoteError('hemi/vvcode-request-failed', 'VVCode returned an invalid pricing entry.',
        { operation: 'model-candidates', status: 200 })
    }
    const groups: string[] = []
    let listed = false
    for (const item of enableGroups) {
      if (typeof item !== 'string') {
        throw new RemoteError('hemi/vvcode-request-failed', 'VVCode returned an invalid pricing entry.',
          { operation: 'model-candidates', status: 200 })
      }
      if (item === group) listed = true
      groups.push(item)
    }
    if (!listed) continue
    const supportedEndpointTypes: string[] = []
    if (endpoints !== undefined) {
      for (const item of endpoints) {
        if (typeof item !== 'string' || item === '') {
          throw new RemoteError('hemi/vvcode-request-failed', 'VVCode returned an invalid pricing entry.',
            { operation: 'model-candidates', status: 200 })
        }
        supportedEndpointTypes.push(item)
      }
    }
    candidates.push({ modelName, enableGroups: groups, supportedEndpointTypes })
  }
  if (candidates.length > state.maxModels) {
    throw new RemoteError('hemi/vvcode-request-failed', 'The VVCode pricing list exceeded the configured maximum.',
      { operation: 'model-candidates', status: 200 })
  }
  return candidates.sort((a, b) => (a.modelName < b.modelName ? -1 : a.modelName > b.modelName ? 1 : 0))
}

/**
 * Report whether a caught failure is a refused or unusable usage answer. Caller cancellation
 * and the account-expired failure must propagate instead of becoming a partial state.
 * @param error - The caught failure.
 * @returns whether the usage read may continue with a partial result.
 */
function recoverableUsageFailure(error: unknown): boolean {
  return remoteErrorOf(error)?.code === 'hemi/vvcode-request-failed'
}

/**
 * Read the wallet balance and active subscriptions in the site's configured display unit.
 * The public status read decides the unit and carries no credential; its failure fails the
 * whole read. The balance and subscription reads run with the scoped PAT and fail
 * independently: a refused or unusable answer becomes that part's `unavailable` state, while
 * a 401 throws the account-expired failure. A grant without `wallet:read`, or a server-side
 * refusal of the subscription read, reports `reauthorize` without marking the account expired.
 * @param state - Validated client state.
 * @param scopes - Scopes of the credential in use; decides whether subscriptions are queried.
 * @param signal - Caller cancellation, when supplied.
 */
async function usage(
  state: VvcodeClientState, scopes: readonly string[], signal: AbortSignal | undefined,
): Promise<VvcodeUsage> {
  const envelope = await requestEnvelope(state, 'usage-status', '/api/status', { method: 'GET' }, signal, undefined)
  if (!envelope.success) {
    throw new RemoteError('hemi/vvcode-request-failed',
      envelope.message ?? 'VVCode refused the request.', { operation: 'usage-status', status: envelope.status })
  }
  const unit = parseUsageUnit(envelope.data)
  let balance: VvcodeUsage['balance']
  try {
    balance = {
      state: 'ready',
      remaining: parseBalance(
        await manageRequest(state, 'usage-balance', '/api/user/self', { method: 'GET' }, signal), unit.amount),
    }
  } catch (error: unknown) {
    if (!recoverableUsageFailure(error)) throw error
    balance = { state: 'unavailable' }
  }
  if (!scopes.includes(VVCODE_WALLET_READ_SCOPE)) {
    return { unit: unit.unit, balance, subscriptions: { state: 'reauthorize' } }
  }
  try {
    const items = parseActiveSubscriptions(
      await manageRequest(state, 'usage-subscriptions', '/api/subscription/self', { method: 'GET' }, signal),
      Date.now(), unit.amount, state.userId)
    return { unit: unit.unit, balance, subscriptions: { state: 'ready', items } }
  } catch (error: unknown) {
    if (!recoverableUsageFailure(error)) throw error
    const refused = remoteErrorOf(error)
    return {
      unit: unit.unit,
      balance,
      subscriptions: refused?.code === 'hemi/vvcode-request-failed' && refused.details.status === 403
        ? { state: 'reauthorize' }
        : { state: 'unavailable' },
    }
  }
}

/**
 * Create a typed VVCode protocol client; every option is validated before the first request.
 * @param options - Origin, scoped PAT, optional expected account, and required request budgets.
 * @returns the client whose management methods never reach `/v1` and whose `listModels` never sends the PAT.
 */
export function createVvcodeClient(options: VvcodeClientOptions): VvcodeClient {
  const state = clientState(options)
  return {
    listGroups: (signal?: AbortSignal) => listGroups(state, signal),
    groupModels: (group: string, signal?: AbortSignal) => groupModels(state, group, signal),
    self: (signal?: AbortSignal) => self(state, signal),
    usage: (scopes: readonly string[], signal?: AbortSignal) => usage(state, scopes, signal),
    listTokens: (signal?: AbortSignal) => listTokens(state, signal),
    findToken: (uniqueName: string, signal?: AbortSignal) => findToken(state, uniqueName, signal),
    getToken: (id: number, signal?: AbortSignal) => getToken(state, id, signal),
    createToken: (
      uniqueName: string, group: string, signal?: AbortSignal,
      onCreatedId?: (id: number) => Promise<void>,
    ) => createToken(state, uniqueName, group, signal, onCreatedId),
    tokenKey: (id: number, signal?: AbortSignal) => tokenKey(state, id, signal),
    deleteToken: (id: number, signal?: AbortSignal) => deleteToken(state, id, signal),
    listModels: (apiKey: string, signal?: AbortSignal) => listModels(state, apiKey, signal),
    modelCatalog: (apiKey: string, signal?: AbortSignal) => modelCatalog(state, apiKey, signal),
    modelCandidates: (group: string, signal?: AbortSignal) => modelCandidates(state, group, signal),
  }
}
