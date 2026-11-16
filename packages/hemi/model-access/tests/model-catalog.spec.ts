/** Imported model capabilities use exact catalog ids while keeping gateway transport independent. */
import { expect, it, vi } from 'vitest'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { resolveProfiles } from '@deepseek-ai/dsh-llm-pi-ai'
import { draftModelDefaults, importedCatalogModel, installedCatalogModel, isKnownNonReasoningModel, withCatalogCapabilities } from '../src/model-catalog.ts'
import { PROTOCOL_REASONING_DEFAULTS, withProtocolReasoning } from '../src/protocol-reasoning.ts'

it.each(['openai-completions', 'openai-responses', 'anthropic-messages'])(
  'inherits known model capabilities for %s without inheriting vendor transport or output request caps', (api) => {
    const provider = api === 'anthropic-messages' ? 'anthropic' : 'openai'
    const base = getBuiltinModels(provider).find(model => model.input.includes('image'))!
    const configured = { relay: { api, baseURL: 'https://relay.invalid/v1', apiKeyEnv: 'RELAY_KEY', models: [{ id: base.id }] } }
    const filled = withProtocolReasoning(configured, PROTOCOL_REASONING_DEFAULTS)
    const profile = resolveProfiles(filled).get('relay')!
    expect(profile.piProvider?.getModels()[0]).toMatchObject({ name: base.name, input: base.input,
      contextWindow: base.contextWindow, maxTokens: base.maxTokens, provider: 'relay', api, baseUrl: 'https://relay.invalid/v1',
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })
    expect(profile.piProvider?.getModels()[0]?.headers).toBeUndefined()
    expect(profile.configuredMaxTokens.size).toBe(0)
    expect(configured.relay.models).toEqual([{ id: base.id }])
    expect(draftModelDefaults(api, base.id)).toEqual({ name: base.name, input: base.input,
      contextWindow: base.contextWindow, maxTokens: base.maxTokens })
  },
)

it('keeps explicit text-only and token overrides on a catalog-known relay model', () => {
  const base = getBuiltinModels('openai').find(model => model.input.includes('image'))!
  const profiles = withProtocolReasoning({ relay: { api: 'openai-completions', baseURL: 'https://relay.invalid/v1', models: [
    { id: base.id, name: 'Owner name', input: ['text'], contextWindow: 32000, maxTokens: 2048, reasoningEfforts: false },
  ] } }, PROTOCOL_REASONING_DEFAULTS)
  const profile = resolveProfiles(profiles).get('relay')!
  expect(profile.piProvider?.getModels()[0]).toMatchObject({ name: 'Owner name', input: ['text'], contextWindow: 32000, maxTokens: 2048, reasoning: false })
  expect(profile.configuredMaxTokens.get(base.id)).toBe(2048)
})

it('resolves an explicitly referenced reasoning model to its exact catalog levels', () => {
  // Auto identity for "gpt-5" is refused: catalog providers disagree on context
  // capacity. An explicit catalogProvider pins the identity, so its exact
  // published level map resolves instead of the protocol fallback.
  const base = getBuiltinModels('openai').find(model => model.id === 'gpt-5')!
  const configured = { relay: { api: 'openai-completions', baseURL: 'https://relay.invalid/v1',
    models: [{ id: base.id, catalogProvider: 'openai' }] } }
  const profile = resolveProfiles(withProtocolReasoning(configured, PROTOCOL_REASONING_DEFAULTS)).get('relay')!
  const model = profile.piProvider?.getModels()[0]
  expect(model).toMatchObject({ id: base.id, reasoning: true, api: 'openai-completions', baseUrl: 'https://relay.invalid/v1',
    name: base.name, contextWindow: base.contextWindow, maxTokens: base.maxTokens, input: base.input })
  // The vendor's published level map arrives intact: levels the model does not
  // support stay unoffered, and no protocol fallback widens the offer.
  expect(model?.thinkingLevelMap).toEqual(base.thinkingLevelMap)
  expect(configured.relay.models).toEqual([{ id: base.id, catalogProvider: 'openai' }])
})

it.each([
  ['anthropic', 'openai-completions'],
  ['openai', 'anthropic-messages'],
] as const)('recognizes %s model inputs when a relay exposes them through %s', (vendor, api) => {
  const base = getBuiltinModels(vendor).find(model => model.input.includes('image'))!
  expect(importedCatalogModel(api, base.id)?.input).toEqual(['text', 'image'])
  const profiles = withProtocolReasoning({ relay: { api, baseURL: 'https://relay.invalid/v1', models: [{ id: base.id }] } },
    PROTOCOL_REASONING_DEFAULTS)
  expect(resolveProfiles(profiles).get('relay')?.piProvider?.getModels()[0]).toMatchObject({
    api, baseUrl: 'https://relay.invalid/v1', input: ['text', 'image'],
  })
})

