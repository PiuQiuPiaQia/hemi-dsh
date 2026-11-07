/** Concurrent model connection probes over the real LlmRuntime, gated per request by the spec. */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import LlmRuntime, { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { PeerId, RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import HemiModelSettings from '../src/index.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** Test-only non-owner caller used by this spec. */
    'model-test-guest': { readonly kind: 'model-test-guest' }
  }
}

/** One held-open model request: the dispatched options plus a spec-owned response gate. */
interface GatedProbe {
  /** Fully assembled request the runtime dispatched for this probe. */
  readonly options: GenerateOptions
  /** Resolves with the chunks the probe then emits, or the error it throws instead. */
  readonly response: PromiseWithResolvers<readonly StreamChunk[] | Error>
}

/**
 * Adapter whose model requests wait behind per-probe gates: every `stream()`
 * call registers a probe and emits nothing until the spec opens its gate, so
 * probes overlap at spec-chosen points. An aborted request refuses to emit its
 * gated response, like a transport that observes cancellation on its next
 * event.
 */
class GatedAdapter extends LlmAdapter {
  readonly probes: GatedProbe[] = []
  private readonly entries: PromiseWithResolvers<undefined>[] = []
  private nextEntry = 0

  /** Barrier resolving once the probe with this ordinal is inside its stream. */
  entered(ordinal: number): Promise<'entered'> {
    while (this.entries.length <= ordinal) this.entries.push(Promise.withResolvers<undefined>())
    return this.entries[ordinal]!.promise.then(() => 'entered' as const)
  }

  /** Open the gate of an entered probe; its stream then emits `chunks`. */
  release(ordinal: number, chunks: readonly StreamChunk[]): void {
    this.script(ordinal).resolve(chunks)
  }

  /** Open the gate of an entered probe; its stream then throws `error`. */
  fail(ordinal: number, error: Error): void {
    this.script(ordinal).resolve(error)
  }

  private script(ordinal: number): PromiseWithResolvers<readonly StreamChunk[] | Error> {
    const probe = this.probes[ordinal]
    if (probe === undefined) throw new Error(`probe ${ordinal} never entered its stream`)
    return probe.response
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const probe: GatedProbe = { options, response: Promise.withResolvers() }
    this.probes.push(probe)
    while (this.entries.length <= this.nextEntry) this.entries.push(Promise.withResolvers<undefined>())
    this.entries[this.nextEntry]!.resolve(undefined)
    this.nextEntry += 1
    const outcome = await probe.response.promise
    if (outcome instanceof Error) throw outcome
    for (const chunk of outcome) {
      if (options.signal?.aborted) throw new Error('gated probe aborted before emitting its response')
      yield chunk
    }
  }
}

/** Successful response carrying exactly the expected test tool call. */
function toolCallResponse(): readonly StreamChunk[] {
  const id = ToolCallId('probe-call')
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name: 'model_connection_test', argumentsDelta: '{}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'model_connection_test', arguments: '{}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** Successful plain-text response without any tool call. */
function textResponse(text: string): readonly StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

interface Host {
  readonly ctx: Context
  readonly service: HemiModelSettings
  readonly adapter: GatedAdapter
}

/** Real LlmRuntime with a gated adapter and the mounted settings service. */
async function setupHost(): Promise<Host> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  const adapter = new GatedAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(HemiModelSettings, {})
  return { ctx, service: ctx.hemiModelSettings, adapter }
}

