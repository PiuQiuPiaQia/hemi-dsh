/** Register the Memory tab over the Hemi memory settings endpoints. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import memoryRemote from '@deepseek-ai/dsh-hemi-memory/remote'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { MemorySection, type MemoryActions } from './MemorySection.tsx'
import { en, zh, type MemoryLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'hemi-memory': MemoryLocaleKey
  }
}

export const inject = ['slots', 'locale', 'remote']

async function unwrap<T>(request: Promise<RemoteResult<T>>): Promise<T> {
  const result = await request
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/** Mount the Remote descriptors for as long as the settings contribution is active. */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const unmount = await ctx.remote.$mount(memoryRemote)
  const features = ctx.inject(['remote.hemiMemory'], registerMemory)
  try {
    await features.await()
  } catch (error) {
    await features.dispose()
    await unmount()
    throw error
  }
  return async () => {
    await features.dispose()
    await unmount()
  }
}

function registerMemory(ctx: Context): void {
  const namespace = 'hemi-memory'
  ctx.effect(() => ctx.locale.register(namespace, { en, zh }), 'hemi-memory-ui: dictionaries')
  const t = ctx.locale.bind(namespace)
  const actions: MemoryActions = {
    read: (target, date) => unwrap(ctx.remote.hemiMemory.readStore(target, date)),
    save: (target, content, revision, date) => unwrap(ctx.remote.hemiMemory.saveStore(target, content, revision, date)),
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: namespace,
    order: 60,
    label: () => t('nav'),
    locale: namespace,
    inject: () => ({ actions }),
  }, MemorySection))
}
