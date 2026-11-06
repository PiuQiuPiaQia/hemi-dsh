/** Hemi-owned GitHub release commands; the Desktop shell supplies its existing packaging operations. */

import { readFileSync, appendFileSync } from 'node:fs'
import { cp, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { resolveHemiDesktopIdentity } from './identity.mjs'
import { resolveHemiCommunitySigning } from './signing.mjs'
import { resolveHemiGitHubDistribution } from './config.mjs'
import { createHemiGitHubClient, prepareHemiGitHubRelease, publishHemiGitHubRelease } from './publish.mjs'

const GROUPS = {
  'mac-arm64': ['mac-arm64'],
  'mac-all': ['mac-arm64', 'mac-x64'],
  'win-x64': ['win-x64'],
  all: ['mac-arm64', 'mac-x64', 'win-x64'],
}

function required(value, name) {
  if (!value?.trim()) throw new Error(`Hemi Desktop: ${name} is required`)
  return value
}

function targets(value) {
  if (Object.hasOwn(GROUPS, value)) return GROUPS[value]
  return value.split(',').map((target) => {
    if (target !== 'mac-arm64' && target !== 'mac-x64' && target !== 'win-x64') throw new Error('Hemi Desktop: invalid release target')
    return target
  })
}

function selectedOptions(values, services, environment) {
  const product = { version: services.productVersion }
  const desktop = { version: services.desktopVersion }
  if (desktop.version !== product.version) throw new Error('Hemi Desktop: product and desktop versions differ')
  const version = services.validateBuildVersion(required(values.version ?? environment.HEMI_RELEASE_VERSION, 'version'), product.version)
  const channel = values.channel ?? environment.HEMI_RELEASE_CHANNEL
  if (channel !== 'stable' && channel !== 'nightly') throw new Error('Hemi Desktop: channel must be stable or nightly')
  if (channel === 'stable' && version.includes('-')) throw new Error('Hemi Desktop: stable requires a stable version')
  const repository = required(values.repository ?? environment.GITHUB_REPOSITORY, 'repository')
  const branch = values.branch ?? environment.HEMI_DESKTOP_FEED_BRANCH ?? 'desktop-update-feeds'
  resolveHemiGitHubDistribution({ DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
    HEMI_DESKTOP_GITHUB_REPOSITORY: repository, HEMI_DESKTOP_GITHUB_FEED_BRANCH: branch })
  const commit = required(values.commit ?? environment.GITHUB_SHA, 'commit')
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error('Hemi Desktop: commit must be a complete Git SHA')
  const signingMode = values['signing-mode'] ?? (environment.HEMI_RELEASE_SIGNING_MODE || 'official')
  if (!['community', 'official'].includes(signingMode)) throw new Error('Hemi Desktop: signing mode must be community or official')
  const selected = targets(values.targets ?? environment.HEMI_RELEASE_TARGETS ?? 'mac-arm64')
  if (new Set(selected).size !== selected.length) throw new Error('Hemi Desktop: duplicate release target')
  return { repository, branch, version, channel, commit, targets: selected, signingMode,
    artifactsRoot: resolve(values.artifacts ?? environment.HEMI_RELEASE_ARTIFACTS ?? '.artifacts/hemi-desktop-release') }
}

/**
 * Run build preparation, package staging, preview or publication with shell-owned packaging operations.
 * @param {import('./command.mjs').HemiGitHubCommandServices} services Existing Desktop version, configuration and artifact operations.
 * @param {string[]} argv Command arguments; omitted reads the current process arguments.
 * @param {NodeJS.ProcessEnv} environment Workflow inputs; omitted reads the current process environment.
 * @returns {Promise<void>} Completion, or a failure that stops dependent publication work.
 */
export async function runHemiGitHubReleaseCommand(services, argv = process.argv.slice(2), environment = process.env) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    'signing-mode': { type: 'string' }, version: { type: 'string' }, channel: { type: 'string' }, repository: { type: 'string' }, branch: { type: 'string' },
    commit: { type: 'string' }, targets: { type: 'string' }, artifacts: { type: 'string' }, target: { type: 'string' },
  } })
  const command = positionals[0]
  if (positionals.length !== 1 || !['prepare', 'check', 'stage', 'preview', 'publish', 'cua'].includes(command ?? '')) {
    throw new Error('Usage: github:release prepare|check|stage|preview|publish [--version V --channel stable|nightly --targets TARGETS --artifacts DIRECTORY]')
  }
  if (command === 'prepare') {
    if (environment.GITHUB_REF_TYPE === 'tag') {
      const prefix = 'hemi-desktop-v'
      const tag = required(environment.GITHUB_REF_NAME, 'GITHUB_REF_NAME')
      if (!tag.startsWith(prefix)) throw new Error('Hemi Desktop: release trigger tag must start with hemi-desktop-v')
      values.version = tag.slice(prefix.length)
    }
    values.channel ??= environment.HEMI_RELEASE_CHANNEL || (values.version?.includes('-') ? 'nightly' : 'stable')
  }
  const options = selectedOptions(values, services, environment)
  if (command === 'prepare') {
    const matrix = options.targets.map((target) => {
      const windows = target === 'win-x64'
      const community = options.signingMode === 'community'
      return { target, runner: community
        ? [windows ? 'windows-latest' : target === 'mac-x64' ? 'macos-15-intel' : 'macos-15']
        : windows
          ? ['self-hosted', 'Windows', 'X64', environment.HEMI_DESKTOP_WINDOWS_RUNNER || 'dsh-win-package-trial']
          : ['self-hosted', 'macOS', 'ARM64', environment.HEMI_DESKTOP_MAC_RUNNER || 'dsh-mac-package-trial'],
      configDirectory: community ? '' : required(windows ? environment.HEMI_DESKTOP_WINDOWS_CONFIG_DIR : environment.HEMI_DESKTOP_MAC_CONFIG_DIR,
        windows ? 'HEMI_DESKTOP_WINDOWS_CONFIG_DIR' : 'HEMI_DESKTOP_MAC_CONFIG_DIR') }
    })
    const output = { signing_mode: options.signingMode, version: options.version, channel: options.channel, targets: options.targets.join(','), matrix: JSON.stringify({ include: matrix }) }
    if (environment.GITHUB_OUTPUT) appendFileSync(environment.GITHUB_OUTPUT, Object.entries(output).map(([key, value]) => `${key}=${value}\n`).join(''))
    console.log(JSON.stringify(output, null, 2))
    return
  }
  if (command === 'cua') {
    if (options.signingMode !== 'community' || services.prepareComputerUse === undefined) throw new Error('Hemi Desktop: community helper preparation is unavailable')
    await services.prepareComputerUse()
    return
  }
  if (command === 'check' || command === 'stage') {
    const target = required(values.target, 'target')
    if (!options.targets.includes(target)) throw new Error('Hemi Desktop: target is not in selected package set')
    const platform = target === 'win-x64' ? 'win32' : 'darwin'
    const packaging = services.loadEnvironment(platform)
    const distribution = resolveHemiGitHubDistribution(packaging)
    if (distribution?.repository !== options.repository || distribution.branch !== options.branch) {
      throw new Error('Hemi Desktop: signing preset GitHub repository/branch differs from this workflow')
    }
    if ((resolveHemiCommunitySigning(packaging, platform) !== undefined) !== (options.signingMode === 'community')) throw new Error('Hemi Desktop: preset signing mode differs from the selected workflow mode')
    if (command === 'check') { console.log(`GitHub packaging destination: ${options.repository} / ${options.branch}`); return }
    const source = services.artifactsDirectory(target)
    const destination = join(options.artifactsRoot, target)
    await mkdir(destination, { recursive: true })
    const suffix = platform === 'darwin' ? '-mac' : ''
    const record = JSON.parse(readFileSync(join(source, `${target}-release.json`), 'utf8'))
    const stem = `${resolveHemiDesktopIdentity(record)?.artifactPrefix ?? 'deepseek-harness'}-${options.version}-${platform === 'darwin' ? 'mac' : 'win'}-${target.endsWith('arm64') ? 'arm64' : 'x64'}`
    const extension = platform === 'darwin' ? 'zip' : 'exe'
    const names = [`${target}-release.json`, `${options.channel}${suffix}.yml`, `${stem}.${extension}`, `${stem}.${extension}.blockmap`,
      ...(platform === 'darwin' ? [`${stem}.dmg`] : [])]
    for (const name of names) await cp(join(source, name), join(destination, name), { errorOnExist: true, force: false })
    await prepareHemiGitHubRelease({ ...options, targets: [target] })
    if (environment.GITHUB_OUTPUT) appendFileSync(environment.GITHUB_OUTPUT, `directory=${options.artifactsRoot}\n`)
    console.log(`Verified ${target} completed package for GitHub publication`)
    return
  }
  const plan = await prepareHemiGitHubRelease(options)
  await mkdir(options.artifactsRoot, { recursive: true })
  await writeFile(join(options.artifactsRoot, 'release-plan.json'), `${JSON.stringify(plan, null, 2)}\n`)
  console.log(JSON.stringify({ tag: plan.tag, repository: plan.repository, branch: plan.branch,
    assets: plan.assets.map(({ name, size, sha256 }) => ({ name, size, sha256 })), feeds: plan.feeds.map(feed => feed.path) }, null, 2))
  if (command === 'publish') {
    const result = await publishHemiGitHubRelease(plan, createHemiGitHubClient(required(environment.GH_TOKEN, 'GH_TOKEN')))
    console.log(`Published ${result.tag}; feed branch ${result.branch} confirmed${result.commit === undefined ? ' (already current)' : ` at ${result.commit}`}`)
  }
}
