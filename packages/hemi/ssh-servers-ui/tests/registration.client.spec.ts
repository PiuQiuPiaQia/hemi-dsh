import { Context, Service } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RemoteEndpoint } from '@deepseek-ai/dsh-api-remote-access/client'
import { RemoteError, type TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteStream, type RemoteStreamFactory } from '@deepseek-ai/dsh-api-gateway/client'
import { ResourceRegistry } from '@deepseek-ai/dsh-client-resources/src/client/resources.ts'
import type { SshAuthenticationChallenge, SshAuthenticationChallengeId } from '@deepseek-ai/dsh-hemi-ssh-servers/workspace-types'
import { AUTHENTICATION_ADDRESS } from '../src/client/authentication-resources.ts'
import { editorDirectoryAddress } from '../src/client/editor-directories.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SshServer, SshServerId } from '@deepseek-ai/dsh-hemi-ssh-servers/types'
import type { ConnectionPickerInjected } from '../src/client/ConnectionPicker.tsx'
import type { MenuContribution } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type { FolderInjected } from '../src/client/types.ts'
import type { ResourceProtocol } from '@deepseek-ai/dsh-client-resources/client'
import { whenAllowed, type AccessEffect } from '@deepseek-ai/dsh-api-remote-access/src/client/when-allowed.ts'
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import { mountServers } from '../src/client/mount.ts'
import type { ServerRemote } from '../src/client/controller.ts'
import type {} from '@deepseek-ai/dsh-hemi-ssh-servers/remote'
import { createEditorStore } from '../src/client/store.ts'
import { ServerOverlay } from '../src/client/ServerOverlay.tsx'
import { en } from '../src/client/locales.ts'
import type { EditorInjected } from '../src/client/types.ts'

async function bench() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('locale', new LocaleRuntime(ctx))
  await ctx.plugin(SlotRegistry).await()
  const grants = {
    'hemiSshServers/list': createSnapshotStore(true), 'hemiSshServers/create': createSnapshotStore(true),
    'hemiSshServers/update': createSnapshotStore(true), 'hemiSshServers/removeServer': createSnapshotStore(true),
    'hemiSshWorkspaces/browseSavedFolders': createSnapshotStore(true), 'hemiSshWorkspaces/prepareServerFolder': createSnapshotStore(true),
    'hemiSshWorkspaces/connectServer': createSnapshotStore(true), 'hemiSshWorkspaces/browseServer': createSnapshotStore(true),
    'hemiSshWorkspaces/getRuntime': createSnapshotStore(true), 'hemiSshWorkspaces/configureRuntime': createSnapshotStore(true),
    'hemiSshWorkspaces/browseFolders': createSnapshotStore(true), 'hemiSshWorkspaces/prepareFolder': createSnapshotStore(true),
    'workspace/create': createSnapshotStore(true),
  }
  class Access extends Service {
    constructor(scope: Context) { super(scope, 'remoteAccess') }
    whenAccess(action: RemoteEndpoint, callback: () => AccessEffect): () => void {
      const key = action as keyof typeof grants
      return whenAllowed(this.ctx, grants[key], callback, 'fixture grant')
    }
  }
  new Access(ctx)
  const remote: ServerRemote = {
    list: vi.fn<ServerRemote['list']>(async () => ({ ok: true, value: [] })),
    create: vi.fn(), update: vi.fn(), removeServer: vi.fn(),
  }
  const folders: TypertClientRemote['hemiSshWorkspaces'] = {
    followAuthentication: vi.fn(), answerAuthentication: vi.fn(), answerAuthenticationAndRemember: vi.fn(),
    browseSavedFolders: vi.fn(), prepareServerFolder: vi.fn(), connectServer: vi.fn(), browseServer: vi.fn(),
    getRuntime: vi.fn(), configureRuntime: vi.fn(), browseFolders: vi.fn(), prepareFolder: vi.fn(),
  }
  ctx.provide('workspaces', { create: vi.fn() } as never)
  const unmount = vi.fn()
  const mount = vi.fn(async () => {
    const remove = ctx.reflect.provide('remote.hemiSshServers', remote)
    const removeFolders = ctx.reflect.provide('remote.hemiSshWorkspaces', folders)
    return async () => { unmount(); await removeFolders(); await remove() }
  })
  const stream: RemoteStreamFactory['$stream'] = options => new RemoteStream({ generation: {
    getSnapshot: () => ({ id: 1, host: { home: '/fixture' } }), subscribe: () => () => {},
  } }, options)
  ctx.provide('remote', { $mount: mount, $stream: stream, hemiSshServers: remote, hemiSshWorkspaces: folders } as never)
  const menus = new Map<string, MenuContribution<'hemi-ssh-connection'>>()
  ctx.provide('contextMenus', { register: (entry: MenuContribution<'hemi-ssh-connection'>) => {
    menus.set(entry.id, entry)
    return () => { menus.delete(entry.id) }
  } } as never)
  const providers = new Set<ResourceProvider<ResourceProtocol>>()
  const resources = new ResourceRegistry(ctx)
  ctx.provide('resources', {
    source: (address: string) => resources.source(address),
    pin: (address: string, signal: AbortSignal) => { resources.pin(address, signal) },
    register: (provider: ResourceProvider<ResourceProtocol>) => {
      providers.add(provider)
      const remove = resources.register(provider)
      return () => { remove(); providers.delete(provider) }
    },
  })
  const declare = () => ctx.slots.register({ name: 'root', children: {
    'shell.overlay': { kind: 'list', scope: 'root' },
    'sidebar.workspaces.add.actions': { kind: 'list', scope: 'root' },
    'conversation.hero.workspace.add.actions': { kind: 'list', scope: 'root' },
    'conversation.hero.workspace.connections': { kind: 'list', scope: 'root' },
  } } as never, () => null)
  const collapse = declare()
  const fiber = ctx.plugin({
    inject: ['slots', 'locale', 'remote', 'remoteAccess', 'resources', 'workspaces'],
    apply: scope => mountServers(scope, { package: '@fixture/ssh', descriptors: [] }),
  })
  await fiber.await()
  return { ctx, fiber, grants, menus, providers, remote, folders, mount, unmount, declare, collapse }
}

