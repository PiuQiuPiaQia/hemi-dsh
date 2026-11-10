/** Form parsing, field validation and compact endpoint labels. */
import type { SshServer, SshServerInput } from '@deepseek-ai/dsh-hemi-ssh-servers/types'
import type { ServerDraft } from './types.ts'

/** Stable empty history for selectors before an endpoint has been visited. */
export const EMPTY_DIRECTORY_HISTORY: readonly string[] = Object.freeze([])

/**
 * Isolate picker locations by the exact unresolved connection fields.
 * @param endpoint - connection identity, without display name or preferred directory.
 * @returns stable interaction-state key, not a display label or saved connection id.
 */
export function directoryHistoryKey(endpoint: Pick<SshServerInput, 'host' | 'username' | 'port' | 'identityFile'>): string {
  return JSON.stringify([endpoint.host, endpoint.username, endpoint.port, endpoint.identityFile])
}

/** Form field order, also used to focus the first invalid field. */
export const FIELDS: readonly (keyof ServerDraft)[] = ['name', 'address', 'port', 'identityFile', 'directory']

/**
 * Seed a detached string-valued editor draft.
 * @param server - Captured record, or no record for creation.
 * @returns Editable text fields without inferred SSH values.
 */
export function serverDraft(server?: SshServer): ServerDraft {
  return {
    name: server?.name ?? '',
    address: server === undefined ? '' : `${server.username === '' ? '' : `${server.username}@`}${server.host}`,
    port: String(server?.port ?? 22), identityFile: server?.identityFile ?? '', directory: server?.directory ?? '',
  }
}

/**
 * Validate unsubmitted fields without contacting a host or reading a key.
 * @param draft - Unsubmitted text fields.
 * @returns Every field requiring correction.
 */
export function invalidFields(draft: ServerDraft): readonly (keyof ServerDraft)[] {
  const invalid: (keyof ServerDraft)[] = []
  const name = draft.name.trim()
  const address = draft.address.trim()
  const { host, username } = addressParts(address)
  const ip = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  const hostSyntax = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(host)
    || ip.split(':').length >= 3 && /^[0-9a-fA-F:.]+(?:%[a-zA-Z0-9_.-]+)?$/.test(ip)
  const key = draft.identityFile.trim()
  if (name.length === 0 || name.length > 120 || /\p{Cc}/u.test(name)) invalid.push('name')
  if (host.length === 0 || host.length > 253 || !hostSyntax || (address.includes('@') && username.length === 0)
    || username.length > 128 || !/^[a-zA-Z0-9_.@-]*$/.test(username) || username.startsWith('-')) invalid.push('address')
  if (!/^\d+$/.test(draft.port.trim()) || Number(draft.port) < 1 || Number(draft.port) > 65535) invalid.push('port')
  if (key.length > 4096 || /\p{Cc}/u.test(key) || /-----BEGIN|PRIVATE KEY-----/i.test(key)
    || (key !== '' && !/^(?:\/|~\/|[a-zA-Z]:[\\/]|\\\\)/.test(key))) invalid.push('identityFile')
  const directory = draft.directory.trim()
  if (directory.length > 4096 || /\p{Cc}/u.test(directory) || directory !== '' && !directory.startsWith('/')) invalid.push('directory')
  return invalid
}

/**
 * Parse a validated draft for submission.
 * @param draft - Validated text fields.
 * @returns Explicit Host input, with optional fields empty rather than inferred.
 */
export function serverInput(draft: ServerDraft): SshServerInput {
  return {
    name: draft.name.trim(), ...addressParts(draft.address.trim()), port: Number(draft.port),
    identityFile: draft.identityFile.trim(),
    ...draft.directory.trim() === '' ? {} : { directory: draft.directory.trim() },
  }
}

/** The final @ separates the host, preserving saved login names that themselves contain @. */
function addressParts(address: string): Pick<SshServerInput, 'host' | 'username'> {
  const separator = address.lastIndexOf('@')
  return separator === -1 ? { host: address, username: '' }
    : { host: address.slice(separator + 1), username: address.slice(0, separator) }
}

/**
 * Format saved fields without resolving SSH configuration.
 * @param server - Saved, unresolved SSH fields.
 * @returns Endpoint label without an invented username or connection state.
 */
export function endpointLabel(server: Pick<SshServerInput, 'host' | 'username' | 'port'>): string {
  const host = server.host.includes(':') && !server.host.startsWith('[') ? `[${server.host}]` : server.host
  return `${server.username === '' ? '' : `${server.username}@`}${host}:${String(server.port)}`
}
