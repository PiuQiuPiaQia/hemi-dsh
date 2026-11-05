/** Commit the old Hemi New API browser import into the Harness model and credential stores. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { asObject } from './response.ts'
import type { NewApiBrowserCommit, NewApiBrowserCommitResult, NewApiImportReceipt } from './types.ts'

const NS = 'llm-pi-ai'

function operationDigest(id: string): string {
  if (!/^pi-[a-z0-9]{1,24}-[a-z0-9]{1,24}$/.test(id)) throw new Error('Invalid New API import operation.')
  return createHash('sha256').update(id).digest('hex')
}

function keyOf(operationId: string) {
  return credentialKey('hemi-model-access', `new-api-${operationDigest(operationId)}`)
}

function providerPrefix(operationId: string): string {
  return `mpi-${operationDigest(operationId).slice(0, 10)}-`
}

function refOf(provider: string, planHash: string) {
  return credentialRef(`${provider.toUpperCase().replaceAll('-', '_')}_${planHash.toUpperCase()}_API_KEY`)
}

function sectionOf(ctx: Context) {
  const section = ctx.settings.describe().find(entry => entry.ns === NS)
  if (section === undefined) throw new Error('The Harness model settings are unavailable.')
  return { revision: section.revision, providers: asObject(asObject(section.value)?.providers) ?? {} }
}

function decodeReceipt(value: unknown, operationId: string): NewApiImportReceipt | null {
  const record = asObject(value)
  if (record?.operationId !== operationId || typeof record.planHash !== 'string'
    || !Array.isArray(record.providerIds) || !Array.isArray(record.modelKeys)
    || !record.providerIds.every(id => typeof id === 'string') || !record.modelKeys.every(key => typeof key === 'string')) return null
  return { operationId, planHash: record.planHash, providerIds: record.providerIds, modelKeys: record.modelKeys }
}

function committedRoutes(ctx: Context, receipt: NewApiImportReceipt): boolean {
  const { providers } = sectionOf(ctx)
  return receipt.providerIds.length > 0 && receipt.providerIds.every((provider) => {
    return asObject(providers[provider])?.apiKeyEnv === refOf(provider, receipt.planHash)
  })
}

/**
 * Recover a receipt after the route write, including a restart between route and receipt writes.
 * @param ctx - Owning Host or Client context providing the required services.
 * @param operationId - Recoverable desktop operation ID.
 * @returns the saved operation receipt, or null when no committed import is found.
 */
export async function findBrowserReceipt(ctx: Context, operationId: string): Promise<NewApiImportReceipt | null> {
  const key = keyOf(operationId)
  const stored = await ctx.credentials.readRecord(key)
  const value = stored?.kind === 'grant' ? asObject(stored.payload) : undefined
  const receipt = decodeReceipt(value?.receipt, operationId)
  if (receipt === null) return null
  if (value?.committed === true) return receipt
  if (!committedRoutes(ctx, receipt)) return null
  await ctx.credentials.modifyRecord(key, () => Promise.resolve({ kind: 'grant', payload: { receipt, committed: true } }))
  return receipt
}

/**
 * Ensure configuration is present before the desktop coordinator dispatches the remote create.
 * @param ctx - Owning Host or Client context providing the required services.
 */
export function browserImportReady(ctx: Context): void {
  sectionOf(ctx)
}

/**
 * Save all selected routes in one settings mutation after staging their credentials.
 * @param ctx - Owning Host or Client context providing the required services.
 * @param input - Validated draft or import plan including its optimistic settings revision.
 * @returns the committed model routes and durable import receipt.
 */
export async function commitBrowserImport(ctx: Context, input: NewApiBrowserCommit): Promise<NewApiBrowserCommitResult> {
  const prefix = providerPrefix(input.operationId)
  if (!/^[a-f0-9]{64}$/.test(input.planHash) || input.providers.length < 1 || input.providers.length > 2) {
    throw new Error('Invalid New API import plan.')
  }
  const entries = input.providers.map((provider, index) => {
    const { name, baseUrl, api, deterministicId: id } = provider
    const url = new URL(baseUrl)
    if (id !== `${prefix}${index}` || name.trim() === '' || name.length > 128
      || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.search || url.hash
      || (api !== 'openai-completions' && api !== 'anthropic-messages')
      || provider.models.length === 0 || provider.models.length > 500
      || !/^[\w-]{8,512}$/.test(provider.apiKey)) throw new Error('Invalid New API import route.')
    const models = [...new Set(provider.models.map(model => model.model))]
    if (models.some(model => model.trim() === '' || model.length > 256)) throw new Error('Invalid New API model ID.')
    return {
      route: { id, name, baseUrl, api, models: models.map(model => ({ model })) },
      reference: refOf(id, input.planHash), apiKey: provider.apiKey,
    }
  })
  const routes = entries.map(entry => entry.route)
  const receipt: NewApiImportReceipt = {
    operationId: input.operationId,
    planHash: input.planHash,
    providerIds: routes.map(route => route.id),
    modelKeys: routes.flatMap(route => route.models.map(model => `${route.id}/${model.model}`)),
  }
  const existing = await findBrowserReceipt(ctx, receipt.operationId)
  if (existing !== null) {
    if (existing.planHash !== receipt.planHash) throw new Error('This import operation already committed another plan.')
    return { receipt: existing, providers: routes }
  }

  const key = keyOf(receipt.operationId)
  await ctx.credentials.modifyRecord(key, (record) => {
    const current = record?.kind === 'grant' ? decodeReceipt(asObject(record.payload)?.receipt, input.operationId) : null
    if (current !== null && current.planHash !== receipt.planHash) throw new Error('This import operation is tied to another plan.')
    return Promise.resolve(record === undefined ? { kind: 'grant', payload: { receipt, committed: false } } : undefined)
  })
  const section = sectionOf(ctx)
  if (routes.some(route => Object.hasOwn(section.providers, route.id))) throw new Error('A New API provider ID is already in use.')
  for (const { reference, apiKey } of entries) await ctx.credentials.set(reference, apiKey)
  try {
    await ctx.settings.mutate(NS, entries.map(({ route, reference }) => ({
      op: 'set', path: ['providers', route.id], value: {
        displayName: route.name,
        baseURL: route.baseUrl,
        api: route.api,
        apiKeyEnv: reference,
        models: route.models.map(model => ({ id: model.model })),
      },
    })), section.revision)
  } catch (error: unknown) {
    if (!committedRoutes(ctx, receipt)) throw error
  }
  await ctx.credentials.modifyRecord(key, () => Promise.resolve({ kind: 'grant', payload: { receipt, committed: true } }))
  return { receipt, providers: routes }
}
