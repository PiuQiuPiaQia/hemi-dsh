/** Saved SSH server references; no credential contents or connection state. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SshAuthenticationChallengeId } from './authentication-types.ts'

/** Stable identity of a saved SSH server. */
export type SshServerId = Branded<'HemiSshServerId'>

/** Explicit connection fields; empty user and key path defer to OpenSSH configuration. */
export interface SshServerInput {
  /** Display name, independent of the host. */
  readonly name: string
  /** Hostname, address, or existing OpenSSH alias. */
  readonly host: string
  /** TCP port, from 1 through 65535. */
  readonly port: number
  /** Login name, or empty to use the OpenSSH configuration. */
  readonly username: string
  /** Private-key path reference, or empty to use the OpenSSH configuration. */
  readonly identityFile: string
  /** Preferred absolute remote directory; omitted until selected, without restricting other folders. */
  readonly directory?: string | undefined
}

/** One durable server reference; saving it does not establish a connection. */
export interface SshServer extends SshServerInput {
  /** Opaque record identity. */
  readonly id: SshServerId
  /** Revision required to edit or remove this record. */
  readonly revision: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A server field is invalid; no record was written. */
    'hemi-ssh/invalid-input': { readonly field: string }
    /** The requested server was removed. */
    'hemi-ssh/not-found': { readonly id: SshServerId }
    /** Another editor changed this server; reload before writing. */
    'hemi-ssh/conflict': { readonly id: SshServerId }
    /**
     * An opted-in remembered password could not be stored; thrown by the awaiting connection operation, not the answer call.
     * Authentication already succeeded; the connection is released. A failed store write has an unconfirmed durable outcome.
     */
    'hemi-ssh/remember-failed': { readonly host: string; readonly reason: 'credentials-unavailable' | 'credentials-write' | 'no-saved-endpoint' }
    /** A remember request targeted a prompt that is not the saved server's own native password prompt. */
    'hemi-ssh/not-rememberable': { readonly id: SshAuthenticationChallengeId }
    /** The server change is durable but its stored password record could not be removed; retried at the next service start. */
    'hemi-ssh/credential-cleanup-failed': { readonly id: SshServerId }
  }
}
