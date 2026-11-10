/** Real-process askpass, single-use ownership, cancellation, and teardown without contacting any external SSH endpoint. */
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SshAuthentication, SshAuthenticationError } from '../src/authentication.ts'
import type { SshAuthenticationChallenge } from '../src/authentication-types.ts'
import type { SshEndpointArgs } from '../src/browse.ts'
import type {} from '../src/workspace-types.ts'
import { createAuthenticationTransport, type AuthenticationScenario } from './support/authentication-transport.ts'

const askpassPath = fileURLToPath(new URL('../src/askpass.ts', import.meta.url))
const endpoint: SshEndpointArgs = { host: 'fixture.example', port: 2202, username: 'fixture-user', identityFile: '/fixture/key' }
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  vi.useRealTimers()
  try { for (const cleanup of cleanups.reverse()) await cleanup() }
  finally { cleanups.length = 0; vi.unstubAllEnvs() }
})

async function fixture(timeoutMs = 30_000): Promise<{
  auth: SshAuthentication
  transport: Awaited<ReturnType<typeof createAuthenticationTransport>>
}> {
  const transport = await createAuthenticationTransport()
  cleanups.push(() => transport.close())
  const auth = new SshAuthentication({
    timeoutMs, serverAliveIntervalSeconds: 10, serverAliveCountMax: 3, askpassPath, sshPath: transport.sshPath,
  })
  cleanups.push(() => auth.dispose())
  return { auth, transport }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false
    throw error
  }
}

function observed<T>(operation: Promise<T>): Promise<T> {
  // Assertion failure still disposes the owner; its resulting operation rejection must remain observed.
  void operation.catch((error: unknown) => { void error })
  return operation
}

async function challenge(stream: AsyncGenerator<readonly SshAuthenticationChallenge[]>): Promise<SshAuthenticationChallenge> {
  for (;;) {
    const next = await stream.next()
    if (next.done) throw new Error('Authentication challenge stream ended')
    if (next.value[0] !== undefined) return next.value[0]
  }
}

async function sendRaw(path: string, frame: string | Buffer): Promise<void> {
  const socket = createConnection(path)
  const closed = new Promise<void>((resolve) => { socket.once('close', () => { resolve() }) })
  socket.on('error', () => { socket.destroy() })
  socket.once('connect', () => { socket.write(frame) })
  await closed
}

it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])('rejects invalid native liveness settings: %s', (value) => {
  for (const field of ['serverAliveIntervalSeconds', 'serverAliveCountMax'] as const) {
    const options = { timeoutMs: 1000, serverAliveIntervalSeconds: 10, serverAliveCountMax: 3, [field]: value }
    expect(() => new SshAuthentication(options)).toThrow(RangeError)
    expect(() => new SshAuthentication(options)).toThrow(field)
  }
})

it.each([1, 2_147_483_647])('accepts inclusive native liveness bounds: %s', async (value) => {
  const auth = new SshAuthentication({ timeoutMs: 1000, serverAliveIntervalSeconds: value, serverAliveCountMax: value })
  await auth.dispose()
})

