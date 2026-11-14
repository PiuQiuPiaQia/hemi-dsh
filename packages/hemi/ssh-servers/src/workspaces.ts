/** Hemi SSH directory selection and immutable execution-provider registration. */
import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import schema from '@deepseek-ai/schemastery'
import { Context, Service } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ExecutionTargetUnavailableError, type AgentExecutionLease } from '@deepseek-ai/dsh-session'
import type { ExecutionProviderId, ExecutionTargetId } from '@deepseek-ai/dsh-session'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from './index.ts'
import type {} from '@deepseek-ai/dsh-api-workspace-controller'
import { sshWorkspaceDisplayTitle } from './workspace-title.ts'
import { SshAuthentication, SshAuthenticationError } from './authentication.ts'
import type { SshAuthenticationChallenge, SshAuthenticationChallengeId } from './authentication-types.ts'
import { SshExecutionPool } from './execution-pool.ts'
import { containsPath, listRemoteDirectories, resolveRemoteHome, type SshEndpointArgs } from './browse.ts'
import { rememberFailureReasonOf } from './remembered-passwords.ts'
import { provisionRemoteNode } from './node-provision.ts'
import { loadHelperArtifacts, type SshHelperArtifacts } from './runtime-artifacts.ts'
import { isCurrentManagedHelper, managedHelperDirectory, prepareRemoteRuntime } from './runtime-bootstrap.ts'
import { serverInputSchema } from './spec.ts'
import { runtimeDeploymentSchema, sshWorkspacesSpec } from './workspace-spec.ts'
import type { SshExecutionTargetRecord } from './workspace-spec.ts'
import type { SshServer, SshServerId, SshServerInput } from './types.ts'
import type { SshDirectorySelection, SshRemoteDirectory, SshRemoteFolders, SshRuntimeDeployment, SshSavedRuntime, SshWorkspaceRevision } from './workspace-types.ts'

export type { SshDirectorySelection, SshRemoteDirectory, SshRemoteFolders, SshRuntimeDeployment, SshSavedRuntime, SshWorkspaceRevision } from './workspace-types.ts'

/** Authentication and retained-master liveness settings for the workspace service. */
export interface Config {
  /** Deadline in milliseconds for connection, all native prompts and readiness. */
  authenticationTimeoutMs: number
  /** Deadline in milliseconds for supplying the bundled remote Node runtime when the server has none. */
  runtimeProvisionTimeoutMs: number
  /** OpenSSH probe interval in seconds while the authenticated master is otherwise idle. */
  serverAliveIntervalSeconds: number
  /** Unanswered OpenSSH probes before the master disconnects and permits fresh authentication. */
  serverAliveCountMax: number
}

/** Stable provider identity; target ids resolve only through validated durable snapshots. */
export const SSH_EXECUTION_PROVIDER = brandString<ExecutionProviderId>('hemi-ssh')

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Real remote folder selection; saved references alone create no Workspace. */
    hemiSshWorkspaces: HemiSshWorkspaces
  }
}

/** Explicit deployments and verified remote directories under the Gateway's global-resource policy. */
export default class HemiSshWorkspaces extends TypertRemoteService {
  static inject = ['storageDomain', 'sessions', 'hemiSshServers', 'sandboxPolicy']
  static Config: schema<Config> = schema.object({
    authenticationTimeoutMs: schema.number().step(1).min(1).max(2_147_483_647).default(120_000),
    runtimeProvisionTimeoutMs: schema.number().step(1).min(1).max(2_147_483_647).default(300_000),
    serverAliveIntervalSeconds: schema.number().step(1).min(1).max(2_147_483_647).default(10),
    serverAliveCountMax: schema.number().step(1).min(1).max(2_147_483_647).default(3),
  })
  private readonly authentication: SshAuthentication
  private domain: Domain<typeof sshWorkspacesSpec> | undefined
  private readonly lifecycle = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly connecting = new Map<SshServerId, Promise<SshSavedRuntime>>()
  private readonly managedDeployments = new Map<string, Promise<SshRuntimeDeployment>>()
  private bundledArtifacts: Promise<SshHelperArtifacts> | undefined
  private writes: Promise<void> = Promise.resolve()
  private unregister: (() => Promise<void>) | undefined
  private readonly runtime: { owner: Context; pool: SshExecutionPool }
  private readonly provisionTimeoutMs: number

