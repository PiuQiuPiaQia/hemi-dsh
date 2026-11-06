/** Hemi fork: one product selection keeps builder names, packaging paths and smoke paths consistent. */
import { resolveHemiGitHubDistribution } from '@deepseek-ai/dsh-hemi-customizations/github-distribution'
import { hemiDesktopIdentity } from '@deepseek-ai/dsh-hemi-customizations/desktop-branding'

/**
 * Resolve distribution-owned filenames without changing upstream defaults.
 * @param {NodeJS.ProcessEnv} environment File-owned package settings.
 * @returns {{ productName: string, artifactPrefix: string, protocol: string }} Product identity used throughout packaging.
 */
export function resolveDesktopProduct(environment = process.env) {
  return resolveHemiGitHubDistribution(environment) === undefined
    ? { productName: 'DeepSeek Harness', artifactPrefix: 'deepseek-harness', protocol: 'dsh' }
    : hemiDesktopIdentity
}
