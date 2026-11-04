/** Model routing UI over the native model-menu, label and settings extension slots. */
import type { Context } from '@deepseek-ai/cordis'
import routingRemote from '@deepseek-ai/dsh-hemi-routing/remote'
import { mountRouting } from './mount.ts'

/** Shared services required before the plugin mounts its own routing namespace. */
export const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.session']

/**
 * Mount the routing namespace and activate its model-menu and settings controls.
 * @param ctx - Client context holding shared Remote and UI services.
 * @returns disposer removing controls before the routing namespace.
 */
export function apply(ctx: Context): Promise<() => Promise<void>> {
  return mountRouting(ctx, routingRemote)
}
