/** Native OpenSSH password authentication and host trust against an owned password-only loopback SSH server. */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SshAuthentication } from '../src/authentication.ts'
import type { SshAuthenticationChallenge } from '../src/authentication-types.ts'
import { listRemoteDirectories, resolveRemoteHome, type SshEndpointArgs } from '../src/browse.ts'
import type {} from '../src/workspace-types.ts'
import { createPasswordSshFixture, type PasswordSshFixture } from './support/password-ssh.ts'

const run = promisify(execFile)
const askpassPath = fileURLToPath(new URL('../src/askpass.ts', import.meta.url))
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  try { for (const cleanup of cleanups.reverse()) await cleanup() }
  finally { cleanups.length = 0; vi.unstubAllEnvs() }
})

async function setup(trustHost = false): Promise<{
  server: PasswordSshFixture
  auth: SshAuthentication
  endpoint: SshEndpointArgs
}> {
  const server = await createPasswordSshFixture({ trustHost })
  cleanups.push(() => server.close())
  const auth = new SshAuthentication({
    timeoutMs: 30_000, serverAliveIntervalSeconds: 10, serverAliveCountMax: 3, askpassPath, sshPath: server.sshPath,
  })
  cleanups.push(() => auth.dispose())
  vi.stubEnv('PATH', `${server.bin}:${process.env.PATH ?? '/usr/bin:/bin'}`)
  return { server, auth, endpoint: { host: server.host, port: server.port, username: server.username, identityFile: '' } }
}

async function nextPrompt(stream: AsyncGenerator<readonly SshAuthenticationChallenge[]>): Promise<SshAuthenticationChallenge> {
  for (;;) {
    const next = await stream.next()
    if (next.done) throw new Error('Native SSH prompt stream ended')
    if (next.value[0] !== undefined) return next.value[0]
  }
}

function observed<T>(operation: Promise<T>): Promise<T> {
  void operation.catch((error: unknown) => { void error /* Owner disposal also settles operations after failed assertions. */ })
  return operation
}