  /**
   * @param ctx - Host owner supplying directory storage and execution registration.
   * @param config - validated authentication, provisioning and master liveness settings; passwords are never configuration.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'hemiSshWorkspaces', { namespace: 'hemiSshWorkspaces' })
    this.provisionTimeoutMs = config.runtimeProvisionTimeoutMs
    this.authentication = new SshAuthentication({ timeoutMs: config.authenticationTimeoutMs,
      serverAliveIntervalSeconds: config.serverAliveIntervalSeconds, serverAliveCountMax: config.serverAliveCountMax,
      passwordMemory: ctx.hemiSshServers.authenticationPasswords() })
    this.runtime = { owner: ctx, pool: new SshExecutionPool(ctx, SSH_EXECUTION_PROVIDER,
      (server, signal) => this.authenticate(this.endpointOf(server), signal)) }
    ctx.effect(() => async () => {
      this.lifecycle.abort(new Error('SSH workspace service is closing'))
      const results = await Promise.allSettled([
        this.unregister?.(), this.writes, ...this.operations, ...this.managedDeployments.values(),
      ])
      const failures: unknown[] = []
      for (const result of results) if (result.status === 'rejected') failures.push(result.reason)
      try { await this.runtime.pool.close() } catch (error: unknown) { failures.push(error) }
      try { await this.authentication.dispose() } catch (error: unknown) { failures.push(error) }
      try { await this.domain?.close() } catch (error: unknown) { failures.push(error) }
      if (failures.length > 0) throw new AggregateError(failures, 'SSH workspace shutdown failed')
    }, 'hemi-ssh.workspaces: consumers, providers and domain')
  }

  /** Validate persisted targets before publishing the provider. */
  async [Service.init](): Promise<void> {
    const domain = await this.runtime.owner.storageDomain.open(sshWorkspacesSpec)
    if (this.lifecycle.signal.aborted) {
      await domain.close()
      this.lifecycle.signal.throwIfAborted()
    }
    this.domain = domain
    // The optional BFF adapter decorates old and new Workspaces without making headless SSH depend on a GUI service.
    this.runtime.owner.inject(['workspaceController'], (ctx) => {
      ctx.effect(() => ctx.workspaceController.registerDisplayTitle({
        resolve: (workspace, views) => sshWorkspaceDisplayTitle(workspace, SSH_EXECUTION_PROVIDER,
          this.directory().global.get().targets, ctx.hemiSshServers.list(this.lifecycle.signal), views),
        subscribe: listener => ctx.on('domain/changed', (change) => {
          if (change.domain === 'hemi_ssh_servers' || change.domain === 'hemi_ssh_workspaces') listener()
        }),
      }), 'hemi-ssh: Workspace display names')
    })
    this.unregister = this.runtime.owner.sessions.registerExecutionProvider(SSH_EXECUTION_PROVIDER, {
      acquire: (id, signal) => {
        const target = this.directory().global.get().targets.find(row => row.id === id)
        if (target === undefined) throw new RemoteError('hemi-ssh/target-unavailable', 'Restore the saved SSH execution target', { targetId: id })
        return this.run(signal, async (control) => {
          try { return await this.acquireTarget(target, control) }
          catch (cause: unknown) {
            control.throwIfAborted()
            throw new ExecutionTargetUnavailableError({ provider: SSH_EXECUTION_PROVIDER, id }, 'acquisition-failed', { cause })
          }
        })
      },
    })
  }

  /**
   * Follow native OpenSSH login prompts without including responses or stored passwords.
   * @param signal - calling UI lifetime; service unload ends this stream.
   * @returns current authentication challenges, including the initial snapshot.
   */
  @Remote({ mode: 'stream' })
  async *followAuthentication(signal: AbortSignal): AsyncIterable<readonly SshAuthenticationChallenge[]> {
    yield* this.authentication.follow(AbortSignal.any([signal, this.lifecycle.signal]))
  }

