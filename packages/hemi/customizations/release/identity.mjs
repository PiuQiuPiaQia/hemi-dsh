/** Stable Hemi desktop identity shared by packaging and its Electron adapter. */
export const hemiDesktopIdentity = Object.freeze({ productName: 'hemi-dsh', artifactPrefix: 'hemi-dsh', protocol: 'hemi-dsh', homeDirectory: '.hemi-dsh' })

/**
 * Read the explicit fork marker while retaining legacy packages without one.
 * @param {unknown} metadata Packaged manifest or release completion record.
 * @returns {typeof hemiDesktopIdentity | undefined} Fork identity, or the original DSH identity.
 */
export function resolveHemiDesktopIdentity(metadata) {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Hemi Desktop: expected an application manifest object')
  }
  if (metadata.hemiDesktopProduct === undefined) return undefined
  if (metadata.hemiDesktopProduct !== hemiDesktopIdentity.productName) throw new Error('Hemi Desktop: unsupported product identity')
  return hemiDesktopIdentity
}

/**
 * Preserve locale-owned wording while substituting the selected proper product name.
 * @param {Record<string, string>} messages Shipped Desktop dictionary.
 * @returns {Record<string, string>} A new branded dictionary with the same keys.
 */
export function hemiDesktopMessages(messages) {
  return Object.fromEntries(Object.entries(messages).map(([key, value]) => [key, value.replaceAll('DeepSeek Harness', hemiDesktopIdentity.productName)]))
}
