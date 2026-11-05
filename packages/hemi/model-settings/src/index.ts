/** Host operations for the Hemi Models and Routing page. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import { principalOf, Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Model connection tests over the configured LLM runtime. */
    hemiModelSettings: HemiModelSettings
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'hemi/model-test-forbidden': {}
    'hemi/model-test-busy': {}
    'hemi/model-test-failed': {}
    'hemi/model-test-timeout': {}
  }
}

/** Probe a configured route with its actual adapter and saved credential. */
export default class HemiModelSettings extends TypertRemoteService {
  static inject = ['llm']
  private testing = false

  constructor(ctx: Context) {
    super(ctx, 'hemiModelSettings', { namespace: 'hemiModelSettings' })
  }

  /**
   * Send a bounded request and check whether the model returns a test tool call.
   * @param provider - configured provider ID.
   * @param model - model ID.
   * @param signal - cancellation propagated from the client.
   * @returns whether the model returned the test tool call.
   */
  @Remote
  async testModel(provider: string, model: string, signal: AbortSignal): Promise<boolean> {
    if (principalOf(this.ctx.invocation) !== undefined) {
      throw new RemoteError('hemi/model-test-forbidden', 'Only the profile owner can test models.', {})
    }
    if (this.testing) throw new RemoteError('hemi/model-test-busy', 'A model test is already running.', {})
    this.testing = true
    const deadline = AbortSignal.timeout(25_000)
    const requestSignal = AbortSignal.any([signal, deadline])
    try {
      let called = false
      for await (const chunk of this.ctx.llm.stream({
        provider, model, signal: requestSignal, maxTokens: 128,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Call the model_connection_test tool with no arguments.' }] }],
        tools: [{ name: 'model_connection_test', description: 'Confirm that this model supports tool calls.',
          parameters: { type: 'object', properties: {}, additionalProperties: false } }],
      })) {
        if (chunk.type === 'block-end' && chunk.block.type === 'tool-call' && chunk.block.name === 'model_connection_test') called = true
        if (chunk.type === 'finish' && chunk.reason.kind !== 'error' && chunk.reason.kind !== 'aborted') return called
      }
      throw new RemoteError('hemi/model-test-failed', 'The model request did not complete. Check the provider configuration.', {})
    } catch (error: unknown) {
      if (deadline.aborted) throw new RemoteError('hemi/model-test-timeout', 'The model test timed out.', {})
      if (error instanceof RemoteError) throw error
      throw new RemoteError('hemi/model-test-failed', 'The model request did not complete. Check the provider configuration.', {})
    } finally {
      this.testing = false
    }
  }
}
