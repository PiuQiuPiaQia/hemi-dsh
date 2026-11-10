/** Real provider groups over a mocked SSH process transport and actual domain storage. */
import { EventEmitter, once } from 'node:events'
import { createHash } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import schema from '@deepseek-ai/schemastery'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { SshFileSystem } from '@deepseek-ai/dsh-fs-ssh'
import { SshSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-ssh'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { SshRpcPeer } from '@deepseek-ai/dsh-ssh/protocol'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ExecutionTargetId } from '@deepseek-ai/dsh-session'
import WorkspaceController, { type WorkspaceDisplayTitleProvider, type WorkspaceView, type WorkspaceFollowFrame } from '@deepseek-ai/dsh-api-workspace-controller'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { PROVISIONED_NODE_VERSION } from '../src/node-provision.ts'
import type * as nodeProvision from '../src/node-provision.ts'
import HemiSshServers from '../src/index.ts'
import HemiSshWorkspaces, { SSH_EXECUTION_PROVIDER } from '../src/workspaces.ts'
import type { SshRuntimeDeployment, SshWorkspaceRevision } from '../src/workspace-types.ts'

/** Provisioner options the service resolves from its Config and warning sink. */
type ProvisionOptions = Parameters<typeof nodeProvision.provisionRemoteNode>[3]

// Persistence/provider unit tests replace the external login process; native authentication has its own real-SSH suite.
vi.mock('../src/authentication.ts', async (original) => {
  const actual = await original<typeof import('../src/authentication.ts')>()
  return { ...actual, SshAuthentication: class {
    endpoint(input: import('../src/browse.ts').SshEndpointArgs): Promise<import('../src/browse.ts').SshEndpointArgs> {
      return Promise.resolve(input)
    }
    async dispose(): Promise<void> { await Promise.resolve() }
  } }
})

// Node provisioning downloads from nodejs.org; service tests script its outcome instead of contacting the network.
const provision = vi.hoisted(() => ({ remoteNode: vi.fn() }))
vi.mock('../src/node-provision.ts', async (original) => {
  const actual = await original<typeof import('../src/node-provision.ts')>()
  return { ...actual, provisionRemoteNode: provision.remoteNode }
})

const transport = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }))
vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(), spawn: transport.spawn, execFile: transport.execFile,
}))

class Child extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  closed = false
  kill(): boolean {
    if (!this.closed) {
      this.closed = true
      queueMicrotask(() => { this.emit('close', 0, null) })
    }
    return true
  }
}

const deployment: SshRuntimeDeployment = { helper: '/opt/hemi/helper', helperHash: 'a'.repeat(64), launch: { kind: 'executable' } }
const signal = new AbortController().signal

async function setup(options: {
  hello?: () => Promise<void>
  helperHash?: () => string
  bootstrapHash?: () => string
  withAgents?: boolean
  policy?: { mode: 'read-only' | 'workspace-write'; additionalWritableRoots: string[] }
  probe?: () => string
  displayTitles?: boolean
  withWorkspaceController?: boolean
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hemi-ssh-workspaces-'))
  const ctx = new Context()
  const children: Child[] = []
  const peers: SshRpcPeer[] = []
  const requests: { host: string; method: string; params: unknown }[] = []
  const shellCommands: string[] = []
  const launchCommands: string[] = []
  transport.execFile.mockImplementation((
    _command: string, args: unknown[], _options: unknown,
    callback: (error: Error | null, stdout?: string) => void,
  ) => {
    const remote = String(args.at(-1))
    shellCommands.push(remote)
    if (remote.includes('cd -- "$HOME"')) { callback(null, '/remote-home'); return }
    if (remote.startsWith('cd ')) {
      const path = /^cd '([^']*)'/.exec(remote)?.[1] ?? ''
      // The physical directory arrives as the first NUL-separated entry, before listing entries.
      callback(null, path === '/remote/other' ? `${path}\0` : `${path}\0${path}/nested\0`)
      return
    }
    if (remote.includes('command -v node')) { callback(null, options.probe?.() ?? 'H/remote-home\nN/usr/bin/node\nVv24.19.0\nC/remote-home/.cache/hemi-ssh'); return }
    callback(Object.assign(new Error('ssh: connection refused'), { code: 255 }), '')
  })
  transport.spawn.mockImplementation((_command: string, args: string[]) => {
    const child = new Child()
    children.push(child)
    if (!args.includes('-M')) {
      // A one-shot remote shell command: consume the streamed bytes and succeed.
      const command = args.at(-1) ?? ''
      shellCommands.push(command)
      void Promise.resolve(child.stdin).then(async (stream) => {
        stream.resume()
        await once(stream, 'end').catch(() => {})
        queueMicrotask(() => { child.emit('close', 0, null) })
      })
      return child
    }
    const host = args.at(-2) ?? ''
    launchCommands.push(args.at(-1) ?? '')
    const helper = new SshRpcPeer(child.stdin, child.stdout, 64 * 1024 * 1024, 128, async (method, params) => {
      requests.push({ host, method, params })
      switch (method) {
        case 'hello': {
          const hello = z.looseObject({ workspace: z.string(), bootstrapPath: z.string().optional() }).parse(params)
          await options.hello?.()
          const kind = (args.at(-1) ?? '').startsWith('NODE_OPTIONS') ? 'executable' : 'node-script'
          return {
            protocol: 3, hash: options.helperHash?.() ?? deployment.helperHash, kind, platform: 'linux', nodeVersion: 'v24.19.0',
            executable: deployment.helper, root: '/tmp/remote-helper', workspace: hello.workspace,
            ...(hello.bootstrapPath === undefined ? {} : { bootstrapHash: options.bootstrapHash?.() ?? 'b'.repeat(64) }),
          }
        }
        case 'heartbeat': case 'close': return null
        case 'fs.resolve': {
          const request = z.object({ path: z.string(), cwd: z.string().optional() }).strict().parse(params)
          const path = request.path === '/link' ? '/remote/project'
            : request.path === '/outside-link' ? '/opt/hemi/helper'
              : posix.resolve(request.cwd ?? '/', request.path)
          return { targetKey: path, displayPath: request.path }
        }
        case 'sandbox': {
          const request = z.object({ argv: z.array(z.string()), policy: z.unknown() }).strict().parse(params)
          return { argv: request.argv, enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
        }
        case 'fs.write': return { operation: 'create', version: 'v1', before: null, after: 'new' }
        case 'fs.stat': return { type: 'directory', version: '1' }
        case 'fs.list': return [{ name: 'nested', type: 'directory', target: { targetKey: '/remote/project/nested', displayPath: 'nested' } }]
        default: throw new Error(`unexpected helper operation ${method}`)
      }
    })
    peers.push(helper)
    return child
  })
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() } finally {
      for (const child of children) { child.kill(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy() }
      for (const peer of peers) peer.close()
      await rm(root, { recursive: true, force: true })
      vi.clearAllMocks()
    }
  })
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root)
  ctx.effect(() => () => backend.close())
  ctx.effect(() => ctx.storage.backend.register('json', backend))
  ctx.provide(storageBackendServiceKey('json'), backend)
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjections)
  if (options.withAgents !== false) await ctx.plugin(AgentRegistry)
  await ctx.plugin(SandboxPolicy, { mode: 'read-only', workspaceRoot: root, ...options.policy })
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(HemiSshServers)
  if (options.withWorkspaceController === true) {
    ctx.provide('sessionPersistence', { list: () => Promise.resolve([]) } as never)
    await ctx.plugin(WorkspaceRegistry)
    const dispose = (): void => {}
    ctx.provide('typert', {
      lookups: { configure: () => dispose }, contexts: { configureHost: () => dispose }, resources: { register: () => dispose },
    } as never)
    ctx.provide('remoteAccess', { allows: () => true } as never)
    new WorkspaceController(ctx, { documentsDirectory: root })
  }
  const titleProviders = new Set<WorkspaceDisplayTitleProvider>()
  if (options.displayTitles === true) {
    ctx.provide('workspaceController', {
      registerDisplayTitle: (provider: WorkspaceDisplayTitleProvider) => {
        titleProviders.add(provider)
        return () => { titleProviders.delete(provider) }
      },
    } as never)
  }
  const fiber = await ctx.plugin(HemiSshWorkspaces)
  const server = await ctx.hemiSshServers.create({ name: 'Remote', host: 'first-host', port: 2200, username: 'user', identityFile: '' }, signal)
  const currentRevision = (): SshWorkspaceRevision => {
    const saved = ctx.hemiSshServers.list(signal).find(row => row.id === server.id)
    const runtime = ctx.hemiSshWorkspaces.getRuntime(server.id, signal)
    if (saved === undefined || runtime === undefined) throw new Error('Fixture requires a saved endpoint and deployment')
    return { serverRevision: saved.revision, runtimeRevision: runtime.revision }
  }
  return { ctx, root, server, fiber, children, requests, shellCommands, launchCommands, currentRevision, titleProviders }
}

