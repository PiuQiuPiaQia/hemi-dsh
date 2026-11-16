/** Unknown-model defaults reach both model metadata and real HTTP request bodies. */
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import LlmRuntime, { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import { mountProtocolReasoning, PROTOCOL_REASONING_DEFAULTS, withProtocolReasoning } from '../src/protocol-reasoning.ts'

afterEach(() => { vi.unstubAllEnvs() })

it('preserves explicit offers, explicit disabling, installed models and unrelated protocols', () => {
  const entry = getBuiltinModels('openai')[0]!
  const profiles = {
    openai: { models: [{ id: entry.id }] },
    custom: { api: 'openai-completions', models: [
      { id: 'disabled', reasoningEfforts: false as const },
      { id: 'declared', reasoningEfforts: { low: 'custom-low' } },
    ] },
    other: { api: 'google-generative-ai', models: [{ id: 'unknown' }] },
    empty: { api: 'openai-completions' },
  }
  expect(withProtocolReasoning(profiles, PROTOCOL_REASONING_DEFAULTS)).toEqual(profiles)
})

it('keeps the protocol fallback when catalog providers conflict on the id', () => {
  // "gpt-5" and "deepseek-v4-pro" exist on several catalog providers whose
  // capacities or level maps disagree. No provider is picked silently: the
  // models keep the deployment's protocol offer instead.
  const fallback = PROTOCOL_REASONING_DEFAULTS['openai-completions']!.efforts
  const filled = withProtocolReasoning({
    relay: { api: 'openai-completions', models: [{ id: 'gpt-5' }, { id: 'deepseek-v4-pro' }] },
  }, PROTOCOL_REASONING_DEFAULTS)
  expect(filled.relay!.models).toEqual([
    { id: 'gpt-5', reasoningEfforts: fallback, defaultReasoningEffort: 'medium' },
    { id: 'deepseek-v4-pro', reasoningEfforts: fallback, defaultReasoningEffort: 'medium' },
  ])
})

it('translates an explicitly referenced cross-family model into the target encoding', () => {
  const base = getBuiltinModels('openai').find(model => model.id === 'gpt-5')!
  const filled = withProtocolReasoning({
    relay: { api: 'openai-completions', baseURL: 'https://relay.invalid/v1', models: [{ id: base.id, catalogProvider: 'openai' }] },
  }, PROTOCOL_REASONING_DEFAULTS)
  // The openai entry names off unsupported; the translated offer carries the
  // supported levels in the completions spelling and invents no default.
  expect(filled.relay!.models).toEqual([{ id: base.id, catalogProvider: 'openai',
    reasoningEfforts: { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' } }])
  const model = PiAi.resolveProfiles(filled).get('relay')?.piProvider?.getModels()[0]
  expect(model?.thinkingLevelMap).toEqual(base.thinkingLevelMap)
  expect(getSupportedThinkingLevels(model!)).toEqual(['minimal', 'low', 'medium', 'high'])
})

it('keeps an own-protocol anthropic reference adaptive and in the anthropic effort vocabulary', () => {
  const base = getBuiltinModels('anthropic')[0]!
  const filled = withProtocolReasoning({
    relay: { api: 'anthropic-messages', baseURL: 'https://relay.invalid/v1', models: [{ id: base.id }] },
  }, PROTOCOL_REASONING_DEFAULTS)
  const [entry] = filled.relay!.models!
  expect(entry).toMatchObject({ id: base.id, catalogProvider: 'anthropic',
    compat: { forceAdaptiveThinking: true } })
  expect(entry?.defaultReasoningEffort).toBeUndefined()
  const model = PiAi.resolveProfiles(filled).get('relay')?.piProvider?.getModels()[0]
  // The anthropic wire never names "minimal": the absent-key default follows
  // the protocol's own normalization instead of the internal level id, and the
  // declared off-unsupported and xhigh/max spellings stay untouched.
  expect(model?.thinkingLevelMap).toEqual({ off: null, minimal: 'low', low: 'low', medium: 'medium',
    high: 'high', xhigh: 'xhigh', max: 'max' })
  expect(model?.compat).toMatchObject({ forceAdaptiveThinking: true })
})

it.each([
  ['openai-completions', ['off', 'low', 'high', 'max']],
  ['openai-responses', ['off', 'low', 'high', 'max']],
  ['anthropic-messages', ['off', 'low', 'high', 'max']],
])('carries deepseek-flash levels to %s without importing vendor transport', (api, levels) => {
  const filled = withProtocolReasoning({
    relay: { api, baseURL: 'https://relay.invalid/v1', models: [{ id: 'deepseek-flash' }] },
  }, PROTOCOL_REASONING_DEFAULTS)
  // The same four levels the native deepseek route offers, in the route's own
  // encoding: completions copies the vendor map (off stays send-nothing),
  // responses uses its effort enum, anthropic maps minimal-free levels and
  // keeps adaptive thinking.
  const expected = api === 'openai-completions'
    ? { id: 'deepseek-flash', catalogProvider: 'deepseek',
      reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' },
      compat: { thinkingFormat: 'deepseek' } }
    : api === 'openai-responses'
      ? { id: 'deepseek-flash', catalogProvider: 'deepseek',
        reasoningEfforts: { off: 'none', low: 'low', high: 'high', max: 'max' } }
      : { id: 'deepseek-flash', catalogProvider: 'deepseek',
        reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' },
        compat: { forceAdaptiveThinking: true } }
  expect(filled.relay!.models).toEqual([expected])
  const model = PiAi.resolveProfiles(filled).get('relay')?.piProvider?.getModels()[0]
  expect(getSupportedThinkingLevels(model!)).toEqual(levels)
  // Only the thinking channel of a matching protocol crosses; vendor
  // endpoints, authentication, and output caps never do.
  expect(model).toMatchObject({ provider: 'relay', name: 'DeepSeek V4.1 Flash',
    contextWindow: 1000000, maxTokens: 384000, input: ['text', 'image'],
    thinkingLevelMap: { low: 'low', high: 'high', max: 'max' } })
  if (api === 'openai-completions') expect(model?.compat).toMatchObject({ thinkingFormat: 'deepseek' })
  else expect(model?.compat ?? {}).not.toHaveProperty('thinkingFormat')
})

it('keeps known non-reasoning catalog models non-reasoning on every route', () => {
  const filled = withProtocolReasoning({
    relay: { api: 'openai-completions', baseURL: 'https://relay.invalid/v1', models: [{ id: 'gpt-4.1-nano' }] },
    relayAnthropic: { api: 'anthropic-messages', baseURL: 'https://relay.invalid/v1', models: [{ id: 'gpt-4.1-nano' }] },
  }, PROTOCOL_REASONING_DEFAULTS)
  // A unanimous non-reasoning declaration beats a capacity disagreement:
  // neither route gains a protocol effort offer or a default.
  expect(filled.relay!.models).toEqual([{ id: 'gpt-4.1-nano', reasoningEfforts: false }])
  expect(filled.relayAnthropic!.models).toEqual([{ id: 'gpt-4.1-nano', reasoningEfforts: false }])
  for (const provider of ['relay', 'relayAnthropic']) {
    expect(PiAi.resolveProfiles(filled).get(provider)?.piProvider?.getModels()[0]).toMatchObject({ reasoning: false })
  }
})

it('lets explicit choices beat catalog identity and endpoint switches beat fallbacks', () => {
  const filled = withProtocolReasoning({
    narrow: { api: 'openai-completions', baseURL: 'https://relay.invalid/v1', models: [
      { id: 'deepseek-flash', reasoningEfforts: { high: 'high' }, defaultReasoningEffort: 'high' },
    ] },
    disabled: { api: 'openai-completions', baseURL: 'https://relay.invalid/v1', models: [{ id: 'deepseek-flash', reasoningEfforts: false as const }] },
    routeSwitch: { api: 'openai-completions', baseURL: 'https://relay.invalid/v1', compat: { supportsReasoningEffort: false }, models: [{ id: 'deepseek-flash' }] },
    ownFormat: { api: 'openai-completions', baseURL: 'https://relay.invalid/v1', models: [{ id: 'deepseek-flash', compat: { thinkingFormat: 'openai' } }] },
  }, PROTOCOL_REASONING_DEFAULTS)
  // Identity resolution still records the reference beside an explicit offer;
  // the explicit fields themselves stay untouched.
  expect(filled.narrow!.models).toEqual([
    { id: 'deepseek-flash', catalogProvider: 'deepseek', reasoningEfforts: { high: 'high' }, defaultReasoningEffort: 'high' }])
  expect(filled.disabled!.models).toEqual([{ id: 'deepseek-flash', catalogProvider: 'deepseek', reasoningEfforts: false }])
  expect(filled.routeSwitch!.models).toEqual([{ id: 'deepseek-flash', catalogProvider: 'deepseek' }])
  // The declared format decides the encoding: the reference map is translated
  // into the declared channel instead of copying the vendor one.
  expect(filled.ownFormat!.models).toEqual([{ id: 'deepseek-flash', catalogProvider: 'deepseek',
    compat: { thinkingFormat: 'openai' },
    reasoningEfforts: { off: 'none', low: 'low', high: 'high', max: 'max' } }])
  const resolved = PiAi.resolveProfiles(filled)
  expect(resolved.get('narrow')?.piProvider?.getModels()[0]).toMatchObject({ reasoning: true })
  expect(resolved.get('disabled')?.piProvider?.getModels()[0]).toMatchObject({ reasoning: false })
  expect(resolved.get('routeSwitch')?.piProvider?.getModels()[0]).toMatchObject({ reasoning: false })
  expect(resolved.get('ownFormat')?.piProvider?.getModels()[0]).toMatchObject({ reasoning: true,
    thinkingLevelMap: { off: 'none', low: 'low', high: 'high', max: 'max', minimal: null, medium: null } })
})

it('does not borrow composite template formats or their disabled effort switches', () => {
  // moonshotai/Kimi-K2.5 dispatches through a baseten chat-template whose
  // arguments the reference route owns; its route also switches effort
  // dispatch off. Neither fact may leak onto a plain completions route: the
  // levels translate into the target encoding with no thinking format.
  const filled = withProtocolReasoning({
    relay: { api: 'openai-completions', baseURL: 'https://relay.invalid/v1', models: [{ id: 'moonshotai/Kimi-K2.5', catalogProvider: 'baseten' }] },
  }, PROTOCOL_REASONING_DEFAULTS)
  expect(filled.relay!.models).toEqual([{ id: 'moonshotai/Kimi-K2.5', catalogProvider: 'baseten',
    reasoningEfforts: { off: 'none', high: 'high' } }])
  const model = PiAi.resolveProfiles(filled).get('relay')?.piProvider?.getModels()[0]
  expect(model?.compat ?? {}).not.toHaveProperty('thinkingFormat')
  expect(getSupportedThinkingLevels(model!)).toEqual(['off', 'high'])
})

it.each(['openai-completions', 'openai-responses', 'anthropic-messages'])(
  'advertises and sends protocol defaults and chosen levels for unknown models on %s without persisting them',
  async (api) => {
    vi.stubEnv('HEMI_REASONING_TEST_KEY', 'fixture-key')
    const bodies: Record<string, unknown>[] = []
    const server = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        bodies.push(JSON.parse(body) as Record<string, unknown>)
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'fixture response' } }))
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    onTestFinished(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => { resolve() }) }))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Missing fixture port')
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(LlmRuntime)
    const configured = { custom: { api, baseURL: `http://127.0.0.1:${address.port}/v1`,
      apiKeyEnv: 'HEMI_REASONING_TEST_KEY', models: [{ id: 'custom-model' }],
    } }
    await ctx.plugin(PiAi, { providers: configured })
    expect((await ctx.llm.resolveModelInfo('custom', 'custom-model')).reasoning).toBeUndefined()
    const plugin = ctx.plugin({ name: 'reasoning-fixture', apply(scope: Context) {
      mountProtocolReasoning(scope, PROTOCOL_REASONING_DEFAULTS)
    } })
    await plugin
    const info = await ctx.llm.resolveModelInfo('custom', 'custom-model')
    expect(info.reasoning?.defaultEffort).toBe(api === 'anthropic-messages' ? 'high' : 'medium')
    expect(info.reasoning?.efforts.map(effort => effort.id)).toEqual(api === 'anthropic-messages'
      ? ['low', 'medium', 'high', 'xhigh', 'max'] : ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    for (const effort of [undefined, 'max', ...api === 'anthropic-messages' ? [] : ['off']]) {
      for await (const _chunk of ctx.llm.stream({ provider: 'custom', model: 'custom-model',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }],
        ...effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) },
      })) { /* Capture the request; the fixture returns a provider rejection. */ }
    }
    const field = api === 'openai-completions' ? 'reasoning_effort' : api === 'openai-responses' ? 'reasoning' : 'output_config'
    const wire = bodies.map(body => api === 'openai-completions' ? body[field] : (body[field] as { effort: string }).effort)
    expect(wire).toEqual(api === 'anthropic-messages' ? ['high', 'max'] : ['medium', 'max', 'none'])
    expect(configured.custom.models).toEqual([{ id: 'custom-model' }])
    await plugin.dispose()
    expect((await ctx.llm.resolveModelInfo('custom', 'custom-model')).reasoning).toBeUndefined()
  },
)

