/** OpenSSH connection owner for one version-matched POSIX helper and its process streams. */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { isIP } from 'node:net'
import type { Duplex } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { assertNever } from '@deepseek-ai/dsh-util-values'
// Hemi fork: an explicit target marks a non-default execution environment, never a Host-path policy namespace.
import { isSessionExecutionTarget, type SessionExecutionTarget } from '@deepseek-ai/dsh-session'
import { SshRpcPeer, SSH_PROTOCOL_VERSION } from './protocol.ts'
import { helloSchema } from './schemas.ts'
import type { SshStreamId } from './streams.ts'

type Hello = z.infer<typeof helloSchema>

/** Installed helper invocation; script deployments may also install a PTC bootstrap. */
export type HelperLaunch = {
  /** Run the installed script with a separately installed Node executable. */
  kind: 'node-script'
  /** Absolute remote Node executable. */
  node: string
  /** Absolute remote PTC bootstrap; requires bootstrapHash. */
  bootstrapPath?: string
  /** Lowercase SHA-256 of bootstrapPath; requires that path. */
  bootstrapHash?: string
} | {
  /** Run the helper executable with its embedded Node and PTC worker. */
  kind: 'executable'
}

/** Deployment-owned SSH identity and installed helper; no model argument selects these values. */
export interface Config {
  /** OpenSSH alias, DNS name or IP address; legacy user@host remains supported. */
  host: string
  /** Explicit login; omission retains the alias or legacy host's user selection. */
  username?: string
  /** Explicit TCP port; omission retains OpenSSH configuration. */
  port?: number
  /** Local identity-file path; omission retains OpenSSH credential selection. No key contents are read by this service. */
  identityFile?: string
  /** Hemi fork: borrowed OpenSSH control socket already authenticated to this exact endpoint; its owner retains and closes the master. */
  authenticatedControlPath?: string
  /** Explicit script or self-contained executable invocation. */
  launch: HelperLaunch
  /** Absolute path to the installed, bundled helper entry. */
  helper: string
  /** SHA-256 of that bundled helper; mismatches refuse the connection. */
  helperHash: string
  /** Explicit non-default environment; absent when SSH is the deployment-default provider. */
  executionTarget?: SessionExecutionTarget
  /** Absolute remote default workspace. */
  workspace: string
  /** Connection and administrative-request deadline, at most 2,147,483,647 milliseconds. */
  requestTimeoutMs?: number
  /** Maximum JSON payload bytes per helper request or response. */
  maxFrameBytes?: number
  /** Maximum ordinary requests; heartbeat and bounded resource cleanup have reserved capacity. */
  maxPending?: number
  /** Remote helper lease; loss of heartbeats starts remote managed cleanup. */
  leaseMs?: number
}

type OptionalConfig = 'username' | 'port' | 'identityFile' | 'executionTarget' | 'authenticatedControlPath'
type ResolvedConfig = Required<Omit<Config, OptionalConfig>> & Pick<Config, OptionalConfig>

function validHost(value: string): boolean {
  if (/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/.test(value)) return true
  const separator = value.lastIndexOf('@')
  const host = value.slice(separator + 1)
  if (separator >= 0 && !/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/.test(value.slice(0, separator))) return false
  return isIP(host) === 6 || host.startsWith('[') && host.endsWith(']') && isIP(host.slice(1, -1)) === 6
}

declare module '@deepseek-ai/cordis' {
  interface Context { ssh: SshConnection }
}

/** One non-reconnecting SSH session; loss invalidates all active operations. */
export class SshConnection extends Service {
  static Config: schema<Config> = schema.object({
    host: schema.string().required(), helper: schema.string().required(),
    username: schema.string(), port: schema.number().step(1).min(1).max(65535), identityFile: schema.string(),
    authenticatedControlPath: schema.string(),
    launch: schema.union([
      schema.object({ kind: schema.const('node-script').required(), node: schema.string().required(), bootstrapPath: schema.string(), bootstrapHash: schema.string() }),
      schema.object({ kind: schema.const('executable').required() }),
    ]).required(),
    helperHash: schema.string().required(), workspace: schema.string().required(),
    executionTarget: schema.any<SessionExecutionTarget>(),
    requestTimeoutMs: schema.number().default(30_000), maxFrameBytes: schema.number().default(64 * 1024 * 1024),
    maxPending: schema.number().default(128), leaseMs: schema.number().default(30_000),
  })

