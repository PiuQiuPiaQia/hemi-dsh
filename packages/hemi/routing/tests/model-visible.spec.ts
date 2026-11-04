/** Owner-local model-visible snapshot: the `hemi_delegate` tool schema and role prompt section. */

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

/** The exact model-facing tool entry, committed as this package's model-visible snapshot. */
const EXPECTED_HEMI_DELEGATE = {
  name: 'hemi_delegate',
  description: 'Delegate a task to a Hemi role using its configured model. Returns the child’s result in the current turn by default.',
  parameters: {
    type: 'object',
    properties: {
      role: {
        type: 'string',
        description: 'Delegation role. explorer gathers read-only context and reports; oracle analyzes independently; fixer makes the changes; designer works on the interface.',
        enum: ['explorer', 'oracle', 'fixer', 'designer'],
      },
      description: {
        type: 'string',
        description: "A short (3-5 word) description of the delegated task, for display. Use the language of the user's current request.",
      },
      prompt: {
        type: 'string',
        description: "The complete standalone task for the subagent, including every constraint and the expected deliverable. The role's duty is prepended automatically.",
      },
      background: {
        type: 'boolean',
        description: 'Set true only when the user requests background execution. Returns an ID immediately and delivers the result later.',
      },
    },
    required: ['role', 'description', 'prompt'],
  },
}

const ROLE_POLICY = [
  'Follow the user’s explicit role assignment or request to work directly.',
  'worth the handoff, wait, and verification. Do small, bounded work directly.',
  'broad or uncertain fact-finding',
  'independent judgment on consequential assumptions',
  'substantial, well-scoped execution',
  'visual or interaction judgment materially affects the outcome',
  'Verify and integrate the results needed for the final answer.',
]

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
        await agentCtx.plugin(routingPreset, { provider: 'spawn' })
      },
    })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Help me plan the work' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()

    const header = handle.agent.session.snapshotEvents().find(event => event.type === 'request/header')
    expect(header).toBeDefined()
    const tools = (header?.data as { header?: { tools?: unknown[] } }).header?.tools ?? []
    const delegate = tools.find(tool => (tool as { name?: string }).name === 'hemi_delegate') as Record<string, unknown>
    expect(delegate).toBeDefined()
    // The committed snapshot is the complete model-facing tool entry.
    expect(delegate).toEqual(EXPECTED_HEMI_DELEGATE)

    const system = handle.agent.session.snapshotEvents().find(event => event.type === 'system/message')
    expect(system).toBeDefined()
    const content = (system?.data as { message?: { content?: readonly { type?: string; text?: string }[] } }).message?.content
    const systemText = JSON.stringify(content ?? [])
    for (const clause of ROLE_POLICY) expect(systemText).toContain(clause)
  })
})