async function sameNamedRemoteWorkspaces() {
  const fixture = await setup({ withWorkspaceController: true })
  const { ctx, server } = fixture
  await ctx.hemiSshWorkspaces.configureRuntime(server.id, undefined, deployment, signal)
  const first = await ctx.hemiSshWorkspaces.prepareFolder(server.id, '/remote/project', fixture.currentRevision(), signal)
  const otherServer = await ctx.hemiSshServers.create({ name: server.name, host: 'second-host', port: 2200,
    username: 'user', identityFile: '' }, signal)
  const runtime = await ctx.hemiSshWorkspaces.configureRuntime(otherServer.id, undefined, deployment, signal)
  const second = await ctx.hemiSshWorkspaces.prepareFolder(otherServer.id, '/remote/project', {
    serverRevision: otherServer.revision, runtimeRevision: runtime.revision,
  }, signal)
  const one = (await ctx.workspaceController.create(first)).workspace
  const two = (await ctx.workspaceController.create(second)).workspace
  const markerPath = join(fixture.root, 'local-marker')
  await mkdir(markerPath)
  const marker = (await ctx.workspaceController.create({ path: markerPath })).workspace
  return { ...fixture, one, two, marker }
}

async function framesThroughOrder(
  iterator: AsyncIterator<WorkspaceFollowFrame>, order: readonly WorkspaceView['workspaceId'][],
): Promise<WorkspaceFollowFrame[]> {
  const frames: WorkspaceFollowFrame[] = []
  for (;;) {
    const next = await iterator.next()
    if (next.done === true) throw new Error('Workspace follow ended before the committed order marker')
    const frame = next.value
    frames.push(frame)
    if (frame.type === 'order' && frame.workspaceIds.length === order.length
      && frame.workspaceIds.every((id, index) => id === order[index])) return frames
  }
}

it('resolves authentication, provisioning and retained-master liveness settings from the workspace service schema', () => {
  expect(schema.resolve({}, HemiSshWorkspaces.Config, {})[0]).toEqual({
    authenticationTimeoutMs: 120_000, runtimeProvisionTimeoutMs: 300_000, serverAliveIntervalSeconds: 10, serverAliveCountMax: 3,
  })
  expect(HemiSshWorkspaces.Config({
    authenticationTimeoutMs: 7000, runtimeProvisionTimeoutMs: 250_000, serverAliveIntervalSeconds: 7, serverAliveCountMax: 2,
  })).toEqual({ authenticationTimeoutMs: 7000, runtimeProvisionTimeoutMs: 250_000, serverAliveIntervalSeconds: 7, serverAliveCountMax: 2 })
})

it.each([
  { authenticationTimeoutMs: 0 }, { authenticationTimeoutMs: 1.5 }, { authenticationTimeoutMs: 2_147_483_648 },
  { runtimeProvisionTimeoutMs: 0 }, { runtimeProvisionTimeoutMs: 1.5 }, { runtimeProvisionTimeoutMs: 2_147_483_648 },
  { serverAliveIntervalSeconds: 0 }, { serverAliveIntervalSeconds: 1.5 }, { serverAliveIntervalSeconds: 2_147_483_648 },
  { serverAliveCountMax: 0 }, { serverAliveCountMax: 1.5 }, { serverAliveCountMax: 2_147_483_648 },
])('refuses invalid authentication, provisioning or master-liveness configuration before SSH starts: %j', (config) => {
  expect(() => schema.resolve(config, HemiSshWorkspaces.Config, {})).toThrow()
  expect(transport.spawn).not.toHaveBeenCalled()
})

it('keeps server saving separate from explicit helper setup and refuses unavailable targets without Host I/O', async () => {
  const f = await setup()
  expect(f.ctx.hemiSshWorkspaces.getRuntime(f.server.id, signal)).toBeUndefined()
  await expect(f.ctx.hemiSshWorkspaces.prepareFolder(f.server.id, '/project',
    { serverRevision: f.server.revision, runtimeRevision: 'not-configured' }, signal))
    .rejects.toMatchObject({ code: 'hemi-ssh/runtime-unconfigured' })
  const hostResolve = vi.spyOn(f.ctx.fs, 'resolve')
  await expect(f.ctx.agents.acquireExecution({ provider: SSH_EXECUTION_PROVIDER,
    id: brandString<ExecutionTargetId>('00000000-0000-4000-8000-000000000001') }, signal))
    .rejects.toMatchObject({ code: 'hemi-ssh/target-unavailable' })
  expect(hostResolve).not.toHaveBeenCalled()
  expect(transport.spawn).not.toHaveBeenCalled()
})

