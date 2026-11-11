/** Real helper and logical process streams over an in-memory transport. */
import { PassThrough } from 'node:stream'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { runSshHelper } from '../../src/helper.ts'
import { SshRpcPeer, SSH_PROTOCOL_VERSION } from '../../src/protocol.ts'
import { helloSchema } from '../../src/schemas.ts'
import type { SshStreamId } from '../../src/streams.ts'

export function createStreamPeers(handler?: ConstructorParameters<typeof SshRpcPeer>[4]) {
  const input = new PassThrough()
  const output = new PassThrough()
  const helper = new SshRpcPeer(input, output, 64 * 1024 * 1024, 128, handler)
  const client = new SshRpcPeer(output, input, 64 * 1024 * 1024, 128)
  return { helper, client, close: () => { client.close(); helper.close() } }
}

export async function createHelperHarness(handshake = true, leaseMs = 30_000, kind: 'node-script' | 'executable' = 'node-script') {
  const root = await realpath(await mkdtemp('/tmp/dsh-ssh-rpc-'))
  const input = new PassThrough()
  const output = new PassThrough()
  const controller = new AbortController()
  const serving = runSshHelper({ input, output, kind, entryPath: fileURLToPath(new URL('../../src/helper-entry.ts', import.meta.url)), signal: controller.signal })
  void serving.catch(() => {})
  const client = new SshRpcPeer(output, input, 64 * 1024 * 1024, 128)
  const hello = () => client.request('hello', { protocol: SSH_PROTOCOL_VERSION, workspace: root, leaseMs }, helloSchema)
  let closing: Promise<void> | undefined
  const close = () => {
    closing ??= (async () => {
      client.close()
      controller.abort()
      try { await serving } finally { await rm(root, { recursive: true, force: true }) }
    })()
    return closing
  }
  const connectStream = (id: SshStreamId, signal?: AbortSignal) => client.openStream(id, signal)
  let facts: z.infer<typeof helloSchema> | undefined
  try { if (handshake) facts = await hello() } catch (error) { await close(); throw error }
  const connection = {
    ready: Promise.resolve(facts),
    request: <T>(method: string, params: unknown, schema: z.ZodType<T>, signal?: AbortSignal) =>
      client.request(method, params, schema, signal),
    connectStream, dispose: close,
  }
  return { root, client, hello, close, serving, controller, facts, connection, connectStream }
}
