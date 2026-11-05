/** Immutable profiles and prepared-call metadata exposed to pi-ai contributors. */

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
