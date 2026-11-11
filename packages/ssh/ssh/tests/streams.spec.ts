/** Process stream flow control and ownership over the helper's private RPC transport. */
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { buffer } from 'node:stream/consumers'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SshRpcPeer } from '../src/protocol.ts'
import { SSH_STREAM_DATA_LIMIT, SSH_STREAM_DATA_TAG } from '../src/streams.ts'
import { createStreamPeers } from './fixtures/helper.ts'

describe('SSH process stream framing', () => {
  it('keeps RPC and a duplex control stream responsive while output fills its receive window', async () => {
    const peer = createStreamPeers(async method => method)
    try {
      const output = peer.helper.reserveStream()
      const control = peer.helper.reserveStream()
      const reader = await peer.client.openStream(output.id)
      const interactive = await peer.client.openStream(control.id)
      const payload = Buffer.alloc(2 * 1024 * 1024, 0x96)
      const outputFinished = once(output.stream, 'finish')
      void outputFinished.catch(() => {})
      output.stream.end(payload)
      await expect.poll(() => reader.readableLength).toBe(reader.readableHighWaterMark)
      expect(output.stream.writableFinished).toBe(false)

      await expect(peer.client.request('heartbeat', {}, z.string())).resolves.toBe('heartbeat')
      await expect(peer.client.request('process.terminate', {}, z.string())).resolves.toBe('process.terminate')
      const incoming = once(control.stream, 'data')
      const inputEnded = once(control.stream, 'end')
      control.stream.resume()
      const binary = Buffer.from([0, 0xff, 0x0a, 0x80])
      interactive.end(binary)
      expect((await incoming)[0]).toEqual(binary)
      await inputEnded
      const reply = buffer(interactive)
      control.stream.end('still writable after the opposite EOF')
      expect((await reply).toString()).toBe('still writable after the opposite EOF')

      reader.end()
      expect((await buffer(reader)).equals(payload)).toBe(true)
      await outputFinished
    } finally { peer.close() }
  })

  it('rejects a reservation on another connection and cancels only the attached stream', async () => {
    const owner = createStreamPeers(async method => method)
    const observer = createStreamPeers()
    try {
      const reservation = owner.helper.reserveStream()
      await expect(observer.client.openStream(reservation.id)).rejects.toThrow('reset')
      const caller = new AbortController()
      const stream = await owner.client.openStream(reservation.id, caller.signal)
      const closed = new Promise<void>((resolve) => { reservation.stream.once('close', resolve) })
      caller.abort()
      await closed
      expect(stream.destroyed).toBe(true)
      await expect(owner.client.openStream(reservation.id)).rejects.toThrow('reset')
      await expect(owner.client.request('heartbeat', {}, z.string())).resolves.toBe('heartbeat')
    } finally { owner.close(); observer.close() }
  })

  it('rejects an oversized binary frame before reading its payload', async () => {
    const input = new PassThrough()
    const peer = new SshRpcPeer(input, new PassThrough(), 64 * 1024 * 1024, 128)
    try {
      const failure = once(peer, 'closed')
      const header = Buffer.alloc(4)
      header.writeUInt32BE(SSH_STREAM_DATA_TAG + SSH_STREAM_DATA_LIMIT + 1)
      input.write(header)
      expect((await failure)[0]).toMatchObject({ message: 'SSH helper sent an invalid frame length' })
    } finally { peer.close() }
  })
})
