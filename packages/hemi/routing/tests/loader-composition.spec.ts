/** Real Cordis Loader composition over the fixture `cordis.yml`, including reversibility. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { EntryTree, type Entry } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import { mountNativeRoles } from './native-roles.ts'
import * as routingPreset from '../src/index.ts'
import routingSettings from '../src/settings.ts'
import { ScriptedAdapter } from './mock-llm.ts'
import { MutableRoutingSettings } from './settings-stub.ts'
import { mountWorkingDirectoryFixture } from './working-directory.ts'

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Load the fixture composition through the real Loader with source modules. */
async function loadFixture(): Promise<{ ctx: Context; settings: MutableRoutingSettings }> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-hemi-routing-loader-'))
  roots.push(storageRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await mountNativeRoles(ctx)
  await ctx.plugin(ToolSubagent, { provider: 'spawn', allowedAgentPresets: ['explorer', 'oracle', 'fixer', 'designer'] })
  const settings = new MutableRoutingSettings()
  settings.provide(ctx)
  ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([]))

  const root = await mkdtemp(join(tmpdir(), 'dsh-hemi-routing-yaml-'))
  roots.push(root)
  const fixture = await readFile(new URL('./fixture/cordis.yml', import.meta.url), 'utf8')
  await writeFile(join(root, 'cordis.yml'), fixture)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-hemi-routing', routingPreset],
    ['@deepseek-ai/dsh-hemi-routing/settings', routingSettings],
  ])
  vi.spyOn(EntryTree.prototype, 'import').mockImplementation(async (specifier: string) => {
    if (specifier === 'cordis:include') return Include
    if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
    return modules.get(specifier)
  })
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(join(root, 'cordis.yml')).href },
  })
  await ctx.loader.await()
  return { ctx, settings }
}

/**
 * Fiber of one loaded entry, failing the test when absent. `Array.from`
 * materializes the vendored Loader's EntryTree generator so the Entry
 * element type stays statically visible.
 */
function entryFiber(ctx: Context, id: string): NonNullable<Entry['fiber']> {
  const loader = ctx.loader
  const entry = Array.from(loader.entries()).find(row => row.options.id === id)
  if (entry?.fiber === undefined) throw new Error(`Loader entry "${id}" is not active`)
  return entry.fiber
}

describe('real Loader composition', () => {
  it('keeps installable and built-in native role configuration aligned', () => {
    expect(() => execFileSync(process.execPath, [
      fileURLToPath(new URL('../../../../plugins/hemi-model-routing/sync-config.mjs', import.meta.url)),
    ])).not.toThrow()
  })

  it('loads both entries and maps the legacy role table through schema resolution', async () => {
    const { ctx, settings } = await loadFixture()
    const unloaded = [...ctx.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.id)
    expect(unloaded).toEqual([])
    const service = ctx.get('hemiRoutingSettings')
    expect(service).toBeInstanceOf(routingSettings)
    // `main: null` loads as null and the legacy `research` key survives the
    // schema and maps onto the canonical explorer role.
    expect(service?.currentMain()).toBeNull()
    expect(service?.currentRoles()).toEqual({
      explorer: { provider: 'mock', model: 'legacy-explorer' },
      oracle: { provider: 'mock', model: 'oracle-model' },
    })
    expect(service?.modeOfSession(SessionId('loader-session'))).toBe('auto')
    expect(service?.modeOfSession(SessionId('other-session'))).toBe('fixed')
    expect(settings.attempts.mutate).toBe(0)
  })

  it('rejects malformed config at the Loader resolution boundary a settings write uses', async () => {
    const { ctx } = await loadFixture()
    const fiber = entryFiber(ctx, 'hemi-routing-settings')
    expect(() => fiber.resolveConfig({
      main: null,
      roles: { writer: { provider: 'mock', model: 'x' } },
    })).toThrow(/writer|union|expected/)
    expect(() => fiber.resolveConfig({
      main: null,
      roles: { oracle: { provider: 'mock', model: 'x', maxTokens: 5 } },
    })).toThrow(/maxTokens|not supported/)
    expect(() => fiber.resolveConfig({
      main: { provider: '', model: 'x' },
      roles: {},
    })).toThrow(/provider/)
    // The values the settings pipeline may persist still resolve.
    expect(() => fiber.resolveConfig({ main: null, roles: { research: { provider: 'mock', model: 'x' } } }))
      .not.toThrow()
  })

  it('unloads both entries reversibly', async () => {
    const { ctx } = await loadFixture()
    const handle = await ctx.agents.create({ sessionId: SessionId('lead'), agentOptions: { provider: 'mock', model: 'mock' } })
    const signal = new AbortController().signal
    const visibleTools = async (): Promise<string[]> => {
      const toolSet = await ctx.tools.resolve({
        agent: handle.agent,
        modelSelection: { provider: 'mock', model: 'mock' },
        signal,
      })
      return [...toolSet.view(handle.agent).keys()].sort()
    }
    expect(await visibleTools()).toContain('subagent')
    expect(await visibleTools()).not.toContain('hemi_delegate')

    await entryFiber(ctx, 'hemi-routing').dispose()
    expect(await visibleTools()).not.toContain('hemi_delegate')

    await entryFiber(ctx, 'hemi-routing-settings').dispose()
    expect(ctx.get('hemiRoutingSettings')).toBeUndefined()
  })
})
