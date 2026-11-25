/** A fallback Coding Plan model reaches the Anthropic Messages wire with adaptive thinking and its effort. */
import { expect, it, vi } from 'vitest'
import { normalizeContext } from '@earendil-works/pi-ai'
import type { AssistantMessageEvent, CredentialStore } from '@earendil-works/pi-ai'
import { bigModelCodingProvider } from '#bigmodel-protocol'
import { bigModelCatalog } from '../src/bigmodel/index.ts'
import { PROTOCOL_REASONING_DEFAULTS } from '../src/protocol-reasoning.ts'

/** Request bodies the Coding Plan transport received. */
const captured = vi.hoisted((): Record<string, unknown>[] => [])

vi.mock('../legacy/bigmodel/bigmodel-coding-transport.mjs', () => ({
  // Record each request and refuse it: the test reads the body and needs no model reply.
  createCodingTransport: () => ({
    forRequest: () => async (_input: unknown, init: RequestInit) => {
      if (typeof init.body !== 'string') throw new Error('The request body is not JSON text.')
      captured.push(JSON.parse(init.body) as Record<string, unknown>)
      return Response.json(
        { type: 'error', error: { type: 'invalid_request_error', message: 'captured' } }, { status: 400 })
    },
  }),
}))

/** A store no request reaches: the recorded transport never reads credentials. */
const UNUSED_STORE: CredentialStore = {
  read: async () => undefined,
  list: async () => [],
  modify: async (_provider, update) => update(undefined),
  delete: async () => {},
}

const LEVELS = ['low', 'medium', 'max'] as const

it('sends a new Coding Plan model with adaptive thinking and the selected effort', async () => {
  const provider = bigModelCodingProvider(UNUSED_STORE)
  const model = bigModelCatalog(provider.getModels(), ['GLM-5.4'], undefined, PROTOCOL_REASONING_DEFAULTS).models[0]!
  const context = normalizeContext({ messages: [{ role: 'user', content: 'ping', timestamp: 0 }] })
  for (const reasoning of LEVELS) {
    const events: AssistantMessageEvent[] = []
    for await (const event of provider.streamSimple(model, context, { reasoning, apiKey: 'unused' })) events.push(event)
    const terminal = events.at(-1)
    if (terminal?.type !== 'error') throw new Error(`The refused request ended with "${String(terminal?.type)}".`)
    expect(terminal.error.errorMessage).toContain('captured')
    expect(captured.at(-1)).toMatchObject({
      model: 'GLM-5.4', thinking: { type: 'adaptive' }, output_config: { effort: reasoning },
    })
  }
  expect(captured).toHaveLength(LEVELS.length)
})