  /**
   * Answer exactly one active login prompt without saving or logging its response.
   * @param id - active challenge identity received from the authentication stream.
   * @param answer - native response, or null to cancel; never a connection setting.
   * @param signal - caller cancellation before the response is accepted.
   */
  @Remote
  // oxlint-disable-next-line typescript/require-await -- Preserve Promise rejection semantics for synchronous native prompt acceptance.
  async answerAuthentication(id: SshAuthenticationChallengeId, answer: string | null, signal: AbortSignal): Promise<void> {
    try { this.authentication.answer(id, answer, AbortSignal.any([signal, this.lifecycle.signal])) }
    catch (error: unknown) { this.authenticationAnswerFailure(error, id) }
  }

  /**
   * Answer one native prompt with an explicit password-saving choice; successful authentication commits the opted-in password.
   * @param id - active challenge identity; only a challenge marked canRemember accepts a non-cancelled opt-in.
   * @param answer - native response, or null to cancel without saving.
   * @param remember - true saves the accepted password through DSH credentials; false keeps the response transient.
   * @param signal - caller cancellation before the response is accepted.
   * @returns after accepting the response, not a password-save receipt; a store failure rejects the awaiting connection operation.
   */
  @Remote
  // oxlint-disable-next-line typescript/require-await -- Preserve Promise rejection semantics for synchronous prompt acceptance.
  async answerAuthenticationAndRemember(
    id: SshAuthenticationChallengeId, answer: string | null, remember: boolean, signal: AbortSignal,
  ): Promise<void> {
    try { this.authentication.answerRemember(id, answer, remember, AbortSignal.any([signal, this.lifecycle.signal])) }
    catch (error: unknown) { this.authenticationAnswerFailure(error, id) }
  }

  private authenticationAnswerFailure(error: unknown, id: SshAuthenticationChallengeId): never {
    if (error instanceof SshAuthenticationError) {
      if (error.code === 'stale-challenge' || error.code === 'disposed') {
        throw new RemoteError('hemi-ssh/authentication-expired', 'The SSH login prompt is no longer active', {})
      }
      if (error.code === 'invalid-answer') {
        throw new RemoteError('hemi-ssh/invalid-input', 'The SSH response is invalid', { field: 'authentication' })
      }
      if (error.code === 'not-rememberable') {
        throw new RemoteError('hemi-ssh/not-rememberable', 'This SSH prompt cannot store a password', { id })
      }
    }
    throw error
  }

  /**
   * Read the explicit helper deployment without contacting the remote machine.
   * @param serverId - saved connection whose deployment to read.
   * @param signal - caller cancellation before reading.
   * @returns the saved deployment, or undefined until configured.
   */
  @Remote
  getRuntime(serverId: SshServerId, signal: AbortSignal): SshSavedRuntime | undefined {
    signal.throwIfAborted()
    this.server(serverId, signal)
    return this.directory().global.get().runtimes.find(row => row.serverId === serverId)
  }

  /**
   * Save an explicit installed helper; this operation installs nothing and reads no key.
   * @param serverId - saved connection to configure.
   * @param revision - last observed deployment revision; omitted for initial configuration.
   * @param deployment - absolute remote artifact coordinates and verified digests.
   * @param signal - cancellation before the durable write starts.
   * @returns the durable deployment and its replacement revision.
   */
  @Remote
  configureRuntime(
    serverId: SshServerId, revision: string | undefined, deployment: SshRuntimeDeployment, signal: AbortSignal,
  ): Promise<SshSavedRuntime> {
    signal.throwIfAborted()
    const parsed = runtimeDeploymentSchema.safeParse(deployment)
    if (!parsed.success) {
      throw new RemoteError('hemi-ssh/invalid-runtime', 'Check the installed SSH helper configuration',
        { field: String(parsed.error.issues[0]?.path[0] ?? 'deployment') })
    }
    return this.enqueue(async () => {
      signal.throwIfAborted()
      this.server(serverId, signal)
      const domain = this.directory()
      const current = domain.global.get()
      const previous = current.runtimes.find(row => row.serverId === serverId)
      if (previous?.revision !== revision) {
        throw new RemoteError('hemi-ssh/connection-changed', 'Reload the SSH runtime before saving', { serverId })
      }
      const saved = { serverId, revision: randomUUID(), deployment: parsed.data }
      await domain.global.set({ ...current, runtimes: [...current.runtimes.filter(row => row.serverId !== serverId), saved] })
      return saved
    })
  }

