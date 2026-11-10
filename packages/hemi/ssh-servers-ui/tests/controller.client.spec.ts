import { expect, it, onTestFinished, vi } from 'vitest'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SshServer, SshServerId, SshServerInput } from '@deepseek-ai/dsh-hemi-ssh-servers/types'
import type {} from '@deepseek-ai/dsh-hemi-ssh-servers/remote'
import { ServerController, type ServerRemote } from '../src/client/controller.ts'
import { endpointLabel, invalidFields, serverDraft, serverInput } from '../src/client/draft.ts'

const server: SshServer = {
  id: 'server-1' as SshServerId, revision: 'r1', name: 'Production', host: 'prod', port: 22, username: '', identityFile: '',
}
const address = 'dsh-resource://hemi-ssh-servers/list'

function bench() {
  const list = vi.fn<ServerRemote['list']>(async () => ({ ok: true, value: [server] }))
  const create = vi.fn<ServerRemote['create']>(async () => ({ ok: true, value: server }))
  const update = vi.fn<ServerRemote['update']>(async () => ({ ok: true, value: { ...server, revision: 'r2' } }))
  const removeServer = vi.fn<ServerRemote['removeServer']>(async () => ({ ok: true, value: undefined }))
  const allowed = vi.fn(() => true)
  const controller = new ServerController({ list, create, update, removeServer }, allowed)
  const signal = new AbortController()
  const iterator = controller.provider().open(address, { signal: signal.signal })[Symbol.asyncIterator]()
  onTestFinished(async () => { signal.abort(); await controller.dispose(); await iterator.return?.() })
  return { controller, list, create, update, removeServer, allowed, iterator, signal }
}

it('reads only through the resource stream and refreshes after a durable create', async () => {
  const b = bench()
  expect(b.list).not.toHaveBeenCalled()
  expect((await b.iterator.next()).value).toEqual({ ok: true, value: [server] })
  b.list.mockResolvedValueOnce({ ok: true, value: [server, { ...server, id: 'server-2' as SshServerId }] })
  const saved = await b.controller.save(null, serverInput(serverDraft(server)))
  expect(saved).toEqual({ kind: 'complete', notice: 'saved' })
  expect(b.create).toHaveBeenCalledWith(serverInput(serverDraft(server)), expect.any(AbortSignal))
  expect((await b.iterator.next()).value).toMatchObject({ ok: true, value: [server, { id: 'server-2' }] })
  expect(b.list).toHaveBeenCalledTimes(2)
})

it('sends captured revisions and reports a failed refresh separately from a successful write', async () => {
  const b = bench()
  await b.iterator.next()
  b.list.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'private storage path', {}) })
  expect(await b.controller.save(server, server)).toEqual({ kind: 'complete', notice: 'savedRefreshFailed' })
  expect(b.update).toHaveBeenCalledWith(server.id, 'r1', server, expect.any(AbortSignal))
  expect((await b.iterator.next()).value).toMatchObject({ ok: false })
  expect(await b.controller.remove(server)).toEqual({ kind: 'complete', notice: 'removed' })
  expect(b.removeServer).toHaveBeenCalledWith(server.id, 'r1', expect.any(AbortSignal))
})

it.each([
  [new RemoteError('hemi-ssh/conflict', '/private/secret storage error', { id: server.id }), 'conflict', null],
  [new RemoteError('hemi-ssh/not-found', '/private/secret storage error', { id: server.id }), 'notFound', null],
  [new RemoteError('hemi-ssh/invalid-input', '/private/secret storage error', { field: 'host' }), 'invalid', 'address'],
  [new RemoteError('hemi-ssh/invalid-input', '/private/secret storage error', { field: 'username' }), 'invalid', 'address'],
  [new RemoteError('hemi-ssh/invalid-input', '/private/secret storage error', { field: 'port' }), 'invalid', 'port'],
  [new RemoteError('gateway/internal', '/private/secret storage error', {}), 'failed', null],
] as const)('classifies %s without forwarding internal diagnostics', async (failure, problem, field) => {
  const b = bench()
  b.create.mockResolvedValueOnce({ ok: false, error: failure })
  expect(await b.controller.save(null, server)).toEqual({ kind: 'failed', problem, field })
  expect(b.list).not.toHaveBeenCalled()
})