// The fixture needs POSIX shell processes and the platform's real OpenSSH client, not a user account password.
describe.skipIf(process.platform === 'win32' || !existsSync('/usr/bin/ssh'))('native password authentication', () => {
  it('requires first-host consent, authenticates a password, and reuses one master for ordinary directory commands', async () => {
    const { server, auth, endpoint } = await setup()
    await mkdir(join(server.home, 'project'))
    const stream = auth.follow(new AbortController().signal)
    const pending = observed(auth.endpoint(endpoint, new AbortController().signal))
    const trust = await nextPrompt(stream)
    expect(trust.prompt).toContain('SHA256:')
    // Native host-trust prompts omit SSH_ASKPASS_PROMPT; input must not be interpreted as a password classification.
    expect(trust.kind).toBe('input')
    expect(server.stats()).toMatchObject({ passwordAttempts: 0, acceptedPasswords: 0, executions: 0 })
    expect(await readFile(server.knownHosts, 'utf8')).toBe('')
    auth.answer(trust.id, 'yes', new AbortController().signal)
    const password = await nextPrompt(stream)
    expect(password.id).not.toBe(trust.id)
    expect(password.kind).toBe('input')
    auth.answer(password.id, server.password, new AbortController().signal)
    const ready = await pending
    expect(await readFile(server.knownHosts, 'utf8')).toContain(server.hostPublicKey)
    expect(await resolveRemoteHome(ready, new AbortController().signal)).toBe(server.home)
    expect(await listRemoteDirectories(ready, server.home, new AbortController().signal)).toEqual({
      path: server.home, parentPath: server.root,
      directories: [{ name: 'project', path: join(server.home, 'project') }],
    })
    const pwd = await run(server.sshPath, ['-T', '-S', ready.controlPath, '-o', 'ControlMaster=no',
      '-o', 'ProxyCommand=false', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '--', server.host, 'pwd -P'])
    expect(pwd.stdout.trim()).toBe(server.home)
    expect(await auth.endpoint(endpoint, new AbortController().signal)).toEqual(ready)
    expect(server.stats()).toMatchObject({ connections: 1, passwordAttempts: 1, acceptedPasswords: 1, executions: 4 })
    expect((await stream.next()).value).toEqual([])
    await auth.dispose()
    await server.close()
    expect(server.stats()).toMatchObject({ activeConnections: 0, activeProcesses: 0 })
    expect(existsSync(server.root)).toBe(false)
    expect(existsSync(ready.controlPath)).toBe(false)
    expect((await stream.next()).done).toBe(true)
  }, 30_000)

  it('reports native password rejection, accepts a fresh retry, and never reuses the rejected prompt id', async () => {
    const { server, auth, endpoint } = await setup(true)
    const stream = auth.follow(new AbortController().signal)
    const rejected = observed(auth.endpoint(endpoint, new AbortController().signal))
    let stale: SshAuthenticationChallenge | undefined
    for (let attempt = 0; attempt < 3; attempt++) {
      const prompt = await nextPrompt(stream)
      stale = prompt
      auth.answer(prompt.id, 'not-the-fixture-password', new AbortController().signal)
    }
    await expect(rejected).rejects.toMatchObject({ code: 'unavailable', exitCode: 255, signal: null })
    expect(server.stats()).toMatchObject({ passwordAttempts: 3, acceptedPasswords: 0, executions: 0 })
    const retried = observed(auth.endpoint(endpoint, new AbortController().signal))
    const prompt = await nextPrompt(stream)
    expect(prompt.id).not.toBe(stale!.id)
    expect(() => { auth.answer(stale!.id, server.password, new AbortController().signal) })
      .toThrow(expect.objectContaining({ code: 'stale-challenge' }))
    auth.answer(prompt.id, server.password, new AbortController().signal)
    const ready = await retried
    expect(await resolveRemoteHome(ready, new AbortController().signal)).toBe(server.home)
    expect(server.stats()).toMatchObject({ connections: 2, passwordAttempts: 4, acceptedPasswords: 1 })
    await stream.return(undefined)
  }, 30_000)

  it('cancels host trust and password prompts independently, then permits a new owned attempt', async () => {
    const { server, auth, endpoint } = await setup()
    const stream = auth.follow(new AbortController().signal)
    const untrusted = observed(auth.endpoint(endpoint, new AbortController().signal))
    auth.answer((await nextPrompt(stream)).id, null, new AbortController().signal)
    await expect(untrusted).rejects.toMatchObject({ code: 'cancelled' })
    expect(await readFile(server.knownHosts, 'utf8')).toBe('')
    expect(server.stats().passwordAttempts).toBe(0)

    const cancelledPassword = observed(auth.endpoint(endpoint, new AbortController().signal))
    auth.answer((await nextPrompt(stream)).id, 'yes', new AbortController().signal)
    auth.answer((await nextPrompt(stream)).id, null, new AbortController().signal)
    await expect(cancelledPassword).rejects.toMatchObject({ code: 'cancelled' })
    expect(server.stats().acceptedPasswords).toBe(0)
    expect(await readFile(server.knownHosts, 'utf8')).toContain(server.hostPublicKey)

    const retried = observed(auth.endpoint(endpoint, new AbortController().signal))
    auth.answer((await nextPrompt(stream)).id, server.password, new AbortController().signal)
    expect(await resolveRemoteHome(await retried, new AbortController().signal)).toBe(server.home)
    expect(server.stats().acceptedPasswords).toBe(1)
    await stream.return(undefined)
  }, 30_000)

  it('fails changed host keys closed without asking for a password or rewriting known-host trust', async () => {
    const { server, auth, endpoint } = await setup()
    const other = await createPasswordSshFixture()
    cleanups.push(() => other.close())
    const changed = `[${server.host}]:${server.port} ${other.hostPublicKey}\n`
    await writeFile(server.knownHosts, changed)
    await expect(auth.endpoint(endpoint, new AbortController().signal)).rejects.toMatchObject({ code: 'unavailable', exitCode: 255 })
    expect(await readFile(server.knownHosts, 'utf8')).toBe(changed)
    expect(server.stats()).toMatchObject({ passwordAttempts: 0, acceptedPasswords: 0, executions: 0 })
    const stream = auth.follow(new AbortController().signal)
    expect((await stream.next()).value).toEqual([])
    await stream.return(undefined)
  }, 30_000)
})