it('sends deepseek-flash native effort fields over a VVCode-style route', async () => {
  vi.stubEnv('HEMI_REASONING_TEST_KEY', 'fixture-key')
  const bodies: Record<string, unknown>[] = []
  const urls: string[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      bodies.push(JSON.parse(body) as Record<string, unknown>)
      urls.push(request.url ?? '')
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'fixture response' } }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => { resolve() }) }))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing fixture port')
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  // The VVCode adapter publishes group routes with exactly this shape: one
  // openai-completions route whose model list names the relay's model ids.
  const configured = { vvcode: { api: 'openai-completions', baseURL: `http://127.0.0.1:${address.port}/v1`,
    apiKeyEnv: 'HEMI_REASONING_TEST_KEY', models: [{ id: 'deepseek-flash' }] } }
  await ctx.plugin(PiAi, { providers: configured })
  const plugin = ctx.plugin({ name: 'reasoning-fixture', apply(scope: Context) {
    mountProtocolReasoning(scope, PROTOCOL_REASONING_DEFAULTS)
  } })
  await plugin
  // The identified model offers exactly the native deepseek-flash levels and
  // no invented request default; the UI therefore shows Off/Low/High/Max.
  const info = await ctx.llm.resolveModelInfo('vvcode', 'deepseek-flash')
  expect(info.reasoning?.efforts.map(effort => effort.id)).toEqual(['off', 'low', 'high', 'max'])
  expect(info.reasoning?.defaultEffort).toBeUndefined()
  // Every level dispatches in the model's own thinking channel: chosen levels
  // enable thinking and name the effort, off disables thinking and sends no
  // effort parameter. Requests reach the configured relay, not a vendor host.
  for (const effort of [undefined, 'off', 'high', 'max'] as const) {
    for await (const _chunk of ctx.llm.stream({ provider: 'vvcode', model: 'deepseek-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }],
      ...effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) },
    })) { /* Capture the request; the fixture returns a provider rejection. */ }
  }
  expect(bodies.map(body => ({ thinking: body.thinking, reasoning_effort: body.reasoning_effort }))).toEqual([
    { thinking: { type: 'disabled' }, reasoning_effort: undefined },
    { thinking: { type: 'disabled' }, reasoning_effort: undefined },
    { thinking: { type: 'enabled' }, reasoning_effort: 'high' },
    { thinking: { type: 'enabled' }, reasoning_effort: 'max' },
  ])
  expect(urls).toEqual(Array(4).fill('/v1/chat/completions'))
  expect(configured.vvcode.models).toEqual([{ id: 'deepseek-flash' }])
  await plugin.dispose()
  expect((await ctx.llm.resolveModelInfo('vvcode', 'deepseek-flash')).reasoning).toBeUndefined()
})

