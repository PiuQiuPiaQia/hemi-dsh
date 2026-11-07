/** Routing-mode persistence through the real Loader, ConfigEditor, and Settings pipeline. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { initProfile, mountRootInclude, readProfilePatches } from '@deepseek-ai/dsh-app-boot'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as routingPreset from '../src/index.ts'
import routingSettings from '../src/settings.ts'
import type { Route } from '../src/types.ts'
import { ScriptedAdapter, textResponse } from './mock-llm.ts'
import { mountWorkingDirectoryFixture } from './working-directory.ts'

/** Function-plugin object registered as a Loader builtin, as compositions load it. */
const routingPlugin = { name: routingPreset.name, inject: routingPreset.inject, Config: routingPreset.Config, apply: routingPreset.apply }

const MAIN: Route = { provider: 'mock', model: 'main-model' }

const contexts: Context[] = []
const roots: string[] = []
const homes: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/** One real profile: bundle-inserted routing entries plus the user patch layer ConfigEditor writes. */
function createProfile(
  roles: Record<string, Route> = {},
  newSession: { newSessionMode?: 'fixed' | 'auto'; newSessionEffort?: 'low' | 'medium' | 'high' | 'max' | null } = {},
): { profile: ProfileContext; readPatch: () => Promise<string> } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-hemi-routing-profile-')))
  homes.push(home)
  const dir = join(home, 'profile')
  initProfile(dir, ['test-hemi-routing-bundle'])
  const bundle = join(dir, 'node_modules', 'test-hemi-routing-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'test-hemi-routing-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'hemi-routing-settings', name: 'cordis:hemi-routing-settings', config: { main: MAIN, roles, ...newSession } },
    { id: 'hemi-routing', name: 'cordis:hemi-routing', config: { provider: 'spawn' } },
  ] }]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'test',
    startedBundles: ['test-hemi-routing-bundle'],
    dir,
    patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'),
    cwd: home,
    home,
    overlays: [],
    telemetryDisabledEnv: undefined,
  }
  return { profile, readPatch: () => readFile(profile.patchPath, 'utf8') }
}

/** Boot one host over the profile: real Loader, ConfigEditor, Settings, and loop services. */
async function startHost(profile: ProfileContext): Promise<{ ctx: Context; service: routingSettings }> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-hemi-routing-persist-'))
  roots.push(storageRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([textResponse('ok'), textResponse('ok'), textResponse('ok')]))
  ctx.baseUrl = pathToFileURL(profile.home).href + '/'
  ctx.provide('profileContext', profile)
  await ctx.plugin(Loader)
  ctx.loader.builtins['hemi-routing-settings'] = routingSettings
  ctx.loader.builtins['hemi-routing'] = routingPlugin
  await ctx.plugin(ConfigEditor)
  await ctx.plugin(Settings)
  await mountRootInclude(ctx, join(profile.dir, 'cordis.yml'), readProfilePatches('test', profile))
  await ctx.loader.await()
  const service = ctx.get('hemiRoutingSettings')
  if (!(service instanceof routingSettings)) throw new Error('the loaded composition did not publish hemiRoutingSettings')
  return { ctx, service }
}

/** Create one root agent the Remote-mode owner accepts. */
async function createLead(ctx: Context, id: string, signal?: AbortSignal): Promise<Agent> {
  const handle = await ctx.agents.create({
    sessionId: SessionId(id),
    agentOptions: { provider: 'mock', model: 'mock' },
    ...signal === undefined ? {} : { signal },
  })
  return handle.agent
}

/** Persisted routing settings value of one host, for restart assertions. */
function routingValue(ctx: Context): Record<string, unknown> {
  const row = ctx.settings.describe().find(item => item.ns === 'hemi-routing-settings')
  if (row === undefined) throw new Error('routing settings are unavailable')
  return row.value as Record<string, unknown>
}

