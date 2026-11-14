/** Owned inetd-mode OpenSSH endpoint for real POSIX transport tests; no user SSH files are modified. */
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createServer, type Socket } from 'node:net'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** One private SSH server and the operator-owned client settings reaching it. */
export interface OpenSshFixture {
  readonly root: string
  readonly host: string
  readonly port: number
  readonly username: string
  readonly identityFile: string
  readonly clientConfig: string
  readonly bin: string
  /** Bounded diagnostics from the owned inetd children. */
  diagnostics(): string
  /** Switch transport availability and join disconnected clients when going offline. */
  setOnline(online: boolean): Promise<void>
  /** Stop admission, disconnect sockets, join owned processes, and remove the verified private root. */
  close(): Promise<void>
}

function quoteShell(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }
function quoteConfig(value: string): string { return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"` }

/**
 * Start a nonprivileged real sshd per accepted loopback connection, with private keys and known-host trust.
 * @param options - extra session environment; values under the fixture root are created as directories,
 *   so automatic remote caches and login directories stay inside the owned tree.
 * @returns the listening endpoint and idempotent quiescent cleanup.
 */
export async function createOpenSshFixture(options: { env?: Record<string, string> } = {}): Promise<OpenSshFixture> {
  const parent = await realpath(tmpdir())
  const root = await realpath(await mkdtemp(join(parent, 'hemi-openssh-')))
  const username = userInfo().username
  const server = createServer({ pauseOnConnect: true })
  const sockets = new Set<Socket>()
  const children = new Map<ChildProcess, Promise<void>>()
  let output = ''
  let online = true
  let closing: Promise<void> | undefined
  const diagnostic = (value: string): void => { output = (output + value).slice(-64 * 1024) }
  server.on('error', (error) => { diagnostic(`listener: ${error.message}\n`) })

  const close = (): Promise<void> => closing ??= (async () => {
    const listenerClosed = server.listening
      ? new Promise<void>((resolveClosed, reject) => {
        server.close((error) => { if (error) reject(error); else resolveClosed() })
      })
      : Promise.resolve()
    for (const socket of sockets) socket.destroy()
    for (const child of children.keys()) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await Promise.all([listenerClosed, ...children.values()])
    const actual = await realpath(root)
    if (actual !== root || resolve(root) !== root || dirname(root) !== parent || !basename(root).startsWith('hemi-openssh-')) {
      throw new Error(`Refusing to remove a replaced SSH fixture directory: ${root}`)
    }
    await rm(actual, { recursive: true, force: true })
  })()

  try {
    const hostKey = join(root, 'host-key')
    const identityFile = join(root, 'client-key')
    await run('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey])
    await run('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', identityFile])
    const authorized = join(root, 'authorized-keys')
    await writeFile(authorized, await readFile(`${identityFile}.pub`), { mode: 0o600 })
    const config = join(root, 'sshd.conf')
    const bin = join(root, 'bin')
    await mkdir(bin)
    // sshd honors only the first obtained SetEnv directive, so extra assignments join this one line.
    const sessionEnv: Record<string, string> = { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin` }
    for (const [key, raw] of Object.entries(options.env ?? {})) {
      sessionEnv[key] = raw.replaceAll('${root}', root)
    }
    for (const value of Object.values(sessionEnv)) {
      if (value.startsWith(`${root}/`)) await mkdir(value, { recursive: true }).catch(() => {})
    }
    await writeFile(config, [
      `HostKey ${quoteConfig(hostKey)}`,
      `AuthorizedKeysFile ${quoteConfig(authorized)}`,
      `PidFile ${quoteConfig(join(root, 'sshd.pid'))}`,
      `AllowUsers ${username}`,
      'StrictModes no', 'UsePAM no', 'UseDNS no', 'PasswordAuthentication no',
      'KbdInteractiveAuthentication no', 'PermitRootLogin no', 'PubkeyAuthentication yes',
      'PermitUserRC no', 'PermitUserEnvironment no', 'AllowAgentForwarding no',
      'AllowStreamLocalForwarding no', 'AllowTcpForwarding no', 'LogLevel ERROR',
      `SetEnv ${Object.entries(sessionEnv).map(([key, value]) => `${key}=${value}`).join(' ')}`,
    ].join('\n') + '\n', { mode: 0o600 })
    await run('/usr/sbin/sshd', ['-t', '-f', config])
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('error', (error) => { diagnostic(`socket: ${error.message}\n`) })
      if (!online || closing !== undefined) { sockets.delete(socket); socket.destroy(); return }
      socket.once('close', () => { sockets.delete(socket) })
      const child = spawn('/usr/sbin/sshd', ['-i', '-e', '-f', config], { stdio: [socket, socket, 'pipe'] })
      const closed = new Promise<void>((resolveClosed) => {
        child.once('error', (error) => { diagnostic(`sshd: ${error.message}\n`); socket.destroy() })
        child.once('close', () => { children.delete(child); socket.destroy(); resolveClosed() })
      })
      children.set(child, closed)
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => { diagnostic(chunk) })
      child.once('spawn', () => { socket.destroy() })
    })
    await new Promise<void>((resolveListening, reject) => {
      const failed = (error: Error): void => { reject(error) }
      server.once('error', failed)
      server.listen(0, '127.0.0.1', () => { server.off('error', failed); resolveListening() })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('OpenSSH fixture did not allocate a loopback port')
    const port = address.port
    const hostPublic = (await readFile(`${hostKey}.pub`, 'utf8')).trim().split(/\s+/).slice(0, 2).join(' ')
    const knownHosts = join(root, 'known-hosts')
    await writeFile(knownHosts, `[127.0.0.1]:${port} ${hostPublic}\n`, { mode: 0o600 })
    const clientConfig = join(root, 'ssh.conf')
    await writeFile(clientConfig, [
      'Host *', `  User ${username}`, `  Port ${port}`, `  IdentityFile ${quoteConfig(identityFile)}`,
      `  UserKnownHostsFile ${quoteConfig(knownHosts)}`, '  GlobalKnownHostsFile /dev/null',
      '  IdentityAgent none', '  IdentitiesOnly yes', '  StrictHostKeyChecking yes', '  BatchMode yes',
      '  PasswordAuthentication no', '  KbdInteractiveAuthentication no', '  ForwardAgent no', '  LogLevel ERROR',
    ].join('\n') + '\n', { mode: 0o600 })
    await writeFile(join(bin, 'ssh'), `#!/bin/sh\nexec /usr/bin/ssh -F ${quoteShell(clientConfig)} "$@"\n`, { mode: 0o700 })
    return {
      root, host: '127.0.0.1', port, username, identityFile, clientConfig, bin, diagnostics: () => output,
      setOnline: async (next) => {
        online = next
        if (next) return
        for (const socket of sockets) socket.destroy()
        for (const child of children.keys()) child.kill('SIGTERM')
        await Promise.all(children.values())
      },
      close,
    }
  } catch (error: unknown) {
    await close()
    throw error
  }
}
