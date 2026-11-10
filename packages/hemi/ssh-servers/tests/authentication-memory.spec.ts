/** Opt-in password remembering over the authentication owner: reuse once, manual fallback, candidate, and typed failures. */
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { SshAuthentication } from '../src/authentication.ts'
import type { SshAuthenticationChallenge } from '../src/authentication-types.ts'
import type { SshEndpointArgs } from '../src/browse.ts'
import {
  canonicalSshEndpoint, type SshAuthenticationPasswordMemory, type SshPasswordEndpoint,
} from '../src/remembered-passwords.ts'
import {
  createAuthenticationTransport, type AuthenticationScenario, type AuthenticationTransportConnection,
} from './support/authentication-transport.ts'

const askpassPath = fileURLToPath(new URL('../src/askpass.ts', import.meta.url))
const endpoint: SshEndpointArgs = { host: 'fixture.example', port: 2202, username: 'fixture-user', identityFile: '/fixture/key' }
const passwordPrompt = (user: string, host = endpoint.host): string => `${user}@${host}'s password: `
const otherPrompts = [
  'Verification code: ',
  "Enter passphrase for key '/fixture/key': ",
  passwordPrompt('fixture-user', 'jump.example.com'),
] as const

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  try { for (const cleanup of cleanups.reverse()) await cleanup() }
  finally { cleanups.length = 0 }
})

/** File-backed password memory double: one shared store survives across authentication owners like a restart would. */
function memory(stored = new Map<string, { nativeUser: string; password: string }>()): {
  readonly store: SshAuthenticationPasswordMemory
  readonly saved: Map<string, { nativeUser: string; password: string }>
  readonly persisted: { endpoint: SshPasswordEndpoint; nativeUser: string; password: string }[]
  readonly discarded: { endpoint: SshPasswordEndpoint; password: string }[]
  lookupCalls: number
  failPersist: boolean
  canPersistFlag: boolean
} {
  const persisted: { endpoint: SshPasswordEndpoint; nativeUser: string; password: string }[] = []
  const discarded: { endpoint: SshPasswordEndpoint; password: string }[] = []
  let lookupCalls = 0
  let failPersist = false
  let canPersistFlag = true
  const store: SshAuthenticationPasswordMemory = {
    async lookup(endpoint) {
      lookupCalls++
      return stored.get(canonicalSshEndpoint(endpoint))
    },
    async persist(endpoint, nativeUser, password) {
      if (failPersist) throw new Error('EACCES: .credentials.yaml')
      persisted.push({ endpoint, nativeUser, password })
      stored.set(canonicalSshEndpoint(endpoint), { nativeUser, password })
    },
    async discard(endpoint, password) {
      discarded.push({ endpoint, password })
      if (stored.get(canonicalSshEndpoint(endpoint))?.password === password) {
        stored.delete(canonicalSshEndpoint(endpoint))
      }
    },
    canPersist: (endpoint) => {
      void endpoint
      return canPersistFlag
    },
  }
  return {
    store, saved: stored, persisted, discarded,
    get lookupCalls() { return lookupCalls },
    get failPersist() { return failPersist },
    set failPersist(value) { failPersist = value },
    get canPersistFlag() { return canPersistFlag },
    set canPersistFlag(value) { canPersistFlag = value },
  }
}

function fixture(options: { memory?: SshAuthenticationPasswordMemory } = {}): Promise<{
  auth: SshAuthentication
  connect: (scenario: AuthenticationScenario) => Promise<AuthenticationTransportConnection>
}> {
  return (async () => {
    const transport = await createAuthenticationTransport()
    cleanups.push(() => transport.close())
    const auth = new SshAuthentication({
      timeoutMs: 30_000, serverAliveIntervalSeconds: 10, serverAliveCountMax: 3, askpassPath, sshPath: transport.sshPath,
      ...options.memory === undefined ? {} : { passwordMemory: options.memory },
    })
    cleanups.push(() => auth.dispose())
    return { auth, connect: scenario => transport.connection(scenario) }
  })()
}

