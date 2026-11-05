/** Auto/fixed routing through the real AgentLoop, real spawn subagents, and a mock LLM adapter. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import { mountNativeRoles } from './native-roles.ts'
import { HEMI_ROLE_IDS } from '../src/types.ts'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { ScriptedAdapter, textResponse, toolCallResponse } from './mock-llm.ts'
import type { ScriptEntry } from './mock-llm.ts'
import { mountWorkingDirectoryFixture } from './working-directory.ts'
import { MutableRoutingSettings } from './settings-stub.ts'
import { apply, Config as RoutingConfig, inject, name } from '../src/index.ts'
import type { Route } from '../src/types.ts'
import HemiRoutingSettingsService from '../src/settings.ts'

/** Function-plugin object the Loader composes in production; tests mount it the same way. */
const routingPlugin = { name, inject, Config: RoutingConfig, apply }

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Direct service instance reading the stand-in document live. */
class DirectService extends HemiRoutingSettingsService {
  initialize(): void {
    this[Service.init]()
  }
}

/** Mount the routing service over one settings stand-in on a prepared context. */
function mountService(ctx: Context, settings: MutableRoutingSettings): DirectService {
  settings.provide(ctx)
  const service = new DirectService(ctx, settings.config)
  service.initialize()
  return service
}

interface Host {
  ctx: Context
  service: DirectService
  settings: MutableRoutingSettings
  adapter: ScriptedAdapter
  lead: Agent
}

/** Full host: settings service, real loop, spawn provider, and a routed lead agent. */
async function setupHost(
  script: readonly ScriptEntry[],
  options: {
    initial?: { main?: Route | null; roles?: Record<string, Route>; sessionModes?: Record<string, boolean> }
    agentOptions?: { provider: string; model: string }
    maxDepth?: number
  } = {},
): Promise<Host> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-hemi-routing-loop-'))
  roots.push(storageRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await mountNativeRoles(ctx)
  const settings = new MutableRoutingSettings(options.initial ?? {})
  const service = mountService(ctx, settings)
  const adapter = new ScriptedAdapter([...script])
  ctx.llm.registerAdapter(['mock'], adapter)
  const handle = await ctx.agents.create({
    sessionId: SessionId('lead'),
    agentOptions: options.agentOptions ?? { provider: 'mock', model: 'mock' },
    setup: async (agentCtx: Context) => {
      await agentCtx.plugin(ToolSubagent, {
        provider: 'spawn', allowedAgentPresets: [...HEMI_ROLE_IDS],
        ...options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth },
      })
      await agentCtx.plugin(routingPlugin, {})
    },
  })
  return { ctx, service, settings, adapter, lead: handle.agent }
}

/** Run one turn for the agent; the adapter script was supplied up front. */
async function runTurn(agent: Agent, text = 'go'): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

function delegateCall(id: string, role: string): StreamChunk[] {
  return toolCallResponse(id, 'subagent', {
    agent_preset: role, description: 'task', prompt: 'go',
  })
}

const MAIN: Route = { provider: 'mock', model: 'main-model' }
const ORACLE: Route = { provider: 'mock', model: 'oracle-model' }

