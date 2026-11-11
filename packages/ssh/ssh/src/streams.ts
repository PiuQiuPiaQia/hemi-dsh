/** Flow-controlled duplex streams carried inside the helper's private SSH exec channel. */
import { randomUUID } from 'node:crypto'
import { Duplex } from 'node:stream'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'

const WINDOW = 256 * 1024
const CHUNK = 16 * 1024
const ID_BYTES = 36
/** Binary frame tag in the length word. Administrative JSON frames use the lower 31 bits. */
export const SSH_STREAM_DATA_TAG = 0x80000000
/** Maximum binary payload, including its stream identifier. */
export const SSH_STREAM_DATA_LIMIT = ID_BYTES + CHUNK

/** An opaque identifier scoped to a single private helper connection. */
export type SshStreamId = Branded<'SshStreamId'>
/** Validate a stream identifier received from the helper. */
export const sshStreamIdSchema = z.uuid().transform((id): SshStreamId => id as SshStreamId)
/** Validate flow-control and lifecycle messages carried alongside RPC frames. */
export const sshStreamFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('stream.open'), id: sshStreamIdSchema }).strict(),
  z.object({ type: z.literal('stream.ready'), id: sshStreamIdSchema }).strict(),
  z.object({ type: z.literal('stream.credit'), id: sshStreamIdSchema, bytes: z.number().int().min(1).max(WINDOW) }).strict(),
  z.object({ type: z.literal('stream.end'), id: sshStreamIdSchema }).strict(),
  z.object({ type: z.literal('stream.reset'), id: sshStreamIdSchema }).strict(),
])
type StreamFrame = z.infer<typeof sshStreamFrameSchema>
type SendFrame = (frame: StreamFrame) => Promise<void>

function streamError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** One reserved remote endpoint and the acknowledgement that permits launch. */
export interface SshStreamReservation {
  id: SshStreamId
  stream: Duplex
  attached: Promise<void>
}

class LogicalStream extends Duplex {
  private readonly ready = Promise.withResolvers<void>()
  private sendCredit = WINDOW
  private receiveCredit = WINDOW
  private creditWait: (() => void) | undefined
  private creditPending = false
  private connected = false
  private sentEnd = false
  private receivedEnd = false
  private remoteClosed = false

  constructor(
    readonly id: SshStreamId,
    readonly role: 'reserved' | 'opening',
    private readonly send: SendFrame,
    private readonly sendData: (stream: LogicalStream, bytes: Buffer) => Promise<void>,
    private readonly remove: () => void,
  ) {
    super({ allowHalfOpen: true, readableHighWaterMark: WINDOW })
    this.pause()
    void this.ready.promise.catch(() => {})
    // Owners observe closure and attach their own error handlers when piping begins.
    this.on('error', () => {})
  }

  get attached(): Promise<void> { return this.ready.promise }
  get isConnected(): boolean { return this.connected }

  attach(): void {
    this.connected = true
    this.ready.resolve()
  }

  receive(bytes: Buffer): void {
    if (!this.connected || this.receivedEnd || bytes.length > this.receiveCredit) {
      throw new Error('SSH helper sent data outside the stream receive window')
    }
    this.receiveCredit -= bytes.length
    this.push(bytes)
    this.grantCredit()
  }

  credit(bytes: number): void {
    if (!this.connected || this.sendCredit + bytes > WINDOW) throw new Error('SSH helper sent excessive stream credit')
    this.sendCredit += bytes
    this.wakeWriter()
  }

  receiveEnd(): void {
    if (!this.connected || this.receivedEnd) throw new Error('SSH helper sent an unexpected stream EOF')
    this.receivedEnd = true
    this.push(null)
  }

  remoteReset(error: Error): void {
    this.remoteClosed = true
    this.destroy(error)
  }

  override _read(): void {}

  override read(size?: number): unknown {
    const value: unknown = super.read(size)
    // Node can call _read before removing buffered bytes from a paused stream.
    this.grantCredit()
    return value
  }

  private grantCredit(): void {
    if (!this.connected || this.receivedEnd || this.destroyed || this.creditPending) return
    const available = WINDOW - this.readableLength - this.receiveCredit
    if (available < CHUNK) return
    this.receiveCredit += available
    this.creditPending = true
    void this.send({ type: 'stream.credit', id: this.id, bytes: available }).then(() => {
      this.creditPending = false
      this.grantCredit()
    }, (error: unknown) => { this.destroy(streamError(error)) })
  }

  override _write(bytes: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    void this.writeChunks(bytes).then(() => { callback() }, (error: unknown) => { callback(streamError(error)) })
  }

