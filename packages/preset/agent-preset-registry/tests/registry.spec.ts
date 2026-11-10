import { afterEach, describe, expect, it } from 'vitest'
import { setImmediate as immediate } from 'node:timers/promises'
import { createScope } from '@deepseek-ai/dsh-scope'
import AgentRegistry, { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ExecutionProviderId, ExecutionTargetId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import { entryListProblem } from '../src/index.ts'
import { currentKey, harness, declare, contribution, agentOn, liveRegistries, plugin } from './harness.ts'
import { omitsGeneratedPage } from '../../../settings/settings/tests/live-config.ts'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentPresets from '../src/index.ts'
import type { Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    executionProbe: { readonly world: string }
    executionEvents: string[]
  }
}

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
async function setup() { const ctx = await harness(); contexts.push(ctx); return ctx }

function remoteExecution(ctx: Context) {
  const events: string[] = []
  const realm = Symbol('live-remote')
  const provider = brandString<ExecutionProviderId>('test-remote')
  const lost = new AbortController()
  ctx.provide('executionProbe', { world: 'default' })
  ctx.isolate('executionProbe', realm).provide('executionProbe', { world: 'remote' })
  ctx.agents.registerExecutionProvider(provider, { acquire: async () => ({
    realm, signal: lost.signal, bind: base => base.isolate('executionProbe', realm),
    close: async () => { events.push('lease-closed') },
  }) })
  const create = () => ctx.agents.create({
    sessionId: SessionId('remote-preset-lifecycle'),
    meta: { executionTarget: { provider, id: brandString<ExecutionTargetId>('remote') } },
    setup: async (agentCtx, agent) => { await ctx.agentPresets.mount(agentCtx, 'standard', undefined, agent.execution) },
  })
  return { events, lost, create }
}

