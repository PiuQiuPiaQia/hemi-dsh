/** Folder interaction ownership over generated Remote methods and the ordinary Workspace admission callback. */
import { setImmediate as immediate } from 'node:timers/promises'
import { expect, it, onTestFinished, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RemoteError, type TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type { ExecutionProviderId, ExecutionTargetId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceCreateRequest, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/types'
import type { SshServer, SshServerId } from '@deepseek-ai/dsh-hemi-ssh-servers/types'
import type { SshRemoteDirectory } from '@deepseek-ai/dsh-hemi-ssh-servers/workspace-types'
import { FolderController } from '../src/client/folder-controller.ts'
import { foldersAddress } from '../src/client/addresses.ts'

const server: SshServer = { id: brandString<SshServerId>('connection-1'), revision: 'r1', name: 'Remote',
  host: 'remote', username: 'user', identityFile: '', port: 22 }
const target = { provider: brandString<ExecutionProviderId>('ssh-fixture'), id: brandString<ExecutionTargetId>('target-1') }
const directory = (path = '/remote/project'): SshRemoteDirectory => ({ path: path || '/remote/home', parentPath: '/remote', directories: [] })

function bench() {
  type Remote = Pick<TypertClientRemote['hemiSshWorkspaces'], 'browseSavedFolders' | 'prepareServerFolder'>
  const remote: Remote = {
    browseSavedFolders: vi.fn<Remote['browseSavedFolders']>(async (_server, path) => ({ ok: true, value: directory(path) })),
    prepareServerFolder: vi.fn<Remote['prepareServerFolder']>(async (_server, path) => ({ ok: true,
      value: { path, title: 'project', serverName: server.name, executionTarget: target } })),
  }
  const create = vi.fn(async (request: WorkspaceCreateRequest): Promise<WorkspaceView> => ({
    workspaceId: brandString<WorkspaceId>(`workspace-${request.path}`), path: request.path, title: 'project', sessionIds: [],
    createdAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-09T00:00:00Z', executionTarget: target,
  }))
  const picked = vi.fn<(id: WorkspaceId) => void>()
  const interrupted = vi.fn()
  const allowed = vi.fn(() => true)
  const controller = new FolderController(remote, create, allowed)
  onTestFinished(() => controller.dispose())
  const selected = controller.choose(server, picked, interrupted)
  if (selected.kind !== 'folder') throw new Error('Expected the folder interaction')
  return { remote, create, picked, interrupted, allowed, controller, selected }
}

it('browses the captured saved endpoint and resolves its remote home without preparing execution', async () => {
  const b = bench()
  expect(b.remote.browseSavedFolders).not.toHaveBeenCalled()
  expect(b.remote.prepareServerFolder).not.toHaveBeenCalled()
  const control = new AbortController()
  const reader = b.controller.foldersProvider()
    .open(foldersAddress(server.id, b.selected.selection), { signal: control.signal })[Symbol.asyncIterator]()
  expect((await reader.next()).value).toEqual({ ok: true, value: { directory: directory(''), request: 1 } })
  expect(b.remote.browseSavedFolders).toHaveBeenCalledWith(server.id, '', server.revision, expect.any(AbortSignal))
  expect(b.create).not.toHaveBeenCalled()
  expect(b.picked).not.toHaveBeenCalled()
  control.abort(); await reader.return?.()
})

it('starts a saved preferred directory without restricting later navigation', async () => {
  const b = bench()
  const selected = b.controller.choose({ ...server, directory: '/saved/project' }, b.picked, b.interrupted)
  if (selected.kind !== 'folder') throw new Error('Expected a folder interaction')
  const control = new AbortController()
  const reader = b.controller.foldersProvider()
    .open(foldersAddress(server.id, selected.selection), { signal: control.signal })[Symbol.asyncIterator]()
  expect((await reader.next()).value).toEqual({ ok: true, value: { directory: directory('/saved/project'), request: 1 } })
  control.abort(); await reader.return?.()
})

it('publishes only the newest requested directory after overlapping responses', async () => {
  const b = bench()
  const entered = Promise.withResolvers<undefined>()
  const first = Promise.withResolvers<SshRemoteDirectory>()
  vi.mocked(b.remote.browseSavedFolders).mockImplementation(async (_server, path) => {
    if (path === '/slow') { entered.resolve(undefined); return { ok: true, value: await first.promise } }
    return { ok: true, value: directory(path) }
  })
  const control = new AbortController()
  const reader = b.controller.foldersProvider()
    .open(foldersAddress(server.id, b.selected.selection), { signal: control.signal })[Symbol.asyncIterator]()
  await reader.next()
  try {
    b.controller.browse(b.selected.selection, '/slow')
    await entered.promise
    b.controller.browse(b.selected.selection, '/newest')
    expect((await reader.next()).value).toEqual({ ok: true, value: { directory: directory('/newest'), request: 3 } })
    expect(b.remote.browseSavedFolders).toHaveBeenLastCalledWith(server.id, '/newest', server.revision, expect.any(AbortSignal))
    first.resolve(directory('/slow'))
    await immediate()
    expect(b.controller.directoryRequest.getSnapshot()).toBe(3)
  } finally { first.resolve(directory('/slow')); control.abort(); await reader.return?.() }
})

it('preserves the last directory frame on failure rather than inventing a successful selection', async () => {
  const b = bench()
  const control = new AbortController()
  const reader = b.controller.foldersProvider()
    .open(foldersAddress(server.id, b.selected.selection), { signal: control.signal })[Symbol.asyncIterator]()
  await reader.next()
  b.controller.browse(b.selected.selection, '/good')
  expect((await reader.next()).value).toEqual({ ok: true, value: { directory: directory('/good'), request: 2 } })
  vi.mocked(b.remote.browseSavedFolders).mockResolvedValue({ ok: false,
    error: new RemoteError('hemi-ssh/connection-failed', 'private diagnostic', { serverId: server.id, operation: 'browse' }) })
  b.controller.browse(b.selected.selection, '/bad')
  expect((await reader.next()).value).toMatchObject({ ok: false, error: { code: 'hemi-ssh/connection-failed' } })
  expect(b.picked).not.toHaveBeenCalled()
  control.abort(); await reader.return?.()
})

it('admits the returned physical path and target before invoking the original picker', async () => {
  const b = bench()
  vi.mocked(b.remote.prepareServerFolder).mockResolvedValue({ ok: true,
    value: { path: '/physical/project', title: 'project', serverName: server.name, executionTarget: target } })
  expect(await b.controller.open(b.selected.selection, '/link')).toEqual({ kind: 'complete' })
  expect(b.create).toHaveBeenCalledExactlyOnceWith({ path: '/physical/project', executionTarget: target })
  expect(b.picked).toHaveBeenCalledExactlyOnceWith('workspace-/physical/project')
})

it('opens different directory Workspaces through the same saved connection', async () => {
  const b = bench()
  await b.controller.open(b.selected.selection, '/one')
  const next = b.controller.choose(server, b.picked, b.interrupted)
  if (next.kind !== 'folder') throw new Error('Expected a folder interaction')
  await b.controller.open(next.selection, '/two')
  expect(b.picked.mock.calls.map(call => call[0])).toEqual(['workspace-/one', 'workspace-/two'])
  expect(b.remote.prepareServerFolder).toHaveBeenCalledTimes(2)
})

it('cancels before admission without creating a Workspace or navigating after a late directory response', async () => {
  const b = bench()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  vi.mocked(b.remote.prepareServerFolder).mockImplementation(async () => {
    entered.resolve(undefined); await release.promise
    return { ok: true, value: { path: '/project', title: 'project', serverName: server.name, executionTarget: target } }
  })
  const opening = b.controller.open(b.selected.selection, '/project')
  await entered.promise
  expect(b.controller.cancel()).toBe(false)
  release.resolve(undefined)
  expect(await opening).toEqual({ kind: 'withdrawn' })
  expect(b.create).not.toHaveBeenCalled()
  expect(b.picked).not.toHaveBeenCalled()
})

it('joins an admitted write after dismissal while suppressing late navigation', async () => {
  const b = bench()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  b.create.mockImplementation(async (request) => {
    entered.resolve(undefined); await release.promise
    return { workspaceId: brandString<WorkspaceId>('real-committed'), path: request.path, title: 'project', sessionIds: [], createdAt: '', updatedAt: '' }
  })
  const opening = b.controller.open(b.selected.selection, '/project')
  await entered.promise
  expect(b.controller.cancel()).toBe(true)
  let disposed = false
  const disposal = b.controller.dispose().then(() => { disposed = true })
  try {
    await immediate()
    expect(disposed).toBe(false)
    release.resolve(undefined)
    expect(await opening).toEqual({ kind: 'withdrawn' })
    await disposal
    expect(b.picked).not.toHaveBeenCalled()
  } finally { release.resolve(undefined); await opening; await disposal }
})

it('keeps a refused Workspace admission visible as a failure without calling the picker', async () => {
  const b = bench()
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    b.create.mockRejectedValue(new Error('workspace storage unavailable'))
    expect(await b.controller.open(b.selected.selection, '/project')).toEqual({ kind: 'failed', problem: 'workspaceFailed' })
    expect(b.picked).not.toHaveBeenCalled()
  } finally { log.mockRestore() }
})

it('contains a changed connection revision and blocks writes after permission withdrawal', async () => {
  const b = bench()
  vi.mocked(b.remote.prepareServerFolder).mockResolvedValue({ ok: false,
    error: new RemoteError('hemi-ssh/connection-changed', 'changed', { serverId: server.id }) })
  expect(await b.controller.open(b.selected.selection, '/project')).toEqual({ kind: 'failed', problem: 'runtimeChanged' })
  b.allowed.mockReturnValue(false)
  expect(await b.controller.open(b.selected.selection, '/project')).toEqual({ kind: 'failed', problem: 'folderUnavailable' })
  expect(b.remote.prepareServerFolder).toHaveBeenCalledTimes(1)
})

it('reports a failed remote Node provisioning separately from an unusable remote platform', async () => {
  const b = bench()
  vi.mocked(b.remote.prepareServerFolder).mockResolvedValue({ ok: false,
    error: new RemoteError('hemi-ssh/runtime-provision-failed', 'private download detail', { host: server.host, detail: 'checksum' }) })
  expect(await b.controller.open(b.selected.selection, '/project')).toEqual({ kind: 'failed', problem: 'runtimeProvisionFailed' })
  vi.mocked(b.remote.prepareServerFolder).mockResolvedValue({ ok: false,
    error: new RemoteError('hemi-ssh/remote-runtime-missing', 'private platform detail', { host: server.host, detail: 'musl' }) })
  expect(await b.controller.open(b.selected.selection, '/project')).toEqual({ kind: 'failed', problem: 'runtimeMissing' })
  expect(b.picked).not.toHaveBeenCalled()
})

it('reports a failed password save after sign-in without admitting a Workspace', async () => {
  const b = bench()
  vi.mocked(b.remote.prepareServerFolder).mockResolvedValueOnce({ ok: false,
    error: new RemoteError('hemi-ssh/remember-failed', 'private credential detail', { host: server.host, reason: 'credentials-write' }) })
  expect(await b.controller.open(b.selected.selection, '/project')).toEqual({ kind: 'failed', problem: 'passwordRememberFailed' })
  expect(b.create).not.toHaveBeenCalled()
  expect(b.picked).not.toHaveBeenCalled()
})

it('reports uncertainty when reconnect withdraws an already dispatched Workspace admission', async () => {
  const b = bench()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  b.create.mockImplementation(async (request) => {
    entered.resolve(undefined); await release.promise
    return { workspaceId: brandString<WorkspaceId>('committed-during-reset'), path: request.path,
      title: 'project', sessionIds: [], createdAt: '', updatedAt: '' }
  })
  const opening = b.controller.open(b.selected.selection, '/project')
  await entered.promise
  try {
    b.controller.reset()
    expect(b.interrupted).toHaveBeenCalledExactlyOnceWith(true)
  } finally { release.resolve(undefined); await opening }
  expect(b.picked).not.toHaveBeenCalled()
})

it('withdraws captured navigation on a transport reset', () => {
  const b = bench()
  b.controller.reset()
  expect(b.interrupted).toHaveBeenCalledOnce()
  expect(b.picked).not.toHaveBeenCalled()
})
