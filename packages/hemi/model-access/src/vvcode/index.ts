/** VVCode account authorization and per-group syncs own their credentials and recoverable token creation. */
import { createHash, randomUUID } from 'node:crypto'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { asObject } from '../response.ts'
import type { ModelOptions, Subscription, VvcodeDirectory, VvcodeGroup, VvcodeGroupView, VvcodeModelSelection, VvcodeUsage } from '../types.ts'
import type { VvcodeConfig } from './settings.ts'
import { mountVvcodeAdapter, VVCODE_PROVIDER, isVvcodeProvider, vvcodeProviderId } from './adapter.ts'
import type { VvcodeApi, VvcodeGroupConnection, VvcodeLegacyConnection, VvcodeRoute } from './adapter.ts'
import { loginVvcode } from './oauth.ts'
import type { VvcodeClient, VvcodeGrant } from './types.ts'
import { createVvcodeClient } from './api.ts'
import { writeModelOptions } from '../model-options.ts'
import type { ProtocolReasoningDefault } from '../protocol-reasoning.ts'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'

/** VVCode account authorization is owned by this plugin, not the Pi credential format. */
export const VVCODE_KEY = credentialKey('hemi-model-access', 'vvcode')

/** One group's unobserved or partially observed token creation, recoverable by exact name. */
interface SavedGrantPending {
  /** Unique creation name; the recovery key for an unknown outcome. */
  name: string
  /** Server token ID once any answer revealed it; present means verification can resume. */
  tokenId?: number
  /** Key reference of the binding this creation replaces, unset after retirement. */
  retireRef?: string
}

/** One group connection a save prepared from its key but has not committed to settings yet. */
interface PreparedGroup {
  /** Exact application-authorized group the binding is written under. */
  group: string
  /** Live group metadata carried into the binding atomically with the selection. */
  liveGroup: VvcodeGroup
  /** Verified server token ID the key was revealed from. */
  tokenId: number
  /** Credential reference the key is stored under at commit time. */
  ref: CredentialRef
  /** Revealed model API key, held only until the credential write lands. */
  apiKey: string
  /** Provider route of the binding, reusing a replaced binding's route. */
  provider: string
  /** Key catalog with each model's site-declared protocol. */
  models: readonly { id: string; api: VvcodeApi }[]
  /** The pending record the preparation adopted, cleared after the commit. */
  pending: SavedGrantPending | undefined
  /** The binding this preparation replaces, when the group was already bound under another route. */
  previous: VvcodeGroupConnection | null
  /** Enabled model IDs the save commits for this group. */
  selected: readonly string[]
}

/** Stored grant payload; version 2 records pending creations per group. */
interface SavedGrant extends VvcodeGrant {
  version: 2
  origin: string
  invalidated?: boolean
  pending: Record<string, SavedGrantPending>
}

/** Settings access remains in the plugin that owns the subscription adapter. */
export interface VvcodeSettings {
  /** Deployment reasoning policy shared with ordinary API connections. */
  reasoningFallbacks: Record<string, ProtocolReasoningDefault>
  vvcode: VvcodeConfig
  vvcodeConnection: Volatile<VvcodeLegacyConnection | null | undefined>
  vvcodeConnections: Volatile<Record<string, VvcodeGroupConnection>>
  subscriptionModels: Volatile<Record<string, string[]>>
  subscriptionModelOptions: Volatile<Record<string, Record<string, ModelOptions>>>
}

function failure(reason: 'sign-in-required' | 'account-changed' | 'group-unavailable' | 'creation-unknown' | 'operation-failed' | 'busy') {
  return new RemoteError('hemi/vvcode-failed', 'The VVCode account operation could not complete. Reconnect or retry the selected group.', { reason })
}

/** The raw settings values one routes snapshot derived from, for change detection between reads. */
interface VvcodeRouteMemo {
  connections: Record<string, VvcodeGroupConnection>
  legacy: VvcodeLegacyConnection | null
  options: Record<string, Record<string, ModelOptions>>
  routes: readonly VvcodeRoute[]
}

/**
 * A group name must stay a plain own property of the settings map: names that could collide
 * with object prototype paths are refused before they ever become settings keys.
 */
function isSafeGroupKey(name: string): boolean {
  return name !== '' && name.length <= 128 && !/[\u0000-\u001f\u007f]/.test(name) && name !== '__proto__'
}



/** One bound group whose key catalog a save re-read to validate models past its saved catalog. */
interface RefreshedCatalog {
  /** The binding the fresh catalog replaces. */
  record: VvcodeGroupConnection
  /** Live group metadata carried into the binding atomically with the selection. */
  liveGroup: VvcodeGroup
  /** The key catalog just read, with each model's site-declared protocol. */
  models: readonly { id: string; api: VvcodeApi }[]
  /** Enabled model IDs the save commits for this group. */
  wanted: readonly string[]
}

/**
 * Manage one VVCode account with independent per-group bindings. Each group owns a stable
 * provider route, key reference, catalog and selection; a failed group operation retains every
 * other group's data. Directory reads and single-group refreshes are read-only listing
 * operations that never create, verify, or reveal a token, so the model directory is browsable
 * without any connection; a token is only prepared when a save enables a group that has no
 * binding yet, and a dispatched creation remains recorded per group for exact-name recovery
 * and is never repeated automatically.
 */
export class VvcodeSubscription {
  private changing = false
  private closed = false
  private readonly lifetime = new AbortController()
  private readonly tasks = new Set<Promise<unknown>>()
  private readonly refresh: () => void
  private readonly origin: string
  /**
   * Monotonic sequence of dispatched live group reads. The sequence is drawn when the request
   * is sent, not when its answer arrives, so site truth is ordered by request time and a late
   * answer from an older request carries the older sequence.
   */
  private liveSeq = 0
  /**
   * Sequence of the newest accepted live observation. Acceptance advances it whether or not
   * that observation's conclusions could be persisted, so an unpersisted failure still
   * outranks every older answer.
   */
  private appliedLiveSeq = 0
  /** Groups a successful read confirmed absent whose revocation is not stored yet; they keep refusing to serve. */
  private unpersistedRevoked = new Set<string>()

  /**
   * Replace the in-memory revocation hold. The routes memo keys on settings values, which the
   * hold does not touch, so every hold change also invalidates that memo to force a republish.
   */
  private replaceHold(next: Set<string>): void {
    this.unpersistedRevoked = next
    this.routeMemo = undefined
  }
  private routeMemo: VvcodeRouteMemo | undefined
  /**
   * The authorized groups and read-only directory model IDs of the current account's last
   * successful groups read, isolated per account so a changed sign-in starts from an empty
   * cache. The cache only feeds browse rows and local provider resolution; saved selections
   * and key catalogs never derive from it.
   */
  private directoryCache: {
    userId: string
    groups: readonly VvcodeGroup[]
    models: Map<string, readonly string[]>
  } | undefined