describe('declarative preset revisions', () => {
  it.each([false, true])('drains preset activation before execution release (activation fails: %s)', async (fail) => {
    const ctx = await setup()
    const remote = remoteExecution(ctx)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    ctx.loader.builtins.pausedRemote = { async apply(child: Context) {
      if (child.get('executionProbe')?.world === 'default') return
      child.effect(() => () => { remote.events.push('preset-disposed') })
      entered.resolve(undefined)
      await release.promise
      remote.events.push('activation-settled')
      if (fail) throw new Error('remote activation failed')
    } }
    await declare(ctx, { id: 'standard', plugins: [{ name: 'cordis:pausedRemote' }] })
    const outcome = remote.create().then(() => undefined, (error: unknown) => error)
    try {
      await entered.promise
      remote.lost.abort(new Error('remote lost during activation'))
      await immediate()
      expect(remote.events).toEqual([])
      release.resolve(undefined)
      expect(await outcome).toMatchObject({ message: 'remote lost during activation' })
      expect(remote.events).toEqual(['activation-settled', 'preset-disposed', 'lease-closed'])
      expect(ctx.agentPresets.inspectCompositions()).toHaveLength(1)
    } finally {
      release.resolve(undefined)
      await outcome
    }
  })

  it('keeps a remote preset alive through admitted work during enclosing Core unload', async () => {
    const ctx = await setup()
    const remote = remoteExecution(ctx)
    const release = Promise.withResolvers<undefined>()
    const cancelled = Promise.withResolvers<undefined>()
    let resourceAlive = false
    ctx.loader.builtins.liveRemote = { apply(child: Context) {
      if (child.get('executionProbe')?.world === 'default') return
      child.effect(() => {
        resourceAlive = true
        return () => { resourceAlive = false; remote.events.push('preset-disposed') }
      })
    } }
    await declare(ctx, { id: 'standard', plugins: [{ name: 'cordis:liveRemote' }] })
    const handle = await remote.create()
    const loop = handle.agent.execution?.base.fiber
    if (loop === undefined) throw new Error('missing bound Core context')
    const work = handle.agent.runMaintenance(async (signal) => {
      signal.addEventListener('abort', () => { cancelled.resolve(undefined) }, { once: true })
      await release.promise
      remote.events.push(`consumer-used-resource:${resourceAlive}`)
    })
    const disposal = Promise.resolve(loop.dispose())
    try {
      await cancelled.promise
      await immediate()
      expect(resourceAlive).toBe(true)
      expect(remote.events).toEqual([])
      release.resolve(undefined)
      await work
      await disposal
      expect(remote.events).toEqual(['consumer-used-resource:true', 'preset-disposed', 'lease-closed'])
    } finally {
      release.resolve(undefined)
      await work
      await disposal
    }
  })

  it('shares presets only within one live execution instance and settles them before the last lease', async () => {
    const ctx = await setup()
    const events: string[] = []
    ctx.provide('executionEvents', events)
    ctx.provide('executionProbe', { world: 'default' })
    await declare(ctx, { id: 'standard', plugins: [{ name: plugin('execution-contribute') }] })
    const provider = brandString<ExecutionProviderId>('test-execution')
    const realms = new Map<ExecutionTargetId, { token: symbol; world: string }>()
    for (const world of ['a', 'b']) {
      const token = Symbol(world)
      const id = brandString<ExecutionTargetId>(world)
      realms.set(id, { token, world })
      ctx.isolate('executionProbe', token).provide('executionProbe', { world })
    }
    ctx.agents.registerExecutionProvider(provider, { acquire: async (id) => {
      const realm = realms.get(id)
      if (realm === undefined) throw new Error('missing fixture execution instance')
      return { realm: realm.token, signal: new AbortController().signal,
        bind: base => base.isolate('executionProbe', realm.token),
        close: () => { events.push(`release:${realm.world}`); return Promise.resolve() },
      }
    } })
    const create = (id: string, target: string) => ctx.agents.create({
      sessionId: SessionId(id), meta: { cwd: '/same/project', executionTarget: { provider, id: brandString<ExecutionTargetId>(target) } },
      setup: async (agentCtx, agent) => {
        expect(agent.execution?.realm).toBe(realms.get(brandString<ExecutionTargetId>(target))?.token)
        await ctx.agentPresets.mount(agentCtx, 'standard', undefined, agent.execution)
      },
    })
    const first = await create('realm-a-1', 'a')
    const second = await create('realm-a-2', 'a')
    const other = await create('realm-b', 'b')
    expect(events).toContain('mount:a')
    expect(ctx.agentPresets.inspectCompositions(first.agent.ctx).map(row => row.id)).toEqual(['standard'])
    expect(ctx.tools.schemas(first.agent).map(tool => tool.description)).toEqual(['execution in a'])
    expect(ctx.tools.schemas(other.agent).map(tool => tool.description)).toEqual(['execution in b'])
    const differentWorld = createScope(ctx, {})
    expect(() => ctx.agentPresets.composeFrom(differentWorld.ctx, first.agent.ctx, other.agent.execution))
      .toThrow('another execution instance')
    await differentWorld.dispose()
    expect(events.filter(event => event === 'mount:a')).toHaveLength(1)
    expect(ctx.agentPresets.inspectCompositions()).toHaveLength(3)
    await first.dispose()
    expect(events).not.toContain('unmount:a')
    await second.dispose()
    expect(events.slice(-2)).toEqual(['unmount:a', 'release:a'])
    expect(ctx.agentPresets.inspectCompositions()).toHaveLength(2)
    await other.dispose()
    expect(ctx.agentPresets.inspectCompositions()).toHaveLength(1)
    const replacement = Symbol('a-reconnected')
    realms.set(brandString<ExecutionTargetId>('a'), { token: replacement, world: 'a-new' })
    ctx.isolate('executionProbe', replacement).provide('executionProbe', { world: 'a-new' })
    const reconnected = await create('realm-a-new', 'a')
    expect(ctx.tools.schemas(reconnected.agent).map(tool => tool.description)).toEqual(['execution in a-new'])
    await reconnected.dispose()
    expect(events.slice(-2)).toEqual(['unmount:a-new', 'release:a-new'])
  })

  it('eagerly scopes tool and prompt registrations and shares one revision across Agents', async () => {
    const ctx = await setup()
    await declare(ctx, contribution('standard'))
    await declare(ctx, contribution('minimal'))
    expect(ctx.agentPresets.inspectCompositions()).toHaveLength(2)
    const first = await agentOn(ctx, 'first')
    const second = await agentOn(ctx, 'second', 'minimal')
    const third = await agentOn(ctx, 'third')
    expect(ctx.agentPresets.inspectCompositions(ctx)).toEqual([])
    expect(ctx.agentPresets.inspectCompositions(first.ctx).map(row => row.id)).toEqual(['standard'])
    expect(ctx.agentPresets.inspectCompositions(second.ctx).map(row => row.id)).toEqual(['minimal'])
    expect(ctx.tools.schemas(first).map(row => row.name)).toEqual(['standard'])
    expect(ctx.tools.schemas(second).map(row => row.name)).toEqual(['minimal'])
    expect(ctx.tools.schemas(third).map(row => row.name)).toEqual(['standard'])
    expect(ctx.tools.schemas()).toEqual([])
    const prompt = await ctx.systemPrompt.assemble(assembleContextFor(first))
    expect(prompt.sections.map(row => row.name)).toContain('preset:standard')
    expect(prompt.sections.map(row => row.name)).not.toContain('preset:minimal')
    expect(ctx.agentPresets.inspectCompositions()).toHaveLength(2)
  })

  it('retains a replaced revision for existing scopes and their children, then releases it', async () => {
    const ctx = await setup()
    const old = await declare(ctx, contribution('standard'))
    const agent = createScope(ctx, {})
    await ctx.agentPresets.mount(agent.ctx)
    const oldKey = await currentKey(ctx)
    await old.dispose()
    await declare(ctx, { ...contribution('replacement'), id: 'standard' })
    expect(await currentKey(ctx)).not.toBe(oldKey)
    expect(ctx.agentPresets.inspectCompositions()).toHaveLength(2)
    const child = createScope(ctx, {})
    expect(ctx.agentPresets.composeFrom(child.ctx, agent.ctx)).toBe('standard')
    await agent.dispose()
    expect(ctx.agentPresets.inspectCompositions()).toHaveLength(2)
    await child.dispose()
    expect(ctx.agentPresets.inspectCompositions()).toHaveLength(1)
    const fresh = await agentOn(ctx, 'fresh')
    expect(ctx.tools.schemas(fresh).map(row => row.name)).toEqual(['replacement'])
  })

  it('removes definitions without revoking live bindings', async () => {
    const ctx = await setup()
    const definition = await declare(ctx, contribution('standard'))
    const agent = createScope(ctx, {})
    await ctx.agentPresets.mount(agent.ctx)
    await definition.dispose()
    expect(await ctx.agentPresets.list()).toEqual([])
    await expect(ctx.agentPresets.resolve()).rejects.toThrow('Unknown agent preset')
    expect(ctx.agentPresets.composedPreset(agent.ctx)).toBe('standard')
    await agent.dispose()
    expect(ctx.agentPresets.inspectCompositions()).toEqual([])
  })

  it('reports a failed definition while allowing healthy definitions and the host to start', async () => {
    const ctx = await setup()
    await declare(ctx, { id: 'broken', plugins: [{ name: 'missing-preset-plugin-for-test' }] })
    await declare(ctx, contribution('standard'))
    expect(await ctx.agentPresets.resolve('broken')).toMatchObject({ id: 'broken', broken: expect.any(String) as string })
    const scope = createScope(ctx, {})
    await expect(ctx.agentPresets.mount(scope.ctx, 'broken')).rejects.toThrow()
    expect(await ctx.agentPresets.mount(scope.ctx)).toEqual({ id: 'standard' })
    const roster = await ctx.agentPresets.remoteExportList()
    expect(roster.presets.find(row => row.id === 'standard')?.isDefault).toBe(true)
  })

  it('rejects duplicate IDs without disposing the first definition', async () => {
    const ctx = await setup()
    await declare(ctx, contribution('standard'))
    await expect(declare(ctx, contribution('standard'))).rejects.toThrow('Duplicate agent preset')
    expect(await ctx.agentPresets.resolve()).toEqual({ id: 'standard' })
  })

  it('rebinds a blank scope and preserves a child inheriting its former revision', async () => {
    const ctx = await setup()
    await declare(ctx, contribution('standard'))
    await declare(ctx, contribution('minimal'))
    const scope = createScope(ctx, {})
    await ctx.agentPresets.mount(scope.ctx)
    await ctx.agentPresets.mount(scope.ctx)
    const child = createScope(ctx, {})
    ctx.agentPresets.composeFrom(child.ctx, scope.ctx)
    await ctx.agentPresets.recompose(scope.ctx, 'minimal')
    expect(ctx.agentPresets.composedPreset(scope.ctx)).toBe('minimal')
    expect(ctx.agentPresets.composedPreset(child.ctx)).toBe('standard')
    expect(ctx.agentPresets.composeFrom(createScope(ctx, {}).ctx, ctx)).toBeUndefined()
  })

  it('logs selection and rejects preset changes after the first turn', async () => {
    const ctx = await setup()
    await declare(ctx, contribution('standard'))
    await declare(ctx, contribution('minimal'))
    const agent = await agentOn(ctx, 'selection')
    expect(await ctx.agentPresets.select(agent, 'minimal')).toBe('minimal')
    expect(ctx.sessionProjections.checkpoint(agent.session).agentPreset?.val).toBe('minimal')
    agent.session.append('turn/start', { turn: 1 })
    await expect(ctx.agentPresets.select(agent, 'standard')).rejects.toThrow('already started')
  })

  it('inventories active and disabled child entries and declared display metadata', async () => {
    const ctx = await setup()
    await declare(ctx, { ...contribution('standard'), name: 'Standard', description: 'General', order: 2 })
    await declare(ctx, { id: 'empty', order: 1, plugins: [{ name: 'missing', disabled: true }] })
    expect((await ctx.agentPresets.list()).map(row => row.id)).toEqual(['empty', 'standard'])
    expect(await ctx.agentPresets.compositionInventory()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'standard', name: 'Standard', isDefault: true, rows: expect.any(Array) as unknown[] }),
      expect.objectContaining({ id: 'empty', rows: [expect.objectContaining({ moduleName: 'missing', enabled: false })] }),
    ]))
  })

  it('renders a declaration as entry-list YAML for reading, conditions included', async () => {
    const ctx = await setup()
    await declare(ctx, {
      ...contribution('standard'), name: 'Standard', description: 'General',
      plugins: [
        { id: 'contribute', name: plugin('contribute'), config: { tool: 'standard' } },
        { id: 'windows-only', name: 'missing', disabled: { __jsExpr: "process.platform !== 'win32'" } },
      ],
    })
    const document = await ctx.agentPresets.readDocument('standard')
    expect(document).toMatchObject({ agentPreset: 'standard', name: 'Standard', description: 'General' })
    expect(document.content.startsWith('- id: contribute\n  name: ')).toBe(true)
    expect(document.content).toContain("\n  config:\n    tool: standard\n- id: windows-only\n  name: missing\n  disabled: !!js process.platform !== 'win32'\n")
    expect(document.content).not.toContain('__jsExpr')
    await declare(ctx, contribution('minimal'))
    expect(await ctx.agentPresets.readDocument('minimal')).toEqual({
      agentPreset: 'minimal', content: expect.any(String) as string,
    })
    await expect(ctx.agentPresets.readDocument('absent')).rejects.toThrow('Unknown agent preset: absent')
  })
})

