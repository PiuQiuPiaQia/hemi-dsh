/** New-conversation preference inheritance: recent defaults, guards, failures, and commit ordering. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import HemiRoutingSettingsService from '../src/settings.ts'
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

/** Direct instance bypassing plugin config resolution, like the settings tests. */
class DirectService extends HemiRoutingSettingsService {
  initialize(): void {
    this[Service.init]()
  }
}

interface Host {
  ctx: Context
  service: DirectService
  settings: MutableRoutingSettings
  config: MutableRoutingSettings['config']
  lead: Agent
}

/** Base mount without the preset plugin: settings stand-in, service, and a live lead agent. */
async function setup(initial: Partial<RoutingConfigDocument> = {}): Promise<Host> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-hemi-routing-new-'))
  roots.push(storageRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  const settings = new MutableRoutingSettings(initial)
  settings.provide(ctx)
  const config = settings.config
  const service = new DirectService(ctx, config)
  service.initialize()
  ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([textResponse('ok'), textResponse('ok')]))
  const handle = await ctx.agents.create({ sessionId: SessionId('lead'), agentOptions: { provider: 'mock', model: 'mock' } })
  return { ctx, service, settings, config, lead: handle.agent }
}

/** Create one further root conversation on a mounted host. */
async function createRoot(ctx: Context, id: string, signal?: AbortSignal): Promise<Agent> {
  const handle = await ctx.agents.create({
    sessionId: SessionId(id),
    agentOptions: { provider: 'mock', model: 'mock' },
    ...signal === undefined ? {} : { signal },
  })
  return handle.agent
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

describe('new conversation inheritance', () => {
  it('persists the remembered auto mode and effort in one write', async () => {
    const { service, settings, lead } = await setup({ main: MAIN, newSessionMode: 'auto', newSessionEffort: 'max' })
    expect(settings.snapshot()).toMatchObject({
      sessionModes: { lead: true }, sessionEfforts: { lead: 'max' },
      newSessionMode: 'auto', newSessionEffort: 'max',
    })
    expect(settings.attempts.mutate).toBe(1)
    expect(settings.opLog[0]).toEqual([
      { op: 'set', path: ['sessionModes', 'lead'], value: true },
      { op: 'set', path: ['sessionEfforts', 'lead'], value: 'max' },
    ])
    expect(service.modeOf(lead)).toBe('auto')
    service.prepareTurn(lead)
    await service.captureStep(lead)
    expect(service.routeForDelegation(lead, 'explorer')).toMatchObject({ kind: 'bound', route: { provider: 'mock', model: 'main' } })
  })

  it('materializes the routing default effort when the remembered effort is null', async () => {
    const { settings } = await setup({ main: MAIN, newSessionMode: 'auto', defaultReasoningEffort: 'medium' })
    expect(settings.snapshot()).toMatchObject({
      sessionModes: { lead: true }, sessionEfforts: { lead: 'medium' }, newSessionEffort: null,
    })
  })

  it('skips the write entirely for the fixed default without a remembered effort', async () => {
    const { settings } = await setup({ main: MAIN })
    expect(settings.attempts.mutate).toBe(0)
    expect(settings.snapshot()).toMatchObject({ sessionModes: {}, sessionEfforts: {} })
  })

  it('inherits the mode an explicit switch just remembered, keeping the remembered effort', async () => {
    const { ctx, service, settings, lead } = await setup({ main: MAIN, newSessionMode: 'auto', newSessionEffort: 'max' })
    await service.setEnabled(lead, false)
    expect(settings.opLog.at(-1)).toEqual([
      { op: 'set', path: ['sessionModes', 'lead'], value: false },
      { op: 'set', path: ['newSessionMode'], value: 'fixed' },
    ])
    const second = await createRoot(ctx, 'lead-2')
    expect(settings.opLog.at(-1)).toEqual([
      { op: 'set', path: ['sessionModes', 'lead-2'], value: false },
      { op: 'set', path: ['sessionEfforts', 'lead-2'], value: 'max' },
    ])
    expect(settings.snapshot()).toMatchObject({
      sessionModes: { lead: false, 'lead-2': false },
      sessionEfforts: { lead: 'max', 'lead-2': 'max' },
      newSessionMode: 'fixed', newSessionEffort: 'max',
    })
    expect(service.modeOf(second)).toBe('fixed')
  })
})

describe('already configured conversations are not reset', () => {
  it('keeps a saved mode when the conversation is created again', async () => {
    const { service, settings } = await setup({ main: MAIN, newSessionMode: 'auto', newSessionEffort: 'max', sessionModes: { lead: false } })
    expect(settings.attempts.mutate).toBe(0)
    expect(settings.snapshot()).toMatchObject({ sessionModes: { lead: false }, sessionEfforts: {} })
    expect(service.modeOfSession(SessionId('lead'))).toBe('fixed')
  })

  it('keeps a saved effort when the conversation is created again', async () => {
    const { service, settings } = await setup({ main: MAIN, newSessionMode: 'auto', newSessionEffort: 'max', sessionEfforts: { lead: 'low' } })
    expect(settings.attempts.mutate).toBe(0)
    expect(settings.snapshot()).toMatchObject({ sessionModes: {}, sessionEfforts: { lead: 'low' } })
    expect(service.modeOfSession(SessionId('lead'))).toBe('fixed')
  })
})

describe('only fresh root conversations initialize', () => {
  it('does not initialize subagent children or forked conversations', async () => {
    const { ctx, settings, lead } = await setup({ main: MAIN, newSessionMode: 'auto', newSessionEffort: 'max' })
    expect(settings.attempts.mutate).toBe(1)
    const child = await spawnChild(ctx, lead)
    try {
      const seed: SessionEvent[] = [
        { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
        { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
      ]
      await ctx.agents.create({
        sessionId: SessionId('fork-sess'),
        seed,
        meta: { parentSession: lead.id, isSeeded: true },
        inheritedEventCount: SessionLogOffset(seed.length),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      expect(settings.attempts.mutate).toBe(1)
      expect(settings.snapshot()).toMatchObject({ sessionModes: { lead: true }, sessionEfforts: { lead: 'max' } })
    } finally {
      await child.dispose()
    }
  })

  it('does not initialize a resumed conversation', async () => {
    const { ctx, service, settings } = await setup({ main: MAIN })
    expect(settings.attempts.mutate).toBe(0)
    const handle = await ctx.agents.create({ sessionId: SessionId('resume-sess'), agentOptions: { provider: 'mock', model: 'mock' } })
    await ctx.sessions.flush(handle.agent.session)
    await handle.dispose()
    settings.setConfig({ newSessionMode: 'auto', newSessionEffort: 'max' })
    const resumed = await ctx.agents.resume({ resumeSessionId: SessionId('resume-sess'), agentOptions: { provider: 'mock', model: 'mock' } })
    expect(settings.attempts.mutate).toBe(0)
    expect(settings.snapshot()).toMatchObject({ sessionModes: {}, sessionEfforts: {}, newSessionMode: 'auto' })
    expect(service.modeOf(resumed.agent)).toBe('fixed')
  })
})

describe('creation-time failures', () => {
  it('rejects creation when the initial preference save fails', async () => {
    const { ctx, settings } = await setup({ main: MAIN })
    settings.setConfig({ newSessionMode: 'auto', newSessionEffort: 'max' })
    settings.plan({ failure: new Error('disk full') })
    await expect(createRoot(ctx, 'doomed')).rejects.toThrow(/saving initial routing preferences failed/)
    expect(ctx.agents.get(SessionId('doomed'))).toBeUndefined()
    expect(settings.attempts.mutate).toBe(1)
    expect(settings.snapshot()).toMatchObject({ sessionModes: {}, sessionEfforts: {} })
  })

  it('rejects creation when the remembered auto mode has no configured main', async () => {
    const { ctx, settings } = await setup()
    settings.setConfig({ newSessionMode: 'auto' })
    await expect(createRoot(ctx, 'doomed')).rejects.toMatchObject({ code: 'HEMI_ROUTING_MAIN_REQUIRED' })
    expect(ctx.agents.get(SessionId('doomed'))).toBeUndefined()
    expect(settings.attempts.mutate).toBe(0)
  })

  it('stops waiting on a creation signal and never writes the cancelled conversation', async () => {
    const { ctx, service, settings, lead } = await setup({ main: MAIN })
    settings.plan({ hold: true })
    const switching = service.setEnabled(lead, true)
    await vi.waitFor(() => { expect(settings.attempts.mutate).toBe(1) })
    const controller = new AbortController()
    const creating = createRoot(ctx, 'cancelled', controller.signal)
    controller.abort(new Error('stop creating'))
    await expect(creating).rejects.toThrow(/stop creating/)
    settings.release()
    await switching
    expect(ctx.agents.get(SessionId('cancelled'))).toBeUndefined()
    expect(settings.attempts.mutate).toBe(1)
    expect(settings.opLog.at(-1)).toEqual([
      { op: 'set', path: ['sessionModes', 'lead'], value: true },
      { op: 'set', path: ['newSessionMode'], value: 'auto' },
    ])
    expect(settings.snapshot()).toMatchObject({ sessionModes: { lead: true }, sessionEfforts: {} })
  })
})

describe('explicit choices and the commit queue', () => {
  it('saves the session mode and the new-conversation mode in one transaction', async () => {
    const { service, settings, lead } = await setup({ main: MAIN, sessionModes: { lead: true } })
    expect(settings.attempts.mutate).toBe(0)
    await service.setEnabled(lead, true)
    expect(settings.attempts.mutate).toBe(1)
    expect(settings.opLog[0]).toEqual([
      { op: 'set', path: ['sessionModes', 'lead'], value: true },
      { op: 'set', path: ['newSessionMode'], value: 'auto' },
    ])
    expect(settings.snapshot().newSessionMode).toBe('auto')
    // Once both the session mode and the remembered default match, nothing is written.
    await service.setEnabled(lead, true)
    expect(settings.attempts.mutate).toBe(1)
  })

  it('keeps automatic routing active while a repeated choice waits behind another conversation', async () => {
    const { ctx, service, settings, config, lead } = await setup({ main: MAIN, newSessionMode: 'auto', newSessionEffort: 'max' })
    const other = await createRoot(ctx, 'other')
    settings.plan({ hold: true })
    const holding = service.setReasoningEffort(other, 'low')
    await vi.waitFor(() => { expect(settings.attempts.mutate).toBe(3) })
    const admitted = vi.spyOn(config.sessionModes, 'get')
    const refreshing = service.setEnabled(lead, true)
    try {
      await vi.waitFor(() => { expect(admitted).toHaveBeenCalled() })
      expect(service.modeOf(lead)).toBe('auto')
      service.prepareTurn(lead)
      await service.captureStep(lead)
      expect(service.routeForDelegation(lead, 'explorer')).toMatchObject({ kind: 'bound', route: MAIN })
    } finally {
      settings.release()
      await Promise.all([holding, refreshing])
    }
    expect(service.modeOf(lead)).toBe('auto')
  })

  it('reports a failed default-only refresh without blocking the unchanged automatic mode', async () => {
    const { service, settings, lead } = await setup({ main: MAIN, sessionModes: { lead: true } })
    settings.plan({ failure: new Error('disk full') })
    await expect(service.setEnabled(lead, true)).rejects.toThrow(/saving the routing mode failed/)
    expect(service.modeOf(lead)).toBe('auto')
    expect(service.blockedReason(lead)).toBeNull()
    expect(settings.snapshot().newSessionMode).toBe('fixed')
  })

  it('saves the conversation effort and the new-conversation effort in one transaction', async () => {
    const { service, settings, lead } = await setup({ defaultReasoningEffort: 'high', sessionEfforts: { lead: 'high' } })
    await service.setReasoningEffort(lead, 'low')
    expect(settings.attempts.mutate).toBe(1)
    expect(settings.opLog[0]).toEqual([
      { op: 'set', path: ['sessionEfforts', 'lead'], value: 'low' },
      { op: 'set', path: ['newSessionEffort'], value: 'low' },
    ])
    expect(settings.snapshot()).toMatchObject({ defaultReasoningEffort: 'high', newSessionEffort: 'low', sessionEfforts: { lead: 'low' } })
  })

  it('leaves the new-conversation default alone when a recorded selection exits auto', async () => {
    const { service, settings, lead } = await setup({ main: MAIN })
    await service.setEnabled(lead, true)
    expect(settings.snapshot().newSessionMode).toBe('auto')
    lead.model.select({ provider: 'mock', model: 'user-model' })
    await vi.waitFor(() => { expect(settings.snapshot().sessionModes).toEqual({ lead: false }) })
    expect(settings.opLog.at(-1)).toEqual([{ op: 'set', path: ['sessionModes', 'lead'], value: false }])
    expect(settings.snapshot().newSessionMode).toBe('auto')
    expect(settings.snapshot().newSessionEffort).toBeNull()
  })

  it('inherits the last persisted default when an earlier explicit write fails', async () => {
    const { ctx, service, settings, lead } = await setup({ main: MAIN })
    settings.plan({ hold: true, failure: new Error('disk full') })
    const switching = service.setEnabled(lead, true)
    await vi.waitFor(() => { expect(settings.attempts.mutate).toBe(1) })
    const creating = createRoot(ctx, 'latecomer')
    settings.release()
    await expect(switching).rejects.toThrow(/saving the routing mode failed/)
    const late = await creating
    expect(late.id).toBe('latecomer')
    expect(settings.attempts.mutate).toBe(1)
    expect(settings.snapshot()).toMatchObject({
      sessionModes: {}, sessionEfforts: {}, newSessionMode: 'fixed', newSessionEffort: null,
    })
  })

  it('inherits an explicit write that settles while the conversation waits in the queue', async () => {
    const { ctx, service, settings, lead } = await setup({ main: MAIN })
    settings.plan({ hold: true })
    const switching = service.setEnabled(lead, true)
    await vi.waitFor(() => { expect(settings.attempts.mutate).toBe(1) })
    const creating = createRoot(ctx, 'latecomer')
    settings.release()
    await switching
    const late = await creating
    expect(late.id).toBe('latecomer')
    expect(settings.attempts.mutate).toBe(2)
    expect(settings.snapshot()).toMatchObject({
      sessionModes: { lead: true, latecomer: true }, sessionEfforts: { latecomer: 'high' },
      newSessionMode: 'auto', newSessionEffort: null,
    })
  })
})
