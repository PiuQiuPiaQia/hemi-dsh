/** Live subscription discovery; installed models supply transport metadata only. */
import type { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { credentialStoreFrom } from '@deepseek-ai/dsh-llm-pi-ai'
import type { OAuthCredential, Provider } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot'
import { bigModelCodingProvider } from '#bigmodel-protocol'
import { asObject, readJson } from './response.ts'

/** Request limits and external client versions used for subscription discovery. */
export interface SubscriptionDiscoveryConfig {
  /** Total time allowed for one catalog refresh, including authentication. */
  timeoutMs: number
  /** Maximum number of model entries accepted from a provider. */
  maxModels: number
  /** Codex client version sent to its model catalog endpoint. */
  codexClientVersion: string
  /** ZCode version sent when downloading the current Coding Plan catalog. */
  zcodeAppVersion: string
}

function failure(cause?: unknown): RemoteError<'hemi/subscription-discovery-failed'> {
  return new RemoteError('hemi/subscription-discovery-failed',
    'Could not read the live subscription catalog. Retry or sign in again.', {}, { cause })
}

async function request(url: URL, signal: AbortSignal, headers?: HeadersInit): Promise<unknown> {
  return readJson(await fetch(url, { method: 'GET', cache: 'no-store', redirect: 'error', signal,
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache', ...Object.fromEntries(new Headers(headers)) } }))
}

function rows(body: unknown, key: string): Record<string, unknown>[] {
  const list = asObject(body)?.[key]
  if (!Array.isArray(list)) throw failure()
  return list.map((item) => {
    const row = asObject(item)
    if (row === undefined) throw failure()
    return row
  })
}

async function codingPlanModels(config: SubscriptionDiscoveryConfig, signal: AbortSignal): Promise<string[]> {
  const platform = process.platform === 'win32' ? 'windows' : process.platform
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch
  const url = new URL('https://zcode.z.ai/api/v1/client/configs')
  url.searchParams.set('app_version', config.zcodeAppVersion)
  url.searchParams.set('platform', `${platform}-${arch}`)
  const control = asObject(await request(url, signal))
  if (control?.code !== 0) throw failure()
  const address = asObject(asObject(control.data)?.configs)?.builtin_provider_config_json
  if (typeof address !== 'string') throw failure()
  const catalogUrl = new URL(address)
  // The public catalog never receives the account token, including on redirects.
  if (catalogUrl.origin !== 'https://cdn-zcode.z.ai' || catalogUrl.username || catalogUrl.password) throw failure()
  const catalog = asObject(await request(catalogUrl, signal))
  const rules = asObject(asObject(catalog?.config)?.providerConfigRules)?.providerRules
  if (!Array.isArray(rules)) throw failure()
  const ids: string[] = []
  let found = false
  for (const raw of rules) {
    const rule = asObject(asObject(raw)?.config)
    const access = asObject(rule?.access)
    if (access?.accountType !== 'bigmodel' || !['individual-coding-plan', 'team-coding-plan'].includes(String(access.mode))) continue
    found = true
    if (!Array.isArray(rule?.builtinModelIds) || rule.builtinModelIds.some(id => typeof id !== 'string' || id.trim() === '')) throw failure()
    for (const id of rule.builtinModelIds) if (typeof id === 'string') ids.push(id)
  }
  if (!found) throw failure()
  return ids
}

async function accountModels(provider: Provider, credential: OAuthCredential, config: SubscriptionDiscoveryConfig,
  signal: AbortSignal): Promise<string[]> {
  if (provider.id === 'openai-codex') {
    const url = new URL('https://chatgpt.com/backend-api/codex/models')
    url.searchParams.set('client_version', config.codexClientVersion)
    const headers: Record<string, string> = { Authorization: `Bearer ${credential.access}` }
    if (typeof credential.accountId === 'string') headers['ChatGPT-Account-Id'] = credential.accountId
    return rows(await request(url, signal, headers), 'models')
      .filter(model => model.visibility === undefined || model.visibility === 'list')
      .map((model) => { if (typeof model.slug !== 'string') throw failure(); return model.slug })
  }
  if (provider.id === 'bigmodel') return codingPlanModels(config, signal)
  const oauth = provider.auth.oauth
  if (oauth === undefined) throw failure()
  const auth = await oauth.toAuth(credential)
  if (provider.id === 'github-copilot') {
    const url = new URL(`${auth.baseUrl ?? provider.baseUrl}/models`)
    if (url.protocol !== 'https:') throw failure()
    const data = rows(await request(url, signal, {
      Authorization: `Bearer ${auth.apiKey ?? credential.access}`, 'Editor-Version': 'vscode/1.107.0',
      'Editor-Plugin-Version': 'copilot-chat/0.35.0', 'Copilot-Integration-Id': 'vscode-chat',
      'X-GitHub-Api-Version': '2026-06-01',
    }), 'data').filter(model => asObject(asObject(model.capabilities)?.supports)?.tool_calls !== false)
    const picker = data.filter(model => model.model_picker_enabled === true && asObject(model.policy)?.state !== 'disabled')
    const selectable = picker.length > 0 || url.origin !== 'https://api.individual.githubcopilot.com'
      ? picker : data.filter(model => asObject(model.policy)?.state === 'enabled')
    return selectable.map((model) => { if (typeof model.id !== 'string') throw failure(); return model.id })
  }
  const ids: string[] = []
  const url = new URL('https://api.anthropic.com/v1/models?limit=1000')
  const cursors = new Set<string>()
  for (;;) {
    const body = asObject(await request(url, signal, { Authorization: `Bearer ${auth.apiKey ?? credential.access}`,
      'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20' }))
    for (const model of rows(body, 'data')) {
      if (typeof model.id !== 'string') throw failure()
      ids.push(model.id)
    }
    if (body?.has_more !== true) return ids
    if (typeof body.last_id !== 'string' || cursors.has(body.last_id) || ids.length >= config.maxModels) throw failure()
    cursors.add(body.last_id)
    url.searchParams.set('after_id', body.last_id)
  }
}

/**
 * Fetch the current subscription catalog without falling back to installed IDs.
 * @param ctx - Host context providing encrypted credentials.
 * @param id - Subscription provider ID.
 * @param config - Discovery budgets and supported external client versions.
 * @param signal - Caller cancellation, shared across authentication and downloads.
 * @returns live advertised IDs; known GLM spellings retain their existing runtime IDs.
 */
export async function subscriptionCatalog(
  ctx: Context, id: string, config: SubscriptionDiscoveryConfig, signal: AbortSignal,
): Promise<string[]> {
  const credentials = credentialStoreFrom(ctx)
  const provider = id === 'bigmodel' ? bigModelCodingProvider(credentials)
    : id === 'openai-codex' ? openaiCodexProvider()
      : id === 'anthropic' ? anthropicProvider()
        : id === 'github-copilot' ? githubCopilotProvider() : undefined
  if (provider?.auth.oauth === undefined) throw failure()
  const oauth = provider.auth.oauth
  try {
    let credential = await credentials.read(id, { signal })
    if (credential?.type !== 'oauth') throw failure()
    if (credential.expires <= Date.now()) credential = await credentials.modify(id, async (current) => {
      if (current?.type !== 'oauth') throw failure()
      return current.expires > Date.now() ? undefined : oauth.refresh(current, signal)
    }, { signal })
    if (credential?.type !== 'oauth') throw failure()
    const captured = credential
    const ids = await accountModels(provider, credential, config, signal)
    signal.throwIfAborted()
    const latest = await credentials.read(id, { signal })
    if (latest?.type !== 'oauth' || latest.access !== captured.access) throw failure()
    if (ids.length > config.maxModels || ids.some(model => model.trim() === '')) throw failure()
    if (id === 'github-copilot') await credentials.modify(id, (current) => {
      if (current?.type !== 'oauth' || current.access !== captured.access) throw failure()
      return Promise.resolve({ ...current, availableModelIds: ids })
    }, { signal })
    const known = new Map(provider.getModels().map(model => [model.id.toLowerCase(), model.id]))
    return [...new Set(ids.map(model => id === 'bigmodel' ? known.get(model.toLowerCase()) ?? model : model))]
  } catch (error) {
    if (signal.aborted) throw signal.reason
    throw failure(error)
  }
}