  /** Verified remote helper coordinates; callers must await this before launch. */
  readonly ready: Promise<Hello>
  private rpc: SshRpcPeer | undefined
  private child: ChildProcessWithoutNullStreams | undefined
  private childClosed: Promise<void> | undefined
  private heartbeat: NodeJS.Timeout | undefined
  private closed = false
  private readonly lifetime = new AbortController()
  private disposal: Promise<void> | undefined
  private failure: Error | undefined
  private readonly config: ResolvedConfig
  private remote: Hello | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, 'ssh')
    if (process.platform !== 'linux' && process.platform !== 'darwin') throw new Error('SSH runtime requires a POSIX client')
    this.config = z.object({
      host: z.string().refine(validHost, 'invalid SSH host'),
      username: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.@-]+$/).refine(value => !value.startsWith('-')).optional(),
      port: z.number().int().min(1).max(65535).optional(),
      identityFile: z.string().min(1).max(4096).regex(/^[^\p{Cc}]+$/u).optional(),
      authenticatedControlPath: z.string().startsWith('/').max(4096).regex(/^[^\p{Cc}]+$/u).optional(),
      launch: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('node-script'), node: z.string().startsWith('/'),
          bootstrapPath: z.string().startsWith('/').optional(), bootstrapHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
        }).strict().refine(value => (value.bootstrapPath === undefined) === (value.bootstrapHash === undefined), 'bootstrapPath and bootstrapHash must be paired'),
        z.object({ kind: z.literal('executable') }).strict(),
      ]),
      helper: z.string().startsWith('/'), helperHash: z.string().regex(/^[0-9a-f]{64}$/),
      executionTarget: z.custom<SessionExecutionTarget>(isSessionExecutionTarget)
        .transform(value => Object.freeze({ ...value })).optional(),
      workspace: z.string().startsWith('/'), requestTimeoutMs: z.number().int().positive().max(2_147_483_647),
      maxFrameBytes: z.number().int().positive().max(64 * 1024 * 1024), maxPending: z.number().int().positive().max(128),
      leaseMs: z.number().int().min(3000).max(600_000),
    }).strict().refine(value => value.username === undefined || !value.host.includes('@'),
      'username and legacy user@host must not be combined').parse(config) as ResolvedConfig
    this.ready = this.start()
    // Startup uses Node I/O, local validation, and Error-valued RPC failures.
    void this.ready.catch((error: unknown) => { this.fail(error as Error) })
    ctx.effect(() => () => this.dispose())
  }

  /** Hold plugin readiness until the remote identity and helper digest are verified. */
  async [Service.init](): Promise<void> { await this.ready }

  /** Aborts on transport loss or owner shutdown; consumers must stop before releasing this execution instance. */
  get signal(): AbortSignal { return this.lifetime.signal }

  /** Explicit execution environment; its deployment-default writable roots must not be inherited. */
  get executionTarget(): SessionExecutionTarget | undefined { return this.config.executionTarget }

  /** Physical remote workspace verified during readiness; never the Host fallback path. */
  get workspaceRoot(): string {
    if (this.remote === undefined) throw new Error('SSH helper is not ready')
    return this.remote.workspace
  }

  /** Verified remote PTC launch configuration; script deployments require a verified bootstrap. */
  get ptcLaunch(): { kind: 'embedded'; executable: string } | { kind: 'node-script'; executable: string; bootstrapPath: string } {
    if (this.remote === undefined) throw new Error('SSH helper is not ready')
    const launch = this.config.launch
    switch (launch.kind) {
      case 'executable': return { kind: 'embedded', executable: this.remote.executable }
      case 'node-script':
        if (launch.bootstrapPath === undefined) throw new Error('SSH PTC requires a verified bootstrapPath and bootstrapHash')
        return { kind: 'node-script', executable: this.remote.executable, bootstrapPath: launch.bootstrapPath }
      /* v8 ignore next -- Config parsing admits only these two launch kinds. */
      default: return assertNever(launch)
    }
  }

  /**
   * Send a helper operation; cancellation never replays an ambiguous mutation.
   * @param method - the private helper operation.
   * @param params - JSON request fields validated by the helper.
   * @param result - response validation before returning provider-visible data.
   * @param signal - cancellation, which does not undo completed remote effects.
   * @param wait - allow a process observation to outlast the administrative deadline.
   * @returns the validated remote result.
   */
  async request<T>(method: string, params: unknown, result: z.ZodType<T>, signal?: AbortSignal, wait: boolean = false): Promise<T> {
    this.assertOpen()
    await this.ready
    this.assertOpen()
    const bounded = wait ? signal : signal === undefined
      ? AbortSignal.timeout(this.config.requestTimeoutMs)
      : AbortSignal.any([signal, AbortSignal.timeout(this.config.requestTimeoutMs)])
    return (this.rpc as SshRpcPeer).request(method, params, result, bounded)
  }

  /**
   * Attach one process stream inside the authenticated helper channel.
   * @param id - reservation issued by this connection's helper.
   * @param signal - cancellation of attachment and stream use.
   * @returns a paused duplex; attach a consumer before resuming it.
   */
  async connectStream(id: SshStreamId, signal?: AbortSignal): Promise<Duplex> {
    this.assertOpen()
    await this.ready
    this.assertOpen()
    const deadline = new AbortController()
    const timer = setTimeout(() => { deadline.abort(new Error('SSH process stream attachment timed out')) }, this.config.requestTimeoutMs)
    const lifetime = signal === undefined ? deadline.signal : AbortSignal.any([signal, deadline.signal])
    try { return await (this.rpc as SshRpcPeer).openStream(id, lifetime) }
    finally { clearTimeout(timer) }
  }

  /** Request remote managed cleanup before ending the SSH exec session. */
  dispose(): Promise<void> {
    this.disposal ??= this.disposeOnce()
    return this.disposal
  }

  private async disposeOnce(): Promise<void> {
    this.closed = true
    this.lifetime.abort(new Error('SSH connection is closing'))
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    try {
      await this.ready.catch(() => {})
      if (this.failure === undefined) await this.rpc?.request('close', {}, z.null(), AbortSignal.timeout(this.config.requestTimeoutMs))
    } finally {
      this.rpc?.close()
      this.child?.kill('SIGTERM')
      const force = setTimeout(() => { this.child?.kill('SIGKILL') }, this.config.requestTimeoutMs)
      try { await this.childClosed } finally { clearTimeout(force) }
    }
  }

  private identityArguments(): string[] {
    // Hemi fork: saved login fields remain argv values, never shell syntax or rewritten SSH configuration.
    return [
      ...this.config.username === undefined ? [] : ['-l', this.config.username],
      ...this.config.port === undefined ? [] : ['-p', String(this.config.port)],
      ...this.config.identityFile === undefined ? [] : ['-i', this.config.identityFile],
    ]
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('SSH connection is closed')
    if (this.failure !== undefined) throw this.failure
  }

  private fail(error: Error): void {
    if (this.failure !== undefined) return
    this.failure = error
    this.lifetime.abort(error)
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    this.rpc?.close(error)
    this.child?.kill('SIGTERM')
  }

  private async start(): Promise<Hello> {
    if (this.closed) throw new Error('SSH connection closed before startup')
    const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
    const launch = this.config.launch
    let command: string
    let bootstrapPath: string | undefined
    let bootstrapHash: string | undefined
    switch (launch.kind) {
      case 'node-script':
        command = [launch.node, '--disable-sigusr1', this.config.helper].map(quote).join(' ')
        bootstrapPath = launch.bootstrapPath
        bootstrapHash = launch.bootstrapHash
        break
      case 'executable':
        command = `NODE_OPTIONS='--disable-sigusr1' ${quote(this.config.helper)}`
        break
      /* v8 ignore next -- Config parsing admits only these two launch kinds. */
      default: return assertNever(launch)
    }
    // Hemi fork: a borrowed master must already authenticate this endpoint. Refuse a replacement connection.
    const master = this.config.authenticatedControlPath
    const child = spawn('ssh', [
      '-T', '-o', 'ControlMaster=no', '-S', master ?? 'none',
      ...master === undefined ? [] : ['-o', 'ProxyCommand=false'],
      '-o', 'ControlPersist=no', '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
      '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3', ...this.identityArguments(), this.config.host, command,
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    this.childClosed = new Promise((resolve) => { child.once('close', () => { resolve() }) })
    child.stderr.resume() // SSH diagnostics can contain configured paths; operation errors remain structured.
    child.once('error', (error) => { this.fail(error) })
    child.once('close', () => { this.fail(new Error('SSH helper disconnected; remote outcomes and cleanup are unknown')) })
    const rpc = new SshRpcPeer(child.stdout, child.stdin, this.config.maxFrameBytes, this.config.maxPending)
    this.rpc = rpc
    rpc.once('closed', (error) => { this.fail(error as Error) })
    const hello = await rpc.request('hello', {
      protocol: SSH_PROTOCOL_VERSION, workspace: this.config.workspace, leaseMs: this.config.leaseMs,
      ...(bootstrapPath === undefined ? {} : { bootstrapPath }),
    }, helloSchema, AbortSignal.timeout(this.config.requestTimeoutMs))
    if (hello.hash !== this.config.helperHash) throw new Error('SSH helper digest differs from the configured artifact')
    if (hello.kind !== launch.kind) throw new Error('SSH helper runtime differs from the configured launch kind')
    if (hello.bootstrapHash !== bootstrapHash) throw new Error('SSH PTC bootstrap digest differs from the configured artifact')
    this.remote = hello
    let heartbeatPending: Promise<unknown> | undefined
    this.heartbeat = setInterval(() => {
      heartbeatPending ??= rpc.request('heartbeat', {}, z.null(), AbortSignal.timeout(this.config.leaseMs / 2))
        .catch((error: unknown) => { this.fail(error as Error) })
        .finally(() => { heartbeatPending = undefined })
    }, Math.floor(this.config.leaseMs / 3))
    this.heartbeat.unref()
    return hello
  }
}

export default SshConnection
