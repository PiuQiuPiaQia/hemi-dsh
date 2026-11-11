/** Helper shutdown joins completed-process resources before relinquishing ownership. */
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { describe, expect, it } from 'vitest'
import { RemoteProcesses } from '../src/helper-processes.ts'
import { createStreamPeers } from './fixtures/helper.ts'

describe.skipIf(process.platform === 'win32')('SSH completed-process cleanup ownership', () => {
  it.each(['success', 'failure'] as const)('joins finalization after native %s while retaining the direct result', async (kind) => {
    const root = await mkdtemp('/tmp/dsh-ssh-final-')
    const ctx = new Context()
    const filesystem = await ctx.plugin(LocalFileSystem, { cwd: root })
    const subprocess = await ctx.plugin(LocalSubprocessRuntime)
    const peers = createStreamPeers()
    const closingStream = Promise.withResolvers<undefined>()
    const releaseStream = Promise.withResolvers<undefined>()
    const streams: Duplex[] = []
    const owner = new RemoteProcesses(ctx, () => {
      const reservation = peers.helper.reserveStream()
      const { stream } = reservation
      streams.push(stream)
      const destroy = stream._destroy.bind(stream)
      stream._destroy = (error, callback) => {
        closingStream.resolve(undefined)
        void releaseStream.promise.then(() => { destroy(error, callback) })
      }
      return reservation
    }, 1, 5000)
    try {
      const prepared = await owner.prepare({
        argv: kind === 'success' ? [process.execPath, '-e', 'process.exit(0)'] : [join(root, 'missing-executable')],
        cwd: root, graceMs: 50, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      })
      for (const id of Object.values(prepared.streams)) {
        const stream = await peers.client.openStream(id)
        stream.end()
        stream.resume()
      }
      await owner.start(prepared.id)
      const outcome = await owner.done(prepared.id).then(
        value => ({ value }), (error: unknown) => ({ error }),
      )
      if (kind === 'failure') expect(outcome).toMatchObject({ error: { code: 'ENOENT' } })
      else expect(outcome).toMatchObject({ value: { outcome: { exitCode: 0 } } })
      await closingStream.promise
      let closed = false
      const close = owner.close().then(() => { closed = true })
      await new Promise(resolve => setImmediate(resolve))
      expect(closed).toBe(false)
      releaseStream.resolve(undefined)
      await close
      expect(streams.every(stream => stream.closed)).toBe(true)
      const late = await owner.done(prepared.id).then(
        value => ({ value }), (error: unknown) => ({ error }),
      )
      expect(late).toEqual(outcome)
      if ('error' in outcome) expect('error' in late && late.error).toBe(outcome.error)
    } finally {
      releaseStream.resolve(undefined)
      peers.close()
      await owner.close()
      await subprocess.dispose()
      await filesystem.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