it('retains a retired revision for an in-flight cold read', async () => {
  const ctx = await setup()
  const definition = await declare(ctx, contribution('standard'))
  const lease = await ctx.agentPresets.acquireScope()
  await definition.dispose()
  expect(ctx.agentPresets.inspectCompositions()).toHaveLength(1)
  await lease[Symbol.asyncDispose]()
  await lease[Symbol.asyncDispose]()
  expect(ctx.agentPresets.inspectCompositions()).toEqual([])
})

it.each([['throws', 'refused'], ['global-service', 'require isolate realms']])('contains a %s plugin activation failure', async (name, reason) => {
  const ctx = await setup()
  const { plugin } = await import('./harness.ts')
  await declare(ctx, { id: 'invalid', plugins: [{ name: plugin(name), config: { message: 'refused', service: 'fixtureService' } }] })
  expect((await ctx.agentPresets.resolve('invalid')).broken).toContain(reason)
  expect(ctx.get('fixtureService')).toBeUndefined()
  expect(ctx.agentPresets.inspectCompositions()).toEqual([])
})

it('keeps a row waiting for an absent service mounted, reports it, and refuses bindings', async () => {
  const ctx = await setup()
  const { plugin } = await import('./harness.ts')
  await declare(ctx, { id: 'invalid', plugins: [{ name: plugin('needs-missing') }] })
  expect((await ctx.agentPresets.resolve('invalid')).broken).toContain('waiting for serviceThatDoesNotExist')
  expect(ctx.agentPresets.inspectCompositions()).toHaveLength(1)
  await expect(ctx.agentPresets.mount(createScope(ctx, {}).ctx, 'invalid')).rejects.toThrow('waiting for serviceThatDoesNotExist')
  expect((await ctx.agentPresets.list())[0]!.broken).toContain('waiting for serviceThatDoesNotExist')
})

