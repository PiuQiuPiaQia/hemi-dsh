/**
 * Instance-owned foreground OpenSSH authentication and borrowed control sockets for Hemi's Host operations.
 * Unix permissions and per-master tokens exclude other users and accidental cross-connection workers, not malicious Host-UID code.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { access, chmod, lstat, mkdtemp, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SshEndpointArgs } from './browse.ts'
import type { SshAuthenticationChallenge, SshAuthenticationChallengeId } from './authentication-types.ts'
import {
  MAX_AUTHENTICATION_FRAME_BYTES, parseAskpassRequest, validAuthenticationAnswer,
} from './authentication-protocol.ts'
import type { AskpassRequest } from './authentication-protocol.ts'
import {
  nativePasswordPromptUser, rememberFailureReasonOf, type SshAuthenticationPasswordMemory,
} from './remembered-passwords.ts'

/** Structured failure identity; diagnostic text never selects recovery behavior. */
export type SshAuthenticationErrorCode = 'unavailable' | 'timeout' | 'cancelled' | 'disposed'
  | 'stale-challenge' | 'invalid-answer' | 'askpass-unavailable' | 'ipc-failed' | 'cleanup-failed' | 'unsupported-platform'
  | 'not-rememberable' | 'remember-failed'

/** Authentication stopped without starting a caller's remote business command; accepted known-host trust may remain. */
export class SshAuthenticationError extends Error {
  constructor(
    readonly code: SshAuthenticationErrorCode,
    readonly reason: string,
    readonly exitCode: number | null = null,
    readonly signal: NodeJS.Signals | null = null,
  ) {
    super(`SSH authentication ${code}`)
    this.name = 'SshAuthenticationError'
  }
}

/** Host configuration plus explicit executable locations for isolated process fixtures. */
export interface SshAuthenticationOptions {
  /** Deadline including connection, every prompt, and readiness; supplied by the owning plugin's validated Config. */
  readonly timeoutMs: number
  /** OpenSSH liveness-probe interval in seconds, supplied by the owning plugin's validated Config. */
  readonly serverAliveIntervalSeconds: number
  /** Unanswered OpenSSH probes before closing a ready master, supplied by the owning plugin's validated Config. */
  readonly serverAliveCountMax: number
  /** Omitted in production to resolve the shipped lib/askpass.js beside this bundle. */
  readonly askpassPath?: string
  /** Omitted in production to retain the operator's ordinary OpenSSH executable selection. */
  readonly sshPath?: string
  /** Omitted when no credential store is active; remembering then stays off without changing authentication. */
  readonly passwordMemory?: SshAuthenticationPasswordMemory
}

interface Resources {
  readonly root: string
  readonly parent: string
  readonly socketPath: string
  readonly wrapperPath: string
  readonly server: Server
  readonly sockets: Map<Socket, Promise<void>>
}

interface Master {
  readonly key: string
  readonly endpoint: SshEndpointArgs
  readonly token: string
  readonly lifetime: AbortController
  readonly readiness: PromiseWithResolvers<string>
  readonly completion: PromiseWithResolvers<void>
  readonly workers: Set<number>
  waiters: number
  phase: 'authenticating' | 'ready' | 'closed'
  child: ChildProcessWithoutNullStreams | undefined
  challenge: SshAuthenticationChallengeId | undefined
  /** A remembered password was auto-submitted for this master; later password prompts are manual. */
  passwordTried: boolean
  /** The remembered password awaiting either rejection or readiness; dropped on any new password prompt. */
  autoUsed: string | undefined
  /** A remember-opted answer awaiting readiness before it is persisted; dropped on any subsequent prompt. */
  candidate: { password: string; nativeUser: string } | undefined
  /** A remembered-password lookup is deciding whether the prompt surfaces at all. */
  passwordLookup: boolean
}

interface PendingChallenge {
  readonly view: SshAuthenticationChallenge
  readonly master: Master
  readonly socket: Socket
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }

