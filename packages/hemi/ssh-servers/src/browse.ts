/** Read-only remote directory inspection over one-shot OpenSSH commands; no helper or remote runtime is involved. */
import { execFile, spawn } from 'node:child_process'
import { posix } from 'node:path'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SshServerInput } from './types.ts'

/** Deadline for each single OpenSSH command; connection setup is included. */
const COMMAND_TIMEOUT_MS = 30_000
/** Bounded stdout for directory listings and probe replies. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
/** OpenSSH reports its own reachability, authentication and host-key failures with this exit status. */
const SSH_TRANSPORT_EXIT = 255

/** Explicit endpoint fields the saved editor also persists; secrets are never accepted. */
export type SshEndpointArgs = Pick<SshServerInput, 'host' | 'port' | 'username' | 'identityFile'> & {
  /** Ephemeral authenticated master, never part of saved connection or target data. */
  readonly controlPath?: string
}

/** A remotely executed command refused; the OpenSSH transport itself worked. */
export class RemoteCommandError extends Error {
  constructor(readonly exitCode: number, readonly reason: string) {
    super(`Remote command failed (${exitCode}): ${reason}`)
    this.name = 'RemoteCommandError'
  }
}

function endpointOptions(endpoint: SshEndpointArgs): string[] {
  if (endpoint.username !== '' && endpoint.host.includes('@')) {
    throw new RemoteError('hemi-ssh/invalid-input', 'Enter the login name in its own field', { field: 'username' })
  }
  return [
    '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no',
    ...endpoint.controlPath === undefined ? [] : ['-S', endpoint.controlPath, '-o', 'ControlMaster=no', '-o', 'ProxyCommand=false'],
    '-o', 'ClearAllForwardings=yes', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3',
    ...endpoint.username === '' ? [] : ['-l', endpoint.username],
    '-p', String(endpoint.port),
    ...endpoint.identityFile === '' ? [] : ['-i', endpoint.identityFile],
  ]
}

/**
 * Single-quote a value for the remote POSIX shell.
 * @param value - literal text inserted into a fixed command; embedded quotes are escaped.
 * @returns the quoted shell word.
 */
export function quoteRemote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }

/** One ssh diagnostic line, bounded and stripped of control characters. */
function reasonOf(stderr: unknown): string {
  const text = typeof stderr === 'string' ? stderr : ''
  const line = text.split(/\r?\n/).find(candidate => candidate.trim() !== '') ?? ''
  return line.replace(/\p{Cc}/gu, ' ').trim().slice(0, 300)
}

function classifyTransport(endpoint: SshEndpointArgs, fallback: string, stderr: unknown): RemoteError {
  const reason = reasonOf(stderr)
  return new RemoteError('hemi-ssh/ssh-unavailable', 'Check the SSH endpoint, authentication and known-host trust', {
    host: endpoint.host, reason: reason === '' ? fallback : reason,
  })
}

/**
 * Run one remote command and return its stdout.
 * @param endpoint - saved connection fields; never a secret.
 * @param command - fixed POSIX shell program; caller-supplied values are shell-quoted by the caller.
 * @param signal - caller cancellation; kills the local ssh client.
 * @returns the complete stdout bytes.
 * @throws RemoteError `hemi-ssh/ssh-unavailable` when OpenSSH cannot reach/authenticate the endpoint, or the command times out.
 * @throws RemoteCommandError when the command ran remotely and exited nonzero.
 */
export function sshExec(endpoint: SshEndpointArgs, command: string, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted()
  return new Promise<Buffer>((resolve, reject) => {
    execFile('ssh', [...endpointOptions(endpoint), endpoint.host, command], {
      signal, maxBuffer: MAX_OUTPUT_BYTES, timeout: COMMAND_TIMEOUT_MS, killSignal: 'SIGKILL',
    }, (error, stdout, stderr) => {
      if (error === null) { resolve(Buffer.from(stdout)); return }
      if (signal.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new Error('SSH command cancelled'))
        return
      }
      if (error.killed) { reject(classifyTransport(endpoint, 'SSH command timed out', stderr)); return }
      if (error.code === SSH_TRANSPORT_EXIT) { reject(classifyTransport(endpoint, error.message, stderr)); return }
      if (typeof error.code === 'number') { reject(new RemoteCommandError(error.code, reasonOf(stderr))); return }
      reject(classifyTransport(endpoint, error.message, stderr))
    })
  })
}

/**
 * Run one remote command with bytes written to its stdin; same failure mapping as {@link sshExec}.
 * @param endpoint - saved connection fields.
 * @param command - fixed POSIX shell program.
 * @param input - exact bytes the remote command reads from stdin.
 * @param signal - caller cancellation; kills the local ssh client after which the exit is awaited.
 */