it('waits for a Host provider still activating instead of recording the preset as broken', async () => {
  const ctx = await setup()
  const { plugin } = await import('./harness.ts')
  let release!: () => void
  const paused = new Promise<void>((resolve) => { release = resolve })
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  ctx.loader.builtins.slowProvider = { async apply(host: Context) {
    entered()
    await paused
    host.provide('serviceThatDoesNotExist', { label: 'late host' })
  } }
  const hostUpdate = ctx.loader.root.update([{ id: 'slow', name: 'cordis:slowProvider' }])
  await started
  await declare(ctx, { id: 'late', plugins: [{ name: plugin('needs-missing') }] })
  expect(ctx.agentPresets.inspectCompositions()).toHaveLength(1)
  const acquiring = ctx.agentPresets.acquireScope('late')
  const outcome = await Promise.race([
    acquiring.then(() => 'settled', () => 'settled'),
    new Promise<string>((resolve) => { setImmediate(() => { resolve('waiting') }) }),
  ])
  expect(outcome).toBe('waiting')
  release()
  await hostUpdate
  const lease = await acquiring
  expect(await ctx.agentPresets.resolve('late')).toEqual({ id: 'late' })
  expect((await ctx.agentPresets.compositionInventory())[0]).toMatchObject({ id: 'late',
    rows: [expect.objectContaining({ moduleName: plugin('needs-missing'), enabled: true })] })
  await lease[Symbol.asyncDispose]()
})

