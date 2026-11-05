/** The account route serves its /models listing, gates models, and keeps discovery independent of the API-key route. */
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import LlmRuntime, { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { DeepSeekAccount } from '@deepseek-ai/dsh-deepseek-account'
import * as ApiKey from '@deepseek-ai/dsh-llm-deepseek-api-key'
import * as Account from '../src/index.ts'

const MESSAGES = { output_modalities: ['text'], api_capabilities: { anthropic_messages: {} } }
const FLASH = {
  id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', context_window: 1_048_576, max_output_tokens: 393_216,
  input_modalities: ['text', 'image'], output_modalities: ['text'],
  effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' },
  api_capabilities: { anthropic_messages: { system_prompt_update: 'in-history' } },
}
const PRO = { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', context_window: 1_048_576, max_output_tokens: 393_216, input_modalities: ['text'], ...MESSAGES }
const requires = (version: string) => ({ client_requirements: { 'deepseek-harness': { min_version: version } } })

const contexts: Context[] = []
const servers: Server[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

/** Loopback listing endpoint: `reply` answers GET /models; any other request fails the test through its status. */
async function listing(reply: (request: IncomingMessage, response: ServerResponse) => void) {
  const requests: IncomingMessage[] = []
  const server = createServer((request, response) => {
    requests.push(request)
    if (request.method === 'GET' && request.url === '/models') reply(request, response)
    else response.writeHead(500).end('unexpected request')
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  const origin = `http://127.0.0.1:${address.port}`
  return { origin, requests, baseURL: `${origin}/anthropic` }
}
const json = (body: unknown) => (_request: IncomingMessage, response: ServerResponse) => {
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}

async function host(origin: string, token: () => string | undefined = () => 'fixture-account-token') {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  ctx.provide('deepseekAccount', {
    resolveToken: (url: string) => Promise.resolve(new URL(url).origin === origin ? token() : undefined),
  } as DeepSeekAccount)
  return ctx
}

it('keeps discovery and disposal independent across the two credential routes', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'fixture-api-key')
  const server = await listing(json({ data: [FLASH, PRO] }))
  let token: string | undefined = 'fixture-account-token'
  const ctx = await host(server.origin, () => token)
  const account = ctx.plugin(Account, { baseURL: server.baseURL })
  await account
  const official = ctx.plugin(ApiKey, { models: [{ id: 'api-key-model', name: 'API-key model' }] })
  await official
  expect((await ctx.llm.listModels('deepseek-account')).map(row => [row.id, row.name])).toEqual([
    ['deepseek-flash', 'DeepSeek-V4.1-Flash'], ['deepseek-v4-pro', 'DeepSeek-V4-Pro'],
  ])
  expect((await ctx.llm.listModels('deepseek-official')).map(row => row.id)).toEqual(['api-key-model'])
  expect(ctx.llm.listConfigurableProviders().map(row => [row.provider, row.settingsNs])).toEqual([
    ['deepseek-account', 'llm-deepseek-account'], ['deepseek-official', 'llm-deepseek-api-key'],
  ])
  expect(Account.Config({})).not.toHaveProperty('apiKeyEnv')
  token = undefined
  expect(await ctx.llm.listModels('deepseek-account')).toEqual([])
  token = 'second-account-token'
  expect(await ctx.llm.listModels('deepseek-account')).toHaveLength(2)
  expect(server.requests.map(request => request.headers['x-dsh-auth-token'])).toEqual(['fixture-account-token', 'second-account-token'])
  await account.dispose()
  expect(ctx.llm.listProviders().map(row => row.id)).toEqual(['deepseek-official'])
  await official.dispose()
  expect(ctx.llm.listConfigurableProviders()).toEqual([])
})

it('resolves listed capabilities with this build\'s model knowledge', async () => {
  const server = await listing(json({ data: [FLASH, PRO] }))
  const ctx = await host(server.origin)
  await ctx.plugin(Account, { baseURL: server.baseURL })
  await expect(ctx.llm.resolveModelInfo('deepseek-account', 'deepseek-flash')).resolves.toMatchObject({
    name: 'DeepSeek-V4.1-Flash', context: { contextWindow: 1_048_576 }, defaultMaxTokens: 256_000,
    systemPromptUpdate: 'in-history', toolUpdate: 'addition-only', inputModalities: ['text', 'image'],
    reasoning: { defaultEffort: ReasoningEffortId('high') },
  })
  await expect(ctx.llm.resolveModelInfo('deepseek-account', 'deepseek-v4-pro')).resolves.not.toHaveProperty('systemPromptUpdate')
  expect(server.requests).toHaveLength(1)
  expect(server.requests[0]?.headers['user-agent']).toMatch(/^deepseek-harness\//)
})

it('advertises the badges its listing declares', async () => {
  const badge = { text: { en: 'New', zh: '新' }, tone: 'success' }
  const server = await listing(json({ data: [{ ...FLASH, client_metadata: { 'deepseek-harness': { badge } } }, PRO] }))
  const ctx = await host(server.origin)
  await ctx.plugin(Account, { baseURL: server.baseURL })
  expect((await ctx.llm.listModels('deepseek-account')).map(row => [row.id, row.badge])).toEqual([
    ['deepseek-flash', badge], ['deepseek-v4-pro', undefined],
  ])
})

it('publishes an account badge removal after the default idle refresh interval', async () => {
  let badge: { text: string } | undefined = { text: 'New' }
  const server = await listing((request, response) => {
    json({ data: [{ ...FLASH, client_metadata: { 'deepseek-harness': { badge } } }] })(request, response)
  })
  const ctx = await host(server.origin)
  const refreshed = Promise.withResolvers<undefined>()
  const changes: string[] = []
  ctx.on('llm/models-updated', (provider) => {
    changes.push(provider)
    if (changes.length === 2) refreshed.resolve(undefined)
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  try {
    await ctx.plugin(Account, { baseURL: server.baseURL })
    expect((await ctx.llm.listModels('deepseek-account'))[0]?.badge?.text).toBe('New')
    badge = undefined
    await vi.advanceTimersByTimeAsync(600_000)
    await refreshed.promise
    expect(changes).toEqual(['deepseek-account', 'deepseek-account'])
    expect((await ctx.llm.listModels('deepseek-account'))[0]).not.toHaveProperty('badge')
    expect(server.requests).toHaveLength(2)
  } finally {
    try { await ctx.fiber.dispose() }
    finally { vi.useRealTimers() }
  }
})

it('falls back to the bundled catalog when the listing fails', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const server = await listing((_request, response) => { response.writeHead(503).end('down') })
  const ctx = await host(server.origin)
  await ctx.plugin(Account, { baseURL: server.baseURL })
  expect((await ctx.llm.listModels('deepseek-account')).map(row => row.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
  expect(warn).toHaveBeenCalledExactlyOnceWith('[llm-deepseek-account]', expect.stringContaining('using the bundled catalog') as string)
  await expect(ctx.llm.resolveModelInfo('deepseek-account', 'deepseek-flash')).resolves.toMatchObject({ context: { contextWindow: 1_048_576 } })
})

it('hides and refuses listed models this build cannot serve before any inference request', async () => {
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const server = await listing(json({ data: [
    FLASH,
    { ...PRO, id: 'deepseek-v5' },
    { ...PRO, id: 'deepseek-v5-open', ...requires('0.0.1') },
    { ...PRO, id: 'deepseek-v5-next', ...requires('99.0.0-alpha.1') },
    { id: 'deepseek-v4-pro' },
  ] }))
  const ctx = await host(server.origin)
  await ctx.plugin(Account, { baseURL: server.baseURL })
  expect((await ctx.llm.listModels('deepseek-account')).map(row => row.id)).toEqual(['deepseek-flash', 'deepseek-v5-open'])
  await expect(ctx.llm.prepareCall({ provider: 'deepseek-account', model: 'deepseek-v5' })).rejects.toMatchObject({ code: 'MODEL_UNSUPPORTED' })
  await expect(ctx.llm.prepareCall({ provider: 'deepseek-account', model: 'deepseek-v4-pro' })).rejects.toMatchObject({ code: 'MODEL_UNSUPPORTED' })
  await expect(ctx.llm.prepareCall({ provider: 'deepseek-account', model: 'deepseek-v5-next' }))
    .rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED', message: expect.stringMatching(/requires DeepSeek Harness 99\.0\.0-alpha\.1 or later; current version is /) as string })
  await expect(ctx.llm.prepareCall({ provider: 'deepseek-account', model: 'unlisted-pass-through' })).resolves.toBeDefined()
  expect(server.requests.map(request => request.url)).toEqual(['/models'])
  expect(diagnostic).toHaveBeenCalledExactlyOnceWith('[llm-deepseek-account]', expect.stringContaining('loaded 5 model(s), skipped 0 row(s)') as string)
  expect(warn).toHaveBeenCalledExactlyOnceWith('[llm-deepseek-account]', 'model "deepseek-v4-pro" declares no api_capabilities.anthropic_messages')
})

it('applies model overrides and reports stale ones on the provider directory until they resolve', async () => {
  let token = 'first-account'
  const server = await listing((request, response) => {
    const rows = request.headers['x-dsh-auth-token'] === 'first-account' ? [FLASH] : [FLASH, { ...PRO, id: 'deepseek-v5', ...requires('0.0.1') }]
    json({ data: rows })(request, response)
  })
  const ctx = await host(server.origin, () => token)
  await ctx.plugin(Account, { baseURL: server.baseURL, modelOverrides: { 'deepseek-flash': { contextWindow: 524_288 }, 'deepseek-v5': { contextWindow: 9 } } })
  await ctx.llm.listModels('deepseek-account')
  await expect(ctx.llm.resolveModelInfo('deepseek-account', 'deepseek-flash')).resolves.toMatchObject({ context: { contextWindow: 524_288 } })
  expect(ctx.llm.listConfigurableProviders()[0]?.error).toContain('"deepseek-v5"')
  await ctx.llm.listModels('deepseek-account')
  expect(ctx.llm.listConfigurableProviders()[0]?.error).toContain('"deepseek-v5"')
  token = 'second-account'
  await ctx.llm.listModels('deepseek-account')
  expect(ctx.llm.listConfigurableProviders()[0]).not.toHaveProperty('error')
  await expect(ctx.llm.resolveModelInfo('deepseek-account', 'deepseek-v5')).resolves.toMatchObject({ context: { contextWindow: 9 } })
})

it('rejects the retired models setting at load', async () => {
  const ctx = await host('http://127.0.0.1:1')
  await expect(ctx.plugin(Account, { models: [] })).rejects.toThrow(/models is no longer configurable/)
  expect(ctx.llm.listProviders()).toEqual([])
})

it('aborts an in-flight listing request when the plugin is disposed', async () => {
  const held = Promise.withResolvers<IncomingMessage>()
  const server = await listing((request) => { held.resolve(request) })
  const ctx = await host(server.origin)
  const account = ctx.plugin(Account, { baseURL: server.baseURL })
  await account
  const pending = ctx.llm.listModels('deepseek-account')
  const request = await held.promise
  const closed = new Promise(resolve => request.socket.once('close', resolve))
  await account.dispose()
  await closed
  await expect(pending).resolves.toEqual(expect.any(Array))
})

it('keeps the full catalog discoverable while selection narrows advertised models', async () => {
  let unavailable = false
  const server = await listing((request, response) => {
    if (unavailable) response.writeHead(503).end('outage')
    else json({ data: [FLASH, PRO] })(request, response)
  })
  const ctx = await host(server.origin)
  const fiber = ctx.plugin(Account, { baseURL: server.baseURL, selectedModels: ['deepseek-flash'] })
  await fiber
  expect((await ctx.llm.listModels('deepseek-account')).map(model => model.id)).toEqual(['deepseek-flash'])
  const request = { provider: 'deepseek-account' }
  expect((await ctx.llm.discoverModels('llm-deepseek-account', request)).map(model => model.id))
    .toEqual(['deepseek-flash', 'deepseek-v4-pro'])
  expect(server.requests).toHaveLength(2)
  unavailable = true
  await expect(ctx.llm.discoverModels('llm-deepseek-account', request)).rejects.toMatchObject({ code: 'MODEL_LISTING_FAILED' })
  expect((await ctx.llm.listModels('deepseek-account')).map(model => model.id)).toEqual(['deepseek-flash'])
  for (const invalid of [{ provider: 'other' }, { ...request, baseURL: 'https://example.com' },
    { ...request, api: 'anthropic-messages' }, { ...request, apiKey: 'fixture-key' }]) {
    await expect(ctx.llm.discoverModels('llm-deepseek-account', invalid)).rejects.toMatchObject({ code: 'INVALID_DISCOVERY' })
  }
  await fiber.dispose()
  await expect(ctx.llm.discoverModels('llm-deepseek-account', request)).rejects.toMatchObject({ code: 'NO_DISCOVERY' })
})

it('keeps the provider registered with an empty selection', async () => {
  const server = await listing(json({ data: [FLASH, PRO] }))
  const ctx = await host(server.origin)
  await ctx.plugin(Account, { baseURL: server.baseURL, selectedModels: [] })
  expect(await ctx.llm.listModels('deepseek-account')).toEqual([])
  expect(ctx.llm.listProviders().some(provider => provider.id === 'deepseek-account')).toBe(true)
  expect((await ctx.llm.discoverModels('llm-deepseek-account', { provider: 'deepseek-account' })).map(model => model.id))
    .toEqual(['deepseek-flash', 'deepseek-v4-pro'])
})

it('publishes selection changes without changing the account or refetching its catalog', async () => {
  const server = await listing(json({ data: [FLASH, PRO] }))
  const ctx = await host(server.origin)
  const config = Account.Config({ baseURL: server.baseURL })
  // Retain the parsed references so the fixture can publish the loader's committed config update.
  const fiber = ctx.plugin({ inject: Account.inject, apply: (owner: Context) => { Account.apply(owner, config) } })
  await fiber
  await ctx.llm.listModels('deepseek-account')
  const changed = vi.fn()
  ctx.on('llm/models-updated', changed)
  updateVolatile(config.selectedModels, createVolatile<string[] | null>([]))
  fiber.ctx.emit('loader/volatile-update', [['selectedModels']])
  expect(await ctx.llm.listModels('deepseek-account')).toEqual([])
  expect(changed).toHaveBeenCalledExactlyOnceWith('deepseek-account')
  fiber.ctx.emit('loader/volatile-update', [])
  expect(changed).toHaveBeenCalledTimes(1)
  updateVolatile(config.selectedModels, createVolatile<string[] | null>(['deepseek-v4-pro']))
  fiber.ctx.emit('loader/volatile-update', [['selectedModels']])
  expect((await ctx.llm.listModels('deepseek-account')).map(model => model.id)).toEqual(['deepseek-v4-pro'])
  expect(server.requests).toHaveLength(1)
})

it('rejects discovery before sign-in and when the credential changes during its request', async () => {
  let token: string | undefined
  const server = await listing((request, response) => {
    token = 'replacement-token'
    json({ data: [FLASH, PRO] })(request, response)
  })
  const ctx = await host(server.origin, () => token)
  await ctx.plugin(Account, { baseURL: server.baseURL })
  const discover = () => ctx.llm.discoverModels('llm-deepseek-account', { provider: 'deepseek-account' })
  await expect(discover()).rejects.toMatchObject({ code: 'ACCOUNT_SIGN_IN_REQUIRED' })
  expect(server.requests).toHaveLength(0)
  token = 'first-token'
  await expect(discover()).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' })
})

it('does not fetch models when sign-out interrupts discovery preflight', async () => {
  const server = await listing(json({ data: [FLASH, PRO] }))
  let lookups = 0
  const ctx = await host(server.origin, () => ++lookups === 1 ? 'old-token' : undefined)
  await ctx.plugin(Account, { baseURL: server.baseURL })
  await expect(ctx.llm.discoverModels('llm-deepseek-account', { provider: 'deepseek-account' }))
    .rejects.toMatchObject({ code: 'ACCOUNT_SIGN_IN_REQUIRED' })
  expect(server.requests).toHaveLength(0)
})
