/** Hosted-runner configuration for fixed Hemi self-signing; never creates or rotates a certificate. */
import { X509Certificate } from 'node:crypto'
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { resolveHemiGitHubDistribution } from './config.mjs'

function context(environment, target) {
  if (environment.GITHUB_ACTIONS !== 'true' || environment.RUNNER_ENVIRONMENT !== 'github-hosted') {
    throw new Error('Hemi Desktop: automatic credential setup/cleanup is limited to disposable GitHub-hosted runners')
  }
  if (!['mac-arm64', 'mac-x64', 'win-x64'].includes(target)) throw new Error('Hemi Desktop: invalid community target')
  if (!environment.RUNNER_TEMP || !isAbsolute(environment.RUNNER_TEMP)) throw new Error('Hemi Desktop: RUNNER_TEMP must be absolute')
  const directory = join(resolve(environment.RUNNER_TEMP), `hemi-desktop-community-${target}`)
  if (lstatSync(resolve(environment.RUNNER_TEMP)).isSymbolicLink()) throw new Error('Hemi Desktop: runner temporary root cannot be a link')
  return directory
}

/**
 * Write isolated public presets and private p12 inputs for one hosted job.
 * @param {NodeJS.ProcessEnv} environment GitHub identity and secrets; p12 bytes and passwords never enter output.
 * @param {string} target Closed Desktop target.
 * @returns {string} Private configuration directory; caller exports only this path.
 */
export function setupHemiCommunitySigning(environment, target) {
  const directory = context(environment, target)
  if (existsSync(directory)) throw new Error('Hemi Desktop: community setup requires a fresh runner directory')
  const appId = environment.HEMI_DESKTOP_APP_ID || 'ai.hemi.dsh.desktop'
  if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u.test(appId)) throw new Error('Hemi Desktop: invalid application identifier')
  const settings = { DSH_DESKTOP_APP_ID: appId, DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
    HEMI_DESKTOP_GITHUB_REPOSITORY: environment.GITHUB_REPOSITORY,
    HEMI_DESKTOP_GITHUB_FEED_BRANCH: environment.HEMI_DESKTOP_FEED_BRANCH || 'desktop-update-feeds',
    HEMI_DESKTOP_UPDATE_POLICY: 'disabled', HEMI_DESKTOP_SIGNING_MODE: 'community' }
  resolveHemiGitHubDistribution(settings)
  let p12
  let password
  if (target !== 'win-x64') {
    const encoded = environment.HEMI_MAC_SIGNING_P12
    password = environment.HEMI_MAC_SIGNING_PASSWORD
    if (!encoded || !password) throw new Error('Hemi Desktop: set HEMI_MAC_SIGNING_P12 and HEMI_MAC_SIGNING_PASSWORD to the existing fixed Hemi identity')
    if (/[\r\n\0']/u.test(password)) throw new Error('Hemi Desktop: CI p12 password cannot contain line breaks, NUL or a single quote')
    p12 = Buffer.from(encoded, 'base64')
    if (p12.length === 0 || p12.toString('base64') !== encoded.replace(/\s/gu, '')) throw new Error('Hemi Desktop: signing p12 must be valid base64')
    // Loading the committed public certificate detects a missing pin before saving any credentials.
    new X509Certificate(readFileSync(new URL('./macos-signing.cer', import.meta.url)))
  }
  mkdirSync(directory, { mode: 0o700 })
  try {
    writeFileSync(join(directory, '.hemi-community-signing'), '1\n', { mode: 0o600, flag: 'wx' })
    mkdirSync(join(directory, 'presets'), { mode: 0o700 })
    writeFileSync(join(directory, 'presets/production.env'), Object.entries(settings).map(([name, value]) => `${name}=${value}`).join('\n') + '\n', { mode: 0o600 })
    if (p12 !== undefined) {
      mkdirSync(join(directory, 'secrets'), { mode: 0o700 })
      writeFileSync(join(directory, 'secrets/identity.p12'), p12, { mode: 0o600, flag: 'wx' })
      writeFileSync(join(directory, 'secrets/macos-signing.env'), `CSC_LINK=identity.p12\nCSC_KEY_PASSWORD='${password}'\n`, { mode: 0o600, flag: 'wx' })
    }
    if (environment.GITHUB_ENV) appendFileSync(environment.GITHUB_ENV, `DSH_PACKAGING_CONFIG_DIR=${directory}\n`)
    return directory
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw new Error('Hemi Desktop: could not prepare the owned signing directory; no signing was attempted')
  }
}

/**
 * Remove only this hosted job's marked credential directory after packaging settles.
 * @param {NodeJS.ProcessEnv} environment Disposable GitHub-hosted job context.
 * @param {string} target Target used during setup.
 * @returns {void} Missing directories are harmless; unowned or linked directories are refused.
 */
export function cleanupHemiCommunitySigning(environment, target) {
  const directory = context(environment, target)
  if (!existsSync(directory)) return
  const marker = join(directory, '.hemi-community-signing')
  if (lstatSync(directory).isSymbolicLink() || !existsSync(marker) || !lstatSync(marker).isFile()
    || lstatSync(marker).isSymbolicLink() || readFileSync(marker, 'utf8') !== '1\n') {
    throw new Error('Hemi Desktop: refusing cleanup of an unowned signing directory')
  }
  rmSync(directory, { recursive: true })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { target: { type: 'string' } } })
  if (positionals.length !== 1 || !values.target || !['setup', 'cleanup'].includes(positionals[0])) throw new Error('Usage: setup.mjs setup|cleanup --target TARGET')
  if (positionals[0] === 'setup') { setupHemiCommunitySigning(process.env, values.target); console.log('Hemi community signing inputs prepared') }
  else { cleanupHemiCommunitySigning(process.env, values.target); console.log('Hemi community signing inputs cleaned') }
}