  /**
   * Prepare and verify the automatic helper runtime for one saved connection without user artifact input.
   * Re-verifying an unchanged saved deployment keeps its revision, so concurrent editors never invalidate each other.
   * @param serverId - saved connection to make ready.
   * @param serverRevision - endpoint revision loaded with that record.
   * @param signal - cancellation of probing, streaming and the verification connection.
   * @returns the durable deployment the connection is verified against.
   */
  @Remote
  connectServer(serverId: SshServerId, serverRevision: string, signal: AbortSignal): Promise<SshSavedRuntime> {
    return this.run(signal, async (control) => {
      const server = this.server(serverId, control)
      if (server.revision !== serverRevision) {
        throw new RemoteError('hemi-ssh/connection-changed', 'Reload the connection before connecting', { serverId })
      }
      const joining = this.connecting.get(serverId)
      if (joining !== undefined) {
        const result = await this.join(joining, control)
        if (this.server(serverId, control).revision !== serverRevision) {
          throw new RemoteError('hemi-ssh/connection-changed', 'Reload the connection before connecting', { serverId })
        }
        return result
      }
      const operation = this.connect(server, control)
      // Only the originating caller and joiners observe the failure; the tracker must not hold a bare rejection.
      void operation.finally(() => { this.connecting.delete(serverId) }).catch(() => {})
      this.connecting.set(serverId, operation)
      return operation
    })
  }

  /**
   * Browse a not-yet-saved endpoint read-only over plain OpenSSH; no helper, remote runtime or remote write is involved.
   * @param input - editor connection fields; validated exactly like saving.
   * @param path - existing absolute remote directory, or empty for the remote login directory.
   * @param signal - cancellation of the one-shot OpenSSH command.
   * @returns remote directory names and physical location.
   */
  @Remote
  browseServer(input: SshServerInput, path: string, signal: AbortSignal): Promise<SshRemoteDirectory> {
    return this.run(signal, async (control) => {
      const parsed = serverInputSchema.safeParse(input)
      if (!parsed.success) {
        throw new RemoteError('hemi-ssh/invalid-input', 'Check the SSH server fields before browsing', {
          field: String(parsed.error.issues[0]?.path[0] ?? 'server'),
        })
      }
      const endpoint = await this.authenticate(this.endpointOf(parsed.data), control)
      const target = await this.targetDirectory(endpoint, path, control)
      return listRemoteDirectories(endpoint, target, control)
    })
  }

  /**
   * List directories of a saved connection read-only over plain OpenSSH.
   * @param serverId - saved connection to browse.
   * @param path - existing absolute remote directory, or empty for the remote login directory.
   * @param revision - endpoint and deployment revisions captured before browsing; checked before SSH starts.
   * @param signal - cancellation of the one-shot OpenSSH command.
   * @returns remote directory names and physical location.
   */
  @Remote
  browseFolders(serverId: SshServerId, path: string, revision: SshWorkspaceRevision, signal: AbortSignal): Promise<SshRemoteFolders> {
    return this.run(signal, async (control) => {
      const checked = this.revisionSnapshot(serverId, revision, control)
      const endpoint = await this.authenticate(this.endpointOf(checked.server), control)
      const target = await this.targetDirectory(endpoint, path, control)
      const view = await listRemoteDirectories(endpoint, target, control)
      return { revision: { serverRevision: checked.server.revision, runtimeRevision: checked.runtimeRevision }, ...view }
    })
  }