  /** Record the authorized groups of one successful groups read for the current account. */
  private noteAuthorized(grant: SavedGrant, live: readonly VvcodeGroup[]): void {
    const userId = String(grant.userId)
    this.directoryCache = {
      userId,
      groups: live,
      models: this.directoryCache?.userId === userId ? this.directoryCache.models : new Map<string, readonly string[]>(),
    }
  }

  /**
   * The authorized group one derived provider route names in the local cache, when any. The
   * derivation includes the account, so another account's cached groups never resolve.
   */
  private cachedGroupFor(provider: string): VvcodeGroup | undefined {
    const cache = this.directoryCache
    if (cache === undefined) return undefined
    return cache.groups.find(item => isSafeGroupKey(item.name)
      && vvcodeProviderId(this.origin, cache.userId, item.name) === provider)
  }

  constructor(private readonly ctx: Context, private readonly config: VvcodeSettings) {
    const url = new URL(config.vvcode.origin)
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('VVCode requires an HTTPS site origin.')
    }
    this.origin = url.origin
    const publish = mountVvcodeAdapter(ctx, {
      origin: this.origin,
      reasoningDefaults: config.reasoningFallbacks,
      routes: () => this.routes(),
      requireAccount: async (provider) => {
        const grant = await this.read()
        if (grant === undefined || this.expired(grant)) {
          throw new LlmError('Sign in to VVCode again before using this subscription.', 'MISSING_CREDENTIAL')
        }
        const record = this.recordByProvider(provider)
        if (record === null || record.origin !== this.origin || record.userId !== String(grant.userId)
          || record.revoked === true || this.unpersistedRevoked.has(record.group)) {
          throw new LlmError('Choose a group for this VVCode account.', 'MISSING_CREDENTIAL')
        }
      },
    })
    this.refresh = () => { if (!this.closed) publish() }
    ctx.effect(() => async () => {
      this.closed = true
      this.lifetime.abort()
      await Promise.allSettled([...this.tasks])
    }, 'drain VVCode account operations before unloading')
    ctx.authorization.registerFlow({
      key: VVCODE_KEY, label: 'VVCode', methods: [{ id: 'oauth', label: 'VVCode' }],
      run: session => this.owned(async (signal) => {
        this.assertIdle()
        const previous = await this.read()
        if (previous !== undefined && previous.origin !== this.origin) throw failure('account-changed')
        const connection = this.connection()
        if (connection !== null && connection.origin !== this.origin) throw failure('account-changed')
        const grant = await loginVvcode({
          origin: this.origin, signal,
          notifyURL: (url) => { session.notify({ url, message: 'VVCode' }) },
          timeoutMs: config.vvcode.loginTimeoutMs, maxResponseBytes: config.vvcode.maxResponseBytes,
        })
        if (previous !== undefined && previous.userId !== grant.userId) throw failure('account-changed')
        if (!['profile:read', 'api_key:read', 'api_key:write', 'api_key:reveal'].every(scope => grant.scopes.includes(scope))) {
          throw failure('sign-in-required')
        }
        signal.throwIfAborted()
        const saved: SavedGrant = { ...grant, version: 2, origin: this.origin,
          pending: previous === undefined ? {} : previous.pending }
        await session.commit({ kind: 'grant', payload: saved })
        this.refresh()
      }, session.signal),
    })
  }

  private owned<T>(operation: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(failure('operation-failed'))
    const signal = AbortSignal.any([this.lifetime.signal, ...external === undefined ? [] : [external]])
    const task = Promise.resolve().then(() => { signal.throwIfAborted(); return operation(signal) })
    this.tasks.add(task)
    void task.then(() => { this.tasks.delete(task) }, () => { this.tasks.delete(task) })
    return task
  }

  /** Refuse overlapping group syncs, model changes, and account authorization. */
  assertIdle(): void {
    if (this.changing) throw failure('busy')
  }

  /** An omitted nullable setting is Schemastery's undefined value; explicit null also means no binding. */
  private connection(): VvcodeLegacyConnection | null {
    return this.config.vvcodeConnection.get() ?? null
  }

  private expired(grant: SavedGrant): boolean {
    return grant.expiresAt <= Date.now() || grant.invalidated === true || grant.origin !== this.origin
  }

  /**
   * Parse one stored grant payload. Version 1 carried a single pending creation and normalizes
   * into the per-group map; any other shape is a stored-state failure, never a fallback.
   */
  private parseGrant(payload: unknown): SavedGrant {
    const value = asObject(payload)
    const pending = asObject(value?.pending)
    const singlePending = value?.version === 1 && pending !== undefined ? pending : undefined
    if (value?.version !== 1 && value?.version !== 2 || typeof value.origin !== 'string' || typeof value.accessToken !== 'string'
      || !/^nap_[A-Za-z0-9_-]+$/.test(value.accessToken) || !Number.isSafeInteger(value.userId) || Number(value.userId) < 1
      || typeof value.expiresAt !== 'number' || !Number.isSafeInteger(value.expiresAt)
      || !Array.isArray(value.scopes) || !value.scopes.every((scope): scope is string => typeof scope === 'string')
      || (value.invalidated !== undefined && typeof value.invalidated !== 'boolean')
      || (value.version === 2 && value.pending !== undefined && pending === undefined)) {
      throw failure('operation-failed')
    }
    const grantPending: Record<string, SavedGrantPending> = {}
    if (singlePending !== undefined) {
      if (typeof singlePending.name !== 'string' || typeof singlePending.group !== 'string'
        || (singlePending.tokenId !== undefined && (!Number.isSafeInteger(singlePending.tokenId) || Number(singlePending.tokenId) < 1))
        || (singlePending.retireRef !== undefined && typeof singlePending.retireRef !== 'string')) {
        throw failure('operation-failed')
      }
      grantPending[singlePending.group] = {
        name: singlePending.name,
        ...singlePending.tokenId === undefined ? {} : { tokenId: Number(singlePending.tokenId) },
        ...typeof singlePending.retireRef !== 'string' ? {} : { retireRef: singlePending.retireRef },
      }
    } else if (value.version === 2 && pending !== undefined) {
      for (const [group, entry] of Object.entries(pending)) {
        const record = asObject(entry)
        if (!isSafeGroupKey(group) || typeof record?.name !== 'string'
          || (record.tokenId !== undefined && (!Number.isSafeInteger(record.tokenId) || Number(record.tokenId) < 1))
          || (record.retireRef !== undefined && typeof record.retireRef !== 'string')) {
          throw failure('operation-failed')
        }
        grantPending[group] = {
          name: record.name,
          ...record.tokenId === undefined ? {} : { tokenId: Number(record.tokenId) },
          ...typeof record.retireRef !== 'string' ? {} : { retireRef: record.retireRef },
        }
      }
    }
    return { version: 2, origin: value.origin, accessToken: value.accessToken, userId: Number(value.userId),
      expiresAt: value.expiresAt, scopes: value.scopes,
      ...value.invalidated === undefined ? {} : { invalidated: value.invalidated },
      pending: grantPending }
  }

  private async read(): Promise<SavedGrant | undefined> {
    const record = await this.ctx.credentials.readRecord(VVCODE_KEY)
    return record?.kind === 'grant' ? this.parseGrant(record.payload) : undefined
  }

  private async account(): Promise<SavedGrant> {
    const grant = await this.read()
    if (grant === undefined || this.expired(grant)) throw failure('sign-in-required')
    return grant
  }

  private client(grant: SavedGrant) {
    return createVvcodeClient({ ...this.config.vvcode, origin: this.origin, accessToken: grant.accessToken, userId: grant.userId })
  }

  private async invalidate(error: unknown, accessToken: string | undefined): Promise<never> {
    const remote = remoteErrorOf(error)
    const expired = remote?.code === 'hemi/vvcode-management-auth-expired'
      || (remote?.code === 'hemi/vvcode-token-refused' && remote.details.status === 401)
    if (expired && accessToken !== undefined) {
      await this.ctx.credentials.modifyRecord(VVCODE_KEY, (current) => {
        const stored = current?.kind === 'grant' ? asObject(current.payload) : undefined
        if (stored?.accessToken !== accessToken) return Promise.resolve(undefined)
        return Promise.resolve({ kind: 'grant', payload: { ...stored, invalidated: true } })
      })
    }
    throw error
  }

  private guarded<T>(operation: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T> {
    this.assertIdle()
    this.changing = true
    return this.owned(async (signal) => {
      let accessToken: string | undefined
      try {
        const record = await this.ctx.credentials.readRecord(VVCODE_KEY)
        const raw = record?.kind === 'grant' ? asObject(record.payload)?.accessToken : undefined
        accessToken = typeof raw === 'string' ? raw : undefined
        signal.throwIfAborted()
        return await operation(signal)
      } catch (error) { return await this.invalidate(error, accessToken) }
    }, external).finally(() => { this.changing = false })
  }

  private async savePending(grant: SavedGrant, group: string, pending: SavedGrantPending | undefined): Promise<void> {
    await this.ctx.credentials.modifyRecord(VVCODE_KEY, (current) => {
      const stored = current?.kind === 'grant' ? this.parseGrant(current.payload) : undefined
      if (stored?.accessToken !== grant.accessToken) throw failure('sign-in-required')
      const nextPending = pending === undefined
        ? Object.fromEntries(Object.entries(stored.pending).filter(([name]) => name !== group))
        : { ...stored.pending, [group]: pending }
      return Promise.resolve({ kind: 'grant', payload: { ...stored, version: 2, pending: nextPending } })
    })
  }

  /**
   * Adopted bindings: the saved per-group map plus the legacy single-group binding synthesized
   * in until its one-time migration lands. Lookups use own-property checks so persisted group
   * names can never resolve through inherited object keys.
   */
  private records(): Record<string, VvcodeGroupConnection> {
    const connections = this.config.vvcodeConnections.get()
    const legacy = this.connection()
    if (legacy === null || !isSafeGroupKey(legacy.group) || Object.hasOwn(connections, legacy.group)) return connections
    const selected = (this.config.subscriptionModels.get().vvcode ?? [])
      .filter(id => legacy.models.some(model => model.id === id))
    return { ...connections, [legacy.group]: {
      origin: legacy.origin, group: legacy.group, userId: legacy.userId, tokenId: legacy.tokenId,
      apiKeyRef: legacy.apiKeyRef, provider: VVCODE_PROVIDER, models: legacy.models, selected,
    } }
  }

  private record(group: string): VvcodeGroupConnection | null {
    const connections = this.records()
    return (Object.hasOwn(connections, group) ? connections[group] : undefined) ?? null
  }

  private recordByProvider(provider: string): VvcodeGroupConnection | null {
    return Object.values(this.records()).find(record => record.provider === provider) ?? null
  }

  /**
   * Current provider routes with the identity of the raw settings values they derive from, so
   * repeated reads between committed changes republish the same snapshot.
   */
  private routes(): readonly VvcodeRoute[] {
    const connections = this.config.vvcodeConnections.get()
    const legacy = this.config.vvcodeConnection.get() ?? null
    const options = this.config.subscriptionModelOptions.get()
    const memo = this.routeMemo
    if (memo !== undefined && memo.connections === connections && memo.legacy === legacy && memo.options === options) {
      return memo.routes
    }
    const routes: VvcodeRoute[] = []
    for (const record of Object.values(this.records())) {
      if (record.revoked === true || this.unpersistedRevoked.has(record.group)) continue
      routes.push({ provider: record.provider, group: record.group, apiKeyRef: record.apiKeyRef,
        models: record.models, selected: record.selected, options: options[record.provider] ?? {} })
    }
    routes.sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0))
    this.routeMemo = { connections, legacy, options, routes }
    return routes
  }

  /**
    * Return connection facts without tokens; expired accounts retain their saved groups.
    * @returns the account's local connection state; group rows render from the directory.
    */
  async describe(): Promise<Subscription> {
    const grant = await this.read()
    const stale = grant !== undefined && Object.values(this.records())
      .some(record => record.origin !== this.origin || record.userId !== String(grant.userId))
    return { id: 'vvcode', name: 'VVCode', connected: grant !== undefined, quota: false, models: [],
      ...grant === undefined ? {} : { vvcode: { expiresAt: grant.expiresAt, expired: this.expired(grant) || stale } } }
  }

  /**
   * Distinguish owned subscription routes from similarly named manual API connections.
   * @param provider - Native LLM provider route ID.
   * @returns whether a saved VVCode group owns the route.
   */
  ownsProvider(provider: string): boolean {
    return this.recordByProvider(provider) !== null
  }

  /**
   * Read the saved selection of one group's provider without issuing any request.
   * @param provider - The legacy `vvcode` route or one `vvcode-group-…` route.
   * @returns the saved enabled model IDs; an empty array covers an unknown route.
   */
  selectedModels(provider: string): readonly string[] {
    return this.recordByProvider(provider)?.selected ?? []
  }

  /**
   * Read the account's wallet balance and active subscriptions in the site's display unit.
   * The read persists nothing and never blocks group selection; an expired account fails
   * before any request, and a management 401 invalidates the stored grant before rethrowing.
   * @param external - Caller cancellation, composed with plugin unloading.
   * @returns the usage report, with independent per-part failure states.
   */
  usage(external: AbortSignal): Promise<VvcodeUsage> {
    return this.owned(async (signal) => {
      const grant = await this.account()
      try { return await this.client(grant).usage(grant.scopes, signal) }
      catch (error) { return this.invalidate(error, grant.accessToken) }
    }, external)
  }

  /**
   * The read-only directory IDs cached for one group, falling back to the saved key catalog's
   * IDs when no directory read has reported the group yet.
   */
  private browseModels(group: string, record: VvcodeGroupConnection | null): readonly string[] {
    const cached = this.directoryCache?.models.get(group)
    if (cached !== undefined) return cached
    return (record?.models ?? []).map(model => model.id)
      .sort((a, b) => a.localeCompare(b))
  }

  /**
   * Build every group row: live metadata where the latest read supplied it, otherwise the last
   * saved values. Every authorized group exposes its read-only directory model IDs for
   * browsing; saved selections mark the enabled ones. Saved rows survive expiry and read
   * failures so local edits stay possible.
   */
  private groupViews(
    grant: SavedGrant | undefined, live: readonly VvcodeGroup[] | undefined, catalogErrors: ReadonlySet<string>,
  ): VvcodeGroupView[] {
    const connections = this.records()
    const liveByName = new Map((live ?? []).map(group => [group.name, group]))
    const pendingFor = (group: string): SavedGrantPending | undefined =>
      grant === undefined ? undefined : grant.pending[group]
    const rows: VvcodeGroupView[] = Object.entries(connections).map(([group, record]) => {
      const liveGroup = liveByName.get(group)
      const pending = pendingFor(group)
      const lost = record.revoked === true || this.unpersistedRevoked.has(group)
        || (live !== undefined && liveGroup === undefined)
      return {
        name: group,
        desc: liveGroup?.desc ?? record.desc ?? '',
        ratio: liveGroup !== undefined ? liveGroup.ratio : record.ratio ?? null,
        provider: record.provider,
        state: lost ? 'unavailable'
          : pending !== undefined && pending.tokenId === undefined ? 'creation-unknown' : 'ready',
        hasConnection: true,
        catalogError: catalogErrors.has(group),
        models: this.browseModels(group, record).map(id => ({ id, enabled: record.selected.includes(id) })),
      }
    })
    if (live !== undefined) {
      for (const liveGroup of live) {
        if (Object.hasOwn(connections, liveGroup.name)) continue
        const pending = pendingFor(liveGroup.name)
        rows.push({
          name: liveGroup.name, desc: liveGroup.desc, ratio: liveGroup.ratio,
          provider: vvcodeProviderId(this.origin, grant?.userId ?? '', liveGroup.name),
          state: pending !== undefined && pending.tokenId === undefined ? 'creation-unknown' : 'not-synced',
          hasConnection: false,
          catalogError: catalogErrors.has(liveGroup.name),
          models: this.browseModels(liveGroup.name, null).map(id => ({ id, enabled: false })),
        })
      }
    }
    return rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }

  /**
   * Read the account's groups and, for each authorized group, its read-only model directory,
   * then merge everything with every saved binding. The reads never create a token or key, so
   * the whole directory is browsable without any connection. A successful groups read persists
   * only group metadata — revocation, ratio and description — for the bindings of the same
   * account and origin, re-checking the stored grant before the commit so a late response from
   * a rotated account never lands. A failed per-group model read keeps that group's previous
   * IDs and is reported on its row, and a failed read leaves every saved row unchanged.
   * @param external - Caller cancellation, composed with plugin unloading.
   * @returns the directory with its aggregate state and one row per known group.
   */
  async directory(external: AbortSignal): Promise<VvcodeDirectory> {
    return this.owned(async (signal) => {
      const grant = await this.read()
      if (grant === undefined || this.expired(grant)) {
        return { state: 'sign-in-required', groups: this.groupViews(grant, undefined, new Set()) }
      }
      const accessToken = grant.accessToken
      // The sequence is drawn before dispatch: an older request whose answer arrives late
      // carries older site truth than a request dispatched after it, whatever the arrival order.
      const seq = this.nextLiveSeq()
      let live: readonly VvcodeGroup[]
      try {
        live = await this.client(grant).listGroups(signal)
      } catch (error) {
        if (signal.aborted) throw error
        try { await this.invalidate(error, accessToken) } catch { /* The original failure is reported below. */ }
        const accountGone = remoteErrorOf(error)?.code === 'hemi/vvcode-management-auth-expired'
        return accountGone
          ? { state: 'sign-in-required', groups: this.groupViews(grant, undefined, new Set()) }
          : { state: 'unavailable', groups: this.groupViews(grant, undefined, new Set()) }
      }
      this.noteAuthorized(grant, live)
      let failures: ReadonlyMap<string, unknown>
      try {
        failures = await this.readGroupModels(grant, live, signal)
      } catch (error) {
        if (signal.aborted) throw error
        try { await this.invalidate(error, accessToken) } catch { /* The original failure is reported below. */ }
        return { state: 'sign-in-required', groups: this.groupViews(grant, undefined, new Set()) }
      }
      let adopted: boolean
      try {
        adopted = await this.persistGroupMetadata(accessToken, live, seq)
      } catch {
        // The live observation stays in the rows, but the directory may not report a clean
        // `ready` while a confirmed conclusion is not durable; serving stays withheld.
        return { state: 'unavailable', groups: this.groupViews(grant, live, new Set(failures.keys())) }
      }
      if (!adopted) {
        // A newer read owns the authority: report the durable local rows, not this read's
        // superseded live observation, dressed up as a fresh result.
        return { state: 'unavailable', groups: this.groupViews(grant, undefined, new Set(failures.keys())) }
      }
      return { state: 'ready', groups: this.groupViews(grant, live, new Set(failures.keys())) }
    }, external)
  }

  /**
   * Read the read-only model directory of every authorized group, one group at a time, and
   * refresh the in-memory cache. A failed group keeps its previous cached IDs and is reported
   * through the returned map; only caller cancellation and an account-expiring answer
   * propagate, so one group's failure never clears another group's data or a revocation.
   * @param grant - The valid grant the reads run under.
   * @param live - The authorized groups just read; only these names are queried.
   * @param signal - Caller cancellation.
   * @param only - Restrict the reads to one group, as the single-group refresh does.
   * @returns the failed groups with the errors their reads threw.
   */
  private async readGroupModels(
    grant: SavedGrant, live: readonly VvcodeGroup[], signal: AbortSignal, only?: string,
  ): Promise<ReadonlyMap<string, unknown>> {
    const userId = String(grant.userId)
    const cache = this.directoryCache
    const models = cache?.userId === userId ? cache.models : new Map<string, readonly string[]>()
    const client = this.client(grant)
    const failures = new Map<string, unknown>()
    for (const group of live) {
      if (only !== undefined ? group.name !== only : !isSafeGroupKey(group.name)) continue
      try {
        const ids = await client.groupModels(group.name, signal)
        models.set(group.name, [...ids].sort((a, b) => a.localeCompare(b)))
      } catch (error) {
        if (signal.aborted) throw error
        if (remoteErrorOf(error)?.code === 'hemi/vvcode-management-auth-expired') throw error
        failures.set(group.name, error)
      }
    }
    this.directoryCache = {
      userId,
      groups: this.directoryCache?.userId === userId ? this.directoryCache.groups : [],
      models,
    }
    return failures
  }

  /**
   * Persist confirmed group metadata from one successful live read. A synthesized legacy
   * binding first migrates into the collection in the same write, so every metadata path
   * targets a complete stored record. The commit re-reads the latest bindings and updates
   * only `revoked`, `ratio` and `desc` fields, so a racing write never replaces another
   * group's selection, key reference, or catalog, and a live answer that was already
   * superseded by a newer one persists nothing.
   */
  private async persistGroupMetadata(accessToken: string, live: readonly VvcodeGroup[], seq: number): Promise<boolean> {
    const grant = await this.read()
    if (grant === undefined || grant.accessToken !== accessToken || this.expired(grant)) return false
    if (!this.acceptLive(seq)) return false
    // This observation is the operative authority from the moment it is accepted, whether or
    // not its conclusions can be stored: an older answer that settles later stays rejected,
    // and it can never clear the hold this read is about to engage on a failed persist.
    this.noteAppliedLive(seq)
    // Hold the observed absence immediately, so even the migration's republish below never
    // briefly revives a group this newest read no longer names.
    const absent = this.absentGroups(grant, live)
    this.replaceHold(absent)
    this.refresh()
    try {
      await this.migrate()
      // A newer read may have settled while this one was migrating; its conclusions win.
      if (!this.acceptLive(seq)) return false
      const changes = this.metadataChanges(grant, live)
      if (changes.length > 0) await this.ctx.settings.mutate('hemi-model-access', changes, this.settings().revision)
    } catch (error) {
      // The loss keeps refusing to serve while it cannot be stored. Only the newest
      // observation may shape the hold, so an older failing read never overwrites one
      // a newer read has already engaged.
      if (this.acceptLive(seq)) this.replaceHold(this.absentGroups(grant, live))
      throw error
    }
    // Clearing the hold again requires still being the newest authority: an older queued
    // write that settles here must not release what a newer read is holding. Adopted either
    // way, a zero-change read is still what keeps an older late answer from committing.
    if (this.acceptLive(seq)) this.replaceHold(new Set())
    this.refresh()
    return true
  }

  /** Draw the sequence for one live group read at the moment its request is dispatched. */
  private nextLiveSeq(): number {
    return ++this.liveSeq
  }

  /**
   * Whether this live read is still the newest answered one. An older answer that settles
   * after a newer one must never overwrite the newer conclusions, so its metadata is dropped.
   */
  private acceptLive(seq: number): boolean {
    return seq >= this.appliedLiveSeq
  }

  private noteAppliedLive(seq: number): void {
    this.appliedLiveSeq = Math.max(this.appliedLiveSeq, seq)
  }

  /**
   * The owned bindings of this account that the live read no longer names. Holding them from
   * acceptance onward keeps even an in-flight migration from briefly reviving a confirmed loss.
   */
  private absentGroups(grant: SavedGrant, live: readonly VvcodeGroup[]): Set<string> {
    const liveNames = new Set(live.map(group => group.name))
    return new Set(Object.values(this.records())
      .filter(record => record.origin === this.origin && record.userId === String(grant.userId)
        && !liveNames.has(record.group)).map(record => record.group))
  }

  /**
   * Compute the revocation and metadata changes one successful live read implies for every
   * binding of the same account, for merging into the caller's own atomic mutation.
   */
  private metadataChanges(grant: SavedGrant, live: readonly VvcodeGroup[]): SettingsPathOp[] {
    const liveByName = new Map(live.map(group => [group.name, group]))
    const changes: SettingsPathOp[] = []
    for (const [group, record] of Object.entries(this.records())) {
      if (record.origin !== this.origin || record.userId !== String(grant.userId) || !isSafeGroupKey(group)) continue
      const liveGroup = liveByName.get(group)
      const revoked = liveGroup === undefined
      if ((record.revoked ?? false) !== revoked) {
        changes.push({ op: 'set', path: ['vvcodeConnections', group, 'revoked'], value: revoked })
      }
      if (liveGroup === undefined) continue
      if (record.ratio !== liveGroup.ratio) changes.push({ op: 'set', path: ['vvcodeConnections', group, 'ratio'], value: liveGroup.ratio })
      if (record.desc !== liveGroup.desc) changes.push({ op: 'set', path: ['vvcodeConnections', group, 'desc'], value: liveGroup.desc })
    }
    return changes
  }

  private settings() {
    const section = this.ctx.settings.describe().find(entry => entry.ns === 'hemi-model-access')
    if (section === undefined) throw failure('operation-failed')
    return section
  }

  /**
   * Move the legacy single-group binding into the per-group collection and clear the legacy
   * settings, in one atomic mutation that keeps the old selection. Failures leave the legacy
   * fields in place; the adopted view keeps serving them and the next operation retries.
   */
  private async migrate(): Promise<void> {
    const legacy = this.connection()
    if (legacy === null || !isSafeGroupKey(legacy.group)) return
    const connections = this.config.vvcodeConnections.get()
    if (Object.hasOwn(connections, legacy.group)) return
    const selected = (this.config.subscriptionModels.get().vvcode ?? [])
      .filter(id => legacy.models.some(model => model.id === id))
    const section = this.settings()
    await this.ctx.settings.mutate('hemi-model-access', [
      { op: 'set', path: ['vvcodeConnections', legacy.group], value: {
        origin: legacy.origin, group: legacy.group, userId: legacy.userId, tokenId: legacy.tokenId,
        apiKeyRef: legacy.apiKeyRef, provider: VVCODE_PROVIDER, models: legacy.models, selected } },
      { op: 'unset', path: ['vvcodeConnection'] },
      { op: 'unset', path: ['subscriptionModels', 'vvcode'] },
    ], section.revision)
    this.refresh()
  }

  private async advertised(grant: SavedGrant, apiKey: string, signal: AbortSignal) {
    const client = this.client(grant)
    const catalog = await client.modelCatalog(apiKey, signal)
    const byId = new Map<string, VvcodeApi>()
    for (const item of catalog) {
      const declared = item.supportedEndpointTypes
      const api: VvcodeApi | undefined = declared.includes('openai') ? 'openai-completions'
        : declared.includes('anthropic') ? 'anthropic-messages'
          : declared.includes('openai-response') ? 'openai-responses' : undefined
      if (api !== undefined) byId.set(item.id, api)
    }
    return [...byId].map(([id, api]) => ({ id, api })).sort((a, b) => a.id.localeCompare(b.id))
  }

  /**
   * Refresh one group's directory entry after an explicit UI refresh: verify live
   * authorization, persist every binding's confirmed metadata, and re-read that group's
   * read-only model directory into the local authorized cache. The refresh never creates,
   * verifies, or reveals a token, so it also stays available for a group with a pending
   * unobserved creation. A group the live list no longer names is marked revoked in the same
   * mutation and stays revoked — requests keep failing — until a later successful read names
   * it again; a failed model read propagates so the caller can mark that row stale and retry.
   * @param group - Exact application-authorized group name.
   * @param external - Caller cancellation, including the directory reads.
   */
  async syncGroup(group: string, external: AbortSignal): Promise<void> {
    await this.guarded(async (signal) => {
      await this.migrate()
      const grant = await this.account()
      const client = this.client(grant)
      // Sequenced before dispatch so a late answer from an older request can never outrank a
      // newer request's site truth.
      const liveSeq = this.nextLiveSeq()
      const live = await client.listGroups(signal)
      this.noteAuthorized(grant, live)
      const liveGroup = live.find(item => item.name === group)
      if (liveGroup === undefined || !isSafeGroupKey(group)) {
        // The loss goes through the same verified persist path as the directory read, so its
        // hold engages and its sequence is adopted even when the conclusion cannot be stored.
        await this.persistGroupMetadata(grant.accessToken, live, liveSeq)
        throw failure('group-unavailable')
      }
      await this.persistGroupMetadata(grant.accessToken, live, liveSeq)
      const failures = await this.readGroupModels(grant, live, signal, group)
      const modelError = failures.get(group)
      // Every collected read failure is the read's own Error; anything else never reaches the map.
      if (modelError !== undefined) throw modelError instanceof Error ? modelError : failure('operation-failed')
    }, external)
  }

  /**
   * Refresh one group's live catalog without silently adding models or recreating its token.
   * A group the live list no longer names is marked revoked in the same mutation and stays
   * revoked — requests keep failing — until a later successful read names it again.
   * @param provider - The legacy `vvcode` route or one `vvcode-group-…` route.
   * @param external - Caller cancellation, composed with plugin unloading.
   * @returns supported model IDs advertised to the group's key.
   */
  async refreshCatalog(provider: string, external: AbortSignal): Promise<string[]> {
    return this.guarded(async (signal) => {
      await this.migrate()
      const grant = await this.account()
      const record = this.recordByProvider(provider)
      if (record === null || record.origin !== this.origin || record.userId !== String(grant.userId)) {
        throw failure('group-unavailable')
      }
      const client = this.client(grant)
      const liveSeq = this.nextLiveSeq()
      const live = await client.listGroups(signal)
      const liveGroup = live.find(group => group.name === record.group)
      if (liveGroup === undefined) {
        if (this.acceptLive(liveSeq)) {
          const section = this.settings()
          const changes = this.metadataChanges(grant, live)
          if (changes.length > 0) await this.ctx.settings.mutate('hemi-model-access', changes, section.revision)
          this.noteAppliedLive(liveSeq)
          this.refresh()
        }
        throw failure('group-unavailable')
      }
      const key = await this.ctx.credentials.resolve(credentialRef(record.apiKeyRef))
      if (key === undefined) throw failure('operation-failed')
      const models = await this.advertised(grant, key.value, signal)
      const section = this.settings()
      signal.throwIfAborted()
      // The catalog refresh carries the newest stored revocation: a superseded refresh cannot
      // clear a revocation the newest read confirmed after this refresh dispatched.
      const latest = this.recordByProvider(provider) ?? record
      const superseded = !this.acceptLive(liveSeq)
      await this.ctx.settings.mutate('hemi-model-access', [
        { op: 'set', path: ['vvcodeConnections', latest.group], value: {
          ...latest, models, ratio: liveGroup.ratio, desc: liveGroup.desc,
          // Same as the sync commit: a failed persist leaves the durable flag unset while
          // the hold already refuses the group, so the superseded merge weighs both.
          revoked: superseded && (latest.revoked === true || this.unpersistedRevoked.has(latest.group)) } },
        ...superseded ? [] : this.metadataChanges(grant, live),
      ], section.revision)
      this.noteAppliedLive(liveSeq)
      if (!superseded && this.unpersistedRevoked.delete(latest.group)) this.routeMemo = undefined
      this.refresh()
      return models.map(model => model.id)
    }, external)
  }

  /**
   * Add or remove one explicit selection of one group's provider. Addition verifies current
   * availability through a live catalog refresh and requires a valid account; a group without
   * a binding is prepared exactly as a modal save prepares it, so a real enable is what ever
   * creates a key. Removal stays local, so an expired account can still clear its saved
   * selections.
   * @param provider - The legacy `vvcode` route or one `vvcode-group-…` route.
   * @param model - Exact gateway model ID.
   * @param add - True to verify current availability and add; false to remove only the local selection.
   */
  async changeModel(provider: string, model: string, add: boolean): Promise<void> {
    if (add && this.recordByProvider(provider) === null) {
      await this.saveSelections([{ provider, models: [model] }], AbortSignal.timeout(this.config.vvcode.timeoutMs))
      return
    }
    if (add) await this.refreshCatalog(provider, AbortSignal.timeout(this.config.vvcode.timeoutMs))
    await this.guarded(async (signal) => {
      await this.migrate()
      const record = this.recordByProvider(provider)
      if (record === null || !isSafeGroupKey(record.group)) throw failure('group-unavailable')
      if (add) {
        await this.account()
        if (record.revoked === true || !record.models.some(item => item.id === model)) throw failure('group-unavailable')
      }
      const selected = add ? [...new Set([...record.selected, model])] : record.selected.filter(id => id !== model)
      const section = this.settings()
      signal.throwIfAborted()
      await this.ctx.settings.mutate('hemi-model-access', [
        { op: 'set', path: ['vvcodeConnections', record.group, 'selected'], value: selected },
      ], section.revision)
      this.refresh()
    })
  }

  /**
   * Read one bound group's live key catalog through its stored key, without recreating or
   * re-verifying the token. The read is a save's protocol authority when it enables models the
   * saved catalog does not list yet.
   */
  private async refreshedCatalog(
    grant: SavedGrant, record: VvcodeGroupConnection, signal: AbortSignal,
  ): Promise<readonly { id: string; api: VvcodeApi }[]> {
    const key = await this.ctx.credentials.resolve(credentialRef(record.apiKeyRef))
    if (key === undefined) throw failure('operation-failed')
    return this.advertised(grant, key.value, signal)
  }

  /**
   * Prepare one authorized group's connection for a save that enables it: confirm the account
   * identity, reuse a pending token's recorded ID, resume its exact-name verification, or
   * dispatch exactly one creation recorded for recovery; then verify the token live, reveal
   * its key, and read the key's catalog as the protocol authority. The group's selection is
   * validated against that catalog, so an unsupported model fails the whole save before
   * anything is committed. No setting or credential is written here; the caller commits
   * atomically and clears each group's pending record afterwards, so a failed save keeps the
   * pending ID for reuse instead of repeating a creation.
   */
  private async prepareGroupConnection(
    grant: SavedGrant, client: VvcodeClient, liveGroup: VvcodeGroup, wanted: readonly string[], signal: AbortSignal,
  ): Promise<PreparedGroup> {
    const group = liveGroup.name
    const identity = await client.self(signal)
    if (String(identity.id) !== String(grant.userId)) throw failure('account-changed')
    const previous = this.record(group)
    let tokenId: number
    const pending = grant.pending[group]
    if (previous !== null && previous.origin === this.origin && previous.userId === String(grant.userId)
      && pending === undefined) {
      tokenId = previous.tokenId
    } else {
      const next: SavedGrantPending = pending ?? { name: `hemi-dsh-${randomUUID()}`,
        ...previous === null ? {} : { retireRef: previous.apiKeyRef } }
      if (pending === undefined) {
        signal.throwIfAborted()
        await this.savePending(grant, group, next)
        if (signal.aborted) {
          await this.savePending(grant, group, undefined)
          signal.throwIfAborted()
        }
        try {
          const token = await client.createToken(next.name, group, signal,
            id => this.savePending(grant, group, { ...next, tokenId: id }))
          tokenId = token.id
        } catch (error) {
          if (remoteErrorOf(error)?.code === 'hemi/vvcode-token-refused') await this.savePending(grant, group, undefined)
          throw error
        }
        await this.savePending(grant, group, { ...next, tokenId })
      } else if (pending.tokenId !== undefined) {
        tokenId = pending.tokenId
      } else {
        const token = await client.findToken(pending.name, signal)
        if (token === undefined) throw failure('creation-unknown')
        if (token.group !== group || String(token.userId) !== String(grant.userId)) throw failure('account-changed')
        tokenId = token.id
        await this.savePending(grant, group, { ...pending, tokenId })
      }
    }
    const token = await client.getToken(tokenId, signal)
    if (token.group !== group || String(token.userId) !== String(grant.userId)) throw failure('account-changed')
    if (!token.enabled || (token.expiresAt !== undefined && token.expiresAt <= Date.now())) throw failure('group-unavailable')
    const apiKey = await client.tokenKey(tokenId, signal)
    const models = await this.advertised(grant, apiKey, signal)
    if (wanted.some(id => !models.some(model => model.id === id))) throw failure('group-unavailable')
    return {
      group, liveGroup, tokenId, apiKey,
      ref: credentialRef(`VVCODE_${createHash('sha256').update(JSON.stringify([this.origin, grant.userId, tokenId])).digest('hex').toUpperCase()}_API_KEY`),
      provider: previous?.provider ?? vvcodeProviderId(this.origin, grant.userId, group),
      models, pending, previous, selected: wanted,
    }
  }

  /**
   * Reject the whole save when any group it would add models to is revoked or held, so no
   * selection ever lands beside a confirmed loss. Callers re-run this immediately before their
   * commit, since a parallel read can confirm a loss while earlier awaited writes are in
   * flight.
   */
  private assertAddedGroupsLive(groups: readonly string[]): void {
    for (const group of groups) {
      if (this.record(group)?.revoked === true || this.unpersistedRevoked.has(group)) throw failure('group-unavailable')
    }
  }

  /**
   * Save the model selections of several groups in one atomic settings write, as the
   * connection modal commits on save. Every entry is resolved against its current binding
   * first: unknown or duplicate providers and additions to revoked or withheld groups reject
   * the whole call, and any addition requires a valid account, so nothing is ever
   * half-written. Any addition re-reads the authorized groups once and every added group must
   * still be authorized there — a group the site already removed rejects the whole save before
   * a key is prepared, and a loss a later read confirmed while the save was preparing rejects
   * it before the commit. Groups without a binding are prepared first — reusing the pending
   * token or its key reference, or dispatching exactly one recorded creation — and a selection
   * whose model the group's key catalog does not support fails the whole save before any
   * commit. A bound group enabling models past its saved catalog re-reads that key's live
   * catalog in the same save instead of rejecting an unknown ID. Removals stay local and
   * remain available on an expired account, and an unbound group the local authorized cache
   * names saved with nothing enabled is a no-op, so browsing never creates a key.
   * @param selections - One entry per changed group provider with its complete enabled list.
   * @param external - Caller cancellation; aborting before the commit writes nothing.
   */
  async saveSelections(selections: readonly VvcodeModelSelection[], external: AbortSignal): Promise<void> {
    await this.guarded(async (signal) => {
      await this.migrate()
      const targets = new Map<string, { group: string; models: readonly string[]; adds: boolean }>()
      const fresh: { provider: string; models: readonly string[] }[] = []
      const revalidated: { record: VvcodeGroupConnection; models: readonly string[] }[] = []
      for (const selection of selections) {
        const models = [...new Set(selection.models)]
        const record = this.recordByProvider(selection.provider)
        const duplicated = targets.has(selection.provider)
          || fresh.some(entry => entry.provider === selection.provider)
          || revalidated.some(entry => entry.record.provider === selection.provider)
        if (duplicated) throw failure('operation-failed')
        if (record === null || !isSafeGroupKey(record.group)) {
          if (models.length > 0) {
            fresh.push({ provider: selection.provider, models })
            continue
          }
          if (this.cachedGroupFor(selection.provider) === undefined) throw failure('group-unavailable')
          continue
        }
        const added = models.length > 0 && models.some(model => !record.selected.includes(model))
        if (added && (record.revoked === true || this.unpersistedRevoked.has(record.group))) {
          throw failure('group-unavailable')
        }
        if (models.length > 0 && models.some(model => !record.models.some(item => item.id === model))) {
          revalidated.push({ record, models })
          continue
        }
        targets.set(selection.provider, { group: record.group, models, adds: added })
      }
      const addedBound = [...targets.values()].filter(target => target.adds)
      if (addedBound.length === 0 && fresh.length === 0 && revalidated.length === 0) {
        const section = this.settings()
        signal.throwIfAborted()
        await this.ctx.settings.mutate('hemi-model-access', [...targets.values()].map(target => ({
          op: 'set' as const, path: ['vvcodeConnections', target.group, 'selected'], value: target.models,
        })), section.revision)
        this.refresh()
        return
      }
      const grant = await this.account()
      const client = this.client(grant)
      // One authorized-groups read covers the whole save: it is the application boundary every
      // added group must be found in and the live truth the committed metadata merges with.
      const liveSeq = this.nextLiveSeq()
      const live = await client.listGroups(signal)
      this.noteAuthorized(grant, live)
      const liveNames = new Set(live.map(item => item.name))
      const lostAdded = [...addedBound.map(target => target.group),
        ...revalidated.map(entry => entry.record.group)]
        .filter(group => !isSafeGroupKey(group) || !liveNames.has(group))
      if (lostAdded.length > 0) {
        // The confirmed loss goes through the verified persist path before the save rejects,
        // so the sequence is adopted, the hold stops the group's remaining selection, and the
        // selections themselves stay unchanged.
        await this.persistGroupMetadata(grant.accessToken, live, liveSeq)
        throw failure('group-unavailable')
      }
      const prepared: PreparedGroup[] = []
      const refreshed: RefreshedCatalog[] = []
      // One group is written by at most one entry: the legacy route and the derived route of
      // the same group in one save is an ambiguous input, not a combined edit.
      const writtenGroups = new Map<string, string>()
      for (const [provider, target] of targets) {
        if (writtenGroups.has(target.group)) throw failure('operation-failed')
        writtenGroups.set(target.group, provider)
      }
      for (const entry of revalidated) {
        if (writtenGroups.has(entry.record.group)) throw failure('operation-failed')
        writtenGroups.set(entry.record.group, entry.record.provider)
      }
      for (const entry of fresh) {
        const liveGroup = live.find(item => isSafeGroupKey(item.name)
          && vvcodeProviderId(this.origin, grant.userId, item.name) === entry.provider)
        if (liveGroup === undefined) throw failure('group-unavailable')
        if (writtenGroups.has(liveGroup.name)) throw failure('operation-failed')
        prepared.push(await this.prepareGroupConnection(grant, client, liveGroup, entry.models, signal))
      }
      for (const entry of revalidated) {
        const liveGroup = live.find(item => item.name === entry.record.group)
        if (liveGroup === undefined) throw failure('group-unavailable')
        const models = await this.refreshedCatalog(grant, entry.record, signal)
        if (entry.models.some(model => !models.some(item => item.id === model))) throw failure('group-unavailable')
        refreshed.push({ record: entry.record, liveGroup, models, wanted: entry.models })
      }
      // A read that confirmed a loss while this save was preparing wins: the whole save rejects
      // instead of writing its selection beside a revocation.
      const addedGroups = [...addedBound.map(target => target.group),
        ...revalidated.map(entry => entry.record.group), ...prepared.map(item => item.group)]
      this.assertAddedGroupsLive(addedGroups)
      const section = this.settings()
      signal.throwIfAborted()
      // One try owns the whole commit phase: the keys land before any binding, so a committed
      // binding never references a missing credential, and any failure unsets the references
      // no binding owns yet while every pending ID stays recorded, so a retry never re-creates.
      const freshRefs = new Set(prepared.map(item => item.ref))
      try {
        for (const item of prepared) await this.ctx.credentials.set(item.ref, item.apiKey)
        if (signal.aborted) {
          for (const item of prepared) {
            if (this.record(item.group)?.apiKeyRef !== item.ref) await this.ctx.credentials.unset(item.ref)
          }
          signal.throwIfAborted()
        }
        // A held key write can outlast a parallel read that confirms a loss: re-check every
        // added group immediately before the commit, so no selection lands beside a revocation.
        this.assertAddedGroupsLive(addedGroups)
        // This save verified every group live, but a superseded read loses to the newest
        // answer: a revocation confirmed after the save dispatched keeps those routes stopped.
        const superseded = !this.acceptLive(liveSeq)
        await this.ctx.settings.mutate('hemi-model-access', [
          ...prepared.map(item => ({ op: 'set' as const, path: ['vvcodeConnections', item.group], value: {
            origin: this.origin, group: item.group, tokenId: item.tokenId, userId: String(grant.userId),
            apiKeyRef: item.ref, provider: item.provider, models: item.models, selected: item.selected,
            ratio: item.liveGroup.ratio, desc: item.liveGroup.desc,
            // A failed persist leaves the durable flag unset while the hold already refuses
            // the group, so the superseded merge takes both signals into account.
            revoked: superseded && (this.record(item.group)?.revoked === true || this.unpersistedRevoked.has(item.group)) } })),
          ...refreshed.map(item => ({ op: 'set' as const, path: ['vvcodeConnections', item.record.group], value: {
            ...item.record, models: item.models, selected: [...item.wanted],
            ratio: item.liveGroup.ratio, desc: item.liveGroup.desc,
            revoked: superseded && (item.record.revoked === true || this.unpersistedRevoked.has(item.record.group)) } })),
          ...[...targets.values()].map(target => ({
            op: 'set' as const, path: ['vvcodeConnections', target.group, 'selected'], value: target.models })),
          ...superseded ? [] : this.metadataChanges(grant, live),
        ], section.revision)
        this.noteAppliedLive(liveSeq)
        if (!superseded) {
          for (const item of prepared) {
            if (this.unpersistedRevoked.delete(item.group)) this.routeMemo = undefined
          }
        }
      } catch (error) {
        for (const ref of freshRefs) {
          if (!Object.values(this.records()).some(record => record.apiKeyRef === ref)) {
            await this.ctx.credentials.unset(ref)
          }
        }
        throw error
      }
      this.refresh()
      for (const item of prepared) {
        const retireRef = item.pending?.retireRef
          ?? (item.previous !== null && item.previous.apiKeyRef !== item.ref ? item.previous.apiKeyRef : undefined)
        // A retired reference may have been adopted by another binding — a v1 pending recorded
        // the legacy group's key as the replacement's retiree, but the migration kept that key
        // serving its own group — so only a reference no binding points at is unset.
        if (retireRef !== undefined && retireRef !== item.ref
          && !Object.values(this.records()).some(record => record.apiKeyRef === retireRef)) {
          await this.ctx.credentials.unset(credentialRef(retireRef))
        }
        await this.savePending(grant, item.group, undefined)
      }
    }, external)
  }

  /**
   * Save one group model's editable options under the same exclusive write chain as group
   * syncs, so a concurrent sync cannot replace the binding between validation and commit.
   * @param provider - The legacy `vvcode` route or one `vvcode-group-…` route.
   * @param model - Exact model ID currently offered by that route.
   * @param options - Explicit overrides; omitted fields restore adapter defaults.
   * @param revision - Settings revision observed when the editor opened.
   */
  async saveOptions(provider: string, model: string, options: ModelOptions, revision: number): Promise<void> {
    await this.guarded(async () => {
      if (this.recordByProvider(provider) === null) throw failure('group-unavailable')
      await writeModelOptions(this.ctx, provider, model, options, revision, false)
      this.refresh()
    })
  }

  /**
   * Disconnect locally and clear every owned group's binding, key reference, selections and
   * model options, never manual API connections. The PAT has no permission to revoke itself;
   * its server-side authorization remains manageable on VVCode.
   */
  async disconnect(): Promise<void> {
    await this.guarded(async (signal) => {
      await this.migrate()
      const records = Object.values(this.records())
      const ownedOptions = Object.keys(this.config.subscriptionModelOptions.get())
        .filter(provider => isVvcodeProvider(provider))
      const section = this.settings()
      signal.throwIfAborted()
      await this.ctx.settings.mutate('hemi-model-access', [
        { op: 'set', path: ['vvcodeConnections'], value: {} },
        { op: 'unset', path: ['vvcodeConnection'] },
        { op: 'unset', path: ['subscriptionModels', 'vvcode'] },
        ...ownedOptions.map(provider => ({ op: 'unset' as const, path: ['subscriptionModelOptions', provider] })),
      ], section.revision)
      this.replaceHold(new Set())
      this.refresh()
      for (const record of records) await this.ctx.credentials.unset(credentialRef(record.apiKeyRef))
      await this.ctx.credentials.deleteRecord(VVCODE_KEY)
    })
  }
}