describe('native delegation delivery', () => {
  it('returns the activation receipt before the routed child finishes and delivers its answer through the inbox', async () => {
    const childReply = Promise.withResolvers<StreamChunk[]>()
    const childStarted = Promise.withResolvers<undefined>()
    const host = await setupHost([
      delegateCall('native-start', 'oracle'),
      () => { childStarted.resolve(undefined); return childReply.promise },
      textResponse('parent continues'),
      textResponse('parent received the completion notice'),
    ], { initial: { main: MAIN, roles: { oracle: { ...ORACLE, reasoningEffort: 'high' } } } })
    await host.service.setEnabled(host.lead, true)
    const childEnded = Promise.withResolvers<undefined>()
    host.ctx.on('subagent/end', () => { childEnded.resolve(undefined) })
    try {
      await runTurn(host.lead)
      await childStarted.promise
      expect(host.lead.status).toBe('idle')
      expect(host.adapter.requests.find(request => request.model === 'oracle-model')).toMatchObject({ reasoningEffort: 'high' })
      const receipt = host.lead.session.snapshotEvents().find(event => event.type === 'tool/result')
      expect(receipt?.data.message.isError).toBe(false)
      expect(JSON.stringify(receipt?.data.message.content)).toContain('started subagent')
      expect(receipt?.data.meta).toMatchObject({ kind: 'activation' })
      expect(receipt?.data.meta).not.toHaveProperty('completed')
      expect(host.lead.session.snapshotEvents().some(event => event.type === 'user/message'
        && event.data.source.kind === 'subagent-settled')).toBe(false)
    } finally { childReply.resolve(textResponse('routed child report')) }
    await childEnded.promise
    await host.lead.whenIdle()
    const notice = host.lead.session.snapshotEvents().find(event => event.type === 'user/message'
      && event.data.source.kind === 'subagent-settled')
    expect(JSON.stringify(notice)).toContain('routed child report')
  })

  it('keeps a published routed child running when its parent is cancelled after the tool returns', async () => {
    const childReply = Promise.withResolvers<StreamChunk[]>()
    const parentStreaming = Promise.withResolvers<undefined>()
    const childStreaming = Promise.withResolvers<undefined>()
    let childSignal: AbortSignal | undefined
    const afterStart: ScriptEntry = async (options) => {
      if (options.sessionId === 'lead') {
        parentStreaming.resolve(undefined)
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) resolve()
          else options.signal?.addEventListener('abort', () => { resolve() }, { once: true })
        })
        return textResponse('cancelled parent')
      }
      childSignal = options.signal
      childStreaming.resolve(undefined)
      return childReply.promise
    }
    const host = await setupHost([
      delegateCall('native-cancel', 'oracle'), afterStart, afterStart, textResponse('completion received'),
    ], { initial: { main: MAIN, roles: { oracle: ORACLE } } })
    await host.service.setEnabled(host.lead, true)
    const childEnded = Promise.withResolvers<undefined>()
    host.ctx.on('subagent/end', () => { childEnded.resolve(undefined) })
    const turn = runTurn(host.lead)
    try {
      await Promise.all([parentStreaming.promise, childStreaming.promise])
      host.lead.cancel({ kind: 'user' })
      await turn
      expect(childSignal?.aborted).toBe(false)
      expect(host.lead.session.snapshotEvents().find(event => event.type === 'tool/result')?.data.message.isError).toBe(false)
    } finally { childReply.resolve(textResponse('independent child report')) }
    await childEnded.promise
    await host.lead.whenIdle()
    expect(JSON.stringify(host.lead.session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.source.kind === 'subagent-settled'))).toContain('independent child report')
  })
})

describe('auto mode', () => {
  it('routes the main model at each turn and hard-binds configured roles', async () => {
    const host = await setupHost([
      delegateCall('c1', 'oracle'),
      textResponse('child done'),
      textResponse('parent done'),
      delegateCall('c2', 'explorer'),
      textResponse('child done'),
      textResponse('parent done'),
    ], { initial: { main: MAIN, roles: { oracle: ORACLE } } })
    const { service, lead } = host
    await service.setEnabled(lead, true)

    await runTurn(lead)
    expect(host.adapter.requests[0]).toMatchObject({ provider: 'mock', model: 'main-model' })
    expect(host.adapter.requests[1]).toMatchObject({ provider: 'mock', model: 'oracle-model' })

    await runTurn(lead)
    expect(host.adapter.requests[3]).toMatchObject({ provider: 'mock', model: 'main-model' })
    // An unconfigured role follows the turn's main route.
    expect(host.adapter.requests[4]).toMatchObject({ provider: 'mock', model: 'main-model' })
    expect(service.modeOf(lead)).toBe('auto')
  })

  it('keeps role bindings on the turn plan when config changes mid-turn', async () => {
    const host = await setupHost([
      () => {
        host.settings.setConfig({ main: { provider: 'mock', model: 'late-main' }, roles: { oracle: { provider: 'mock', model: 'late-oracle' } } })
        return delegateCall('c1', 'oracle')
      },
      textResponse('child done'),
      textResponse('parent done'),
      textResponse('next turn'),
    ], { initial: { main: MAIN, roles: { oracle: ORACLE } } })
    const { service, lead } = host
    await service.setEnabled(lead, true)

    await runTurn(lead)
    expect(host.adapter.requests[1]).toMatchObject({ model: 'oracle-model' })

    await runTurn(lead)
    expect(host.adapter.requests.at(-1)).toMatchObject({ model: 'late-main' })
  })
})

