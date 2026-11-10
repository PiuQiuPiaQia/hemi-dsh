/** Transient native OpenSSH challenges; neither answers nor control-socket capabilities are durable data. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SshEndpointArgs } from './browse.ts'

/** One single-use prompt owned by one authentication manager and one native askpass invocation. */
export type SshAuthenticationChallengeId = Branded<'HemiSshAuthenticationChallengeId'>

/** Native askpass presentation hint, not a password or host-trust classification. */
export type SshAuthenticationPromptKind = 'input' | 'confirm' | 'notification'

/** One pending native prompt. Its endpoint identifies the requested connection, including configured jump hosts. */
export interface SshAuthenticationChallenge {
  readonly id: SshAuthenticationChallengeId
  readonly endpoint: Pick<SshEndpointArgs, 'host' | 'port' | 'username' | 'identityFile'>
  /** Exact bounded text supplied by OpenSSH; render as text, never HTML or terminal escapes. */
  readonly prompt: string
  /** Only SSH_ASKPASS_PROMPT=confirm/none select confirm/notification; every other prompt is input. */
  readonly kind: SshAuthenticationPromptKind
  /**
   * Whether the owning UI may offer to remember this prompt's answer for the exact endpoint.
   * True only for the target endpoint's own native OpenSSH password prompt while a credential store is active
   * and a saved server still matches the endpoint; every other prompt stays manual and unremembered.
   */
  readonly canRemember: boolean
}