/** Every published challenge plus an event-driven barrier on their count; no polling, no sleeps. */
function collect(auth: SshAuthentication): {
  challenges: SshAuthenticationChallenge[]
  until(count: number): Promise<void>
  stop(): Promise<void>
} {
  const controller = new AbortController()
  const challenges: SshAuthenticationChallenge[] = []
  const waiting: Array<() => void> = []
  let finished = false
  const done = (async () => {
    try {
      for await (const batch of auth.follow(controller.signal)) {
        challenges.push(...batch)
        for (const release of waiting.splice(0)) release()
      }
    } finally {
      finished = true
      for (const release of waiting.splice(0)) release()
    }
  })()
  void done.catch((error: unknown) => { void error })
  return {
    challenges,
    until: async (count: number): Promise<void> => {
      for (;;) {
        if (challenges.length >= count) return
        if (finished) throw new Error(`Challenge stream ended with ${challenges.length} of ${count} prompts`)
        await new Promise<void>((release) => { waiting.push(release) })
      }
    },
    stop: async (): Promise<void> => {
      controller.abort()
      await done
    },
  }
}

function observed<T>(operation: Promise<T>): Promise<T> {
  void operation.catch((error: unknown) => { void error })
  return operation
}

// Unix sockets, executable wrappers, and process-group signals are POSIX-owned semantics.
describe.skipIf(process.platform === 'win32')('remembered passwords in authentication', () => {
  it('keeps remembering off without a credential store', async () => {
    const { auth, connect } = await fixture()
    const view = collect(auth)
    const pending = observed(auth.endpoint(endpoint, new AbortController().signal))
    const connection = await connect({ ready: true, prompts: [{ prompt: passwordPrompt('fixture-user'), hint: null, expected: 'pw' }] })
    await connection.next('worker')
    await view.until(1)
    const challenge = view.challenges[0]
    expect(challenge?.canRemember).toBe(false)
    expect(() => { auth.answerRemember(challenge!.id, 'pw', true, new AbortController().signal) })
      .toThrow(expect.objectContaining({ code: 'not-rememberable' }))
    auth.answer(challenge!.id, 'pw', new AbortController().signal)
    expect((await connection.next('reply')).matched).toBe(true)
    await pending
    await view.stop()
  })

  it('answers the first target password prompt from memory, then reuses the store across owners', async () => {
    const records = memory()
    records.saved.set(canonicalSshEndpoint(endpoint), { nativeUser: 'fixture-user', password: 'stored-pw' })
    const first = await fixture({ memory: records.store })
    const view = collect(first.auth)
    const pending = observed(first.auth.endpoint(endpoint, new AbortController().signal))
    const connection = await first.connect({
      ready: true, prompts: [{ prompt: passwordPrompt('fixture-user'), hint: null, expected: 'stored-pw' }],
    })
    // The reply proves the prompt was consumed without any challenge being published.
    await connection.next('worker')
    const consumed = await connection.next('reply')
    expect(consumed.matched).toBe(true)
    // Readiness resolving also proves no prompt was left unanswered.
    await pending
    expect(view.challenges).toEqual([])
    expect(records.persisted).toEqual([])
    await view.stop()
    await first.auth.dispose()

    // A fresh owner over the same store behaves like a restart: still no prompt, still no new write.
    const second = await fixture({ memory: records.store })
    const reuse = observed(second.auth.endpoint(endpoint, new AbortController().signal))
    const repeat = await second.connect({
      ready: true, prompts: [{ prompt: passwordPrompt('fixture-user'), hint: null, expected: 'stored-pw' }],
    })
    expect((await repeat.next('reply')).matched).toBe(true)
    await reuse
    expect(records.lookupCalls).toBeGreaterThanOrEqual(2)
  })

  it('falls back to one manual prompt and discards the rejected remembered password', async () => {
    const records = memory()
    records.saved.set(canonicalSshEndpoint(endpoint), { nativeUser: 'fixture-user', password: 'wrong' })
    const { auth, connect } = await fixture({ memory: records.store })
    const view = collect(auth)
    const pending = observed(auth.endpoint(endpoint, new AbortController().signal))
    const connection = await connect({ ready: true, prompts: [
      { prompt: passwordPrompt('fixture-user'), hint: null, expected: 'wrong' },
      { prompt: passwordPrompt('fixture-user'), hint: null, expected: 'fresh' },
    ] })
    await connection.next('worker')
    expect((await connection.next('reply')).matched).toBe(true)
    expect(view.challenges).toEqual([])
    await connection.next('worker')
    await view.until(1)
    const manual = view.challenges[0]
    expect(manual?.canRemember).toBe(true)
    auth.answerRemember(manual!.id, 'fresh', true, new AbortController().signal)
    expect((await connection.next('reply')).matched).toBe(true)
    await pending
    expect(records.discarded).toEqual([{ endpoint, password: 'wrong' }])
    expect(records.saved.get(canonicalSshEndpoint(endpoint))).toEqual({ nativeUser: 'fixture-user', password: 'fresh' })
    expect(records.persisted).toEqual([{ endpoint, nativeUser: 'fixture-user', password: 'fresh' }])
    await view.stop()
  })

  it('drops a remember candidate when a new password prompt arrives', async () => {
    const records = memory()
    const { auth, connect } = await fixture({ memory: records.store })
    const view = collect(auth)
    const pending = observed(auth.endpoint(endpoint, new AbortController().signal))
    const connection = await connect({ ready: true, prompts: [
      { prompt: passwordPrompt('fixture-user'), hint: null, expected: 'bad' },
      { prompt: passwordPrompt('fixture-user'), hint: null, expected: 'good' },
    ] })
    await connection.next('worker')
    await view.until(1)
    expect(view.challenges[0]?.canRemember).toBe(true)
    auth.answerRemember(view.challenges[0]!.id, 'bad', true, new AbortController().signal)
    await connection.next('reply')
    await connection.next('worker')
    await view.until(2)
    auth.answer(view.challenges[1]!.id, 'good', new AbortController().signal)
    expect((await connection.next('reply')).matched).toBe(true)
    await pending
    expect(records.persisted).toEqual([])
    expect(records.saved.size).toBe(0)
    await view.stop()
  })

  it('drops a remember candidate when a one-time prompt intervenes before readiness', async () => {
    const records = memory()
    const { auth, connect } = await fixture({ memory: records.store })
    const view = collect(auth)
    const pending = observed(auth.endpoint(endpoint, new AbortController().signal))
    const connection = await connect({ ready: true, prompts: [
      { prompt: passwordPrompt('fixture-user'), hint: null, expected: 'pw' },
      { prompt: 'Verification code: ', hint: null, expected: '123456' },
    ] })
    await connection.next('worker')
    await view.until(1)
    expect(view.challenges[0]?.canRemember).toBe(true)
    auth.answerRemember(view.challenges[0]!.id, 'pw', true, new AbortController().signal)
    await connection.next('reply')
    await connection.next('worker')
    await view.until(2)
    expect(view.challenges[1]?.canRemember).toBe(false)
    auth.answer(view.challenges[1]!.id, '123456', new AbortController().signal)
    expect((await connection.next('reply')).matched).toBe(true)
    await pending
    expect(records.persisted).toEqual([])
    expect(records.saved.size).toBe(0)
    await view.stop()
  })

  it('fails the awaiting connection typed when the durable write fails after ready', async () => {
    const records = memory()
    records.failPersist = true
    const { auth, connect } = await fixture({ memory: records.store })
    const view = collect(auth)
    const pending = observed(auth.endpoint(endpoint, new AbortController().signal))
    const connection = await connect({ ready: true, prompts: [{ prompt: passwordPrompt('fixture-user'), hint: null, expected: 'pw' }] })
    await connection.next('worker')
    await view.until(1)
    auth.answerRemember(view.challenges[0]!.id, 'pw', true, new AbortController().signal)
    await expect(pending).rejects.toMatchObject({ code: 'remember-failed', reason: 'credentials-write' })
    expect(records.saved.size).toBe(0)
    await connection.closed
    await view.stop()
  })

  it('stores nothing for cancelled or failed authentication', async () => {
    const records = memory()
    const cancelled = await fixture({ memory: records.store })
    const view = collect(cancelled.auth)
    const stopping = observed(cancelled.auth.endpoint(endpoint, new AbortController().signal))
    const connection = await cancelled.connect({ ready: true, prompts: [{ prompt: passwordPrompt('fixture-user'), hint: null, expected: null }] })
    await connection.next('worker')
    await view.until(1)
    cancelled.auth.answerRemember(view.challenges[0]!.id, null, true, new AbortController().signal)
    await expect(stopping).rejects.toMatchObject({ code: 'cancelled' })
    await view.stop()

    const failing = await fixture({ memory: records.store })
    const refused = observed(failing.auth.endpoint(endpoint, new AbortController().signal))
    const failureConnection = await failing.connect({ ready: false, prompts: [], stderr: 'Permission denied\n', exitCode: 255 })
    await failureConnection.closed
    await expect(refused).rejects.toMatchObject({ code: 'unavailable', exitCode: 255 })
    expect(records.persisted).toEqual([])
    expect(records.saved.size).toBe(0)
  })

  it('never remembers, auto-answers, or even looks up other prompts', async () => {
    const records = memory()
    records.saved.set(canonicalSshEndpoint(endpoint), { nativeUser: 'fixture-user', password: 'stored-pw' })
    const { auth, connect } = await fixture({ memory: records.store })
    const view = collect(auth)
    const prompts = [
      { prompt: 'Allow connection?', hint: 'confirm', expected: 'yes' },
      { prompt: 'Notice', hint: 'none', expected: '' },
      ...otherPrompts.map(prompt => ({ prompt, hint: null, expected: 'manual' })),
    ]
    const pending = observed(auth.endpoint(endpoint, new AbortController().signal))
    const connection = await connect({ ready: true, prompts })
    for (let index = 0; index < prompts.length; index++) {
      await connection.next('worker')
      await view.until(index + 1)
      const challenge = view.challenges[index]
      expect(challenge?.canRemember).toBe(false)
      expect(() => { auth.answerRemember(challenge!.id, 'manual', true, new AbortController().signal) })
        .toThrow(expect.objectContaining({ code: 'not-rememberable' }))
      auth.answer(challenge!.id, prompts[index]!.expected ?? 'manual', new AbortController().signal)
      expect((await connection.next('reply')).matched).toBe(true)
    }
    await pending
    expect(records.lookupCalls).toBe(0)
    expect(records.persisted).toEqual([])
    await view.stop()
  })

  it('isolates endpoints: a remembered password for another port is never auto-sent', async () => {
    const records = memory()
    records.saved.set(canonicalSshEndpoint({ ...endpoint, port: 2203 }), { nativeUser: 'fixture-user', password: 'other-port' })
    const { auth, connect } = await fixture({ memory: records.store })
    const view = collect(auth)
    const pending = observed(auth.endpoint(endpoint, new AbortController().signal))
    const connection = await connect({ ready: true, prompts: [{ prompt: passwordPrompt('fixture-user'), hint: null, expected: 'manual' }] })
    await connection.next('worker')
    await view.until(1)
    expect(view.challenges[0]?.canRemember).toBe(true)
    auth.answer(view.challenges[0]!.id, 'manual', new AbortController().signal)
    expect((await connection.next('reply')).matched).toBe(true)
    await pending
    expect(records.saved.get(canonicalSshEndpoint(endpoint))).toBeUndefined()
    await view.stop()
  })

  it('never auto-sends a remembered password to a different native account of the same endpoint', async () => {
    const deferred: SshEndpointArgs = { ...endpoint, username: '' }
    const records = memory()
    records.saved.set(canonicalSshEndpoint(deferred), { nativeUser: 'alice', password: 'alice-pw' })
    const { auth, connect } = await fixture({ memory: records.store })
    const view = collect(auth)
    const pending = observed(auth.endpoint(deferred, new AbortController().signal))
    const connection = await connect({ ready: true, prompts: [{ prompt: passwordPrompt('bob'), hint: null, expected: 'bob-pw' }] })
    await connection.next('worker')
    await view.until(1)
    const challenge = view.challenges[0]
    expect(challenge?.canRemember).toBe(true)
    expect(challenge?.endpoint).toEqual(deferred)
    auth.answer(challenge!.id, 'bob-pw', new AbortController().signal)
    expect((await connection.next('reply')).matched).toBe(true)
    await pending
    expect(records.lookupCalls).toBe(1)
    expect(records.saved.get(canonicalSshEndpoint(deferred))?.password).toBe('alice-pw')
    await view.stop()
  })

  it('leaves no stored residue when the owner is disposed before authentication completes', async () => {
    const records = memory()
    const { auth, connect } = await fixture({ memory: records.store })
    const view = collect(auth)
    const pending = observed(auth.endpoint(endpoint, new AbortController().signal))
    const connection = await connect({ ready: true, prompts: [{ prompt: passwordPrompt('fixture-user'), hint: null, expected: null }] })
    await connection.next('worker')
    await view.until(1)
    auth.answerRemember(view.challenges[0]!.id, 'pw', true, new AbortController().signal)
    await auth.dispose()
    await expect(pending).rejects.toMatchObject({ code: 'disposed' })
    await connection.closed
    expect(records.persisted).toEqual([])
    expect(records.saved.size).toBe(0)
    await view.stop()
  })
})
