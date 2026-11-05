/** Versioned installer destination and frozen package selection. */
export interface HemiGitHubReleaseOptions {
  readonly repository: string
  readonly branch: string
  readonly version: string
  readonly channel: 'stable' | 'nightly'
  readonly commit: string
  readonly targets: readonly ('mac-arm64' | 'mac-x64' | 'win-x64')[]
  readonly signingMode?: 'community' | 'official'
  readonly artifactsRoot: string
}

/** Locally verified bytes uploaded as one Release attachment. */
export interface HemiGitHubAsset {
  readonly path: string
  readonly name: string
  readonly size: number
  readonly sha256: string
  readonly sha512: string
}

/** Fully prepared publication; fingerprint excludes local filesystem paths. */
export interface HemiGitHubReleasePlan {
  readonly repository: string
  readonly branch: string
  readonly tag: string
  readonly version: string
  readonly channel: 'stable' | 'nightly'
  readonly commit: string
  readonly fingerprint: string
  readonly assets: readonly HemiGitHubAsset[]
  readonly feeds: readonly { readonly path: string; readonly contents: string }[]
}

/** GitHub operations used by publication; JSON is checked where consumed. */
export interface HemiGitHubClient {
  // GitHub endpoint responses have different fields; validation belongs to each operation.
  request(method: string, path: string, body?: object, optional?: boolean): Promise<unknown>
  // GitHub upload responses are checked for uploaded state, size and SHA-256.
  upload(repository: string, releaseId: number, file: HemiGitHubAsset): Promise<unknown>
}

/** Publication failure with safe operator guidance and a stable classification. */
export class HemiGitHubReleaseError extends Error {
  readonly code: string
  constructor(code: string, message: string)
}

/** Validate completed signed packages and prepare per-target, per-channel feeds without writes. */
export function prepareHemiGitHubRelease(options: HemiGitHubReleaseOptions): Promise<HemiGitHubReleasePlan>

/** Create bounded, non-retrying production HTTP operations; token never enters package data. */
export function createHemiGitHubClient(token: string): HemiGitHubClient

/** Publish verified assets before atomically advancing feeds; retries reconcile remote state. */
export function publishHemiGitHubRelease(
  plan: HemiGitHubReleasePlan,
  client: HemiGitHubClient,
): Promise<{ tag: string; branch: string; commit: string | undefined }>
