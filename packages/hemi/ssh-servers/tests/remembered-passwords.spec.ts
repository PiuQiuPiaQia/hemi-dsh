/** Remembered-password key binding, payload admission, prompt classification, failure mapping, and saved-directory cleanup. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { CREDENTIALS_FILENAME, LocalCredentialProvider, parseCredentialsDocument } from '@deepseek-ai/dsh-credentials-local'
import HemiSshServers from '../src/index.ts'
import type {} from '../src/types.ts'
import {
  canonicalSshEndpoint, nativePasswordPromptUser, parseSshPasswordRecord, rememberFailureReasonOf,
  sameSshEndpoint, sshPasswordCredentialKey, sshPasswordGrantRecord, type SshPasswordEndpoint,
} from '../src/remembered-passwords.ts'

const endpoint: SshPasswordEndpoint = { host: 'dev.example.com', port: 22, username: 'deploy', identityFile: '' }
const prompt = (user: string, host = endpoint.host): string => `${user}@${host}'s password: `

describe('remembered password keys', () => {
  it('binds one key to the exact endpoint fields and nothing else', () => {
    expect(String(sshPasswordCredentialKey(endpoint))).toMatch(/^hemi-ssh-servers\/endpoint-[a-f0-9]{64}$/)
    expect(sshPasswordCredentialKey(endpoint)).toBe(sshPasswordCredentialKey({ ...endpoint }))
    for (const changed of [
      { host: 'other.example.com' }, { username: 'root' }, { port: 2222 }, { identityFile: '/id_ed25519' },
    ] as const) {
      expect(sshPasswordCredentialKey({ ...endpoint, ...changed }))
        .not.toBe(sshPasswordCredentialKey(endpoint))
    }
  })

  it('compares saved servers by endpoint fields only', () => {
    const server = { ...endpoint, id: 'irrelevant', revision: 'irrelevant', name: 'Development', directory: '/srv' }
    const renamed = { ...server, name: 'Renamed', directory: '/other' }
    const movedPort = { ...server, port: 2222 }
    expect(sameSshEndpoint(server, endpoint)).toBe(true)
    expect(sameSshEndpoint(renamed, endpoint)).toBe(true)
    expect(sameSshEndpoint(movedPort, endpoint)).toBe(false)
    expect(canonicalSshEndpoint(endpoint)).toBe(canonicalSshEndpoint({ identityFile: '', username: 'deploy', port: 22, host: 'dev.example.com' }))
  })
})

describe('remembered password records', () => {
  it('round-trips one grant payload', () => {
    const parsed = parseSshPasswordRecord(sshPasswordGrantRecord(endpoint, 'deploy', 'hunter2'))
    expect(parsed).toEqual({ endpoint, nativeUser: 'deploy', password: 'hunter2' })
  })

  it('admits only this layout, field for field', () => {
    const { payload } = sshPasswordGrantRecord(endpoint, 'deploy', 'hunter2')
    expect(parseSshPasswordRecord(undefined)).toBeUndefined()
    expect(parseSshPasswordRecord('grant')).toBeUndefined()
    expect(parseSshPasswordRecord({ kind: 'api-key', key: 'x' })).toBeUndefined()
    expect(parseSshPasswordRecord({ kind: 'grant' })).toBeUndefined()
    expect(parseSshPasswordRecord({ kind: 'grant', payload: { ...payload, type: 'other' } })).toBeUndefined()
    expect(parseSshPasswordRecord({ kind: 'grant', payload: { ...payload, extra: true } })).toBeUndefined()
    expect(parseSshPasswordRecord({ kind: 'grant', payload: { ...payload, password: undefined } })).toBeUndefined()
    expect(parseSshPasswordRecord({ kind: 'grant', payload: { ...payload, password: '' } })).toBeUndefined()
    expect(parseSshPasswordRecord({ kind: 'grant', payload: { ...payload, nativeUser: '' } })).toBeUndefined()
    expect(parseSshPasswordRecord({ kind: 'grant', payload: { ...payload, port: '22' } })).toBeUndefined()
    expect(parseSshPasswordRecord({ kind: 'grant', payload: { ...payload, port: 0 } })).toBeUndefined()
  })
})

describe('native password prompt classification', () => {
  it('accepts only the target host password prompt and reports its native login', () => {
    expect(nativePasswordPromptUser(prompt('deploy'), endpoint)).toBe('deploy')
    expect(nativePasswordPromptUser(prompt('deploy').slice(0, -1), endpoint)).toBe('deploy')
  })

  it('rejects other accounts, other hosts, and every non-password prompt', () => {
    expect(nativePasswordPromptUser(prompt('root'), endpoint)).toBeUndefined()
    expect(nativePasswordPromptUser(prompt('deploy', 'jump.example.com'), endpoint)).toBeUndefined()
    expect(nativePasswordPromptUser('deploy@dev.example.com: ', endpoint)).toBeUndefined()
    expect(nativePasswordPromptUser('Password: ', endpoint)).toBeUndefined()
    expect(nativePasswordPromptUser('Verification code: ', endpoint)).toBeUndefined()
    expect(nativePasswordPromptUser("Enter passphrase for key '/id_ed25519': ", endpoint)).toBeUndefined()
    expect(nativePasswordPromptUser('', endpoint)).toBeUndefined()
  })

  it('accepts any native login while the endpoint defers the login to OpenSSH configuration', () => {
    const deferred = { ...endpoint, username: '' }
    expect(nativePasswordPromptUser(prompt('anyone'), deferred)).toBe('anyone')
    expect(nativePasswordPromptUser('a@b@dev.example.com\'s password: ', deferred)).toBe('a@b')
    expect(nativePasswordPromptUser(prompt('someone-else', 'other.example.com'), deferred)).toBeUndefined()
  })
})

describe('remember failure mapping', () => {
  it('carries structured reasons and never free text', () => {
    for (const reason of ['credentials-unavailable', 'no-saved-endpoint'] as const) {
      expect(rememberFailureReasonOf(new RemoteError('hemi-ssh/remember-failed', 'display only', { host: 'h', reason })))
        .toBe(reason)
      const carried = new Error('carrier') as Error & { code: string; reason: string }
      carried.code = 'remember-failed'
      carried.reason = reason
      expect(rememberFailureReasonOf(carried)).toBe(reason)
    }
    expect(rememberFailureReasonOf(new RemoteError('hemi-ssh/invalid-input', 'display only', { field: 'host' })))
      .toBe('credentials-write')
    expect(rememberFailureReasonOf(new Error('EACCES: /credentials.yaml'))).toBe('credentials-write')
    expect(rememberFailureReasonOf('not an error')).toBe('credentials-write')
  })
})

const signal = new AbortController().signal
const input = { name: 'Development', host: 'dev.example.com', port: 22, username: 'deploy', identityFile: '' }

/** Boot the saved-server directory over real JSON storage and the real file-backed credential provider. */
async function directory(): Promise<{
  service: HemiSshServers
  stored: () => Promise<Map<string, CredentialRecord>>
}> {
  const root = await mkdtemp(join(tmpdir(), 'hemi-ssh-remember-'))
  const credentialsPath = join(root, 'home', CREDENTIALS_FILENAME)
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root)
  ctx.effect(() => () => backend.close())
  ctx.effect(() => ctx.storage.backend.register('json', backend))
  ctx.provide(storageBackendServiceKey('json'), backend)
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(LocalCredentialProvider, { path: credentialsPath, watch: false })
  await ctx.plugin(HemiSshServers)
  const service = ctx.hemiSshServers
  const stored = async (): Promise<Map<string, CredentialRecord>> => {
    try {
      return parseCredentialsDocument(await readFile(credentialsPath, 'utf8'), credentialsPath).records
    } catch (error: unknown) {
      // No write has happened yet, so no credentials document exists.
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return new Map()
      throw error
    }
  }
  return { service, stored: () => stored() }
}