it('shares one registered interaction store and withdraws every contribution before unmounting the namespace', async () => {
  const b = await bench()
  const overlay = b.ctx.slots.entries('shell.overlay')[0]!
  const add = b.ctx.slots.entries('sidebar.workspaces.add.actions')[0]!
  const connections = b.ctx.slots.entries('conversation.hero.workspace.connections')[0]!
  expect(overlay.component).toBe(ServerOverlay)
  expect(overlay.store).toBe(add.store)
  expect(overlay.store).toBe(b.ctx.slots.entries('conversation.hero.workspace.add.actions')[0]!.store)
  expect(overlay.store).toBe(connections.store)
  expect(b.ctx.slots.entries('shell.overlay')[1]!.store).toBe(overlay.store)
  expect(b.providers.size).toBe(4)
  expect(b.remote.list).not.toHaveBeenCalled()
  const actions = createEditorStore().create().actions
  const value = overlay.inject!(actions as never)
  const injected: EditorInjected = {
    save: value.save as EditorInjected['save'], remove: value.remove as EditorInjected['remove'],
    refresh: value.refresh as EditorInjected['refresh'],
  }
  await b.fiber.dispose()
  expect(b.ctx.slots.entries('shell.overlay')).toHaveLength(0)
  expect(b.ctx.slots.entries('sidebar.workspaces.add.actions')).toHaveLength(0)
  expect(b.ctx.slots.entries('conversation.hero.workspace.add.actions')).toHaveLength(0)
  expect(b.providers.size).toBe(0)
  expect(b.unmount).toHaveBeenCalledOnce()
  injected.refresh()
  injected.save(null, { name: 'Late', host: 'prod', port: 22, username: '', identityFile: '' })
  expect(b.remote.list).not.toHaveBeenCalled()
  expect(b.remote.create).not.toHaveBeenCalled()
})

