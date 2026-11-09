/** The real Loader and AgentLoop exercise lifecycle effects against isolated memory files. */
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { EntryTree } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import BasicCompaction from '@deepseek-ai/dsh-compaction-basic'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import type { SessionFormatArtifact } from '@deepseek-ai/dsh-session-format'
import { restoreReleasedV4Artifact } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as memory from '../src/index.ts'
import { ScriptedAdapter, textResponse, type ScriptEntry } from '../../routing/tests/mock-llm.ts'
import { readStore, storePath, writeStore } from '../src/store.ts'

const roots: string[] = []
const contexts: Context[] = []
const originalHome = process.env.DSH_HOME
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
})

async function fixture(script: ScriptEntry[] = [textResponse('已确定方案'), textResponse('保留这项决定')], timeoutMs = 3500) {
  const root = await mkdtemp(join(tmpdir(), 'hemi-memory-lifecycle-'))
  roots.push(root)
  process.env.DSH_HOME = root
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new ScriptedAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const yaml = await readFile(new URL('./fixture/cordis.yml', import.meta.url), 'utf8')
  await writeFile(join(root, 'cordis.yml'), yaml + `  config:\n    summaryTimeoutMs: ${timeoutMs}\n`)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  vi.spyOn(EntryTree.prototype, 'import').mockImplementation(async (specifier: string) => {
    if (specifier === 'cordis:include') return Include
    if (specifier !== '@deepseek-ai/dsh-hemi-memory') throw new Error(specifier)
    return memory
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(root, 'cordis.yml')).href } })
  await ctx.loader.await()
  const handle = await ctx.agents.create({
    sessionId: SessionId('main'),
    agentOptions: { provider: 'mock', model: 'current' }, meta: { cwd: root },
  })
  const turn = async (text = '采用这个方案') => {
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
  }
  return { ctx, root, handle, adapter, turn }
}

it('loads updates on every turn and waits for exactly one close summary', async () => {
  const { handle, adapter, turn } = await fixture([
    textResponse('first'), textResponse('second'), textResponse('最终决定'),
  ])
  await writeStore(storePath('long_term', undefined), 'SHARED_FACT_ONE')
  await turn()
  await writeStore(storePath('long_term', undefined), 'SHARED_FACT_TWO')
  await turn()
  expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('SHARED_FACT_ONE')
  expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('SHARED_FACT_TWO')
  expect(adapter.requests).toHaveLength(2)
  await Promise.all([handle.dispose(), handle.dispose()])
  expect(adapter.requests).toHaveLength(3)
  expect(adapter.requests[2]?.purpose).toBe('hemi-memory-summary')
  expect(adapter.requests[2]?.model).toBe('current')
  expect(await readStore(storePath('daily', undefined))).toContain('最终决定')
  const results = handle.agent.session.snapshotEvents().filter(event => event.type === 'hemi-memory/summary-result')
  expect(results).toHaveLength(1)
  expect(results[0]?.data).toMatchObject({ outcome: 'saved', usage: { inputTokens: 10 } })
  expect(results[0]?.ignorable).toBe(true)
  const summaryRequest = handle.agent.session.snapshotEvents().find(event => event.type === 'hemi-memory/summary-request')
  expect(summaryRequest?.ignorable).toBe(true)
  expect(summaryRequest?.data.messages).toEqual(adapter.requests[2]?.messages)
  expect(summaryRequest?.data.messages).toMatchObject([{ role: 'user' }])
  expect(summaryRequest?.data.messages[0]).not.toHaveProperty('source')
  expect(summaryRequest?.data.messages[0]).not.toHaveProperty('id')
  const artifact = JSON.parse(JSON.stringify({
    header: { delegationDepth: 0, ...handle.agent.session.header },
    inheritedEventCount: handle.agent.session.inheritedEventCount,
    events: handle.agent.session.snapshotEvents(),
  })) as SessionFormatArtifact
  const upstreamVocabulary = new Set([...KNOWN_SESSION_EVENT_TYPES].filter(type => !type.startsWith('hemi-memory/')))
  expect(() => restoreReleasedV4Artifact(artifact, upstreamVocabulary)).not.toThrow()
})

