/** Owner-local model-visible snapshot: the native `subagent` tool schema and role prompt section. */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import { mountNativeRoles } from './native-roles.ts'
import * as routingPreset from '../src/index.ts'
import HemiRoutingSettingsService from '../src/settings.ts'
import { ScriptedAdapter, textResponse } from './mock-llm.ts'
import { MutableRoutingSettings } from './settings-stub.ts'
import { mountWorkingDirectoryFixture } from './working-directory.ts'

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

class DirectService extends HemiRoutingSettingsService {
  initialize(): void {
    this[Service.init]()
  }
}

describe('model-visible snapshot', () => {
  it.each([false, true])('serves the role prompt from a real turn (auto=%s)', async (auto) => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await mountWorkingDirectoryFixture(ctx)
    const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-hemi-routing-visible-'))
    roots.push(storageRoot)
    await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentService)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    await mountNativeRoles(ctx)
    const settings = new MutableRoutingSettings({
      main: { provider: 'mock', model: 'mock' },
      sessionModes: { lead: auto },
    })
    settings.provide(ctx)
    const service = new DirectService(ctx, settings.config)
    service.initialize()
    const adapter = new ScriptedAdapter([textResponse('done')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('lead'),
      agentOptions: { provider: 'mock', model: 'mock' },
      setup: async (agentCtx: Context) => {
        await agentCtx.plugin(ToolSubagent, { provider: 'spawn', allowedAgentPresets: ['explorer', 'oracle', 'fixer', 'designer'] })
        await agentCtx.plugin(routingPreset, {})
      },
    })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Help me plan the work' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()

    const header = handle.agent.session.snapshotEvents().find(event => event.type === 'request/header')
    expect(header).toBeDefined()
    const tools = (header?.data as { header?: { tools?: unknown[] } }).header?.tools ?? []
    expect(tools.some(tool => (tool as { name?: string }).name === 'hemi_delegate')).toBe(false)
    const delegate = tools.find(tool => (tool as { name?: string }).name === 'subagent') as Record<string, unknown>
    expect(delegate).toBeDefined()
    // Role selection is part of the native model-facing schema.
    expect(delegate).toMatchObject({ parameters: { properties: {
      agent_preset: { enum: ['explorer', 'oracle', 'fixer', 'designer'] },
    } } })

    expect(delegate).not.toHaveProperty('parameters.properties.background')
    expect(delegate).toHaveProperty('description', expect.stringContaining('immediately returns its id'))

    const system = handle.agent.session.snapshotEvents().find(event => event.type === 'system/message')
    expect(system).toBeDefined()
    const content = (system?.data as { message?: { content?: readonly { type?: string; text?: string }[] } }).message?.content
    const systemText = JSON.stringify(content ?? [])
    expect(systemText).toContain('native `subagent`')
    expect(systemText).toContain('explorer')
    expect(systemText).not.toContain('hemi_delegate')
  })
})
