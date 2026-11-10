/** Owned ssh2 password endpoint for real OpenSSH/GUI tests; no OS accounts, PAM, or user SSH files are used. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Server, utils, type Connection } from 'ssh2'

/** Externally observable transport/session counts without credentials or command contents. */
export interface PasswordSshStats {
  readonly connections: number
  readonly activeConnections: number
  readonly passwordAttempts: number
  readonly acceptedPasswords: number
  readonly executions: number
  readonly activeProcesses: number
}

/** One private password-only SSH server, client configuration, and fake credentials owned by the test. */
export interface PasswordSshFixture {
  readonly root: string
  readonly home: string
  readonly host: '127.0.0.1'
  readonly port: number
  readonly username: string
  /** Test-only input, unrelated to every account on the Host. Never use an operator's password in this fixture. */
  readonly password: string
  readonly knownHosts: string
  readonly hostPublicKey: string
  readonly clientConfig: string
  readonly sshPath: string
  readonly bin: string
  /** Snapshot live resources and authentication attempts without exposing responses. */
  stats(): PasswordSshStats
  /** Disconnect and join current clients and session processes while leaving the owned listener available for reconnection. */
  disconnect(): Promise<void>
  /** Stop admission, terminate and join every session process and connection, then remove the verified private root. */
  close(): Promise<void>
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }
function configQuote(value: string): string { return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"` }
function gone(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ESRCH' }

/**
 * Start an independently allocated loopback server whose shell children stay in its private home/temp environment.
 * @param options - pretrust the owned host when true; otherwise OpenSSH must request first-host confirmation.
 * @returns the endpoint, private OpenSSH wrapper, test-only credential, and idempotent quiescent cleanup.
 */
export async function createPasswordSshFixture(options: { trustHost?: boolean } = {}): Promise<PasswordSshFixture> {
  const parent = await realpath('/tmp')
  const root = await realpath(await mkdtemp(join(parent, 'hemi-password-ssh-')))
  const home = join(root, 'home')
  const temp = join(root, 'tmp')
  const bin = join(root, 'bin')
  const username = 'hemi-fixture'
  const password = 'owned-loopback-fixture-password'
  const host = '127.0.0.1'
  const connections = new Map<Connection, Promise<void>>()
  const children = new Map<ChildProcessWithoutNullStreams, Promise<void>>()
  let totalConnections = 0
  let passwordAttempts = 0
  let acceptedPasswords = 0
  let executions = 0
  let closing: Promise<void> | undefined
  const privateKey = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  }).privateKey
  const parsed = utils.parseKey(privateKey)
  if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('Could not parse the owned SSH host key')
  const hostPublicKey = `${parsed.type} ${parsed.getPublicSSH().toString('base64')}`
  const terminating = new WeakSet<ChildProcessWithoutNullStreams>()
  const gracefulDisconnect = new WeakSet<ChildProcessWithoutNullStreams>()
  const kill = (child: ChildProcessWithoutNullStreams): void => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null || terminating.has(child)) return
    try { process.kill(-child.pid, 'SIGKILL') }
    catch (error: unknown) { if (!gone(error)) throw error }
    // Disconnect and stream-close can both request termination before the child's close event.
    terminating.add(child)
  }
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    totalConnections++
    const closed = new Promise<void>((resolve) => { client.once('close', () => { connections.delete(client); resolve() }) })
    connections.set(client, closed)
    client.on('error', () => { client.end() })
    if (closing !== undefined) { client.end(); return }
    client.on('authentication', (context) => {
      if (context.method !== 'password') { context.reject(['password']); return }
      passwordAttempts++
      if (context.username !== username || context.password !== password) { context.reject(['password']); return }
      acceptedPasswords++
      context.accept()
    })
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('exec', (acceptCommand, rejectCommand, info) => {
          if (closing !== undefined) { rejectCommand(); return }
          const stream = acceptCommand()
          executions++
          const child = spawn('/bin/sh', ['-c', info.command], {
            cwd: home, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
            env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, TMPDIR: temp, USER: username, LOGNAME: username, SHELL: '/bin/sh' },
          })
          const completed = new Promise<void>((resolve) => {
            child.once('close', (code) => {
              children.delete(child)
              if (!stream.destroyed) { stream.exit(code ?? 255); stream.end() }
              resolve()
            })
          })
          children.set(child, completed)
          child.once('error', () => { stream.exit(255); stream.end() })
          child.stdin.on('error', (error: Error) => { void error /* Session closure and the process exit determine the outcome. */ })
          const disconnected = (): void => {
            if (gracefulDisconnect.has(child)) child.stdin.end()
            else kill(child)
          }
          stream.on('error', disconnected)
          stream.once('close', disconnected)
          stream.pipe(child.stdin)
          child.stdout.pipe(stream, { end: false })
          child.stderr.pipe(stream.stderr, { end: false })
        })
      })
    })
  })
  server.on('error', (error: Error) => { void error /* Listen failures reject setup; accepted connections own their errors. */ })
  const disconnect = async (force = false): Promise<void> => {
    const clients = [...connections.entries()]
    const processes = [...children.entries()]
    for (const [child] of processes) {
      if (force) { gracefulDisconnect.delete(child); kill(child) }
      else {
        // Transport loss closes stdin; the fixture's directory commands and retained `exec cat` then exit naturally.
        gracefulDisconnect.add(child)
        child.stdin.end()
      }
    }
    for (const [client] of clients) client.end()
    await Promise.all([...clients.map(([, closed]) => closed), ...processes.map(([, done]) => done)])
  }
  const close = (): Promise<void> => closing ??= (async () => {
    const listenerClosed = server.listening ? new Promise<void>((resolve) => { server.close(() => { resolve() }) }) : Promise.resolve()
    await Promise.all([listenerClosed, disconnect(true)])
    const actual = await realpath(root)
    if (actual !== root || dirname(actual) !== parent || !basename(actual).startsWith('hemi-password-ssh-')) {
      throw new Error('Refusing to remove a replaced password SSH fixture')
    }
    await rm(actual, { recursive: true, force: true })
  })()
  try {
    await Promise.all([mkdir(home), mkdir(temp), mkdir(bin)])
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error): void => { reject(error) }
      server.once('error', failed)
      server.listen(0, host, () => { server.off('error', failed); resolve() })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('The password SSH fixture did not allocate a loopback port')
    const port = address.port
    const knownHosts = join(root, 'known-hosts')
    await writeFile(knownHosts, options.trustHost === true ? `[${host}]:${port} ${hostPublicKey}\n` : '', { flag: 'wx', mode: 0o600 })
    const clientConfig = join(root, 'ssh.conf')
    await writeFile(clientConfig, [
      'Host *', `  User ${username}`, `  Port ${port}`,
      `  UserKnownHostsFile ${configQuote(knownHosts)}`, '  GlobalKnownHostsFile /dev/null',
      '  StrictHostKeyChecking ask', '  UpdateHostKeys no', '  IdentityAgent none', '  PubkeyAuthentication no',
      '  PasswordAuthentication yes', '  KbdInteractiveAuthentication no', '  PreferredAuthentications password',
      '  NumberOfPasswordPrompts 3', '  ForwardAgent no', '  AddKeysToAgent no', '  LogLevel ERROR',
    ].join('\n') + '\n', { flag: 'wx', mode: 0o600 })
    const sshPath = join(bin, 'ssh')
    await writeFile(sshPath, `#!/bin/sh\nexec /usr/bin/ssh -F ${shellQuote(clientConfig)} "$@"\n`, { flag: 'wx', mode: 0o700 })
    return {
      root, home, host, port, username, password, knownHosts, hostPublicKey, clientConfig, sshPath, bin, disconnect, close,
      stats: () => ({ connections: totalConnections, activeConnections: connections.size,
        passwordAttempts, acceptedPasswords, executions, activeProcesses: children.size }),
    }
  } catch (error: unknown) {
    await close()
    throw error
  }
}