  private async writeChunks(bytes: Buffer): Promise<void> {
    await this.attached
    let offset = 0
    while (offset < bytes.length) {
      if (this.sendCredit === 0 && !this.destroyed) await new Promise<void>((resolve) => { this.creditWait = resolve })
      if (this.destroyed) throw new Error('SSH process stream closed during a write')
      const size = Math.min(CHUNK, this.sendCredit, bytes.length - offset)
      this.sendCredit -= size
      await this.sendData(this, bytes.subarray(offset, offset + size))
      offset += size
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    void this.attached.then(async () => {
      this.sentEnd = true
      await this.send({ type: 'stream.end', id: this.id })
    }).then(() => { callback() }, (error: unknown) => { callback(streamError(error)) })
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.remove()
    this.ready.reject(error ?? new Error('SSH process stream closed before attachment'))
    this.wakeWriter()
    if (!this.remoteClosed && (this.role === 'opening' || this.connected) && !(this.sentEnd && this.receivedEnd)) {
      void this.send({ type: 'stream.reset', id: this.id }).catch(() => {})
    }
    callback(error)
  }

  private wakeWriter(): void {
    const wake = this.creditWait
    this.creditWait = undefined
    wake?.()
  }
}

/** Owns stream reservations, receive windows and fair scheduling of bounded binary writes. */
export class SshStreamMux {
  private readonly streams = new Map<SshStreamId, LogicalStream>()
  private dataTail = Promise.resolve()
  private failure: Error | undefined

  constructor(
    private readonly limit: number,
    private readonly send: SendFrame,
    private readonly write: (payload: Buffer) => Promise<void>,
  ) {}

  /**
   * Reserve a stream for the client to attach before the remote process starts.
   * @returns the reserved stream and its attachment promise.
   */
  reserve(): SshStreamReservation {
    const id = randomUUID() as SshStreamId
    const stream = this.create(id, 'reserved')
    return { id, stream, attached: stream.attached }
  }

  /**
   * Attach a stream advertised by the helper and bind it to the caller's lifetime.
   * @param id - the reservation from the current helper connection.
   * @param signal - cancellation through stream closure.
   * @returns the paused duplex after acknowledgement.
   */
  async open(id: SshStreamId, signal?: AbortSignal): Promise<Duplex> {
    signal?.throwIfAborted()
    const stream = this.create(id, 'opening')
    const abort = (): void => { stream.destroy(new Error('SSH process stream cancelled', { cause: signal?.reason })) }
    signal?.addEventListener('abort', abort, { once: true })
    stream.once('close', () => { signal?.removeEventListener('abort', abort) })
    try {
      await Promise.all([this.send({ type: 'stream.open', id }), stream.attached])
      signal?.throwIfAborted()
      return stream
    } catch (error) {
      stream.destroy()
      throw error
    }
  }

  /**
   * Apply a validated stream-control message to its reservation.
   * @param frame - control message from the same SSH peer.
   */
  receive(frame: StreamFrame): void {
    const stream = this.streams.get(frame.id)
    if (frame.type === 'stream.open') {
      if (stream?.role !== 'reserved' || stream.isConnected) {
        this.reply({ type: 'stream.reset', id: frame.id })
        return
      }
      stream.attach()
      this.reply({ type: 'stream.ready', id: frame.id })
      return
    }
    if (stream === undefined) return // A frame can cross a stream reset in flight.
    switch (frame.type) {
      case 'stream.ready':
        if (stream.role !== 'opening' || stream.isConnected) throw new Error('SSH helper acknowledged an unexpected stream')
        stream.attach()
        break
      case 'stream.credit': stream.credit(frame.bytes); break
      case 'stream.end': stream.receiveEnd(); break
      case 'stream.reset': stream.remoteReset(new Error('SSH process stream was reset by its peer')); break
    }
  }

  /**
   * Deliver one bounded binary frame without waiting for the stream's reader.
   * @param payload - the ASCII identifier followed by nonempty data.
   */
  receiveData(payload: Buffer): void {
    if (payload.length <= ID_BYTES) throw new Error('SSH helper sent an empty stream data frame')
    const id = sshStreamIdSchema.parse(payload.toString('latin1', 0, ID_BYTES))
    this.streams.get(id)?.receive(payload.subarray(ID_BYTES))
  }

  /**
   * Fail all streams after losing the private transport.
   * @param error - the connection failure.
   */
  close(error: Error): void {
    this.failure = error
    for (const stream of this.streams.values()) stream.remoteReset(error)
  }

  private create(id: SshStreamId, role: LogicalStream['role']): LogicalStream {
    if (this.failure !== undefined) throw this.failure
    if (this.streams.has(id) || this.streams.size >= this.limit) throw new Error('SSH process stream capacity unavailable')
    const stream = new LogicalStream(id, role, this.send, (owner, bytes) => this.enqueueData(owner, bytes), () => {
      this.streams.delete(id)
    })
    this.streams.set(id, stream)
    return stream
  }

  private reply(frame: StreamFrame): void {
    void this.send(frame).catch((error: unknown) => { this.close(streamError(error)) })
  }

  private enqueueData(stream: LogicalStream, bytes: Buffer): Promise<void> {
    // Each stream queues at most one chunk. Only one enters the shared writer at a time.
    const write = this.dataTail.then(async () => {
      if (stream.destroyed) throw new Error('SSH process stream closed during a write')
      await this.write(Buffer.concat([Buffer.from(stream.id, 'ascii'), bytes]))
    })
    this.dataTail = write.catch(() => {})
    return write
  }
}
