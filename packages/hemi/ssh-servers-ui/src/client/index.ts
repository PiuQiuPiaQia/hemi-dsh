/** Browser entry for the independent saved SSH server interface. */
import type { Context } from '@deepseek-ai/cordis'
import sshServersRemote from '@deepseek-ai/dsh-hemi-ssh-servers/remote'
import { mountServers } from './mount.ts'

/** Services required to mount the feature without changing native workspace navigation. */
export const inject = ['slots', 'locale', 'remote', 'remoteAccess', 'resources', 'workspaces']

/**
 * Mount the optional saved-server controls.
 * @param ctx - Client root context.
 * @returns Disposer closing UI and requests before its Remote namespace.
 */
export function apply(ctx: Context): Promise<() => Promise<void>> {
  return mountServers(ctx, sshServersRemote)
}
