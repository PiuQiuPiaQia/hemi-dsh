import { describe, expect, it, vi } from 'vitest'
import { applyModelOptions, modelOptionsOf, readKeyModelDefaults, readModelOptions, writeModelOptions } from '../src/model-options.ts'

describe('model capability overrides', () => {
  it('clears inherited fields without changing protocol or reasoning configuration', () => {
    const previous = { id: 'model', name: 'Old', contextWindow: 64000, maxTokens: 8000, input: ['text', 'image'],
      reasoningEfforts: { high: 'enabled' }, compat: { supportsStore: false } }
    expect(applyModelOptions(previous, {})).toEqual({ id: 'model', reasoningEfforts: { high: 'enabled' }, compat: { supportsStore: false } })
    expect(previous.contextWindow).toBe(64000)
  })

  it('keeps text-only selection explicit and trims the display name', () => {
    expect(applyModelOptions({ id: 'model' }, { name: ' My model ', contextWindow: 128000, maxTokens: 8192, input: ['text'] }))
      .toEqual({ id: 'model', name: 'My model', contextWindow: 128000, maxTokens: 8192, input: ['text'] })
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY])('rejects an invalid token limit: %s', (value) => {
    expect(() => applyModelOptions({}, { contextWindow: value })).toThrow('positive integers')
    expect(() => applyModelOptions({}, { maxTokens: value })).toThrow('positive integers')
  })

  it('rejects an empty explicit input declaration and a blank explicit name', () => {
    expect(() => applyModelOptions({}, { input: [] })).toThrow('input type')
    expect(() => applyModelOptions({}, { name: ' ' })).toThrow('display name')
  })

  it('does not expose unrelated configuration in the editor', () => {
    expect(modelOptionsOf({ id: 'model', name: 'Name', contextWindow: 32000, maxTokens: 4096, input: ['text', 'image'],
      headers: { 'X-Private': 'secret' }, reasoningEfforts: false }))
      .toEqual({ name: 'Name', contextWindow: 32000, maxTokens: 4096, input: ['text', 'image'] })
    expect(modelOptionsOf(undefined)).toEqual({})
    expect(modelOptionsOf({ input: [] })).toEqual({})
  })

  it('separates inherited route capabilities from saved overrides in an existing connection draft', () => {
    const ctx = { settings: { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { relay: {
      api: 'openai-completions', defaultContextWindow: 32000, defaultMaxTokens: 4096, defaultInput: ['text', 'image'],
      models: [{ id: 'unknown-private-model', name: 'Saved name', input: ['text'], contextWindow: 64000, maxTokens: 2048 }],
    } } } }] } } as never
    expect(readKeyModelDefaults(ctx, 'openai-completions', 'unknown-private-model', 'relay')).toEqual({
      name: 'unknown-private-model', contextWindow: 32000, maxTokens: 4096, input: ['text', 'image'],
    })
  })

  it('reports a removed draft connection and an unavailable catalog reference', () => {
    const ctx = { settings: { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { relay: {
      models: [{ id: 'unknown-model', catalogProvider: 'openai' }],
    } } } }] } } as never
    expect(() => readKeyModelDefaults(ctx, 'openai-completions', 'unknown-model', 'removed')).toThrow('connection was removed')
    expect(() => readKeyModelDefaults(ctx, 'openai-completions', 'unknown-model', 'relay')).toThrow('catalog model is unavailable')
  })
})

it('edits native DeepSeek model overrides without creating a Pi route or replacing its catalog', async () => {
  const mutate = vi.fn(async () => {})
  const ctx = {
    llm: {
      listModels: async () => [{ id: 'deepseek-flash' }],
      resolveModelInfo: async () => ({ name: 'Original', inputModalities: ['text', 'image'], context: { contextWindow: 1000000 } }),
      listConfigurableProviders: () => [{ provider: 'deepseek-account', settingsNs: 'native-account', settingsPath: [] }],
    },
    settings: {
      describe: () => [{ ns: 'native-account', revision: 3, value: {
        modelOverrides: { 'deepseek-flash': { name: 'Original', inputModalities: ['text', 'image'], imageMaxBytes: 1234 } },
      } }],
      mutate,
    },
  } as never
  await expect(readModelOptions(ctx, 'deepseek-account', 'deepseek-flash', false)).resolves.toEqual({
    revision: 3, options: { name: 'Original', input: ['text', 'image'] },
    effective: { name: 'Original', input: ['text', 'image'], contextWindow: 1000000 },
  })
  await writeModelOptions(ctx, 'deepseek-account', 'deepseek-flash', { name: 'Edited', input: ['text'] }, 3, false)
  expect(mutate).toHaveBeenLastCalledWith('native-account', [{ op: 'set', path: ['modelOverrides', 'deepseek-flash'],
    value: { name: 'Edited', inputModalities: ['text'], imageMaxBytes: 1234 } }], 3)
  await writeModelOptions(ctx, 'deepseek-account', 'deepseek-flash', {}, 3, false)
  expect(mutate).toHaveBeenLastCalledWith('native-account', [{ op: 'set', path: ['modelOverrides', 'deepseek-flash'],
    value: { imageMaxBytes: 1234 } }], 3)
})
