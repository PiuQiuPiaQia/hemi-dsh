/** Single-writer GitHub publication: verified Release assets precede atomic feed advancement. */

import { createHash } from 'node:crypto'
import { createReadStream, openAsBlob } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dump, load } from 'js-yaml'
import { gt, valid } from 'semver'
import { resolveHemiDesktopIdentity } from './identity.mjs'
import { resolveHemiCommunitySigning } from './signing.mjs'
import { resolveHemiGitHubDistribution, resolveHemiGitHubUpdate } from './config.mjs'

const TARGETS = {
  'mac-arm64': { os: 'mac', arch: 'arm64', extension: 'zip', suffix: '-mac' },
  'mac-x64': { os: 'mac', arch: 'x64', extension: 'zip', suffix: '-mac' },
  'win-x64': { os: 'win', arch: 'x64', extension: 'exe', suffix: '' },
}

/** Publication failure; retries reconcile remote state and never overwrite conflicting assets. */
export class HemiGitHubReleaseError extends Error {
  /**
   * @param {string} code Stable failure classification.
   * @param {string} message Safe operator guidance without credentials or raw server responses.
   */
  constructor(code, message) {
    super(message)
    this.name = 'HemiGitHubReleaseError'
    this.code = code
  }
}

function requireValue(condition, message) {
  if (!condition) throw new HemiGitHubReleaseError('invalid-package', message)
}

async function artifact(path) {
  const info = await lstat(path)
  requireValue(info.isFile() && info.size > 0, `Not a nonempty regular artifact: ${path}`)
  const sha256 = createHash('sha256')
  const sha512 = createHash('sha512')
  for await (const bytes of createReadStream(path)) {
    sha256.update(bytes)
    sha512.update(bytes)
  }
  return { path, name: path.split(/[\\/]/u).at(-1), size: info.size,
    sha256: sha256.digest('hex'), sha512: sha512.digest('base64') }
}

/**
 * Validate completed signed packages and prepare architecture-specific, channel-specific feeds.
 * Each target directory must contain its ordinary DSH package completion record and artifacts.
 * @param {import('./publish.mjs').HemiGitHubReleaseOptions} options Frozen source, destination, version and artifact selection.
 * @returns {Promise<import('./publish.mjs').HemiGitHubReleasePlan>} Fully hashed assets and feed bytes; no network writes occur.
 */
