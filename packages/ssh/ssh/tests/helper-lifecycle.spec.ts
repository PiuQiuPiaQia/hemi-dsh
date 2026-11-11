/** Reservation and process ownership across asynchronous preparation and cancellation. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { RemoteProcesses } from '../src/helper-processes.ts'
import { createStreamPeers } from './fixtures/helper.ts'

const request = { argv: ['true'], cwd: '/tmp', graceMs: 100, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } }

describe.skipIf(process.platform === 'win32')('SSH helper allocation ownership', () => {
  it('closes all reserved streams and refuses new work after helper shutdown', async () => {
    const peers = createStreamPeers()
    const owner = new RemoteProcesses(new Context(), () => peers.helper.reserveStream(), 1, 5000)
    try {
      const prepared = await owner.prepare(request)
      await expect(owner.prepare(request)).rejects.toThrow('capacity unavailable')
      await owner.close()
      for (const id of Object.values(prepared.streams)) {
        await expect(peers.client.openStream(id)).rejects.toThrow('reset')
      }
      await expect(owner.prepare(request)).rejects.toThrow('capacity unavailable')
    } finally { peers.close(); await owner.close() }
  })

  it('does not publish a process after termination interrupts cwd resolution', async () => {
    const peers = createStreamPeers()
    const ctx = new Context()
    const resolving = Promise.withResolvers<undefined>()
    const releaseCwd = Promise.withResolvers<never>()
    const spawn = vi.fn()
    ctx.provide('fs', {
      resolve: () => { resolving.resolve(undefined); return releaseCwd.promise }, processPath: () => '/tmp',
    } as never)
    ctx.provide('subprocess', { spawn } as never)
    const owner = new RemoteProcesses(ctx, () => peers.helper.reserveStream(), 1, 5000)
    try {
      const prepared = await owner.prepare(request)
      const streams = await Promise.all(Object.values(prepared.streams).map(id => peers.client.openStream(id)))
      const started = owner.start(prepared.id)
      const rejected = expect(started).rejects.toThrow('termination requested')
      await resolving.promise
      const stopped = owner.terminate(prepared.id)
      releaseCwd.resolve({} as never)
      await Promise.all([stopped, rejected])
      expect(spawn).not.toHaveBeenCalled()
      await vi.waitFor(() => { expect(streams.every(stream => stream.closed)).toBe(true) })
    } finally {
      peers.close()
      await owner.close()
    }
  })
})
