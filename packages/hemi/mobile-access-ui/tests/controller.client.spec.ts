import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { MobileAccessState } from '../src/types.ts'
import { MobileController, MOBILE_ADDRESS } from '../src/client/controller.ts'
import { device, invitation, off, on, remoteFixture, request } from './fixtures.client.ts'

function bench() {
  const remote = remoteFixture()
  const controller = new MobileController(remote)
  const holder = new AbortController()
  const iterator = controller.provider().open(MOBILE_ADDRESS, { signal: holder.signal })[Symbol.asyncIterator]()
  onTestFinished(async () => { holder.abort(); await controller.dispose(); await iterator.return?.() })
  return { remote, controller, holder, iterator }
}
afterEach(() => { vi.useRealTimers() })

it('does not read or listen before a resource holder opens and stops polling when it closes', async () => {
  vi.useFakeTimers()
  const b = bench()
  expect(b.remote.getState).not.toHaveBeenCalled()
  expect(await b.controller.start()).toEqual({ kind: 'withdrawn' })
  expect((await b.iterator.next()).value).toEqual({ ok: true, value: { kind: 'state', state: off } })
  const next = b.iterator.next()
  await vi.advanceTimersByTimeAsync(1000)
  await next
  expect(b.remote.getState).toHaveBeenCalledTimes(2)
  expect(b.remote.start).not.toHaveBeenCalled()
  b.holder.abort()
  await b.iterator.next()
  await vi.advanceTimersByTimeAsync(5000)
  expect(b.remote.getState).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})

it('returns the one-time secret only to the creating action and publishes authoritative state without it', async () => {
  const b = bench()
  await b.iterator.next()
  expect(await b.controller.start()).toEqual({ kind: 'complete', invitation })
  expect(b.remote.start).toHaveBeenCalledWith(expect.any(AbortSignal))
  expect(b.remote.createInvitation).toHaveBeenCalledOnce()
  const frame = await b.iterator.next()
  expect(JSON.stringify(frame)).not.toContain(invitation.token)
})

it('reports unavailable Wi-Fi from start without creating an invitation or exposing Host diagnostics', async () => {
  const b = bench()
  await b.iterator.next()
  b.remote.start.mockResolvedValueOnce({ ok: false, error: new RemoteError('hemi-mobile/no-network', 'bindHost 0.0.0.0:4444 /private', {}) })
  expect(await b.controller.start()).toEqual({ kind: 'failed', problem: 'noNetwork' })
  expect(b.remote.start).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal))
  expect(b.remote.createInvitation).not.toHaveBeenCalled()
})

it('reports invitation failure independently after the listener successfully starts', async () => {
  const b = bench()
  await b.iterator.next()
  b.remote.createInvitation.mockResolvedValueOnce({ ok: false, error: new RemoteError('hemi-mobile/credentials-unavailable', '/private/credentials', {}) })
  expect(await b.controller.start()).toEqual({ kind: 'failed', problem: 'invitationFailed' })
  expect(b.remote.start).toHaveBeenCalledOnce()
})

it('confirms stop and revoke from returned Host facts rather than a resolved promise alone', async () => {
  const b = bench()
  await b.iterator.next()
  b.remote.stop.mockResolvedValueOnce({ ok: true, value: on })
  expect(await b.controller.stop()).toEqual({ kind: 'failed', problem: 'unknown' })
  expect(await b.controller.stop()).toEqual({ kind: 'complete', invitation: null })
  b.remote.revoke.mockResolvedValueOnce({ ok: true, value: on })
  expect(await b.controller.revoke(device.deviceId)).toEqual({ kind: 'failed', problem: 'unknown' })
  expect(await b.controller.revoke(device.deviceId)).toEqual({ kind: 'complete', invitation: null })
})