// Unix sockets, executable wrappers, and process-group signals are POSIX-owned semantics.
describe.skipIf(process.platform === 'win32')('OpenSSH authentication ownership', () => {
  it('passes configured native liveness settings to its owned OpenSSH process', async () => {
    const transport = await createAuthenticationTransport()
    cleanups.push(() => transport.close())
    const auth = new SshAuthentication({
      timeoutMs: 30_000, serverAliveIntervalSeconds: 7, serverAliveCountMax: 2, askpassPath, sshPath: transport.sshPath,
    })
    cleanups.push(() => auth.dispose())
    const connected = transport.connection({ ready: true, prompts: [] })
    const pending = observed(auth.endpoint(endpoint, new AbortController().signal))
    const connection = await connected
    const started = await connection.next('started')
    expect(started.argv).toContain('ServerAliveInterval=7')
    expect(started.argv).toContain('ServerAliveCountMax=2')
    expect(started.argv).not.toContain('ServerAliveInterval=10')
    expect(started.argv).not.toContain('ServerAliveCountMax=3')
    await pending
  })

  it('uses native hints, accepts each answer once, shares only its ready master, and joins disposal', async () => {
    vi.stubEnv('HEMI_TEST_PASSWORD', 'must-not-reach-ssh')
    vi.stubEnv('SSH_AUTH_SOCK', '/fixture/agent-socket')
    const { auth, transport } = await fixture()
    const follow = auth.follow(new AbortController().signal)
    expect((await follow.next()).value).toEqual([])
    const scenario: AuthenticationScenario = { ready: true, prompts: [
      { prompt: '服务器的原生问题：', hint: null, expected: 'fixture-password' },
      { prompt: 'Native permission', hint: 'confirm', expected: 'yes' },
      { prompt: 'Native notification', hint: 'none', expected: '' },
    ] }
    const connected = transport.connection(scenario)
    const first = observed(auth.endpoint({ ...endpoint, controlPath: '/never-publish-this' }, new AbortController().signal))
    const second = observed(auth.endpoint(endpoint, new AbortController().signal))
    const connection = await connected
    const started = await connection.next('started')
    expect(started.leakedEnvironment).toEqual([])
    expect(started.agentSocket).toBe('/fixture/agent-socket')
    for (const argument of ['StrictHostKeyChecking=ask', 'UpdateHostKeys=no', 'BatchMode=no', 'ControlPersist=no', 'ForwardAgent=no']) {
      expect(started.argv).toContain(argument)
    }
    expect(started.argv).not.toContain('-f')
    const expectedKinds = ['input', 'confirm', 'notification'] as const
    for (let index = 0; index < scenario.prompts.length; index++) {
      const worker = await connection.next('worker')
      const prompt = await challenge(follow)
      expect(prompt.kind).toBe(expectedKinds[index])
      expect(prompt.prompt).toBe(scenario.prompts[index]!.prompt)
      expect(prompt.endpoint).toEqual(endpoint)
      expect('controlPath' in prompt.endpoint).toBe(false)
      auth.answer(prompt.id, scenario.prompts[index]!.expected, new AbortController().signal)
      expect(() => { auth.answer(prompt.id, 'stale', new AbortController().signal) }).toThrow(expect.objectContaining({ code: 'stale-challenge' }))
      expect(await connection.next('reply')).toMatchObject({ code: 0, signal: null, matched: true, stderrEmpty: true })
      expect(alive(worker.pid)).toBe(false)
    }
    const ready = await first
    expect(await second).toEqual(ready)
    expect(await auth.endpoint(endpoint, new AbortController().signal)).toEqual(ready)
    expect(existsSync(ready.controlPath)).toBe(true)
    expect(alive(started.pid)).toBe(true)
    expect((await stat(dirname(ready.controlPath))).mode & 0o777).toBe(0o700)
    expect((await stat(started.wrapper)).mode & 0o777).toBe(0o700)
    expect((await stat(started.authSocket)).mode & 0o777).toBe(0o600)
    const empty = await follow.next()
    expect(empty.value).toEqual([])
    expect(JSON.stringify(empty.value)).not.toContain('fixture-password')
    const disposal = auth.dispose()
    expect(auth.dispose()).toBe(disposal)
    await disposal
    await connection.closed
    expect(alive(started.pid)).toBe(false)
    expect(existsSync(dirname(ready.controlPath))).toBe(false)
    expect((await follow.next()).done).toBe(true)
  })

  it('refuses cross-manager ids and cancels independent same-endpoint connections without stale replies', async () => {
    const one = await fixture()
    const two = await fixture()
    const scenario = { ready: true, prompts: [{ prompt: 'Password:', hint: null, expected: 'unused' }] }
    const connectedOne = one.transport.connection(scenario)
    const connectedTwo = two.transport.connection(scenario)
    const first = observed(one.auth.endpoint(endpoint, new AbortController().signal))
    const second = observed(two.auth.endpoint(endpoint, new AbortController().signal))
    const connectionOne = await connectedOne
    const connectionTwo = await connectedTwo
    const streamOne = one.auth.follow(new AbortController().signal)
    const streamTwo = two.auth.follow(new AbortController().signal)
    const promptOne = await challenge(streamOne)
    const promptTwo = await challenge(streamTwo)
    expect(promptOne.id).not.toBe(promptTwo.id)
    expect(() => { two.auth.answer(promptOne.id, 'wrong-owner', new AbortController().signal) }).toThrow(expect.objectContaining({ code: 'stale-challenge' }))
    const workerOne = await connectionOne.next('worker')
    const workerTwo = await connectionTwo.next('worker')
    one.auth.answer(promptOne.id, null, new AbortController().signal)
    two.auth.answer(promptTwo.id, null, new AbortController().signal)
    await expect(first).rejects.toMatchObject({ code: 'cancelled' })
    await expect(second).rejects.toMatchObject({ code: 'cancelled' })
    expect(() => { one.auth.answer(promptOne.id, 'late', new AbortController().signal) }).toThrow(expect.objectContaining({ code: 'stale-challenge' }))
    expect(alive(workerOne.pid)).toBe(false)
    expect(alive(workerTwo.pid)).toBe(false)
    await streamOne.return(undefined)
    await streamTwo.return(undefined)
  })

  it('keeps another waiter alive when one caller aborts, then releases the last pending owner', async () => {
    const { auth, transport } = await fixture()
    const controller = new AbortController()
    const connected = transport.connection({ ready: true, prompts: [{ prompt: 'Response:', hint: null, expected: 'ok' }] })
    const first = observed(auth.endpoint(endpoint, controller.signal))
    const second = observed(auth.endpoint(endpoint, new AbortController().signal))
    const connection = await connected
    const started = await connection.next('started')
    const stream = auth.follow(new AbortController().signal)
    const prompt = await challenge(stream)
    const reason = new Error('Caller left')
    controller.abort(reason)
    await expect(first).rejects.toBe(reason)
    expect(alive(started.pid)).toBe(true)
    auth.answer(prompt.id, 'ok', new AbortController().signal)
    await second
    await stream.return(undefined)

    const another = new AbortController()
    const nextConnection = transport.connection({ ready: true, prompts: [{ prompt: 'Cancel me', hint: null, expected: null }] })
    const third = observed(auth.endpoint({ ...endpoint, port: endpoint.port + 1 }, another.signal))
    const native = await nextConnection
    const child = await native.next('started')
    const worker = await native.next('worker')
    const nextStream = auth.follow(new AbortController().signal)
    const nextPrompt = await challenge(nextStream)
    another.abort(reason)
    await expect(third).rejects.toBe(reason)
    expect(alive(child.pid)).toBe(false)
    expect(alive(worker.pid)).toBe(false)
    expect(() => { auth.answer(nextPrompt.id, 'late', new AbortController().signal) }).toThrow(expect.objectContaining({ code: 'stale-challenge' }))
    await nextStream.return(undefined)
  })

  it('checks complete UTF-8 answer limits and aborted submissions without consuming the prompt', async () => {
    const { auth, transport } = await fixture()
    const response = '界'.repeat(1365) + 'a'
    const connected = transport.connection({ ready: true, prompts: [{ prompt: 'Input', hint: 'unrecognized', expected: response }] })
    const pending = observed(auth.endpoint(endpoint, new AbortController().signal))
    const connection = await connected
    const stream = auth.follow(new AbortController().signal)
    const prompt = await challenge(stream)
    expect(prompt.kind).toBe('input')
    for (const invalid of [`${response}b`, 'one\ntwo', 'one\rtwo', 'one\0two']) {
      expect(() => { auth.answer(prompt.id, invalid, new AbortController().signal) }).toThrow(expect.objectContaining({ code: 'invalid-answer' }))
    }
    const cancelled = new AbortController()
    cancelled.abort(new Error('Submission cancelled'))
    expect(() => { auth.answer(prompt.id, response, cancelled.signal) }).toThrow('Submission cancelled')
    auth.answer(prompt.id, response, new AbortController().signal)
    expect(await connection.next('reply')).toMatchObject({ matched: true, code: 0, signal: null })
    await pending
    await stream.return(undefined)
  })

  it('rejects forged, duplicate, malformed, and oversized worker frames without replacing the real prompt', async () => {
    const { auth, transport } = await fixture()
    const connected = transport.connection({ ready: true, prompts: [{ prompt: 'Owned prompt', hint: null, expected: 'ok' }] })
    const pending = observed(auth.endpoint(endpoint, new AbortController().signal))
    const connection = await connected
    const started = await connection.next('started')
    const worker = await connection.next('worker')
    const stream = auth.follow(new AbortController().signal)
    const prompt = await challenge(stream)
    const request = { token: started.token, pid: worker.pid, prompt: 'Cannot replace', hint: null }
    for (const frame of [
      'not-json\n', '{}\n', `${JSON.stringify({ ...request, token: '0'.repeat(64) })}\n`,
      `${JSON.stringify(request)}\n`, `${JSON.stringify({ ...request, pid: worker.pid + 1 })}\n`,
      `${JSON.stringify(request)}\ntrailing`, Buffer.alloc(128 * 1024 + 1, 120),
    ]) await sendRaw(started.authSocket, frame)
    auth.answer(prompt.id, 'ok', new AbortController().signal)
    expect(await connection.next('reply')).toMatchObject({ matched: true, code: 0, signal: null })
    await pending
    await stream.return(undefined)
  })

  it('bounds authentication across every prompt and removes workers on deadline', async () => {
    vi.useFakeTimers()
    const { auth, transport } = await fixture()
    const connected = transport.connection({ ready: true, prompts: [{ prompt: 'Never answered', hint: null, expected: null }] })
    const pending = observed(auth.endpoint(endpoint, new AbortController().signal))
    const connection = await connected
    const started = await connection.next('started')
    const worker = await connection.next('worker')
    const stream = auth.follow(new AbortController().signal)
    const prompt = await challenge(stream)
    await vi.advanceTimersByTimeAsync(30_000)
    await expect(pending).rejects.toMatchObject({ code: 'timeout' })
    expect(alive(started.pid)).toBe(false)
    expect(alive(worker.pid)).toBe(false)
    expect(() => { auth.answer(prompt.id, 'late', new AbortController().signal) }).toThrow(expect.objectContaining({ code: 'stale-challenge' }))
    vi.useRealTimers()
    await stream.return(undefined)
  })

  it('keeps native failures display-only, preserves exit facts, and does not cache failed authentication', async () => {
    const { auth, transport } = await fixture()
    for (const stderr of ['fixture-user@fixture: Permission denied (publickey,password).\n', '\u001b[31mConnection refused\u0007\n']) {
      const connected = transport.connection({ ready: false, prompts: [], stderr, exitCode: 255 })
      const result = observed(auth.endpoint(endpoint, new AbortController().signal))
      await connected
      const failure: unknown = await result.catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(SshAuthenticationError)
      expect(failure).toMatchObject({ code: 'unavailable', exitCode: 255, signal: null })
      expect((failure as SshAuthenticationError).reason).not.toMatch(/[\p{Cc}\p{Cf}]/u)
    }
    const connected = transport.connection({ ready: true, prompts: [] })
    const ready = observed(auth.endpoint(endpoint, new AbortController().signal))
    await connected
    expect((await ready).controlPath).toContain('/m-')
  })

  it('ends follow on subscription cancellation and refuses work after owner shutdown', async () => {
    const { auth } = await fixture()
    const cancelled = new AbortController()
    const stream = auth.follow(cancelled.signal)
    expect((await stream.next()).value).toEqual([])
    const waiting = stream.next()
    cancelled.abort()
    expect((await waiting).done).toBe(true)
    await auth.dispose()
    await expect(auth.endpoint(endpoint, new AbortController().signal)).rejects.toMatchObject({ code: 'disposed' })
    const ended = auth.follow(new AbortController().signal)
    expect((await ended.next()).value).toEqual([])
    expect((await ended.next()).done).toBe(true)
  })

  it('fails clearly when the packaged worker or OpenSSH executable is missing', async () => {
    const missingWorker = new SshAuthentication({
      timeoutMs: 1000, serverAliveIntervalSeconds: 10, serverAliveCountMax: 3, askpassPath: '/missing-owned-worker',
    })
    cleanups.push(() => missingWorker.dispose())
    await expect(missingWorker.endpoint(endpoint, new AbortController().signal)).rejects.toMatchObject({ code: 'askpass-unavailable' })
    const missingSsh = new SshAuthentication({
      timeoutMs: 1000, serverAliveIntervalSeconds: 10, serverAliveCountMax: 3, askpassPath, sshPath: '/missing-owned-openssh',
    })
    cleanups.push(() => missingSsh.dispose())
    await expect(missingSsh.endpoint(endpoint, new AbortController().signal)).rejects.toMatchObject({ code: 'unavailable' })
    expect(() => new SshAuthentication({ timeoutMs: 0, serverAliveIntervalSeconds: 10, serverAliveCountMax: 3 })).toThrow(RangeError)
  })
})