  /**
   * Browse a saved connection read-only without requiring any prepared runtime; directory choice needs no remote Node.
   * @param serverId - saved connection to browse.
   * @param path - existing absolute remote directory, or empty for the remote login directory.
   * @param serverRevision - endpoint revision loaded with the record; a changed endpoint refuses before SSH starts.
   * @param signal - cancellation of the one-shot OpenSSH command.
   * @returns remote directory names and physical location.
   */
  @Remote
  browseSavedFolders(serverId: SshServerId, path: string, serverRevision: string, signal: AbortSignal): Promise<SshRemoteDirectory> {
    return this.run(signal, async (control) => {
      const server = this.server(serverId, control)
      if (server.revision !== serverRevision) {
        throw new RemoteError('hemi-ssh/connection-changed', 'Reload the connection before browsing it', { serverId })
      }
      const endpoint = await this.authenticate(this.endpointOf(server), control)
      const target = await this.targetDirectory(endpoint, path, control)
      return listRemoteDirectories(endpoint, target, control)
    })
  }

  /**
   * Open one directory of a saved connection end to end: prepare the runtime, then retain the immutable target.
   * The runtime requirement surfaces here, not during directory selection.
   * @param serverId - saved connection to open.
   * @param path - chosen absolute remote directory, or empty for the remote login directory.
   * @param serverRevision - endpoint revision loaded with the record; re-checked at both steps.
   * @param signal - cancellation of runtime preparation, verification and target persistence.
   * @returns a real directory and target, not a synthetic Workspace id.
   */
  @Remote
  prepareServerFolder(
    serverId: SshServerId, path: string, serverRevision: string, signal: AbortSignal,
  ): Promise<SshDirectorySelection> {
    return this.run(signal, async (control) => {
      const ready = await this.connectServer(serverId, serverRevision, control)
      return this.prepareFolder(serverId, path, { serverRevision, runtimeRevision: ready.revision }, control)
    })
  }

  /**
   * Validate a physical folder and retain its immutable target reference for Workspace creation.
   * @param serverId - saved connection to open.
   * @param path - existing absolute remote directory, or empty for the remote login directory.
   * @param revision - successful browse revisions; mismatch refuses before contacting a replacement endpoint.
   * @param signal - cancellation before target persistence begins; an admitted write remains durable.
   * @returns a real directory and target, not a synthetic Workspace id.
   */
  @Remote
  prepareFolder(serverId: SshServerId, path: string, revision: SshWorkspaceRevision, signal: AbortSignal): Promise<SshDirectorySelection> {
    return this.run(signal, async (control) => {
      // The revision gate runs before any SSH: a stale editor never contacts a replacement endpoint.
      const checked = this.revisionSnapshot(serverId, revision, control)
      const initial = await this.targetDirectory(this.endpointOf(checked.server), path, control)
      const probe = this.probe(serverId, initial, revision, control)
      const physical = await this.withFilesystem(probe, control, async (fs, operationSignal) => {
        const target = await fs.resolve(initial, { signal: operationSignal })
        if ((await fs.stat(target, operationSignal))?.type !== 'directory') throw new Error('Remote path is not a directory')
        return fs.processPath(target)
      }).catch((error: unknown) => this.connectionFailure(error, serverId, 'open', control))
      // Lexical containment was checked before connecting; the resolved physical path is authoritative.
      this.refuseRuntimeInsideWorkspace(serverId, probe.deployment, physical)
      return this.enqueue(async () => {
        control.throwIfAborted()
        const server = this.server(serverId, control)
        const domain = this.directory()
        const current = domain.global.get()
        const runtime = current.runtimes.find(row => row.serverId === serverId)
        if (server.revision !== probe.server.revision || runtime?.revision !== probe.runtimeRevision) {
          throw new RemoteError('hemi-ssh/connection-changed', 'Reload the connection before opening its directory', { serverId })
        }
        let target = current.targets.find(row => row.server.id === serverId && row.server.revision === server.revision
          && row.runtimeRevision === runtime.revision && row.path === physical)
        if (target === undefined) {
          target = { ...probe, path: physical }
          await domain.global.set({ ...current, targets: [...current.targets, target] })
        }
        return { executionTarget: { provider: SSH_EXECUTION_PROVIDER, id: target.id }, path: physical,
          title: posix.basename(physical) || physical, serverName: server.name }
      })
    })
  }