it('passes the opaque request identity and captured code and checks the settled request status', async () => {
  const b = bench()
  await b.iterator.next()
  expect(await b.controller.approve(request.requestId, request.verificationCode)).toEqual({ kind: 'complete', invitation: null })
  expect(b.remote.approve).toHaveBeenCalledWith(request.requestId, '042891', expect.any(AbortSignal))
  expect(await b.controller.reject(request.requestId)).toEqual({ kind: 'complete', invitation: null })
  b.remote.approve.mockResolvedValueOnce({ ok: true, value: on })
  expect(await b.controller.approve(request.requestId, request.verificationCode)).toEqual({ kind: 'failed', problem: 'unknown' })
})

it.each([
  ['hemi-mobile/no-network', 'noNetwork'],
  ['hemi-mobile/wrong-code', 'wrongCode'],
  ['hemi-mobile/not-listening', 'notListening'],
  ['hemi-mobile/credentials-unavailable', 'credentialsFailed'],
] as const)('localizes %s without exposing private diagnostics', async (code, problem) => {
  const b = bench()
  await b.iterator.next()
  b.remote.createInvitation.mockResolvedValueOnce({ ok: false, error: new RemoteError(code, '/private/secret-token', {}) })
  const result = await b.controller.createInvitation()
  expect(result).toEqual({ kind: 'failed', problem })
  expect(JSON.stringify(result)).not.toContain('/private')
})

it('contains carrier failures as unknown outcomes and does not dispatch overlapping writes', async () => {
  const b = bench()
  await b.iterator.next()
  const pending = Promise.withResolvers<RemoteResult<MobileAccessState>>()
  b.remote.stop.mockReturnValueOnce(pending.promise)
  const stopping = b.controller.stop()
  expect(await b.controller.revoke(device.deviceId)).toEqual({ kind: 'withdrawn' })
  pending.reject(new Error('/private/secret'))
  expect(await stopping).toEqual({ kind: 'failed', problem: 'unknown' })
  expect(b.remote.revoke).not.toHaveBeenCalled()
})

it('replaces retained management data on authorization denial and preserves read failures as failure frames', async () => {
  const b = bench()
  await b.iterator.next()
  b.remote.getState.mockResolvedValueOnce({ ok: false, error: new RemoteError('hemi-mobile/unauthorized', 'private', {}) })
  b.controller.refresh()
  expect((await b.iterator.next()).value).toEqual({ ok: true, value: { kind: 'unauthorized' } })
  b.remote.getState.mockRejectedValueOnce(new Error('private'))
  b.controller.refresh()
  expect((await b.iterator.next()).value).toMatchObject({ ok: false, error: { code: 'gateway/internal' } })
})

it('aborts admitted writes when the settings holder closes and never starts their dependent invitation', async () => {
  const b = bench()
  await b.iterator.next()
  const pending = Promise.withResolvers<RemoteResult<MobileAccessState>>()
  let signal: AbortSignal | undefined
  b.remote.start.mockImplementationOnce((abort?: AbortSignal) => { signal = abort; return pending.promise })
  const starting = b.controller.start()
  b.holder.abort()
  expect(signal?.aborted).toBe(true)
  pending.resolve({ ok: true, value: on })
  expect(await starting).toEqual({ kind: 'withdrawn' })
  expect(b.remote.createInvitation).not.toHaveBeenCalled()
  await b.controller.dispose()
  expect(await b.controller.stop()).toEqual({ kind: 'withdrawn' })
})

it('drops a read started before a command commit or connection reset', async () => {
  const b = bench()
  await b.iterator.next()
  const old = Promise.withResolvers<RemoteResult<MobileAccessState>>()
  b.remote.getState.mockReturnValueOnce(old.promise)
  b.controller.refresh()
  b.controller.reset()
  b.remote.getState.mockResolvedValue({ ok: true, value: { ...off, addresses: [] } })
  old.resolve({ ok: true, value: on })
  expect((await b.iterator.next()).value).toEqual({ ok: true, value: { kind: 'state', state: { ...off, addresses: [] } } })
})