it('projects stored target names through the optional BFF provider and removes that contribution on unload', async () => {
  const f = await setup({ displayTitles: true })
  expect(f.titleProviders.size).toBe(1)
  const provider = [...f.titleProviders][0]!
  const invalidate = vi.fn()
  const unsubscribe = provider.subscribe(invalidate)
  await f.ctx.hemiSshWorkspaces.configureRuntime(f.server.id, undefined, deployment, signal)
  const selected = await f.ctx.hemiSshWorkspaces.prepareFolder(f.server.id, '/remote/project', f.currentRevision(), signal)
  const workspace: WorkspaceView = {
    workspaceId: 'existing-workspace' as WorkspaceView['workspaceId'], path: selected.path, executionTarget: selected.executionTarget,
    title: 'project', sessionIds: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }
  expect(provider.resolve(workspace, [workspace])).toBe('project（Remote）')
  const { id, revision, ...fields } = f.server
  invalidate.mockClear()
  const renamed = await f.ctx.hemiSshServers.update(id, revision, { ...fields, name: 'Renamed' }, signal)
  expect(invalidate).toHaveBeenCalled()
  expect(provider.resolve(workspace, [workspace])).toBe('project（Renamed）')
  const replacement = await f.ctx.hemiSshServers.update(id, renamed.revision, { ...fields, name: 'Replacement', host: 'replacement-host' }, signal)
  expect(provider.resolve(workspace, [workspace])).toBe('project（Remote）')
  await f.ctx.hemiSshServers.removeServer(id, replacement.revision, signal)
  expect(provider.resolve(workspace, [workspace])).toBe('project（Remote）')
  expect(workspace.title).toBe('project')
  unsubscribe()
  invalidate.mockClear()
  await f.fiber.dispose()
  expect(f.titleProviders.size).toBe(0)
  await f.ctx.hemiSshServers.create({ ...fields, name: 'Later' }, signal)
  expect(invalidate).not.toHaveBeenCalled()
})

it('keeps every followed remote rename committed before the next Workspace order marker', async () => {
  const { ctx, one, two, marker } = await sameNamedRemoteWorkspaces()
  const abort = new AbortController()
  const iterator = ctx.workspaceController.follow(abort.signal)[Symbol.asyncIterator]()
  try {
    const opening = await iterator.next()
    expect(opening.value).toMatchObject({ type: 'baseline' })
    await ctx.workspaceController.rename({ workspaceId: one.workspaceId, title: 'Custom remote title' })
    // An order-only write is a deterministic marker after all rename upserts; it does not reproject labels itself.
    await ctx.workspaceController.insertBefore({ workspaceId: one.workspaceId, beforeWorkspaceId: two.workspaceId })
    const frames = await framesThroughOrder(iterator, [marker.workspaceId, one.workspaceId, two.workspaceId])
    const upserts = frames.filter(frame => frame.type === 'upsert')
    expect(upserts.filter(frame => frame.workspace.workspaceId === one.workspaceId).at(-1)?.workspace)
      .toMatchObject({ title: 'Custom remote title', displayTitle: 'Custom remote title（Remote）' })
    expect(upserts.filter(frame => frame.workspace.workspaceId === two.workspaceId).at(-1)?.workspace.displayTitle)
      .toBe('project（Remote）')
    expect(upserts.filter(frame => frame.workspace.workspaceId === one.workspaceId)
      .every(frame => frame.workspace.title === 'Custom remote title')).toBe(true)
  } finally { abort.abort(); await iterator.return?.() }
})

it('removes endpoint qualification from the remaining followed Workspace after deleting its collision peer', async () => {
  const { ctx, one, two, marker } = await sameNamedRemoteWorkspaces()
  const abort = new AbortController()
  const iterator = ctx.workspaceController.follow(abort.signal)[Symbol.asyncIterator]()
  try {
    const opening = await iterator.next()
    if (opening.done === true || opening.value.type !== 'baseline') throw new Error('Workspace follow requires an opening baseline')
    expect(opening.value.value.items.find(workspace => workspace.workspaceId === one.workspaceId)?.displayTitle)
      .toBe('project（Remote · user@first-host:2200）')
    expect(opening.value.value.items.find(workspace => workspace.workspaceId === two.workspaceId)?.displayTitle)
      .toBe('project（Remote · user@second-host:2200）')
    await ctx.workspaceController.delete({ workspaceId: two.workspaceId })
    await ctx.workspaceController.insertBefore({ workspaceId: one.workspaceId, beforeWorkspaceId: marker.workspaceId })
    const frames = await framesThroughOrder(iterator, [one.workspaceId, marker.workspaceId])
    const upserts = frames.filter(frame => frame.type === 'upsert')
    expect(frames).toContainEqual({ type: 'remove', workspaceId: two.workspaceId })
    expect(upserts.filter(frame => frame.workspace.workspaceId === one.workspaceId).at(-1)?.workspace)
      .toMatchObject({ title: 'project', displayTitle: 'project（Remote）' })
    const removedAt = frames.findIndex(frame => frame.type === 'remove' && frame.workspaceId === two.workspaceId)
    expect(frames.slice(removedAt + 1).some(frame => frame.type === 'upsert' && frame.workspace.workspaceId === two.workspaceId)).toBe(false)
  } finally { abort.abort(); await iterator.return?.() }
})

it('selects a real remote directory with the Session-owned registry and no Agent service', async () => {
  const f = await setup({ withAgents: false })
  expect(f.ctx.get('agents')).toBeUndefined()
  await f.ctx.hemiSshWorkspaces.configureRuntime(f.server.id, undefined, deployment, signal)
  const selected = await f.ctx.hemiSshWorkspaces.prepareFolder(f.server.id, '/project', f.currentRevision(), signal)
  const lease = await f.ctx.sessions.acquireExecution(selected.executionTarget, signal)
  try { expect(lease.bind(f.ctx).get('fs')).toBeInstanceOf(SshFileSystem) } finally { await lease.close() }
})