it('replaces the authentication provider on connection reset and stops replacement after teardown', async () => {
  const b = await bench()
  const authentication = () => [...b.providers].find(provider => provider.protocol === 'hemi-ssh-authentication')
  const original = authentication()
  b.ctx.emit('connection/reset')
  const replacement = authentication()
  expect(replacement).toBeDefined()
  expect(replacement).not.toBe(original)
  expect(b.providers.size).toBe(4)
  b.ctx.emit('connection/reset')
  expect(authentication()).not.toBe(replacement)
  const recovered = authentication()
  const editor = [...b.providers].find(provider => provider.protocol === 'hemi-ssh-editor-folders')!
  editor.open('dsh-resource://hemi-ssh-editor-folders/staged', { signal: new AbortController().signal })
  expect(authentication()).not.toBe(recovered)
  expect(b.providers.size).toBe(4)
  expect(b.folders.browseFolders).not.toHaveBeenCalled()
  await b.fiber.dispose()
  b.ctx.emit('connection/reset')
  expect(b.providers.size).toBe(0)
})

it('restores live authentication when a new connection editor browses after an idle terminal failure', async () => {
  const b = await bench()
  const failed = Promise.withResolvers<undefined>()
  const challenge: SshAuthenticationChallenge = {
    id: brandString<SshAuthenticationChallengeId>('new-connection-login'), kind: 'input', prompt: 'fixture password:', canRemember: true,
    endpoint: { host: 'fixture', username: 'operator', identityFile: '', port: 22 },
  }
  vi.mocked(b.folders.followAuthentication).mockImplementationOnce(() => ({
    send: () => {}, end: () => {}, dispose: () => {},
    async *[Symbol.asyncIterator]() { yield []; await failed.promise; throw new RemoteError('gateway/internal', 'fixture terminal', {}) },
  })).mockImplementationOnce((signal = new AbortController().signal) => ({
    send: () => {}, end: () => {}, dispose: () => {},
    async *[Symbol.asyncIterator]() {
      yield [challenge]
      if (!signal.aborted) await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    },
  }))
  const authentication = b.ctx.resources.source(AUTHENTICATION_ADDRESS)
  const stopAuthentication = authentication.subscribe(() => {})
  onTestFinished(stopAuthentication)
  await vi.waitFor(() => { expect(authentication.getSnapshot()).toMatchObject({ status: 'live', value: [] }) })
  failed.resolve(undefined)
  await vi.waitFor(() => { expect(authentication.getSnapshot().status).toBe('failed') })
  vi.mocked(b.folders.browseServer).mockResolvedValueOnce({ ok: true, value: { path: '/remote', parentPath: '/', directories: [] } })
  const staged = b.ctx.resources.source(editorDirectoryAddress({
    name: 'Unsaved connection', host: 'fixture', username: 'operator', identityFile: '', port: 22,
  }, '', 1))
  const stopStaged = staged.subscribe(() => {})
  onTestFinished(stopStaged)
  await vi.waitFor(() => { expect(authentication.getSnapshot()).toMatchObject({ status: 'live', value: [challenge] }) })
  await vi.waitFor(() => { expect(staged.getSnapshot()).toMatchObject({ status: 'live', value: { path: '/remote' } }) })
  expect(b.folders.followAuthentication).toHaveBeenCalledTimes(2)
  expect(b.folders.browseServer).toHaveBeenCalledOnce()
  await b.fiber.dispose()
})

it('removes access-gated actions and resources and restores them without duplicating the namespace', async () => {
  const b = await bench()
  b.grants['hemiSshServers/create'].set(false)
  expect(b.ctx.slots.entries('sidebar.workspaces.add.actions')).toHaveLength(0)
  expect(b.ctx.slots.entries('conversation.hero.workspace.add.actions')).toHaveLength(0)
  expect(b.ctx.slots.entries('conversation.hero.workspace.connections')).toHaveLength(1)
  b.grants['hemiSshServers/list'].set(false)
  expect(b.ctx.slots.entries('shell.overlay')).toHaveLength(0)
  expect(b.providers.size).toBe(0)
  b.grants['hemiSshServers/list'].set(true)
  b.grants['hemiSshServers/create'].set(true)
  expect(b.ctx.slots.entries('sidebar.workspaces.add.actions')).toHaveLength(1)
  expect(b.ctx.slots.entries('conversation.hero.workspace.add.actions')).toHaveLength(1)
  expect(b.ctx.slots.entries('conversation.hero.workspace.connections')).toHaveLength(1)
  expect(b.providers.size).toBe(4)
  expect(b.mount).toHaveBeenCalledOnce()
})