describe('manual model selections', () => {
  it('routes the next step and its delegations to the selection recorded between steps', async () => {
    const host = await setupHost([
      delegateCall('c1', 'oracle'),
      () => {
        // The child's stream runs inside step 1's tool execution: a user
        // selection here lands between step 1 and step 2.
        host.lead.model.select({ provider: 'mock', model: 'user-model' })
        return textResponse('child done')
      },
      delegateCall('c2', 'explorer'),
      textResponse('child done'),
      textResponse('parent done'),
    ], { initial: { main: MAIN, roles: { oracle: ORACLE } } })
    const { service, lead } = host
    await service.setEnabled(lead, true)

    await runTurn(lead)
    expect(host.adapter.requests[0]).toMatchObject({ model: 'main-model' })
    expect(host.adapter.requests[1]).toMatchObject({ model: 'oracle-model' })
    // Step 2 runs on the user's selection, and its delegation follows the
    // parent's actual route instead of the turn's auto routes.
    expect(host.adapter.requests[2]).toMatchObject({ model: 'user-model' })
    expect(host.adapter.requests[3]).toMatchObject({ model: 'user-model' })
    expect(service.modeOf(lead)).toBe('fixed')
    expect(service.blockedReason(lead)).toBeNull()
  })

  it('keeps a step already prepared on its captured routes', async () => {
    const host = await setupHost([
      delegateCall('c1', 'oracle'),
      textResponse('child done'),
      () => {
        // This selection lands while step 2's request streams, after the
        // step's mode was captured at its pre-step.
        host.lead.model.select({ provider: 'mock', model: 'user-model' })
        return delegateCall('c2', 'oracle')
      },
      textResponse('child done'),
      textResponse('parent done'),
    ], { initial: { main: MAIN, roles: { oracle: ORACLE } } })
    const { service, lead } = host
    await service.setEnabled(lead, true)

    await runTurn(lead)
    expect(host.adapter.requests[2]).toMatchObject({ model: 'main-model' })
    expect(host.adapter.requests[3]).toMatchObject({ model: 'oracle-model' })
    expect(host.adapter.requests[4]).toMatchObject({ model: 'user-model' })
    expect(service.modeOf(lead)).toBe('fixed')
  })

  it('routes from the next turn after auto is enabled mid-turn', async () => {
    let toggled: Promise<void> = Promise.resolve(undefined)
    const host = await setupHost([
      () => {
        toggled = host.service.setEnabled(host.lead, true)
        return delegateCall('c1', 'explorer')
      },
      textResponse('child done'),
      textResponse('parent done'),
      delegateCall('c2', 'explorer'),
      textResponse('child done'),
      textResponse('parent done'),
    ], { initial: { main: MAIN }, agentOptions: { provider: 'mock', model: 'chosen-model' } })
    const { service, lead } = host

    await runTurn(lead)
    await toggled
    // The turn was planned fixed, so neither request nor delegation routed.
    expect(host.adapter.requests[0]).toMatchObject({ model: 'chosen-model' })
    expect(host.adapter.requests[1]).toMatchObject({ model: 'chosen-model' })

    await runTurn(lead)
    expect(host.adapter.requests[3]).toMatchObject({ model: 'main-model' })
    expect(host.adapter.requests[4]).toMatchObject({ model: 'main-model' })
    expect(service.modeOf(lead)).toBe('auto')
  })

  it('treats selecting the same complete route as a no-op that keeps auto', async () => {
    const host = await setupHost([textResponse('ok'), textResponse('ok again')], { initial: { main: MAIN } })
    const { service, settings, lead } = host
    await service.setEnabled(lead, true)
    await runTurn(lead)
    const selections = lead.session.snapshotEvents().filter(event => event.type === 'model/selection').length
    lead.model.select({ provider: 'mock', model: 'main-model' })
    expect(lead.session.snapshotEvents().filter(event => event.type === 'model/selection').length).toBe(selections)
    expect(service.modeOf(lead)).toBe('auto')
    expect(settings.attempts.mutate).toBe(1)
  })

  it('leaves auto on a user selection and follows the new route', async () => {
    const host = await setupHost([
      delegateCall('c1', 'explorer'),
      textResponse('child done'),
      textResponse('parent done'),
    ], { initial: { main: MAIN } })
    const { service, lead } = host
    await service.setEnabled(lead, true)
    lead.model.select({ provider: 'mock', model: 'user-model' })
    expect(service.modeOf(lead)).toBe('fixed')

    await runTurn(lead)
    expect(host.adapter.requests[0]).toMatchObject({ model: 'user-model' })
    expect(host.adapter.requests[1]).toMatchObject({ model: 'user-model' })
  })
})

describe('fixed mode', () => {
  it('leaves the parent route untouched and lets delegations inherit it', async () => {
    const host = await setupHost([
      delegateCall('c1', 'oracle'),
      textResponse('child done'),
      textResponse('parent done'),
    ], {
      initial: { main: MAIN, roles: { oracle: ORACLE } },
      agentOptions: { provider: 'mock', model: 'chosen-model' },
    })
    const { service, lead } = host
    expect(service.modeOf(lead)).toBe('fixed')

    await runTurn(lead)
    expect(host.adapter.requests[0]).toMatchObject({ model: 'chosen-model' })
    expect(host.adapter.requests[1]).toMatchObject({ model: 'chosen-model' })
  })
})

