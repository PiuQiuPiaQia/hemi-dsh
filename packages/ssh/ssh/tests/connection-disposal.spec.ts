import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { SshRpcPeer, SSH_PROTOCOL_VERSION } from '../src/protocol.ts'
import { SshConnection } from '../src/index.ts'

const transport = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: transport.spawn,
}))

class HelperChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  private stopped = false
  readonly signals: (string | undefined)[] = []

  kill(signal?: string): boolean {
    this.signals.push(signal)
    if (!this.stopped) {
      this.stopped = true
      queueMicrotask(() => { this.emit('close', 0, null) })
    }
    return true
  }
}

async function setup(holdHeartbeat = false, holdClose = false) {
  const child = new HelperChild()
  const heartbeat = Promise.withResolvers<null>()
  const ordinary = Promise.withResolvers<null>()
  const ordinaryEntered = Promise.withResolvers<undefined>()
  const closing = Promise.withResolvers<null>()
  const closeEntered = Promise.withResolvers<undefined>()
  let heartbeatCalls = 0
  const helper = new SshRpcPeer(child.stdin, child.stdout, 4096, 8, async (method) => {
    if (method === 'close') { closeEntered.resolve(undefined); return holdClose ? closing.promise : null }
    if (method === 'heartbeat') { heartbeatCalls++; return holdHeartbeat ? heartbeat.promise : null }
    if (method === 'ordinary') { ordinaryEntered.resolve(undefined); return ordinary.promise }
    if (method !== 'hello') throw new Error(`unexpected helper operation: ${method}`)
    return { protocol: SSH_PROTOCOL_VERSION, hash: 'a'.repeat(64), platform: 'linux', nodeVersion: 'v24.19.0', kind: 'node-script', executable: '/usr/bin/node', workspace: '/workspace' }
  })
  transport.spawn.mockReturnValue(child)
  const ctx = new Context()
  const fiber = ctx.plugin(SshConnection, {
    host: 'hermetic-test', launch: { kind: 'node-script', node: '/usr/bin/node' }, helper: '/opt/dsh/helper.js', helperHash: 'a'.repeat(64), workspace: '/workspace',
    requestTimeoutMs: 10_000, maxFrameBytes: 4096, maxPending: holdHeartbeat ? 1 : 8, leaseMs: 30_000,
  })
  onTestFinished(async () => {
    heartbeat.resolve(null)
    ordinary.resolve(null)
    closing.resolve(null)
    helper.close()
    child.stderr.destroy()
    child.kill()
    await fiber.dispose()
    vi.clearAllMocks()
  })
  await fiber
  return { service: ctx.ssh, helper, heartbeatCalls: () => heartbeatCalls,
    ordinaryEntered: ordinaryEntered.promise, releaseOrdinary: () => { ordinary.resolve(null) },
    releaseHeartbeat: () => { heartbeat.resolve(null) }, closeEntered: closeEntered.promise,
    releaseClose: () => { closing.resolve(null) } }
}

describe.skipIf(process.platform === 'win32')('SSH stream establishment disposal', () => {
  it.each(['ready continuation', 'already closing'] as const)('rejects new requests during the %s without sending them', async (phase) => {
    const state = await setup(false, true)
    const request = () => state.service.request('ordinary', {}, z.null(), undefined, true)
      .then(() => ({ kind: 'completed' as const }), (error: unknown) => ({ kind: 'rejected' as const, error }))
    const pending = phase === 'ready continuation' ? request() : undefined
    const disposal = state.service.dispose()
    await state.closeEntered
    const outcome = await Promise.race([
      pending ?? request(),
      state.ordinaryEntered.then(() => ({ kind: 'admitted' as const })),
    ])
    expect(outcome.kind).toBe('rejected')
    if (outcome.kind !== 'rejected') throw new Error('request was sent after disposal began')
    expect(String(outcome.error)).toContain('SSH connection is closed')
    state.releaseClose()
    await disposal
  })

  it('keeps one heartbeat outstanding when ordinary capacity is full and its reply is delayed', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let state: Awaited<ReturnType<typeof setup>> | undefined
    try {
      state = await setup(true)
      let ordinarySettled = false
      const pending = state.service.request('ordinary', {}, z.null(), undefined, true)
        .then(value => ({ value }), (error: unknown) => ({ error }))
        .finally(() => { ordinarySettled = true })
      await state.ordinaryEntered
      await vi.advanceTimersByTimeAsync(10_000)
      expect(state.heartbeatCalls()).toBe(1)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(state.heartbeatCalls()).toBe(1)
      expect(ordinarySettled).toBe(false)
      state.releaseHeartbeat()
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(state.heartbeatCalls()).toBe(2)
      state.releaseOrdinary()
      expect(await pending).toEqual({ value: null })
    } finally {
      state?.releaseHeartbeat()
      state?.releaseOrdinary()
      await state?.service.dispose()
      vi.useRealTimers()
    }
  })

  it('closes attached process streams when the helper connection disposes', async () => {
    const state = await setup()
    const reservation = state.helper.reserveStream()
    const client = await state.service.connectStream(reservation.id)
    const closed = new Promise<void>((resolve) => { client.once('close', resolve) })
    await state.service.dispose()
    await closed
    expect(reservation.stream.destroyed).toBe(true)
    await expect(state.service.connectStream(reservation.id)).rejects.toThrow('closed')
  })
})