export function sshStream(endpoint: SshEndpointArgs, command: string, input: Buffer, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    const child = spawn('ssh', [...endpointOptions(endpoint), endpoint.host, command], { stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    let settled = false
    let timedOut = false
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8192) })
    const kill = (): void => { child.kill('SIGKILL') }
    signal.addEventListener('abort', kill, { once: true })
    // A hung transport or remote reader must not hold the caller forever.
    const deadline = setTimeout(() => { timedOut = true; kill() }, COMMAND_TIMEOUT_MS)
    const settle = (failed: boolean, exitCode: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      signal.removeEventListener('abort', kill)
      if (!failed) { resolve(); return }
      if (signal.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new Error('SSH command cancelled'))
        return
      }
      if (timedOut) { reject(classifyTransport(endpoint, 'SSH command timed out', stderr)); return }
      if (exitCode === SSH_TRANSPORT_EXIT) { reject(classifyTransport(endpoint, 'ssh failed', stderr)); return }
      if (exitCode !== null) { reject(new RemoteCommandError(exitCode, reasonOf(stderr))); return }
      reject(classifyTransport(endpoint, 'ssh failed to start', stderr))
    }
    child.once('error', () => { if (!signal.aborted && !settled) settle(true, null) })
    child.once('close', (code) => { settle(code !== 0, code) })
    // A remote refusal closes the channel while bytes are still queued; the ignored write
    // failure is expected and the command's exit status settles this promise.
    const ignoreStdinError = (error: Error): void => { void error }
    child.stdin.on('error', ignoreStdinError)
    child.stdin.end(input)
  })
}

/**
 * Resolve the remote login directory reported by the remote shell, without symlink aliases.
 * @param endpoint - saved connection fields.
 * @param signal - caller cancellation.
 * @returns the absolute physical remote home directory.
 */
export async function resolveRemoteHome(endpoint: SshEndpointArgs, signal: AbortSignal): Promise<string> {
  const output = (await sshExec(endpoint, 'cd -- "$HOME" && pwd -P', signal)).toString('utf8')
  const home = output.trim()
  if (home === '' || !posix.isAbsolute(home) || home.includes('\0')) {
    throw new RemoteError('hemi-ssh/remote-directory-unavailable', 'The remote login directory is not usable', {
      host: endpoint.host, path: '', reason: 'empty or relative HOME',
    })
  }
  return home
}

/**
 * List immediate subdirectories of one remote directory and report its physical location.
 * @param endpoint - saved connection fields.
 * @param path - existing absolute remote directory; symlinked paths resolve to their physical target.
 * @param signal - caller cancellation.
 * @returns the physical directory and its subdirectories; symlinked subdirectories are included.
 * @throws RemoteError `hemi-ssh/remote-directory-unavailable` when the directory cannot be entered or listed.
 */
export async function listRemoteDirectories(
  endpoint: SshEndpointArgs, path: string, signal: AbortSignal,
): Promise<{ path: string; parentPath: string; directories: { name: string; path: string }[] }> {
  signal.throwIfAborted()
  const output = await sshExec(
    endpoint,
    `cd ${quoteRemote(path)} && p=$(pwd -P) && printf '%s\\0' "$p" && find -L "$p" -mindepth 1 -maxdepth 1 -type d -print0`,
    signal,
  ).catch((error: unknown) => {
    if (error instanceof RemoteCommandError) {
      throw new RemoteError('hemi-ssh/remote-directory-unavailable', 'The remote folder cannot be listed', {
        host: endpoint.host, path, reason: error.reason === '' ? `exit ${error.exitCode}` : error.reason,
      })
    }
    throw error
  })
  const parts = output.toString('utf8').split('\0')
  const physical = parts[0] ?? ''
  if (physical === '' || !posix.isAbsolute(physical)) {
    throw new RemoteError('hemi-ssh/remote-directory-unavailable', 'The remote folder cannot be listed', {
      host: endpoint.host, path, reason: 'the remote path did not resolve physically',
    })
  }
  const directories = parts.slice(1)
    .filter(entry => entry !== '')
    .map(entry => posix.normalize(entry))
    .map(entry => ({ name: posix.basename(entry), path: entry }))
    .sort((one, two) => one.name.localeCompare(two.name))
  return { path: physical, parentPath: posix.dirname(physical), directories }
}

/**
 * Whether one absolute POSIX path lies inside another, including equality, without symlink resolution.
 * @param parent - candidate containing directory.
 * @param child - candidate contained path.
 * @returns true when `child` equals or lies under `parent`; the root directory contains every path.
 */
export function containsPath(parent: string, child: string): boolean {
  const relative = posix.relative(parent, child)
  return relative === '' || (relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative))
}
