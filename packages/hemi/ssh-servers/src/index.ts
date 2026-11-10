/** Host-owned SSH server directory. Remote calls manage references, never SSH connections. */
import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { serverInputSchema, sshServersSpec } from './spec.ts'
import {
  parseSshPasswordRecord, sameSshEndpoint, sshPasswordCredentialKey, sshPasswordGrantRecord,
  SSH_PASSWORD_CREDENTIAL_SCOPE, type SshAuthenticationPasswordMemory, type SshCredentialRecords, type SshPasswordEndpoint,
} from './remembered-passwords.ts'
import type { SshServer, SshServerId, SshServerInput } from './types.ts'

export type { SshServer, SshServerId, SshServerInput } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Saved SSH references, independent of the local Workspace registry. */
    hemiSshServers: HemiSshServers
  }
}

/** Durable CRUD under the Gateway's global-resource access policy. */
export default class HemiSshServers extends TypertRemoteService {
  static inject = ['storageDomain']
  private records: SshCredentialRecords | undefined
  private domain: Domain<typeof sshServersSpec> | undefined
  private writes: Promise<void> = Promise.resolve()
  private closed = false

  /** @param ctx - Host context supplying validated domain storage and Remote registration. */
  constructor(ctx: Context) {
    super(ctx, 'hemiSshServers', { namespace: 'hemiSshServers' })
    ctx.effect(() => async () => {
      this.closed = true
      await this.writes
      await this.domain?.close()
    }, 'hemi-ssh-servers: pending writes and domain')
    ctx.inject(['credentials'], async (owner) => {
      this.records = owner.credentials
      owner.effect(() => async () => {
        this.records = undefined
        await this.writes
      }, 'hemi-ssh-servers: credential operations before provider release')
      if (!this.closed && this.domain !== undefined) await this.enqueue(() => this.sweepRememberedPasswords())
    })
  }

