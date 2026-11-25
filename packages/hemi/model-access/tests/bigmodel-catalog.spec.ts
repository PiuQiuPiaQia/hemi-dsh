/** GLM Coding Plan model resolution: shipped ids keep their capabilities, new ids take the protocol reasoning fallback. */
import { describe, expect, it } from 'vitest'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import type { CredentialStore, Provider } from '@earendil-works/pi-ai'
import { bigModelCodingProvider } from '#bigmodel-protocol'
import { BIGMODEL_PROVIDER, bigModelCatalog } from '../src/bigmodel/index.ts'
import { PROTOCOL_REASONING_DEFAULTS } from '../src/protocol-reasoning.ts'

/** A store no resolution reads: model resolution never touches credentials. */
const UNUSED_STORE: CredentialStore = {
  read: async () => undefined,
  list: async () => [],
  modify: async (_provider, update) => update(undefined),
  delete: async () => {},
}

/** The models the Coding Plan provider ships. */
const shipped = (): ReturnType<Provider['getModels']> => bigModelCodingProvider(UNUSED_STORE).getModels()

describe('bigModelCatalog', () => {
  it('publishes every shipped model with its own levels while nothing is selected', () => {
    const catalog = bigModelCatalog(shipped(), undefined, undefined, PROTOCOL_REASONING_DEFAULTS)
    expect(catalog.models.map(model => [model.id, getSupportedThinkingLevels(model)])).toEqual([
      ['glm-5.3', ['low', 'high', 'max']],
      ['glm-5.3-flash', ['low', 'high', 'max']],
    ])
    expect(catalog.configuredReasoningEfforts.size).toBe(0)
  })

  it('gives a service-advertised id the Anthropic protocol fallback beside a shipped sibling', () => {
    const catalog = bigModelCatalog(shipped(), ['glm-5.3-flash', 'GLM-5.4'],
      { 'GLM-5.4': { input: ['text', 'image'] } }, PROTOCOL_REASONING_DEFAULTS)
    const [sibling, discovered] = catalog.models
    expect(getSupportedThinkingLevels(sibling!)).toEqual(['low', 'high', 'max'])
    expect(discovered).toMatchObject({
      id: 'GLM-5.4', api: 'anthropic-messages', provider: BIGMODEL_PROVIDER, reasoning: true,
      baseUrl: 'https://open.bigmodel.cn/api/anthropic', input: ['text', 'image'],
      compat: { forceAdaptiveThinking: true },
    })
    expect(getSupportedThinkingLevels(discovered!)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect([...catalog.configuredReasoningEfforts]).toEqual([['GLM-5.4', 'high']])
  })

  it('reads the configured reasoning defaults instead of the built-in protocol table', () => {
    const catalog = bigModelCatalog(shipped(), ['GLM-5.4'], undefined, {
      'anthropic-messages': { efforts: { low: 'low', max: 'max' }, defaultEffort: 'max' },
    })
    const [discovered] = catalog.models
    expect(getSupportedThinkingLevels(discovered!)).toEqual(['low', 'max'])
    expect([...catalog.configuredReasoningEfforts]).toEqual([['GLM-5.4', 'max']])
  })
})
