import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { credentialStoreFrom } from '@deepseek-ai/dsh-llm-pi-ai'
import { subscriptionCatalog, type SubscriptionDiscoveryConfig } from '../src/subscription-models.ts'

vi.mock('@deepseek-ai/dsh-llm-pi-ai', async original => ({
  ...await original<typeof import('@deepseek-ai/dsh-llm-pi-ai')>(), credentialStoreFrom: vi.fn(),
}))

const config: SubscriptionDiscoveryConfig = {
  timeoutMs: 30000, maxModels: 500, codexClientVersion: '0.164.0', zcodeAppVersion: '3.17.2',
}

function requestUrl(value: Parameters<typeof globalThis.fetch>[0] | undefined): string {
  if (value === undefined) throw new Error('The expected catalog request was not sent.')
  return typeof value === 'string' ? value : value instanceof URL ? value.href : value.url
}
let store: InMemoryCredentialStore
beforeEach(() => {
  store = new InMemoryCredentialStore()
  vi.mocked(credentialStoreFrom).mockReturnValue(store)
})
afterEach(() => { vi.restoreAllMocks() })

async function grant(provider: string, access = 'test-access'): Promise<void> {
  await store.modify(provider, () => Promise.resolve({ type: 'oauth', access, refresh: 'test-refresh',
    expires: Date.now() + 60000, accountId: 'test-account' }))
}

it('fetches Codex on every call and rejects an outage without returning its previous result', async () => {
  await grant('openai-codex')
  const fetch = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json({ models: [{ slug: 'remote-a', visibility: 'list' }, { slug: 'hidden', visibility: 'hide' }] }))
    .mockResolvedValueOnce(Response.json({ models: [{ slug: 'remote-b', visibility: 'list' }] }))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
  const ctx = new Context()
  await expect(subscriptionCatalog(ctx, 'openai-codex', config, new AbortController().signal)).resolves.toEqual(['remote-a'])
  await expect(subscriptionCatalog(ctx, 'openai-codex', config, new AbortController().signal)).resolves.toEqual(['remote-b'])
  await expect(subscriptionCatalog(ctx, 'openai-codex', config, new AbortController().signal))
    .rejects.toMatchObject({ code: 'hemi/subscription-discovery-failed' })
  expect(fetch).toHaveBeenCalledTimes(3)
  for (const [url, init] of fetch.mock.calls) {
    expect(requestUrl(url)).toBe('https://chatgpt.com/backend-api/codex/models?client_version=0.164.0')
    expect(init?.cache).toBe('no-store')
    expect(new Headers(init?.headers).get('chatgpt-account-id')).toBe('test-account')
  }
})

it.each([{ models: [{}] }, { models: 'invalid' }])('refuses malformed live model data: %j', async (body) => {
  await grant('openai-codex')
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(body))
  await expect(subscriptionCatalog(new Context(), 'openai-codex', config, new AbortController().signal))
    .rejects.toMatchObject({ code: 'hemi/subscription-discovery-failed' })
})

it('reads all Claude pages using the current OAuth bearer', async () => {
  await grant('anthropic')
  const fetch = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json({ data: [{ id: 'claude-live-a' }], has_more: true, last_id: 'cursor-a' }))
    .mockResolvedValueOnce(Response.json({ data: [{ id: 'claude-live-b' }], has_more: false }))
  await expect(subscriptionCatalog(new Context(), 'anthropic', config, new AbortController().signal))
    .resolves.toEqual(['claude-live-a', 'claude-live-b'])
  expect(new URL(requestUrl(fetch.mock.calls[1]?.[0])).searchParams.get('after_id')).toBe('cursor-a')
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer test-access')
})

it('refreshes Copilot availability from live policy flags rather than stored available IDs', async () => {
  await grant('github-copilot', 'tid=test;proxy-ep=proxy.individual.githubcopilot.com;')
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: [
    { id: 'live-enabled', model_picker_enabled: true, policy: { state: 'enabled' } },
    { id: 'disabled', model_picker_enabled: true, policy: { state: 'disabled' } },
    { id: 'no-tools', model_picker_enabled: true, capabilities: { supports: { tool_calls: false } } },
  ] }))
  await expect(subscriptionCatalog(new Context(), 'github-copilot', config, new AbortController().signal))
    .resolves.toEqual(['live-enabled'])
  expect(await store.read('github-copilot')).toMatchObject({ availableModelIds: ['live-enabled'] })
})

it('uses the live GLM Coding Plan release and sends no account credential to the public catalog', async () => {
  await grant('bigmodel')
  const fetch = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json({ code: 0, data: { configs: { builtin_provider_config_json: 'https://cdn-zcode.z.ai/release.json' } } }))
    .mockResolvedValueOnce(Response.json({ config: { providerConfigRules: { providerRules: [{ config: {
      access: { accountType: 'bigmodel', mode: 'team-coding-plan' }, builtinModelIds: ['GLM-5.3', 'GLM-Live-New'],
    } }] } } }))
  await expect(subscriptionCatalog(new Context(), 'bigmodel', config, new AbortController().signal))
    .resolves.toEqual(['glm-5.3', 'GLM-Live-New'])
  for (const [, init] of fetch.mock.calls) {
    const headers = new Headers(init?.headers)
    expect(headers.has('authorization')).toBe(false)
    expect(headers.has('x-api-key')).toBe(false)
    expect(init?.redirect).toBe('error')
  }
})

it('refuses an unexpected catalog download origin without making another request', async () => {
  await grant('bigmodel')
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ code: 0, data: {
    configs: { builtin_provider_config_json: 'https://untrusted.example/catalog.json' },
  } }))
  await expect(subscriptionCatalog(new Context(), 'bigmodel', config, new AbortController().signal))
    .rejects.toMatchObject({ code: 'hemi/subscription-discovery-failed' })
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('reads DeepSeek models from its native account adapter without a Pi OAuth grant', async () => {
  const discoverModels = vi.fn(async () => [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }])
  const ctx = { llm: { discoverModels, listConfigurableProviders: () => [{ provider: 'deepseek-account', settingsNs: 'native-account' }] } } as never
  vi.mocked(credentialStoreFrom).mockClear()
  await expect(subscriptionCatalog(ctx, 'deepseek-account', config, new AbortController().signal))
    .resolves.toEqual(['deepseek-flash', 'deepseek-v4-pro'])
  expect(discoverModels).toHaveBeenCalledWith('native-account', { provider: 'deepseek-account' }, expect.any(AbortSignal))
  expect(credentialStoreFrom).not.toHaveBeenCalled()
  discoverModels.mockResolvedValueOnce([])
  await expect(subscriptionCatalog(ctx, 'deepseek-account', config, new AbortController().signal))
    .rejects.toMatchObject({ code: 'hemi/subscription-discovery-failed' })
})
