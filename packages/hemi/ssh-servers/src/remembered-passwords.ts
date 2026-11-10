/** Opt-in remembered OpenSSH passwords over the DSH credential seam; values stay Host-side and never cross to a Client. */
import { createHash } from 'node:crypto'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { credentialKey, type CredentialKey, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { validAuthenticationAnswer } from './authentication-protocol.ts'

/** Owning plugin name; the credential seam requires the registered plugin's scope. */
export const SSH_PASSWORD_CREDENTIAL_SCOPE = 'hemi-ssh-servers'

/** The exact endpoint fields a remembered password is bound to; display names and directories never take part. */
export type SshPasswordEndpoint = Readonly<{ host: string; port: number; username: string; identityFile: string }>

/** One remembered password grant payload; `nativeUser` is the login name OpenSSH itself printed in the password prompt. */
export interface SshPasswordGrantPayload {
  readonly type: 'hemi-ssh-password'
  readonly host: string
  readonly username: string
  readonly port: number
  readonly identityFile: string
  readonly nativeUser: string
  readonly password: string
}

/** Credential-record spelling of one remembered password; opaque `grant` payload to the seam. */
export interface SshPasswordGrantRecord { readonly kind: 'grant'; readonly payload: SshPasswordGrantPayload }

/** Why an opted-in remember could not be persisted. */
export type SshRememberFailureReason = 'credentials-unavailable' | 'credentials-write' | 'no-saved-endpoint'

/** Credential record operations supplied by the optional Host provider. */
export type SshCredentialRecords = Pick<CredentialProvider, 'readRecord' | 'modifyRecord' | 'deleteRecord' | 'listRecords'>

/**
 * Canonical exact-endpoint spelling; identical fields produce identical text.
 * @param endpoint - endpoint fields in the fixed order shared with authentication masters.
 * @returns the canonical JSON text used for equality and key derivation.
 */
export function canonicalSshEndpoint(endpoint: SshPasswordEndpoint): string {
  return JSON.stringify([endpoint.host, endpoint.username, endpoint.port, endpoint.identityFile])
}

/**
 * Credential record key for one exact endpoint.
 * @param endpoint - endpoint fields the password is bound to.
 * @returns `<scope>/endpoint-<sha256>`; the hash prefix keeps the key segment inside the seam's lowercase grammar.
 */
export function sshPasswordCredentialKey(endpoint: SshPasswordEndpoint): CredentialKey {
  return credentialKey(SSH_PASSWORD_CREDENTIAL_SCOPE,
    `endpoint-${createHash('sha256').update(canonicalSshEndpoint(endpoint)).digest('hex')}`)
}

/**
 * Whether one server record addresses the exact endpoint a password was remembered for.
 * @param server - saved server fields; name and directory are not endpoint fields.
 * @param endpoint - remembered endpoint fields.
 * @returns true only when host, login, port and identity file all match.
 */
export function sameSshEndpoint(
  server: Readonly<{ host: string; port: number; username: string; identityFile: string }>,
  endpoint: SshPasswordEndpoint,
): boolean {
  return canonicalSshEndpoint(server) === canonicalSshEndpoint(endpoint)
}

/**
 * Build one grant record for a verified password.
 * @param endpoint - exact endpoint fields the password authenticated.
 * @param password - the value OpenSSH accepted; stored once, never returned to a Client.
 * @param nativeUser - login name printed by the native password prompt, binding reuse to the same account.
 * @returns the grant record to store under {@link sshPasswordCredentialKey}.
 */
export function sshPasswordGrantRecord(endpoint: SshPasswordEndpoint, nativeUser: string, password: string): SshPasswordGrantRecord {
  return {
    kind: 'grant',
    payload: {
      type: 'hemi-ssh-password', host: endpoint.host, username: endpoint.username, port: endpoint.port,
      identityFile: endpoint.identityFile, nativeUser, password,
    },
  }
}

/**
 * Admit one stored record as this plugin's remembered password.
 * @param value - the record as the credential seam returned it.
 * @returns endpoint, native login and password, or undefined for anything this layout did not write.
 */
export function parseSshPasswordRecord(
  value: unknown,
): { endpoint: SshPasswordEndpoint; nativeUser: string; password: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as { kind?: unknown; payload?: unknown }
  if (record.kind !== 'grant' || typeof record.payload !== 'object' || record.payload === null) return undefined
  const payload = record.payload as Record<string, unknown>
  if (Object.keys(payload).length !== 7 || payload.type !== 'hemi-ssh-password') return undefined
  const { host, username, identityFile, nativeUser, password } = payload
  const { port } = payload
  if (typeof host !== 'string' || typeof username !== 'string' || typeof identityFile !== 'string'
    || typeof nativeUser !== 'string' || typeof password !== 'string' || typeof port !== 'number'
    || !Number.isSafeInteger(port) || port < 1 || port > 65535 || !validAuthenticationAnswer(password)
    || host === '' || nativeUser === '' || password === '') return undefined
  return { endpoint: { host, username, port, identityFile }, nativeUser, password }
}

/**
 * Classify one native prompt as the target endpoint's own OpenSSH password prompt.
 * OpenSSH prints `<user>@<host>'s password: ` from local connection state; prompts for other hosts and non-password responses are excluded.
 * @param prompt - exact bounded prompt text.
 * @param endpoint - endpoint the authenticating master targets.
 * @returns the login name OpenSSH printed, or undefined when the prompt is not this endpoint's password prompt.
 */
export function nativePasswordPromptUser(prompt: string, endpoint: Readonly<{ host: string; username: string }>): string | undefined {
  const text = prompt.endsWith(' ') ? prompt.slice(0, -1) : prompt
  const suffix = "'s password:"
  if (!text.endsWith(suffix)) return undefined
  const body = text.slice(0, -suffix.length)
  const separator = body.lastIndexOf('@')
  if (separator === -1) return undefined
  const nativeUser = body.slice(0, separator)
  const host = body.slice(separator + 1)
  if (nativeUser === '' || host !== endpoint.host) return undefined
  return endpoint.username === '' || nativeUser === endpoint.username ? nativeUser : undefined
}

/**
 * Normalize one failure into the remember-failure reason code.
 * @param error - the failure raised by a persist attempt, or the typed authentication failure carrying one.
 * @returns the structured reason; unknown failures are credential writes, never free text.
 */
export function rememberFailureReasonOf(error: unknown): SshRememberFailureReason {
  const failure = remoteErrorOf(error)
  const reason = failure?.code === 'hemi-ssh/remember-failed' ? failure.details.reason : undefined
  if (reason === 'credentials-unavailable' || reason === 'no-saved-endpoint') return reason
  const carried = error instanceof Error && 'code' in error && error.code === 'remember-failed'
    ? (error as { readonly reason?: unknown }).reason : undefined
  return carried === 'credentials-unavailable' || carried === 'no-saved-endpoint' ? carried : 'credentials-write'
}

/** Password memory collaborator consumed by the authentication owner; absent disables remembering without changing authentication. */
export interface SshAuthenticationPasswordMemory {
  /**
   * Read the remembered password for one exact endpoint.
   * A failure reads as absence: a broken store must not block the connection, only remembering.
   * @param endpoint - exact endpoint fields.
   * @returns the remembered native login and password, or undefined while none applies.
   */
  lookup(endpoint: SshPasswordEndpoint): Promise<{ nativeUser: string; password: string } | undefined>
  /**
   * Persist one password OpenSSH already accepted.
   * @param endpoint - exact endpoint fields the password authenticated.
   * @param nativeUser - login name printed by the native password prompt.
   * @param password - the accepted value; handed to the credential seam only.
   * @returns after the durable write; rejection fails the awaiting connection with a typed remember failure.
   */
  persist(endpoint: SshPasswordEndpoint, nativeUser: string, password: string): Promise<void>
  /**
   * Drop the stored record only while it still holds this rejected value.
   * @param endpoint - exact endpoint fields.
   * @param password - the value a later prompt proved wrong.
   */
  discard(endpoint: SshPasswordEndpoint, password: string): Promise<void>
  /**
   * Whether a saved server currently matches the endpoint, so remembering cannot offer to store a password nothing will own.
   * @param endpoint - exact endpoint fields.
   * @returns true while at least one saved server addresses this endpoint.
   */
  canPersist(endpoint: SshPasswordEndpoint): boolean
}
