/** Authenticated transport faults and competing native-range finalization. */
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { PassThrough, type Duplex } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { RemoteProcesses } from '../src/helper-processes.ts'
import type { SshStreamId } from '../src/streams.ts'
import { createStreamPeers } from './fixtures/helper.ts'

function nativeProcess() {
  const completion = Promise.withResolvers<SubprocessOutcome>()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const control = new PassThrough()
  const finish = (): void => {
    stdout.end(); stderr.end(); control.end()
    completion.resolve({ exitCode: 0, signal: null })
  }
  const terminate = vi.fn(finish)
  const waitForExit = vi.fn(async () => { await completion.promise; return true })
  const handle: SubprocessHandle = {
    stdin: undefined, stdout, stderr, control, collected: {}, done: completion.promise,
    terminate, waitForExit,
  }
  return { handle, control, finish, terminate, waitForExit }
}

async function harness(child: ReturnType<typeof nativeProcess>, control: boolean) {
  const root = await mkdtemp('/tmp/dsh-ssh-finalize-')
  const ctx = new Context()
  const peers = createStreamPeers()
  const reservations = new Map<SshStreamId, Duplex>()
  const owner = new RemoteProcesses(ctx, () => {
    const reservation = peers.helper.reserveStream()
    reservations.set(reservation.id, reservation.stream)
    return reservation
  }, 1, 5000)
  onTestFinished(async () => {
    child.finish()
    peers.close()
    try { await owner.close() }
    finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
      vi.restoreAllMocks()
    }
  })
  await ctx.plugin(LocalFileSystem)
  await ctx.plugin(LocalSubprocessRuntime)
  vi.spyOn(ctx.subprocess, 'spawn').mockReturnValue(child.handle)
  const prepared = await owner.prepare({
    argv: ['fixture-native-process'], cwd: root, graceMs: 100,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', ...(control ? { control: 'pipe' } : {}) },
  })
  const serving: Record<string, Duplex> = {}
  for (const [name, id] of Object.entries(prepared.streams)) {
    serving[name] = reservations.get(id)!
    const stream = await peers.client.openStream(id)
    if (name !== 'control') { stream.end(); stream.resume() }
  }
  await owner.start(prepared.id)
  return { owner, id: prepared.id, serving }
}

describe.skipIf(process.platform === 'win32')('SSH helper finalization ownership', () => {
  it('destroys the native control endpoint when its logical SSH stream fails', async () => {
    const child = nativeProcess()
    const test = await harness(child, true)
    const control = test.serving.control!
    const closed = once(child.control, 'close')
    expect(child.control.destroyed).toBe(false)
    control.destroy(Object.assign(new Error('authenticated transport I/O failed'), { code: 'ECONNRESET' }))
    await closed
    expect(child.control.destroyed).toBe(true)
    await test.owner.terminate(test.id)
    expect(child.waitForExit).toHaveBeenCalled()
    expect(await test.owner.done(test.id)).toMatchObject({ outcome: { exitCode: 0, signal: null } })
  })

  it('does not republish completion after helper close has released the process record', async () => {
    const child = nativeProcess()
    const observing = Promise.withResolvers<undefined>()
    const releaseObservation = Promise.withResolvers<undefined>()
    child.waitForExit.mockImplementationOnce(async () => {
      observing.resolve(undefined)
      await releaseObservation.promise
      return true
    })
    const test = await harness(child, false)
    onTestFinished(async () => {
      await test.owner.close()
      releaseObservation.resolve(undefined)
      await setImmediate()
    })
    child.finish()
    await observing.promise
    await test.owner.close()
    expect(child.terminate).toHaveBeenCalledOnce()
    expect(child.waitForExit).toHaveBeenCalledTimes(2)
    expect(Object.values(test.serving).every(stream => stream.closed)).toBe(true)
    releaseObservation.resolve(undefined)
    await setImmediate()
    await expect(test.owner.done(test.id)).rejects.toThrow('Unknown or expired SSH process handle')
    expect(Object.values(test.serving).every(stream => stream.closed)).toBe(true)
  })

  it('leaves completion owned by a release that is still observing the native range', async () => {
    const child = nativeProcess()
    const firstEntered = Promise.withResolvers<undefined>()
    const secondEntered = Promise.withResolvers<undefined>()
    const first = Promise.withResolvers<undefined>()
    const second = Promise.withResolvers<undefined>()
    child.waitForExit.mockImplementationOnce(async () => {
      firstEntered.resolve(undefined)
      await first.promise
      return true
    }).mockImplementationOnce(async () => {
      secondEntered.resolve(undefined)
      await second.promise
      return true
    })
    const test = await harness(child, false)
    onTestFinished(() => { first.resolve(undefined); second.resolve(undefined) })
    child.finish()
    await firstEntered.promise
    const closed = test.owner.close()
    try {
      await secondEntered.promise
      first.resolve(undefined)
      await setImmediate()
      second.resolve(undefined)
      await closed
      await expect(test.owner.done(test.id)).rejects.toThrow('Unknown or expired SSH process handle')
    } finally {
      first.resolve(undefined)
      second.resolve(undefined)
      await closed
    }
  })
})