export async function prepareHemiGitHubRelease(options) {
  const { repository, branch, version, channel, commit, targets, artifactsRoot } = options
  const environment = { DSH_DESKTOP_AUTO_UPDATE_ENV: 'production', HEMI_DESKTOP_GITHUB_REPOSITORY: repository,
    HEMI_DESKTOP_GITHUB_FEED_BRANCH: branch, DSH_DESKTOP_UPDATE_CHANNEL: channel }
  const distribution = resolveHemiGitHubDistribution(environment)
  requireValue(valid(version) === version && !version.includes('+'), 'Release version must be normalized semver without build metadata')
  requireValue(channel === 'stable' || channel === 'nightly', 'Channel must be stable or nightly')
  requireValue(channel !== 'stable' || !version.includes('-'), 'Stable requires a stable version')
  requireValue(/^[a-f0-9]{40}$/u.test(commit), 'Source commit must be a complete Git SHA')
  requireValue(Array.isArray(targets) && targets.length > 0 && new Set(targets).size === targets.length
    && targets.every(target => Object.hasOwn(TARGETS, target)), 'Select distinct supported release targets')
  const signingMode = options.signingMode ?? 'official'
  requireValue(signingMode === 'community' || signingMode === 'official', 'Invalid release signing mode')
  const tag = `hemi-desktop-${channel}-v${version}`
  const assets = []
  const feeds = []
  for (const target of targets) {
    const spec = TARGETS[target]
    const directory = join(artifactsRoot, target)
    const record = JSON.parse(await readFile(join(directory, `${target}-release.json`), 'utf8'))
    const update = resolveHemiGitHubUpdate(environment, target, channel)
    requireValue(record.schemaVersion === 1 && record.target === target && record.version === version
      && record.environment === 'production' && record.channel === channel && record.publicUrl === update.publicUrl
      && record.commit === commit && record.dirty === false, `Package completion record disagrees with release selection: ${target}`)
    const community = resolveHemiCommunitySigning({ ...environment, ...(signingMode === 'community' ? { HEMI_DESKTOP_SIGNING_MODE: 'community' } : {}) }, spec.os === 'mac' ? 'darwin' : 'win32')
    requireValue(record.hemiSigning === community?.kind, `Package signing mode disagrees with release selection: ${target}`)
    if (community?.kind === 'mac-self-signed') requireValue(record.hemiSigningSha256 === community.sha256, `Package certificate disagrees with the fixed Hemi certificate: ${target}`)
    const metadataName = `${channel}${spec.suffix}.yml`
    const metadata = load(await readFile(join(directory, metadataName), 'utf8'))
    const stem = `${resolveHemiDesktopIdentity(record)?.artifactPrefix ?? 'deepseek-harness'}-${version}-${spec.os}-${spec.arch}`
    const updaterName = `${stem}.${spec.extension}`
    requireValue(metadata?.version === version && Array.isArray(metadata.files) && metadata.files.length === 1,
      `Update metadata has the wrong version or file count: ${target}`)
    const declared = metadata.files[0]
    requireValue(declared?.url === updaterName && (!metadata.path || metadata.path === updaterName),
      `Update metadata must reference its target's local artifact: ${target}`)
    const updater = await artifact(join(directory, updaterName))
    requireValue(declared.size === updater.size && declared.sha512 === updater.sha512
      && (!metadata.sha512 || metadata.sha512 === updater.sha512), `Update checksum or size mismatch: ${target}`)
    assets.push(updater, await artifact(join(directory, `${updaterName}.blockmap`)))
    if (spec.os === 'mac') assets.push(await artifact(join(directory, `${stem}.dmg`)))
    const url = `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(updaterName)}`
    const contents = dump({ version, files: [{ url, sha512: updater.sha512, size: updater.size }],
      path: url, sha512: updater.sha512,
      ...(typeof metadata.releaseNotes === 'string' ? { releaseNotes: metadata.releaseNotes } : {}),
      ...(typeof metadata.releaseDate === 'string' ? { releaseDate: metadata.releaseDate } : {}) }, { lineWidth: -1, noRefs: true })
    feeds.push({ path: `feeds/${target}/${metadataName}`, contents })
  }
  requireValue(new Set(assets.map(file => file.name)).size === assets.length, 'Release asset names collide')
  const identity = { repository, branch: distribution.branch, tag, version, channel, commit,
    assets: assets.map(({ name, size, sha256 }) => ({ name, size, sha256 })).sort((a, b) => a.name.localeCompare(b.name)),
    feeds: [...feeds].sort((a, b) => a.path.localeCompare(b.path)) }
  const fingerprint = createHash('sha256').update(JSON.stringify(identity)).digest('hex')
  return { ...identity, assets, fingerprint }
}

/**
 * Create the production HTTP client. Only GitHub API and upload origins receive its token.
 * @param {string} token Workflow-scoped GitHub token; never stored in package data.
 * @returns {import('./publish.mjs').HemiGitHubClient} Bounded, non-retrying API and upload operations.
 */
export function createHemiGitHubClient(token) {
  if (!token?.trim()) throw new HemiGitHubReleaseError('configuration', 'Set GH_TOKEN for publication; preview needs no token')
  async function request(method, path, body, optional = false) {
    let response
    try {
      response = await fetch(`https://api.github.com/${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(120_000),
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Hemi-Desktop-Publisher', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      if (optional && response.status === 404) { await response.body?.cancel(); return undefined }
      if (!response.ok) {
        await response.body?.cancel()
        throw new HemiGitHubReleaseError('github-http', `GitHub ${method} ${path} returned HTTP ${response.status}; inspect the draft and feed branch before retrying`)
      }
      return await response.json()
    } catch (error) {
      if (error instanceof HemiGitHubReleaseError) throw error
      throw new HemiGitHubReleaseError('github-unknown', `GitHub ${method} ${path} did not confirm completion; rerun to reconcile remote state`)
    }
  }
  return {
    request,
    async upload(repository, releaseId, file) {
      const bytes = await openAsBlob(file.path)
      let response
      try {
        response = await fetch(`https://uploads.github.com/repos/${repository}/releases/${releaseId}/assets?name=${encodeURIComponent(file.name)}`,
          { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(600_000), body: bytes,
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
              'User-Agent': 'Hemi-Desktop-Publisher', 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size) } })
        if (!response.ok) {
          await response.body?.cancel()
          throw new HemiGitHubReleaseError('github-http', `GitHub asset upload returned HTTP ${response.status}; inspect the draft before retrying`)
        }
        return await response.json()
      } catch (error) {
        if (error instanceof HemiGitHubReleaseError) throw error
        throw new HemiGitHubReleaseError('github-unknown', 'GitHub asset upload did not confirm completion; rerun to reconcile remote state')
      }
    },
  }
}

