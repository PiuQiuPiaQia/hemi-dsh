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
  const settings = new MutableRoutingSettings(options.initial ?? {})
  const service = mountService(ctx, settings)
  const adapter = new ScriptedAdapter([...script])
  ctx.llm.registerAdapter(['mock'], adapter)
  const handle = await ctx.agents.create({
    sessionId: SessionId('lead'),
    agentOptions: options.agentOptions ?? { provider: 'mock', model: 'mock' },
    setup: async (agentCtx: Context) => {
      await agentCtx.plugin(routingPlugin, { provider: 'spawn', ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }) })
    },
  })
  return { ctx, service, settings, adapter, lead: handle.agent }
}

/** Run one turn for the agent; the adapter script was supplied up front. */
async function runTurn(agent: Agent, text = 'go'): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

function delegateCall(id: string, role: string, background?: boolean): StreamChunk[] {
  return toolCallResponse(id, 'hemi_delegate', {
    role, description: 'task', prompt: 'go',
    ...background === undefined ? {} : { background },
  })
}

const MAIN: Route = { provider: 'mock', model: 'main-model' }
const ORACLE: Route = { provider: 'mock', model: 'oracle-model' }

describe('delegation delivery', () => {
  it.each([false, true])('delivers the child result with background=%s', async (background) => {
    const childResult = Promise.withResolvers<StreamChunk[]>()
    const host = await setupHost([
      delegateCall('c1', 'fixer', background || undefined),
      () => childResult.promise,
      textResponse('parent done'),
      textResponse('follow-up done'),
    ])
    const turn = runTurn(host.lead)
    const events = () => host.lead.session.snapshotEvents()
    try {
      await vi.waitFor(() => { expect(host.adapter.requests.length).toBeGreaterThanOrEqual(2) })
      if (background) {
        await vi.waitFor(() => { expect(events().filter(event => event.type === 'turn/end')).toHaveLength(1) })
      } else {
        expect(events().some(event => event.type === 'turn/end' || event.type === 'tool/result')).toBe(false)
      }
    } finally {
      childResult.resolve(textResponse('child report'))
    }
    await turn
    await vi.waitFor(() => {
      expect(events().filter(event => event.type === 'turn/end')).toHaveLength(background ? 2 : 1)
    })
    const result = events().find(event => event.type === 'tool/result')
    expect(result?.data.message.isError).toBe(false)
    expect(JSON.stringify(result?.data.message.content)).toContain(background ? 'started fixer' : 'child report')
    const notice = events().find(event => event.type === 'user/message' && event.data.source.kind === 'subagent-settled')
    if (background) expect(JSON.stringify(notice)).toContain('child report')
    else expect(notice).toBeUndefined()
  })

  it('reports a failed foreground child as a tool error', async () => {
    const { lead } = await setupHost([
      delegateCall('c1', 'fixer'),
      [{ type: 'finish', reason: { kind: 'error', failure: { message: 'probe failed', code: 'TEST_FAILURE' } } }],
      textResponse('parent acknowledged failure'),
    ])
    await runTurn(lead)
    const result = lead.session.snapshotEvents().find(event => event.type === 'tool/result')
    expect(result?.data.message.isError).toBe(true)
    expect(JSON.stringify(result?.data.message.content)).toContain('ended with error')
  })

  it('stops the exact foreground child when the parent is cancelled', async () => {
    let childAborted = false
    const { lead, adapter } = await setupHost([
      delegateCall('c1', 'fixer'),
      async ({ signal }) => {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve()
          else signal?.addEventListener('abort', () => { resolve() }, { once: true })
        })
        childAborted = true
        return []
      },
    ])
    const turn = runTurn(lead)
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    lead.cancel({ kind: 'user' })
    await vi.waitFor(() => { expect(childAborted).toBe(true) })
    await turn
    expect(adapter.requests).toHaveLength(2)
    expect(lead.session.snapshotEvents().some(event =>
      event.type === 'user/message' && event.data.source.kind === 'subagent-settled')).toBe(false)
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
    let toggled: Promise<void> = Promise.resolve()
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
  it('rejects hemi_delegate when the configured depth is zero', async () => {
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