it('persists explicit deployments without SSH and refuses a stale editor', async () => {
  const f = await setup()
  const configured = await f.ctx.hemiSshWorkspaces.configureRuntime(f.server.id, undefined, deployment, signal)
  expect(f.ctx.hemiSshWorkspaces.getRuntime(f.server.id, signal)).toEqual(configured)
  await expect(f.ctx.hemiSshWorkspaces.configureRuntime(f.server.id, undefined, deployment, signal))
    .rejects.toMatchObject({ code: 'hemi-ssh/connection-changed' })
  await f.fiber.dispose()
  await f.ctx.plugin(HemiSshWorkspaces)
  expect(f.ctx.hemiSshWorkspaces.getRuntime(f.server.id, signal)).toEqual(configured)
  expect(transport.spawn).not.toHaveBeenCalled()
})

it('resolves physical folders remotely, reuses immutable targets and supports multiple directories per connection', async () => {
  const f = await setup()
  const hostResolve = vi.spyOn(f.ctx.fs, 'resolve')
  await f.ctx.hemiSshWorkspaces.configureRuntime(f.server.id, undefined, deployment, signal)
  const first = await f.ctx.hemiSshWorkspaces.prepareFolder(f.server.id, '/link', f.currentRevision(), signal)
  expect(first.path).toBe('/remote/project')
  expect(first.title).toBe('project')
  expect(await f.ctx.hemiSshWorkspaces.prepareFolder(f.server.id, '/remote/project', f.currentRevision(), signal)).toEqual(first)
  const second = await f.ctx.hemiSshWorkspaces.prepareFolder(f.server.id, '/remote/other', f.currentRevision(), signal)
  expect(second.executionTarget).not.toEqual(first.executionTarget)
  expect(await f.ctx.hemiSshWorkspaces.browseFolders(f.server.id, '/remote/project', f.currentRevision(), signal)).toEqual({
    revision: f.currentRevision(), path: '/remote/project', parentPath: '/remote', directories: [{ name: 'nested', path: '/remote/project/nested' }],
  })
  expect(hostResolve).not.toHaveBeenCalled()
  expect(f.requests.some(request => request.method === 'fs.resolve')).toBe(true)
})

it('refuses to switch endpoints between browsing a directory and preparing its Workspace', async () => {
  const f = await setup()
  await f.ctx.hemiSshWorkspaces.configureRuntime(f.server.id, undefined, deployment, signal)
  const browsed = await f.ctx.hemiSshWorkspaces.browseFolders(f.server.id, '/project', f.currentRevision(), signal)
  const { id, revision, ...fields } = f.server
  await f.ctx.hemiSshServers.update(id, revision, { ...fields, host: 'replacement-host' }, signal)
  const starts = transport.spawn.mock.calls.length
  await expect(f.ctx.hemiSshWorkspaces.prepareFolder(id, browsed.path, browsed.revision, signal))
    .rejects.toMatchObject({ code: 'hemi-ssh/connection-changed' })
  expect(transport.spawn).toHaveBeenCalledTimes(starts)
})

it('refuses an endpoint changed since selection before the first browse starts SSH', async () => {
  const f = await setup()
  await f.ctx.hemiSshWorkspaces.configureRuntime(f.server.id, undefined, deployment, signal)
  const expected = f.currentRevision()
  const { id, revision, ...fields } = f.server
  await f.ctx.hemiSshServers.update(id, revision, { ...fields, host: 'replacement-host' }, signal)
  await expect(f.ctx.hemiSshWorkspaces.browseFolders(id, '/project', expected, signal))
    .rejects.toMatchObject({ code: 'hemi-ssh/connection-changed' })
  expect(transport.spawn).not.toHaveBeenCalled()
  expect(transport.execFile).not.toHaveBeenCalled()
})

it('refuses a deployment changed after browsing before another SSH instance starts', async () => {
  const f = await setup()
  const runtime = await f.ctx.hemiSshWorkspaces.configureRuntime(f.server.id, undefined, deployment, signal)
  const browsed = await f.ctx.hemiSshWorkspaces.browseFolders(f.server.id, '/project', f.currentRevision(), signal)
  await f.ctx.hemiSshWorkspaces.configureRuntime(f.server.id, runtime.revision, deployment, signal)
  const starts = transport.spawn.mock.calls.length
  await expect(f.ctx.hemiSshWorkspaces.prepareFolder(f.server.id, browsed.path, browsed.revision, signal))
    .rejects.toMatchObject({ code: 'hemi-ssh/connection-changed' })
  expect(transport.spawn).toHaveBeenCalledTimes(starts)
})

it('retains the commit-time revision check when the endpoint changes during SSH startup', async () => {
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const f = await setup({ hello: () => { entered.resolve(undefined); return release.promise } })
  await f.ctx.hemiSshWorkspaces.configureRuntime(f.server.id, undefined, deployment, signal)
  const preparing = f.ctx.hemiSshWorkspaces.prepareFolder(f.server.id, '/project', f.currentRevision(), signal)
  await entered.promise
  try {
    const { id, revision, ...fields } = f.server
    await f.ctx.hemiSshServers.update(id, revision, { ...fields, host: 'replacement-host' }, signal)
    release.resolve(undefined)
    await expect(preparing).rejects.toMatchObject({ code: 'hemi-ssh/connection-changed' })
  } finally { release.resolve(undefined); await Promise.allSettled([preparing]) }
})

it('shares six providers only within a live instance and leaves Host services unchanged', async () => {
  const f = await setup()
  await f.ctx.hemiSshWorkspaces.configureRuntime(f.server.id, undefined, deployment, signal)
  const selected = await f.ctx.hemiSshWorkspaces.prepareFolder(f.server.id, '/project', f.currentRevision(), signal)
  const [first, second] = await Promise.all([
    f.ctx.agents.acquireExecution(selected.executionTarget, signal), f.ctx.agents.acquireExecution(selected.executionTarget, signal),
  ])
  try {
    const bound = first.bind(f.ctx)
    expect(bound.get('fs')).toBeInstanceOf(SshFileSystem)
    expect(bound.get('subprocess')).toBeInstanceOf(SshSubprocessRuntime)
    expect(bound.get('shell')).toBeInstanceOf(SandboxBashExecutor)
    expect(bound.get('shell')?.resolve({ command: 'pwd' }).workdir).toBe('/project')
    expect(bound.get('ptcRuntime')?.language).toBe('typescript')
    expect(f.ctx.get('fs')).toBeInstanceOf(LocalFileSystem)
    expect(first.realm).toBe(second.realm)
    await first.close()
    expect(second.signal.aborted).toBe(false)
    await second.close()
    const fresh = await f.ctx.agents.acquireExecution(selected.executionTarget, signal)
    try { expect(fresh.realm).not.toBe(second.realm) } finally { await fresh.close() }
  } finally { await Promise.all([first.close(), second.close()]) }
})

