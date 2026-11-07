/** Recorded native role delivery: model binding does not change activation lifetime or inbox results. */
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  fixtureContext, formatSystemPromptSnapshot, formatToolSchemasSnapshot, normalizedSystemPrompts,
  normalizedToolSchemas, normalizeSessionSnapshot, normalizeSessionSnapshots, redactSessionSnapshotIds,
} from '@deepseek-ai/dsh-session-snapshot'
import type {} from '../../../packages/hemi/routing/src/settings.ts'
import { ScriptedAdapter, textResponse, toolCallResponse } from '../../../packages/hemi/routing/tests/mock-llm.ts'
import {
  assertFixtureInventory, fixtureUserPrompts, launchWebScaffold, normalizeWebSessionVolatiles,
  rawSessionLog, webSnapshotMode,
} from './scaffold.ts'

const DIR = fileURLToPath(new URL('../../../snapshots/web/hemi-role-delivery', import.meta.url))
const PATHS = ['session.v4.jsonl', 'session.1.v4.jsonl'].map(file => join(DIR, file))
const MODE = webSnapshotMode()
const BRANDING = fileURLToPath(new URL('./hemi-branding.overlay.yml', import.meta.url))

it.skipIf(MODE === 'record')('replays native activation receipts and completion notices with role-bound model options', async () => {
  const bootstrap = MODE === 'refresh' && !existsSync(PATHS[0]!)
  const expected = bootstrap ? [] : await Promise.all(PATHS.map(path => readFile(path, 'utf8')))
  const scaffold = await launchWebScaffold(bootstrap ? {
    compareReplaySession: true, deepSeekMissingCredential: true, extraOverlayPath: BRANDING,
  } : {
    extraOverlayPath: BRANDING,
    deepSeekMissingCredential: true,
    replayFixture: PATHS[0]!, replayChildFixtures: [PATHS[1]!], compareReplaySession: false,
    replayProviders: [{ id: 'hemi-delivery-test', name: 'Role delivery fixture', models: [
      { id: 'main', name: 'Main' },
      { id: 'oracle', name: 'Oracle', reasoningEfforts: ['high'] },
    ] }],
  })
  const released = Promise.withResolvers<undefined>()
  try {
    if (bootstrap) scaffold.ctx.llm.registerAdapter(['hemi-delivery-test'], new ScriptedAdapter([
      toolCallResponse('native-oracle', 'subagent', {
        agent_preset: 'oracle', description: 'Analyze the task', prompt: 'Report the analysis.',
      }),
      textResponse('I can continue while the analysis runs.'),
      textResponse('The analysis is complete.'),
      textResponse('I received the analysis through the inbox.'),
    ]))
    const sessions: Session[] = []
    const childReady = Promise.withResolvers<undefined>()
    const childEnded = Promise.withResolvers<undefined>()
    scaffold.ctx.on('session/created', (session) => { sessions.push(session) })
    scaffold.ctx.on('subagent/end', () => { childEnded.resolve(undefined) })
    scaffold.ctx.on('agent/pre-step', async ({ agent }, next) => {
      if (agent.session.header.origin === 'subagent') {
        childReady.resolve(undefined)
        await released.promise
      }
      return next()
    })
    await scaffold.ctx.settings.mutate('hemi-routing-settings', [
      { op: 'set', path: ['main'], value: { provider: 'hemi-delivery-test', model: 'main' } },
      { op: 'set', path: ['roles'], value: { oracle: { provider: 'hemi-delivery-test', model: 'oracle', reasoningEffort: 'high' } } },
    ])
    const { sessionId } = await scaffold.ctx.sessionController.create({ cwd: scaffold.workspaceCwd })
    const parent = scaffold.ctx.agents.get(sessionId)
    if (parent === undefined) throw new Error('Snapshot parent was not created')
    await scaffold.ctx.hemiRoutingSettings.setEnabled(parent, true)
    const prompt = bootstrap ? 'Delegate the independent analysis to oracle.' : fixtureUserPrompts(expected[0]!)[0]
    if (prompt === undefined) throw new Error('Snapshot has no user task')
    parent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
    await parent.whenIdle()
    await childReady.promise
    const receipt = parent.session.snapshotEvents().find(event => event.type === 'tool/result')
    expect(receipt?.data.message.isError).toBe(false)
    expect(receipt?.data.meta).toMatchObject({ kind: 'activation' })
    expect(receipt?.data.meta).not.toHaveProperty('completed')
    expect(JSON.stringify(receipt?.data.message.content)).toContain('started subagent')
    expect(parent.session.snapshotEvents().filter(event => event.type === 'turn/end')).toHaveLength(1)
    expect(sessions).toHaveLength(2)
    const child = sessions.find(session => session.header.origin === 'subagent')
    if (child === undefined) throw new Error('Snapshot child was not created')
    expect(child.header.agentPreset).toBe('oracle')
    expect(child.snapshotEvents().some(event => event.type === 'assistant/message')).toBe(false)
    released.resolve(undefined)
    await childEnded.promise
    await parent.whenIdle()
    expect(parent.session.snapshotEvents().filter(event => event.type === 'turn/end')).toHaveLength(2)
    expect(JSON.stringify(parent.session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.source.kind === 'subagent-settled'))).toContain('The analysis is complete.')
    expect(child.snapshotEvents().find(event => event.type === 'request/context')?.data)
      .toMatchObject({ provider: 'hemi-delivery-test', model: 'oracle' })
    const raw = [parent.session, child].map(session => normalizeWebSessionVolatiles(rawSessionLog(session), scaffold.workspaceCwd))
    const context = { sessionIds: [parent.id, child.id], cwd: scaffold.workspaceCwd }
    const prompts = raw.flatMap(log => normalizedSystemPrompts(log, context))
    expect(prompts[0]).toContain('You are an AI agent powered by Hemi.')
    expect(prompts[0]).not.toContain('powered by DeepSeek Harness')
    const schemas = raw.flatMap(log => normalizedToolSchemas(log, context))
    const promptPin = formatSystemPromptSnapshot(prompts[0]!, prompts.slice(1))
    const schemaPin = formatToolSchemasSnapshot(schemas[0]!, schemas.slice(1))
    if (MODE === 'refresh') {
      const logs = redactSessionSnapshotIds(raw.map(log => normalizeSessionSnapshot(log, context, { identityMode: 'preserve' })))
      await Promise.all(logs.map((log, index) => writeFile(PATHS[index]!, log)))
      await writeFile(join(DIR, 'system-prompt.expected.md'), promptPin)
      await writeFile(join(DIR, 'tool-schemas.expected.json'), schemaPin)
    }
    const fixtures = await Promise.all(PATHS.map(path => readFile(path, 'utf8')))
    expect(normalizeSessionSnapshots(raw, context)).toEqual(normalizeSessionSnapshots(fixtures, fixtureContext(fixtures[0]!)))
    expect(promptPin).toBe(await readFile(join(DIR, 'system-prompt.expected.md'), 'utf8'))
    expect(schemaPin).toBe(await readFile(join(DIR, 'tool-schemas.expected.json'), 'utf8'))
    await assertFixtureInventory(DIR, ['session.v4.jsonl', 'session.1.v4.jsonl', 'system-prompt.expected.md', 'tool-schemas.expected.json'])
  } finally {
    released.resolve(undefined)
    await scaffold.close()
  }
})
