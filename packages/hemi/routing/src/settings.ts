/**
 * Host-owned settings and routing service for Hemi role routing. Root-scope
 * `TypertRemoteService` owning the `hemi-routing-settings` namespace: the
 * main route, the per-role route table, and the per-Session auto/fixed
 * preference. The settings card writes the volatile config through the
 * standard settings pipeline; the per-Session mode is one path-addressed
 * preference saved through the same pipeline, and the preset-scope
 * `hemi-routing` plugin reads everything through the domain getters below
 * when it plans turns and binds `hemi_delegate`. No Hemi session events are
 * recorded; plain Session logs stay readable by every harness build.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Volatile } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type { HemiRoleId, HemiRoutingMode, RoleRoutes, Route } from './types.ts'
import { HEMI_ROLE_IDS, LEGACY_ROLE_IDS } from './types.ts'

/** Cordis plugin name; also the settings namespace and profile entry id. */
export const name = 'hemi-routing-settings'

/** Profile entry id used for settings-pipeline writes. */
export const SETTINGS_NAMESPACE = 'hemi-routing-settings'

/** Stable Hemi routing failure. */
export class HemiRoutingError extends HarnessError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'HemiRoutingError'
  }
}

/** Settings forms rehydrate this schema from JSON, which cannot carry transforms. */
const RouteSchema = z.object({
  provider: z.string().min(1).required(),
  model: z.string().min(1).required(),
  reasoningEffort: z.string(),
})

/** Known role ids the roles schema accepts: canonical plus legacy spellings. */
const ROLE_KEY_SCHEMA = z.union([
  z.const('explorer'), z.const('oracle'), z.const('fixer'), z.const('designer'),
  z.const('research'), z.const('review'), z.const('execution'), z.const('design'),
])

/** Plugin config: the main route, the role table, and the per-Session modes. */
export interface Config {
  /** Auto routing's main route; `null` or absent until configured. */
  main: Volatile<Route | null>
  /** Role routes keyed by canonical or legacy id; absent roles follow main. */
  roles: Volatile<Record<string, Route>>
  /** Auto-routing preference per root Session id; absent means fixed. */
  sessionModes: Volatile<Record<string, boolean>>
}

/** Runtime schema; volatile so the settings card writes it live. */
export const Config = z.object({
  main: z.union([z.const(null), RouteSchema]).volatile(),
  roles: z.dict(RouteSchema, ROLE_KEY_SCHEMA).default({}).volatile(),
  sessionModes: z.dict(z.boolean()).default({}).volatile(),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Hemi routing settings and mode owner. */
    hemiRoutingSettings: HemiRoutingSettingsService
  }
}

/** Route a delegation will hard-bind, or parent inheritance. */
export type DelegationRoute = { readonly kind: 'bound'; readonly route: Route } | { readonly kind: 'inherit' }

/** Per-turn routing plan: mode and config captured at the turn's first claimed message. */
export interface TurnSnapshot {
  /** Mode when this turn was planned; it governs the whole turn. */
  readonly mode: HemiRoutingMode
  /** Main route captured at planning; `null` while unconfigured. */
  readonly main: Route | null
  /** Role routes captured at planning. */
  readonly roles: RoleRoutes
}

/** One root Session's unsettled routing-mode write: in flight or failed. */
interface PendingWrite {
  /** Identity of the newest registered write; older settlements ignore. */
  readonly token: number
  /** Stored value the newest registered write targets. */
  readonly desired: boolean
  /** Whether the newest write still runs or has failed. */
  status: 'writing' | 'failed'
  /** Failure detail when `status` is `'failed'`. */
  message?: string
}

/**
 * Validate and detach one stored route value. Config arrives through the
 * schema above, so this guards direct constructions and stale references:
 * unknown fields, empty provider/model, or a non-string effort fail loud
 * instead of silently degrading the role to follow-main.
 * @param value - stored route candidate.
 * @param where - config path naming the candidate in errors.
 * @returns the detached canonical route.
 */