it('keeps saved Session targets on their original endpoint after editing or removing the connection', async () => {
  const f = await setup()
  await f.ctx.hemiSshWorkspaces.configureRuntime(f.server.id, undefined, deployment, signal)
  const selected = await f.ctx.hemiSshWorkspaces.prepareFolder(f.server.id, '/project', f.currentRevision(), signal)
  const { id, revision, ...fields } = f.server
  const edited = await f.ctx.hemiSshServers.update(id, revision, { ...fields, host: 'replacement-host' }, signal)
  const updated = await f.ctx.hemiSshWorkspaces.prepareFolder(id, '/project', f.currentRevision(), signal)
  expect(updated.executionTarget).not.toEqual(selected.executionTarget)
  await f.ctx.hemiSshServers.removeServer(id, edited.revision, signal)
  const count = f.requests.length
  const lease = await f.ctx.agents.acquireExecution(selected.executionTarget, signal)
  expect(f.requests.slice(count).filter(request => request.method === 'hello').map(request => request.host)).toEqual(['first-host'])
  await lease.close()
})

it('resolves agentless FS, Bash and PTC policies from the verified target workspace without deployment grants', async () => {
  const f = await setup({ policy: { mode: 'workspace-write', additionalWritableRoots: ['/shared'] } })
  await f.ctx.hemiSshWorkspaces.configureRuntime(f.server.id, undefined, deployment, signal)
  const selected = await f.ctx.hemiSshWorkspaces.prepareFolder(f.server.id, '/link', f.currentRevision(), signal)
  const lease = await f.ctx.sessions.acquireExecution(selected.executionTarget, signal)
  try {
    const bound = lease.bind(f.ctx)
    const fs = bound.get('fs')!
    const expected = { mode: 'workspace-write', workspaceRoot: '/remote/project' }
    expect(bound.get('sandbox')!.executionTarget).toEqual(selected.executionTarget)
    expect(bound.get('shell')!.resolve({ command: 'true' }).sandboxPolicy).toEqual(expected)
    expect(bound.get('ptcRuntime')!.resolve({ program: 'return 1', bindings: [] })).toMatchObject({ cwd: '/remote/project', sandboxPolicy: expected })
    await fs.writeText(await fs.resolve('file.txt'), 'new', { kind: 'createIfAbsent' })
    expect(f.requests.findLast(request => request.method === 'fs.write')?.params).toMatchObject({ policy: expected })
    expect(f.ctx.sandboxPolicy.resolve().additionalWritableRoots).toEqual(['/shared'])
  } finally { await lease.close() }
})

it('owns the admitted target policy before SSH request encoding yields to a mutable caller', async () => {
  const f = await setup()
  await f.ctx.hemiSshWorkspaces.configureRuntime(f.server.id, undefined, deployment, signal)
  const selected = await f.ctx.hemiSshWorkspaces.prepareFolder(f.server.id, '/project', f.currentRevision(), signal)
  const lease = await f.ctx.sessions.acquireExecution(selected.executionTarget, signal)
  try {
    const bound = lease.bind(f.ctx)
    const fs = bound.get('fs')!
    const target = await fs.resolve('/project/file.txt')
    const roots: string[] = []
    const policy = { mode: 'workspace-write' as const, workspaceRoot: '/project', additionalWritableRoots: roots }
    const writing = fs.writeText(target, 'new', undefined, signal, policy)
    roots.push('/shared'); policy.workspaceRoot = '/shared'
    await writing
    expect(f.requests.findLast(request => request.method === 'fs.write')?.params).toMatchObject({
      policy: { mode: 'workspace-write', workspaceRoot: '/project' },
    })
    expect(z.object({ policy: z.object({ additionalWritableRoots: z.unknown().optional() }) }).parse(
      f.requests.findLast(request => request.method === 'fs.write')?.params).policy.additionalWritableRoots).toBeUndefined()
    const sandboxRoots: string[] = []
    const confinedPolicy = { mode: 'workspace-write' as const, workspaceRoot: '/project', additionalWritableRoots: sandboxRoots }
    const confining = bound.get('sandbox')!.confine(['true'], confinedPolicy, signal)
    sandboxRoots.push('/shared'); confinedPolicy.workspaceRoot = '/shared'
    await confining
    expect(f.requests.findLast(request => request.method === 'sandbox')?.params).toEqual({
      argv: ['true'], policy: { mode: 'workspace-write', workspaceRoot: '/project' },
    })
  } finally { await lease.close() }
})

it.each(['read-only', 'workspace-write'] as const)('refuses caller-supplied deployment roots at each target mutation and confinement operation under %s', async (mode) => {
  const f = await setup({ policy: { mode, additionalWritableRoots: ['/shared'] } })
  await f.ctx.hemiSshWorkspaces.configureRuntime(f.server.id, undefined, deployment, signal)
  const selected = await f.ctx.hemiSshWorkspaces.prepareFolder(f.server.id, '/project', f.currentRevision(), signal)
  const lease = await f.ctx.sessions.acquireExecution(selected.executionTarget, signal)
  try {
    const bound = lease.bind(f.ctx)
    const fs = bound.get('fs')!
    const target = await fs.resolve('file.txt')
    const policy = f.ctx.sandboxPolicy.resolve()
    const before = f.requests.length
    const refused = { code: 'SANDBOX_UNSUPPORTED_POLICY' }
    await expect(fs.writeText(target, 'new', undefined, signal, policy)).rejects.toMatchObject(refused)
    await expect(fs.editText(target, { oldString: 'old', newString: 'new', replaceAll: false }, undefined, signal, policy)).rejects.toMatchObject(refused)
    await expect(fs.patchText(target, [], undefined, signal, policy)).rejects.toMatchObject(refused)
    await expect(fs.deleteFile(target, undefined, signal, policy)).rejects.toMatchObject(refused)
    await expect(fs.moveFile(target, target, { hunks: [], expectedDestination: { kind: 'createIfAbsent' } }, signal, policy)).rejects.toMatchObject(refused)
    await expect(bound.get('sandbox')!.confine(['true'], { ...policy, mode }, signal)).rejects.toMatchObject(refused)
    expect(f.requests.slice(before).filter(request => request.method !== 'heartbeat')).toEqual([])
  } finally { await lease.close() }
})