describe('settings-pipeline persistence', () => {
  it('boots with legacy roles without starting a settings transaction', async () => {
    const selected = { provider: 'mock', model: 'old-review' }
    const { profile, readPatch } = createProfile({ review: selected })
    const initial = await readPatch()
    const { service } = await startHost(profile)
    expect(service.currentRoles()).toEqual({ oracle: selected })
    expect(await readPatch()).toBe(initial)
  })

  it('exposes saved routes through a settings schema that survives the JSON wire', async () => {
    const { profile } = createProfile()
    const { ctx } = await startHost(profile)
    const selected = { provider: 'mock', model: 'review-model', reasoningEffort: 'high' }
    await ctx.settings.mutate('hemi-routing-settings', [
      { op: 'set', path: ['roles', 'oracle'], value: selected },
    ])
    const row = ctx.settings.describe({ redactSecrets: true }).find(item => item.ns === 'hemi-routing-settings')
    if (row === undefined) throw new Error('routing settings are unavailable')
    const schema = new Schema(JSON.parse(JSON.stringify(row.schema)) as Schema)
    expect(schema(row.value)).toMatchObject({ main: MAIN, roles: { oracle: selected } })
  })

  it('saves two parallel Sessions without cross-overwrites and reloads them after a restart', async () => {
    const { profile, readPatch } = createProfile()
    const first = await startHost(profile)
    const leadA = await createLead(first.ctx, 'lead-a')
    const leadB = await createLead(first.ctx, 'lead-b')
    await Promise.all([
      first.service.setEnabled(leadA, true),
      first.service.setEnabled(leadB, true),
    ])
    await first.service.setEnabled(leadB, false)
    expect(first.service.modeOf(leadA)).toBe('auto')
    expect(first.service.modeOf(leadB)).toBe('fixed')
    // Mode writes never touch the routes in the same namespace.
    expect(first.service.currentMain()).toEqual(MAIN)
    expect(first.service.currentRoles()).toEqual({})
    const patch = await readPatch()
    expect(patch).toContain('sessionModes')
    expect(patch).toContain('lead-a')

    await first.ctx.fiber.dispose()
    const second = await startHost(profile)
    expect(second.service.modeOfSession(SessionId('lead-a'))).toBe('auto')
    expect(second.service.modeOfSession(SessionId('lead-b'))).toBe('fixed')
    expect(second.service.currentMain()).toEqual(MAIN)
    expect(second.service.currentRoles()).toEqual({})
    // Without a turn plan this process, the live config routes a delegation.
    expect(second.service.routeForDelegation(await createLead(second.ctx, 'lead-a'), 'explorer')).toEqual({ kind: 'bound', route: MAIN })
  })

  it('persists the auto exit of a recorded user selection through the same pipeline', async () => {
    const { profile, readPatch } = createProfile()
    const first = await startHost(profile)
    const lead = await createLead(first.ctx, 'lead-exit')
    await first.service.setEnabled(lead, true)
    expect(first.service.modeOf(lead)).toBe('auto')
    lead.model.select({ provider: 'mock', model: 'user-model' })
    expect(first.service.modeOf(lead)).toBe('fixed')
    await vi.waitFor(async () => {
      const patch = await readPatch()
      expect(patch).toContain('lead-exit: false')
      expect(first.ctx.settings.describe().find(row => row.ns === 'hemi-routing-settings')?.value)
        .toMatchObject({ sessionModes: { 'lead-exit': false } })
    })

    await first.ctx.fiber.dispose()
    const second = await startHost(profile)
    expect(second.service.modeOfSession(SessionId('lead-exit'))).toBe('fixed')
  })
})

describe('new-conversation preference inheritance through the pipeline', () => {
  it('persists inherited preferences and re-inherits them after a restart', async () => {
    const { profile, readPatch } = createProfile(undefined, { newSessionMode: 'auto', newSessionEffort: 'max' })
    const first = await startHost(profile)
    await createLead(first.ctx, 'inherit-a')
    expect(routingValue(first.ctx)).toMatchObject({
      sessionModes: { 'inherit-a': true }, sessionEfforts: { 'inherit-a': 'max' },
    })
    expect(await readPatch()).toContain('inherit-a: true')

    await first.ctx.fiber.dispose()
    const second = await startHost(profile)
    expect(second.service.modeOfSession(SessionId('inherit-a'))).toBe('auto')
    expect(routingValue(second.ctx)).toMatchObject({ sessionEfforts: { 'inherit-a': 'max' } })
    const leadB = await createLead(second.ctx, 'inherit-b')
    expect(second.service.modeOf(leadB)).toBe('auto')
    expect(routingValue(second.ctx)).toMatchObject({
      sessionModes: { 'inherit-a': true, 'inherit-b': true },
      sessionEfforts: { 'inherit-a': 'max', 'inherit-b': 'max' },
    })
  })

  it('inherits an explicitly remembered fixed default after a restart', async () => {
    const { profile } = createProfile(undefined, { newSessionMode: 'auto', newSessionEffort: 'max' })
    const first = await startHost(profile)
    const lead = await createLead(first.ctx, 'switch-a')
    await first.service.setEnabled(lead, false)
    expect(routingValue(first.ctx)).toMatchObject({ sessionModes: { 'switch-a': false }, newSessionMode: 'fixed' })

    await first.ctx.fiber.dispose()
    const second = await startHost(profile)
    expect(second.service.modeOfSession(SessionId('switch-a'))).toBe('fixed')
    expect(routingValue(second.ctx)).toMatchObject({ newSessionMode: 'fixed' })
    const leadB = await createLead(second.ctx, 'switch-b')
    expect(second.service.modeOf(leadB)).toBe('fixed')
    // The remembered effort survives the mode switch and keeps initializing conversations.
    expect(routingValue(second.ctx)).toMatchObject({ sessionEfforts: { 'switch-a': 'max', 'switch-b': 'max' } })
  })
})

