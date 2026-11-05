/** GitHub-hosted Desktop feeds; installers remain versioned Release attachments. */

/**
 * Resolve opt-in Hemi distribution settings; absent settings preserve DSH distribution.
 * @param {NodeJS.ProcessEnv} environment File-owned packaging settings.
 * @returns {{ repository: string, branch: string, policy: 'required' | 'disabled' } | undefined} Validated public distribution.
 */
export function resolveHemiGitHubDistribution(environment) {
  const repository = environment.HEMI_DESKTOP_GITHUB_REPOSITORY
  const branch = environment.HEMI_DESKTOP_GITHUB_FEED_BRANCH ?? 'desktop-update-feeds'
  const policy = environment.HEMI_DESKTOP_UPDATE_POLICY ?? 'required'
  if (repository === undefined) {
    if (environment.HEMI_DESKTOP_GITHUB_FEED_BRANCH !== undefined || environment.HEMI_DESKTOP_UPDATE_POLICY !== undefined) {
      throw new Error('Hemi Desktop: HEMI_DESKTOP_GITHUB_REPOSITORY is required for GitHub settings')
    }
    return undefined
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(repository)
    || repository.endsWith('.git')) throw new Error('Hemi Desktop: repository must be owner/repo without .git')
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(branch) || ['main', 'master', 'HEAD'].includes(branch)) {
    throw new Error('Hemi Desktop: feed branch must be a dedicated simple branch name')
  }
  if (policy !== 'required' && policy !== 'disabled') throw new Error('Hemi Desktop: update policy must be required or disabled')
  if (environment.DSH_DESKTOP_AUTO_UPDATE_ENV !== 'production') {
    throw new Error('Hemi Desktop: GitHub distribution requires production deployment; select stable or nightly independently')
  }
  return { repository, branch, policy }
}

/**
 * Resolve a generic feed without changing channel selection or installation behavior.
 * @param {NodeJS.ProcessEnv} environment File-owned packaging settings.
 * @param {'mac-arm64' | 'mac-x64' | 'win-x64'} target Supported target.
 * @param {'stable' | 'nightly'} channel Validated update channel.
 * @returns {{ environment: 'production', channel: 'stable' | 'nightly', target: string, origin: string, publicUrl: string, keyPrefix: string, binaryKeyPrefix: string } | undefined} GitHub feed, or no override.
 */
export function resolveHemiGitHubUpdate(environment, target, channel) {
  const distribution = resolveHemiGitHubDistribution(environment)
  if (distribution === undefined) return undefined
  const { repository, branch } = distribution
  const keyPrefix = `feeds/${target}`
  return { environment: 'production', channel, target, origin: 'https://raw.githubusercontent.com',
    publicUrl: `https://raw.githubusercontent.com/${repository}/${branch}/${keyPrefix}/`,
    keyPrefix, binaryKeyPrefix: `https://github.com/${repository}/releases/download` }
}