it.each(['provider', 'root'] as const)('waits for a borrowed instance during %s withdrawal before closing SSH', async (owner) => {
  const f = await setup()
  await f.ctx.hemiSshWorkspaces.configureRuntime(f.server.id, undefined, deployment, signal)
  const selected = await f.ctx.hemiSshWorkspaces.prepareFolder(f.server.id, '/project', f.currentRevision(), signal)
  const lease = await f.ctx.agents.acquireExecution(selected.executionTarget, signal)
  const child = f.children.at(-1)
  const aborted = once(lease.signal, 'abort')
  const disposal = owner === 'root' ? f.ctx.fiber.dispose() : f.fiber.dispose()
  try {
    await aborted
    await setImmediate()
    expect(child?.closed).toBe(false)
    await lease.close()
    await disposal
    expect(child?.closed).toBe(true)
  } finally { await lease.close(); await disposal }
})

it('does not let one cancelled startup borrower close another borrower’s SSH instance', async () => {
  const entered = Promise.withResolvers<undefined>()
  const released = Promise.withResolvers<undefined>()
  let hold = false
  const f = await setup({ hello: async () => { if (hold) { entered.resolve(undefined); await released.promise } } })
  await f.ctx.hemiSshWorkspaces.configureRuntime(f.server.id, undefined, deployment, signal)
  const selected = await f.ctx.hemiSshWorkspaces.prepareFolder(f.server.id, '/project', f.currentRevision(), signal)
  hold = true
  const cancelled = new AbortController()
  const first = f.ctx.agents.acquireExecution(selected.executionTarget, cancelled.signal)
  const rejected = expect(first).rejects.toThrow('cancel one borrower')
  const second = f.ctx.agents.acquireExecution(selected.executionTarget, signal)
  try {
    await entered.promise
    cancelled.abort(new Error('cancel one borrower'))
    await rejected
    expect(f.children.at(-1)?.closed).toBe(false)
    released.resolve(undefined)
    const lease = await second
    try { expect(lease.bind(f.ctx).get('fs')).toBeInstanceOf(SshFileSystem) } finally { await lease.close() }
  } finally {
    released.resolve(undefined)
    await rejected
    const remaining = await second
    await remaining.close()
  }
})

it('drains an abandoned pending handshake before provider withdrawal finishes', async () => {
  const entered = Promise.withResolvers<undefined>()
  const released = Promise.withResolvers<undefined>()
  let hold = false
  const f = await setup({ hello: async () => { if (hold) { entered.resolve(undefined); await released.promise } } })
  await f.ctx.hemiSshWorkspaces.configureRuntime(f.server.id, undefined, deployment, signal)
  const selected = await f.ctx.hemiSshWorkspaces.prepareFolder(f.server.id, '/project', f.currentRevision(), signal)
  hold = true
  const cancelled = new AbortController()
  const pending = f.ctx.agents.acquireExecution(selected.executionTarget, cancelled.signal)
  const rejected = expect(pending).rejects.toThrow('cancel handshake')
  try {
    await entered.promise
    cancelled.abort(new Error('cancel handshake'))
    await rejected
    const disposal = f.fiber.dispose()
    released.resolve(undefined)
    await disposal
    expect(f.children.at(-1)?.closed).toBe(true)
  } finally { released.resolve(undefined); await rejected }
})

it('closes a rejected helper and allows a fresh connection after the deployment is repaired', async () => {
  let broken = true
  const f = await setup({ helperHash: () => broken ? 'b'.repeat(64) : deployment.helperHash })
  await f.ctx.hemiSshWorkspaces.configureRuntime(f.server.id, undefined, deployment, signal)
  await expect(f.ctx.hemiSshWorkspaces.prepareFolder(f.server.id, '/project', f.currentRevision(), signal))
    .rejects.toMatchObject({ code: 'hemi-ssh/connection-failed' })
  expect(f.children.at(-1)?.closed).toBe(true)
  broken = false
  await expect(f.ctx.hemiSshWorkspaces.prepareFolder(f.server.id, '/project', f.currentRevision(), signal)).resolves.toMatchObject({ path: '/project' })
})

it('revokes a disconnected execution lease without publishing Host bindings', async () => {
  const f = await setup()
  await f.ctx.hemiSshWorkspaces.configureRuntime(f.server.id, undefined, deployment, signal)
  const selected = await f.ctx.hemiSshWorkspaces.prepareFolder(f.server.id, '/project', f.currentRevision(), signal)
  const lease = await f.ctx.agents.acquireExecution(selected.executionTarget, signal)
  const aborted = once(lease.signal, 'abort')
  try {
    f.children.at(-1)?.kill()
    await aborted
    expect(() => lease.bind(f.ctx)).toThrow()
    expect(f.ctx.get('fs')).toBeInstanceOf(LocalFileSystem)
  } finally { await lease.close() }
})

/** Digest-consistent bundled artifact set in the shipped lib/remote layout. */
async function artifactFixture(): Promise<{
  dir: string
  helperHash: string
  bootstrapHash: string
  version: string
  contentId: string
}> {
  const dir = await mkdtemp(join(tmpdir(), 'hemi-ssh-artifacts-'))
  const helper = Buffer.from('// bundled helper fixture\n')
  const bootstrap = Buffer.from('// bundled bootstrap fixture\n')
  const pkg = Buffer.from('{"name":"hemi-ssh-helper-runtime","version":"9.9.9-test","type":"module"}\n')
  await mkdir(join(dir, 'runtime/helper'), { recursive: true })
  await writeFile(join(dir, 'runtime/helper/helper.js'), helper)
  await writeFile(join(dir, 'runtime/helper/ptc-process.js'), bootstrap)
  await writeFile(join(dir, 'runtime/package.json'), pkg)
  const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
  const files = [
    { path: 'runtime/helper/helper.js', sha256: digest(helper) },
    { path: 'runtime/helper/ptc-process.js', sha256: digest(bootstrap) },
    { path: 'runtime/package.json', sha256: digest(pkg) },
  ]
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({
    version: '9.9.9-test', helper: 'runtime/helper/helper.js', bootstrap: 'runtime/helper/ptc-process.js', files,
  }))
  const contentId = createHash('sha256').update(JSON.stringify(files.map(file => [file.path, file.sha256]))).digest('hex').slice(0, 16)
  return { dir, helperHash: digest(helper), bootstrapHash: digest(bootstrap), version: '9.9.9-test', contentId }
}

