/** Unknown-model defaults reach both model metadata and real HTTP request bodies. */
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import LlmRuntime, { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
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
  }
  expect(withProtocolReasoning(profiles, PROTOCOL_REASONING_DEFAULTS)).toEqual(profiles)
})

it.each(['openai-completions', 'openai-responses', 'anthropic-messages'])(
  'advertises and sends protocol defaults and chosen levels for %s without persisting them', async (api) => {
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
