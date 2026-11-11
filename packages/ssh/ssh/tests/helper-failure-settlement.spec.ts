/** Failed native launches release remote capacity while retaining the original result error. */
import { mkdtemp, rm } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { describe, expect, it, vi } from 'vitest'
import { RemoteProcesses } from '../src/helper-processes.ts'
import { createStreamPeers } from './fixtures/helper.ts'

describe.skipIf(process.platform === 'win32')('SSH failed process settlement', () => {
  it('reuses a one-process capacity after ENOENT and preserves late done errors', async () => {
    const root = await mkdtemp('/tmp/dsh-ssh-failed-')
    const ctx = new Context()
    const filesystem = await ctx.plugin(LocalFileSystem, { cwd: root })
    const subprocess = await ctx.plugin(LocalSubprocessRuntime)
    const peers = createStreamPeers()
    const owner = new RemoteProcesses(ctx, () => peers.helper.reserveStream(), 1, 5000)
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const prepared = await owner.prepare({
          argv: [`${root}/missing-executable`], cwd: root, graceMs: 50,
          stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        })
        const streams = await Promise.all(Object.values(prepared.streams).map(id => peers.client.openStream(id)))
        for (const stream of streams) { stream.end(); stream.resume() }
        await owner.start(prepared.id)
        const failure = await owner.done(prepared.id).catch((error: unknown) => error)
        expect(failure).toMatchObject({ code: 'ENOENT' })
        await owner.terminate(prepared.id)
        expect(await owner.wait(prepared.id)).toBe(true)
        await vi.waitFor(() => { expect(streams.every(stream => stream.closed)).toBe(true) })
        await expect(owner.done(prepared.id)).rejects.toBe(failure)
      }
    } finally {
      peers.close()
      await owner.close()
      await subprocess.dispose()
      await filesystem.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
