/** Credential-provider teardown retains admitted SSH reads and writes until their explicit completion. */
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import HemiSshServers from '../src/index.ts'

const endpoint = { host: 'fixture.example', port: 22, username: 'operator', identityFile: '' }

it.each(['lookup', 'persist', 'discard'] as const)('joins an admitted %s before releasing its credential provider', async (action) => {
  const root = await mkdtemp(join(tmpdir(), 'hemi-ssh-credential-lifetime-'))
  const ctx = new Context()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(async () => {
    release.resolve(undefined)
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root)
  ctx.effect(() => () => backend.close())
  ctx.effect(() => ctx.storage.backend.register('json', backend))
  ctx.provide(storageBackendServiceKey('json'), backend)
  await ctx.plugin(StorageDomain, { backend: 'json' })
  const provider = ctx.plugin(LocalCredentialProvider, { path: join(root, '.credentials.yaml'), watch: false })
  await provider
  await ctx.plugin(HemiSshServers)
  await ctx.hemiSshServers.create({ ...endpoint, name: 'Fixture' }, new AbortController().signal)
  await ctx.hemiSshServers.rememberPassword(endpoint, endpoint.username, 'fixture-original-secret')
  const memory = ctx.hemiSshServers.authenticationPasswords()
  const credentials = ctx.credentials
  const entered = Promise.withResolvers<undefined>()
  if (action === 'lookup') {
    const read = credentials.readRecord.bind(credentials)
    vi.spyOn(credentials, 'readRecord').mockImplementation(async (key) => {
      entered.resolve(undefined)
      await release.promise
      return read(key)
    })
  } else {
    const modify = credentials.modifyRecord.bind(credentials)
    vi.spyOn(credentials, 'modifyRecord').mockImplementation(async (key, mutate) => {
      entered.resolve(undefined)
      await release.promise
      return modify(key, mutate)
    })
  }
  const admitted = action === 'lookup' ? memory.lookup(endpoint)
    : action === 'persist' ? memory.persist(endpoint, endpoint.username, 'fixture-replacement-secret')
      : memory.discard(endpoint, 'fixture-original-secret')
  await entered.promise
  let disposed = false
  const disposal = provider.dispose().then(() => { disposed = true })
  await vi.waitFor(() => { expect(memory.canPersist(endpoint)).toBe(false) })
  expect(disposed).toBe(false)
  release.resolve(undefined)
  const result = await admitted
  if (action === 'lookup') expect(result).toEqual({ nativeUser: endpoint.username, password: 'fixture-original-secret' })
  await disposal
  expect(ctx.get('credentials')).toBeUndefined()
  expect(memory.canPersist(endpoint)).toBe(false)
})
