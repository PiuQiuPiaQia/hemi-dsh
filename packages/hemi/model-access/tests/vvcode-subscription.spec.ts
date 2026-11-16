/** VVCode subscription lifecycle over the real Loader, ConfigEditor, Settings, credentials, authorization, and LLM composition. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { initProfile, mountRootInclude, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import LlmRuntime, { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import type { Api, Model, ModelThinkingLevel } from '@earendil-works/pi-ai'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import type { PeerId, RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import HemiModelAccess from '../src/index.ts'
import { importedCatalogModel } from '../src/model-catalog.ts'
import { VVCODE_KEY } from '../src/vvcode/index.ts'
import { vvcodeProviderId } from '../src/vvcode/adapter.ts'
import { asObject } from '../src/response.ts'
import type { Subscription, VvcodeDirectory, VvcodeGroupView, VvcodeModelSelection } from '../src/types.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** Test-only non-owner caller used by this spec. */
    'vvcode-spec-guest': { readonly kind: 'vvcode-spec-guest' }
  }
}

const VVCODE_ORIGIN = 'https://cf.vvcode.top'
const PAT = 'nap_vvcode_spec_pat_0001'

/** Request facts one mocked VVCode call carried. */
interface WireCall {
  method: string
  pathname: string
  authorization: string | undefined
  /** Anthropic-protocol key header, carried beside (not instead of) `authorization`. */
  apiKeyHeader: string | undefined
  appId: string | undefined
  redirect: string | undefined
  query: URLSearchParams
  body: unknown
  signal: AbortSignal | undefined
}

/** One token record the mocked site stores; `expired_time: -1` means never expires. */
interface StoredToken {
  id: number
  user_id: number
  name: string
  group: string
  status: number
  expired_time: number
}

/** One `/v1/models` entry: the id plus the wire endpoint types the site declares. */
interface CatalogEntry {
  id: string
  supported_endpoint_types?: string[]
}

/** Application-prefixed token names; the real site hides them from list and search responses. */
const EXCLUSIVE_NAME_PREFIX = 'hemi-dsh-'

/** A minimal complete text generation in chat-completions SSE shape. */
const CHAT_COMPLETIONS_SSE = [
  '{"choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"content":"hello"},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
  '[DONE]',
]

/** A minimal complete text generation in Anthropic Messages SSE shape. */
const ANTHROPIC_MESSAGES_SSE = [
  '{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"vv-beta","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
  '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
  '{"type":"content_block_stop","index":0}',
  '{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
  '{"type":"message_stop"}',
]

/** A minimal complete text generation in OpenAI Responses SSE shape. */
const OPENAI_RESPONSES_SSE = [
  '{"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}',
  '{"type":"response.output_item.added","output_index":0,"item":{"type":"message","role":"assistant","id":"msg_1"}}',
  '{"type":"response.output_text.delta","output_index":0,"item_id":"msg_1","delta":"hello"}',
  '{"type":"response.output_text.done","output_index":0,"item_id":"msg_1","text":"hello"}',
  '{"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","status":"completed","content":[{"type":"output_text","text":"hello","annotations":[]}]}}',
  '{"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[{"type":"message","id":"msg_1","role":"assistant","status":"completed","content":[{"type":"output_text","text":"hello","annotations":[]}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
]

/**
 * Local VVCode stand-in behind `globalThis.fetch`. Every vvcode-origin request is
 * recorded and answered from scripted state; any other origin falls through to
 * the real fetch, which nothing in this composition should trigger.
 */
class VvcodeSite {
  readonly calls: WireCall[] = []
  /** Origins a request tried to reach besides the configured one, recorded before the refusal. */
  readonly crossOriginAttempts: string[] = []
  groups: Record<string, { ratio: number | 'auto'; desc: string }> = {}
  /** Advertised catalog per group, served to that group token's revealed key. */
  catalogByGroup: Record<string, CatalogEntry[]> = {}
  /** Read-only directory model IDs per group, served to `GET /api/user/models?group=` reads. */
  modelsByGroup: Record<string, string[]> = {}
  /** Per-group status refusal for the read-only model directory read. */
  failModels: Record<string, number> = {}
  tokens: StoredToken[] = []
  keys = new Map<number, string>()
  nextTokenId = 77
  /** Public display configuration served anonymously by `/api/status`. */
  status: Record<string, unknown> = {
    quota_per_unit: 500000,
    quota_display_type: 'USD',
    usd_exchange_rate: 7.3,
    custom_currency_symbol: '¤',
    custom_currency_exchange_rate: 2,
  }
  /** Wallet balance merged into `/api/user/self`; unset keeps the group-flow fixture without quota. */
  selfQuota?: number
  /** Subscription summaries served by `/api/subscription/self`. */
  subscriptions: Record<string, unknown>[] = []
  /** When set, `/api/user/self` answers 401 without a body payload. */
  failSelfWith401 = false
  /** When set, `/api/subscription/self` answers with this status. */
  subscriptionSelfStatus?: number
  /** When set, `/api/desktop/groups` answers with this status. */
  failGroupsWith?: number
  /** `no-id` mimics a creation whose success response carries no verifiable id. */
  createOutcome: 'id' | 'no-id' = 'id'
  /** When set, the creation POST answers 401 without recording a token. */
  failCreateWith401 = false
  /** When set, token detail reads answer 401. */
  failTokenDetailWith401 = false
  /** When set, the chat-completions endpoint answers with a redirect to this location. */
  redirectChatCompletionsTo?: string
  private readonly arrivals = new Map<string, PromiseWithResolvers<undefined>[]>()
  private readonly held = new Map<string, PromiseWithResolvers<Response>>()

  /** Resolves once a request for `pathname` has been received. */
  arrived(pathname: string): Promise<void> {
    const gate = Promise.withResolvers<undefined>()
    const list = this.arrivals.get(pathname) ?? []
    list.push(gate)
    this.arrivals.set(pathname, list)
    return gate.promise
  }

  /** Hold the response for `pathname`; it resolves via `resolve` or rejects when the request aborts. */
  hold(pathname: string): PromiseWithResolvers<Response> {
    const held = Promise.withResolvers<Response>()
    this.held.set(pathname, held)
    return held
  }

  /** Take a held response back out, so later requests for `pathname` answer normally again. */
  release(pathname: string): PromiseWithResolvers<Response> | undefined {
    const held = this.held.get(pathname)
    this.held.delete(pathname)
    return held
  }