function verifyAsset(remote, expected) {
  if (!remote || remote.state !== 'uploaded' || remote.size !== expected.size || remote.digest !== `sha256:${expected.sha256}`) {
    throw new HemiGitHubReleaseError('asset-conflict', `Release asset is absent, incomplete or differs: ${expected.name}; inspect the draft, no asset was overwritten`)
  }
}

function hasPackageMarker(release, marker) {
  return typeof release?.body === 'string' && release.body.split(/\r?\n/u).includes(marker)
}

async function prepareFeeds(plan, request) {
  const base = `repos/${plan.repository}`
  const ref = await request('GET', `${base}/git/ref/heads/${plan.branch}`, undefined, true)
  const head = ref?.object?.sha
  requireValue(ref === undefined || (typeof head === 'string' && head.length > 0), 'GitHub returned an invalid feed branch reference')
  const parent = head === undefined ? undefined : await request('GET', `${base}/git/commits/${head}`)
  requireValue(head === undefined || (typeof parent?.tree?.sha === 'string' && parent.tree.sha.length > 0), 'GitHub returned an invalid feed tree; existing feeds must be preserved')
  const changes = []
  for (const feed of plan.feeds) {
    const previous = head === undefined ? undefined
      : await request('GET', `${base}/contents/${feed.path}?ref=${head}`, undefined, true)
    if (previous !== undefined) {
      requireValue(previous.type === 'file' && previous.encoding === 'base64' && typeof previous.content === 'string', `Feed is not a regular base64 file: ${feed.path}`)
      const contents = Buffer.from(previous.content, 'base64').toString('utf8')
      if (contents === feed.contents) continue
      const version = load(contents)?.version
      if (valid(version) === null || !gt(plan.version, version)) {
        throw new HemiGitHubReleaseError('feed-conflict', `Feed ${feed.path} does not contain an older valid version; no feeds were changed`)
      }
    }
    changes.push({ path: feed.path, mode: '100644', type: 'blob', content: feed.contents })
  }
  return { head, tree: parent?.tree?.sha, changes }
}

async function verifySourceTag(plan, request) {
  const base = `repos/${plan.repository}`
  const source = await request('GET', `${base}/commits/${plan.commit}`)
  requireValue(source.sha === plan.commit, 'Source commit is not available in the release repository')
  const ref = await request('GET', `${base}/git/ref/tags/${plan.tag}`, undefined, true)
  if (ref === undefined) {
    await request('POST', `${base}/git/refs`, { ref: `refs/tags/${plan.tag}`, sha: plan.commit })
    return
  }
  let object = ref.object
  for (let depth = 0; object?.type === 'tag' && depth < 5; depth++) {
    object = (await request('GET', `${base}/git/tags/${object.sha}`)).object
  }
  requireValue(object?.type === 'commit' && object.sha === plan.commit, 'Existing release tag points to a different source commit')
}

/**
 * Publish one verified package set, then advance only its target/channel files in one commit.
 * Retries reconcile matching draft or published assets; conflicts stop without overwriting.
 * Failed or unconfirmed requests stop dependent writes; already published files remain public.
 * Feed writes are fast-forward only and preserve other platforms and channels.
 * @param {import('./publish.mjs').HemiGitHubReleasePlan} plan Prepared artifact hashes and feed contents.
 * @param {import('./publish.mjs').HemiGitHubClient} client GitHub HTTP operations; replaceable for offline qualification.
 * @returns {Promise<{ tag: string, branch: string, commit: string | undefined }>} Confirmed publication and optional feed commit.
 */
