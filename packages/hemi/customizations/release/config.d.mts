/** Validated public GitHub distribution, enabled only by file-owned packaging settings. */
export interface HemiGitHubDistribution {
  readonly repository: string
  readonly branch: string
  readonly policy: 'required' | 'disabled'
}

/** Resolve opt-in Hemi settings; absent settings preserve DSH distribution. */
export function resolveHemiGitHubDistribution(environment: NodeJS.ProcessEnv): HemiGitHubDistribution | undefined

/** Resolve one generic GitHub feed without changing channel or installation semantics. */
export function resolveHemiGitHubUpdate(
  environment: NodeJS.ProcessEnv,
  target: 'mac-arm64' | 'mac-x64' | 'win-x64',
  channel: 'stable' | 'nightly',
): {
  environment: 'production'
  channel: 'stable' | 'nightly'
  target: 'mac-arm64' | 'mac-x64' | 'win-x64'
  origin: string
  publicUrl: string
  keyPrefix: string
  binaryKeyPrefix: string
} | undefined