it('keeps missing or unsupported protocols unencoded and preserves adaptive-thinking overrides', () => {
  const filled = withProtocolReasoning({
    missing: { models: [{ id: 'unknown-model' }] },
    unsupported: { api: 'google-generative-ai', models: [{ id: 'deepseek-flash' }] },
    modelAdaptive: { api: 'anthropic-messages', models: [{ id: 'deepseek-flash', compat: { forceAdaptiveThinking: false } }] },
    routeAdaptive: { api: 'anthropic-messages', compat: { forceAdaptiveThinking: false }, models: [{ id: 'deepseek-flash' }] },
    anthropic: { api: 'anthropic-messages', models: [{ id: 'gpt-5', catalogProvider: 'openai' }] },
  }, {})
  expect(filled.missing!.models).toEqual([{ id: 'unknown-model' }])
  expect(filled.unsupported!.models).toEqual([{ id: 'deepseek-flash', catalogProvider: 'deepseek' }])
  expect(filled.modelAdaptive!.models![0]!.compat?.forceAdaptiveThinking).toBe(false)
  expect(filled.routeAdaptive!.models![0]!.compat?.forceAdaptiveThinking).toBe(false)
  expect(filled.anthropic!.models![0]!.reasoningEfforts).toEqual({ minimal: 'low', low: 'low', medium: 'medium', high: 'high' })
})