function normalizeRoute(value: unknown, where: string): Route {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HemiRoutingError(`${where} must be an object with provider and model`, 'HEMI_ROUTING_INVALID_CONFIG')
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== 'provider' && key !== 'model' && key !== 'reasoningEffort') {
      throw new HemiRoutingError(`${where} has unknown field "${key}"`, 'HEMI_ROUTING_INVALID_CONFIG')
    }
  }
  const { provider, model, reasoningEffort } = record
  if (typeof provider !== 'string' || provider === '') {
    throw new HemiRoutingError(`${where}.provider must be a non-empty string`, 'HEMI_ROUTING_INVALID_CONFIG')
  }
  if (typeof model !== 'string' || model === '') {
    throw new HemiRoutingError(`${where}.model must be a non-empty string`, 'HEMI_ROUTING_INVALID_CONFIG')
  }
  if (reasoningEffort != null && typeof reasoningEffort !== 'string') {
    throw new HemiRoutingError(`${where}.reasoningEffort must be a string`, 'HEMI_ROUTING_INVALID_CONFIG')
  }
  if (reasoningEffort === '' || reasoningEffort == null) return { provider, model }
  return { provider, model, reasoningEffort }
}

/**
 * Validate the stored role table, mapping the four legacy role ids onto their
 * canonical roles and rejecting unknown ids or a legacy/canonical conflict.
 * @param value - stored roles candidate.
 * @returns the canonical role table.
 */
function normalizeRoles(value: unknown): RoleRoutes {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HemiRoutingError('roles must be an object keyed by role id', 'HEMI_ROUTING_INVALID_CONFIG')
  }
  const roles: RoleRoutes = {}
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined) continue
    const canonical = HEMI_ROLE_IDS.includes(key as HemiRoleId)
      ? key as HemiRoleId
      : Object.hasOwn(LEGACY_ROLE_IDS, key) ? LEGACY_ROLE_IDS[key as keyof typeof LEGACY_ROLE_IDS] : undefined
    if (canonical === undefined) {
      throw new HemiRoutingError(`roles has unknown role id "${key}"`, 'HEMI_ROUTING_INVALID_CONFIG')
    }
    if (roles[canonical] !== undefined) {
      throw new HemiRoutingError(`roles defines both legacy and canonical routes for "${canonical}"`, 'HEMI_ROUTING_INVALID_CONFIG')
    }
    roles[canonical] = normalizeRoute(raw, `roles.${key}`)
  }
  return roles
}

/**
 * Validate the stored session mode table as a detached copy of booleans.
 * @param value - stored sessionModes candidate.
 * @returns session id to auto preference.
 */
function normalizeSessionModes(value: unknown): Record<string, boolean> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HemiRoutingError('sessionModes must be an object of session id to boolean', 'HEMI_ROUTING_INVALID_CONFIG')
  }
  const modes: Record<string, boolean> = {}
  for (const [id, enabled] of Object.entries(value)) {
    if (typeof enabled !== 'boolean') {
      throw new HemiRoutingError(`sessionModes["${id}"] must be a boolean`, 'HEMI_ROUTING_INVALID_CONFIG')
    }
    modes[id] = enabled
  }
  return modes
}

/** Convert one route's optional effort into the branded selection form. */
function toSelection(route: Route): { provider: string; model: string; reasoningEffort?: ReturnType<typeof ReasoningEffortId> } {
  return {
    provider: route.provider,
    model: route.model,
    ...route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) },
  }
}

/** Settings namespace service and Remote owner for Hemi routing. */
export class HemiRoutingSettingsService extends TypertRemoteService {
  static inject = ['llm', 'settings', 'subagents']

  static Config = Config

