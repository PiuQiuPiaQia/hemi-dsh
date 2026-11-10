/** Execution identity survives every JSONL header and cold-restoration path. */
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { Session, SessionId, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { ExecutionProviderId, ExecutionTargetId, SessionHeader } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '../src/index.ts'
import { logPath, type JsonlCompression } from '../src/format.ts'
import { compressZstdFrame } from '../src/zstd.ts'

async function fixture(compression: JsonlCompression) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-execution-target-'))
  const contexts: Context[] = []
  onTestFinished(async () => {
    try {
      const results = await Promise.allSettled(contexts.map(ctx => ctx.fiber.dispose()))
      const failures: unknown[] = results.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length > 0) throw new AggregateError(failures, 'execution target fixture cleanup failed')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  const open = async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(JsonlPersistence, { root, compression })
    return ctx
  }
  return { root, open }
}

it.each(['none', 'zstd'] as const)('cold-reads targeted and default Sessions without merging their execution identities: %s', async (compression: JsonlCompression) => {
  const { open } = await fixture(compression)
  const target = { provider: brandString<ExecutionProviderId>('ssh'), id: brandString<ExecutionTargetId>('folder-1') }
  const metadata: SessionHeader = {
    version: SESSION_FORMAT_VERSION, id: SessionId('remote'), createdAt: 1, isSeeded: false,
    cwd: '/same/project', executionTarget: target,
  }
  const first = await open()
  const writer = await first.sessionPersistence.create(metadata)
  await writer.append([
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  await writer.flush()
  await writer.close()
  const { executionTarget: _target, ...localMetadata } = metadata
  const local = await first.sessionPersistence.create({ ...localMetadata, id: SessionId('local') })
  await local.flush()
  await local.close()
  const empty = await first.sessionPersistence.create({ ...metadata, id: SessionId('remote-empty') })
  await empty.flush()
  await empty.close()
  await first.fiber.dispose()

  const cold = await open()
  expect((await cold.sessionPersistence.stat(metadata.id))?.header.executionTarget).toEqual(target)
  const listed = await cold.sessionPersistence.list()
  expect(listed.find(item => item.header.id === SessionId('local'))?.header.executionTarget).toBeUndefined()
  expect(listed.find(item => item.header.id === metadata.id)?.header.executionTarget).toEqual(target)
  const reader = await cold.sessionPersistence.open(metadata.id, 'read')
  const body = await reader.read()
  const restored = Session.fromRestore(metadata.id, body.events, reader.header, reader.inheritedEventCount, body.eventState)
  expect(restored.header.executionTarget).toEqual(target)
  expect(Object.isFrozen(restored.header.executionTarget)).toBe(true)
  expect(body.events.map(event => event.type)).toEqual(['turn/start', 'turn/end'])
  await reader.close()
  const emptyReader = await cold.sessionPersistence.open(SessionId('remote-empty'), 'write')
  expect(emptyReader.header.executionTarget).toEqual(target)
  expect((await emptyReader.read()).events).toEqual([])
  await emptyReader.close()
})

it.each([['none', 'read'], ['none', 'write'], ['zstd', 'read'], ['zstd', 'write']] as const)(
  'refuses an invalid execution reference before recovering a torn tail: %s/%s',
  async (compression, access) => {
    const { root, open } = await fixture(compression)
    for (const valid of [true, false]) {
      const id = SessionId(valid ? 'valid-target-torn-tail' : 'invalid-target-torn-tail')
      const path = logPath(root, '/project', id, compression)
      const header = JSON.stringify({
        type: 'session', version: SESSION_FORMAT_VERSION, id, createdAt: 1, cwd: '/project',
        isSeeded: false, delegationDepth: 0, executionTarget: { provider: 'ssh', id: valid ? 'folder-1' : '' },
      }) + '\n'
      const event = JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }) + '\n'
      const parts = [header, event, '{"type":']
      let bytes: Buffer
      if (compression === 'none') {
        bytes = Buffer.from(parts.join(''))
      } else {
        const tail = await compressZstdFrame('{"type":')
        bytes = Buffer.concat([await compressZstdFrame(header), await compressZstdFrame(event), tail.subarray(0, -1)])
      }
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, bytes)
      const ctx = await open()
      if (valid) {
        const handle = await ctx.sessionPersistence.open(id, access)
        try {
          expect(handle.header.executionTarget?.id).toBe('folder-1')
          expect((await handle.read()).events.map(row => row.type)).toEqual(['turn/start'])
        } finally { await handle.close() }
      } else {
        await expect(ctx.sessionPersistence.open(id, access)).rejects.toThrow(/executionTarget|session header/)
      }
      expect(await readFile(path)).toEqual(bytes)
    }
  },
)
