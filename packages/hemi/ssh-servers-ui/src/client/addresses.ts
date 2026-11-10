/** Resource addresses distinguish saved connections and each captured directory interaction. */
import type { SshServerId } from '@deepseek-ai/dsh-hemi-ssh-servers/types'

/** Stable saved-connection resource, shared by picker occurrences. */
export const SERVER_ADDRESS = 'dsh-resource://hemi-ssh-servers/list'

/**
 * Address the folder interaction whose successful frames the resource model retains.
 * @param id - saved connection identity.
 * @param selection - transient interaction generation.
 * @returns folder resource address.
 */
export function foldersAddress(id: SshServerId, selection: number): string {
  return `dsh-resource://hemi-ssh-folders/${encodeURIComponent(id)}?selection=${selection}`
}
