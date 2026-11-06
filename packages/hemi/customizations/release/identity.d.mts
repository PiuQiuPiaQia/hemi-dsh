/** Stable public identity of the Hemi desktop distribution. */
export const hemiDesktopIdentity: Readonly<{ productName: 'hemi-dsh'; artifactPrefix: 'hemi-dsh'; protocol: 'hemi-dsh'; homeDirectory: '.hemi-dsh' }>
/** Read an explicit fork marker, rejecting unsupported markers. */
export function resolveHemiDesktopIdentity(metadata: unknown): typeof hemiDesktopIdentity | undefined
/** Substitute the product name without changing dictionary keys or the original dictionary. */
export function hemiDesktopMessages<T extends Record<string, string>>(messages: T): { [K in keyof T]: string }
