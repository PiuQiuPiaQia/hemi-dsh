/** Immutable profiles and request metadata exposed to pi-ai contributors. */

import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { Config } from './config.ts'

/** Validated, immutable provider configuration supplied to deployment-default contributors. */
export type PiAiProviderProfiles = ReturnType<Config['providers']['get']>

/** Model-hidden routing metadata from the exact prepared adapter call. */
export interface PiAiRequestHeaderContext extends Readonly<Pick<GenerateOptions<string>,
  'provider' | 'model' | 'sessionId' | 'purpose'>> {
  /** Resolved endpoint of the model selected for this call. */
  readonly baseURL: string
}

// Hemi fork: the adapter and log consumer share metadata without sharing the raw SDK error.
/** Allowlisted metadata for one Codex WebSocket failure, delivered after the SDK attempt settles. */
export interface PiAiTransportDiagnostic extends Readonly<Pick<GenerateOptions<string>,
  'provider' | 'model' | 'sessionId' | 'purpose'>> {
  readonly transport: 'websocket'
  readonly configuredTransport: 'auto' | 'websocket' | 'websocket-cached'
  /** Unix time in milliseconds at which pi-ai caught the failure. */
  readonly timestamp: number
  /** Time from SDK dispatch until the failure, before any fallback. */
  readonly elapsedMs: number
  readonly phase: 'before_message_stream_start' | 'after_message_stream_start'
  readonly closeCode?: number
  readonly fallbackTransport?: 'sse'
  /** Size of the full JSON request before any WebSocket continuation optimization. */
  readonly fullRequestBytes?: number
  /** Final SDK outcome, including any fallback within this attempt. */
  readonly outcome: 'completed' | 'failed' | 'aborted'
}
