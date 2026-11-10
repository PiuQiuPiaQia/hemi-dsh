/** Ref-counted real SSH provider groups; no execution service is replaced on the Host. */
import type { Context } from '@deepseek-ai/cordis'
import type { AgentExecutionLease, ExecutionProviderId } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SshConnection } from '@deepseek-ai/dsh-ssh'
import { SshFileSystem } from '@deepseek-ai/dsh-fs-ssh'
import { SshSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-ssh'
import { SshSandboxProvider } from '@deepseek-ai/dsh-sandbox-ssh'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { NodePtcRuntime } from '@deepseek-ai/dsh-ptc-runtime-node'
import type { SshServer } from './types.ts'
import type { SshEndpointArgs } from './browse.ts'
import type { SshExecutionTargetRecord } from './workspace-spec.ts'

const services = ['ssh', 'fs', 'subprocess', 'sandbox', 'shell', 'ptcRuntime'] as const

async function observe<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  const cancelled = Promise.withResolvers<never>()
  const abort = (): void => { cancelled.reject(signal.reason) }
  signal.addEventListener('abort', abort, { once: true })
  try { return await Promise.race([promise, cancelled.promise]) }
  finally { signal.removeEventListener('abort', abort) }
}

class ExecutionInstance {
  readonly realm = Symbol('Hemi SSH execution')
  readonly lifetime = new AbortController()
  readonly ready: Promise<void>
  private readonly labels = {
    ssh: Symbol('ssh'), fs: Symbol('fs'), subprocess: Symbol('subprocess'),
    sandbox: Symbol('sandbox'), shell: Symbol('shell'), ptcRuntime: Symbol('ptcRuntime'),
  }
  private readonly released = Promise.withResolvers<undefined>()
  private readonly idle = Promise.withResolvers<undefined>()
  private readonly drained: Promise<void>
  private readonly unfollow: () => Promise<void>
  private readonly context: Context
  private users = 0
  private closing: Promise<void> | undefined

  constructor(
    owner: Context, target: SshExecutionTargetRecord, provider: ExecutionProviderId,
    private readonly retire: () => void, private readonly forget: () => void,
    private readonly authenticatedEndpoint: (server: SshServer, signal: AbortSignal) => Promise<SshEndpointArgs>,
  ) {
    const scope = createScope(this.bind(owner), {})
    this.context = scope.ctx
    this.drained = this.released.promise.then(() => scope.dispose())
    const drained = this.drained
    this.unfollow = owner.effect(function* () {
      yield scope.rawDispose
      yield () => drained
    }, 'hemi-ssh.execution-instance')
    this.ready = this.initialize(target, provider).catch((error: unknown) => { this.lifetime.abort(error); throw error })
    // Borrowers observe startup failure; an aborted last borrower can leave no waiter on readiness.
    void this.ready.catch(() => {})
  }

  async acquire(signal: AbortSignal): Promise<AgentExecutionLease> {
    signal.throwIfAborted()
    this.lifetime.signal.throwIfAborted()
    this.users++
    let release: Promise<void> | undefined
    const close = (): Promise<void> => (release ??= Promise.resolve().then(() => this.release()))
    try {
      await observe(this.ready, AbortSignal.any([signal, this.lifetime.signal]))
      this.lifetime.signal.throwIfAborted()
      return { realm: this.realm, signal: this.lifetime.signal, bind: base => this.bind(base), close }
    } catch (error: unknown) {
      await close()
      throw error
    }
  }

  withdraw(): Promise<void> {
    this.lifetime.abort(new Error('SSH execution owner is closing'))
    return this.idle.promise.then(() => this.close())
  }

  private bind(base: Context): Context {
    let bound = base
    // Cordis stores values by label: each service needs its own label, separate from the realm identity.
    this.lifetime.signal.throwIfAborted()
    for (const name of services) bound = bound.isolate(name, this.labels[name])
    return bound
  }

