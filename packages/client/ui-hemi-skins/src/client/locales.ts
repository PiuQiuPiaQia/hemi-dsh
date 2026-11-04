/** Locale bundles for the Hemi skin settings section. */

/** Locale keys the section renders. */
export type SkinKey = 'nav' | 'skin.title' | 'skin.description'

/** English copy. */
export const en: Record<SkinKey, string> = {
  'nav': 'Skin', 'skin.title': 'Skin',
  'skin.description': 'Pick the Hemi character skin. The choice is remembered per browser and applied through the role routing-safe override layer.',
}

/** Chinese copy. */
export const zh: Record<SkinKey, string> = {
  'nav': '皮肤', 'skin.title': '皮肤',
  'skin.description': '选择 Hemi 人物皮肤。选择按浏览器记忆，并通过路由安全覆盖层即时生效。',
}
