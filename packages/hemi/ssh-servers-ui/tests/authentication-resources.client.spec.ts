import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { RemoteStream, RemoteStreamCarrierError, type RemoteStreamFactory } from '@deepseek-ai/dsh-api-gateway/client'
import { ResourceRegistry } from '@deepseek-ai/dsh-client-resources/src/client/resources.ts'
import { RemoteError, type RemoteResult, type RemoteStreamHandle, type TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SshAuthenticationChallenge, SshAuthenticationChallengeId } from '@deepseek-ai/dsh-hemi-ssh-servers/workspace-types'
import { AUTHENTICATION_ADDRESS, AuthenticationResources } from '../src/client/authentication-resources.ts'

type Challenges = readonly SshAuthenticationChallenge[]
type Remote = Pick<TypertClientRemote['hemiSshWorkspaces'], 'followAuthentication' | 'answerAuthentication' | 'answerAuthenticationAndRemember'>
type Script = (signal: AbortSignal) => AsyncIterable<Challenges>
const challenge: SshAuthenticationChallenge = {
  id: brandString<SshAuthenticationChallengeId>('pending-authentication'), kind: 'input', prompt: 'fixture password:', canRemember: true,
  endpoint: { host: 'fixture', username: 'operator', port: 22, identityFile: '' },
}