it('rejects an empty reasoningEfforts dict instead of falling back', () => {
  expect(() => PiAi.resolveProfiles({ custom: { api: 'openai-completions', baseURL: 'https://example.invalid/v1',
    models: [{ id: 'm', reasoningEfforts: {} }] } })).toThrow(/empty reasoningEfforts/)
})

it('rejects a materialized default that its identified offer excludes', () => {
  expect(() => PiAi.resolveProfiles({ custom: { api: 'openai-completions', baseURL: 'https://example.invalid/v1',
    models: [{ id: 'deepseek-flash', defaultReasoningEffort: 'medium' }] } }))
    .toThrow(/defaultReasoningEffort must name an offered reasoning level/)
})

it('rejects a per-model default that its declared effort offer excludes', () => {
  expect(() => PiAi.resolveProfiles({ custom: { api: 'openai-completions', baseURL: 'https://example.invalid/v1',
    models: [{ id: 'm', reasoningEfforts: { high: 'high' }, defaultReasoningEffort: 'low' }],
  } })).toThrow(/defaultReasoningEffort must name an offered reasoning level/)
})

it('refuses a fallback default outside its offer before registering the contribution', () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  expect(() => {
    mountProtocolReasoning(ctx, { 'openai-completions': { efforts: { high: 'high' }, defaultEffort: 'low' } })
  }).toThrow(/defaultEffort must name an offered reasoning level/)
})
