/** Imported model capabilities use exact catalog ids while keeping gateway transport independent. */
import { expect, it } from 'vitest'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { resolveProfiles } from '@deepseek-ai/dsh-llm-pi-ai'
import { draftModelDefaults, importedCatalogModel } from '../src/model-catalog.ts'
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

it('uses text-only fallback for an unknown or merely similar id', () => {
  expect(importedCatalogModel('openai-completions', 'o4-mini-relay-unknown')).toBeUndefined()
  expect(draftModelDefaults('openai-completions', 'o4-mini-relay-unknown')).toMatchObject({ input: ['text'] })
})

it('rejects a capability reference that cannot resolve an exact model id', () => {
  expect(() => resolveProfiles({ relay: { api: 'openai-completions', baseURL: 'https://relay.invalid/v1', models: [
    { id: 'nonexistent-model', catalogProvider: 'openai' },
  ] } })).toThrow(/catalogProvider.*has no matching model/)
})