  /** Open and validate the saved directory before the service becomes available. */
  async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(sshServersSpec)
    if (this.closed) {
      await domain.close()
      throw new Error('SSH server directory closed during initialization')
    }
    this.domain = domain
    // Heal records a failed cleanup or a crash between the two durable writes left behind.
    await this.enqueue(() => this.sweepRememberedPasswords())
  }

  /**
   * Read the saved directory without contacting its hosts.
   * @param signal - Caller cancellation before the synchronous read.
   * @returns Saved server references in creation order.
   */
  @Remote
  list(signal: AbortSignal): readonly SshServer[] {
    signal.throwIfAborted()
    return this.directory().global.get().servers
  }

  /**
   * Save a new server reference without modifying OpenSSH configuration.
   * @param input - Explicit server fields; no secrets or connection options.
   * @param signal - Cancellation before writing begins; an admitted durable write is not rolled back.
   * @returns The durable record and its initial revision.
   */
  @Remote
  create(input: SshServerInput, signal: AbortSignal): Promise<SshServer> {
    signal.throwIfAborted()
    const fields = this.validate(input)
    return this.enqueue(async () => {
      signal.throwIfAborted()
      const server: SshServer = { ...fields, id: brandString<SshServerId>(randomUUID()), revision: randomUUID() }
      const domain = this.directory()
      await domain.global.set({ servers: [...domain.global.get().servers, server] })
      return server
    })
  }

  /**
   * Replace a server only while its revision still matches the editor's copy.
   * @param id - Saved server identity.
   * @param revision - Revision loaded with that record.
   * @param input - Replacement fields.
   * @param signal - Cancellation before writing begins; an admitted durable write is not rolled back.
   * @returns The durable record with a new revision.
   * @throws RemoteError `hemi-ssh/credential-cleanup-failed` if the endpoint change is saved but its old password could not be cleared.
   */
  @Remote
  update(id: SshServerId, revision: string, input: SshServerInput, signal: AbortSignal): Promise<SshServer> {
    signal.throwIfAborted()
    const fields = this.validate(input)
    return this.enqueue(async () => {
      signal.throwIfAborted()
      const domain = this.directory()
      const servers = domain.global.get().servers
      const current = this.requireRevision(servers, id, revision)
      const server: SshServer = { ...fields, id, revision: randomUUID() }
      await domain.global.set({ servers: servers.map(row => row.id === id ? server : row) })
      // Only an endpoint change orphans a stored password; renaming a server keeps it.
      await this.forgetEndpointPassword(this.endpointOf(current), id)
      return server
    })
  }

  /**
   * Remove a reference and its password when no saved connection shares that endpoint; SSH configuration and remote files stay untouched.
   * @param id - Saved server identity.
   * @param revision - Revision being removed; a changed record is refused.
   * @param signal - Cancellation before writing begins; an admitted durable write is not rolled back.
   * @returns Resolution after the removal is durable.
   * @throws RemoteError `hemi-ssh/credential-cleanup-failed` if the reference is removed but its password could not be cleared.
   */
  @Remote
  removeServer(id: SshServerId, revision: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    return this.enqueue(async () => {
      signal.throwIfAborted()
      const domain = this.directory()
      const servers = domain.global.get().servers
      const removed = this.requireRevision(servers, id, revision)
      await domain.global.set({ servers: servers.filter(row => row.id !== id) })
      await this.forgetEndpointPassword(this.endpointOf(removed), id)
    })
  }

  /**
   * Supply Host-only password operations to the authentication owner; no secret is part of the Remote API.
   * @returns operations bound to this directory's queue and optional credential provider.
   */
  authenticationPasswords(): SshAuthenticationPasswordMemory {
    return {
      lookup: endpoint => this.enqueue(async () => {
        const records = this.credentials()
        if (records === undefined || !this.endpointSaved(endpoint)) return undefined
        try {
          const saved = parseSshPasswordRecord(await records.readRecord(sshPasswordCredentialKey(endpoint)))
          return saved !== undefined && sameSshEndpoint(saved.endpoint, endpoint)
            ? { nativeUser: saved.nativeUser, password: saved.password } : undefined
        } catch (error: unknown) {
          void error // Store diagnostics may contain a secret; only the affected capability is reported.
          this.ctx.logger.warn('Could not read a remembered SSH password; manual authentication is required')
          return undefined
        }
      }),
      persist: (endpoint, nativeUser, password) => this.rememberPassword(endpoint, nativeUser, password),
      discard: (endpoint, password) => this.forgetPassword(endpoint, password),
      canPersist: endpoint => !this.closed && this.credentials() !== undefined && this.endpointSaved(endpoint),
    }
  }

  /**
   * Commit one password OpenSSH already accepted for an exact saved endpoint, on this service's write queue.
   * Host-side only; the value goes to the credential seam and never crosses to a Client.
   * The queued commit re-checks that a saved server still owns the endpoint, so a parallel removal cannot leave a rewritten orphan.
   * @param endpoint - exact endpoint fields the password authenticated.
   * @param nativeUser - login name the native password prompt printed.
   * @param password - the accepted value; never included in any failure.
   * @returns after the durable grant write.
   * @throws RemoteError `hemi-ssh/remember-failed` when no store is active, the write fails, or no saved server owns the endpoint.
   */
  rememberPassword(endpoint: SshPasswordEndpoint, nativeUser: string, password: string): Promise<void> {
    return this.enqueue(async () => {
      const records = this.credentials()
      if (records === undefined) {
        throw new RemoteError('hemi-ssh/remember-failed', 'No credential store is available for remembered SSH passwords',
          { host: endpoint.host, reason: 'credentials-unavailable' })
      }
      if (!this.endpointSaved(endpoint)) {
        throw new RemoteError('hemi-ssh/remember-failed', 'The connection no longer matches a saved SSH server',
          { host: endpoint.host, reason: 'no-saved-endpoint' })
      }
      try {
        await records.modifyRecord(sshPasswordCredentialKey(endpoint), () =>
          Promise.resolve(sshPasswordGrantRecord(endpoint, nativeUser, password)))
      } catch (error: unknown) {
        void error // Provider failure text can contain the secret being written.
        this.ctx.logger.warn('Could not save the SSH password; the connection will be closed')
        throw new RemoteError('hemi-ssh/remember-failed', 'The remembered SSH password could not be stored',
          { host: endpoint.host, reason: 'credentials-write' })
      }
    })
  }

  /**
   * Drop a remembered password while the record still holds one specific rejected value, on this service's write queue.
   * A concurrently stored replacement value survives.
   * @param endpoint - exact endpoint fields.
   * @param password - the value a later native prompt proved wrong.
   */
  forgetPassword(endpoint: SshPasswordEndpoint, password: string): Promise<void> {
    return this.enqueue(async () => {
      const records = this.credentials()
      if (records === undefined) return
      const key = sshPasswordCredentialKey(endpoint)
      try {
        await records.modifyRecord(key, current => Promise.resolve(
          parseSshPasswordRecord(current)?.password === password
            ? { kind: 'grant', payload: { type: 'hemi-ssh-password-rejected' } } : undefined,
        ))
      } catch (error: unknown) {
        void error // A failed cleanup must not reveal the rejected value through provider diagnostics.
        this.ctx.logger.warn('Could not clear a rejected SSH password; manual authentication is required')
      }
    })
  }

  /** Delete one endpoint's stored password when no saved server owns it; runs inside a queued write. */
  private async forgetEndpointPassword(endpoint: SshPasswordEndpoint, id: SshServerId): Promise<void> {
    const records = this.credentials()
    if (records === undefined || this.endpointSaved(endpoint)) return
    try { await records.deleteRecord(sshPasswordCredentialKey(endpoint)) }
    catch (error: unknown) {
      void error // Provider failure text must not disclose credential contents.
      this.ctx.logger.warn('The SSH connection changed, but its saved password could not be cleared')
      throw new RemoteError('hemi-ssh/credential-cleanup-failed',
        'The saved SSH server changed, but its stored password could not be removed', { id })
    }
  }

  /** Remove stored passwords no saved server owns anymore; unreadable entries are reported and left in place. */
  private async sweepRememberedPasswords(): Promise<void> {
    const records = this.credentials()
    if (records === undefined) return
    let entries: Awaited<ReturnType<SshCredentialRecords['listRecords']>>
    try { entries = await records.listRecords() }
    catch (error: unknown) {
      void error // Only a capability-level warning is safe for credential failures.
      this.ctx.logger.warn('Could not check remembered SSH passwords for removed connections')
      return
    }
    for (const entry of entries) {
      if (!entry.key.startsWith(`${SSH_PASSWORD_CREDENTIAL_SCOPE}/`)) continue
      try {
        const remembered = parseSshPasswordRecord(await records.readRecord(entry.key))
        if (remembered !== undefined && !this.endpointSaved(remembered.endpoint)) {
          await records.deleteRecord(entry.key)
        }
      } catch (error: unknown) {
        void error // A record-read error may quote credential contents.
        this.ctx.logger.warn('A remembered SSH password could not be checked or cleared; cleanup remains incomplete')
      }
    }
  }

  private credentials(): SshCredentialRecords | undefined { return this.records }

  private endpointSaved(endpoint: SshPasswordEndpoint): boolean {
    return this.directory().global.get().servers.some(server => sameSshEndpoint(server, endpoint))
  }

  private endpointOf(server: SshServer): SshPasswordEndpoint {
    return { host: server.host, port: server.port, username: server.username, identityFile: server.identityFile }
  }

  private validate(input: SshServerInput): SshServerInput {
    const parsed = serverInputSchema.safeParse(input)
    if (!parsed.success) {
      const field = String(parsed.error.issues[0]?.path[0] ?? 'server')
      throw new RemoteError('hemi-ssh/invalid-input', 'Check the SSH server fields before saving', { field })
    }
    return parsed.data
  }

  /** Locate one server and confirm the editor's revision; a missing or changed record refuses before any write. */
  private requireRevision(servers: readonly SshServer[], id: SshServerId, revision: string): SshServer {
    const server = servers.find(row => row.id === id)
    if (server === undefined) throw new RemoteError('hemi-ssh/not-found', 'The SSH server was removed; reload the list', { id })
    if (server.revision !== revision) throw new RemoteError('hemi-ssh/conflict', 'The SSH server changed; reload before saving', { id })
    return server
  }

  private directory(): Domain<typeof sshServersSpec> {
    if (this.closed || this.domain === undefined) throw new Error('SSH server directory is unavailable')
    return this.domain
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('SSH server directory is unavailable'))
    const result = this.writes.then(operation)
    this.writes = result.then(() => {}, () => {})
    return result
  }
}