it('completes the summary during whole-application disposal', async () => {
  const { ctx, handle, turn } = await fixture()
  await turn()
  const persistence = ctx.sessionPersistence
  await ctx.fiber.dispose()
  const stored = await persistence.open(handle.agent.id, 'read')
  try {
    expect((await stored.read()).events.at(-1)?.type).toBe('hemi-memory/summary-result')
  } finally { await stored.close() }
  expect(handle.agent.session.snapshotEvents().at(-1)?.type).toBe('hemi-memory/summary-result')
  expect(await readStore(storePath('daily', undefined))).toContain('保留这项决定')
})

it('contains summary failures and records an unsuccessful result', async () => {
  const { handle, turn, ctx } = await fixture([textResponse('answer')])
  const warn = vi.spyOn(ctx.logger, 'warn')
  await turn()
  await handle.dispose()
  expect(handle.agent.session.snapshotEvents().at(-1)?.data).toMatchObject({ outcome: 'failed' })
  expect(await readStore(storePath('daily', undefined))).toBe('')
  expect(warn).toHaveBeenCalled()
})

it('leaves blank runtimes without a summary request', async () => {
  const { handle, adapter } = await fixture([])
  await handle.dispose()
  expect(adapter.requests).toHaveLength(0)
})

it('saves the real compaction summary and scratchpad as a handoff', async () => {
  const { ctx, handle, turn } = await fixture([
    textResponse('long answer'), textResponse('COMPACTION_DECISION'), textResponse('exit summary'),
  ])
  await ctx.plugin(TokenMeter)
  await ctx.plugin(BasicCompaction, { auto: false })
  await writeStore(storePath('scratchpad', undefined), 'OPEN_TODO')
  await turn('conversation detail '.repeat(500))
  const result = await ctx.compaction.compactNow(handle.agent, new AbortController().signal)
  expect(result).not.toBeNull()
  await expect.poll(() => readStore(storePath('daily', undefined))).toContain('COMPACTION_DECISION')
  expect(await readStore(storePath('daily', undefined))).toContain('OPEN_TODO')
})

it('skips automatic writes when the plugin is reconfigured', async () => {
  const { ctx, handle, turn, adapter } = await fixture()
  await turn()
  const entry = [...ctx.loader.entries()].find(row => row.options.id === 'memory')
  if (entry?.fiber === undefined) throw new Error('Memory plugin did not load')
  await entry.fiber.dispose()
  await handle.dispose()
  expect(adapter.requests).toHaveLength(1)
  expect(await readStore(storePath('daily', undefined))).toBe('')
})

it('keeps child agents out of automatic memory reads and writes', async () => {
  const { ctx, adapter, root } = await fixture([textResponse('child answer')])
  await writeStore(storePath('long_term', undefined), 'PRIVATE_ROOT_FACT')
  const child = await ctx.agents.create({
    sessionId: SessionId('child'), meta: { origin: 'subagent', parentSession: SessionId('main'), cwd: root },
    agentOptions: { provider: 'mock', model: 'current' },
  })
  child.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'child task' }], source: { kind: 'user' } }))
  await child.agent.whenIdle()
  await child.dispose()
  expect(adapter.requests).toHaveLength(1)
  expect(JSON.stringify(adapter.requests[0]?.messages)).not.toContain('PRIVATE_ROOT_FACT')
  expect(await readStore(storePath('daily', undefined))).toBe('')
})

it('does not summarize restored history again when the user sends no new message', async () => {
  const { ctx, handle, turn, adapter } = await fixture()
  await turn()
  await handle.dispose()
  const resumed = await ctx.agents.resume({
    resumeSessionId: SessionId('main'), agentOptions: { provider: 'mock', model: 'current' },
  })
  await resumed.dispose()
  expect(adapter.requests).toHaveLength(2)
})

it('settles a stalled summary within the configured deadline', async () => {
  const { handle, turn } = await fixture([
    textResponse('answer'),
    options => new Promise((_, reject) => {
      if (options.signal === undefined) throw new Error('Expected cancellation')
      options.signal.addEventListener('abort', () => { reject(new Error('Test summary deadline')) }, { once: true })
    }),
  ], 25)
  await turn()
  await handle.dispose()
  expect(handle.agent.session.snapshotEvents().at(-1)?.data).toMatchObject({ outcome: 'failed', failure: 'timeout' })
  expect(await readStore(storePath('daily', undefined))).toBe('')
})
