import { describe, expect, it } from 'vitest'
import { applyModelOptions, modelOptionsOf } from '../src/model-options.ts'

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
})