it('allows an isolated service and resolves it through the Agent composition', async () => {
  const ctx = await setup()
  const { plugin } = await import('./harness.ts')
  await declare(ctx, { id: 'standard', plugins: [{ name: 'cordis:group', group: true,
    isolate: { fixtureService: true }, config: [{ name: plugin('global-service'), config: { service: 'fixtureService', label: 'scoped' } }] }] })
  const scope = createScope(ctx, {})
  await ctx.agentPresets.mount(scope.ctx)
  expect(ctx.agentPresets.serviceFor({ ctx: scope.ctx }, 'fixtureService' as string & keyof Context)).toEqual({ label: 'scoped' })
  expect(ctx.agentPresets.serviceFor({ ctx }, 'fixtureService' as string & keyof Context)).toBeUndefined()
  expect(ctx.agentPresets.serviceFor({ ctx: scope.ctx }, 'loader')).toBeUndefined()
})

it('resolves the saved default over the deployment default, and drops a removed override', async () => {
  const ctx = await harness({ live: true })
  contexts.push(ctx)
  const live = liveRegistries.get(ctx)!
  await live.update({ selectedDefault: 'minimal' })
  expect(ctx.agentPresets.defaultId).toBe('minimal')
  await live.replace({ default: 'standard' })
  expect(ctx.agentPresets.defaultId).toBe('standard')
})

