/** Lifecycle assembly for generated mobile methods, held resources, and the settings contribution. */
import type { Context } from '@deepseek-ai/cordis'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { MobileController } from './controller.ts'
import { nativeConnection } from './native.ts'
import { MobileSection } from './MobileSection.tsx'
import { en, zh } from './locales.ts'
import type { MobileInjected } from './types.ts'

/**
 * Mount the generated namespace before its UI, and withdraw requests before unmounting it.
 * @param ctx - Client plugin context.
 * @param contribution - Host-generated mobile management descriptors.
 * @returns Ordered asynchronous teardown.
 */
export async function mountMobile(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const unmount = await ctx.remote.$mount(contribution)
  const features = ctx.inject(['remote.hemiMobileAccess'], registerMobile)
  try { await features.await() } catch (error: unknown) {
    await features.dispose()
    await unmount()
    throw error
  }
  return async () => { await features.dispose(); await unmount() }
}

function registerMobile(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('hemi-mobile-access', { en, zh }), 'hemi-mobile-access-ui: copy')
  const controller = new MobileController(ctx.remote.hemiMobileAccess)
  ctx.effect(() => () => controller.dispose(), 'hemi-mobile-access-ui: admitted requests')
  ctx.effect(() => ctx.resources.register(controller.provider()), 'hemi-mobile-access-ui: held settings resource')
  ctx.on('connection/reset', () => { controller.reset() })
  const t = ctx.locale.bind('hemi-mobile-access')
  const connection = nativeConnection(typeof window === 'undefined' ? undefined : window.__HEMI_MOBILE__)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'hemi-mobile-access', order: 75,
    label: () => t('nav'), locale: 'hemi-mobile-access',
    inject: (): MobileInjected => ({
      nativeConnection: connection,
      refresh: () => { controller.refresh() },
      start: () => controller.start(),
      stop: () => controller.stop(),
      createInvitation: () => controller.createInvitation(),
      approve: (requestId, code) => controller.approve(requestId, code),
      reject: requestId => controller.reject(requestId),
      revoke: deviceId => controller.revoke(deviceId),
      copy: text => writeClipboard(text),
    }),
  }, MobileSection))
}
