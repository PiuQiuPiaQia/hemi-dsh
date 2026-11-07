/** Locale bundles for the Hemi skin settings section. */

/** Locale keys the section renders. */
export type SkinKey = 'brand.name' | 'brand.edition' | 'nav' | 'skin.title'

/** English copy. */
export const en: Record<SkinKey, string> = {
  'brand.name': 'Hemi',
  'brand.edition': 'dsh',
  'nav': 'Skin', 'skin.title': 'Skin',
}

/** Chinese copy. */
export const zh: Record<SkinKey, string> = {
  'brand.name': 'Hemi',
  'brand.edition': 'dsh',
  'nav': '皮肤', 'skin.title': '皮肤',
}
