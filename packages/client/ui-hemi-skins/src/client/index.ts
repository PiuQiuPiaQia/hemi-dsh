/** Hemi character skins as DSH alias-token themes with a settings picker row. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the theme service Context merge (ctx.theme).
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
// Type-only: pulls the slot registry Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the locale service Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { SkinRowInjected } from './SkinRow.tsx'
import { SkinRow } from './SkinRow.tsx'
import { createSkinRowStore } from './skin-store.ts'
import { installBackdrop } from './backdrop.ts'
import { en, zh, type SkinKey } from './locales.ts'
import { HEMI_SKINS, HEMI_DEFAULT_SKIN, type HemiSkin } from './skins.ts'

/** Namespace owning the skin row's copy. */
export const SKINS_NS = 'hemi-skins'

/** Browser persistence key for the chosen skin (per device, Hemi keeps skins per instance). */
const STORAGE_KEY = 'hemi-skin'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Hemi skin picker row's copy. */
    'hemi-skins': SkinKey
  }
}

/** Required services: theme registry, slot registry, locale. */
export const inject = ['theme', 'slots', 'locale']

/** Read the persisted skin id, falling back to the Hemi default. */
function readStoredSkin(): string {
  if (typeof localStorage === 'undefined') return HEMI_DEFAULT_SKIN.id
  const stored = localStorage.getItem(STORAGE_KEY)
  const found = HEMI_SKINS.find(entry => entry.id === stored)
  return found === undefined ? HEMI_DEFAULT_SKIN.id : found.id
}

/**
 * Register every ported Hemi skin as a selectable theme, apply the chosen
 * skin through a durable token override layer (the built-in preference
 * schema only accepts light/dark/system, so `setTheme` with a third-party
 * id would be reverted by the next settings adopt), and register a picker
 * row into the settings General section. Selecting a skin persists the
 * choice per browser and re-stacks the override layer.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  const disposers = HEMI_SKINS.map(entry => ctx.theme.register(entry.definition))
  const skinOf = (id: string): HemiSkin => HEMI_SKINS.find(entry => entry.id === id) ?? HEMI_DEFAULT_SKIN
  const disposeOverride = ctx.theme.overrideTokens('hemi-skins', skinOf(readStoredSkin()).overrides)
  const updateBackdrop = installBackdrop(ctx)
  updateBackdrop(skinOf(readStoredSkin()))

  ctx.effect(() => () => {
    disposeOverride()
    for (const dispose of disposers) dispose()
  }, 'ui-hemi-skins: skin theme registrations')

  ctx.effect(() => ctx.locale.register(SKINS_NS, { zh, en }), 'ui-hemi-skins: skin row dictionaries')

  const store = createSkinRowStore()
  let bound: BoundActions<typeof store> | undefined
  let revision = 0
  const injected = (actions: BoundActions<typeof store>): SkinRowInjected => {
    bound = actions
    bound.sync(readStoredSkin(), revision++)
    return {
      setSkin: (id: string) => {
        if (!HEMI_SKINS.some(entry => entry.id === id)) return
        if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, id)
        const skin = skinOf(id)
        ctx.theme.overrideTokens('hemi-skins', skin.overrides)
        updateBackdrop(skin)
        bound?.sync(id, revision++)
      },
    }
  }
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'hemi-skins',
    order: 12,
    store,
    locale: SKINS_NS,
    inject: injected,
  }, SkinRow))
}