  /** Connect one server: verify a saved deployment when possible, otherwise provision Node and deploy the bundled one. */
  private async connect(server: SshServer, signal: AbortSignal): Promise<SshSavedRuntime> {
    const endpoint = await this.authenticate(this.endpointOf(server), signal)
    const saved = this.directory().global.get().runtimes.find(row => row.serverId === server.id)
    if (saved !== undefined) {
      const home = await resolveRemoteHome(endpoint, signal)
      const verified = await this.verifyDeployment(server, saved.deployment, home, signal).then(() => true, (error: unknown) => {
        // A saved deployment that stopped working is replaced below, not retried by the caller.
        this.runtime.owner.logger.warn(`SSH saved runtime failed verification for ${server.id}: ${String(error)}`)
        return false
      })
      if (verified) {
        if (this.server(server.id, signal).revision !== server.revision) {
          throw new RemoteError('hemi-ssh/connection-changed', 'Reload the connection before connecting', { serverId: server.id })
        }
        return saved
      }
    }
    const prepared = await this.prepareDeployment(endpoint, await this.artifacts(), signal)
    await this.verifyDeployment(server, prepared.deployment, prepared.probe.home, signal)
      .catch((error: unknown) => this.connectionFailure(error, server.id, 'connect', signal))
    return this.enqueue(async () => {
      signal.throwIfAborted()
      // An endpoint edited during probing or streaming keeps its previous state untouched.
      if (this.server(server.id, signal).revision !== server.revision) {
        throw new RemoteError('hemi-ssh/connection-changed', 'Reload the connection before connecting', { serverId: server.id })
      }
      const domain = this.directory()
      const current = domain.global.get()
      const existing = current.runtimes.find(row => row.serverId === server.id)
      if (existing !== undefined && this.sameDeployment(existing.deployment, prepared.deployment)) return existing
      const savedRuntime: SshSavedRuntime = { serverId: server.id, revision: randomUUID(), deployment: prepared.deployment }
      await domain.global.set({
        ...current,
        runtimes: [...current.runtimes.filter(row => row.serverId !== server.id), savedRuntime],
      })
      return savedRuntime
    })
  }

  private artifacts(): Promise<SshHelperArtifacts> {
    return this.bundledArtifacts ??= loadHelperArtifacts().catch((error: unknown) => {
      this.bundledArtifacts = undefined
      throw error
    })
  }

  private prepareDeployment(endpoint: SshEndpointArgs, artifacts: SshHelperArtifacts, signal: AbortSignal) {
    return prepareRemoteRuntime(endpoint, artifacts, signal, cacheDir =>
      provisionRemoteNode(endpoint, cacheDir, signal, {
        timeoutMs: this.provisionTimeoutMs,
        onWarn: (message) => { this.runtime.owner.logger.warn(message) },
      }))
  }

  private async acquireTarget(target: SshExecutionTargetRecord, signal: AbortSignal): Promise<AgentExecutionLease> {
    const directory = managedHelperDirectory(target.deployment)
    if (directory === undefined) return this.runtime.pool.acquire(target, signal)
    const artifacts = await this.join(this.artifacts(), signal)
    if (isCurrentManagedHelper(directory, artifacts)) return this.runtime.pool.acquire(target, signal)

    const { server, path } = target
    const key = JSON.stringify([server.id, server.revision])
    let upgrade = this.managedDeployments.get(key)
    if (upgrade === undefined) {
      const current = this.runtime.owner.hemiSshServers.list(signal).find(row => row.id === server.id)
      const saved = current?.revision === server.revision
        ? this.directory().global.get().runtimes.find(row => row.serverId === server.id)
        : undefined
      const savedDirectory = saved === undefined ? undefined : managedHelperDirectory(saved.deployment)
      if (saved !== undefined && savedDirectory !== undefined && isCurrentManagedHelper(savedDirectory, artifacts)) {
        upgrade = Promise.resolve(saved.deployment)
      } else {
        const control = this.lifecycle.signal
        upgrade = this.authenticate(this.endpointOf(server), control)
          .then(endpoint => this.prepareDeployment(endpoint, artifacts, control))
          .then(({ deployment }) => deployment)
          .catch((error: unknown) => { this.managedDeployments.delete(key); throw error })
      }
      this.managedDeployments.set(key, upgrade)
    }
    const deployment = await this.join(upgrade, signal)
    this.refuseRuntimeInsideWorkspace(server.id, deployment, path)
    return this.runtime.pool.acquire({ ...target, deployment }, signal)
  }

