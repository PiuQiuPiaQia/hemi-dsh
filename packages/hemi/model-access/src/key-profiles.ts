/** Hemi connection editor over Harness settings and write-only credentials. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { asObject } from './response.ts'
import type { KeyDirectory, KeyProfileInput } from './types.ts'
import { applyModelOptions, modelOptionsOf } from './model-options.ts'

const NS = 'llm-pi-ai'
const APIS = new Set(['openai-completions', 'openai-responses', 'anthropic-messages'])

function section(ctx: Context) {
  const view = ctx.settings.describe().find(item => item.ns === NS)
  if (view === undefined) throw new Error('Model settings are unavailable.')
  return { revision: view.revision, providers: asObject(asObject(view.value)?.providers) ?? {} }
}

function endpoint(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Enter an HTTP or HTTPS API endpoint.')
  }
  return url.href.replace(/\/$/, '')
}

/**
 * List configured API connections, including previous imports.
 * @param ctx - Owning Host or Client context providing the required services.
 * @returns the configured connections and their current settings revision.
 */
export async function keyDirectory(ctx: Context): Promise<KeyDirectory> {
  const current = section(ctx)
  const profiles: KeyDirectory['profiles'] = []
  for (const [id, raw] of Object.entries(current.providers)) {
    const config = asObject(raw)
    if (typeof config?.baseURL !== 'string' || typeof config.api !== 'string') continue
    const key = typeof config.apiKeyEnv === 'string' ? await ctx.credentials.describe(credentialRef(config.apiKeyEnv)) : undefined
    profiles.push({
      id, name: typeof config.displayName === 'string' ? config.displayName : id,
      baseUrl: config.baseURL, api: config.api, hasKey: key?.configured === true,
      modelOptions: Object.fromEntries((Array.isArray(config.models) ? config.models : []).flatMap((model) => {
        const id = asObject(model)?.id
        return typeof id === 'string' ? [[id, modelOptionsOf(model)]] : []
      })),
      models: Array.isArray(config.models) ? config.models.flatMap((model) => {
        const item = asObject(model)
        return typeof item?.id === 'string' && !(Array.isArray(config.hiddenModels) && config.hiddenModels.includes(item.id))
          ? [item.id] : []
      }) : [],
    })
  }
  return { revision: current.revision, profiles }
}

/**
 * Discover model IDs using the draft key or the existing encrypted credential.
 * @param ctx - Owning Host or Client context providing the required services.
 * @param input - Validated draft or import plan including its optimistic settings revision.
 * @param signal - Caller cancellation for this asynchronous operation.
 * @returns the discovered model IDs, deduplicated and capped at 500.
 */
export async function discoverKeyModels(ctx: Context, input: KeyProfileInput, signal: AbortSignal): Promise<string[]> {
  const current = section(ctx)
  const config = input.id === undefined ? undefined : asObject(current.providers[input.id])
  const key = input.apiKey || (typeof config?.apiKeyEnv === 'string'
    ? (await ctx.credentials.resolve(credentialRef(config.apiKeyEnv)))?.value : undefined)
  if (!APIS.has(input.api)) throw new Error('Unsupported model protocol.')
  const models = await ctx.llm.discoverModels(NS, {
    baseURL: endpoint(input.baseUrl), api: input.api, ...key === undefined ? {} : { apiKey: key },
  }, signal)
  return [...new Set(models.map(model => model.id))].slice(0, 500)
}

/**
 * Preserve advanced fields on existing routes while saving the Hemi connection fields.
 * @param ctx - Owning Host or Client context providing the required services.
 * @param input - Validated draft or import plan including its optimistic settings revision.
 */
export async function saveKeyProfile(ctx: Context, input: KeyProfileInput): Promise<void> {
  const current = section(ctx)
  if (input.revision !== current.revision) throw new Error('Configuration changed. Reopen the connection and retry.')
  const id = input.id ?? `hemi-key-${randomUUID()}`
  const previous = asObject(current.providers[id])
  if (input.id !== undefined && previous === undefined) throw new Error('This connection was removed.')
  if (input.name.trim() === '' || input.name.length > 128 || !APIS.has(input.api)) throw new Error('Invalid connection.')
  const baseURL = endpoint(input.baseUrl)
  const ids = [...new Set(input.models.map(model => model.trim()))]
  if ((ids.length === 0 && input.id === undefined) || ids.length > 500 || ids.some(model => model === '' || model.length > 256)) {
    throw new Error('Choose at least one valid model.')
  }
  if (input.apiKey !== undefined && (input.apiKey.length > 4096 || /[\r\n]/.test(input.apiKey))) throw new Error('Invalid API key.')
  const oldModels = Array.isArray(previous?.models) ? previous.models : []
  const models = ids.map((id) => {
    const previousModel = asObject(oldModels.find(raw => asObject(raw)?.id === id))
    const options = input.modelOptions?.[id]
    return { ...(options === undefined ? previousModel : applyModelOptions(previousModel, options)), id }
  })
  // New references allow a failed settings write to leave the prior credential intact.
  const newRef = input.apiKey ? credentialRef(`HEMI_KEY_${randomUUID().replaceAll('-', '_').toUpperCase()}`) : undefined
  if (newRef !== undefined) await ctx.credentials.set(newRef, input.apiKey ?? '')
  try {
    await ctx.settings.mutate(NS, [{
      op: 'set', path: ['providers', id], value: {
        ...previous, displayName: input.name.trim(), baseURL, api: input.api,
        ...newRef === undefined ? {} : { apiKeyEnv: newRef },
        hiddenModels: ids.length === 0 ? oldModels.flatMap((model) => {
          const value = asObject(model)?.id
          return typeof value === 'string' ? [value] : []
        }) : [],
        models: ids.length === 0 ? oldModels : models,
      },
    }], current.revision)
  } catch (error) {
    const saved = asObject(section(ctx).providers[id])
    if (newRef !== undefined && saved?.apiKeyEnv !== newRef) await ctx.credentials.unset(newRef)
    throw error
  }
}

/**
 * Remove the selected route without affecting other connections sharing a credential.
 * @param ctx - Owning Host or Client context providing the required services.
 * @param id - Exact operation, token or connection ID selected by the caller.
 * @param revision - Settings revision observed when the edit began.
 */
export async function removeKeyProfile(ctx: Context, id: string, revision: number): Promise<void> {
  const current = section(ctx)
  if (asObject(current.providers[id]) === undefined) throw new Error('This connection was removed.')
  await ctx.settings.mutate(NS, [{ op: 'unset', path: ['providers', id] }], revision)
}