  private async initialize(target: SshExecutionTargetRecord, provider: ExecutionProviderId): Promise<void> {
    const context = this.context
    const lifetime = this.lifetime
    const authenticated = await this.authenticatedEndpoint(target.server, lifetime.signal)
    lifetime.signal.throwIfAborted()
    const composition = context.effect(async function* () {
      const ssh = context.plugin(SshConnection, {
        host: target.server.host, port: target.server.port,
        ...target.server.username === '' ? {} : { username: target.server.username },
        ...target.server.identityFile === '' ? {} : { identityFile: target.server.identityFile },
        ...authenticated.controlPath === undefined ? {} : { authenticatedControlPath: authenticated.controlPath },
        ...target.deployment, workspace: target.path, executionTarget: { provider, id: target.id },
      })
      yield ssh.dispose
      await ssh
      const connection = context.get('ssh')
      if (connection === undefined) throw new Error('SSH connection did not publish its service')
      const lost = (): void => { lifetime.abort(connection.signal.reason) }
      connection.signal.addEventListener('abort', lost, { once: true })
      yield () => { connection.signal.removeEventListener('abort', lost) }
      if (connection.signal.aborted) lost()
      lifetime.signal.throwIfAborted()
      const sandbox = context.plugin(SshSandboxProvider)
      yield sandbox.dispose
      await sandbox
      const subprocess = context.plugin(SshSubprocessRuntime)
      yield subprocess.dispose
      await subprocess
      const fs = context.plugin(SshFileSystem)
      yield fs.dispose
      await fs
      const shell = context.plugin(SandboxBashExecutor, { cwd: target.path })
      yield shell.dispose
      await shell
      const ptc = context.plugin(NodePtcRuntime, { launch: connection.ptcLaunch })
      yield ptc.dispose
      await ptc
      lifetime.signal.throwIfAborted()
    }, 'hemi-ssh.execution-providers')
    await composition
  }

  private release(): Promise<void> {
    this.users--
    if (this.users !== 0) return Promise.resolve()
    this.idle.resolve(undefined)
    return this.close()
  }

  private close(): Promise<void> {
    return this.closing ??= Promise.resolve().then(async () => {
      this.retire()
      this.lifetime.abort(new Error('SSH execution instance released'))
      this.released.resolve(undefined)
      try { await this.drained } finally {
        try { await this.unfollow() } finally { this.forget() }
      }
    })
  }
}

/** One Hemi service owns the groups; the last borrower closes each group, including failed startup. */
export class SshExecutionPool {
  private readonly entries = new Map<string, ExecutionInstance>()
  private readonly live = new Set<ExecutionInstance>()
  private closing: Promise<void> | undefined

  /**
   * @param owner - plugin context owning every provider group.
   * @param provider - registered execution-provider identity bound to every target.
   * @param authenticatedEndpoint - owner retaining authentication across directory and execution channels.
   */
  constructor(
    private readonly owner: Context, private readonly provider: ExecutionProviderId,
    private readonly authenticatedEndpoint: (server: SshServer, signal: AbortSignal) => Promise<SshEndpointArgs>,
  ) {}

  /**
   * Retain providers for one immutable endpoint, helper deployment and directory.
   * @param target - validated durable target or a private directory probe snapshot.
   * @param signal - caller cancellation; never cancels a different borrower's work.
   * @returns a lease binding only this group's six execution services.
   */
  acquire(target: SshExecutionTargetRecord, signal: AbortSignal): Promise<AgentExecutionLease> {
    if (this.closing !== undefined) return Promise.reject(new Error('SSH execution pool is closed'))
    signal.throwIfAborted()
    const key = JSON.stringify([target.id, target.server, target.deployment, target.path])
    let entry = this.entries.get(key)
    if (entry === undefined || entry.lifetime.signal.aborted) {
      const created = new ExecutionInstance(this.owner, target, this.provider, () => {
        if (this.entries.get(key) === created) this.entries.delete(key)
      }, () => { this.live.delete(created) }, this.authenticatedEndpoint)
      entry = created
      this.entries.set(key, created)
      this.live.add(created)
    }
    return entry.acquire(signal)
  }

  /** Stop admission, cancel borrowers and wait for their actual provider cleanup. */
  close(): Promise<void> {
    return this.closing ??= Promise.resolve().then(async () => {
      const results = await Promise.allSettled([...this.live].map(entry => entry.withdraw()))
      this.entries.clear()
      this.live.clear()
      const failures: unknown[] = []
      for (const result of results) if (result.status === 'rejected') failures.push(result.reason)
      if (failures.length > 0) throw new AggregateError(failures, 'SSH execution cleanup failed')
    })
  }
}