it('keeps child-only presets available by recorded ID while excluding them from main-session selection', async () => {
  const ctx = await harness({ live: true })
  contexts.push(ctx)
  await declare(ctx, contribution('standard'))
  await declare(ctx, { ...contribution('role'), subagentOnly: true })
  await liveRegistries.get(ctx)!.update({ selectedDefault: 'role' })

  expect(ctx.agentPresets.defaultId).toBe('standard')
  expect((await ctx.agentPresets.remoteExportList()).presets).toContainEqual(expect.objectContaining({
    id: 'role', subagentOnly: true, isDefault: false,
  }))
  await expect(ctx.agentPresets.resolve('role', 'main-session')).rejects.toThrow('reserved for subagents')
  expect(await ctx.agentPresets.resolve(undefined, 'main-session')).toEqual({ id: 'standard' })
  const main = await agentOn(ctx, 'main')
  await expect(ctx.agentPresets.select(main, 'role')).rejects.toThrow('reserved for subagents')
  expect(ctx.agentPresets.composedPreset(main.ctx)).toBe('standard')
  const recorded = await ctx.agentPresets.resolve('role')
  const existing = await agentOn(ctx, 'existing', recorded.id)
  expect(ctx.agentPresets.composedPreset(existing.ctx)).toBe('role')
  const child = await ctx.agents.create({ sessionId: SessionId('child'), meta: { origin: 'subagent' } })
  expect(await ctx.agentPresets.select(child.agent, 'role')).toBe('role')
  expect(ctx.agentPresets.composedPreset(child.agent.ctx)).toBe('role')
})

it('ignores a retired modeSelectionEnabled field in the user patch', async () => {
  const ctx = await harness({ live: true })
  contexts.push(ctx)
  const live = liveRegistries.get(ctx)!
  await declare(ctx, contribution('minimal'))
  // A patch written before Developer tools became the only gate still carries
  // this key; the Loader's declared fields simply do not include it.
  await live.update({ selectedDefault: 'minimal', modeSelectionEnabled: false })
  expect(ctx.agentPresets.defaultId).toBe('minimal')
  expect((await ctx.agentPresets.remoteExportList()).presets.find(row => row.id === 'minimal')?.isDefault).toBe(true)
  // Neither read nor rewritten: the raw entry keeps the key it was loaded with.
  expect(live.entry.options.config).toMatchObject({ selectedDefault: 'minimal', modeSelectionEnabled: false })
})

it('keeps its own instance off the generated Settings pages', () => omitsGeneratedPage(async (ctx) => {
  await ctx.plugin(Loader)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  return ctx.plugin(AgentPresets, { default: 'standard' })
}))

