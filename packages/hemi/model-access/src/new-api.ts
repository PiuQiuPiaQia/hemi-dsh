/** New API management requests for the site the owner explicitly selected. */
import { createHash, randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { readJson, asObject } from './response.ts'

import type { NewApiLogin, NewApiToken } from './types.ts'

const MODEL_SETTINGS = 'llm-pi-ai'

function sameUserId(value: unknown, userId: string): boolean {
  return (typeof value === 'number' || typeof value === 'string') && String(value) === userId
}

function session(login: NewApiLogin) {
  const url = new URL(login.site.trim())
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('New API requires an HTTPS site origin.')
  }
  if (!/^[1-9]\d{0,15}$/.test(login.userId) || !/^\S{1,1024}$/.test(login.accessToken)) {
    throw new Error('Invalid account ID or system access token.')
  }
  return { origin: url.origin, headers: {
    Authorization: `Bearer ${login.accessToken}`, 'New-Api-User': login.userId, Accept: 'application/json',
  } }
}

async function request(
  account: ReturnType<typeof session>, path: string, signal: AbortSignal, method: 'GET' | 'POST' = 'GET',
): Promise<unknown> {
  const response = await fetch(new URL(path, account.origin), {
    headers: account.headers, redirect: 'error', method, signal,
  })
  const result = asObject(await readJson(response))
  if (result?.success !== true) throw new Error('New API refused the request.')
  return result.data
}

/**
 * Confirm the identity server-side, then return display-only token data.
 * @param login - Selected New API site identity and account credential.
 * @param signal - Caller cancellation for this asynchronous operation.
 * @returns enabled account tokens eligible for explicit import.
 */
export async function listTokens(login: NewApiLogin, signal: AbortSignal): Promise<NewApiToken[]> {
  const account = session(login)
  const identity = asObject(await request(account, '/api/user/self', signal))
  if (!sameUserId(identity?.id, login.userId)) throw new Error('New API account mismatch.')
  const tokens: NewApiToken[] = []
  for (let page = 1; page <= 5; page += 1) {
    const data = await request(account, `/api/token/?p=${page}&page_size=100&size=100`, signal)
    const envelope = asObject(data)
    const items = Array.isArray(data) ? data : envelope?.items ?? envelope?.records
    if (!Array.isArray(items)) throw new Error('Invalid New API token list.')
    for (const value of items.slice(0, 100)) {
      const item = asObject(value)
      if (typeof item?.id !== 'number' || !Number.isSafeInteger(item.id) || item.id < 1
        || typeof item.name !== 'string' || (item.user_id !== undefined && !sameUserId(item.user_id, login.userId))
        || (item.status !== undefined && item.status !== 1)) continue
      if (!tokens.some(token => token.id === item.id)) tokens.push({
        id: item.id, name: item.name.slice(0, 128), group: typeof item.group === 'string' ? item.group.slice(0, 128) : '',
      })
    }
    if (items.length < 100 || (typeof envelope?.total === 'number' && page * 100 >= envelope.total)) break
  }
  return tokens
}

/**
 * Import only the requested token and the model IDs advertised to that token.
 * @param ctx - Owning Host or Client context providing the required services.
 * @param login - Selected New API site identity and account credential.
 * @param id - Exact operation, token or connection ID selected by the caller.
 * @param signal - Caller cancellation for this asynchronous operation.
 * @returns the number of model routes imported.
 */
export async function importToken(ctx: Context, login: NewApiLogin, id: number, signal: AbortSignal): Promise<number> {
  const account = session(login)
  const token = (await listTokens(login, signal)).find(candidate => candidate.id === id)
  if (token === undefined) throw new Error('Choose an active API token from this account.')
  const tokenData = asObject(await request(account, `/api/token/${id}/key`, signal, 'POST'))
  const raw = tokenData?.key
  if (typeof raw !== 'string' || !/^[\w-]{8,512}$/.test(raw)) throw new Error('New API did not return an API key.')
  const apiKey = raw.startsWith('sk-') ? raw : `sk-${raw}`
  const baseURL = `${account.origin}/v1`
  const advertised = await ctx.llm.discoverModels(MODEL_SETTINGS, { baseURL, api: 'openai-completions', apiKey }, signal)
  const models = advertised.slice(0, 500).map(model => ({ id: model.id }))
  if (models.length === 0) throw new Error('The API token did not advertise any models.')
  const hash = createHash('sha256').update(JSON.stringify([account.origin, login.userId, id])).digest('hex').slice(0, 20)
  const prefix = `new-api-${hash}-`
  const provider = `${prefix}${randomBytes(8).toString('hex')}`
  const current = ctx.settings.describe().find(entry => entry.ns === MODEL_SETTINGS)
  const routes = Object.keys(asObject(asObject(current?.value)?.providers) ?? {})
  if (current === undefined || routes.some(route => route.startsWith(prefix))) {
    throw new Error('The model settings are unavailable or this token is already imported.')
  }
  // Match the stock model editor's managed-reference convention for later deletion.
  const ref = credentialRef(`${provider.toUpperCase().replaceAll('-', '_')}_API_KEY`)
  signal.throwIfAborted()
  await ctx.credentials.set(ref, apiKey)
  try {
    await ctx.settings.mutate(MODEL_SETTINGS, [{
      op: 'set', path: ['providers', provider], value: {
        displayName: `${new URL(account.origin).host} · ${token.name}`,
        baseURL, api: 'openai-completions', apiKeyEnv: ref, models,
      },
    }], current.revision)
  } catch (error: unknown) {
    const latest = ctx.settings.describe().find(entry => entry.ns === MODEL_SETTINGS)
    const saved = asObject(asObject(asObject(latest?.value)?.providers)?.[provider])
    if (latest !== undefined && saved?.apiKeyEnv !== ref) await ctx.credentials.unset(ref)
    throw error
  }
  return models.length
}