export async function publishHemiGitHubRelease(plan, client) {
  const { request } = client
  const base = `repos/${plan.repository}`
  const repository = await request('GET', base)
  requireValue(repository.private === false && repository.default_branch !== plan.branch, 'Use a public repository and a dedicated feed branch')
  // Revalidate local bytes before creating any remote object.
  for (const file of plan.assets) {
    const actual = await artifact(file.path)
    requireValue(actual.sha256 === file.sha256 && actual.size === file.size, `Local asset changed after preview: ${file.name}`)
  }
  const feeds = await prepareFeeds(plan, request)
  await verifySourceTag(plan, request)
  const marker = `Hemi Desktop package: ${plan.fingerprint}`
  let release = await request('GET', `${base}/releases/tags/${plan.tag}`, undefined, true)
  if (release === undefined) {
    release = await request('POST', `${base}/releases`, { tag_name: plan.tag, target_commitish: plan.commit,
      name: `hemi-dsh ${plan.version} (${plan.channel})`, body: marker, generate_release_notes: true,
      draft: true, prerelease: plan.channel === 'nightly' })
  }
  requireValue(release.tag_name === plan.tag && hasPackageMarker(release, marker) && release.prerelease === (plan.channel === 'nightly'),
    'Existing Release does not match this package selection; no Release was overwritten')
  requireValue(Number.isSafeInteger(release.id) && release.id > 0 && typeof release.draft === 'boolean', 'GitHub returned invalid Release metadata')
  const listed = await request('GET', `${base}/releases/${release.id}/assets?per_page=100`)
  requireValue(Array.isArray(listed) && listed.every(file => plan.assets.some(expected => expected.name === file.name)),
    'Release contains unexpected assets; inspect the draft before retrying')
  for (const file of plan.assets) {
    const existing = listed.find(asset => asset.name === file.name)
    if (existing !== undefined) { verifyAsset(existing, file); continue }
    requireValue(release.draft === true, `Published Release is missing ${file.name}; published assets are never overwritten`)
    const current = await request('GET', `${base}/releases/${release.id}`)
    requireValue(current.draft === true && hasPackageMarker(current, marker), 'Release changed during upload; feeds were not advanced')
    verifyAsset(await client.upload(plan.repository, release.id, file), file)
  }
  const verified = await request('GET', `${base}/releases/${release.id}/assets?per_page=100`)
  requireValue(verified.length === plan.assets.length, 'Release asset set changed during upload')
  for (const file of plan.assets) verifyAsset(verified.find(asset => asset.name === file.name), file)
  if (release.draft) {
    await request('PATCH', `${base}/releases/${release.id}`, { draft: false, make_latest: plan.channel === 'stable' ? 'true' : 'false' })
  }
  release = await request('GET', `${base}/releases/${release.id}`)
  requireValue(release.draft === false && hasPackageMarker(release, marker) && release.tag_name === plan.tag
    && release.prerelease === (plan.channel === 'nightly'), 'Release publication was not confirmed; feeds were not advanced')
  if (feeds.changes.length === 0) return { tag: plan.tag, branch: plan.branch, commit: undefined }
  const tree = await request('POST', `${base}/git/trees`, { ...(feeds.tree === undefined ? {} : { base_tree: feeds.tree }), tree: feeds.changes })
  requireValue(typeof tree?.sha === 'string' && tree.sha.length > 0, 'GitHub did not confirm the new feed tree')
  const commit = await request('POST', `${base}/git/commits`, { message: `Publish ${plan.tag}`, tree: tree.sha,
    parents: feeds.head === undefined ? [] : [feeds.head] })
  requireValue(typeof commit?.sha === 'string' && commit.sha.length > 0, 'GitHub did not confirm the new feed commit')
  if (feeds.head === undefined) await request('POST', `${base}/git/refs`, { ref: `refs/heads/${plan.branch}`, sha: commit.sha })
  else await request('PATCH', `${base}/git/refs/heads/${plan.branch}`, { sha: commit.sha, force: false })
  const confirmed = await request('GET', `${base}/git/ref/heads/${plan.branch}`)
  requireValue(confirmed.object?.sha === commit.sha, 'Feed branch changed before confirmation; inspect branch state before retrying')
  return { tag: plan.tag, branch: plan.branch, commit: commit.sha }
}