  private readonly turnSnapshots = new WeakMap<Agent, TurnSnapshot>()
  /** Step routing mode per root, captured synchronously at each step's pre-step. */
  private readonly stepModes = new WeakMap<Agent, HemiRoutingMode>()
  /** Root sessions whose routing-mode write is in flight or failed. */
  private readonly pendingWrites = new Map<SessionId, PendingWrite>()
  /** Newest registered write token per root session. */
  private readonly writeTokens = new Map<SessionId, number>()
  /** Serialized write chain per root session; links always settle fulfilled. */
  private readonly writeQueues = new Map<SessionId, Promise<void>>()
  /** Set during unload; new routing-mode writes are refused afterwards. */
  private stopped = false
  /** Session id currently selecting through this service; see {@linkcode prepareTurn}. */
  private internalSelection: SessionId | undefined

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'hemiRoutingSettings')
  }

  protected [Service.init](): void {
    const ctx = this.ctx
    this.readMain()
    this.currentRoles()
    ctx.effect(() => ctx.on('internal/config', (fiber, next) => {
      const raw: unknown = next()
      if (fiber !== ctx.fiber) return raw
      const candidate = Config(raw as Parameters<typeof Config>[0])
      const main = candidate.main.get()
      if (main != null) normalizeRoute(main, 'main')
      normalizeRoles(candidate.roles.get())
      return raw
    }), 'hemi-routing: validate routing config')
    ctx.effect(() => () => { this.stopWrites() }, 'hemi-routing: stop settings submissions')
    ctx.effect(() => ctx.on('agent/before-user-model-selection', async (agent) => {
      if (agent.session.header.origin !== 'subagent' && ctx.subagents.rootOf(agent) === agent) {
        await this.setEnabled(agent, false)
      }
      return undefined
    }), 'hemi-routing: explicit model selection')
    ctx.effect(() => ctx.on('session/event', (session, event) => {
      this.observeSelection(session.id, session.header.origin, event)
    }), 'hemi-routing: selection observer')
  }

  /**
   * Stop submitting settings changes. ConfigEditor owns an accepted transaction
   * and reconciles Loader fibers before it settles, so this fiber cannot join
   * that transaction from its own cleanup. Callers still await the save result;
   * unloading never acknowledges an unsettled save as persisted.
   */
  private stopWrites(): void {
    this.stopped = true
    if (this.pendingWrites.size > 0) {
      this.ctx.logger.warn('hemi-routing: unloading with unsettled mode changes; saving is not confirmed. Reopen the conversation and check its routing mode before continuing.')
    }
  }

  /**
   * Read the configured main route as a detached copy.
   * @returns the route, or `null` while unconfigured.
   * @throws {HemiRoutingError} on malformed stored config.
   */
  currentMain(): Route | null {
    return this.readMain()
  }

  private readMain(): Route | null {
    const raw: unknown = this.config.main.get()
    if (raw === null || raw === undefined) return null
    return normalizeRoute(raw, 'main')
  }

  /**
   * Read the canonical role table as a detached copy.
   * @returns routes per canonical role; absent roles are missing keys.
   * @throws {HemiRoutingError} on malformed or unknown stored role config.
   */
  currentRoles(): RoleRoutes {
    return normalizeRoles(this.config.roles.get())
  }

  /**
   * Read the saved auto preference of one root Session.
   * @param sessionId - exact root Session identity.
   * @returns the saved preference; absent means fixed.
   */
  private readSessionModes(): Record<string, boolean> {
    return normalizeSessionModes(this.config.sessionModes.get())
  }

  /**
   * Effective routing mode of one root Session: the saved preference, with an
   * unsettled write already counting as its target's opposite — an auto exit
   * in flight or failed reads fixed, so no later claim re-selects the main
   * model underneath the user's recorded selection, and an enable that has
   * not settled yet routes nothing.
   * @param sessionId - exact root Session identity.
   * @returns the effective mode.
   */
  modeOfSession(sessionId: SessionId): HemiRoutingMode {
    if (this.pendingWrites.has(sessionId)) return 'fixed'
    return this.readSessionModes()[sessionId] === true ? 'auto' : 'fixed'
  }

  /**
   * Effective routing mode of the tree `agent` belongs to.
   * @param agent - exact live member of the tree.
   * @returns the root Session's effective mode.
   */
  modeOf(agent: Agent): HemiRoutingMode {
    return this.modeOfSession(this.ctx.subagents.rootOf(agent).id)
  }

  /**
   * Resolve the route one `hemi_delegate` call hard-binds for `role`. Role
   * routing applies only when the turn was planned in auto mode and the
   * delegating step still runs in auto mode: a manual model selection between
   * steps switches later delegations to the selected route, while steps
   * already prepared and delegations already dispatched keep their routes.
   * Main and role routes come from the turn's plan; without a plan (for
   * example immediately after a host restart) the live values decide.
   * @param parent - exact live delegating agent.
   * @param role - preset role id.
   * @returns the bound route, or parent inheritance.
   */
  routeForDelegation(parent: Agent, role: HemiRoleId): DelegationRoute {
    const root = this.ctx.subagents.rootOf(parent)
    const plan = this.turnSnapshots.get(root)
    const stepMode = this.stepModes.get(root) ?? this.modeOfSession(root.id)
    const routed = plan === undefined ? stepMode : plan.mode === 'auto' && stepMode === 'auto' ? 'auto' : 'fixed'
    if (routed !== 'auto') return { kind: 'inherit' }
    const route = plan === undefined
      ? this.currentRoles()[role] ?? this.readMain()
      : plan.roles[role] ?? plan.main
    return route === null ? { kind: 'inherit' } : { kind: 'bound', route }
  }

  /**
   * Capture the routing mode of the step about to run, synchronously before
   * the step proceeds. Called from the preset plugin's `agent/pre-step`
   * listener for the root agent only; descendant and subagent trees route
   * nothing. Also plans the turn lazily when no claimed message planned it,
   * for example a resumed turn whose claim was empty.
   * @param agent - exact live root agent about to run one step.
   */
  captureStep(agent: Agent): void {
    if (this.ctx.subagents.rootOf(agent) !== agent) return
    const mode = this.modeOfSession(agent.id)
    this.stepModes.set(agent, mode)
    if (this.turnSnapshots.has(agent)) return
    this.turnSnapshots.set(agent, { mode, main: this.readMain(), roles: this.currentRoles() })
  }

  /**
   * Fail-closed reason for the step about to run, or `null`. Auto mode with
   * no configured main blocks the model call instead of silently falling back
   * to a stale route, and a failed routing-mode write blocks until a manual
   * mode switch confirms the saved state.
   * @param agent - exact live member of the tree.
   * @returns why the next step must be rejected, or `null` to proceed.
   */
  blockedReason(agent: Agent): string | null {
    const root = this.ctx.subagents.rootOf(agent)
    const pending = this.pendingWrites.get(root.id)
    if (pending !== undefined && pending.status === 'failed') {
      return `saving the routing mode change failed (${pending.message ?? 'unknown error'}); switch auto routing manually to retry`
    }
    if (this.modeOfSession(root.id) === 'auto' && this.readMain() === null) {
      return 'auto routing requires a configured main model before this conversation can continue'
    }
    return null
  }

  /**
   * Plan one root's turn: capture the turn's mode/main/roles snapshot, and in
   * auto mode select the configured main model before the loop reads the
   * step's selection. The synchronous {@linkcode internalSelection} guard
   * marks the plugin's own selection so {@linkcode observeSelection} does not
   * mistake it for a user choice. Auto mode without a main records the plan
   * and selects nothing; the preset plugin then blocks the step.
   * @param root - exact live root agent of a non-subagent Session.
   */
  prepareTurn(root: Agent): void {
    const snapshot: TurnSnapshot = {
      mode: this.modeOfSession(root.id),
      main: this.readMain(),
      roles: this.currentRoles(),
    }
    this.turnSnapshots.set(root, snapshot)
    this.stepModes.delete(root)
    if (snapshot.mode !== 'auto' || snapshot.main === null) return
    this.internalSelection = root.id
    try {
      root.model.select(toSelection(snapshot.main))
    } finally {
      this.internalSelection = undefined
    }
  }

  /**
   * React to one recorded model selection: a selection this service did not
   * make while the root Session is in auto mode exits auto. The exit counts
   * synchronously — a turn claimed before the write settles plans fixed and
   * re-selects no main model over the user's new selection — and the
   * preference write is serialized with every other routing-mode write of the
   * Session. A failed write stays visible and blocks the next step until a
   * manual switch retries it; a new user selection never retries a failed
   * write on its own.
   * @param sessionId - Session whose log grew.
   * @param origin - the Session's recorded origin.
   * @param event - the appended event.
   */
  private observeSelection(sessionId: SessionId, origin: string | undefined, event: { type: string }): void {
    if (event.type !== 'model/selection') return
    if (this.internalSelection === sessionId) return
    if (origin === 'subagent') return
    const pending = this.pendingWrites.get(sessionId)
    // A failed write waits for a manual retry, and a queued exit already
    // covers this selection. An enable still in flight counts as auto: the
    // user's selection supersedes it before the preference lands.
    if (pending !== undefined && (pending.status === 'failed' || !pending.desired)) return
    if (pending === undefined && this.readSessionModes()[sessionId] !== true) return
    const write = this.queueModeWrite(sessionId, false)
    if (write === undefined) {
      this.ctx.logger.warn(`hemi-routing: session ${sessionId} left auto mode, but the settings service is shutting down; the preference was not saved`)
      return
    }
    // The exit write has no caller to reject: the failure is recorded in the
    // unsettled-write state and logged there, and the next step reports it.
    write.catch(() => {})
  }

  /**
   * Register and enqueue one routing-mode preference write. Writes for one
   * Session run in registration order — a later manual save always lands
   * after an earlier in-flight write — and a write's settlement updates the
   * unsettled-write bookkeeping only while its token is still the newest, so
   * a stale failure can never overwrite a newer successful save. The queue
   * link always settles fulfilled; the returned promise is the write itself
   * and rejects when persistence fails.
   * @param sessionId - root Session whose preference is written.
   * @param enabled - stored preference value.
   * @returns the dispatched write, or `undefined` during unload.
   */
  private queueModeWrite(sessionId: SessionId, enabled: boolean): Promise<void> | undefined {
    if (this.stopped) return undefined
    const token = (this.writeTokens.get(sessionId) ?? 0) + 1
    this.writeTokens.set(sessionId, token)
    this.pendingWrites.set(sessionId, { token, desired: enabled, status: 'writing' })
    const previous = this.writeQueues.get(sessionId) ?? Promise.resolve()
    const settled = Promise.withResolvers<void>()
    const settings = this.ctx.settings
    const logger = this.ctx.logger
    const run = async (): Promise<void> => {
      let failure: unknown
      try {
        if (this.stopped) throw new HemiRoutingError('routing settings unloaded before the change was submitted', 'HEMI_ROUTING_SAVE_FAILED')
        await settings.mutate(SETTINGS_NAMESPACE, [{ op: 'set', path: ['sessionModes', sessionId], value: enabled }])
      } catch (error: unknown) {
        failure = error
      }
      if (this.writeTokens.get(sessionId) === token) {
        if (failure === undefined) {
          this.pendingWrites.delete(sessionId)
        } else {
          const message = failure instanceof Error ? failure.message
            : typeof failure === 'string' ? failure : 'the settings write was rejected'
          logger.error(`hemi-routing: saving the routing mode change for session ${sessionId} failed: ${message}`)
          this.pendingWrites.set(sessionId, { token, desired: enabled, status: 'failed', message })
        }
      }
      if (failure === undefined) settled.resolve()
      else settled.reject(failure)
    }
    const queued = previous.then(run, run).finally(() => {
      if (this.writeQueues.get(sessionId) === queued) this.writeQueues.delete(sessionId)
    })
    this.writeQueues.set(sessionId, queued)
    return settled.promise
  }

  /**
   * Save one root Session's routing mode preference. Only the root agent may
   * switch; enabling validates the main route and every configured role route
   * against the live LLM registry. The call resolves only after the settings
   * pipeline has persisted the preference — no optimistic success — and the
   * write is serialized after every earlier in-flight write of the same
   * Session, so concurrent switches land in call order. The mode flips in
   * memory at registration: an enable in flight routes nothing until it
   * settles, and in-flight requests plus accepted delegations keep their
   * routes either way.
   * @param agent - exact live root whose tree receives the selection.
   * @param enabled - `true` selects auto routing, `false` returns to fixed.
   * @param signal - cancellation checked before the preference is written.
   * @throws when called by a descendant, validation fails, or the save fails.
   */
  @Remote
  async setEnabled(agent: Agent, enabled: boolean, signal?: AbortSignal): Promise<void> {
    const root = this.ctx.subagents.rootOf(agent)
    if (root !== agent) throw new HemiRoutingError('change the routing mode from the root Session', 'HEMI_ROUTING_LEAD_REQUIRED')
    signal?.throwIfAborted()
    if (enabled) await this.assertAutoReady(signal)
    signal?.throwIfAborted()
    const needsWrite = this.pendingWrites.has(root.id) || this.modeOfSession(root.id) !== (enabled ? 'auto' : 'fixed')
    if (!needsWrite) return
    const write = this.queueModeWrite(root.id, enabled)
    if (write === undefined) {
      throw new HemiRoutingError('saving the routing mode failed: the settings service is shutting down', 'HEMI_ROUTING_SAVE_FAILED')
    }
    try {
      await write
    } catch (error: unknown) {
      throw new HemiRoutingError(
        `saving the routing mode failed: ${error instanceof Error ? error.message : String(error)}`,
        'HEMI_ROUTING_SAVE_FAILED',
        { cause: error },
      )
    }
  }

  /**
   * Assert every route auto routing needs resolves through the live LLM
   * registry before the mode is saved.
   * @param signal - cancellation while resolving adapter capabilities.
   */
  private async assertAutoReady(signal: AbortSignal | undefined): Promise<void> {
    const main = this.readMain()
    if (main === null) {
      throw new HemiRoutingError('auto routing requires a configured main model', 'HEMI_ROUTING_MAIN_REQUIRED')
    }
    const routes = [main, ...Object.values(this.currentRoles())]
    for (const route of routes) {
      try {
        await this.ctx.llm.resolveCallConfig(toSelection(route), signal)
      } catch (error: unknown) {
        throw new HemiRoutingError(
          `route "${route.provider}/${route.model}" does not resolve: ${error instanceof Error ? error.message : String(error)}`,
          'HEMI_ROUTING_ROUTE_UNRESOLVED',
          { cause: error },
        )
      }
    }
  }
}

export default HemiRoutingSettingsService
