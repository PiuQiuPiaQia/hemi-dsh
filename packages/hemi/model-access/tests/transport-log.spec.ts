/** Exercise Codex WebSocket close frames through the real SDK, adapter and local log sink. */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { mountTransportLog } from '../src/transport-log.ts'

afterEach(() => { vi.unstubAllEnvs() })

it.each([true, false])('logs a 1012 close after response starts: %s', async (started) => {
  const home = await mkdtemp(join(tmpdir(), 'hemi-codex-transport-'))
  const ctx = new Context()
  const account = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url')
  const token = `e30.${account}.fixture`
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('HEMI_CODEX_FIXTURE_TOKEN', token)

  const created = { type: 'response.created', response: { id: 'resp_fixture' } }
  const item = { type: 'message', id: 'msg_fixture', role: 'assistant', content: [{ type: 'output_text', text: 'fallback reply', annotations: [] }] }
  let sseRequests = 0
  const server = createServer((request, response) => {
    sseRequests++
    request.resume()
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const frames = [
      created,
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [item] } },
    ]
    response.end(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''))
  })
  const sockets = new WebSocketServer({ server })
  onTestFinished(async () => {
    for (const socket of sockets.clients) socket.terminate()
    await Promise.all([
      new Promise<void>((resolve) => { sockets.close(() => { resolve() }) }),
      new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }),
      ctx.fiber.dispose(),
    ])
    await rm(home, { recursive: true, force: true })
  })
  const closeReason = 'fixture close text must stay out of the log'
  sockets.on('connection', (socket) => {
    socket.once('message', () => {
      if (started) socket.send(JSON.stringify(created))
      socket.close(1012, closeReason)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing fixture port')

  await ctx.plugin(LlmRuntime)
  await ctx.plugin(PiAi, {
    providers: { 'openai-codex': {
      baseURL: `http://127.0.0.1:${address.port}`, apiKeyEnv: 'HEMI_CODEX_FIXTURE_TOKEN', transport: 'auto',
      models: [{ id: 'gpt-5.5' }],
    } },
  })
  const log = ctx.plugin({ name: 'hemi-transport-log-fixture', apply: mountTransportLog })
  await log
  const sessionId = `session-codex-transport-fixture-${started}` as NonNullable<GenerateOptions['sessionId']>
  const prompt = 'fixture prompt must stay out of the log'
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream({
    provider: 'openai-codex', model: 'gpt-5.5', sessionId,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  })) assembler.push(chunk)
  const finish = assembler.finish
  if (started && finish.kind === 'error') {
    expect(finish.failure.code).toBe('PI_AI_ERROR')
    expect(finish.failure.message).toContain('WebSocket closed 1012')
  }
  expect(finish.kind).toBe(started ? 'error' : 'stop')
  expect(sseRequests).toBe(started ? 0 : 1)

  await log.dispose()
  const contents = await readFile(join(home, 'logs', 'codex-websocket.jsonl'), 'utf8')
  const { timestamp, elapsedMs, fullRequestBytes, ...diagnostic } = JSON.parse(contents) as Record<string, unknown>
  expect(typeof timestamp).toBe('number')
  expect(typeof elapsedMs).toBe('number')
  expect(typeof fullRequestBytes).toBe('number')
  expect(diagnostic).toEqual({
    sessionId, provider: 'openai-codex', model: 'gpt-5.5', transport: 'websocket', configuredTransport: 'auto',
    closeCode: 1012,
    ...started ? { phase: 'after_message_stream_start', outcome: 'failed' }
      : { phase: 'before_message_stream_start', fallbackTransport: 'sse', outcome: 'completed' },
  })
  expect(contents).not.toContain(closeReason)
  expect(contents).not.toContain(prompt)
  expect(contents).not.toContain(token)
})