function diagnostic(stderr: string, fallback: string): string {
  const text = stderr.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim()
  return text === '' ? fallback : text.slice(0, 512)
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

/** Native authentication owner. Ready masters are cached only until this instance is disposed or their process exits. */
export class SshAuthentication {
  private readonly timeoutMs: number
  private readonly serverAliveIntervalSeconds: number
  private readonly serverAliveCountMax: number
  private readonly askpassPath: string
  private readonly sshPath: string
  private readonly passwordMemory: SshAuthenticationPasswordMemory | undefined
  private readonly masters = new Map<string, Master>()
  private readonly tokens = new Map<string, Master>()
  private readonly challenges = new Map<SshAuthenticationChallengeId, PendingChallenge>()
  private readonly listeners = new Set<() => void>()
  private readonly cleanupFailures: SshAuthenticationError[] = []
  private readonly settling = new Set<Promise<void>>()
  private resources: Promise<Resources> | undefined
  private version = 0
  private disposed = false
  private disposal: Promise<void> | undefined
  private failure: SshAuthenticationError | undefined

  constructor(options: SshAuthenticationOptions) {
    for (const field of ['timeoutMs', 'serverAliveIntervalSeconds', 'serverAliveCountMax'] as const) {
      const value = options[field]
      if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
        throw new RangeError(`SSH authentication ${field} must be an integer from 1 through 2147483647`)
      }
    }
    this.timeoutMs = options.timeoutMs
    this.serverAliveIntervalSeconds = options.serverAliveIntervalSeconds
    this.serverAliveCountMax = options.serverAliveCountMax
    this.askpassPath = options.askpassPath ?? fileURLToPath(new URL('./askpass.js', import.meta.url))
    this.sshPath = options.sshPath ?? 'ssh'
    this.passwordMemory = options.passwordMemory
  }

  /**
   * Authenticate once for the exact host, login, port, and identity-file fields.
   * @param input - already validated endpoint fields; empty login/key retain OpenSSH configuration and agent support.
   * @param signal - cancels this wait; the last pending waiter also terminates and joins its authentication process.
   * @returns endpoint fields plus a borrowed socket; consumers must never send this master an exit/stop command.
   * @throws SshAuthenticationError for bounded authentication/setup failure; native diagnostics are display-only.
   */
  async endpoint(input: SshEndpointArgs, signal: AbortSignal): Promise<SshEndpointArgs & { controlPath: string }> {
    signal.throwIfAborted()
    this.assertOpen()
    const endpoint = Object.freeze({ host: input.host, port: input.port, username: input.username, identityFile: input.identityFile })
    const key = JSON.stringify([endpoint.host, endpoint.username, endpoint.port, endpoint.identityFile])
    let master = this.masters.get(key)
    if (master !== undefined && (master.phase === 'closed' || master.lifetime.signal.aborted)) {
      await this.wait(master.completion.promise, signal)
      return this.endpoint(input, signal)
    }
    if (master === undefined) {
      master = this.createMaster(key, endpoint)
      this.masters.set(key, master)
      this.tokens.set(master.token, master)
      const owned = master
      void this.runMaster(owned).then(owned.completion.resolve, (error: unknown) => {
        const failure = error instanceof SshAuthenticationError ? error
          : new SshAuthenticationError('cleanup-failed', 'The SSH authentication process could not be fully released')
        this.cleanupFailures.push(failure)
        this.failure = failure
        if (this.masters.get(owned.key) === owned) this.masters.delete(owned.key)
        owned.readiness.reject(failure)
        owned.completion.resolve()
      })
    }
    master.waiters++
    try {
      const controlPath = await this.wait(master.readiness.promise, signal)
      signal.throwIfAborted()
      this.assertOpen()
      return { ...endpoint, controlPath }
    } finally {
      master.waiters--
      if (master.waiters === 0 && master.phase === 'authenticating') {
        master.lifetime.abort(new SshAuthenticationError('cancelled', 'SSH authentication was cancelled'))
        await master.completion.promise
      }
    }
  }

  /**
   * Follow coalesced snapshots of outstanding native prompts; no answers enter this stream.
   * @param signal - ends only this subscription; pending authentication retains its own deadline and owner.
   * @returns an initial snapshot followed by changes; disposal publishes an empty snapshot and ends the stream.
   */
  async *follow(signal: AbortSignal): AsyncGenerator<readonly SshAuthenticationChallenge[]> {
    let seen = -1
    while (!signal.aborted) {
      if (seen !== this.version) {
        seen = this.version
        yield Object.freeze([...this.challenges.values()].map(entry => entry.view))
        if (this.disposed) return
      }
      await new Promise<void>((resume) => {
        const changed = (): void => {
          this.listeners.delete(changed)
          signal.removeEventListener('abort', changed)
          resume()
        }
        this.listeners.add(changed)
        signal.addEventListener('abort', changed, { once: true })
        if (this.version !== seen || this.disposed || signal.aborted) changed()
      })
    }
  }

  /**
   * Consume one prompt exactly once. The owning authenticated UI decides who may invoke this method.
   * @param id - live challenge id from this instance; stale or another instance's ids are refused.
   * @param answer - one bounded native response, or null to cancel the entire pending authentication.
   * @param signal - an already cancelled submission has no effect.
   * @throws SshAuthenticationError for a stale challenge or invalid line/byte length; invalid input leaves it pending.
   */
  answer(id: SshAuthenticationChallengeId, answer: string | null, signal: AbortSignal): void {
    this.answerRemember(id, answer, false, signal)
  }

  /**
   * Consume one prompt exactly once and optionally hold the answer for a post-authentication durable write.
   * The candidate is held in memory only until readiness or rejection and never enters a diagnostic or the challenge stream.
   * @param id - live challenge id from this instance; stale or another instance's ids are refused.
   * @param answer - one bounded native response, or null to cancel the entire pending authentication.
   * @param remember - store this answer after authentication succeeds; refused unless the challenge itself said it is rememberable.
   * @param signal - an already cancelled submission has no effect.
   * @throws SshAuthenticationError for a stale challenge, invalid response, or non-rememberable prompt; invalid input leaves it pending.
   */
  answerRemember(id: SshAuthenticationChallengeId, answer: string | null, remember: boolean, signal: AbortSignal): void {
    signal.throwIfAborted()
    this.assertOpen()
    const pending = this.challenges.get(id)
    if (pending === undefined) throw new SshAuthenticationError('stale-challenge', 'The SSH prompt is no longer pending')
    if (!validAuthenticationAnswer(answer)) {
      throw new SshAuthenticationError('invalid-answer', 'The SSH response is too long or contains a line terminator')
    }
    const nativeUser = nativePasswordPromptUser(pending.view.prompt, pending.master.endpoint)
    if (answer !== null && remember && (!pending.view.canRemember || nativeUser === undefined)) {
      throw new SshAuthenticationError('not-rememberable', 'Only the target server password prompt can be remembered')
    }
    this.removeChallenge(pending)
    if (answer === null) {
      pending.master.lifetime.abort(new SshAuthenticationError('cancelled', 'SSH authentication was cancelled'))
      return
    }
    if (remember && nativeUser !== undefined) pending.master.candidate = { password: answer, nativeUser }
    pending.socket.end(`${JSON.stringify({ answer })}\n`)
  }

  /**
   * Stop admission, revoke prompts, kill owned process groups, and await processes/socket closure before deleting files.
   * @returns idempotent completion; cleanup failures reject rather than claiming the owned resources were released.
   */
  dispose(): Promise<void> {
    this.disposal ??= this.disposeOnce()
    return this.disposal
  }

  private assertOpen(): void {
    if (this.disposed) throw new SshAuthenticationError('disposed', 'The SSH authentication manager has closed')
    if (this.failure !== undefined) throw this.failure
  }

  private createMaster(key: string, endpoint: SshEndpointArgs): Master {
    const readiness = Promise.withResolvers<string>()
    // A cancelled last waiter still joins completion; suppress only the unused readiness rejection in that path.
    void readiness.promise.catch((error: unknown) => { void error })
    return {
      key, endpoint, token: randomBytes(32).toString('hex'), lifetime: new AbortController(),
      readiness, completion: Promise.withResolvers<void>(), workers: new Set(), waiters: 0,
      phase: 'authenticating', child: undefined, challenge: undefined,
      passwordTried: false, autoUsed: undefined, candidate: undefined,
      passwordLookup: false,
    }
  }

  private wait<T>(completion: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolveReady, reject) => {
      const aborted = (): void => {
        signal.removeEventListener('abort', aborted)
        const reason: unknown = signal.reason
        reject(reason instanceof Error ? reason : new SshAuthenticationError('cancelled', 'SSH authentication was cancelled'))
      }
      signal.addEventListener('abort', aborted, { once: true })
      void completion.then(resolveReady, reject).finally(() => {
        signal.removeEventListener('abort', aborted)
      })
      if (signal.aborted) aborted()
    })
  }

  private changed(): void {
    this.version++
    for (const listener of [...this.listeners]) listener()
  }

  private removeChallenge(pending: PendingChallenge): void {
    if (!this.challenges.delete(pending.view.id)) return
    pending.master.challenge = undefined
    this.changed()
  }

  private revoke(master: Master): void {
    this.tokens.delete(master.token)
    if (master.challenge === undefined) return
    const pending = this.challenges.get(master.challenge)
    if (pending === undefined) return
    this.removeChallenge(pending)
    pending.socket.destroy()
  }

  private async initialize(): Promise<Resources> {
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      throw new SshAuthenticationError('unsupported-platform', 'SSH authentication requires a POSIX Host')
    }
    try { await access(this.askpassPath, constants.R_OK) }
    catch (error: unknown) {
      void error
      throw new SshAuthenticationError('askpass-unavailable', 'The app-owned SSH authentication worker is missing or unreadable')
    }
    const parent = await realpath('/tmp')
    const root = await realpath(await mkdtemp(join(parent, 'hemi-ssh-auth-')))
    const server = createServer()
    const resources: Resources = {
      root, parent, server, socketPath: join(root, 'askpass'), wrapperPath: join(root, 'askpass.sh'), sockets: new Map(),
    }
    try {
      await chmod(root, 0o700)
      await writeFile(resources.wrapperPath,
        `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${quote(process.execPath)} --disable-sigusr1 ${quote(this.askpassPath)} "$@"\n`,
        { flag: 'wx', mode: 0o700 })
      server.on('connection', (socket) => { this.acceptWorker(resources, socket) })
      await new Promise<void>((listening, reject) => {
        server.once('error', reject)
        server.listen(resources.socketPath, () => { server.off('error', reject); listening() })
      })
      await chmod(resources.socketPath, 0o600)
      server.on('error', (error: Error) => {
        void error
        this.failure = new SshAuthenticationError('ipc-failed', 'The private SSH authentication channel failed')
        for (const master of this.masters.values()) master.lifetime.abort(this.failure)
      })
      return resources
    } catch (error: unknown) {
      await this.closeResources(resources)
      if (error instanceof SshAuthenticationError) throw error
      throw new SshAuthenticationError('ipc-failed', 'The private SSH authentication channel could not be opened')
    }
  }

  private acceptWorker(resources: Resources, socket: Socket): void {
    const closed = new Promise<void>((done) => { socket.once('close', () => { resources.sockets.delete(socket); done() }) })
    resources.sockets.set(socket, closed)
    socket.on('error', (error: Error) => { void error; socket.destroy() })
    if (this.disposed || resources.sockets.size > 32) { socket.destroy(); return }
    let incoming = Buffer.alloc(0)
    let consumed = false
    let pending: PendingChallenge | undefined
    const deadline = setTimeout(() => { socket.destroy() }, this.timeoutMs)
    socket.once('close', () => {
      clearTimeout(deadline)
      incoming.fill(0)
      if (pending !== undefined && this.challenges.has(pending.view.id)) {
        this.removeChallenge(pending)
        pending.master.lifetime.abort(new SshAuthenticationError('ipc-failed', 'The native SSH prompt closed before it was answered'))
      }
    })
    socket.on('data', (chunk: Buffer) => {
      if (consumed || incoming.length + chunk.length > MAX_AUTHENTICATION_FRAME_BYTES) { socket.destroy(); return }
      incoming = Buffer.concat([incoming, chunk])
      const newline = incoming.indexOf(10)
      if (newline === -1) return
      if (newline !== incoming.length - 1) { socket.destroy(); return }
      consumed = true
      let value: unknown
      try { value = JSON.parse(incoming.subarray(0, newline).toString('utf8')) }
      catch (error: unknown) { void error; socket.destroy(); return }
      const request = parseAskpassRequest(value)
      incoming.fill(0)
      incoming = Buffer.alloc(0)
      if (request === undefined) { socket.destroy(); return }
      const master = this.tokens.get(request.token)
      if (master === undefined || master.phase !== 'authenticating' || master.lifetime.signal.aborted
        || master.challenge !== undefined || master.passwordLookup
        || master.workers.has(request.pid) || master.workers.size >= 64) {
        socket.destroy()
        return
      }
      master.workers.add(request.pid)
      // A later prompt can mean another authentication mechanism; readiness alone cannot verify the earlier answer.
      master.candidate = undefined
      const memory = this.passwordMemory
      const nativeUser = memory !== undefined && request.hint === null
        ? nativePasswordPromptUser(request.prompt, master.endpoint) : undefined
      if (memory !== undefined && nativeUser !== undefined) {
        // A repeated target password prompt rejects the auto-used value; other prompt kinds do not establish rejection.
        if (master.autoUsed !== undefined) {
          const rejected = master.autoUsed
          master.autoUsed = undefined
          this.track(this.discardRemembered(memory, master.endpoint, rejected))
        }
        if (master.passwordTried) {
          pending = this.publish(master, request, socket, memory.canPersist(master.endpoint))
          return
        }
        master.passwordLookup = true
        this.track((async () => {
          let remembered: { nativeUser: string; password: string } | undefined
          try { remembered = await memory.lookup(master.endpoint) }
          catch (error: unknown) { void error /* A lookup failure reads as no remembered password; the prompt still surfaces. */ }
          master.passwordLookup = false
          if (this.disposed || master.phase !== 'authenticating' || master.lifetime.signal.aborted || !socket.writable) return
          if (remembered !== undefined && remembered.nativeUser === nativeUser) {
            master.passwordTried = true
            master.autoUsed = remembered.password
            socket.end(`${JSON.stringify({ answer: remembered.password })}\n`)
            return
          }
          pending = this.publish(master, request, socket, memory.canPersist(master.endpoint))
        })())
        return
      }
      pending = this.publish(master, request, socket, false)
    })
  }

  /** Admit one prompt to the challenge stream; the returned entry stays owned by the caller's socket. */
  private publish(
    master: Master, request: AskpassRequest, socket: Socket, canRemember: boolean,
  ): PendingChallenge {
    const id = brandString<SshAuthenticationChallengeId>(randomUUID())
    const view: SshAuthenticationChallenge = Object.freeze({
      id, endpoint: master.endpoint, prompt: request.prompt,
      kind: request.hint === 'confirm' ? 'confirm' : request.hint === 'none' ? 'notification' : 'input',
      canRemember,
    })
    const pending: PendingChallenge = { view, master, socket }
    master.challenge = id
    this.challenges.set(id, pending)
    this.changed()
    return pending
  }

  /** Drop a stored password a later native prompt proved wrong; a different stored value stays untouched. */
  private async discardRemembered(memory: SshAuthenticationPasswordMemory, endpoint: SshEndpointArgs, password: string): Promise<void> {
    try { await memory.discard(endpoint, password) }
    catch (error: unknown) { void error /* Rejection cleanup is best-effort; the manual prompt proceeds regardless. */ }
  }

  /**
   * Persist one remember-opted answer after OpenSSH accepted it, then release readiness.
   * A failed durable write fails the waiting callers with a typed remember failure and releases the ready master;
   * the authentication itself already succeeded, so a retry starts a fresh, clean authentication.
   */
  private async commitRemembered(
    master: Master, controlPath: string, memory: SshAuthenticationPasswordMemory,
    candidate: { nativeUser: string; password: string },
  ): Promise<void> {
    try {
      await memory.persist(master.endpoint, candidate.nativeUser, candidate.password)
      if (!master.lifetime.signal.aborted) master.readiness.resolve(controlPath)
    } catch (error: unknown) {
      // The store's own failure text stays inside the credentials seam; only the structured reason travels.
      master.lifetime.abort(new SshAuthenticationError('remember-failed', rememberFailureReasonOf(error)))
    }
  }

  private track(operation: Promise<void>): void {
    this.settling.add(operation)
    void operation.then(() => { this.settling.delete(operation) }, () => {
      this.settling.delete(operation)
      this.failure = new SshAuthenticationError('ipc-failed', 'SSH authentication could not process a native prompt')
      for (const master of this.masters.values()) master.lifetime.abort(this.failure)
    })
  }

  private environment(resources: Resources, master: Master): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (!/KEY|SECRET|TOKEN|PASSWORD/i.test(key)
        && !/^(NODE_OPTIONS|NODE_PATH|SSH_ASKPASS(?:_.*)?|HEMI_SSH_AUTH_.*)$/i.test(key)) env[key] = value
    }
    return {
      ...env, SSH_ASKPASS: resources.wrapperPath, SSH_ASKPASS_REQUIRE: 'force',
      HEMI_SSH_AUTH_SOCKET: resources.socketPath, HEMI_SSH_AUTH_TOKEN: master.token,
      HEMI_SSH_AUTH_TIMEOUT_MS: String(this.timeoutMs),
    }
  }

  private kill(master: Master): void {
    this.revoke(master)
    const child = master.child
    if (child?.pid === undefined) return
    try { process.kill(-child.pid, 'SIGKILL') }
    catch (error: unknown) {
      if (errorCode(error) !== 'ESRCH') {
        this.cleanupFailures.push(new SshAuthenticationError('cleanup-failed', 'The SSH authentication process group could not be terminated'))
        child.kill('SIGKILL')
      }
    }
  }

  private async runMaster(master: Master): Promise<void> {
    const lifetime = master.lifetime.signal
    let failure = new SshAuthenticationError('unavailable', 'OpenSSH closed before authentication was ready')
    let controlPath: string | undefined
    let closed: Promise<void> | undefined
    const kill = (): void => { this.kill(master) }
    const deadline = setTimeout(() => {
      master.lifetime.abort(new SshAuthenticationError('timeout', 'SSH authentication exceeded its configured deadline'))
    }, this.timeoutMs)
    lifetime.addEventListener('abort', kill, { once: true })
    try {
      this.resources ??= this.initialize()
      const resources = await this.resources
      lifetime.throwIfAborted()
      this.assertOpen()
      const masterControlPath = join(resources.root, `m-${randomBytes(8).toString('hex')}`)
      controlPath = masterControlPath
      const marker = `hemi-auth-${randomBytes(32).toString('hex')}`
      const child = spawn(this.sshPath, [
        '-T', '-M', '-S', masterControlPath, '-o', 'ControlMaster=yes', '-o', 'ControlPersist=no',
        '-o', 'BatchMode=no', '-o', 'StrictHostKeyChecking=ask', '-o', 'UpdateHostKeys=no',
        '-o', 'NoHostAuthenticationForLocalhost=no',
        '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'ClearAllForwardings=yes',
        '-o', 'PermitLocalCommand=no', '-o', 'ForkAfterAuthentication=no', '-o', 'StdinNull=no',
        '-o', 'SessionType=default', '-o', 'RemoteCommand=none',
        '-o', `ServerAliveInterval=${String(this.serverAliveIntervalSeconds)}`,
        '-o', `ServerAliveCountMax=${String(this.serverAliveCountMax)}`,
        ...master.endpoint.username === '' ? [] : ['-l', master.endpoint.username],
        '-p', String(master.endpoint.port), ...master.endpoint.identityFile === '' ? [] : ['-i', master.endpoint.identityFile],
        '--', master.endpoint.host, `printf '%s\\n' ${quote(marker)}; exec cat >/dev/null`,
      ], { detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: this.environment(resources, master) })
      master.child = child
      let stderr = ''
      let stdout = ''
      let outputBytes = 0
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4096) })
      child.stdin.on('error', (error: Error) => { void error })
      child.once('error', (error: Error) => {
        void error
        master.lifetime.abort(new SshAuthenticationError('unavailable', 'The OpenSSH client could not be started'))
      })
      closed = new Promise<void>((done) => {
        child.once('close', (exitCode, signal) => {
          failure = new SshAuthenticationError('unavailable', diagnostic(stderr, 'OpenSSH disconnected'), exitCode, signal)
          done()
        })
      })
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        if (master.phase !== 'authenticating' || lifetime.aborted) return
        outputBytes += Buffer.byteLength(chunk)
        if (outputBytes > MAX_AUTHENTICATION_FRAME_BYTES) {
          master.lifetime.abort(new SshAuthenticationError('unavailable', 'The authentication readiness response exceeded its byte limit'))
          return
        }
        stdout += chunk
        if (!stdout.split('\n').some(line => line === marker)) return
        if (master.challenge !== undefined || master.passwordLookup) {
          master.lifetime.abort(new SshAuthenticationError('ipc-failed', 'SSH became ready with an unanswered authentication prompt'))
          return
        }
        master.phase = 'ready'
        clearTimeout(deadline)
        this.tokens.delete(master.token)
        const candidate = master.candidate
        master.candidate = undefined
        master.autoUsed = undefined
        if (candidate !== undefined && this.passwordMemory !== undefined) {
          this.track(this.commitRemembered(master, masterControlPath, this.passwordMemory, candidate))
          return
        }
        master.readiness.resolve(masterControlPath)
      })
      if (lifetime.aborted) kill()
      await closed
    } catch (error: unknown) {
      failure = error instanceof SshAuthenticationError ? error
        : new SshAuthenticationError('unavailable', 'SSH authentication could not be initialized')
    } finally {
      clearTimeout(deadline)
      if (lifetime.aborted && lifetime.reason instanceof SshAuthenticationError) failure = lifetime.reason
      master.candidate = undefined
      master.autoUsed = undefined
      this.kill(master)
      await closed
      lifetime.removeEventListener('abort', kill)
      master.phase = 'closed'
      if (controlPath !== undefined) {
        const resources = await this.resources
        if (resources === undefined || dirname(controlPath) !== resources.root || !basename(controlPath).startsWith('m-')) {
          throw new SshAuthenticationError('cleanup-failed', 'Refusing to remove an unowned SSH control socket')
        }
        try { await unlink(controlPath) }
        catch (error: unknown) { if (errorCode(error) !== 'ENOENT') throw error }
      }
      if (this.masters.get(master.key) === master) this.masters.delete(master.key)
      master.readiness.reject(failure)
    }
  }

  private async closeResources(resources: Resources): Promise<void> {
    const serverClosed = resources.server.listening ? new Promise<void>((done, reject) => {
      resources.server.close((error) => { if (error) reject(error); else done() })
    }) : Promise.resolve()
    const sockets = [...resources.sockets.entries()]
    for (const [socket] of sockets) socket.destroy()
    await Promise.all([serverClosed, ...sockets.map(([, closed]) => closed)])
    const actual = await realpath(resources.root)
    const metadata = await lstat(resources.root)
    if (actual !== resources.root || resolve(resources.root) !== resources.root || dirname(actual) !== resources.parent
      || !basename(actual).startsWith('hemi-ssh-auth-') || !metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new SshAuthenticationError('cleanup-failed', 'Refusing to remove a replaced SSH authentication directory')
    }
    await rm(actual, { recursive: true, force: true })
  }

  private async disposeOnce(): Promise<void> {
    this.disposed = true
    const masters = [...this.masters.values()]
    for (const master of masters) {
      master.lifetime.abort(new SshAuthenticationError('disposed', 'The SSH authentication manager has closed'))
    }
    this.changed()
    await Promise.all(masters.map(master => master.completion.promise))
    // Queued durable writes of already-accepted answers complete or fail typed before the owner releases its resources.
    await Promise.allSettled([...this.settling])
    if (this.resources !== undefined) {
      let resources: Resources | undefined
      try { resources = await this.resources }
      catch (error: unknown) { void error /* Initialization already released its partial resources and failed the caller. */ }
      if (resources !== undefined) await this.closeResources(resources)
    }
    const cleanupFailure = this.cleanupFailures[0]
    if (cleanupFailure !== undefined) throw cleanupFailure
  }
}