it.each(['update', 'remove'] as const)('refreshes a durable %s while reporting incomplete password cleanup', async (action) => {
  const b = bench()
  await b.iterator.next()
  const error = new RemoteError('hemi-ssh/credential-cleanup-failed', '/private/credential secret', { id: server.id })
  b.update.mockResolvedValueOnce({ ok: false, error })
  b.removeServer.mockResolvedValueOnce({ ok: false, error })
  const records = action === 'remove' ? [] : [{ ...server, revision: 'r2' }]
  b.list.mockResolvedValueOnce({ ok: true, value: records })
  const result = await (action === 'remove' ? b.controller.remove(server) : b.controller.save(server, server))
  expect(result).toEqual({ kind: 'failed', problem: 'credentialCleanupFailed', field: null })
  expect((await b.iterator.next()).value).toEqual({ ok: true, value: records })
  expect(b.list).toHaveBeenCalledTimes(2)
  expect(JSON.stringify(result)).not.toContain('/private/credential')
})

it('keeps password cleanup failure visible even when the committed change cannot be refreshed', async () => {
  const b = bench()
  await b.iterator.next()
  b.removeServer.mockResolvedValueOnce({ ok: false,
    error: new RemoteError('hemi-ssh/credential-cleanup-failed', 'private credential detail', { id: server.id }) })
  b.list.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'private refresh detail', {}) })
  expect(await b.controller.remove(server)).toEqual({ kind: 'failed', problem: 'credentialCleanupFailed', field: null })
  expect((await b.iterator.next()).value).toMatchObject({ ok: false })
})

it('does not dispatch after write access is withdrawn or a write is already pending', async () => {
  const b = bench()
  b.allowed.mockReturnValueOnce(false)
  expect(await b.controller.save(null, server)).toEqual({ kind: 'failed', problem: 'failed', field: null })
  expect(b.create).not.toHaveBeenCalled()
  const pending = Promise.withResolvers<RemoteResult<SshServer>>()
  b.create.mockReturnValueOnce(pending.promise)
  const first = b.controller.save(null, server)
  expect(await b.controller.remove(server)).toEqual({ kind: 'withdrawn' })
  expect(b.removeServer).not.toHaveBeenCalled()
  pending.resolve({ ok: true, value: server })
  expect(await first).toEqual({ kind: 'complete', notice: 'saved' })
})

it('aborts and settles an in-flight write without publishing a late success or refresh', async () => {
  const b = bench()
  const pending = Promise.withResolvers<RemoteResult<SshServer>>()
  let signal: AbortSignal | undefined
  b.create.mockImplementationOnce((_input: SshServerInput, abort?: AbortSignal) => { signal = abort; return pending.promise })
  const saved = b.controller.save(null, server)
  const closed = b.controller.dispose()
  expect(signal?.aborted).toBe(true)
  pending.resolve({ ok: true, value: server })
  await closed
  expect(await saved).toEqual({ kind: 'withdrawn' })
  expect(b.list).not.toHaveBeenCalled()
  expect(await b.controller.save(null, server)).toEqual({ kind: 'withdrawn' })
})

it('ignores a previous connection generation and rereads before publishing the resource', async () => {
  const b = bench()
  const old = Promise.withResolvers<RemoteResult<readonly SshServer[]>>()
  b.list.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ ok: true, value: [{ ...server, name: 'New host' }] })
  const first = b.iterator.next()
  await vi.waitFor(() => { expect(b.list).toHaveBeenCalledOnce() })
  b.controller.reset()
  old.resolve({ ok: true, value: [{ ...server, name: 'Old host' }] })
  expect((await first).value).toMatchObject({ ok: true, value: [{ name: 'New host' }] })
  expect(b.list).toHaveBeenCalledTimes(2)
})

it('stops resource work when its last holder leaves', async () => {
  const b = bench()
  b.list.mockImplementationOnce((signal?: AbortSignal) => new Promise((resolve) => {
    signal!.addEventListener('abort', () => { resolve({ ok: false, error: new RemoteError('gateway/internal', 'aborted', {}) }) }, { once: true })
  }))
  const first = b.iterator.next()
  await vi.waitFor(() => { expect(b.list).toHaveBeenCalledOnce() })
  b.signal.abort()
  expect((await first).done).toBe(true)
  expect(await b.controller.refresh()).toBe(true)
  expect(b.list).toHaveBeenCalledOnce()
})