  /** Refuse a workspace whose directory physically contains the deployed runtime files. */
  private refuseRuntimeInsideWorkspace(serverId: SshServerId, deployment: SshRuntimeDeployment, workspace: string): void {
    const deployed = [deployment.helper,
      ...deployment.launch.kind === 'node-script' ? [deployment.launch.bootstrapPath] : []]
    for (const artifact of deployed) {
      if (containsPath(workspace, artifact)) {
        throw new RemoteError('hemi-ssh/runtime-inside-workspace',
          'Choose a directory outside the Hemi runtime cache; the remote folder contains the helper itself', { serverId })
      }
    }
  }

  /** Start the helper once through the execution pool so the handshake verifies the deployed digests. */
  private async verifyDeployment(
    server: SshServer, deployment: SshRuntimeDeployment, home: string, signal: AbortSignal,
  ): Promise<void> {
    const target: SshExecutionTargetRecord = {
      id: brandString<ExecutionTargetId>(randomUUID()), server, runtimeRevision: randomUUID(), deployment, path: home,
    }
    const lease = await this.runtime.pool.acquire(target, signal)
    await lease.close()
  }

  private sameDeployment(one: SshRuntimeDeployment, two: SshRuntimeDeployment): boolean {
    if (one.helper !== two.helper || one.helperHash !== two.helperHash || one.launch.kind !== two.launch.kind) return false
    if (one.launch.kind === 'executable' || two.launch.kind === 'executable') return true
    return one.launch.node === two.launch.node
      && one.launch.bootstrapPath === two.launch.bootstrapPath
      && one.launch.bootstrapHash === two.launch.bootstrapHash
  }

  /** Await an in-flight connection another caller started; this caller's cancellation does not abort it. */
  private async join<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted()
    const cancelled = Promise.withResolvers<never>()
    const abort = (): void => { cancelled.reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    try { return await Promise.race([operation, cancelled.promise]) }
    finally {
      signal.removeEventListener('abort', abort)
      void cancelled.promise.catch(() => {})
    }
  }

  /** Resolve an empty request path to the remote login directory; validate explicit paths locally. */
  private async targetDirectory(endpoint: SshEndpointArgs, path: string, signal: AbortSignal): Promise<string> {
    if (path === '') return resolveRemoteHome(endpoint, signal)
    if (!posix.isAbsolute(path) || path.includes('\0')) {
      throw new RemoteError('hemi-ssh/invalid-runtime', 'Enter an absolute remote folder path', { field: 'path' })
    }
    return path
  }

  private async authenticate(endpoint: SshEndpointArgs, signal: AbortSignal): Promise<SshEndpointArgs> {
    try { return await this.authentication.endpoint(endpoint, signal) }
    catch (error: unknown) {
      signal.throwIfAborted()
      if (error instanceof SshAuthenticationError) {
        if (error.code === 'cancelled') {
          throw new RemoteError('hemi-ssh/authentication-cancelled', 'SSH login was cancelled', { host: endpoint.host })
        }
        if (error.code === 'remember-failed') {
          throw new RemoteError('hemi-ssh/remember-failed', 'SSH signed in, but its password could not be saved; the connection was closed',
            { host: endpoint.host, reason: rememberFailureReasonOf(error) })
        }
        throw new RemoteError('hemi-ssh/ssh-unavailable', 'Could not authenticate the SSH connection', {
          host: endpoint.host, reason: error.reason,
        })
      }
      throw error
    }
  }