it('refuses an unscoped binding and a second child join without leaking references', async () => {
  const ctx = await setup()
  const definition = await declare(ctx, contribution('standard'))
  await expect(ctx.agentPresets.mount(ctx)).rejects.toThrow('scoped context')
  await expect(ctx.agentPresets.register({ id: ' ', plugins: [] })).rejects.toThrow('empty')
  const parent = createScope(ctx, {})
  await ctx.agentPresets.mount(parent.ctx)
  expect(() => ctx.agentPresets.composeFrom(ctx, parent.ctx)).toThrow('requires a scope')
  const child = createScope(ctx, {})
  ctx.agentPresets.composeFrom(child.ctx, parent.ctx)
  expect(() => ctx.agentPresets.composeFrom(child.ctx, parent.ctx)).toThrow('already joined')
  await definition.dispose()
  await child.dispose()
  await parent.dispose()
  expect(ctx.agentPresets.inspectCompositions()).toHaveLength(0)
  await expect(ctx.agentPresets.acquireScope()).rejects.toThrow('Unknown')
})

it('serializes competing blank-session selections and recovers after a failed selection', async () => {
  const ctx = await setup()
  await declare(ctx, contribution('standard'))
  await declare(ctx, contribution('minimal'))
  const agent = await agentOn(ctx, 'competing')
  const results = await Promise.allSettled([
    ctx.agentPresets.select(agent, 'absent'), ctx.agentPresets.select(agent, 'minimal'), ctx.agentPresets.select(agent, 'standard'),
  ])
  expect(results.map(row => row.status)).toEqual(['rejected', 'fulfilled', 'fulfilled'])
  expect(ctx.sessionProjections.checkpoint(agent.session).agentPreset?.val).toBe('standard')
})

it('retains a newly acquired generation when a previous activation is replaced', async () => {
  const ctx = await setup()
  let release!: () => void
  const paused = new Promise<void>((resolve) => { release = resolve })
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  ctx.loader.builtins.delayed = { async apply() { entered(); await paused } }
  const pending = ctx.agentPresets.register({ id: 'standard', plugins: [{ name: 'cordis:delayed' }] })
  await started
  const leasePromise = ctx.agentPresets.acquireScope()
  release()
  const dispose = await pending
  const lease = await leasePromise
  await dispose()
  expect(ctx.agentPresets.inspectCompositions()).toHaveLength(1)
  await lease[Symbol.asyncDispose]()
  expect(ctx.agentPresets.inspectCompositions()).toHaveLength(0)
})

it('keeps a blank Session that already runs the current revision of the selected preset without logging', async () => {
  const ctx = await setup()
  await declare(ctx, contribution('standard'))
  await declare(ctx, contribution('minimal'))
  const agent = await agentOn(ctx, 'repeated')
  expect(await ctx.agentPresets.select(agent, 'minimal')).toBe('minimal')
  let notified = 0
  ctx.on('tools/change', () => { notified++ })

  expect(await ctx.agentPresets.select(agent, 'minimal')).toBe('minimal')

  expect(agent.session.snapshotEvents().filter(event => event.type === 'agent-preset/selected')).toHaveLength(1)
  expect(notified).toBe(0)
})

it('logs the default preset a blank Session runs once it is selected without a recorded preset', async () => {
  const ctx = await setup()
  await declare(ctx, contribution('standard'))
  const agent = await agentOn(ctx, 'unrecorded')
  expect(ctx.agentPresets.presetForSession(agent.session)).toBeNull()

  expect(await ctx.agentPresets.select(agent, 'standard')).toBe('standard')

  expect(ctx.agentPresets.presetForSession(agent.session)).toBe('standard')
})

it('recomposes and logs a repeated selection once the preset definition was replaced', async () => {
  const ctx = await setup()
  await declare(ctx, contribution('standard'))
  const replaced = await declare(ctx, contribution('minimal'))
  const agent = await agentOn(ctx, 'redefined')
  await ctx.agentPresets.select(agent, 'minimal')
  await replaced.dispose()
  await declare(ctx, contribution('minimal'))
  let notified = 0
  ctx.on('tools/change', () => { notified++ })

  expect(await ctx.agentPresets.select(agent, 'minimal')).toBe('minimal')

  expect(agent.session.snapshotEvents().filter(event => event.type === 'agent-preset/selected')).toHaveLength(2)
  expect(notified).toBeGreaterThan(0)
})

