/** Hemi character skins as DSH alias-token themes with a settings section. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { SkinSectionInjected } from './SkinSection.tsx'
import { SkinSection } from './SkinSection.tsx'
import { installBackdrop } from './backdrop.ts'
import { en, zh, type SkinKey } from './locales.ts'
import { HEMI_SKINS, HEMI_DEFAULT_SKIN } from './skins.ts'

/** Locale namespace for the skin section copy. */
export const SKINS_NS = 'hemi-skins'

/** Browser persistence key for the chosen skin (per device). */
const STORAGE_KEY = 'hemi-skin'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The skin section's copy. */
    'hemi-skins': SkinKey
  }
}

/** Services: theme registry, slot registry, locale. */
export const inject = ['theme', 'slots', 'locale']

/**
 * Register every ported Hemi skin as a selectable theme, apply the chosen
 * skin through a durable token override layer (the built-in preference
 * schema only accepts light/dark/system, so a `setTheme` call with a
 * third-party id would be reverted by the next settings adopt), and register
 * the skin section into the settings panel. Selecting a skin persists the
 * choice per browser and re-stacks the override layer.
 * @param ctx - client plugin context.
 */
export function apply(ctx: Context): void {
  const disposers = HEMI_SKINS.map(entry => ctx.theme.register(entry.definition))
  const skinOf = (id: string) => HEMI_SKINS.find(entry => entry.id === id) ?? HEMI_DEFAULT_SKIN
  const disposeOverride = ctx.theme.overrideTokens('hemi-skins', skinOf(readStoredSkin()).overrides)
  const updateBackdrop = installBackdrop(ctx)
  updateBackdrop(skinOf(readStoredSkin()))

  ctx.effect(() => () => {
    disposeOverride()
    for (const dispose of disposers) dispose()
  }, 'ui-hemi-skins: skin theme registrations')

  ctx.effect(() => ctx.locale.register(SKINS_NS, { en, zh }), 'ui-hemi-skins: skin section dictionaries')
  const t = ctx.locale.bind(SKINS_NS)

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'hemi-skins',
    order: 59,
    label: () => t('nav'),
    locale: SKINS_NS,
    inject: (): SkinSectionInjected => ({
      setSkin: (id: string) => {
        if (!HEMI_SKINS.some(entry => entry.id === id)) return
        if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, id)
        const skin = skinOf(id)
        ctx.theme.overrideTokens('hemi-skins', skin.overrides)
        updateBackdrop(skin)
      },
    }),
  }, SkinSection))
}

/** Read the persisted skin id, falling back to the Hemi default. */
function readStoredSkin(): string {
  if (typeof localStorage === 'undefined') return HEMI_DEFAULT_SKIN.id
  const stored = localStorage.getItem(STORAGE_KEY)
  return stored !== null && HEMI_SKINS.some(entry => entry.id === stored) ? stored : HEMI_DEFAULT_SKIN.id
}