  private endpointOf(server: Pick<SshServer, 'host' | 'port' | 'username' | 'identityFile'>): SshEndpointArgs {
    return { host: server.host, port: server.port, username: server.username, identityFile: server.identityFile }
  }

  private revisionSnapshot(
    serverId: SshServerId, expected: SshWorkspaceRevision, signal: AbortSignal,
  ): { server: SshServer; runtimeRevision: string } {
    signal.throwIfAborted()
    const server = this.server(serverId, signal)
    const runtime = this.directory().global.get().runtimes.find(row => row.serverId === serverId)
    if (runtime === undefined) {
      throw new RemoteError('hemi-ssh/runtime-unconfigured', 'Connect the server before using its directories', { serverId })
    }
    if (server.revision !== expected.serverRevision || runtime.revision !== expected.runtimeRevision) {
      throw new RemoteError('hemi-ssh/connection-changed', 'Reload the connection before using its directory', { serverId })
    }
    return { server, runtimeRevision: runtime.revision }
  }

  private probe(serverId: SshServerId, path: string, expected: SshWorkspaceRevision, signal: AbortSignal): SshExecutionTargetRecord {
    signal.throwIfAborted()
    if (!posix.isAbsolute(path) || path.includes('\0')) {
      throw new RemoteError('hemi-ssh/invalid-runtime', 'Enter an absolute remote folder path', { field: 'path' })
    }
    const server = this.server(serverId, signal)
    const runtime = this.directory().global.get().runtimes.find(row => row.serverId === serverId)
    if (runtime === undefined) {
      throw new RemoteError('hemi-ssh/runtime-unconfigured', 'Connect the server before opening its directory', { serverId })
    }
    if (server.revision !== expected.serverRevision || runtime.revision !== expected.runtimeRevision) {
      throw new RemoteError('hemi-ssh/connection-changed', 'Reload the connection before using its directory', { serverId })
    }
    // Lexical preflight only; the authoritative check runs on the physically resolved path.
    this.refuseRuntimeInsideWorkspace(serverId, runtime.deployment, path)
    return { id: brandString<ExecutionTargetId>(randomUUID()), server, runtimeRevision: runtime.revision,
      deployment: runtime.deployment, path }
  }

  private async withFilesystem<T>(
    target: SshExecutionTargetRecord, signal: AbortSignal,
    action: (fs: FileSystem, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const lease: AgentExecutionLease = await this.runtime.pool.acquire(target, signal)
    try {
      const control = AbortSignal.any([signal, lease.signal])
      control.throwIfAborted()
      const fs = lease.bind(this.runtime.owner).get('fs')
      if (fs === undefined) throw new Error('SSH execution did not publish its filesystem')
      return await action(fs, control)
    } finally { await lease.close() }
  }

  private connectionFailure(error: unknown, serverId: SshServerId, operation: 'open' | 'connect', signal: AbortSignal): never {
    signal.throwIfAborted()
    this.runtime.owner.logger.warn(`SSH ${operation} failed for ${serverId}: ${String(error)}`)
    throw new RemoteError('hemi-ssh/connection-failed', 'Could not use the remote folder; check SSH access and the remote runtime',
      { serverId, operation })
  }

  private server(id: SshServerId, signal: AbortSignal): SshServer {
    const server = this.runtime.owner.hemiSshServers.list(signal).find(row => row.id === id)
    if (server === undefined) throw new RemoteError('hemi-ssh/not-found', 'Reload the saved SSH connections', { id })
    return server
  }

  private directory(): Domain<typeof sshWorkspacesSpec> {
    this.lifecycle.signal.throwIfAborted()
    if (this.domain === undefined) throw new Error('SSH workspace storage is unavailable')
    return this.domain
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    this.lifecycle.signal.throwIfAborted()
    const operation = this.writes.then(action)
    this.writes = operation.then(() => {}, () => {})
    return operation
  }

  private run<T>(signal: AbortSignal, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const control = AbortSignal.any([signal, this.lifecycle.signal])
    control.throwIfAborted()
    const operation = action(control)
    const settled = operation.finally(() => { this.operations.delete(settled) })
    this.operations.add(settled)
    return settled
  }
}