describe('remembered passwords in the saved directory', () => {
  it('stores one grant after a saved server owns the endpoint', async () => {
    const { service, stored } = await directory()
    const server = await service.create(input, signal)
    await service.rememberPassword(endpoint, 'deploy', 'hunter2')
    expect((await stored()).get(String(sshPasswordCredentialKey(endpoint)))).toEqual({
      kind: 'grant',
      payload: { type: 'hemi-ssh-password', host: endpoint.host, username: endpoint.username, port: endpoint.port,
        identityFile: endpoint.identityFile, nativeUser: 'deploy', password: 'hunter2' },
    })
    expect(service.list(signal)).toEqual([server])
  })

  it('refuses to store when no saved server owns the endpoint', async () => {
    const { service, stored } = await directory()
    await expect(service.rememberPassword(endpoint, 'deploy', 'hunter2'))
      .rejects.toMatchObject({ code: 'hemi-ssh/remember-failed', details: { reason: 'no-saved-endpoint' } })
    expect(await stored()).toEqual(new Map())
  })

  it('keeps the stored password through a rename and removes it through an endpoint change', async () => {
    const { service, stored } = await directory()
    const server = await service.create(input, signal)
    await service.rememberPassword(endpoint, 'deploy', 'hunter2')
    const renamed = await service.update(server.id, server.revision, { ...input, name: 'Production' }, signal)
    expect((await stored()).has(String(sshPasswordCredentialKey(endpoint)))).toBe(true)
    const moved = await service.update(renamed.id, renamed.revision, { ...input, host: 'next.example.com' }, signal)
    expect((await stored()).has(String(sshPasswordCredentialKey(endpoint)))).toBe(false)
    expect(service.list(signal)).toEqual([moved])
  })

  it('removes the stored password with the server, but only when no other server shares the endpoint', async () => {
    const { service, stored } = await directory()
    const first = await service.create(input, signal)
    const second = await service.create({ ...input, name: 'Same endpoint' }, signal)
    await service.rememberPassword(endpoint, 'deploy', 'hunter2')
    await service.removeServer(first.id, first.revision, signal)
    expect((await stored()).has(String(sshPasswordCredentialKey(endpoint)))).toBe(true)
    await service.removeServer(second.id, second.revision, signal)
    expect((await stored()).has(String(sshPasswordCredentialKey(endpoint)))).toBe(false)
  })

  it('never leaves a rewritten orphan when a pending candidate races the server removal', async () => {
    const { service, stored } = await directory()
    const server = await service.create(input, signal)

    // The candidate commits first; the queued removal still deletes its record.
    const candidate = service.rememberPassword(endpoint, 'deploy', 'hunter2')
    await service.removeServer(server.id, server.revision, signal)
    await expect(candidate).resolves.toBeUndefined()
    expect((await stored()).has(String(sshPasswordCredentialKey(endpoint)))).toBe(false)

    // The removal commits first; the queued candidate can no longer write an orphan.
    const again = await service.create(input, signal)
    await service.removeServer(again.id, again.revision, signal)
    await expect(service.rememberPassword(endpoint, 'deploy', 'hunter2'))
      .rejects.toMatchObject({ code: 'hemi-ssh/remember-failed', details: { reason: 'no-saved-endpoint' } })
    expect(await stored()).toEqual(new Map())
  })

  it('sweeps orphaned records left by an earlier failed cleanup at the next start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hemi-ssh-remember-'))
    const credentialsPath = join(root, 'home', CREDENTIALS_FILENAME)
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
    await ctx.plugin(Storage)
    const backend = new JsonStorageBackend(root)
    ctx.effect(() => () => backend.close())
    ctx.effect(() => ctx.storage.backend.register('json', backend))
    ctx.provide(storageBackendServiceKey('json'), backend)
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(LocalCredentialProvider, { path: credentialsPath, watch: false })
    const provider = ctx.get('credentials')
    if (provider === undefined) throw new Error('credentials provider missing from test composition')
    const servers = await ctx.plugin(HemiSshServers)
    const service = ctx.hemiSshServers
    const owned = { ...input, host: 'owned.example.com' }
    await service.create(owned, signal)
    await service.rememberPassword(owned, 'deploy', 'kept')
    // A record whose cleanup never ran, as after a crash between the two durable writes.
    await provider.modifyRecord(sshPasswordCredentialKey(endpoint), () =>
      Promise.resolve(sshPasswordGrantRecord(endpoint, 'deploy', 'orphan')))
    const kept = String(sshPasswordCredentialKey(owned))
    const orphan = String(sshPasswordCredentialKey(endpoint))
    await servers.dispose()
    expect(ctx.get('hemiSshServers')).toBeUndefined()
    await ctx.plugin(HemiSshServers)
    const swept = parseCredentialsDocument(await readFile(credentialsPath, 'utf8'), credentialsPath).records
    expect(swept.has(orphan)).toBe(false)
    expect(parseSshPasswordRecord(swept.get(kept))?.password).toBe('kept')
  })
})