it('connectServer deploys and verifies the bundled runtime, then keeps the saved revision stable', async () => {
  const artifacts = await artifactFixture()
  onTestFinished(async () => { vi.unstubAllEnvs(); await rm(artifacts.dir, { recursive: true, force: true }) })
  vi.stubEnv('DSH_HEMI_SSH_HELPER_DIR', artifacts.dir)
  const f = await setup({ helperHash: () => artifacts.helperHash, bootstrapHash: () => artifacts.bootstrapHash })
  const ready = await f.ctx.hemiSshWorkspaces.connectServer(f.server.id, f.server.revision, signal)
  const runtimeDir = `/remote-home/.cache/hemi-ssh/helper-${artifacts.version}-${artifacts.contentId}`
  expect(ready).toEqual({
    serverId: f.server.id, revision: ready.revision,
    deployment: {
      helper: `${runtimeDir}/runtime/helper/helper.js`,
      helperHash: artifacts.helperHash,
      launch: { kind: 'node-script', node: '/usr/bin/node',
        bootstrapPath: `${runtimeDir}/runtime/helper/ptc-process.js`,
        bootstrapHash: artifacts.bootstrapHash },
    },
  })
  // probe + one stream command per artifact file, then a verification helper connection
  expect(f.shellCommands.some(command => command.includes('command -v node'))).toBe(true)
  expect(f.shellCommands.filter(command => command.includes('umask 077'))).toHaveLength(3)
  expect(f.requests.filter(request => request.method === 'hello').map(request => request.host)).toEqual(['first-host'])
  const again = await f.ctx.hemiSshWorkspaces.connectServer(f.server.id, f.server.revision, signal)
  expect(again).toEqual(ready)
  expect(again.revision).toBe(ready.revision)
  // the persisted deployment now serves the ordinary revision-bound flows
  expect(await f.ctx.hemiSshWorkspaces.browseFolders(f.server.id, '/remote/project', f.currentRevision(), signal))
    .toMatchObject({ path: '/remote/project' })
})

it('connectServer provisions a remote Node runtime and launches the helper with the provisioned path', async () => {
  const artifacts = await artifactFixture()
  onTestFinished(async () => { vi.unstubAllEnvs(); await rm(artifacts.dir, { recursive: true, force: true }) })
  vi.stubEnv('DSH_HEMI_SSH_HELPER_DIR', artifacts.dir)
  const f = await setup({ helperHash: () => artifacts.helperHash, bootstrapHash: () => artifacts.bootstrapHash,
    probe: () => 'H/remote-home\nN\nV\nC/remote-home/.cache/hemi-ssh' })
  const nodeCache = `/remote-home/.cache/hemi-ssh/node/${PROVISIONED_NODE_VERSION}-linux-x64`
  const provisionedNode = `${nodeCache}/runtime/node-${PROVISIONED_NODE_VERSION}-linux-x64/bin/node`
  let provisionOptions: ProvisionOptions | undefined
  provision.remoteNode.mockImplementation(async (_endpoint: unknown, _cacheDir: string, _signal: AbortSignal,
    options: ProvisionOptions) => { provisionOptions = options; return provisionedNode })
  const ready = await f.ctx.hemiSshWorkspaces.connectServer(f.server.id, f.server.revision, signal)
  const runtimeDir = `/remote-home/.cache/hemi-ssh/helper-${artifacts.version}-${artifacts.contentId}`
  expect(ready).toEqual({
    serverId: f.server.id, revision: ready.revision,
    deployment: {
      helper: `${runtimeDir}/runtime/helper/helper.js`,
      helperHash: artifacts.helperHash,
      launch: { kind: 'node-script', node: provisionedNode,
        bootstrapPath: `${runtimeDir}/runtime/helper/ptc-process.js`, bootstrapHash: artifacts.bootstrapHash },
    },
  })
  expect(provision.remoteNode).toHaveBeenCalledTimes(1)
  expect(provision.remoteNode).toHaveBeenCalledWith(expect.objectContaining({ host: 'first-host' }),
    '/remote-home/.cache/hemi-ssh', expect.any(AbortSignal), expect.objectContaining({ timeoutMs: 300_000 }))
  // provisioning warnings surface through the Host logger
  const logged: string[] = []
  vi.spyOn(f.ctx.logger, 'warn').mockImplementation((message: unknown) => { logged.push(String(message)) })
  provisionOptions?.onWarn?.('The remote system loads a musl loader')
  expect(logged).toContain('The remote system loads a musl loader')
  // the helper handshake runs under the provisioned Node, not a system Node
  const launchCommand = f.launchCommands.find(command => command.includes('--disable-sigusr1'))
  expect(launchCommand?.startsWith(`'${provisionedNode}'`)).toBe(true)
  // the saved deployment serves later connects without provisioning again
  const again = await f.ctx.hemiSshWorkspaces.connectServer(f.server.id, f.server.revision, signal)
  expect(again).toEqual(ready)
  expect(provision.remoteNode).toHaveBeenCalledTimes(1)
})

it('surfaces provisioning failures with the runtime-provision-failed code and persists nothing', async () => {
  const artifacts = await artifactFixture()
  onTestFinished(async () => { vi.unstubAllEnvs(); await rm(artifacts.dir, { recursive: true, force: true }) })
  vi.stubEnv('DSH_HEMI_SSH_HELPER_DIR', artifacts.dir)
  const f = await setup({ probe: () => 'H/remote-home\nN\nV\nC/remote-home/.cache/hemi-ssh' })
  provision.remoteNode.mockRejectedValue(new RemoteError('hemi-ssh/runtime-provision-failed',
    'Could not prepare the remote Node runtime', { host: 'first-host', detail: 'download failed' }))
  await expect(f.ctx.hemiSshWorkspaces.connectServer(f.server.id, f.server.revision, signal))
    .rejects.toMatchObject({ code: 'hemi-ssh/runtime-provision-failed', details: { host: 'first-host' } })
  expect(f.ctx.hemiSshWorkspaces.getRuntime(f.server.id, signal)).toBeUndefined()
  expect(f.requests.filter(request => request.method === 'hello')).toEqual([])
})

it('connectServer refuses a stale endpoint revision before contacting the host', async () => {
  const f = await setup()
  await expect(f.ctx.hemiSshWorkspaces.connectServer(f.server.id, 'stale-revision', signal))
    .rejects.toMatchObject({ code: 'hemi-ssh/connection-changed' })
  expect(transport.spawn).not.toHaveBeenCalled()
  expect(transport.execFile).not.toHaveBeenCalled()
})

it('browseServer inspects an unsaved endpoint, resolves its login directory and validates fields locally', async () => {
  const f = await setup()
  const draft = { name: 'Draft', host: 'first-host', port: 2200, username: 'user', identityFile: '' }
  await expect(f.ctx.hemiSshWorkspaces.browseServer({ ...draft, host: '' }, '/project', signal))
    .rejects.toMatchObject({ code: 'hemi-ssh/invalid-input' })
  expect(await f.ctx.hemiSshWorkspaces.browseServer(draft, '', signal)).toEqual({
    path: '/remote-home', parentPath: '/', directories: [{ name: 'nested', path: '/remote-home/nested' }],
  })
  expect(transport.spawn).not.toHaveBeenCalled()
})