  async handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin !== VVCODE_ORIGIN) {
      this.crossOriginAttempts.push(url.href)
      throw new Error(`vvcode-subscription.spec mock refuses the non-VVCode origin ${url.origin}`)
    }
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const call: WireCall = {
      method: (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(),
      pathname: url.pathname,
      authorization: headers.get('authorization') ?? undefined,
      apiKeyHeader: headers.get('x-api-key') ?? undefined,
      appId: headers.get('x-ai-app') ?? undefined,
      redirect: init?.redirect ?? (input instanceof Request ? input.redirect : undefined),
      query: url.searchParams,
      body: parseBody(init?.body ?? (input instanceof Request ? await input.clone().text() : undefined)),
      signal: init?.signal ?? (input instanceof Request ? input.signal : undefined),
    }
    this.calls.push(call)
    for (const gate of this.arrivals.get(url.pathname) ?? []) gate.resolve(undefined)
    const held = this.held.get(url.pathname)
    if (held !== undefined) {
      call.signal?.addEventListener('abort', () => { held.reject(call.signal?.reason) }, { once: true })
      return held.promise
    }
    return this.respond(call)
  }

  private respond(call: WireCall): Response {
    const { method, pathname } = call
    if (pathname === '/api/desktop/groups') {
      if (this.failGroupsWith !== undefined) return this.envelope({ success: false, message: 'spec: groups read failed' }, this.failGroupsWith)
      return this.envelope({ success: true, data: this.groups })
    }
    if (pathname === '/api/user/models') {
      const group = call.query.get('group') ?? ''
      const failing = this.failModels[group]
      if (failing !== undefined) return this.envelope({ success: false, message: 'spec: models read failed' }, failing)
      return this.envelope({ success: true, data: this.modelsByGroup[group] ?? [] })
    }
    if (pathname === '/api/status') return this.envelope({ success: true, data: this.status })
    if (pathname === '/api/user/self') {
      if (this.failSelfWith401) return this.envelope({ success: false, message: 'spec: PAT no longer authorized' }, 401)
      return this.envelope({ success: true, data: {
        id: 1, username: 'spec-user', ...this.selfQuota === undefined ? {} : { quota: this.selfQuota },
      } })
    }
    if (pathname === '/api/subscription/self') {
      if (this.subscriptionSelfStatus !== undefined) {
        return this.envelope({ success: false, message: 'spec: subscription read refused' }, this.subscriptionSelfStatus)
      }
      return this.envelope({ success: true, data: {
        billing_preference: 'subscription_first',
        subscriptions: this.subscriptions,
        all_subscriptions: [],
      } })
    }
    if (pathname === '/api/token/' && method === 'POST') {
      if (this.failCreateWith401) return this.envelope({ success: false, message: 'spec: PAT no longer authorized' }, 401)
      const name = typeof asObject(call.body)?.name === 'string' ? String(asObject(call.body)?.name) : ''
      const group = typeof asObject(call.body)?.group === 'string' ? String(asObject(call.body)?.group) : ''
      // A server-side creation consumes an id even when the response omits it; only a refusal consumes nothing.
      const id = this.nextTokenId
      this.nextTokenId += 1
      this.tokens.push({ id, user_id: 1, name, group, status: 1, expired_time: -1 })
      // Production reveals a bare key; the client normalizes it onto relay requests with the `sk-` prefix.
      this.keys.set(id, `vv-model-key-${String(id).padStart(4, '0')}`)
      return this.envelope(this.createOutcome === 'id' ? { success: true, data: { id } } : { success: true, data: {} })
    }
    if (pathname === '/api/token/' && method === 'GET') {
      return this.envelope({ success: true, data: { items: this.visibleTokens(), total: this.visibleTokens().length } })
    }
    if (pathname === '/api/token/search') {
      const keyword = call.query.get('keyword') ?? ''
      const items = this.visibleTokens().filter(token => token.name.includes(keyword))
      return this.envelope({ success: true, data: { items } })
    }
    const detail = /^\/api\/token\/(\d+)$/.exec(pathname)
    if (detail !== null && method === 'GET') {
      if (this.failTokenDetailWith401) return this.envelope({ success: false, message: 'spec: PAT no longer authorized' }, 401)
      const token = this.tokens.find(candidate => candidate.id === Number(detail[1]))
      return token === undefined
        ? this.envelope({ success: false, message: 'spec mock has no such token' }, 404)
        : this.envelope({ success: true, data: token })
    }
    const key = /^\/api\/token\/(\d+)\/key$/.exec(pathname)
    if (key !== null && method === 'POST') {
      const stored = this.keys.get(Number(key[1]))
      return stored === undefined
        ? this.envelope({ success: false, message: 'spec mock has no key for this token' }, 404)
        : this.envelope({ success: true, data: { key: stored } })
    }
    if (pathname === '/v1/models') {
      const group = this.groupForKey(call.authorization, call.apiKeyHeader)
      const entries = group === undefined ? [] : this.catalogByGroup[group] ?? []
      return new Response(JSON.stringify({ object: 'list', data: entries }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    if (pathname === '/v1/chat/completions' && method === 'POST') {
      if (this.redirectChatCompletionsTo !== undefined) {
        return new Response(null, { status: 302, headers: { location: this.redirectChatCompletionsTo } })
      }
      return this.sse(CHAT_COMPLETIONS_SSE)
    }
    if (pathname === '/v1/messages' && method === 'POST') return this.sse(ANTHROPIC_MESSAGES_SSE)
    if (pathname === '/v1/responses' && method === 'POST') return this.sse(OPENAI_RESPONSES_SSE)
    return this.envelope({ success: false, message: `vvcode-subscription.spec mock has no handler for ${method} ${pathname}` }, 400)
  }

  /** Application-exclusive tokens never appear in list or search responses. */
  private visibleTokens(): StoredToken[] {
    return this.tokens.filter(token => !token.name.startsWith(EXCLUSIVE_NAME_PREFIX))
  }

  /** The group whose token key authenticates this request, or undefined for an unknown key. */
  private groupForKey(authorization: string | undefined, apiKeyHeader: string | undefined): string | undefined {
    const presented = authorization ?? apiKeyHeader
    if (presented === undefined) return undefined
    for (const [id, key] of this.keys) {
      if (presented === `Bearer sk-${key}` || presented === `sk-${key}`) {
        return this.tokens.find(token => token.id === id)?.group
      }
    }
    return undefined
  }

  /** One management envelope; the protocol requires an explicit `success` flag and `message` string. */
  private envelope(value: Record<string, unknown>, status = 200): Response {
    return new Response(JSON.stringify({ message: '', ...value }), { status, headers: { 'content-type': 'application/json' } })
  }

  private sse(events: string[]): Response {
    const encoder = new TextEncoder()
    const body = new ReadableStream({
      start: (controller) => {
        for (const event of events) {
          // The Anthropic SDK dispatches by the SSE event name; the JSON `type` names the same event.
          if (event === '[DONE]') { controller.enqueue(encoder.encode('data: [DONE]\n\n')); continue }
          const parsed: unknown = JSON.parse(event)
          const name = typeof parsed === 'object' && parsed !== null && 'type' in parsed
            && typeof parsed.type === 'string' ? parsed.type : 'message'
          controller.enqueue(encoder.encode(`event: ${name}\ndata: ${event}\n\n`))
        }
        controller.close()
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
}

function parseBody(body: unknown): unknown {
  if (typeof body !== 'string' || body === '') return undefined
  try { return JSON.parse(body) } catch { return body }
}

let site: VvcodeSite | undefined
const originalFetch = globalThis.fetch

beforeEach(() => {
  site = undefined
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => (
    site === undefined ? originalFetch(input, init) : site.handle(input, init)
  ))
})

const contexts: Context[] = []
const homes: string[] = []

afterEach(async () => {
  site = undefined
  vi.unstubAllGlobals()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

interface Host {
  ctx: Context
  service: HemiModelAccess
}

/** One profile whose pi-ai section stores the supplied providers and whose patch layer seeds subscription state. */
function createProfile(
  providers: Record<string, unknown>,
  subscriptionModels: Record<string, string[]> = {},
  vvcodeConnection?: Record<string, unknown>,
  vvcodeConnections?: Record<string, Record<string, unknown>>,
  subscriptionModelOptions?: Record<string, Record<string, unknown>>,
): {
  profile: ProfileContext
} {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-hemi-vvcode-')))
  homes.push(home)
  const dir = join(home, 'profile')
  initProfile(dir, ['test-vvcode-subscription-bundle'])
  const bundle = join(dir, 'node_modules', 'test-vvcode-subscription-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({
    name: 'test-vvcode-subscription-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'llm-pi-ai', name: 'cordis:llm-pi-ai', config: {} },
    { id: 'hemi-model-access', name: 'cordis:hemi-model-access', config: {} },
  ] }]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  // Subscription selections live in the user patch layer, as the subscription's own writes do.
  // The legacy connection key is omitted entirely by default, as every existing installation's patch does.
  const connectionLines = vvcodeConnection === undefined ? [] : [
    `    vvcodeConnection: ${JSON.stringify(vvcodeConnection)}`,
  ]
  const connectionsLines = vvcodeConnections === undefined ? [] : [
    `    vvcodeConnections: ${JSON.stringify(vvcodeConnections)}`,
  ]
  const optionsLines = subscriptionModelOptions === undefined ? [] : [
    `    subscriptionModelOptions: ${JSON.stringify(subscriptionModelOptions)}`,
  ]
  writeFileSync(join(dir, 'cordis.patch.yml'), [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    ...Object.entries(providers).flatMap(([id, profile]) => [
      `      ${id}:`,
      ...Object.entries(profile as Record<string, unknown>).map(([key, value]) =>
        `        ${key}: ${JSON.stringify(value)}`),
    ]),
    '- id: hemi-model-access',
    '  config:',
    ...connectionLines,
    ...connectionsLines,
    ...optionsLines,
    '    subscriptionModels:',
    ...Object.entries(subscriptionModels).map(([id, models]) => `      ${id}: ${JSON.stringify(models)}`),
    '',
  ].join('\n'))
  const profile: ProfileContext = {
    name: 'test', startedBundles: ['test-vvcode-subscription-bundle'], dir,
    patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'),
    cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  return { profile }
}

/** Boot the profile with a real Loader, ConfigEditor, Settings, credential store, and authorization service. */
async function startHost(
  providers: Record<string, unknown> = {},
  subscriptionModels: Record<string, string[]> = {},
  vvcodeConnection?: Record<string, unknown>,
  vvcodeConnections?: Record<string, Record<string, unknown>>,
  subscriptionModelOptions?: Record<string, Record<string, unknown>>,
): Promise<Host> {
  const { profile } = createProfile(providers, subscriptionModels, vvcodeConnection, vvcodeConnections, subscriptionModelOptions)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LocalCredentialProvider, { path: join(profile.home, '.credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService)
  ctx.baseUrl = pathToFileURL(profile.home).href + '/'
  ctx.provide('profileContext', profile)
  await ctx.plugin(Loader)
  ctx.loader.builtins['llm-pi-ai'] = LlmPiAi
  ctx.loader.builtins['hemi-model-access'] = HemiModelAccess
  await ctx.plugin(ConfigEditor)
  await ctx.plugin(Settings)
  await mountRootInclude(ctx, join(profile.dir, 'cordis.yml'), readProfilePatches('test', profile))
  await ctx.loader.await()
  const service = ctx.get('hemiModelAccess')
  if (service === undefined) throw new Error('the loaded composition did not publish hemiModelAccess')
  return { ctx, service }
}

/** The configured values of the hemi-model-access settings namespace. */
function modelAccessConfig(ctx: Context): Record<string, unknown> {
  const section = ctx.settings.describe().find(item => item.ns === 'hemi-model-access')
  if (section === undefined) throw new Error('hemi model-access settings are unavailable')
  return asObject(section.value) ?? {}
}

function storedConnection(ctx: Context): Record<string, unknown> | undefined {
  return asObject(modelAccessConfig(ctx).vvcodeConnection)
}

/** The saved per-group bindings, keyed by group name. */
function storedConnections(ctx: Context): Record<string, unknown> {
  return asObject(modelAccessConfig(ctx).vvcodeConnections) ?? {}
}

function storedGroup(ctx: Context, group: string): Record<string, unknown> {
  const record = asObject(storedConnections(ctx)[group])
  if (record === undefined) throw new Error(`no saved vvcode connection for ${group}`)
  return record
}

function storedSelections(ctx: Context): Record<string, unknown> {
  return asObject(modelAccessConfig(ctx).subscriptionModels) ?? {}
}

function storedModelOptions(ctx: Context): Record<string, unknown> {
  return asObject(modelAccessConfig(ctx).subscriptionModelOptions) ?? {}
}

/** The stored `providers` map of the pi-ai settings namespace. */
function storedProviders(ctx: Context): Record<string, unknown> {
  const section = ctx.settings.describe().find(item => item.ns === 'llm-pi-ai')
  if (section === undefined) throw new Error('pi-ai settings are unavailable')
  return asObject(asObject(section.value)?.providers) ?? {}
}

/** The stored credential payload of the subscription's own grant key. */
async function storedGrant(ctx: Context): Promise<Record<string, unknown> | undefined> {
  const record = await ctx.credentials.readRecord(VVCODE_KEY)
  return record?.kind === 'grant' ? asObject(record.payload) : undefined
}

/** A valid saved grant payload, as a completed login commits it. */
function grantPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1, origin: VVCODE_ORIGIN, accessToken: PAT, userId: 1,
    expiresAt: Date.now() + 60 * 60 * 1000,
    scopes: ['profile:read', 'api_key:read', 'api_key:write', 'api_key:reveal'],
    ...overrides,
  }
}

async function seedGrant(ctx: Context, overrides: Record<string, unknown> = {}): Promise<void> {
  await ctx.credentials.modifyRecord(VVCODE_KEY, () => Promise.resolve({ kind: 'grant' as const, payload: grantPayload(overrides) }))
}

/** Rewrite the stored grant's expiry into the past, as an elapsed PAT does. */
async function expireGrant(ctx: Context): Promise<void> {
  const stored = await storedGrant(ctx)
  if (stored === undefined) throw new Error('no grant to expire')
  await ctx.credentials.modifyRecord(VVCODE_KEY, () => Promise.resolve({
    kind: 'grant' as const, payload: { ...stored, expiresAt: Date.now() - 1000 },
  }))
}

/** Persist a per-group pending creation record exactly as the subscription does before dispatching one. */
async function savePending(ctx: Context, group: string, pending: Record<string, unknown> | undefined): Promise<void> {
  const stored = await storedGrant(ctx)
  if (stored === undefined) throw new Error('no grant to attach pending to')
  const map = asObject(stored.pending) ?? {}
  const nextPending = pending === undefined
    ? Object.fromEntries(Object.entries(map).filter(([name]) => name !== group))
    : { ...map, [group]: pending }
  const next = { ...stored, version: 2, pending: nextPending }
  await ctx.credentials.modifyRecord(VVCODE_KEY, () => Promise.resolve({ kind: 'grant' as const, payload: next }))
}

/** Endpoint types the VVCode transport serves; catalog entries without one bind no model. */
const SERVED_ENDPOINTS = ['openai', 'anthropic', 'openai-response']

/** The catalog model IDs whose site-declared endpoint the transport serves. */
function servedModels(catalog: CatalogEntry[]): string[] {
  return catalog.filter(entry => entry.supported_endpoint_types?.some(api => SERVED_ENDPOINTS.includes(api)) ?? false)
    .map(entry => entry.id)
}

/**
 * The installed openai-responses reasoning model whose exact effort levels a gateway model inherits.
 * The id must resolve unambiguously across the whole installed catalog and spell every mapped
 * level as its own level id, so both served protocols inherit the exact published offer.
 */
function catalogReasoningModel(): Model<Api> {
  const entry = getBuiltinModels('openai').find(model => model.reasoning && model.thinkingLevelMap !== undefined
    && model.api === 'openai-responses'
    && importedCatalogModel('openai-responses', model.id) === model
    && importedCatalogModel('openai-completions', model.id) !== undefined
    && Object.entries(model.thinkingLevelMap).every(([level, wire]) => wire === null || wire === level))
  if (entry === undefined) throw new Error('the installed catalog ships no unambiguous openai-responses reasoning model')
  return entry
}

/** The internal level ids one catalog model offers, mirroring pi-ai's dispatch support rule. */
function offeredLevels(model: Model<Api>): ModelThinkingLevel[] {
  return (['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const).filter((level) => {
    const wire = model.thinkingLevelMap?.[level]
    if (wire === null) return false
    return level === 'xhigh' || level === 'max' ? wire !== undefined : true
  })
}

/** Script the site so `group` is authorized, its token key advertises `catalog`, and its read-only directory lists the same IDs. */
function scriptGroup(site: VvcodeSite, group: string, catalog: CatalogEntry[]): void {
  site.groups[group] = { ratio: group === 'auto-group' ? 'auto' : 1, desc: `${group} description` }
  site.catalogByGroup[group] = catalog
  site.modelsByGroup[group] = catalog.map(entry => entry.id)
}

/**
 * Seed a valid grant, script the group, and bind it through the owner-only save: the enable
 * prepares the group's key exactly once, then a local save clears the selection again, leaving
 * the bound-but-unselected state the old sync flow produced.
 */
async function connectGroup(host: Host, group: string, catalog: CatalogEntry[]): Promise<void> {
  scriptGroup(site!, group, catalog)
  await seedGrant(host.ctx)
  const provider = providerOf(group)
  await host.service.saveVvcodeModels([{ provider, models: servedModels(catalog) }], new AbortController().signal)
  await host.service.saveVvcodeModels([{ provider, models: [] }], new AbortController().signal)
}

/** The stable provider route a synchronized group owns. */
function providerOf(group: string, legacy = false): string {
  return legacy ? 'vvcode' : vvcodeProviderId(VVCODE_ORIGIN, 1, group)
}

/** Every mocked request must carry the app marker, a nap_ PAT on management paths, and only sk- keys on relay paths. */
function expectWireRoles(): void {
  const current = site!
  expect(current.calls.length).toBeGreaterThan(0)
  for (const call of current.calls) {
    expect(call.appId).toBe('hemi-dsh')
    expect(call.redirect).toBe('error')
    if (call.pathname === '/api/status') {
      // The public display configuration is read anonymously and must never carry the PAT.
      expect(call.authorization).toBeUndefined()
    } else if (call.pathname === '/v1/messages') {
      expect(call.apiKeyHeader).toMatch(/^sk-/)
      expect(call.authorization).toBeUndefined()
    } else if (call.pathname.startsWith('/v1/')) {
      expect(call.authorization).toMatch(/^Bearer sk-/)
      expect(call.apiKeyHeader).toBeUndefined()
    } else {
      expect(call.authorization).toMatch(/^Bearer nap_[A-Za-z0-9_-]+$/)
    }
  }
}

/** One active subscription summary row, active around the current time unless overridden. */
function subscriptionSummary(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const nowSeconds = Math.floor(Date.now() / 1000)
  return { subscription: {
    id, user_id: 1, plan_id: 5, amount_total: 2500000, amount_used: 400000,
    status: 'active', start_time: nowSeconds - 60, end_time: nowSeconds + 3600, next_reset_time: 0,
    ...overrides,
  } }
}

/** The four scopes every VVCode grant carries; the wallet scope is appended by usage tests. */
const BASE_SCOPES = ['profile:read', 'api_key:read', 'api_key:write', 'api_key:reveal']

function createCalls(): WireCall[] {
  return site!.calls.filter(call => call.pathname === '/api/token/' && call.method === 'POST')
}

/** The subscription's typed entry from `subscriptions()`, which also lists other providers' registered flows. */
function vvcodeEntry(subscriptions: Subscription[]): Subscription {
  const entry = subscriptions.find(candidate => candidate.id === 'vvcode')
  if (entry === undefined) throw new Error('the vvcode subscription is missing from subscriptions()')
  return entry
}

/** The connection metadata block of one subscription entry. */
function vvcodeMetadata(entry: Subscription): NonNullable<Subscription['vvcode']> {
  if (entry.vvcode === undefined) throw new Error('the vvcode subscription carries no connection metadata')
  return entry.vvcode
}

/** The vvcode model ids one provider route currently publishes. */
async function publishedModels(host: Host, provider: string): Promise<string[]> {
  return (await host.ctx.llm.listModels(provider)).map(model => model.id)
}

/** The vvcode model display names one provider route currently publishes. */
async function publishedNames(host: Host, provider: string): Promise<string[]> {
  return (await host.ctx.llm.listModels(provider)).map(model => model.name)
}

/** Collect one model stream to completion. */
async function collectStream(host: Host, provider: string, model: string): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of host.ctx.llm.stream({ provider, model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) {
    chunks.push(chunk)
  }
  return chunks
}

/** Expect one model stream to end in the runtime's error finish carrying `code`, without throwing. */
async function expectStreamFailure(host: Host, provider: string, model: string, code: string): Promise<void> {
  const chunks = await collectStream(host, provider, model)
  expect(chunks[chunks.length - 1]).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code } } })
}

/** Read the directory through the owner-only remote and pick one group row. */
async function directoryRow(host: Host, name: string): Promise<{ directory: VvcodeDirectory; row: VvcodeGroupView }> {
  const directory = await host.service.vvcodeDirectory(new AbortController().signal)
  const row = directory.groups.find(group => group.name === name)
  if (row === undefined) throw new Error(`the directory has no ${name} row`)
  return { directory, row }
}

const PRO_CATALOG: CatalogEntry[] = [
  { id: 'vv-alpha', supported_endpoint_types: ['openai'] },
  { id: 'vv-beta', supported_endpoint_types: ['anthropic'] },
  { id: 'vv-gamma', supported_endpoint_types: ['openai-response'] },
  { id: 'vv-delta' },
]

describe('vvcode subscription composition', () => {
  it('activates beside existing manual VVCode routes and leaves their model settings and keys owned by pi-ai', async () => {
    const ids = ['vvcode', 'vvcode-group-empty-0', 'vvcode-group-user-route']
    const providers = Object.fromEntries(ids.map((id, index) => [id, {
      displayName: `Manual ${id}`, api: 'openai-completions', baseURL: `${VVCODE_ORIGIN}/v1`,
      apiKeyEnv: `MANUAL_VVCODE_${index}_API_KEY`, models: [{ id: 'manual-model' }],
    }]))
    const host = await startHost(providers)
    for (const [index, id] of ids.entries()) {
      await host.ctx.credentials.set(credentialRef(`MANUAL_VVCODE_${index}_API_KEY`), `sk-manual-route-${index}`)
      expect((await host.ctx.llm.listModels(id)).map(model => model.id)).toEqual(['manual-model'])
      const options = await host.service.getModelOptions(id, 'manual-model')
      await host.service.saveModelOptions(id, 'manual-model', { name: `Edited ${id}`, contextWindow: 32000 }, options.revision)
      expect(await host.service.getModelOptions(id, 'manual-model')).toMatchObject({
        options: { name: `Edited ${id}`, contextWindow: 32000 },
      })
    }
    expect((await host.service.subscriptions()).find(row => row.id === 'vvcode')).toMatchObject({ connected: false })
    expect(host.service.state()).toBeNull()
    expect((await host.service.keyDirectory()).profiles.map(profile => profile.id)).toEqual(ids)
    const before = storedProviders(host.ctx)
    expect(storedModelOptions(host.ctx)).toEqual({})
    await host.service.disconnect('vvcode')
    expect(storedProviders(host.ctx)).toEqual(before)
    for (const [index, id] of ids.entries()) {
      expect((await host.ctx.llm.listModels(id)).map(model => model.id)).toEqual(['manual-model'])
      expect(await host.ctx.credentials.resolve(credentialRef(`MANUAL_VVCODE_${index}_API_KEY`)))
        .toMatchObject({ value: `sk-manual-route-${index}` })
    }
  })

  it('reports the subscription disconnected until its own grant key holds a payload', async () => {
    // The patch omits `vvcodeConnection` entirely, as every existing installation does before a first sync.
    const host = await startHost()
    expect(storedConnection(host.ctx)).toBeUndefined()
    const flow = host.ctx.authorization.describe(credentialKey('hemi-model-access', 'vvcode'))
    expect(flow).toMatchObject({ label: 'VVCode', methods: [{ id: 'oauth', label: 'VVCode' }] })

    const before = await host.service.subscriptions()
    const entry = vvcodeEntry(before)
    expect(entry).toEqual({ id: 'vvcode', name: 'VVCode', connected: false, quota: false, models: [] })
    expect('vvcode' in entry).toBe(false)
    const signedOut = await host.service.vvcodeDirectory(new AbortController().signal)
    expect(signedOut).toEqual({ state: 'sign-in-required', groups: [] })
    expect(await storedGrant(host.ctx)).toBeUndefined()

    await seedGrant(host.ctx, { userId: 7, expiresAt: Date.now() + 1000 })

    const seededEntry = vvcodeEntry(await host.service.subscriptions())
    expect(seededEntry).toMatchObject({
      id: 'vvcode', name: 'VVCode', connected: true, quota: false, models: [],
      vvcode: { expired: false },
    })
    expect(vvcodeMetadata(seededEntry).expiresAt).toBeGreaterThan(Date.now() - 60_000)
    expect(await storedGrant(host.ctx)).toMatchObject(grantPayload({ userId: 7, expiresAt: expect.any(Number) }))
  })

  it('lists the read-only directory without creating keys and binds a group only through its save', async () => {
    site = new VvcodeSite()
    const host = await startHost()
    scriptGroup(site, 'pro-group', PRO_CATALOG)
    scriptGroup(site, 'auto-group', [])
    await seedGrant(host.ctx)

    const directory = await host.service.vvcodeDirectory(new AbortController().signal)
    expect(directory.state).toBe('ready')
    expect(directory.groups).toEqual([
      { name: 'auto-group', desc: 'auto-group description', ratio: 'auto', provider: providerOf('auto-group'),
        state: 'not-synced', hasConnection: false, catalogError: false, models: [] },
      { name: 'pro-group', desc: 'pro-group description', ratio: 1, provider: providerOf('pro-group'),
        state: 'not-synced', hasConnection: false, catalogError: false,
        models: [
          { id: 'vv-alpha', enabled: false }, { id: 'vv-beta', enabled: false },
          { id: 'vv-delta', enabled: false }, { id: 'vv-gamma', enabled: false },
        ] },
    ])
    // Browsing never created a key or reached the relay: only the two read-only GET kinds ran.
    expect(createCalls()).toEqual([])
    expect(site.calls.some(call => call.pathname.startsWith('/v1/'))).toBe(false)
    await expect(host.service.syncVvcodeGroup('ghost-group', new AbortController().signal))
      .rejects.toMatchObject({ code: 'hemi/vvcode-failed', details: { reason: 'group-unavailable' } })
    expect(storedConnections(host.ctx)).toEqual({})
    expect(createCalls()).toEqual([])

    await host.service.saveVvcodeModels(
      [{ provider: providerOf('pro-group'), models: ['vv-alpha', 'vv-beta', 'vv-gamma'] }], new AbortController().signal)

    const record = storedGroup(host.ctx, 'pro-group')
    const tokenId = site.tokens[0]?.id
    expect(tokenId).toBe(77)
    const apiKeyRef = String(record.apiKeyRef)
    expect(apiKeyRef).toMatch(/^VVCODE_[0-9A-Fa-f]{64}_API_KEY$/)
    expect(record).toEqual({
      origin: VVCODE_ORIGIN, group: 'pro-group', userId: '1', tokenId,
      apiKeyRef, provider: providerOf('pro-group'),
      models: [
        { id: 'vv-alpha', api: 'openai-completions' },
        { id: 'vv-beta', api: 'anthropic-messages' },
        { id: 'vv-gamma', api: 'openai-responses' },
      ],
      selected: ['vv-alpha', 'vv-beta', 'vv-gamma'], ratio: 1, desc: 'pro-group description', revoked: false,
    })
    // The legacy single-group keys are cleared once the per-group collection owns the binding.
    expect(storedConnection(host.ctx)).toBeUndefined()
    expect(storedSelections(host.ctx).vvcode).toBeUndefined()
    expect(await host.ctx.credentials.resolve(credentialRef(apiKeyRef)))
      .toMatchObject({ value: `sk-vv-model-key-${String(tokenId).padStart(4, '0')}` })
    const entry = vvcodeEntry(await host.service.subscriptions())
    expect(entry).toMatchObject({
      id: 'vvcode', name: 'VVCode', connected: true, quota: false, models: [],
      vvcode: { expired: false },
    })
    expect(vvcodeMetadata(entry).expiresAt).toBeGreaterThan(Date.now() - 60_000)
    expect(await publishedModels(host, providerOf('pro-group'))).toEqual(['vv-alpha', 'vv-gamma', 'vv-beta'])
    // The binding verified its token by id, never through the list or search endpoints that hide exclusive tokens.
    expect(site.calls.some(call => call.pathname === `/api/token/${String(tokenId)}` && call.method === 'GET')).toBe(true)
    expectWireRoles()
  })

  it('publishes only explicitly selected models and keeps the PAT off inference', async () => {
    site = new VvcodeSite()
    const host = await startHost()
    await connectGroup(host, 'pro-group', PRO_CATALOG)
    const provider = providerOf('pro-group')
    expect(await publishedModels(host, provider)).toEqual([])

    await host.service.changeSubscriptionModel(provider, 'vv-alpha', true)

    expect(storedGroup(host.ctx, 'pro-group').selected).toEqual(['vv-alpha'])
    expect(await publishedModels(host, provider)).toEqual(['vv-alpha'])
    // The published model names carry exactly one group label so pickers can tell same-named models apart.
    expect(await publishedNames(host, provider)).toEqual(['vv-alpha · pro-group'])

    const chunks = await collectStream(host, provider, 'vv-alpha')

    expect(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'hello')).toBe(true)
    expect(chunks[chunks.length - 1]).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    const request = site.calls.find(call => call.pathname === '/v1/chat/completions')
    expect(request).toMatchObject({ method: 'POST', authorization: 'Bearer sk-vv-model-key-0077', appId: 'hemi-dsh', redirect: 'error' })
    expectWireRoles()

    await host.service.changeSubscriptionModel(provider, 'vv-alpha', false)

    expect(storedGroup(host.ctx, 'pro-group').selected).toEqual([])
    expect(await publishedModels(host, provider)).toEqual([])
  })

  it('routes the same model of two groups through each group key under distinct providers', async () => {
    site = new VvcodeSite()
    const host = await startHost()
    const shared: CatalogEntry[] = [{ id: 'vv-shared', supported_endpoint_types: ['openai'] }]
    await connectGroup(host, 'pro-group', [...PRO_CATALOG.filter(entry => entry.id === 'vv-alpha'), ...shared])
    await connectGroup(host, 'auto-group', [...shared, { id: 'vv-auto', supported_endpoint_types: ['openai'] }])
    const legacyless = providerOf('pro-group')
    const autoProvider = providerOf('auto-group')
    expect(legacyless).not.toBe('vvcode')
    expect(autoProvider).not.toBe(legacyless)

    await host.service.changeSubscriptionModel(legacyless, 'vv-shared', true)
    await host.service.changeSubscriptionModel(autoProvider, 'vv-shared', true)

    expect(await publishedModels(host, legacyless)).toEqual(['vv-shared'])
    expect(await publishedModels(host, autoProvider)).toEqual(['vv-shared'])
    expect(await publishedNames(host, legacyless)).toEqual(['vv-shared · pro-group'])
    expect(await publishedNames(host, autoProvider)).toEqual(['vv-shared · auto-group'])

    const first = await collectStream(host, legacyless, 'vv-shared')
    expect(first[first.length - 1]).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    const second = await collectStream(host, autoProvider, 'vv-shared')
    expect(second[second.length - 1]).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })

    // Each route resolved its own group token: the pro token is 77, the auto token is 78.
    const relay = site.calls.filter(call => call.pathname === '/v1/chat/completions')
    expect(relay.map(call => call.authorization)).toEqual(['Bearer sk-vv-model-key-0077', 'Bearer sk-vv-model-key-0078'])
    expect(await host.ctx.credentials.resolve(credentialRef(String(storedGroup(host.ctx, 'pro-group').apiKeyRef))))
      .toMatchObject({ value: 'sk-vv-model-key-0077' })
    expect(await host.ctx.credentials.resolve(credentialRef(String(storedGroup(host.ctx, 'auto-group').apiKeyRef))))
      .toMatchObject({ value: 'sk-vv-model-key-0078' })
    expectWireRoles()
  })

  it('serves three site-declared protocols through their own transports and endpoints', async () => {
    site = new VvcodeSite()
    const host = await startHost()
    await connectGroup(host, 'pro-group', PRO_CATALOG.filter(entry => entry.id !== 'vv-delta'))
    const provider = providerOf('pro-group')
    for (const model of ['vv-alpha', 'vv-beta', 'vv-gamma']) {
      await host.service.changeSubscriptionModel(provider, model, true)
    }
    expect(await publishedModels(host, provider)).toEqual(['vv-alpha', 'vv-gamma', 'vv-beta'])

    const chat = await collectStream(host, provider, 'vv-alpha')
    const anthropic = await collectStream(host, provider, 'vv-beta')
    const responses = await collectStream(host, provider, 'vv-gamma')
    for (const chunks of [chat, anthropic, responses]) {
      expect(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'hello')).toBe(true)
      expect(chunks[chunks.length - 1]).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    }
    expect(site.calls.filter(call => call.pathname === '/v1/chat/completions')).toHaveLength(1)
    expect(site.calls.filter(call => call.pathname === '/v1/messages')).toHaveLength(1)
    expect(site.calls.filter(call => call.pathname === '/v1/responses')).toHaveLength(1)
    // Every protocol carried the same group key and never the management PAT.
    expect(site.calls.filter(call => call.pathname.startsWith('/v1/')).every(call =>
      (call.authorization ?? `Bearer ${call.apiKeyHeader}`) === 'Bearer sk-vv-model-key-0077')).toBe(true)
    expectWireRoles()
  })

  it('publishes a catalog-known group model with its exact effort levels and sends only supported chosen ones', async () => {
    site = new VvcodeSite()
    const host = await startHost()
    const referenced = catalogReasoningModel()
    await connectGroup(host, 'pro-group', [{ id: referenced.id, supported_endpoint_types: ['openai'] }])
    await connectGroup(host, 'auto-group', [{ id: referenced.id, supported_endpoint_types: ['openai-response'] }])
    const chatProvider = providerOf('pro-group')
    const responsesProvider = providerOf('auto-group')
    await host.service.changeSubscriptionModel(chatProvider, referenced.id, true)
    await host.service.changeSubscriptionModel(responsesProvider, referenced.id, true)

    const levels = offeredLevels(referenced)
    for (const provider of [chatProvider, responsesProvider]) {
      expect((await host.ctx.llm.resolveModelInfo(provider, referenced.id)).reasoning?.efforts.map(effort => effort.id))
        .toEqual(levels)
    }

    const streamWithEffort = async (provider: string, effort?: string): Promise<StreamChunk[]> => {
      const chunks: StreamChunk[] = []
      for await (const chunk of host.ctx.llm.stream({ provider, model: referenced.id,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        ...effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) },
      })) { chunks.push(chunk) }
      return chunks
    }
    // A supported chosen level dispatches its catalog wire spelling, and a referenced model with
    // no configured default sends none, exactly like its native catalog route.
    const chosen = levels.includes('high') ? 'high' : levels[levels.length - 1]!
    const chosenWire = referenced.thinkingLevelMap?.[chosen]
    const chatChunks = await streamWithEffort(chatProvider, chosen)
    expect(chatChunks[chatChunks.length - 1]).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    const noEffortChunks = await streamWithEffort(chatProvider)
    expect(noEffortChunks[noEffortChunks.length - 1]).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    const chatBodies = site.calls.filter(call => call.pathname === '/v1/chat/completions')
      .map(call => asObject(call.body))
    expect(chatBodies.map(body => body?.reasoning_effort)).toEqual([chosenWire, undefined])

    // A level the catalog model does not publish is refused before any request.
    const unsupported = (['off', 'xhigh', 'max', 'minimal'] as const).find(level => !levels.includes(level))
    if (unsupported === undefined) throw new Error('the fixture catalog offers every thinking level')
    const sent = site.calls.filter(call => call.pathname === '/v1/chat/completions').length
    const refused = await streamWithEffort(chatProvider, unsupported)
    expect(refused[refused.length - 1]).toMatchObject({ type: 'finish',
      reason: { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT' } } })
    expect(site.calls.filter(call => call.pathname === '/v1/chat/completions')).toHaveLength(sent)

    const responsesChunks = await streamWithEffort(responsesProvider, chosen)
    expect(responsesChunks[responsesChunks.length - 1]).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    const responsesBodies = site.calls.filter(call => call.pathname === '/v1/responses')
      .map(call => asObject(call.body))
    expect(responsesBodies.map(body => asObject(body?.reasoning)?.effort)).toEqual([chosenWire])

    // Each group served its own model key, never the management PAT.
    expect(site.calls.filter(call => call.pathname.startsWith('/v1/')).every(call =>
      call.authorization === 'Bearer sk-vv-model-key-0077' || call.authorization === 'Bearer sk-vv-model-key-0078'))
      .toBe(true)
    expectWireRoles()
  })

  it('sends the deployment default effort for unknown group models on the published route', async () => {
    site = new VvcodeSite()
    const host = await startHost()
    await connectGroup(host, 'pro-group', [PRO_CATALOG[0]!])
    const provider = providerOf('pro-group')
    await host.service.changeSubscriptionModel(provider, 'vv-alpha', true)

    const info = await host.ctx.llm.resolveModelInfo(provider, 'vv-alpha')
    expect(info.reasoning?.defaultEffort).toBe('medium')
    for await (const _chunk of host.ctx.llm.stream({ provider, model: 'vv-alpha',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) { /* scripted answer */ }
    const bodies = site.calls.filter(call => call.pathname === '/v1/chat/completions')
      .map(call => asObject(call.body))
    expect(bodies.map(body => body?.reasoning_effort)).toEqual(['medium'])
    expectWireRoles()
  })

  it('keeps groups and selections but refuses inference and additions while the grant is expired', async () => {
    site = new VvcodeSite()
    const host = await startHost()
    await connectGroup(host, 'pro-group', PRO_CATALOG)
    const provider = providerOf('pro-group')
    await host.service.changeSubscriptionModel(provider, 'vv-alpha', true)
    const relayCallsBefore = site.calls.filter(call => call.pathname.startsWith('/v1/')).length
    await expireGrant(host.ctx)

    const expiredEntry = vvcodeEntry(await host.service.subscriptions())
    expect(expiredEntry).toMatchObject({
      id: 'vvcode', name: 'VVCode', connected: true, quota: false, models: [],
      vvcode: { expired: true },
    })
    expect(vvcodeMetadata(expiredEntry).expiresAt).toBeLessThanOrEqual(Date.now())
    // The expired directory retains the saved rows, selections included, for local edits only.
    const { directory, row } = await directoryRow(host, 'pro-group')
    expect(directory.state).toBe('sign-in-required')
    expect(row).toEqual({
      name: 'pro-group', desc: 'pro-group description', ratio: 1, provider,
      state: 'ready', hasConnection: true, catalogError: false,
      models: [{ id: 'vv-alpha', enabled: true }, { id: 'vv-beta', enabled: false }, { id: 'vv-gamma', enabled: false }],
    })
    expect(await publishedModels(host, provider)).toEqual([])
    await expectStreamFailure(host, provider, 'vv-alpha', 'MISSING_CREDENTIAL')
    await expect(host.service.changeSubscriptionModel(provider, 'vv-beta', true))
      .rejects.toMatchObject({ code: 'hemi/vvcode-failed', details: { reason: 'sign-in-required' } })
    expect(site.calls.filter(call => call.pathname.startsWith('/v1/'))).toHaveLength(relayCallsBefore)

    // Removal stays available while the account authorization is expired.
    await host.service.changeSubscriptionModel(provider, 'vv-alpha', false)

    expect(storedGroup(host.ctx, 'pro-group').selected).toEqual([])
    expect(storedGroup(host.ctx, 'pro-group')).toMatchObject({ group: 'pro-group' })
    expectWireRoles()
  })

  it('restores inference after a same-account re-sign-in and refuses a changed account', async () => {
    site = new VvcodeSite()
    const host = await startHost()
    await connectGroup(host, 'pro-group', PRO_CATALOG)
    const provider = providerOf('pro-group')
    await host.service.changeSubscriptionModel(provider, 'vv-alpha', true)
    await expireGrant(host.ctx)

    // A completed re-sign-in commits a fresh grant for the same account; selections and the group binding survive.
    await seedGrant(host.ctx, { accessToken: 'nap_vvcode_spec_pat_0002' })

    const restoredEntry = vvcodeEntry(await host.service.subscriptions())
    expect(restoredEntry).toMatchObject({
      id: 'vvcode', name: 'VVCode', connected: true, quota: false, models: [],
      vvcode: { expired: false },
    })
    expect(vvcodeMetadata(restoredEntry).expiresAt).toBeGreaterThan(Date.now())
    expect(await publishedModels(host, provider)).toEqual(['vv-alpha'])
    const chunks = await collectStream(host, provider, 'vv-alpha')
    expect(chunks[chunks.length - 1]).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })

    await seedGrant(host.ctx, { accessToken: 'nap_vvcode_spec_pat_0003', userId: 2 })

    expect(await publishedModels(host, provider)).toEqual([])
    await expectStreamFailure(host, provider, 'vv-alpha', 'MISSING_CREDENTIAL')
    expect(storedGroup(host.ctx, 'pro-group')).toMatchObject({ group: 'pro-group', userId: '1' })
  })

  it('never resends an unobserved creation, recovers it by the persisted token id, and keeps other groups intact', async () => {
    site = new VvcodeSite()
    const host = await startHost()
    await connectGroup(host, 'pro-group', PRO_CATALOG)
    const provider = providerOf('pro-group')
    await host.service.changeSubscriptionModel(provider, 'vv-alpha', true)
    const proRef = String(storedGroup(host.ctx, 'pro-group').apiKeyRef)
    scriptGroup(site, 'auto-group', [{ id: 'vv-gamma', supported_endpoint_types: ['openai-response'] }])

    // The creation response arrives without an id, so the outcome stays unobserved; the pending name is recorded for that group.
    site.createOutcome = 'no-id'
    await expect(host.service.saveVvcodeModels(
      [{ provider: providerOf('auto-group'), models: ['vv-gamma'] }], new AbortController().signal))
      .rejects.toMatchObject({ code: 'hemi/vvcode-request-failed' })
    expect(createCalls()).toHaveLength(2)
    const pendingEntry = asObject(asObject((await storedGrant(host.ctx))?.pending)?.['auto-group'])
    const anyName: unknown = expect.any(String)
    expect(pendingEntry).toMatchObject({ name: anyName })
    expect(pendingEntry?.tokenId).toBeUndefined()
    expect(storedGroup(host.ctx, 'pro-group')).toMatchObject({ group: 'pro-group' })
    expect(await host.ctx.credentials.resolve(credentialRef(proRef))).toBeDefined()
    expect(storedGroup(host.ctx, 'pro-group').selected).toEqual(['vv-alpha'])

    // The directory reports exactly the unknown group; the healthy group stays ready and usable.
    const { row, directory } = await directoryRow(host, 'auto-group')
    expect(directory.state).toBe('ready')
    expect(row).toMatchObject({ state: 'creation-unknown', hasConnection: false, catalogError: false })
    expect(row.models).toEqual([{ id: 'vv-gamma', enabled: false }])
    expect((await directoryRow(host, 'pro-group')).row.state).toBe('ready')
    const chunks = await collectStream(host, provider, 'vv-alpha')
    expect(chunks[chunks.length - 1]).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })

    // The retry re-checks the exact pending name; the site hides exclusive tokens, so the outcome stays unknown.
    await expect(host.service.saveVvcodeModels(
      [{ provider: providerOf('auto-group'), models: ['vv-gamma'] }], new AbortController().signal))
      .rejects.toMatchObject({ code: 'hemi/vvcode-failed', details: { reason: 'creation-unknown' } })
    expect(createCalls()).toHaveLength(2)
    expect(storedGroup(host.ctx, 'pro-group')).toMatchObject({ group: 'pro-group' })

    // Once the creation id is known (as the subscription persists it), the retry recovers without a second creation.
    const pendingName = String(asObject(asObject((await storedGrant(host.ctx))?.pending)?.['auto-group'])?.name)
    const recoveredId = site.tokens.find(token => token.name === pendingName)?.id
    expect(recoveredId).toBe(78)
    await savePending(host.ctx, 'auto-group', { name: pendingName, tokenId: recoveredId })
    site.createOutcome = 'id'

    await host.service.saveVvcodeModels(
      [{ provider: providerOf('auto-group'), models: ['vv-gamma'] }], new AbortController().signal)

    expect(createCalls()).toHaveLength(2)
    expect(storedGroup(host.ctx, 'auto-group')).toMatchObject({
      origin: VVCODE_ORIGIN, group: 'auto-group', userId: '1', tokenId: 78, provider: providerOf('auto-group'),
    })
    const autoRef = String(storedGroup(host.ctx, 'auto-group').apiKeyRef)
    expect(autoRef).not.toBe(proRef)
    expect(await host.ctx.credentials.resolve(credentialRef(autoRef)))
      .toMatchObject({ value: 'sk-vv-model-key-0078' })
    expect(await host.ctx.credentials.resolve(credentialRef(proRef))).toBeDefined()
    // The unknown group's recovery left the healthy group's selection untouched.
    expect(storedGroup(host.ctx, 'pro-group').selected).toEqual(['vv-alpha'])

    // A 401 on the first creation clears only that group's pending record and expires the account until a renewed sign-in.
    scriptGroup(site, 'extra-group', [{ id: 'vv-extra', supported_endpoint_types: ['openai'] }])
    site.failCreateWith401 = true
    await expect(host.service.saveVvcodeModels(
      [{ provider: providerOf('extra-group'), models: ['vv-extra'] }], new AbortController().signal))
      .rejects.toMatchObject({ code: 'hemi/vvcode-token-refused', details: { status: 401 } })
    const refusedGrant = await storedGrant(host.ctx)
    expect(asObject(refusedGrant?.pending)).toEqual({})
    expect(refusedGrant).toMatchObject({ invalidated: true })
    expect(vvcodeMetadata(vvcodeEntry(await host.service.subscriptions())).expired).toBe(true)
    site.failCreateWith401 = false

    // A renewed same-account sign-in clears the expiry, so the retry creates afresh instead of cycling on stale pending.
    await seedGrant(host.ctx, { accessToken: 'nap_vvcode_spec_pat_0004' })
    await host.service.saveVvcodeModels(
      [{ provider: providerOf('extra-group'), models: ['vv-extra'] }], new AbortController().signal)
    expect(storedGroup(host.ctx, 'extra-group')).toMatchObject({ origin: VVCODE_ORIGIN, group: 'extra-group' })
    expect(storedGroup(host.ctx, 'pro-group')).toMatchObject({ group: 'pro-group', tokenId: 77 })

    // A 401 while verifying a known pending token keeps the per-group record for the renewed sign-in.
    const extraTokenId = Number(storedGroup(host.ctx, 'extra-group').tokenId)
    scriptGroup(site, 'resume-group', [{ id: 'vv-resume', supported_endpoint_types: ['openai'] }])
    await savePending(host.ctx, 'resume-group', { name: 'hemi-dsh-spec-kept', tokenId: extraTokenId })
    site.failTokenDetailWith401 = true
    await expect(host.service.saveVvcodeModels(
      [{ provider: providerOf('resume-group'), models: ['vv-resume'] }], new AbortController().signal))
      .rejects.toMatchObject({ code: 'hemi/vvcode-management-auth-expired' })
    const keptGrant = await storedGrant(host.ctx)
    expect(asObject(asObject(keptGrant?.pending)?.['resume-group'])).toEqual({ name: 'hemi-dsh-spec-kept', tokenId: extraTokenId })
    expect(asObject(keptGrant?.pending)?.['auto-group']).toBeUndefined()
    expect(keptGrant).toMatchObject({ invalidated: true })
    expectWireRoles()
  })

  it('adopts the legacy binding on the next local edit without network and keeps serving before it', async () => {
    site = new VvcodeSite()
    const legacyRef = 'VVCODE_LEGACY_API_KEY'
    const host = await startHost({}, { vvcode: ['vv-alpha', 'vv-beta'] }, {
      origin: VVCODE_ORIGIN, group: 'pro-group', userId: '1', tokenId: 77, apiKeyRef: legacyRef,
      models: [{ id: 'vv-alpha', api: 'openai-completions' }, { id: 'vv-beta', api: 'anthropic-messages' }],
    }, undefined, { vvcode: { 'vv-alpha': { name: 'Legacy Alpha', contextWindow: 4096 } } })
    scriptGroup(site, 'pro-group', PRO_CATALOG)
    await seedGrant(host.ctx)
    await host.ctx.credentials.set(credentialRef(legacyRef), 'sk-vv-model-key-0077')

    // The adopted view serves the legacy route before any migration write happens.
    const provider = providerOf('pro-group', true)
    expect(provider).toBe('vvcode')
    expect(await host.service.subscriptionModels('vvcode', new AbortController().signal)).toEqual(['vv-alpha', 'vv-beta'])
    expect(await publishedModels(host, provider)).toEqual(['vv-alpha', 'vv-beta'])
    const chunks = await collectStream(host, provider, 'vv-alpha')
    expect(chunks[chunks.length - 1]).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })

    // A local removal migrates the legacy binding atomically: same route, key reference and selection; no request at all.
    const callsBefore = site.calls.length
    await host.service.changeSubscriptionModel(provider, 'vv-beta', false)

    expect(site.calls.slice(callsBefore)).toEqual([])
    expect(createCalls()).toHaveLength(0)
    const record = storedGroup(host.ctx, 'pro-group')
    expect(record).toMatchObject({
      origin: VVCODE_ORIGIN, group: 'pro-group', userId: '1', tokenId: 77,
      apiKeyRef: legacyRef, provider: 'vvcode', selected: ['vv-alpha'],
    })
    expect(record.models).toEqual([
      { id: 'vv-alpha', api: 'openai-completions' }, { id: 'vv-beta', api: 'anthropic-messages' },
    ])
    expect('ratio' in record).toBe(false)
    expect(storedConnection(host.ctx)).toBeUndefined()
    expect(storedSelections(host.ctx).vvcode).toBeUndefined()
    // The legacy overrides live under the unchanged provider id and stay untouched.
    expect(storedModelOptions(host.ctx).vvcode).toMatchObject({ 'vv-alpha': { name: 'Legacy Alpha', contextWindow: 4096 } })
    expect(await host.ctx.credentials.resolve(credentialRef(legacyRef))).toMatchObject({ value: 'sk-vv-model-key-0077' })
    expect(await publishedModels(host, provider)).toEqual(['vv-alpha'])
    expectWireRoles()
  })

  it('retains the legacy binding and selection when the migration write fails, and migrates on retry', async () => {
    site = new VvcodeSite()
    const legacyRef = 'VVCODE_LEGACY_API_KEY'
    const host = await startHost({}, { vvcode: ['vv-alpha'] }, {
      origin: VVCODE_ORIGIN, group: 'pro-group', userId: '1', tokenId: 77, apiKeyRef: legacyRef,
      models: [{ id: 'vv-alpha', api: 'openai-completions' }],
    })
    scriptGroup(site, 'pro-group', PRO_CATALOG)
    await seedGrant(host.ctx)
    await host.ctx.credentials.set(credentialRef(legacyRef), 'sk-vv-model-key-0077')
    const settings = host.ctx.settings
    const originalMutate = settings.mutate.bind(settings)
    let failing = true
    Object.defineProperty(settings, 'mutate', {
      configurable: true,
      value: (...args: Parameters<typeof originalMutate>) => {
        if (failing) return Promise.reject(new Error('spec: settings write refused'))
        return originalMutate(...args)
      },
    })
    const provider = providerOf('pro-group', true)

    await expect(host.service.changeSubscriptionModel(provider, 'vv-alpha', false))
      .rejects.toThrow('spec: settings write refused')

    // Nothing was lost: the legacy fields and selection stay, and the adopted view still serves.
    expect(storedConnection(host.ctx)).toMatchObject({ group: 'pro-group' })
    expect(storedSelections(host.ctx).vvcode).toEqual(['vv-alpha'])
    expect(storedConnections(host.ctx)).toEqual({})
    expect(await host.service.subscriptionModels('vvcode', new AbortController().signal)).toEqual(['vv-alpha'])
    const chunks = await collectStream(host, provider, 'vv-alpha')
    expect(chunks[chunks.length - 1]).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })

    failing = false
    await host.service.changeSubscriptionModel(provider, 'vv-alpha', false)

    expect(storedGroup(host.ctx, 'pro-group')).toMatchObject({
      group: 'pro-group', apiKeyRef: legacyRef, provider: 'vvcode', selected: [],
    })
    expect(storedConnection(host.ctx)).toBeUndefined()
    expect(storedSelections(host.ctx).vvcode).toBeUndefined()
    expectWireRoles()
  })

  it('marks a group revoked when the live list drops it, keeps its data, and restores it when the list names it again', async () => {
    site = new VvcodeSite()
    const host = await startHost()
    await connectGroup(host, 'pro-group', PRO_CATALOG)
    await connectGroup(host, 'auto-group', [{ id: 'vv-shared', supported_endpoint_types: ['openai'] }])
    const pro = providerOf('pro-group')
    const auto = providerOf('auto-group')
    await host.service.changeSubscriptionModel(pro, 'vv-alpha', true)
    await host.service.changeSubscriptionModel(auto, 'vv-shared', true)

    // The account loses the auto group server-side; the next directory read confirms the loss.
    delete site.groups['auto-group']
    const { directory, row } = await directoryRow(host, 'auto-group')
    expect(directory.state).toBe('ready')
    expect(row.state).toBe('unavailable')
    expect(row.models).toEqual([{ id: 'vv-shared', enabled: true }])
    expect(storedGroup(host.ctx, 'auto-group').revoked).toBe(true)
    expect(storedGroup(host.ctx, 'auto-group').selected).toEqual(['vv-shared'])
    expect(await host.ctx.credentials.resolve(credentialRef(String(storedGroup(host.ctx, 'auto-group').apiKeyRef)))).toBeDefined()
    expect((await directoryRow(host, 'pro-group')).row.state).toBe('ready')
    // The revoked route stops publishing and refuses requests instead of silently serving.
    await expect(host.ctx.llm.listModels(auto)).rejects.toMatchObject({ code: 'NO_ADAPTER' })
    await expectStreamFailure(host, auto, 'vv-shared', 'NO_ADAPTER')
    const proChunks = await collectStream(host, pro, 'vv-alpha')
    expect(proChunks[proChunks.length - 1]).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })

    // A sync attempt against the lost group re-verifies live authorization first and never creates a token.
    const createsBefore = createCalls().length
    await expect(host.service.syncVvcodeGroup('auto-group', new AbortController().signal))
      .rejects.toMatchObject({ code: 'hemi/vvcode-failed', details: { reason: 'group-unavailable' } })
    expect(createCalls()).toHaveLength(createsBefore)

    // The group returns on the server: the next directory read restores it, route included.
    scriptGroup(site, 'auto-group', [{ id: 'vv-shared', supported_endpoint_types: ['openai'] }])
    const restored = await directoryRow(host, 'auto-group')
    expect(restored.directory.state).toBe('ready')
    expect(restored.row.state).toBe('ready')
    expect(storedGroup(host.ctx, 'auto-group').revoked).toBe(false)
    expect(await publishedModels(host, auto)).toEqual(['vv-shared'])
    const autoChunks = await collectStream(host, auto, 'vv-shared')
    expect(autoChunks[autoChunks.length - 1]).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expectWireRoles()
  })

  it('reports a failed live read as unavailable without clearing any saved group data', async () => {
    site = new VvcodeSite()
    const host = await startHost()
    await connectGroup(host, 'pro-group', PRO_CATALOG)
    await connectGroup(host, 'auto-group', [{ id: 'vv-shared', supported_endpoint_types: ['openai'] }])
    const pro = providerOf('pro-group')
    const auto = providerOf('auto-group')
    await host.service.changeSubscriptionModel(pro, 'vv-alpha', true)
    await host.service.changeSubscriptionModel(auto, 'vv-shared', true)
    const proRecord = { ...storedGroup(host.ctx, 'pro-group') }
    const grantBefore = await storedGrant(host.ctx)

    site.failGroupsWith = 500
    const directory = await host.service.vvcodeDirectory(new AbortController().signal)

    expect(directory.state).toBe('unavailable')
    expect(directory.groups.map(group => [group.name, group.state])).toEqual([['auto-group', 'ready'], ['pro-group', 'ready']])
    expect(storedGroup(host.ctx, 'pro-group')).toEqual(proRecord)
    expect(await storedGrant(host.ctx)).toEqual(grantBefore)
    // Serving continues on the last published routes; nothing was cleared by the failed read.
    expect(await publishedModels(host, pro)).toEqual(['vv-alpha'])
    expect(await publishedModels(host, auto)).toEqual(['vv-shared'])
    const chunks = await collectStream(host, auto, 'vv-shared')
    expect(chunks[chunks.length - 1]).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expectWireRoles()
  })

  it('disconnect clears every owned group binding and credential but keeps manual API connections', async () => {
    site = new VvcodeSite()
    const host = await startHost({ 'openai-codex': { models: [{ id: 'gpt-6.1-sol' }], apiKeyEnv: 'OPENAI_API_KEY' } })
    await connectGroup(host, 'pro-group', PRO_CATALOG)
    await connectGroup(host, 'auto-group', [{ id: 'vv-shared', supported_endpoint_types: ['openai'] }])
    const pro = providerOf('pro-group')
    const auto = providerOf('auto-group')
    await host.service.changeSubscriptionModel(pro, 'vv-alpha', true)
    const disconnectRevision = host.ctx.settings.describe().find(item => item.ns === 'hemi-model-access')?.revision ?? 0
    await host.service.saveModelOptions(pro, 'vv-alpha', { name: 'Alpha' }, disconnectRevision)
    const proRef = String(storedGroup(host.ctx, 'pro-group').apiKeyRef)
    const autoRef = String(storedGroup(host.ctx, 'auto-group').apiKeyRef)

    await host.service.disconnect('vvcode')

    expect(storedConnections(host.ctx)).toEqual({})
    expect(storedConnection(host.ctx)).toBeUndefined()
    expect(storedSelections(host.ctx).vvcode).toBeUndefined()
    expect(storedModelOptions(host.ctx)[pro]).toBeUndefined()
    expect(storedModelOptions(host.ctx)[auto]).toBeUndefined()
    expect(await storedGrant(host.ctx)).toBeUndefined()
    expect(await host.ctx.credentials.resolve(credentialRef(proRef))).toBeUndefined()
    expect(await host.ctx.credentials.resolve(credentialRef(autoRef))).toBeUndefined()
    expect(vvcodeEntry(await host.service.subscriptions())).toEqual({
      id: 'vvcode', name: 'VVCode', connected: false, quota: false, models: [],
    })
    await expect(host.ctx.llm.listModels(pro)).rejects.toMatchObject({ code: 'NO_ADAPTER' })
    await expect(host.ctx.llm.listModels(auto)).rejects.toMatchObject({ code: 'NO_ADAPTER' })
    expect(Object.keys(storedProviders(host.ctx))).toEqual(['openai-codex'])
    expectWireRoles()
  })

  it('keeps a connection bound to another site from serving model requests', async () => {
    site = new VvcodeSite()
    const host = await startHost({}, { vvcode: ['vv-alpha'] }, {
      origin: 'https://other.example', group: 'pro-group', userId: '1', tokenId: 5,
      apiKeyRef: 'VVCODE_STALE_API_KEY', models: [{ id: 'vv-alpha', api: 'openai-completions' }],
    })
    await seedGrant(host.ctx)

    const staleEntry = vvcodeEntry(await host.service.subscriptions())
    expect(staleEntry).toMatchObject({
      id: 'vvcode', name: 'VVCode', connected: true, quota: false, models: [],
      // A connection bound to another site reads as expired, so its selections never serve requests.
      vvcode: { expired: true },
    })
    expect(vvcodeMetadata(staleEntry).expiresAt).toBeGreaterThan(Date.now())
    // The saved selections stay visible, but inference refuses before any request leaves for either origin.
    expect(await publishedModels(host, 'vvcode')).toEqual([])
    await expectStreamFailure(host, 'vvcode', 'vv-alpha', 'MISSING_CREDENTIAL')
    expect(site.calls).toEqual([])
  })

  it('refuses to follow a relay redirect away from the configured origin', async () => {
    site = new VvcodeSite()
    const host = await startHost()
    await connectGroup(host, 'pro-group', PRO_CATALOG)
    const provider = providerOf('pro-group')
    await host.service.changeSubscriptionModel(provider, 'vv-alpha', true)
    site.redirectChatCompletionsTo = 'https://other.example/v1/chat/completions'

    // redirect: 'error' makes the transport refuse the redirect; the request never reaches the other origin.
    const chunks = await collectStream(host, provider, 'vv-alpha')

    expect(chunks[chunks.length - 1]).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
    expect(site.calls.filter(call => call.pathname === '/v1/chat/completions')).toHaveLength(1)
    expect(site.crossOriginAttempts).toEqual([])
  })

  it('aborts an in-flight group save on disposal without committing its key', async () => {
    site = new VvcodeSite()
    const host = await startHost()
    scriptGroup(site, 'pro-group', PRO_CATALOG)
    await seedGrant(host.ctx)
    const credentials = host.ctx.credentials
    const settings = host.ctx.settings

    // A pre-aborted call rejects without wedging the busy flag: save, selection and disconnect still run.
    const preaborted = new AbortController()
    preaborted.abort()
    await expect(host.service.saveVvcodeModels(
      [{ provider: providerOf('auto-group'), models: ['vv-gamma'] }], preaborted.signal))
      .rejects.toMatchObject({ name: 'AbortError' })
    await host.service.saveVvcodeModels(
      [{ provider: providerOf('pro-group'), models: ['vv-alpha'] }], new AbortController().signal)
    await host.service.disconnect('vvcode')
    await seedGrant(host.ctx)
    await host.service.saveVvcodeModels(
      [{ provider: providerOf('pro-group'), models: ['vv-alpha'] }], new AbortController().signal)

    const mutations: unknown[][] = []
    const originalMutate = settings.mutate.bind(settings)
    Object.defineProperty(settings, 'mutate', {
      configurable: true,
      value: (...args: Parameters<typeof originalMutate>) => {
        mutations.push(args)
        return originalMutate(...args)
      },
    })
    scriptGroup(site, 'auto-group', [{ id: 'vv-gamma', supported_endpoint_types: ['openai-response'] }])
    const heldTokenId = site.nextTokenId
    site.hold(`/api/token/${String(heldTokenId)}/key`)
    const sync = host.service.saveVvcodeModels(
      [{ provider: providerOf('auto-group'), models: ['vv-gamma'] }], new AbortController().signal)
    await site.arrived(`/api/token/${String(heldTokenId)}/key`)
    let rejected = false
    void sync.catch(() => { rejected = true })

    const disposed = host.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(host.ctx), 1)
    await disposed
    // The drain completed before disposal returned, so the aborted operation has already rejected.
    expect(rejected).toBe(true)
    await expect(sync).rejects.toMatchObject({ name: 'AbortError' })

    const abortedRef = `VVCODE_${createHash('sha256').update(JSON.stringify([VVCODE_ORIGIN, 1, heldTokenId])).digest('hex').toUpperCase()}_API_KEY`
    expect(await credentials.resolve(credentialRef(abortedRef))).toBeUndefined()
    expect(mutations).toEqual([])
  })

  it('settles disposal only after an admitted commit releases and leaves recoverable state', async () => {
    site = new VvcodeSite()
    const host = await startHost()
    scriptGroup(site, 'pro-group', PRO_CATALOG)
    await seedGrant(host.ctx)
    await host.service.saveVvcodeModels(
      [{ provider: providerOf('pro-group'), models: ['vv-alpha'] }], new AbortController().signal)
    const proRef = String(storedGroup(host.ctx, 'pro-group').apiKeyRef)
    const credentials = host.ctx.credentials
    const settings = host.ctx.settings
    const mutations: unknown[][] = []
    const originalMutate = settings.mutate.bind(settings)
    Object.defineProperty(settings, 'mutate', {
      configurable: true,
      value: (...args: Parameters<typeof originalMutate>) => {
        mutations.push(args)
        return originalMutate(...args)
      },
    })
    scriptGroup(site, 'auto-group', [{ id: 'vv-gamma', supported_endpoint_types: ['openai-response'] }])
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let committed = false
    const originalSet = credentials.set.bind(credentials)
    Object.defineProperty(credentials, 'set', {
      configurable: true,
      value: async (...args: Parameters<typeof originalSet>) => {
        entered.resolve(undefined)
        await release.promise
        await originalSet(...args)
        committed = true
      },
    })
    const sync = host.service.saveVvcodeModels(
      [{ provider: providerOf('auto-group'), models: ['vv-gamma'] }], new AbortController().signal)
    await entered.promise
    let disposeSettled = false
    const disposed = host.ctx.fiber.dispose().then(() => { disposeSettled = true })
    contexts.splice(contexts.indexOf(host.ctx), 1)

    // The held commit outlives the disposal request: disposal settles only after it completes.
    release.resolve(undefined)
    await disposed
    expect(committed).toBe(true)
    expect(disposeSettled).toBe(true)
    await expect(sync).rejects.toMatchObject({ name: 'AbortError' })

    // The abort after admission cleans the new key up; the prior binding stays recoverable.
    const newRef = `VVCODE_${createHash('sha256').update(JSON.stringify([VVCODE_ORIGIN, 1, 78])).digest('hex').toUpperCase()}_API_KEY`
    expect(await credentials.resolve(credentialRef(newRef))).toBeUndefined()
    expect(await credentials.resolve(credentialRef(proRef))).toBeDefined()
    expect(mutations).toEqual([])
  })

  it('serializes group syncs with model-option saves and reports overlaps as busy', async () => {
    site = new VvcodeSite()
    const host = await startHost()
    await connectGroup(host, 'pro-group', PRO_CATALOG)
    const provider = providerOf('pro-group')
    await host.service.changeSubscriptionModel(provider, 'vv-alpha', true)
    const settings = host.ctx.settings
    const revision = settings.describe().find(item => item.ns === 'hemi-model-access')?.revision ?? 0

    // While a save holds the write chain at its first live read, a model-option save refuses instead of racing it.
    scriptGroup(site, 'auto-group', [{ id: 'vv-gamma', supported_endpoint_types: ['openai-response'] }])
    const held = site.hold('/api/desktop/groups')
    const sync = host.service.saveVvcodeModels(
      [{ provider: providerOf('auto-group'), models: ['vv-gamma'] }], new AbortController().signal)
    await site.arrived('/api/desktop/groups')
    await expect(host.service.saveModelOptions(provider, 'vv-alpha', { name: 'Alpha' }, revision))
      .rejects.toMatchObject({ code: 'hemi/vvcode-failed', details: { reason: 'busy' } })

    // Releasing the read lets the sync complete on the same exclusive chain the save then reuses.
    held.resolve(new Response(JSON.stringify({
      success: true, message: '', data: site.groups,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    await sync
    expect(storedGroup(host.ctx, 'auto-group')).toMatchObject({ group: 'auto-group' })

    const currentRevision = settings.describe().find(item => item.ns === 'hemi-model-access')?.revision ?? 0
    await host.service.saveModelOptions(provider, 'vv-alpha', { name: 'Alpha' }, currentRevision)
    expect(storedModelOptions(host.ctx)[provider]).toMatchObject({ 'vv-alpha': { name: 'Alpha' } })
    const view = await host.service.getModelOptions(provider, 'vv-alpha')
    expect(view.options).toEqual({ name: 'Alpha' })
    expect(view.effective.name).toBe('Alpha')
    expect(await publishedNames(host, provider)).toEqual(['Alpha · pro-group'])
    expectWireRoles()
  })

  it('reports the automatic group label once in the editor while an unchanged name never saves as an override', async () => {
    site = new VvcodeSite()
    const host = await startHost()
    await connectGroup(host, 'pro-group', PRO_CATALOG)
    const provider = providerOf('pro-group')
    await host.service.changeSubscriptionModel(provider, 'vv-alpha', true)

    // The adapter publishes the suffixed name; the editor strips exactly that suffix for the effective value.
    expect(await publishedNames(host, provider)).toEqual(['vv-alpha · pro-group'])
    const view = await host.service.getModelOptions(provider, 'vv-alpha')
    expect(view.options).toEqual({})
    expect(view.effective.name).toBe('vv-alpha')
    expect(view.effective.contextWindow).toBeGreaterThan(0)

    // A custom display name keeps the raw override and republishes with the label appended once.
    const revision = host.ctx.settings.describe().find(item => item.ns === 'hemi-model-access')?.revision ?? 0
    await host.service.saveModelOptions(provider, 'vv-alpha', { name: 'Alpha' }, revision)
    const renamed = await host.service.getModelOptions(provider, 'vv-alpha')
    expect(renamed.options).toEqual({ name: 'Alpha' })
    expect(renamed.effective.name).toBe('Alpha')
    expect(await publishedNames(host, provider)).toEqual(['Alpha · pro-group'])
    expectWireRoles()
  })

  it('refuses subscription management from a non-owner Remote caller', async () => {
    const host = await startHost()
    const invocation: RemoteInvocation = {
      request: { namespace: 'hemiModelAccess', method: 'subscriptions', args: {} },
      service: 'hemiModelAccess',
      peer: {
        id: 'vvcode-subscription-spec-peer' as PeerId,
        ctx: host.ctx,
        principal: { kind: 'vvcode-spec-guest' },
        signal: new AbortController().signal,
        interactions: 'none',
        dispose: () => Promise.resolve(),
      },
      signal: new AbortController().signal,
      uplink: () => {
        throw new Error('this spec sends no uplink')
      },
    }
    const guest = host.ctx.extend({ invocation }).get('hemiModelAccess')
    if (guest === undefined) throw new Error('hemiModelAccess service was not mounted')
    await expect(guest.subscriptions()).rejects.toMatchObject({ code: 'hemi/model-access-forbidden' })
    expect(vvcodeEntry(await host.service.subscriptions())).toEqual({
      id: 'vvcode', name: 'VVCode', connected: false, quota: false, models: [],
    })
  })

  it('reports wallet balance and active subscriptions without invoking a model', async () => {
    site = new VvcodeSite()
    const host = await startHost()
    const nowSeconds = Math.floor(Date.now() / 1000)
    site.selfQuota = 2_500_000
    site.subscriptions = [
      subscriptionSummary(11, { start_time: nowSeconds - 60, end_time: nowSeconds + 3600 }),
      subscriptionSummary(12, { status: 'expired', end_time: nowSeconds - 30, start_time: nowSeconds - 120 }),
      subscriptionSummary(13, { start_time: nowSeconds + 600, end_time: nowSeconds + 7200 }),
    ]
    await seedGrant(host.ctx, { scopes: [...BASE_SCOPES, 'wallet:read'] })

    const usage = await host.service.vvcodeUsage(new AbortController().signal)

    expect(usage.unit).toEqual({ kind: 'currency', symbol: '$' })
    expect(usage.balance).toEqual({ state: 'ready', remaining: 5 })
    if (usage.subscriptions.state !== 'ready') throw new Error('expected ready subscriptions')
    expect(usage.subscriptions.items).toEqual([
      { id: 11, total: 5, used: 0.8, remaining: 4.2, expiresAt: (nowSeconds + 3600) * 1000, resetAt: null },
    ])
    const statusCall = site.calls.find(call => call.pathname === '/api/status')
    expect(statusCall?.authorization).toBeUndefined()
    expect(statusCall?.appId).toBe('hemi-dsh')
    expect(site.calls.some(call => call.pathname.startsWith('/v1/'))).toBe(false)
    expectWireRoles()
  })

  it('reports reauthorize for a grant without the wallet scope and keeps the account usable', async () => {
    site = new VvcodeSite()
    const host = await startHost()
    site.selfQuota = 1_000_000
    await seedGrant(host.ctx)

    const usage = await host.service.vvcodeUsage(new AbortController().signal)

    expect(usage.unit).toEqual({ kind: 'currency', symbol: '$' })
    expect(usage.balance).toEqual({ state: 'ready', remaining: 2 })
    expect(usage.subscriptions).toEqual({ state: 'reauthorize' })
    expect(site.calls.some(call => call.pathname === '/api/subscription/self')).toBe(false)

    // The missing wallet scope never condemns the account: group saves and bindings keep working.
    scriptGroup(site, 'pro-group', PRO_CATALOG)
    await host.service.saveVvcodeModels(
      [{ provider: providerOf('pro-group'), models: ['vv-alpha'] }], new AbortController().signal)
    expect(storedGroup(host.ctx, 'pro-group')).toMatchObject({ group: 'pro-group' })
    expectWireRoles()
  })

  it('keeps group selection free while a usage read is waiting on the site', async () => {
    site = new VvcodeSite()
    const host = await startHost()
    scriptGroup(site, 'pro-group', PRO_CATALOG)
    await seedGrant(host.ctx, { scopes: [...BASE_SCOPES, 'wallet:read'] })
    await host.service.saveVvcodeModels(
      [{ provider: providerOf('pro-group'), models: ['vv-alpha'] }], new AbortController().signal)

    site.selfQuota = 500000
    site.subscriptions = [subscriptionSummary(21)]
    const held = site.hold('/api/subscription/self')
    const usage = host.service.vvcodeUsage(new AbortController().signal)
    await site.arrived('/api/subscription/self')

    // The group save runs to completion while the usage read is still waiting on its answer.
    scriptGroup(site, 'auto-group', [{ id: 'vv-gamma', supported_endpoint_types: ['openai-response'] }])
    await host.service.saveVvcodeModels(
      [{ provider: providerOf('auto-group'), models: ['vv-gamma'] }], new AbortController().signal)

    held.resolve(new Response(JSON.stringify({
      success: true, message: '', data: { subscriptions: site.subscriptions, all_subscriptions: [] },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const settled = await usage

    expect(settled.balance).toEqual({ state: 'ready', remaining: 1 })
    if (settled.subscriptions.state !== 'ready') throw new Error('expected ready subscriptions')
    expect(settled.subscriptions.items).toEqual([
      expect.objectContaining({ id: 21, total: 5, used: 0.8, remaining: 4.2, resetAt: null }),
    ])
    expect(settled.subscriptions.items[0]?.expiresAt).toBeGreaterThan(Date.now())
    expect(storedGroup(host.ctx, 'auto-group')).toMatchObject({ group: 'auto-group' })
  })

  it('invalidates the grant when the balance read answers 401 and refuses until sign-in', async () => {
    site = new VvcodeSite()
    const host = await startHost()
    scriptGroup(site, 'pro-group', PRO_CATALOG)
    await seedGrant(host.ctx)
    await host.service.saveVvcodeModels(
      [{ provider: providerOf('pro-group'), models: ['vv-alpha'] }], new AbortController().signal)
    site.failSelfWith401 = true

    await expect(host.service.vvcodeUsage(new AbortController().signal))
      .rejects.toMatchObject({ code: 'hemi/vvcode-management-auth-expired' })

    expect(await storedGrant(host.ctx)).toMatchObject({ invalidated: true })
    expect(vvcodeMetadata(vvcodeEntry(await host.service.subscriptions())).expired).toBe(true)
    const directory = await host.service.vvcodeDirectory(new AbortController().signal)
    expect(directory.state).toBe('sign-in-required')
    expect(directory.groups.map(group => [group.name, group.state])).toEqual([['pro-group', 'ready']])
    expect(directory.groups[0]?.models).toEqual([
      { id: 'vv-alpha', enabled: true }, { id: 'vv-beta', enabled: false }, { id: 'vv-gamma', enabled: false },
    ])
  })

  it('keeps the balance and subscriptions independent when one read fails', async () => {
    site = new VvcodeSite()
    const host = await startHost()
    site.selfQuota = 500000
    site.subscriptionSelfStatus = 500
    await seedGrant(host.ctx, { scopes: [...BASE_SCOPES, 'wallet:read'] })
    const grantBefore = await storedGrant(host.ctx)
    if (grantBefore === undefined) throw new Error('no grant to compare against')

    const refused = await host.service.vvcodeUsage(new AbortController().signal)

    expect(refused.balance).toEqual({ state: 'ready', remaining: 1 })
    expect(refused.subscriptions).toEqual({ state: 'unavailable' })

    delete site.selfQuota
    site.subscriptionSelfStatus = 403
    const second = await host.service.vvcodeUsage(new AbortController().signal)

    expect(second.balance).toEqual({ state: 'unavailable' })
    expect(second.subscriptions).toEqual({ state: 'reauthorize' })
    expect(await storedGrant(host.ctx)).toEqual(grantBefore)
  })

  it('surfaces caller cancellation without touching stored account state', async () => {
    site = new VvcodeSite()
    const host = await startHost()
    scriptGroup(site, 'pro-group', PRO_CATALOG)
    await seedGrant(host.ctx)
    await host.service.saveVvcodeModels(
      [{ provider: providerOf('pro-group'), models: ['vv-alpha'] }], new AbortController().signal)
    const grantBefore = await storedGrant(host.ctx)
    if (grantBefore === undefined) throw new Error('no grant to compare against')
    const held = site.hold('/api/user/self')
    const controller = new AbortController()
    const usage = host.service.vvcodeUsage(controller.signal)
    await site.arrived('/api/user/self')
    controller.abort(new Error('stop'))

    await expect(usage).rejects.toThrow('stop')
    held.resolve(new Response(JSON.stringify({ success: true, message: '', data: {} }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    expect(await storedGrant(host.ctx)).toEqual(grantBefore)
    expect(storedGroup(host.ctx, 'pro-group')).toMatchObject({ group: 'pro-group' })
  })

  it('reports a management 401 during the directory read as sign-in-required with rows retained', async () => {
    site = new VvcodeSite()
    const host = await startHost()
    await connectGroup(host, 'pro-group', PRO_CATALOG)
    const recordBefore = { ...storedGroup(host.ctx, 'pro-group') }
    const grantBefore = await storedGrant(host.ctx)
    if (grantBefore === undefined) throw new Error('no grant to compare against')
    site.failGroupsWith = 401

    const directory = await host.service.vvcodeDirectory(new AbortController().signal)

    expect(directory.state).toBe('sign-in-required')
    expect(directory.groups.map(group => group.name)).toEqual(['pro-group'])
    // The confirmed account loss expires the grant but clears neither the binding, its key, nor its catalog.
    expect(await storedGrant(host.ctx)).toMatchObject({ accessToken: grantBefore.accessToken, invalidated: true })
    expect(storedGroup(host.ctx, 'pro-group')).toEqual(recordBefore)
    expect(await host.ctx.credentials.resolve(credentialRef(String(recordBefore.apiKeyRef)))).toBeDefined()
    expectWireRoles()
  })

  it('a stale directory answer that settles after a confirmed revocation cannot reverse it', async () => {
    site = new VvcodeSite()
    const host = await startHost()
    await connectGroup(host, 'pro-group', PRO_CATALOG)
    await connectGroup(host, 'auto-group', [{ id: 'vv-shared', supported_endpoint_types: ['openai'] }])
    const auto = providerOf('auto-group')
    await host.service.changeSubscriptionModel(auto, 'vv-shared', true)

    // D1 dispatches first and its answer is held; the group disappears before D2 dispatches.
    const staleController = new AbortController()
    const held = site.hold('/api/desktop/groups')
    const stale = host.service.vvcodeDirectory(staleController.signal)
    await site.arrived('/api/desktop/groups')
    site.release('/api/desktop/groups')
    delete site.groups['auto-group']
    const fresh = await host.service.vvcodeDirectory(new AbortController().signal)
    expect(fresh.state).toBe('ready')
    expect(fresh.groups.find(group => group.name === 'auto-group')?.state).toBe('unavailable')
    expect(storedGroup(host.ctx, 'auto-group').revoked).toBe(true)
    await expect(host.ctx.llm.listModels(auto)).rejects.toMatchObject({ code: 'NO_ADAPTER' })

    // Releasing the older answer must not overwrite the newer confirmed loss.
    held.resolve(new Response(JSON.stringify({
      success: true, message: '',
      data: { ...site.groups, 'auto-group': { ratio: 'auto', desc: 'auto-group description' } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const settled = await stale

    expect(storedGroup(host.ctx, 'auto-group').revoked).toBe(true)
    expect(settled.groups.find(group => group.name === 'auto-group')?.state).toBe('unavailable')
    await expect(host.ctx.llm.listModels(auto)).rejects.toMatchObject({ code: 'NO_ADAPTER' })
    expect((await directoryRow(host, 'pro-group')).row.state).toBe('ready')
    expectWireRoles()
  })

  it('a superseded catalog refresh cannot clear a revocation confirmed while it was paused', async () => {
    site = new VvcodeSite()
    const host = await startHost()
    await connectGroup(host, 'auto-group', [{ id: 'vv-shared', supported_endpoint_types: ['openai'] }])
    const auto = providerOf('auto-group')
    await host.service.changeSubscriptionModel(auto, 'vv-shared', true)

    const held = site.hold('/v1/models')
    const refresh = host.service.subscriptionCandidates(auto, new AbortController().signal)
    await site.arrived('/v1/models')
    delete site.groups['auto-group']
    expect((await directoryRow(host, 'auto-group')).row.state).toBe('unavailable')
    expect(storedGroup(host.ctx, 'auto-group').revoked).toBe(true)

    held.resolve(new Response(JSON.stringify({ object: 'list', data: [{ id: 'vv-shared', supported_endpoint_types: ['openai'] }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    expect(await refresh).toEqual(['vv-shared'])

    // The refresh recorded its catalog but kept the newer revocation: the route stays refused.
    expect(storedGroup(host.ctx, 'auto-group').revoked).toBe(true)
    expect(storedGroup(host.ctx, 'auto-group').models).toEqual([{ id: 'vv-shared', api: 'openai-completions' }])
    await expect(host.ctx.llm.listModels(auto)).rejects.toMatchObject({ code: 'NO_ADAPTER' })
    expectWireRoles()
  })

  it('a superseded group save cannot clear a revocation confirmed while its verification paused', async () => {
    site = new VvcodeSite()
    const host = await startHost()
    await connectGroup(host, 'auto-group', [{ id: 'vv-shared', supported_endpoint_types: ['openai'] }])
    const auto = providerOf('auto-group')
    await host.service.changeSubscriptionModel(auto, 'vv-shared', true)
    scriptGroup(site, 'extra-group', [{ id: 'vv-extra', supported_endpoint_types: ['openai'] }])
    const extraTokenId = site.nextTokenId

    const held = site.hold(`/api/token/${String(extraTokenId)}`)
    const sync = host.service.saveVvcodeModels(
      [{ provider: providerOf('extra-group'), models: ['vv-extra'] }], new AbortController().signal)
    await site.arrived(`/api/token/${String(extraTokenId)}`)
    delete site.groups['auto-group']
    expect((await directoryRow(host, 'auto-group')).row.state).toBe('unavailable')
    expect(storedGroup(host.ctx, 'auto-group').revoked).toBe(true)

    held.resolve(new Response(JSON.stringify({ success: true, message: '', data: site.tokens.find(token => token.id === extraTokenId) }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    // The creation's own detail read consumed the held answer; later verifications answer normally.
    site.release(`/api/token/${String(extraTokenId)}`)
    await sync

    expect(storedGroup(host.ctx, 'auto-group').revoked).toBe(true)
    await expect(host.ctx.llm.listModels(auto)).rejects.toMatchObject({ code: 'NO_ADAPTER' })
    expect(storedGroup(host.ctx, 'extra-group')).toMatchObject({ group: 'extra-group', revoked: false })
    expectWireRoles()
  })

  it('a single-group refresh whose confirmed loss cannot be stored still stops the route', async () => {
    site = new VvcodeSite()
    const host = await startHost()
    await connectGroup(host, 'pro-group', PRO_CATALOG)
    await connectGroup(host, 'auto-group', [{ id: 'vv-shared', supported_endpoint_types: ['openai'] }])
    const auto = providerOf('auto-group')
    await host.service.changeSubscriptionModel(auto, 'vv-shared', true)
    const settings = host.ctx.settings
    const originalMutate = settings.mutate.bind(settings)
    let failing = true
    Object.defineProperty(settings, 'mutate', {
      configurable: true,
      value: (...args: Parameters<typeof originalMutate>) => {
        if (failing) return Promise.reject(new Error('spec: settings write refused'))
        return originalMutate(...args)
      },
    })

    // The refresh confirms the group is gone while every settings write is refused.
    delete site.groups['auto-group']
    await expect(host.service.syncVvcodeGroup('auto-group', new AbortController().signal))
      .rejects.toThrow('spec: settings write refused')

    // The unstoreable loss still refuses to serve while it cannot be persisted.
    expect(storedGroup(host.ctx, 'auto-group').revoked).toBe(false)
    await expect(host.ctx.llm.listModels(auto)).rejects.toMatchObject({ code: 'NO_ADAPTER' })
    await expectStreamFailure(host, auto, 'vv-shared', 'NO_ADAPTER')
    expect((await directoryRow(host, 'pro-group')).row.state).toBe('ready')

    // Once writes recover, the next refresh persists the loss and the state stays truthful.
    failing = false
    await expect(host.service.syncVvcodeGroup('auto-group', new AbortController().signal))
      .rejects.toMatchObject({ code: 'hemi/vvcode-failed', details: { reason: 'group-unavailable' } })
    expect(storedGroup(host.ctx, 'auto-group').revoked).toBe(true)
    await expect(host.ctx.llm.listModels(auto)).rejects.toMatchObject({ code: 'NO_ADAPTER' })
    expect((await directoryRow(host, 'pro-group')).row.state).toBe('ready')
    expectWireRoles()
  })

  it('a save whose second key write fails cleans up the first and keeps both pending IDs', async () => {
    site = new VvcodeSite()
    const host = await startHost()
    scriptGroup(site, 'pro-group', [{ id: 'vv-alpha', supported_endpoint_types: ['openai'] }])
    scriptGroup(site, 'auto-group', [{ id: 'vv-gamma', supported_endpoint_types: ['openai-response'] }])
    await seedGrant(host.ctx)
    const credentials = host.ctx.credentials
    const originalSet = credentials.set.bind(credentials)
    let failedOnce = false
    Object.defineProperty(credentials, 'set', {
      configurable: true,
      value: async (...args: Parameters<typeof originalSet>) => {
        if (!failedOnce) {
          failedOnce = true
          return originalSet(...args)
        }
        throw new Error('spec: second key write refused')
      },
    })

    await expect(host.service.saveVvcodeModels([
      { provider: providerOf('pro-group'), models: ['vv-alpha'] },
      { provider: providerOf('auto-group'), models: ['vv-gamma'] },
    ], new AbortController().signal)).rejects.toThrow('spec: second key write refused')

    // The written-then-orphaned key reference is cleaned up, and nothing was selected half-way.
    expect(storedConnections(host.ctx)).toEqual({})
    const proRef = `VVCODE_${createHash('sha256').update(JSON.stringify([VVCODE_ORIGIN, 1, 77])).digest('hex').toUpperCase()}_API_KEY`
    const autoRef = `VVCODE_${createHash('sha256').update(JSON.stringify([VVCODE_ORIGIN, 1, 78])).digest('hex').toUpperCase()}_API_KEY`
    expect(await credentials.resolve(credentialRef(proRef))).toBeUndefined()
    expect(await credentials.resolve(credentialRef(autoRef))).toBeUndefined()
    // Both pending creations stay recorded, so the retry reuses them without re-creating.
    const pending = asObject((await storedGrant(host.ctx))?.pending)
    expect(asObject(pending?.['pro-group'])).toMatchObject({ tokenId: 77 })
    expect(asObject(pending?.['auto-group'])).toMatchObject({ tokenId: 78 })
    expect(createCalls()).toHaveLength(2)

    Object.defineProperty(credentials, 'set', { configurable: true, value: originalSet })
    await host.service.saveVvcodeModels([
      { provider: providerOf('pro-group'), models: ['vv-alpha'] },
      { provider: providerOf('auto-group'), models: ['vv-gamma'] },
    ], new AbortController().signal)

    expect(createCalls()).toHaveLength(2)
    expect(storedGroup(host.ctx, 'pro-group')).toMatchObject({ group: 'pro-group', tokenId: 77 })
    expect(storedGroup(host.ctx, 'auto-group')).toMatchObject({ group: 'auto-group', tokenId: 78 })
    expect(storedGroup(host.ctx, 'pro-group').selected).toEqual(['vv-alpha'])
    expect(storedGroup(host.ctx, 'auto-group').selected).toEqual(['vv-gamma'])
    expectWireRoles()
  })

  it('a save whose added group the live list no longer names rejects the whole save and prepares nothing', async () => {
    site = new VvcodeSite()
    const host = await startHost()
    await connectGroup(host, 'pro-group', PRO_CATALOG)
    scriptGroup(site, 'auto-group', [{ id: 'vv-gamma', supported_endpoint_types: ['openai-response'] }])
    // The site removed the bound group after the last read; the local state does not know yet.
    delete site.groups['pro-group']

    await expect(host.service.saveVvcodeModels([
      { provider: providerOf('pro-group'), models: ['vv-alpha'] },
      { provider: providerOf('auto-group'), models: ['vv-gamma'] },
    ], new AbortController().signal))
      .rejects.toMatchObject({ code: 'hemi/vvcode-failed', details: { reason: 'group-unavailable' } })

    // The save prepared nothing for the still-authorized group and wrote no selection.
    expect(createCalls()).toHaveLength(1)
    expect(storedGroup(host.ctx, 'pro-group').selected).toEqual([])
    expect(storedConnections(host.ctx)['auto-group']).toBeUndefined()
    expect(asObject((await storedGrant(host.ctx))?.pending)).toEqual({})
    expectWireRoles()
  })

  it('a loss a later read confirms while a save prepares rejects the whole save before its commit', async () => {
    site = new VvcodeSite()
    const host = await startHost()
    await connectGroup(host, 'pro-group', PRO_CATALOG)
    scriptGroup(site, 'auto-group', [{ id: 'vv-gamma', supported_endpoint_types: ['openai-response'] }])
    const credentials = host.ctx.credentials
    const heldTokenId = site.nextTokenId
    const held = site.hold(`/api/token/${String(heldTokenId)}/key`)
    const sync = host.service.saveVvcodeModels([
      { provider: providerOf('pro-group'), models: ['vv-alpha'] },
      { provider: providerOf('auto-group'), models: ['vv-gamma'] },
    ], new AbortController().signal)
    await site.arrived(`/api/token/${String(heldTokenId)}/key`)

    // While the new group's key reveal is paused, a directory read confirms the bound group is gone.
    delete site.groups['pro-group']
    expect((await directoryRow(host, 'pro-group')).row.state).toBe('unavailable')
    expect(storedGroup(host.ctx, 'pro-group').revoked).toBe(true)

    held.resolve(new Response(JSON.stringify({ success: true, message: '', data: { key: `vv-model-key-${String(heldTokenId).padStart(4, '0')}` } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    site.release(`/api/token/${String(heldTokenId)}/key`)
    await expect(sync).rejects.toMatchObject({ code: 'hemi/vvcode-failed', details: { reason: 'group-unavailable' } })

    // No selection was written beside the revocation, no key leaked, and the pending ID stays reusable.
    expect(storedGroup(host.ctx, 'pro-group').selected).toEqual([])
    expect(storedConnections(host.ctx)['auto-group']).toBeUndefined()
    const autoRef = `VVCODE_${createHash('sha256').update(JSON.stringify([VVCODE_ORIGIN, 1, heldTokenId])).digest('hex').toUpperCase()}_API_KEY`
    expect(await credentials.resolve(credentialRef(autoRef))).toBeUndefined()
    expect(asObject(asObject((await storedGrant(host.ctx))?.pending)?.['auto-group']))
      .toMatchObject({ tokenId: heldTokenId })
    expect(createCalls()).toHaveLength(2)

    // The retry reuses the pending ID without a second creation.
    await host.service.saveVvcodeModels(
      [{ provider: providerOf('auto-group'), models: ['vv-gamma'] }], new AbortController().signal)
    expect(createCalls()).toHaveLength(2)
    expect(storedGroup(host.ctx, 'auto-group')).toMatchObject({ group: 'auto-group', tokenId: heldTokenId })
    expect(storedGroup(host.ctx, 'pro-group').selected).toEqual([])
    expectWireRoles()
  })

  it('a revocation confirmed while a key write is held rejects the commit that would follow it', async () => {
    site = new VvcodeSite()
    const host = await startHost()
    await connectGroup(host, 'pro-group', PRO_CATALOG)
    scriptGroup(site, 'auto-group', [{ id: 'vv-gamma', supported_endpoint_types: ['openai-response'] }])
    const credentials = host.ctx.credentials
    const settings = host.ctx.settings
    const originalMutate = settings.mutate.bind(settings)
    let failingMutate = true
    Object.defineProperty(settings, 'mutate', {
      configurable: true,
      value: (...args: Parameters<typeof originalMutate>) => {
        if (failingMutate) return Promise.reject(new Error('spec: settings write refused'))
        return originalMutate(...args)
      },
    })
    const originalSet = credentials.set.bind(credentials)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let heldOnce = false
    Object.defineProperty(credentials, 'set', {
      configurable: true,
      value: async (...args: Parameters<typeof originalSet>) => {
        if (heldOnce) return originalSet(...args)
        heldOnce = true
        entered.resolve(undefined)
        await release.promise
        return originalSet(...args)
      },
    })

    const sync = host.service.saveVvcodeModels([
      { provider: providerOf('pro-group'), models: ['vv-alpha'] },
      { provider: providerOf('auto-group'), models: ['vv-gamma'] },
    ], new AbortController().signal)
    await entered.promise

    // While the first key write is held, a directory read confirms pro-group is gone and its persist is refused.
    delete site.groups['pro-group']
    expect((await directoryRow(host, 'pro-group')).row.state).toBe('unavailable')
    expect(storedGroup(host.ctx, 'pro-group').revoked).toBe(false)
    failingMutate = false
    release.resolve(undefined)

    // The save re-checks the added groups right before its commit and rejects on the hold.
    await expect(sync).rejects.toMatchObject({ code: 'hemi/vvcode-failed', details: { reason: 'group-unavailable' } })
    expect(storedGroup(host.ctx, 'pro-group').selected).toEqual([])
    expect(storedConnections(host.ctx)['auto-group']).toBeUndefined()
    const autoRef = `VVCODE_${createHash('sha256').update(JSON.stringify([VVCODE_ORIGIN, 1, 78])).digest('hex').toUpperCase()}_API_KEY`
    expect(await credentials.resolve(credentialRef(autoRef))).toBeUndefined()
    expect(asObject(asObject((await storedGrant(host.ctx))?.pending)?.['auto-group'])).toMatchObject({ tokenId: 78 })
    expect(createCalls()).toHaveLength(2)
    // The unstoreable loss keeps the group's remaining selection from serving.
    await expect(host.ctx.llm.listModels(providerOf('pro-group'))).rejects.toMatchObject({ code: 'NO_ADAPTER' })
    expectWireRoles()
  })

  it('a save whose live read lost an added bound group holds that loss before rejecting', async () => {
    site = new VvcodeSite()
    const host = await startHost()
    await connectGroup(host, 'pro-group', PRO_CATALOG)
    await connectGroup(host, 'auto-group', [{ id: 'vv-shared', supported_endpoint_types: ['openai'] }])
    const pro = providerOf('pro-group')
    const auto = providerOf('auto-group')
    await host.service.changeSubscriptionModel(pro, 'vv-alpha', true)
    await host.service.changeSubscriptionModel(auto, 'vv-shared', true)
    const settings = host.ctx.settings
    const originalMutate = settings.mutate.bind(settings)
    let failingMutate = true
    Object.defineProperty(settings, 'mutate', {
      configurable: true,
      value: (...args: Parameters<typeof originalMutate>) => {
        if (failingMutate) return Promise.reject(new Error('spec: settings write refused'))
        return originalMutate(...args)
      },
    })

    // The live read inside the save no longer names pro-group while every settings write is refused.
    delete site.groups['pro-group']
    await expect(host.service.saveVvcodeModels([
      { provider: pro, models: ['vv-alpha', 'vv-beta'] },
      { provider: auto, models: [] },
    ], new AbortController().signal)).rejects.toThrow('spec: settings write refused')

    // The confirmed loss still stops the group's remaining selection from serving.
    await expect(host.ctx.llm.listModels(pro)).rejects.toMatchObject({ code: 'NO_ADAPTER' })
    expect(storedGroup(host.ctx, 'pro-group').selected).toEqual(['vv-alpha'])
    expect(storedGroup(host.ctx, 'auto-group').selected).toEqual(['vv-shared'])

    // Once the hold is engaged, saves refuse additions to that group without any further request.
    await expect(host.service.saveVvcodeModels([
      { provider: pro, models: ['vv-alpha', 'vv-beta'] },
      { provider: auto, models: [] },
    ], new AbortController().signal))
      .rejects.toMatchObject({ code: 'hemi/vvcode-failed', details: { reason: 'group-unavailable' } })
    expect(storedGroup(host.ctx, 'pro-group').revoked).toBe(false)
    expect(storedGroup(host.ctx, 'pro-group').selected).toEqual(['vv-alpha'])
    expect(storedGroup(host.ctx, 'auto-group').selected).toEqual(['vv-shared'])

    // Once writes recover, the next directory read persists the confirmed loss.
    failingMutate = false
    const next = await host.service.vvcodeDirectory(new AbortController().signal)
    expect(next.state).toBe('ready')
    expect(storedGroup(host.ctx, 'pro-group').revoked).toBe(true)
    expect(storedGroup(host.ctx, 'pro-group').selected).toEqual(['vv-alpha'])
    expect(storedGroup(host.ctx, 'auto-group').selected).toEqual(['vv-shared'])
    await expect(host.ctx.llm.listModels(pro)).rejects.toMatchObject({ code: 'NO_ADAPTER' })
    expect((await directoryRow(host, 'auto-group')).row.state).toBe('ready')
    expectWireRoles()
  })

  it('a confirmed loss that cannot be stored reports unavailable, keeps the live rows, and stops the route', async () => {
    site = new VvcodeSite()
    const host = await startHost({}, { vvcode: ['vv-alpha'] }, {
      origin: VVCODE_ORIGIN, group: 'pro-group', userId: '1', tokenId: 77, apiKeyRef: 'VVCODE_LEGACY_API_KEY',
      models: [{ id: 'vv-alpha', api: 'openai-completions' }],
    })
    scriptGroup(site, 'auto-group', [{ id: 'vv-shared', supported_endpoint_types: ['openai'] }])
    await seedGrant(host.ctx)
    await host.ctx.credentials.set(credentialRef('VVCODE_LEGACY_API_KEY'), 'sk-vv-model-key-0077')
    const settings = host.ctx.settings
    const originalMutate = settings.mutate.bind(settings)
    let failing = true
    Object.defineProperty(settings, 'mutate', {
      configurable: true,
      value: (...args: Parameters<typeof originalMutate>) => {
        if (failing) return Promise.reject(new Error('spec: settings write refused'))
        return originalMutate(...args)
      },
    })

    // The only owned (legacy) group disappears while every settings write is refused.
    delete site.groups['pro-group']
    const directory = await host.service.vvcodeDirectory(new AbortController().signal)

    expect(directory.state).toBe('unavailable')
    expect(directory.groups.find(group => group.name === 'pro-group')).toMatchObject({
      state: 'unavailable', provider: 'vvcode',
      // The legacy selection stays saved and visible even while the loss cannot be stored.
      models: [{ id: 'vv-alpha', enabled: true }],
    })
    // The live observation may not clear the binding, and the route refuses while the note is unpersisted.
    expect(storedConnection(host.ctx)).toMatchObject({ group: 'pro-group' })
    // The legacy route stays registered but offers nothing and refuses requests while withheld;
    // with the route withheld, its base profile rejects the model as unconfigured.
    expect(await host.ctx.llm.listModels('vvcode')).toEqual([])
    await expectStreamFailure(host, 'vvcode', 'vv-alpha', 'INVALID_CONFIG')
    // The sync refuses too: it reaches the same unstoreable conclusion and never creates a token.
    const createsBeforeSync = createCalls().length
    await expect(host.service.syncVvcodeGroup('pro-group', new AbortController().signal)).rejects.toThrow()
    expect(createCalls()).toHaveLength(createsBeforeSync)

    // Once writes work again, the next read persists the confirmed loss and the state stays truthful.
    failing = false
    const next = await host.service.vvcodeDirectory(new AbortController().signal)
    expect(next.state).toBe('ready')
    expect(next.groups.find(group => group.name === 'pro-group')?.state).toBe('unavailable')
    expect(storedGroup(host.ctx, 'pro-group').revoked).toBe(true)
    expect(storedGroup(host.ctx, 'pro-group')).toMatchObject({ group: 'pro-group', provider: 'vvcode' })
    expect(await host.ctx.llm.listModels('vvcode')).toEqual([])

    // The group returns server-side: the next read restores the route.
    scriptGroup(site, 'pro-group', [{ id: 'vv-alpha', supported_endpoint_types: ['openai'] }])
    const restored = await host.service.vvcodeDirectory(new AbortController().signal)
    expect(restored.state).toBe('ready')
    expect(restored.groups.find(group => group.name === 'pro-group')?.state).toBe('ready')
    expect(await publishedModels(host, 'vvcode')).toEqual(['vv-alpha'])
    expectWireRoles()
  })

  it('a zero-change newest read adopts the sequence and a late older answer still cannot commit', async () => {
    site = new VvcodeSite()
    const host = await startHost()
    await connectGroup(host, 'pro-group', PRO_CATALOG)
    await connectGroup(host, 'auto-group', [{ id: 'vv-shared', supported_endpoint_types: ['openai'] }])
    const auto = providerOf('auto-group')
    await host.service.changeSubscriptionModel(auto, 'vv-shared', true)

    // The loss is confirmed and stored first.
    delete site.groups['auto-group']
    expect((await directoryRow(host, 'auto-group')).row.state).toBe('unavailable')
    expect(storedGroup(host.ctx, 'auto-group').revoked).toBe(true)

    // D1 dispatches while its answer is held; D2 then reads the unchanged site and needs no write.
    const held = site.hold('/api/desktop/groups')
    const stale = host.service.vvcodeDirectory(new AbortController().signal)
    await site.arrived('/api/desktop/groups')
    site.release('/api/desktop/groups')
    const current = await host.service.vvcodeDirectory(new AbortController().signal)
    expect(current.state).toBe('ready')

    // Releasing the older answer must not commit against the newer adopted read.
    held.resolve(new Response(JSON.stringify({
      success: true, message: '',
      data: { ...site.groups, 'auto-group': { ratio: 'auto', desc: 'auto-group description' } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const settled = await stale

    expect(settled.state).toBe('unavailable')
    expect(settled.groups.find(group => group.name === 'auto-group')?.state).toBe('unavailable')
    expect(storedGroup(host.ctx, 'auto-group').revoked).toBe(true)
    await expect(host.ctx.llm.listModels(auto)).rejects.toMatchObject({ code: 'NO_ADAPTER' })
    expectWireRoles()
  })

  it('a confirmed loss whose persistence failed keeps refusing even when an older answer settles after recovery', async () => {
    site = new VvcodeSite()
    const host = await startHost()
    await connectGroup(host, 'pro-group', PRO_CATALOG)
    await connectGroup(host, 'auto-group', [{ id: 'vv-shared', supported_endpoint_types: ['openai'] }])
    const auto = providerOf('auto-group')
    await host.service.changeSubscriptionModel(auto, 'vv-shared', true)
    const settings = host.ctx.settings
    const originalMutate = settings.mutate.bind(settings)
    let failing = false
    Object.defineProperty(settings, 'mutate', {
      configurable: true,
      value: (...args: Parameters<typeof originalMutate>) => {
        if (failing) return Promise.reject(new Error('spec: settings write refused'))
        return originalMutate(...args)
      },
    })

    // D1 dispatches first and its answer (both groups present) is held.
    const held = site.hold('/api/desktop/groups')
    const stale = host.service.vvcodeDirectory(new AbortController().signal)
    await site.arrived('/api/desktop/groups')
    site.release('/api/desktop/groups')

    // D2 reads the loss while writes are refused: the hold engages and nothing is stored.
    delete site.groups['auto-group']
    failing = true
    const failed = await host.service.vvcodeDirectory(new AbortController().signal)
    expect(failed.state).toBe('unavailable')
    expect(failed.groups.find(group => group.name === 'auto-group')?.state).toBe('unavailable')
    expect(storedGroup(host.ctx, 'auto-group').revoked).toBe(false)
    await expect(host.ctx.llm.listModels(auto)).rejects.toMatchObject({ code: 'NO_ADAPTER' })

    // Writes recover, then the older answer finally settles: it must not clear the hold.
    failing = false
    held.resolve(new Response(JSON.stringify({
      success: true, message: '',
      data: { ...site.groups, 'auto-group': { ratio: 'auto', desc: 'auto-group description' } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const settled = await stale

    expect(settled.state).toBe('unavailable')
    expect(settled.groups.find(group => group.name === 'auto-group')?.state).toBe('unavailable')
    expect(storedGroup(host.ctx, 'auto-group').revoked).toBe(false)
    await expect(host.ctx.llm.listModels(auto)).rejects.toMatchObject({ code: 'NO_ADAPTER' })

    // The next read persists the confirmed loss now that writes work; the hold then ends as data.
    const next = await host.service.vvcodeDirectory(new AbortController().signal)
    expect(next.state).toBe('ready')
    expect(storedGroup(host.ctx, 'auto-group').revoked).toBe(true)
    expect(next.groups.find(group => group.name === 'auto-group')?.state).toBe('unavailable')
    await expect(host.ctx.llm.listModels(auto)).rejects.toMatchObject({ code: 'NO_ADAPTER' })
    expect((await directoryRow(host, 'pro-group')).row.state).toBe('ready')
    expectWireRoles()
  })

  it('commits two groups atomically and refuses the whole save when one entry is invalid', async () => {
    site = new VvcodeSite()
    const host = await startHost()
    await connectGroup(host, 'pro-group', PRO_CATALOG.filter(entry => entry.id !== 'vv-delta'))
    await connectGroup(host, 'auto-group', [{ id: 'vv-shared', supported_endpoint_types: ['openai'] }])
    const pro = providerOf('pro-group')
    const auto = providerOf('auto-group')
    await host.service.changeSubscriptionModel(pro, 'vv-alpha', true)
    const createsBefore = createCalls().length

    // Both groups commit in one save, together with a pure removal on the second group.
    await host.service.saveVvcodeModels([
      { provider: pro, models: ['vv-alpha', 'vv-beta'] },
      { provider: auto, models: [] },
    ], new AbortController().signal)

    expect(storedGroup(host.ctx, 'pro-group').selected).toEqual(['vv-alpha', 'vv-beta'])
    expect(storedGroup(host.ctx, 'auto-group').selected).toEqual([])
    expect(createCalls()).toHaveLength(createsBefore)
    expect(await publishedModels(host, pro)).toEqual(['vv-alpha', 'vv-beta'])

    // One invalid entry (unknown model, duplicate provider, unknown provider) writes nothing at all.
    const before = { pro: [...storedGroup(host.ctx, 'pro-group').selected as string[]],
      auto: [...storedGroup(host.ctx, 'auto-group').selected as string[]] }
    const invalidSelections: readonly [string, VvcodeModelSelection[]][] = [
      ['unknown model', [{ provider: pro, models: ['vv-ghost'] }]],
      ['duplicate provider', [{ provider: pro, models: [] }, { provider: pro, models: ['vv-alpha'] }]],
      ['unknown provider', [{ provider: 'vvcode-group-unknown0000000000', models: [] }]],
    ]
    for (const [name, bad] of invalidSelections) {
      await expect(host.service.saveVvcodeModels(bad, new AbortController().signal))
        .rejects.toMatchObject({ code: 'hemi/vvcode-failed' })
      expect(storedGroup(host.ctx, 'pro-group').selected).toEqual(before.pro)
      expect(storedGroup(host.ctx, 'auto-group').selected).toEqual(before.auto)
      expect(name).toBeDefined()
    }
    // Unchanged groups and model options stay untouched by a save.
    expect(storedModelOptions(host.ctx)[pro]).toBeUndefined()
    expectWireRoles()
  })

  it('on an expired account a modal save allows pure removals and rejects additions without writing', async () => {
    site = new VvcodeSite()
    const host = await startHost()
    await connectGroup(host, 'pro-group', PRO_CATALOG.filter(entry => entry.id !== 'vv-delta'))
    const pro = providerOf('pro-group')
    await host.service.changeSubscriptionModel(pro, 'vv-alpha', true)
    await expireGrant(host.ctx)

    // Pure removal stays local and works while expired.
    await host.service.saveVvcodeModels([{ provider: pro, models: [] }], new AbortController().signal)
    expect(storedGroup(host.ctx, 'pro-group').selected).toEqual([])

    // An addition needs a valid account: the whole save refuses and the removal stays written.
    await expect(host.service.saveVvcodeModels([{ provider: pro, models: ['vv-alpha'] }], new AbortController().signal))
      .rejects.toMatchObject({ code: 'hemi/vvcode-failed', details: { reason: 'sign-in-required' } })
    expect(storedGroup(host.ctx, 'pro-group').selected).toEqual([])
    expect(createCalls()).toHaveLength(1)
  })

  it('aborting a modal save before its commit writes nothing', async () => {
    site = new VvcodeSite()
    const host = await startHost()
    await connectGroup(host, 'pro-group', PRO_CATALOG.filter(entry => entry.id !== 'vv-delta'))
    const pro = providerOf('pro-group')

    const controller = new AbortController()
    controller.abort()
    await expect(host.service.saveVvcodeModels([{ provider: pro, models: ['vv-alpha'] }], controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(storedGroup(host.ctx, 'pro-group').selected).toEqual([])
    expect(await publishedModels(host, pro)).toEqual([])
  })

  it('resuming a v1 pending creation keeps the migrated legacy group key that its retireRef names', async () => {
    site = new VvcodeSite()
    const legacyRef = 'VVCODE_LEGACY_API_KEY'
    const host = await startHost({}, { vvcode: ['vv-alpha'] }, {
      origin: VVCODE_ORIGIN, group: 'pro-group', userId: '1', tokenId: 77, apiKeyRef: legacyRef,
      models: [{ id: 'vv-alpha', api: 'openai-completions' }],
    })
    scriptGroup(site, 'pro-group', [{ id: 'vv-alpha', supported_endpoint_types: ['openai'] }])
    scriptGroup(site, 'auto-group', [{ id: 'vv-gamma', supported_endpoint_types: ['openai-response'] }])
    await seedGrant(host.ctx, {
      // The old single-group flow started a group change to auto-group and recorded the legacy key
      // as the replacement's retiree; the upgrade migrates the legacy binding beside this pending.
      pending: { name: 'hemi-dsh-spec-resume', group: 'auto-group', tokenId: 78, retireRef: legacyRef },
    })
    site.tokens.push({ id: 78, user_id: 1, name: 'hemi-dsh-spec-resume', group: 'auto-group', status: 1, expired_time: -1 })
    site.keys.set(78, 'vv-model-key-0078')
    await host.ctx.credentials.set(credentialRef(legacyRef), 'sk-vv-model-key-0077')

    // The resumed save recovers the pending token by its persisted id without recreating it.
    await host.service.saveVvcodeModels(
      [{ provider: providerOf('auto-group'), models: ['vv-gamma'] }], new AbortController().signal)

    expect(createCalls()).toHaveLength(0)
    expect(storedGroup(host.ctx, 'auto-group')).toMatchObject({
      group: 'auto-group', tokenId: 78, provider: providerOf('auto-group'),
    })
    const autoRef = String(storedGroup(host.ctx, 'auto-group').apiKeyRef)
    expect(autoRef).not.toBe(legacyRef)
    expect(await host.ctx.credentials.resolve(credentialRef(autoRef)))
      .toMatchObject({ value: 'sk-vv-model-key-0078' })
    // The retired reference now belongs to the migrated legacy binding and keeps serving it.
    expect(await host.ctx.credentials.resolve(credentialRef(legacyRef)))
      .toMatchObject({ value: 'sk-vv-model-key-0077' })
    expect(await publishedModels(host, 'vvcode')).toEqual(['vv-alpha'])
    const chunks = await collectStream(host, 'vvcode', 'vv-alpha')
    expect(chunks[chunks.length - 1]).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    const request = site.calls.find(call => call.pathname === '/v1/chat/completions')
    expect(request).toMatchObject({ authorization: 'Bearer sk-vv-model-key-0077' })
    expect(asObject((await storedGrant(host.ctx))?.pending)).toEqual({})
    expectWireRoles()
  })
})
