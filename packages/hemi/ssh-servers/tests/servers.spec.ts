/** Saved server behavior over real JSON storage; no test contacts an SSH server. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import HemiSshServers, { type SshServerInput } from '../src/index.ts'

const signal = new AbortController().signal
const input: SshServerInput = { name: 'Development', host: 'dev.example.com', port: 22, username: 'deploy', identityFile: '' }

async function setup(failWrite = false) {
  const root = await mkdtemp(join(tmpdir(), 'hemi-ssh-servers-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root)
  ctx.effect(() => () => backend.close())
  ctx.effect(() => ctx.storage.backend.register('json', backend))
  ctx.provide(storageBackendServiceKey('json'), backend)
  if (failWrite) {
    const open = backend.kv.open.bind(backend.kv)
    vi.spyOn(backend.kv, 'open').mockImplementationOnce(async (descriptor) => {
      const unit = await open(descriptor)
      vi.spyOn(unit, 'setGlobal').mockRejectedValueOnce(new Error('disk full'))
      return unit
    })
  }
  await ctx.plugin(StorageDomain, { backend: 'json' })
  const fiber = ctx.plugin(HemiSshServers)
  await fiber
  return { ctx, service: ctx.hemiSshServers, root, fiber }
}

describe('saved SSH servers', () => {
  it('withdraws cancelled requests before a queued write starts', async () => {
    const { service } = await setup()
    const cancelled = AbortSignal.abort(new Error('cancelled'))
    expect(() => service.list(cancelled)).toThrow('cancelled')
    expect(() => service.create(input, cancelled)).toThrow('cancelled')
    const caller = new AbortController()
    const pending = service.create(input, caller.signal)
    caller.abort(new Error('cancelled while queued'))
    await expect(pending).rejects.toThrow('cancelled while queued')
    expect(service.list(signal)).toEqual([])
  })

  it('creates, revises and removes only server references', async () => {
    const { service } = await setup()
    expect(service.list(signal)).toEqual([])
    const first = await service.create(input, signal)
    expect(first).toMatchObject(input)
    expect(first.id).not.toBe(first.revision)
    expect(service.list(signal)).toEqual([first])
    const edited = await service.update(first.id, first.revision, { ...input, name: 'Production', port: 2222 }, signal)
    expect(edited.id).toBe(first.id)
    expect(edited.revision).not.toBe(first.revision)
    expect(service.list(signal)).toEqual([edited])
    await expect(service.update(first.id, first.revision, input, signal)).rejects.toMatchObject({ code: 'hemi-ssh/conflict' })
    await expect(service.removeServer(first.id, first.revision, signal)).rejects.toMatchObject({ code: 'hemi-ssh/conflict' })
    await service.removeServer(edited.id, edited.revision, signal)
    expect(service.list(signal)).toEqual([])
    await expect(service.removeServer(edited.id, edited.revision, signal)).rejects.toMatchObject({ code: 'hemi-ssh/not-found' })
  })

  it('reloads server order after the owning plugin is replaced', async () => {
    const { ctx, service, fiber, root } = await setup()
    const servers = await Promise.all([
      service.create(input, signal), service.create({ ...input, name: 'Other', host: 'other-alias', username: '' }, signal),
    ])
    await fiber.dispose()
    expect(ctx.get('hemiSshServers')).toBeUndefined()
    await expect(service.create(input, signal)).rejects.toThrow('unavailable')
    expect(() => service.list(signal)).toThrow('unavailable')
    await ctx.plugin(HemiSshServers)
    expect(ctx.hemiSshServers.list(signal)).toEqual(servers)
    const document: unknown = JSON.parse(await readFile(join(root, 'hemi_ssh_servers.json'), 'utf8'))
    expect(JSON.stringify(document)).toContain('other-alias')
    expect(JSON.stringify(document)).not.toContain('password')
  })

  it.each([
    { name: '' }, { host: '-oProxyCommand=bad' }, { host: 'server;command' }, { host: 'user@host' }, { host: 'host:2222' }, { host: '[not-ipv6]' },
    { host: 'host\nother' }, { port: 0 }, { port: 65536 }, { port: 1.5 },
    { username: '-option' }, { identityFile: 'path\0key' }, { identityFile: 'a-password-not-a-path' },
    { identityFile: '-----BEGIN OPENSSH PRIVATE KEY-----' }, { directory: 'relative' }, { directory: '/path\0bad' },
  ])('refuses invalid fields without publishing a record: %j', async (invalid) => {
    const { service } = await setup()
    expect(() => service.create({ ...input, ...invalid }, signal)).toThrow()
    expect(service.list(signal)).toEqual([])
  })

  it.each(['prod-alias', '192.0.2.1', '::1', '2001:db8::1', '[2001:db8::2]'])('keeps explicit host references: %s', async (host) => {
    const { service } = await setup()
    const row = await service.create({ ...input, host, username: '', identityFile: '~/.ssh/deploy key' }, signal)
    expect(row).toMatchObject({ host, username: '', identityFile: '~/.ssh/deploy key' })
  })

  it('does not retain a failed write and still accepts the next mutation', async () => {
    const { service } = await setup(true)
    await expect(service.create(input, signal)).rejects.toThrow('disk full')
    expect(service.list(signal)).toEqual([])
    const row = await service.create(input, signal)
    expect(service.list(signal)).toEqual([row])
  })

  it('serializes overlapping edits and refuses a stale second writer', async () => {
    const { service } = await setup()
    const row = await service.create(input, signal)
    const results = await Promise.allSettled([
      service.update(row.id, row.revision, { ...input, name: 'First' }, signal),
      service.update(row.id, row.revision, { ...input, name: 'Second' }, signal),
    ])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(service.list(signal)[0]?.name).toBe('First')
  })
  it('preserves an optional remote directory through edits and reload without changing legacy records', async () => {
    const { service, ctx, fiber } = await setup()
    const legacy = await service.create(input, signal)
    expect(legacy.directory).toBeUndefined()
    const saved = await service.update(legacy.id, legacy.revision, { ...input, directory: '/srv/project one' }, signal)
    await fiber.dispose()
    await ctx.plugin(HemiSshServers)
    expect(ctx.hemiSshServers.list(signal)).toEqual([saved])
    expect(saved.directory).toBe('/srv/project one')
  })

})