it('browseServer reports refused transport without starting remote work', async () => {
  const f = await setup()
  transport.execFile.mockImplementationOnce((
    _command: string, _args: unknown[], _options: unknown, callback: (error: Error | null) => void,
  ) => { callback(Object.assign(new Error('ssh: connect refused'), { code: 255 })) })
  await expect(f.ctx.hemiSshWorkspaces.browseServer(
    { name: 'Draft', host: 'first-host', port: 2200, username: 'user', identityFile: '' }, '', signal))
    .rejects.toMatchObject({ code: 'hemi-ssh/ssh-unavailable', details: { host: 'first-host' } })
  expect(transport.spawn).not.toHaveBeenCalled()
})

it('browseSavedFolders needs no runtime and refuses a stale endpoint before SSH', async () => {
  const f = await setup()
  const view = await f.ctx.hemiSshWorkspaces.browseSavedFolders(f.server.id, '', f.server.revision, signal)
  expect(view).toEqual({ path: '/remote-home', parentPath: '/', directories: [{ name: 'nested', path: '/remote-home/nested' }] })
  expect(f.ctx.hemiSshWorkspaces.getRuntime(f.server.id, signal)).toBeUndefined()
  await expect(f.ctx.hemiSshWorkspaces.browseSavedFolders(f.server.id, '', 'stale', signal))
    .rejects.toMatchObject({ code: 'hemi-ssh/connection-changed' })
  expect(transport.spawn).not.toHaveBeenCalled()
})

it('prepareServerFolder connects the runtime automatically and opens the chosen directory', async () => {
  const artifacts = await artifactFixture()
  onTestFinished(async () => { vi.unstubAllEnvs(); await rm(artifacts.dir, { recursive: true, force: true }) })
  vi.stubEnv('DSH_HEMI_SSH_HELPER_DIR', artifacts.dir)
  const f = await setup({ helperHash: () => artifacts.helperHash, bootstrapHash: () => artifacts.bootstrapHash })
  const selected = await f.ctx.hemiSshWorkspaces.prepareServerFolder(f.server.id, '/remote/project', f.server.revision, signal)
  expect(selected).toMatchObject({ path: '/remote/project', title: 'project' })
  const lease = await f.ctx.sessions.acquireExecution(selected.executionTarget, signal)
  try { expect(lease.bind(f.ctx).get('fs')).toBeInstanceOf(SshFileSystem) } finally { await lease.close() }
})

it('prepareFolder refuses a workspace containing the deployed runtime', async () => {
  const f = await setup()
  await f.ctx.hemiSshWorkspaces.configureRuntime(f.server.id, undefined, deployment, signal)
  await expect(f.ctx.hemiSshWorkspaces.prepareFolder(f.server.id, '/opt', f.currentRevision(), signal))
    .rejects.toMatchObject({ code: 'hemi-ssh/runtime-inside-workspace' })
  await expect(f.ctx.hemiSshWorkspaces.prepareFolder(f.server.id, '/opt/hemi', f.currentRevision(), signal))
    .rejects.toMatchObject({ code: 'hemi-ssh/runtime-inside-workspace' })
  expect(transport.spawn).not.toHaveBeenCalled()
})

it('refuses a workspace whose resolved physical path contains the runtime, through an alias', async () => {
  const f = await setup()
  await f.ctx.hemiSshWorkspaces.configureRuntime(f.server.id, undefined, deployment, signal)
  // '/outside-link' resolves remotely to '/opt/hemi/helper'; the lexical preflight alone must not admit it.
  await expect(f.ctx.hemiSshWorkspaces.prepareFolder(f.server.id, '/outside-link', f.currentRevision(), signal))
    .rejects.toMatchObject({ code: 'hemi-ssh/runtime-inside-workspace' })
})

it('refuses the remote root directory as a workspace before contacting the helper', async () => {
  const f = await setup()
  await f.ctx.hemiSshWorkspaces.configureRuntime(f.server.id, undefined, deployment, signal)
  const starts = transport.spawn.mock.calls.length
  await expect(f.ctx.hemiSshWorkspaces.prepareFolder(f.server.id, '/', f.currentRevision(), signal))
    .rejects.toMatchObject({ code: 'hemi-ssh/runtime-inside-workspace' })
  expect(transport.spawn).toHaveBeenCalledTimes(starts)
})

it('keeps the saved state untouched when the endpoint is edited during runtime preparation', async () => {
  const artifacts = await artifactFixture()
  onTestFinished(async () => { vi.unstubAllEnvs(); await rm(artifacts.dir, { recursive: true, force: true }) })
  vi.stubEnv('DSH_HEMI_SSH_HELPER_DIR', artifacts.dir)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const f = await setup({
    helperHash: () => artifacts.helperHash, bootstrapHash: () => artifacts.bootstrapHash,
    hello: async () => { entered.resolve(undefined); await release.promise },
  })
  const connecting = f.ctx.hemiSshWorkspaces.connectServer(f.server.id, f.server.revision, signal)
  await entered.promise
  try {
    const { id, revision, ...fields } = f.server
    await f.ctx.hemiSshServers.update(id, revision, { ...fields, host: 'replacement-host' }, signal)
    release.resolve(undefined)
    await expect(connecting).rejects.toMatchObject({ code: 'hemi-ssh/connection-changed' })
    expect(f.ctx.hemiSshWorkspaces.getRuntime(f.server.id, signal)).toBeUndefined()
  } finally {
    release.resolve(undefined)
    await Promise.allSettled([connecting])
  }
})

it('refuses a stale empty workspace path before resolving the login directory over SSH', async () => {
  const f = await setup()
  await f.ctx.hemiSshWorkspaces.configureRuntime(f.server.id, undefined, deployment, signal)
  const stale = f.currentRevision()
  const { id, revision, ...fields } = f.server
  await f.ctx.hemiSshServers.update(id, revision, { ...fields, host: 'replacement-host' }, signal)
  const commands = f.shellCommands.length
  await expect(f.ctx.hemiSshWorkspaces.prepareFolder(id, '', stale, signal))
    .rejects.toMatchObject({ code: 'hemi-ssh/connection-changed' })
  expect(f.shellCommands).toHaveLength(commands)
  expect(transport.spawn).not.toHaveBeenCalled()
})
