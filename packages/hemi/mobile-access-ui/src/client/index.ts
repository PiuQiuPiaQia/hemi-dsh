/** Browser settings for phone access to the current desktop Host. */
import type { Context } from '@deepseek-ai/cordis'
import mobileRemote from '@deepseek-ai/dsh-hemi-mobile-access/remote'
import { mountMobile } from './mount.ts'

/** Required Client services; the feature mounts its generated Remote namespace itself. */
export const inject = ['slots', 'locale', 'remote', 'resources']

/**
 * Register the phone settings without starting a listener or another runtime.
 * @param ctx - Client plugin context.
 * @returns Teardown that removes the section and joins its requests before its Remote namespace.
 */
export function apply(ctx: Context): Promise<() => Promise<void>> { return mountMobile(ctx, mobileRemote) }
