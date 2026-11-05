/** Config normalization, legacy migration, mode saves, and unsettled-write handling. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import HemiRoutingSettingsService, { HemiRoutingError } from '../src/settings.ts'
import type { Route } from '../src/types.ts'
import { ScriptedAdapter, textResponse } from './mock-llm.ts'
import { MutableRoutingSettings } from './settings-stub.ts'
import type { RoutingConfigDocument } from './settings-stub.ts'
import { mountWorkingDirectoryFixture } from './working-directory.ts'

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Direct instance bypassing plugin config resolution, like the Team tests. */
class DirectService extends HemiRoutingSettingsService {
  initialize(): void {
    this[Service.init]()
  }
}

interface Host {
  ctx: Context
  service: DirectService
  settings: MutableRoutingSettings
  lead: Agent
}

/** Full base mount without the preset plugin: settings stand-in, service, and a live lead agent. */
async function setup(
  initial: Partial<RoutingConfigDocument> = {},
): Promise<Host> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-hemi-routing-'))
  roots.push(storageRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  const settings = new MutableRoutingSettings(initial)
  settings.provide(ctx)
  const service = new DirectService(ctx, settings.config)
  service.initialize()
  const adapter = new ScriptedAdapter([textResponse('ok'), textResponse('ok')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const handle = await ctx.agents.create({ sessionId: SessionId('lead'), agentOptions: { provider: 'mock', model: 'mock' } })
  return { ctx, service, settings, lead: handle.agent }
}

/** Start one real local child of `parent` through the public subagent seam. */
async function spawnChild(ctx: Context, parent: Agent): Promise<{ child: Agent; dispose: () => Promise<void> }> {
  const provider = `hemi-routing-test-${randomUUID()}`
  const unregister = ctx.subagents.registerProvider({
    name: provider,
    capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: true },
    inheritsParentContext: false,
    prepareContinuable: () => Promise.resolve({}),
  })
  const activation = await ctx.subagents.startActivation({
    provider,
    label: 'child task',
    prompt: [{ type: 'text', text: 'child task' }],
    parent,
    agentOptions: { provider: 'mock', model: 'mock' },
    signal: new AbortController().signal,
    delivery: 'caller',
  })
  const child = ctx.agents.get(activation.childId)
  if (child === undefined) throw new Error('local child was not published to the agent registry')
  return {
    child,
    dispose: async () => {
      await activation.dispose()
      unregister()
    },
  }
}

const MAIN: Route = { provider: 'mock', model: 'main' }

describe('canonical config reads', () => {
  it('returns a detached canonical table and main route', async () => {
    const { service } = await setup({
      main: { provider: 'mock', model: 'main' },
      roles: { oracle: { provider: 'mock', model: 'oracle', reasoningEffort: '' } },
    })
    expect(service.currentMain()).toEqual({ provider: 'mock', model: 'main' })
    expect(service.currentRoles()).toEqual({ oracle: { provider: 'mock', model: 'oracle' } })
  })

  it('defaults main to null and roles to empty', async () => {
    const { service } = await setup()
    expect(service.currentMain()).toBeNull()
    expect(service.currentRoles()).toEqual({})
  })
})

describe('legacy config mapping', () => {
  it('maps research/review/execution/design onto canonical roles losslessly', async () => {
    const { service } = await setup({
      roles: {
        research: { provider: 'mock', model: 'explorer-model', reasoningEffort: 'low' },
        review: { provider: 'mock', model: 'oracle-model' },
        execution: { provider: 'mock', model: 'fixer-model' },
        design: { provider: 'mock', model: 'designer-model' },
      },
    })
    expect(service.currentRoles()).toEqual({
      explorer: { provider: 'mock', model: 'explorer-model', reasoningEffort: 'low' },
      oracle: { provider: 'mock', model: 'oracle-model' },
      fixer: { provider: 'mock', model: 'fixer-model' },
      designer: { provider: 'mock', model: 'designer-model' },
    })
  })

  it('retains stored legacy keys and session preferences when starting', async () => {
    const initial = {
      main: MAIN,
      roles: { research: { provider: 'mock', model: 'old-explorer' } },
      sessionModes: { 'kept-session': true },
    }
    const { service, settings } = await setup(initial)
    expect(service.currentRoles()).toEqual({ explorer: { provider: 'mock', model: 'old-explorer' } })
    expect(settings.snapshot()).toEqual(initial)
    expect(settings.attempts.mutate).toBe(0)
  })
})

describe('malformed config fails loud', () => {
  /** Service whose getters run without activation; malformed config never initializes. */
  function bareService(config: Partial<RoutingConfigDocument>): DirectService {
    const ctx = new Context()
    contexts.push(ctx)
    const settings = new MutableRoutingSettings(config)
    return new DirectService(ctx, settings.config)
  }

  it('rejects unknown role ids instead of dropping them to follow-main', async () => {
    const service = bareService({ roles: { writer: { provider: 'mock', model: 'x' } } })
    expect(() => service.currentRoles()).toThrow(HemiRoutingError)
    expect(() => service.currentRoles()).toThrow(/unknown role id "writer"/)
  })

  it('rejects a legacy and canonical route for the same role', async () => {
    const service = bareService({
      roles: {
        research: { provider: 'mock', model: 'legacy' },
        explorer: { provider: 'mock', model: 'canonical' },
      },
    })
    expect(() => service.currentRoles()).toThrow(/both legacy and canonical/)
  })

  it('rejects empty provider, empty model, and unknown route fields', () => {
    const emptyProvider = bareService({ roles: { oracle: { provider: '', model: 'x' } } })
    expect(() => emptyProvider.currentRoles()).toThrow(/provider/)
    const emptyModel = bareService({ main: { provider: 'mock', model: '' } })
    expect(() => emptyModel.currentMain()).toThrow(/model/)
    // A runtime-only extra field: the variable widens the static type, and the
    // validator under test must still reject the unknown member.
    const withExtraField: Route & { maxTokens: number } = { provider: 'mock', model: 'x', maxTokens: 5 }
    const extraField = bareService({ roles: { oracle: withExtraField } })
    expect(() => extraField.currentRoles()).toThrow(/unknown field "maxTokens"/)
  })
})

describe('setEnabled validation', () => {
  it('refuses enabling without a configured main route', async () => {
    const { service, lead } = await setup({ roles: { oracle: { provider: 'mock', model: 'o' } } })
    await expect(service.setEnabled(lead, true)).rejects.toMatchObject({ code: 'HEMI_ROUTING_MAIN_REQUIRED' })
    expect(service.modeOf(lead)).toBe('fixed')
  })

  it('refuses enabling when the main provider has no adapter', async () => {
    const { service, lead } = await setup({ main: { provider: 'missing', model: 'main' } })
    await expect(service.setEnabled(lead, true)).rejects.toMatchObject({ code: 'HEMI_ROUTING_ROUTE_UNRESOLVED' })
  })

  it('refuses enabling when a role route or its effort does not resolve', async () => {
    const roleProviderMissing = await setup({
      main: { provider: 'mock', model: 'main' },
      roles: { oracle: { provider: 'missing', model: 'oracle' } },
    })
    await expect(roleProviderMissing.service.setEnabled(roleProviderMissing.lead, true))
      .rejects.toMatchObject({ code: 'HEMI_ROUTING_ROUTE_UNRESOLVED' })
    const effortUnsupported = await setup({
      main: { provider: 'mock', model: 'main' },
      roles: { oracle: { provider: 'mock', model: 'oracle', reasoningEffort: 'max' } },
    })
    await expect(effortUnsupported.service.setEnabled(effortUnsupported.lead, true))
      .rejects.toMatchObject({ code: 'HEMI_ROUTING_ROUTE_UNRESOLVED' })
  })

  it('saves auto and fixed modes and skips writes when the stored mode matches', async () => {
    const { service, settings, lead } = await setup({ main: MAIN })
    await service.setEnabled(lead, true)
    expect(service.modeOf(lead)).toBe('auto')
    expect(settings.snapshot().sessionModes).toEqual({ lead: true })
    await service.setEnabled(lead, true)
    expect(settings.writes.mutate).toBe(1)
    await service.setEnabled(lead, false)
    expect(service.modeOf(lead)).toBe('fixed')
    expect(settings.snapshot().sessionModes).toEqual({ lead: false })
  })

  it('resolves only after the pipeline has persisted the preference', async () => {
    const { service, settings, lead } = await setup({ main: MAIN })
    settings.plan({ hold: true })
    const enabling = service.setEnabled(lead, true)
    await vi.waitFor(() => { expect(settings.attempts.mutate).toBe(1) })
    expect(settings.writes.mutate).toBe(0)
    settings.release()
    await enabling
    expect(settings.snapshot().sessionModes).toEqual({ lead: true })
  })

  it('rejects a descendant caller and an aborted signal', async () => {
    const { ctx, service, lead } = await setup({ main: MAIN })
    await service.setEnabled(lead, true)
    const child = await spawnChild(ctx, lead)
    try {
      await expect(service.setEnabled(child.child, true)).rejects.toMatchObject({ code: 'HEMI_ROUTING_LEAD_REQUIRED' })
      const aborted = AbortSignal.abort(new Error('stop'))
      await expect(service.setEnabled(lead, true, aborted)).rejects.toThrow(/stop/)
    } finally {
      await child.dispose()
    }
  })
})

describe('auto exits through recorded selections', () => {
  it('marks the exit synchronously and persists it through the pipeline', async () => {
    const { service, settings, lead } = await setup({ main: MAIN })
    await service.setEnabled(lead, true)
    lead.model.select({ provider: 'mock', model: 'user-model' })
    expect(service.modeOf(lead)).toBe('fixed')
    await vi.waitFor(() => { expect(settings.snapshot().sessionModes).toEqual({ lead: false }) })
  })

  it('keeps auto when the selection repeats the current route', async () => {
    const { service, settings, lead } = await setup({ main: MAIN })
    await service.setEnabled(lead, true)
    // Plan the turn so the plugin's own main selection is the current route.
    service.prepareTurn(lead)
    const selections = lead.session.snapshotEvents().filter(event => event.type === 'model/selection').length
    lead.model.select({ provider: 'mock', model: MAIN.model })
    expect(lead.session.snapshotEvents().filter(event => event.type === 'model/selection').length).toBe(selections)
    expect(service.modeOf(lead)).toBe('auto')
    expect(settings.attempts.mutate).toBe(1)
  })

  it('exits an enable that is still in flight, landing the exit after it', async () => {
    const { service, settings, lead } = await setup({ main: MAIN })
    settings.plan({ hold: true })
    const enabling = service.setEnabled(lead, true)
    await vi.waitFor(() => { expect(settings.attempts.mutate).toBe(1) })
    lead.model.select({ provider: 'mock', model: 'user-model' })
    expect(service.modeOf(lead)).toBe('fixed')
    settings.release()
    await enabling
    await vi.waitFor(() => { expect(settings.snapshot().sessionModes).toEqual({ lead: false }) })
    expect(settings.attempts.mutate).toBe(2)
  })
})

describe('unsettled and failed mode writes', () => {
  it('ignores a stale write settlement instead of overwriting a newer save', async () => {
    const { service, settings, lead } = await setup({ main: MAIN, sessionModes: { lead: true } })
    // Hold the exit write; a manual re-enable registers a newer write while it runs.
    settings.plan({ hold: true, failure: new Error('disk full') })
    lead.model.select({ provider: 'mock', model: 'user-model' })
    const reenabling = service.setEnabled(lead, true)
    await Promise.resolve()
    // The exit write settles after the re-enable registered: the failure belongs
    // to a stale token and must neither block nor un-fix the Session.
    settings.release()
    await reenabling
    expect(service.blockedReason(lead)).toBeNull()
    expect(service.modeOf(lead)).toBe('auto')
    expect(settings.attempts.mutate).toBe(2)
    expect(settings.snapshot().sessionModes).toEqual({ lead: true })
  })

  it('fails visibly, blocks the next step, and recovers through a manual switch', async () => {
    const { service, settings, lead } = await setup({ main: MAIN })
    await service.setEnabled(lead, true)
    settings.plan({ failure: new Error('disk full') })
    lead.model.select({ provider: 'mock', model: 'user-model' })
    await vi.waitFor(() => { expect(service.blockedReason(lead)).toMatch(/disk full/) })
    expect(service.modeOf(lead)).toBe('fixed')
    // A later selection never retries the failed write on its own.
    lead.model.select({ provider: 'mock', model: 'another-model' })
    await Promise.resolve()
    expect(settings.attempts.mutate).toBe(2)
    // The manual switch retries and clears the block.
    await service.setEnabled(lead, false)
    expect(service.blockedReason(lead)).toBeNull()
    expect(settings.snapshot().sessionModes).toEqual({ lead: false })
  })

  it('stops submissions without waiting for a ConfigEditor-owned transaction during unload', async () => {
    const { ctx, service, settings, lead } = await setup({ main: MAIN })
    await service.setEnabled(lead, true)
    settings.plan({ hold: true })
    const saving = service.setEnabled(lead, false)
    await vi.waitFor(() => { expect(settings.attempts.mutate).toBe(2) })
    await ctx.fiber.dispose()
    // An already accepted settings transaction retains its own outcome; unload
    // cannot wait for a reconciliation that includes this same fiber.
    settings.release()
    await saving
    expect(settings.snapshot().sessionModes).toEqual({ lead: false })
    expect(settings.attempts.mutate).toBe(2)
    await expect(service.setEnabled(lead, true)).rejects.toThrow()
  })
})