it('identifies deepseek-flash by its model, not by the route vendor', () => {
  const base = installedCatalogModel('deepseek', 'deepseek-flash')!
  // The id is unique across the installed catalog, so every route protocol
  // resolves the same identity and only a matching protocol reuses its wire.
  expect(importedCatalogModel('openai-completions', 'deepseek-flash')).toBe(base)
  expect(importedCatalogModel('openai-responses', 'deepseek-flash')).toBe(base)
  expect(importedCatalogModel('anthropic-messages', 'deepseek-flash')).toBe(base)
  const filled = withCatalogCapabilities('vvcode', { api: 'openai-completions', models: [{ id: 'deepseek-flash' }] })
  expect(filled.models).toEqual([{ id: 'deepseek-flash', catalogProvider: 'deepseek' }])
})

it.each([
  ['gpt-5', 'openai-completions'],
  ['deepseek-v4-pro', 'openai-completions'],
  ['deepseek-v4-pro', 'openai-responses'],
] as const)('refuses %s on %s: same-id catalog providers conflict on capability or capacity', (id, api) => {
  // Refusing the identity keeps the route's own defaults; it never silently
  // picks the first catalog provider that happens to list the id.
  expect(importedCatalogModel(api, id)).toBeUndefined()
  const filled = withCatalogCapabilities('relay', { api, models: [{ id }] })
  expect(filled.models).toEqual([{ id }])
})

it('recognizes a unanimous non-reasoning declaration across conflicting capacities', () => {
  // gpt-4.1-nano is non-reasoning on every catalog provider even though their
  // context capacities disagree; the negative fact must survive the conflict.
  expect(isKnownNonReasoningModel('gpt-4.1-nano')).toBe(true)
  expect(isKnownNonReasoningModel('deepseek-flash')).toBe(false)
  expect(isKnownNonReasoningModel('unknown-relay-model')).toBe(false)
})

it('preserves an explicit catalogProvider reference over auto identity', () => {
  const filled = withCatalogCapabilities('relay', { api: 'openai-completions', models: [
    { id: 'deepseek-flash', catalogProvider: 'deepseek' },
    { id: 'gpt-5', catalogProvider: 'openai' },
  ] })
  expect(filled.models).toEqual([
    { id: 'deepseek-flash', catalogProvider: 'deepseek' },
    { id: 'gpt-5', catalogProvider: 'openai' },
  ])
})

it('uses text-only fallback for an unknown or merely similar id', () => {
  expect(importedCatalogModel('openai-completions', 'o4-mini-relay-unknown')).toBeUndefined()
  expect(draftModelDefaults('openai-completions', 'o4-mini-relay-unknown')).toMatchObject({ input: ['text'] })
})

it('retains a model identity whose catalog omits an explicit effort map', () => {
  const model = importedCatalogModel('bedrock-converse-stream', 'amazon.nova-2-lite-v1:0')
  expect(model).toMatchObject({ id: 'amazon.nova-2-lite-v1:0', reasoning: true })
  expect(model?.thinkingLevelMap).toBeUndefined()
})

it('withholds automatic identity when equivalent levels use conflicting protocol encodings', async () => {
  const actual = await vi.importActual<typeof import('@earendil-works/pi-ai/providers/all')>('@earendil-works/pi-ai/providers/all')
  const base = actual.getBuiltinModels('deepseek')[0]!
  vi.resetModules()
  vi.doMock('@earendil-works/pi-ai/providers/all', () => ({
    ...actual,
    getBuiltinProviders: () => ['fixture-a', 'fixture-b'],
    getBuiltinModels: (provider: string) => [{ ...base, id: 'fixture-conflicting-wire', provider,
      thinkingLevelMap: { off: null, high: provider === 'fixture-a' ? 'high' : 'deep' } }],
  }))
  try {
    const catalog = await import('../src/model-catalog.ts')
    expect(catalog.importedCatalogModel('openai-completions', 'fixture-conflicting-wire')).toBeUndefined()
  } finally {
    vi.doUnmock('@earendil-works/pi-ai/providers/all')
    vi.resetModules()
  }
})

it('rejects a capability reference that cannot resolve an exact model id', () => {
  expect(() => resolveProfiles({ relay: { api: 'openai-completions', baseURL: 'https://relay.invalid/v1', models: [
    { id: 'nonexistent-model', catalogProvider: 'openai' },
  ] } })).toThrow(/catalogProvider.*has no matching model/)
})