/** Loader reconciliation must not depend on a routing cleanup awaiting that same write. */
describe('mode writes racing Loader unload', () => {
  it.each(['entry', 'root'] as const)('settles a real settings transaction during %s disposal', async (scope) => {
    const { profile } = createProfile()
    const { ctx, service } = await startHost(profile)
    const lead = await createLead(ctx, `unload-${scope}`)
    await service.setEnabled(lead, true)
    const entry = [...ctx.loader.entries()].find(row => row.options.id === 'hemi-routing-settings')
    const fiber = entry?.fiber
    if (fiber === undefined) throw new Error('routing settings fiber is missing')
    const originalAwait = fiber.await.bind(fiber)
    const captured = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const escape = Promise.withResolvers<typeof fiber>()
    // The first reconciliation has captured its previous fibers before calling this.
    vi.spyOn(fiber, 'await').mockImplementation(async () => {
      captured.resolve(undefined)
      await release.promise
      return Promise.race([originalAwait(), escape.promise])
    })
    const saving = service.setEnabled(lead, false)
    const saved = saving.then(() => 'saved', () => 'refused')
    await captured.promise
    const disposal = scope === 'root' ? ctx.fiber.dispose() : fiber.dispose()
    let disposed = false
    void disposal.then(() => { disposed = true })
    release.resolve(undefined)
    try {
      await vi.waitFor(() => { expect(disposed).toBe(true) }, { timeout: 1000 })
      await expect(saved).resolves.toBe('refused')
    } finally {
      // Only a failing implementation needs this escape from its circular wait.
      escape.resolve(fiber)
      await Promise.all([saved, disposal])
    }
  })
})

/** Creation-time preference saves answer their creation signal instead of joining the reconciliation they race. */
describe('creation initialization racing Loader unload', () => {
  it.each(['entry', 'root'] as const)('releases a creation-time preference save during %s disposal', async (scope) => {
    const { profile } = createProfile(undefined, { newSessionMode: 'auto', newSessionEffort: 'max' })
    const { ctx } = await startHost(profile)
    const entry = [...ctx.loader.entries()].find(row => row.options.id === 'hemi-routing-settings')
    const fiber = entry?.fiber
    if (fiber === undefined) throw new Error('routing settings fiber is missing')
    const originalAwait = fiber.await.bind(fiber)
    const captured = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const escape = Promise.withResolvers<typeof fiber>()
    // The first reconciliation has captured its previous fibers before calling this.
    vi.spyOn(fiber, 'await').mockImplementation(async () => {
      captured.resolve(undefined)
      await release.promise
      return Promise.race([originalAwait(), escape.promise])
    })
    const controller = new AbortController()
    const creating = createLead(ctx, `init-unload-${scope}`, controller.signal)
    await captured.promise
    const disposal = scope === 'root' ? ctx.fiber.dispose() : fiber.dispose()
    let disposed = false
    void disposal.then(() => { disposed = true })
    // While the save still waits inside reconciliation, the listener must answer
    // its creation signal instead of holding the announcement chain hostage.
    controller.abort(new Error(`stop ${scope} init`))
    await expect(creating).rejects.toThrow(/stop/)
    try {
      release.resolve(undefined)
      await vi.waitFor(() => { expect(disposed).toBe(true) }, { timeout: 2000 })
    } finally {
      // Only a failing implementation needs this escape from its circular wait.
      escape.resolve(fiber)
      await disposal
    }
  })
})