describe('fail-closed routing', () => {
  it('blocks the model call when main is cleared while auto is saved', async () => {
    const host = await setupHost([textResponse('must not be called')], { initial: { main: MAIN } })
    const { service, lead } = host
    await service.setEnabled(lead, true)
    host.settings.setConfig({ main: null })

    await runTurn(lead)
    expect(host.adapter.requests.length).toBe(0)
    expect(service.blockedReason(lead)).toMatch(/main model/)
    expect(service.modeOf(lead)).toBe('auto')
  })

  it('blocks the next turn after a failed mode save and recovers through the manual switch', async () => {
    const host = await setupHost([textResponse('recovered')], { initial: { main: MAIN } })
    const { service, settings, lead } = host
    await service.setEnabled(lead, true)
    settings.plan({ failure: new Error('disk full') })
    lead.model.select({ provider: 'mock', model: 'user-model' })
    await vi.waitFor(() => { expect(service.blockedReason(lead)).toMatch(/disk full/) })

    await runTurn(lead)
    expect(host.adapter.requests.length).toBe(0)

    await service.setEnabled(lead, false)
    expect(service.blockedReason(lead)).toBeNull()
    await runTurn(lead)
    expect(host.adapter.requests.length).toBe(1)
    expect(host.adapter.requests[0]).toMatchObject({ model: 'user-model' })
  })
})

describe('delegation depth', () => {
  it('rejects native subagent when the configured depth is zero', async () => {
    const host = await setupHost([
      delegateCall('c1', 'explorer'),
      textResponse('recover'),
    ], { initial: { main: MAIN }, maxDepth: 0 })
    const { service, lead } = host
    await service.setEnabled(lead, true)

    await runTurn(lead)
    expect(host.adapter.requests.length).toBe(2)
    const failed = lead.session.snapshotEvents().filter(event => event.type === 'tool/result')
      .find((event) => {
        const message = (event.data as { message?: { isError?: boolean; content?: readonly { type?: string; text?: string }[] } }).message
        return message?.isError === true && message.content?.some(block => block.text?.includes('maxDepth'))
      })
    expect(failed).toBeDefined()
  })
})

describe('persistence and isolation', () => {
  it('recovers the saved mode per root Session across a host restart', async () => {
    const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-hemi-routing-persist-'))
    roots.push(storageRoot)
    const settings = new MutableRoutingSettings({ main: MAIN })
    const mount = async (): Promise<{ ctx: Context; service: DirectService; adapter: ScriptedAdapter }> => {
      const ctx = new Context()
      contexts.push(ctx)
      await mountAgentLoopTestDependencies(ctx)
      await mountWorkingDirectoryFixture(ctx)
      await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(SubagentService)
      await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
      const service = mountService(ctx, settings)
      const adapter = new ScriptedAdapter([textResponse('ok'), textResponse('ok')])
      ctx.llm.registerAdapter(['mock'], adapter)
      return { ctx, service, adapter }
    }

    const first = await mount()
    const leadA = (await first.ctx.agents.create({ sessionId: SessionId('lead-a'), agentOptions: { provider: 'mock', model: 'mock' } })).agent
    const leadB = (await first.ctx.agents.create({ sessionId: SessionId('lead-b'), agentOptions: { provider: 'mock', model: 'mock' } })).agent
    await first.service.setEnabled(leadA, true)
    expect(first.service.modeOf(leadA)).toBe('auto')
    expect(first.service.modeOf(leadB)).toBe('fixed')
    // Give each Session durable content so both restore after the restart.
    for (const lead of [leadA, leadB]) {
      lead.followup(createUserMessage({ content: [{ type: 'text', text: 'persist' }], source: { kind: 'user' } }))
      await lead.whenIdle()
    }
    await first.ctx.fiber.dispose()

    const second = await mount()
    const resumed = await second.ctx.agentLoop.resume(second.ctx, { resumeSessionId: SessionId('lead-a') })
    expect(second.service.modeOf(resumed.agent)).toBe('auto')
    expect(second.service.routeForDelegation(resumed.agent, 'explorer')).toEqual({ kind: 'bound', route: MAIN })
    const resumedB = await second.ctx.agentLoop.resume(second.ctx, { resumeSessionId: SessionId('lead-b') })
    expect(second.service.modeOf(resumedB.agent)).toBe('fixed')
  })
})