it('ignores a retained close callback after its registration is replaced', async () => {
  const b = await bench()
  const oldStore = createEditorStore().create()
  const oldFace = b.ctx.slots.entries('shell.overlay')[1]!.inject!(oldStore.actions as never)
  const oldClose = oldFace.closeFolder as FolderInjected['closeFolder']
  b.collapse(); b.declare()
  const current = createEditorStore().create()
  const connections = b.ctx.slots.entries('conversation.hero.workspace.connections')[0]!.inject!(current.actions as never)
  const choose = connections.openConnection as ConnectionPickerInjected['openConnection']
  const server: SshServer = { id: brandString<SshServerId>('connection-1'), revision: 'r1', name: 'Current',
    host: 'current', username: '', identityFile: '', port: 22 }
  choose(server, vi.fn())
  const request = current.getSnapshot().request
  if (request?.kind !== 'folder') throw new Error('Expected the replacement folder interaction')
  oldClose()
  vi.mocked(b.folders.prepareServerFolder).mockResolvedValue({ ok: false,
    error: new RemoteError('hemi-ssh/connection-failed', 'fixture refusal', { serverId: server.id, operation: 'open' }) })
  const face = b.ctx.slots.entries('shell.overlay')[1]!.inject!(current.actions as never)
  const open = face.openFolder as FolderInjected['openFolder']
  open(request.selection, '/remote/project')
  await Promise.resolve()
  expect(b.folders.prepareServerFolder).toHaveBeenCalledOnce()
})

it('follows slot declaration collapse and reinstatement with no detached launchers', async () => {
  const b = await bench()
  b.collapse()
  expect(b.ctx.slots.entries('sidebar.workspaces.add.actions')).toHaveLength(0)
  expect(b.ctx.slots.entries('conversation.hero.workspace.add.actions')).toHaveLength(0)
  expect(b.ctx.slots.entries('shell.overlay')).toHaveLength(0)
  b.declare()
  expect(b.ctx.slots.entries('sidebar.workspaces.add.actions')).toHaveLength(1)
  expect(b.ctx.slots.entries('conversation.hero.workspace.add.actions')).toHaveLength(1)
  expect(b.ctx.slots.entries('conversation.hero.workspace.connections')).toHaveLength(1)
  expect(b.ctx.slots.entries('shell.overlay')).toHaveLength(3)
})

it('registers captured edit/delete context actions only while their permissions and plugin remain', async () => {
  const b = await bench()
  const server: SshServer = { id: brandString<SshServerId>('menu-target'), revision: 'r1', name: 'Remote', host: 'host',
    username: 'user', port: 22, identityFile: '' }
  const store = createEditorStore().create()
  const value = b.ctx.slots.entries('conversation.hero.workspace.connections')[0]!.inject!(store.actions as never)
  const capture = value.menuTarget as ConnectionPickerInjected['menuTarget']
  const signal = new AbortController().signal, dismiss = vi.fn()
  const first = capture(server, dismiss)
  const edit = await b.menus.get('hemi-ssh.edit')!.resolve(first, signal)
  expect(edit[0]?.label).toBe(en.edit)
  await edit[0]?.run?.()
  expect(store.getSnapshot().request).toEqual({ kind: 'edit', server })
  const second = capture(server, dismiss)
  expect(await b.menus.get('hemi-ssh.edit')!.resolve(first, signal)).toEqual([])
  const remove = await b.menus.get('hemi-ssh.remove')!.resolve(second, signal)
  expect(remove[0]?.label).toBe(en.deleteConnection)
  expect(remove[0]?.danger).toBe(true)
  await remove[0]?.run?.()
  expect(store.getSnapshot().request).toEqual({ kind: 'remove', server })
  expect(b.remote.removeServer).not.toHaveBeenCalled()
  b.grants['hemiSshServers/update'].set(false)
  expect(b.menus.has('hemi-ssh.edit')).toBe(false)
  expect(b.menus.has('hemi-ssh.remove')).toBe(true)
  b.grants['hemiSshServers/list'].set(false)
  expect(b.menus.size).toBe(0)
  await b.fiber.dispose()
})