const contexts: Context[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

/**
 * Prove `probe` entered its model stream before it settled: a service that
 * refuses or queues the call settles first, because that ordinal's entry
 * promise never resolves.
 * @param probe - promise returned by `testModel`.
 * @param adapter - gated adapter owning the probe's stream.
 * @param ordinal - registration ordinal of the expected probe.
 */
async function expectStreaming(probe: Promise<boolean>, adapter: GatedAdapter, ordinal: number): Promise<void> {
  const settled = probe.then(
    value => `settled:resolved:${String(value)}`,
    (error: unknown) => `settled:rejected:${error instanceof Error ? error.message : String(error)}`,
  )
  expect(await Promise.race([adapter.entered(ordinal), settled])).toBe('entered')
}

it('streams concurrent probes independently and settles them in reverse order', async () => {
  const { service, adapter } = await setupHost()
  const first = service.testModel('mock', 'alpha', new AbortController().signal)
  await adapter.entered(0)
  const second = service.testModel('mock', 'beta', new AbortController().signal)
  await expectStreaming(second, adapter, 1)
  expect(adapter.probes.map(probe => probe.options.model)).toEqual(['alpha', 'beta'])
  adapter.release(1, toolCallResponse())
  await expect(second).resolves.toBe(true)
  adapter.release(0, textResponse('no tool call'))
  await expect(first).resolves.toBe(false)
})

it('sends one bounded synthetic request without session identity or extra history', async () => {
  const { service, adapter } = await setupHost()
  const probe = service.testModel('mock', 'alpha', new AbortController().signal)
  await adapter.entered(0)
  const request = adapter.probes[0]!.options
  expect(request.provider).toBe('mock')
  expect(request.model).toBe('alpha')
  expect(request.maxTokens).toBe(128)
  expect(request.sessionId).toBeUndefined()
  expect(request.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Call the model_connection_test tool with no arguments.' }] }])
  expect(request.tools).toEqual([{
    name: 'model_connection_test',
    description: 'Confirm that this model supports tool calls.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  }])
  adapter.release(0, toolCallResponse())
  await expect(probe).resolves.toBe(true)
})

it('cancels one probe through its own signal without disturbing a concurrent probe', async () => {
  const { service, adapter } = await setupHost()
  const firstController = new AbortController()
  const first = service.testModel('mock', 'alpha', firstController.signal)
  await adapter.entered(0)
  const second = service.testModel('mock', 'beta', new AbortController().signal)
  await expectStreaming(second, adapter, 1)
  firstController.abort()
  adapter.release(0, toolCallResponse())
  await expect(first).rejects.toMatchObject({ code: 'hemi/model-test-failed' })
  adapter.release(1, toolCallResponse())
  await expect(second).resolves.toBe(true)
})

it('fails one probe without disturbing a concurrent probe', async () => {
  const { service, adapter } = await setupHost()
  const first = service.testModel('mock', 'alpha', new AbortController().signal)
  await adapter.entered(0)
  const second = service.testModel('mock', 'beta', new AbortController().signal)
  await expectStreaming(second, adapter, 1)
  adapter.fail(0, new Error('provider connection refused'))
  await expect(first).rejects.toMatchObject({ code: 'hemi/model-test-failed' })
  adapter.release(1, toolCallResponse())
  await expect(second).resolves.toBe(true)
})

it('expires one probe on its own deadline without disturbing a concurrent probe', async () => {
  const { service, adapter } = await setupHost()
  const deadline = new AbortController()
  const timeout = vi.spyOn(AbortSignal, 'timeout')
  timeout.mockImplementationOnce(() => deadline.signal)
  const first = service.testModel('mock', 'alpha', new AbortController().signal)
  await adapter.entered(0)
  expect(timeout).toHaveBeenCalledExactlyOnceWith(25_000)
  const second = service.testModel('mock', 'beta', new AbortController().signal)
  await expectStreaming(second, adapter, 1)
  deadline.abort()
  adapter.release(0, toolCallResponse())
  await expect(first).rejects.toMatchObject({ code: 'hemi/model-test-timeout' })
  adapter.release(1, toolCallResponse())
  await expect(second).resolves.toBe(true)
})

it('classifies a response that ends without a finish chunk as a failed test', async () => {
  const { service, adapter } = await setupHost()
  const probe = service.testModel('mock', 'alpha', new AbortController().signal)
  await adapter.entered(0)
  adapter.release(0, [])
  await expect(probe).rejects.toMatchObject({ code: 'hemi/model-test-failed' })
})

it('classifies a stream middleware failure as a failed test', async () => {
  const { ctx, service } = await setupHost()
  ctx.on('llm/stream', () => (async function * (): AsyncGenerator<StreamChunk> {
    throw new Error('middleware failed')
  })())
  await expect(service.testModel('mock', 'alpha', new AbortController().signal))
    .rejects.toMatchObject({ code: 'hemi/model-test-failed' })
})

it('refuses a non-owner peer while owner probes keep running', async () => {
  const { ctx, service, adapter } = await setupHost()
  const owner = service.testModel('mock', 'alpha', new AbortController().signal)
  await adapter.entered(0)
  const invocation: RemoteInvocation = {
    request: { namespace: 'hemiModelSettings', method: 'testModel', args: {} },
    service: 'hemiModelSettings',
    peer: {
      id: 'model-test-spec-peer' as PeerId,
      ctx,
      principal: { kind: 'model-test-guest' },
      signal: new AbortController().signal,
      interactions: 'none',
      dispose: () => Promise.resolve(),
    },
    signal: new AbortController().signal,
    uplink: () => {
      throw new Error('this spec sends no uplink')
    },
  }
  const guest = ctx.extend({ invocation }).get('hemiModelSettings')
  if (guest === undefined) throw new Error('hemiModelSettings service was not mounted')
  await expect(guest.testModel('mock', 'beta', new AbortController().signal))
    .rejects.toMatchObject({ code: 'hemi/model-test-forbidden' })
  expect(adapter.probes).toHaveLength(1)
  adapter.release(0, toolCallResponse())
  await expect(owner).resolves.toBe(true)
})
