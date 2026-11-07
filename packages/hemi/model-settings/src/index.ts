/** Model connection tests and provider-neutral Hemi Desktop setup. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { principalOf, Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Model connection tests over the configured LLM runtime. */
    hemiModelSettings: HemiModelSettings
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'hemi/desktop-setup-forbidden': {}
    'hemi/desktop-setup-unavailable': {}
    'hemi/model-test-forbidden': {}
    'hemi/model-test-busy': {}
    'hemi/model-test-failed': {}
    'hemi/model-test-timeout': {}
  }
}

/** Hemi-owned desktop introduction preferences. */
export interface Config {
  /** Use the workspace without a provider-owned native welcome window. */
  desktopStartup: boolean
  /** Explicitly acknowledged provider-neutral introduction. */
  welcomeCompleted: Volatile<boolean>
}

/** Own explicit model connection probes and local Desktop introduction preferences. */
export default class HemiModelSettings extends TypertRemoteService {
  static inject = ['llm']
  static Config = z.object({ desktopStartup: z.boolean().default(false), welcomeCompleted: z.boolean().default(false).volatile() })
  private testing = false

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'hemiModelSettings', { namespace: 'hemiModelSettings' })
    if (config.desktopStartup) {
      ctx.inject(['systemPrompt'], (scope) => {
        scope.effect(() => scope.systemPrompt.section({
          name: 'harness:identity', order: scope.systemPrompt.getSectionOrder('HARNESS_IDENTITY'),
          text: 'You are an AI agent powered by Hemi.',
        }), 'hemi-model-settings: product identity')
      })
    }
  }

  /**
   * Resolve native startup without consulting any provider or credential.
   * @returns workspace startup preferences, or undefined for native DSH startup.
   */
  desktopStartup(): { mode: 'workspace'; localePreference: string | null } | undefined {
    if (!this.config.desktopStartup) return undefined
    const settings = this.ctx.get('settings')
    if (settings === undefined) throw new Error('Hemi desktop startup requires settings')
    const locale = settings.describe().find(item => item.ns === 'locale')?.value
    const preference = typeof locale === 'object' && locale !== null && 'preference' in locale ? locale.preference : undefined
    if (preference !== undefined && typeof preference !== 'string') throw new Error('Hemi desktop startup: invalid locale preference')
    return { mode: 'workspace', localePreference: preference ?? null }
  }

  /**
   * Read local introduction state while preserving completed legacy setup.
   * @returns completion from the local marker, saved model, or completed legacy introduction.
   */
  @Remote
  desktopWelcome(): { readonly enabled: boolean; readonly completed: boolean } {
    const settings = this.ctx.get('settings')
    const legacy = settings?.describe().find(item => item.ns === 'ui-settings-account')?.value
    const legacyDone = typeof legacy === 'object' && legacy !== null && 'step' in legacy && legacy.step === 'done'
    return { enabled: this.config.desktopStartup, completed: this.config.welcomeCompleted.get() || legacyDone
      || this.ctx.get('agentDefaultModel')?.currentSelection() !== undefined }
  }

  /**
   * Acknowledge the local introduction without changing model connections or account state.
   * @returns after the completion marker is durably saved; failures retain the introduction.
   */
  @Remote
  async completeDesktopWelcome(): Promise<void> {
    if (principalOf(this.ctx.invocation) !== undefined) throw new RemoteError('hemi/desktop-setup-forbidden', 'Only the profile owner can complete desktop setup', {})
    const settings = this.ctx.get('settings')
    const section = settings?.describe().find(item => item.ns === 'hemi-model-settings')
    if (settings === undefined || section === undefined) throw new RemoteError('hemi/desktop-setup-unavailable', 'Hemi desktop settings are unavailable', {})
    await settings.mutate(section.ns, [{ op: 'set', path: ['welcomeCompleted'], value: true }], section.revision)
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