function untilAborted(signal: AbortSignal): Promise<void> {
  return signal.aborted ? Promise.resolve() : new Promise((resolve) => {
    signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

function holding(value: Challenges): Script {
  return async function* (signal) { yield value; await untilAborted(signal) }
}

function bench(scripts: Script[] = [holding([challenge])]) {
  let available = true
  const listeners = new Set<() => void>()
  const connection = { generation: {
    getSnapshot: () => available ? { id: 1, host: { home: '/fixture' } } : undefined,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  } }
  const signals: AbortSignal[] = []
  const followAuthentication = vi.fn<Remote['followAuthentication']>((signal = new AbortController().signal) => {
    const owned = new AbortController()
    const combined = AbortSignal.any([signal, owned.signal])
    signals.push(combined)
    const script = scripts.shift()
    if (script === undefined) throw new Error('Unexpected extra authentication subscription')
    const handle: RemoteStreamHandle<Challenges, never> = {
      send: () => { throw new Error('No authentication uplink') }, end: () => {}, dispose: () => { owned.abort() },
      [Symbol.asyncIterator]: () => script(combined)[Symbol.asyncIterator](),
    }
    return handle
  })
  const answerAuthentication = vi.fn<Remote['answerAuthentication']>(async () => ({ ok: true, value: undefined }))
  const answerAuthenticationAndRemember = vi.fn<Remote['answerAuthenticationAndRemember']>(async () => ({ ok: true, value: undefined }))
  const factory: RemoteStreamFactory = { $stream: options => new RemoteStream(connection, options) }
  const owner = new AuthenticationResources({ followAuthentication, answerAuthentication, answerAuthenticationAndRemember }, factory)
  const holder = new AbortController()
  const reader = owner.provider().open(AUTHENTICATION_ADDRESS, { signal: holder.signal })[Symbol.asyncIterator]()
  onTestFinished(async () => { holder.abort(); await reader.return?.(); await owner.dispose() })
  const availability = (value: boolean): void => { available = value; for (const listener of listeners) listener() }
  return { owner, reader, holder, followAuthentication, answerAuthentication, answerAuthenticationAndRemember,
    signals, availability, listeners, factory }
}

it('publishes native snapshots only while the resource is held and joins cancellation', async () => {
  const b = bench()
  expect(b.followAuthentication).not.toHaveBeenCalled()
  expect((await b.reader.next()).value).toEqual({ ok: true, value: [challenge] })
  const waiting = b.reader.next()
  b.holder.abort()
  expect((await waiting).done).toBe(true)
  expect(b.signals.every(signal => signal.aborted)).toBe(true)
  expect(b.followAuthentication).toHaveBeenCalledOnce()
})

it('marks an unexpected normal end failed and accepts the replacement generation snapshot', async () => {
  const replacement = Promise.withResolvers<undefined>()
  const reopened = Promise.withResolvers<undefined>()
  const b = bench([
    async function* () { yield [challenge] },
    async function* (signal) { reopened.resolve(undefined); await replacement.promise; yield []; await untilAborted(signal) },
  ])
  expect((await b.reader.next()).value).toMatchObject({ ok: true, value: [challenge] })
  const failed = await b.reader.next()
  expect(failed.value).toMatchObject({ ok: false, error: { code: 'gateway/internal' } })
  await reopened.promise
  replacement.resolve(undefined)
  expect((await b.reader.next()).value).toEqual({ ok: true, value: [] })
  expect(b.followAuthentication).toHaveBeenCalledTimes(2)
})

it('clears prompt availability during carrier loss and aborts a pending recovery without reopening', async () => {
  const dropped = Promise.withResolvers<undefined>()
  const b = bench([async function* () {
    yield [challenge]
    await dropped.promise
    throw new RemoteStreamCarrierError('private carrier detail')
  }])
  await b.reader.next()
  b.availability(false)
  dropped.resolve(undefined)
  expect((await b.reader.next()).value).toMatchObject({ ok: false, error: { message: 'SSH authentication is unavailable' } })
  const waiting = b.reader.next()
  b.holder.abort()
  expect((await waiting).done).toBe(true)
  expect(b.listeners.size).toBe(0)
  b.availability(true)
  expect(b.followAuthentication).toHaveBeenCalledOnce()
})

it('reopens a still-held resource after a terminal stream failure and discards the old resource state', async () => {
  const b = bench([
    async function* () { throw new RemoteError('gateway/internal', 'private terminal detail', {}) },
    holding([challenge]), holding([]),
  ])
  const ctx = new Context()
  const resources = new ResourceRegistry(ctx)
  let remove = resources.register(b.owner.provider())
  const source = resources.source(AUTHENTICATION_ADDRESS)
  const unwatch = source.subscribe(() => {})
  onTestFinished(async () => { unwatch(); remove(); await ctx.fiber.dispose() })
  await vi.waitFor(() => { expect(source.getSnapshot().status).toBe('failed') })
  remove(); remove = resources.register(b.owner.provider())
  await vi.waitFor(() => { expect(source.getSnapshot()).toMatchObject({ status: 'live', value: [challenge] }) })
  remove(); remove = resources.register(b.owner.provider())
  await vi.waitFor(() => { expect(source.getSnapshot()).toMatchObject({ status: 'live', value: [] }) })
  expect(b.followAuthentication).toHaveBeenCalledTimes(3)
})

it('contains a synchronous stream-factory failure and releases its pending completion', async () => {
  const remote: Remote = { followAuthentication: vi.fn(), answerAuthentication: vi.fn(), answerAuthenticationAndRemember: vi.fn() }
  const owner = new AuthenticationResources(remote, { $stream: () => { throw new Error('private setup detail') } })
  const reader = owner.provider().open(AUTHENTICATION_ADDRESS, { signal: new AbortController().signal })[Symbol.asyncIterator]()
  expect((await reader.next()).value).toMatchObject({ ok: false, error: { message: 'SSH authentication is unavailable' } })
  expect((await reader.next()).done).toBe(true)
  await owner.dispose()
  expect(remote.followAuthentication).not.toHaveBeenCalled()
})

it('does not open authentication for an already released holder or disposed owner', async () => {
  const b = bench()
  b.holder.abort()
  expect((await b.reader.next()).done).toBe(true)
  await b.owner.dispose()
  const reader = b.owner.provider().open(AUTHENTICATION_ADDRESS, { signal: new AbortController().signal })[Symbol.asyncIterator]()
  expect((await reader.next()).done).toBe(true)
  expect(b.followAuthentication).not.toHaveBeenCalled()
})

it.each(['accepted', 'expired', 'failed', 'rejected'] as const)('settles an authentication answer as %s without reporting its secret', async (outcome) => {
  const b = bench()
  if (outcome === 'expired') b.answerAuthentication.mockResolvedValueOnce({ ok: false,
    error: new RemoteError('hemi-ssh/authentication-expired', 'expired', {}) })
  if (outcome === 'failed') b.answerAuthentication.mockResolvedValueOnce({ ok: false,
    error: new RemoteError('gateway/internal', 'private response detail', {}) })
  if (outcome === 'rejected') b.answerAuthentication.mockRejectedValueOnce(new Error('private response detail'))
  const logging = vi.spyOn(console, 'error')
  onTestFinished(() => { logging.mockRestore() })
  expect(await b.owner.answer(challenge.id, 'fixture-secret-response', false)).toBe(outcome === 'rejected' ? 'failed' : outcome)
  expect(b.answerAuthentication).toHaveBeenCalledWith(challenge.id, 'fixture-secret-response', expect.any(AbortSignal))
  expect(logging).not.toHaveBeenCalled()
})

it('routes explicit opt-in to the remember operation while leaving the challenge resource secret-free', async () => {
  const b = bench()
  expect(await b.owner.answer(challenge.id, 'fixture-remember-secret', true)).toBe('accepted')
  expect(b.answerAuthenticationAndRemember).toHaveBeenCalledExactlyOnceWith(challenge.id, 'fixture-remember-secret', true, expect.any(AbortSignal))
  expect(b.answerAuthentication).not.toHaveBeenCalled()
  const frame = await b.reader.next()
  expect(frame.value).toEqual({ ok: true, value: [challenge] })
  expect(JSON.stringify(frame)).not.toContain('fixture-remember-secret')
})

it('routes cancellation to the original non-saving operation even if remember is requested', async () => {
  const b = bench()
  expect(await b.owner.answer(challenge.id, null, true)).toBe('accepted')
  expect(b.answerAuthentication).toHaveBeenCalledExactlyOnceWith(challenge.id, null, expect.any(AbortSignal))
  expect(b.answerAuthenticationAndRemember).not.toHaveBeenCalled()
})

it.each(['expired', 'not-rememberable', 'failed', 'rejected'] as const)('contains a %s remember failure without exposing response or exception text', async (outcome) => {
  const b = bench()
  if (outcome === 'expired') b.answerAuthenticationAndRemember.mockResolvedValueOnce({ ok: false,
    error: new RemoteError('hemi-ssh/authentication-expired', 'fixture-remember-secret', {}) })
  if (outcome === 'not-rememberable') b.answerAuthenticationAndRemember.mockResolvedValueOnce({ ok: false,
    error: new RemoteError('hemi-ssh/not-rememberable', 'fixture-remember-secret', { id: challenge.id }) })
  if (outcome === 'failed') b.answerAuthenticationAndRemember.mockResolvedValueOnce({ ok: false,
    error: new RemoteError('gateway/internal', 'fixture-remember-secret', {}) })
  if (outcome === 'rejected') b.answerAuthenticationAndRemember.mockRejectedValueOnce(new Error('fixture-remember-secret'))
  const logging = vi.spyOn(console, 'error')
  onTestFinished(() => { logging.mockRestore() })
  const result = await b.owner.answer(challenge.id, 'fixture-remember-secret', true)
  expect(result).toBe(outcome === 'expired' || outcome === 'not-rememberable' ? 'expired' : 'failed')
  expect(JSON.stringify(result)).not.toContain('fixture-remember-secret')
  expect(logging).not.toHaveBeenCalled()
  expect(b.answerAuthentication).not.toHaveBeenCalled()
})

it('aborts dispatched replies and waits for their settlement before disposal completes', async () => {
  const b = bench()
  const reply = Promise.withResolvers<RemoteResult<void>>()
  b.answerAuthentication.mockReturnValueOnce(reply.promise)
  const answer = b.owner.answer(challenge.id, null, false)
  await vi.waitFor(() => { expect(b.answerAuthentication).toHaveBeenCalledOnce() })
  const disposed = b.owner.dispose()
  expect(b.answerAuthentication.mock.calls[0]?.[2]?.aborted).toBe(true)
  let finished = false
  void disposed.then(() => { finished = true })
  await Promise.resolve()
  expect(finished).toBe(false)
  reply.resolve({ ok: true, value: undefined })
  await disposed
  expect(await answer).toBe('accepted')
  expect(await b.owner.answer(challenge.id, 'not-dispatched', true)).toBe('expired')
  expect(b.answerAuthentication).toHaveBeenCalledOnce()
})