it('does not lose the durable selection when a tools observer rejects notification', async () => {
  const ctx = await setup()
  await declare(ctx, contribution('standard'))
  await declare(ctx, contribution('minimal'))
  const agent = await agentOn(ctx, 'observer')
  ctx.on('tools/change', () => { throw new Error('observer refused') })
  expect(await ctx.agentPresets.select(agent, 'minimal')).toBe('minimal')
  expect(ctx.sessionProjections.checkpoint(agent.session).agentPreset?.val).toBe('minimal')
})

it('inventories failed conditional entries without executing their expressions again', async () => {
  const ctx = await setup()
  await declare(ctx, { id: 'broken', name: 'Broken', plugins: [
    { name: 'missing', disabled: { __jsExpr: 'false' } },
  ] })
  const inventory = await ctx.agentPresets.compositionInventory()
  expect(inventory[0]).toMatchObject({ id: 'broken', broken: expect.any(String) as string,
    rows: [{ moduleName: 'missing', enabled: 'conditional', condition: 'false' }] })
})

it('does not bind a definition removed while acquisition yields, and disposal is idempotent', async () => {
  const ctx = await setup()
  const dispose = await ctx.agentPresets.register(contribution('standard'))
  const acquiring = ctx.agentPresets.acquireScope()
  const rejection = expect(acquiring).rejects.toThrow('Unknown agent preset')
  await dispose()
  await rejection
  await declare(ctx, contribution('standard'))
  await dispose()
  expect(await ctx.agentPresets.resolve()).toEqual({ id: 'standard' })
})

it('refuses to inherit a revision owned by a different registry', async () => {
  const ctx = await setup()
  const other = await setup()
  await declare(other, contribution('standard'))
  const parent = createScope(other, {})
  await other.agentPresets.mount(parent.ctx)
  expect(() => ctx.agentPresets.composeFrom(createScope(ctx, {}).ctx, parent.ctx)).toThrow('revision is unavailable')
})

it('validates malformed child YAML at the declaring plugin and retains diagnostics', async () => {
  const ctx = await setup()
  const { default: Preset } = await import('@deepseek-ai/dsh-agent-preset')
  ctx.loader.builtins.preset = Preset
  await ctx.loader.root.update([{ id: 'invalid', name: 'cordis:preset', config: { id: 'invalid', plugins: [1] } }])
  expect((await ctx.agentPresets.resolve('invalid')).broken).toContain('not a plugin row')
  expect((await ctx.agentPresets.compositionInventory())[0]!.rows).toEqual([])
})

it.each([
  ['nope', 'the composition must be a top-level list of plugin rows'],
  [[[]], 'row 1 is not a plugin row (expected a map with a "name")'],
  [[{ name: '' }], 'row 1 names no plugin (a "name" string is required)'],
  [[{ name: 'group', group: true, config: 'x' }], 'group row 1 must hold a list of plugin rows'],
  [[{ name: 'group', group: true, config: [{}] }], 'row 1 row 1 names no plugin (a "name" string is required)'],
  [[{ name: 'group', group: true, config: [{ name: 'child' }] }], undefined],
])('names the first invalid row of %j', (rows, problem) => {
  expect(entryListProblem(rows)).toBe(problem)
})

it('reports every process-global service published by a preset', async () => {
  const ctx = await setup()
  ctx.loader.builtins.leaks = { apply(child: Context) {
    child.provide('presetZulu', {})
    child.provide('presetAlpha', {})
  } }
  await declare(ctx, { id: 'leaks', plugins: [{ name: 'cordis:leaks' }] })
  expect((await ctx.agentPresets.resolve('leaks')).broken).toContain('presetAlpha, presetZulu')
})
