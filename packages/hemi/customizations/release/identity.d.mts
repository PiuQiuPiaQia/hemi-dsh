/** Stable public identity of the Hemi desktop distribution. */
export const hemiDesktopIdentity: Readonly<{ productName: 'Hemi'; distributionId: 'hemi-dsh'; artifactPrefix: 'hemi-dsh'; protocol: 'hemi-dsh'; homeDirectory: '.hemi-dsh' }>
/** Read an explicit fork marker, rejecting unsupported markers. */
export function resolveHemiDesktopIdentity(metadata: unknown): typeof hemiDesktopIdentity | undefined
/** Substitute the product name without changing dictionary keys or the original dictionary. */
export function hemiDesktopMessages<T extends Record<string, string>>(messages: T): { [K in keyof T]: string }
/** Localized presentation consumed by the framework-free boot page. */
export interface HemiBootPresentation {
  readonly wordmark: string
  readonly loadingLabel: string
  readonly failedLabel: string
  readonly className: string
}
/** Read shell-owned arguments; absent fork identity preserves native DSH. */
export function hemiBootPresentation(argv: readonly string[]): HemiBootPresentation | undefined
/** Resolve the Hemi Host plugin's provider-neutral desktop startup preferences. */
export function hemiDesktopStartup(ctx: import('@deepseek-ai/cordis').Context): { mode: 'workspace'; localePreference: string | null } | undefined