it.each([
  ['root@192.168.1.10', 'root', '192.168.1.10'],
  ['deploy@server.example.com', 'deploy', 'server.example.com'],
  ['alice@prod', 'alice', 'prod'],
  ['prod', '', 'prod'],
  ['192.168.1.10', '', '192.168.1.10'],
  ['alice@[2001:db8::1]', 'alice', '[2001:db8::1]'],
  ['alice@2001:db8::1', 'alice', '2001:db8::1'],
  ['[::1]', '', '[::1]'],
  ['alice@realm@prod', 'alice@realm', 'prod'],
  ['@realm@prod', '@realm', 'prod'],
  ['  alice@prod  ', 'alice', 'prod'],
] as const)('parses the combined address %s without changing the Host fields', (address, username, host) => {
  const draft = { ...serverDraft(server), address }
  expect(invalidFields(draft)).toEqual([])
  expect(serverInput(draft)).toEqual({ name: server.name, username, host, port: 22, identityFile: '' })
})

it.each([
  '', '@prod', 'alice@', 'ssh alice@prod', 'ssh://alice@prod', 'alice@prod:2222',
  'alice@[::1]:2222', 'alice@[::1', 'alice@::1]', '-alice@prod', 'alice smith@prod',
  'alice@bad host', 'alice@prod;whoami', 'alice@prod/path', 'alice@prod?port=22',
  `${'a'.repeat(129)}@prod`, `alice@${'a'.repeat(254)}`,
])('keeps a malformed or command-style address out of submission: %s', (address) => {
  expect(invalidFields({ ...serverDraft(server), address })).toContain('address')
})

it.each([
  { ...server, host: '192.168.1.10', username: 'root' },
  { ...server, host: 'prod', username: '' },
  { ...server, host: '2001:db8::1', username: 'alice' },
  { ...server, host: '[2001:db8::1]', username: 'alice' },
  { ...server, host: 'prod', username: 'alice@realm' },
])('reopens saved server fields without losing the original host or login: $username@$host', (saved) => {
  const { id: _id, revision: _revision, ...input } = saved
  expect(invalidFields(serverDraft(saved))).toEqual([])
  expect(serverInput(serverDraft(saved))).toEqual(input)
})

it('parses only explicit fields and formats aliases and IPv6 without an invented user', () => {
  expect(serverDraft()).toEqual({ name: '', address: '', port: '22', identityFile: '', directory: '' })
  expect(endpointLabel(server)).toBe('prod:22')
  expect(endpointLabel({ ...server, host: '::1', username: 'alice', port: 2200 })).toBe('alice@[::1]:2200')
  expect(endpointLabel({ ...server, host: '[::1]' })).toBe('[::1]:22')
  expect(serverInput({ ...serverDraft(server), name: '  New name  ' }).name).toBe('New name')
  expect(invalidFields(serverDraft())).toEqual(['name', 'address'])
  expect(invalidFields({ ...serverDraft(server), address: '::1' })).toEqual([])
  expect(invalidFields({ ...serverDraft(server), address: '-bad@prod:2222', port: '65536', identityFile: 'password' }))
    .toEqual(['address', 'port', 'identityFile'])
  expect(invalidFields({ ...serverDraft(server), identityFile: '-----BEGIN OPENSSH PRIVATE KEY-----' })).toEqual(['identityFile'])
  expect(invalidFields({ ...serverDraft(server), identityFile: 'C:\\Users\\alice\\.ssh\\key' })).toEqual([])
  expect(invalidFields({ ...serverDraft(server), identityFile: '~/.ssh/key' })).toEqual([])
})

it('round-trips a selected remote directory and refuses relative paths', () => {
  const draft = serverDraft({ ...server, directory: '/srv/project one' })
  expect(draft.directory).toBe('/srv/project one')
  expect(serverInput(draft).directory).toBe('/srv/project one')
  expect(invalidFields({ ...draft, directory: 'project' })).toContain('directory')
  expect(serverInput({ ...draft, directory: '' }).directory).toBeUndefined()
})
