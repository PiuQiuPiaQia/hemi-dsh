import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dump, load } from 'js-yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveHemiGitHubDistribution, resolveHemiGitHubUpdate } from '../release/config.mjs'
import { resolveHemiCommunitySigning } from '../release/signing.mjs'
import { runHemiGitHubReleaseCommand } from '../release/command.mjs'
import {
  createHemiGitHubClient, prepareHemiGitHubRelease, publishHemiGitHubRelease,
  type HemiGitHubAsset, type HemiGitHubClient, type HemiGitHubReleaseOptions,
} from '../release/publish.mjs'

const roots: string[] = []
const COMMIT = 'a'.repeat(40)
const DISTRIBUTION = { DSH_DESKTOP_AUTO_UPDATE_ENV: 'production', HEMI_DESKTOP_GITHUB_REPOSITORY: 'example/hemi-dsh' }

async function fixture(targets: HemiGitHubReleaseOptions['targets'] = ['mac-arm64'], channel: 'stable' | 'nightly' = 'stable'):
Promise<HemiGitHubReleaseOptions> {
  const artifactsRoot = await mkdtemp(join(tmpdir(), 'hemi-github-release-'))
  roots.push(artifactsRoot)
  const version = channel === 'stable' ? '1.2.3' : '1.2.3-alpha.1'
  for (const target of targets) {
    const directory = join(artifactsRoot, target)
    await mkdir(directory)
    const windows = target === 'win-x64'
    const stem = `deepseek-harness-${version}-${windows ? 'win' : 'mac'}-${target.endsWith('arm64') ? 'arm64' : 'x64'}`
    const name = `${stem}.${windows ? 'exe' : 'zip'}`
    const payload = Buffer.from(`inert ${target} update payload`)
    const sha512 = createHash('sha512').update(payload).digest('base64')
    await writeFile(join(directory, name), payload)
    await writeFile(join(directory, `${name}.blockmap`), 'inert blockmap')
    if (!windows) await writeFile(join(directory, `${stem}.dmg`), 'inert installer')
    await writeFile(join(directory, `${channel}${windows ? '' : '-mac'}.yml`), dump({ version,
      files: [{ url: name, size: payload.length, sha512 }], path: name, sha512 }))
    await writeFile(join(directory, `${target}-release.json`), JSON.stringify({ schemaVersion: 1, target, version,
      channel, environment: 'production', publicUrl: resolveHemiGitHubUpdate(DISTRIBUTION, target, channel)!.publicUrl,
      commit: COMMIT, dirty: false }))
  }
  return { repository: 'example/hemi-dsh', branch: 'desktop-update-feeds', version, channel, commit: COMMIT, targets, artifactsRoot }
}

interface RemoteAsset { name: string; size: number; digest: string; state: string }
interface RemoteRelease { id: number; tag_name: string; body: string; draft: boolean; prerelease: boolean }

/** In-memory GitHub API retains remote writes across interrupted publisher invocations. */
class GitHub implements HemiGitHubClient {
  readonly calls: { method: string; path: string; body: object | undefined }[] = []
  readonly files = new Map<string, string>()
  readonly assets: RemoteAsset[] = []
  release: RemoteRelease | undefined
  head: string | undefined
  tagCommit: string | undefined
  uploads = 0
  failUpload = false
  failFeed = false
  failPublish = false
  private tree: { path: string; content: string }[] = []

  request: HemiGitHubClient['request'] = async (method, path, body) => {
    this.calls.push({ method, path, body })
    const data = body as Record<string, unknown> | undefined
    if (method === 'GET') {
      if (path === 'repos/example/hemi-dsh') return { private: false, default_branch: 'master' }
      if (path.includes('/contents/')) {
        const name = path.split('/contents/')[1]!.split('?')[0]!
        const content = this.files.get(name)
        return content === undefined ? undefined : { type: 'file', encoding: 'base64', content: Buffer.from(content).toString('base64') }
      }
      if (path.includes('/git/ref/heads/')) return this.head === undefined ? undefined : { object: { sha: this.head } }
      if (path.includes('/git/commits/')) return { tree: { sha: 'previous-tree' } }
      if (path.includes('/git/ref/tags/')) return this.tagCommit === undefined ? undefined : { object: { type: 'commit', sha: this.tagCommit } }
      if (path.includes('/commits/')) return { sha: COMMIT }
      if (path.includes('/assets?')) return [...this.assets]
      if (path.includes('/releases/')) return this.release === undefined ? undefined : { ...this.release }
    }
    if (method === 'POST' && path.endsWith('/releases')) {
      this.release = { id: 7, tag_name: String(data!.tag_name), body: String(data!.body),
        draft: true, prerelease: data!.prerelease === true }
      return { ...this.release }
    }
    if (method === 'PATCH' && path.includes('/releases/')) {
      this.release!.draft = false
      if (this.failPublish) throw new Error('publication response lost')
      return { ...this.release }
    }
    if (method === 'POST' && path.endsWith('/git/trees')) {
      this.tree = data!.tree as { path: string; content: string }[]
      return { sha: 'new-tree' }
    }
    if (method === 'POST' && path.endsWith('/git/commits')) return { sha: 'new-commit' }
    if (method === 'POST' && path.endsWith('/git/refs') && String(data!.ref).startsWith('refs/tags/')) {
      this.tagCommit = String(data!.sha)
      return { object: { sha: this.tagCommit } }
    }
    if ((method === 'PATCH' && path.includes('/git/refs/heads/')) || (method === 'POST' && path.endsWith('/git/refs'))) {
      if (this.failFeed) throw new Error('concurrent branch movement')
      expect(data!.force).not.toBe(true)
      this.head = String(data!.sha)
      for (const file of this.tree) this.files.set(file.path, file.content)
      return { object: { sha: this.head } }
    }
    throw new Error(`Unexpected API operation: ${method} ${path}`)
  }

  async upload(_repository: string, _releaseId: number, file: HemiGitHubAsset): Promise<RemoteAsset> {
    this.uploads++
    const asset = { name: file.name, size: file.size, state: 'uploaded', digest: `sha256:${file.sha256}` }
    this.assets.push(asset)
    if (this.failUpload) { this.failUpload = false; throw new Error('upload response lost') }
    return asset
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('GitHub distribution selection', () => {
  it('preserves unconfigured DSH distribution', () => {
    expect(resolveHemiGitHubDistribution({})).toBeUndefined()
    expect(resolveHemiGitHubUpdate({}, 'mac-arm64', 'stable')).toBeUndefined()
  })

  it.each([
    { HEMI_DESKTOP_UPDATE_POLICY: 'disabled' },
    { ...DISTRIBUTION, HEMI_DESKTOP_GITHUB_REPOSITORY: 'https://github.com/example/repo' },
    { ...DISTRIBUTION, HEMI_DESKTOP_GITHUB_REPOSITORY: 'example/repo.git' },
    { ...DISTRIBUTION, HEMI_DESKTOP_GITHUB_FEED_BRANCH: 'master' },
    { ...DISTRIBUTION, HEMI_DESKTOP_GITHUB_FEED_BRANCH: '../feeds' },
    { ...DISTRIBUTION, HEMI_DESKTOP_UPDATE_POLICY: 'false' },
    { ...DISTRIBUTION, DSH_DESKTOP_AUTO_UPDATE_ENV: 'test' },
  ])('rejects invalid or partial configuration %#', (environment) => {
    expect(() => resolveHemiGitHubDistribution(environment)).toThrow()
  })

  it('resolves custom branches and explicit policy disablement', () => {
    expect(resolveHemiGitHubDistribution({ ...DISTRIBUTION, HEMI_DESKTOP_GITHUB_FEED_BRANCH: 'updates', HEMI_DESKTOP_UPDATE_POLICY: 'disabled' }))
      .toEqual({ repository: 'example/hemi-dsh', branch: 'updates', policy: 'disabled' })
  })
})

describe('completed GitHub package validation', () => {
  it('requires an explicit community record and the pinned Mac certificate', async () => {
    const options = await fixture()
    const path = join(options.artifactsRoot, 'mac-arm64/mac-arm64-release.json')
    const record = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    const signing = resolveHemiCommunitySigning({ ...DISTRIBUTION, HEMI_DESKTOP_SIGNING_MODE: 'community' }, 'darwin')
    if (signing?.kind !== 'mac-self-signed') throw new Error('expected fixed certificate')
    await expect(prepareHemiGitHubRelease({ ...options, signingMode: 'community' })).rejects.toThrow('signing mode')
    record.hemiSigning = signing.kind
    record.hemiSigningSha256 = signing.sha256
    await writeFile(path, JSON.stringify(record))
    await expect(prepareHemiGitHubRelease({ ...options, signingMode: 'community' })).resolves.toMatchObject({ version: options.version })
    await expect(prepareHemiGitHubRelease(options)).rejects.toThrow('signing mode')
    record.hemiSigningSha256 = 'different certificate'
    await writeFile(path, JSON.stringify(record))
    await expect(prepareHemiGitHubRelease({ ...options, signingMode: 'community' })).rejects.toThrow('fixed Hemi certificate')
  })

  it('selects hosted community runners without a formal signing-machine configuration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hemi-community-selection-'))
    roots.push(root)
    const output = join(root, 'selection')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await runHemiGitHubReleaseCommand({ productVersion: '1.2.3', desktopVersion: '1.2.3',
      validateBuildVersion: value => value, loadEnvironment: () => DISTRIBUTION, artifactsDirectory: () => root }, ['prepare'], {
      HEMI_RELEASE_SIGNING_MODE: 'community', HEMI_RELEASE_VERSION: '1.2.3', HEMI_RELEASE_CHANNEL: 'stable',
      HEMI_RELEASE_TARGETS: 'all', GITHUB_REPOSITORY: 'example/hemi-dsh', GITHUB_SHA: COMMIT, GITHUB_OUTPUT: output,
    })
    const text = await readFile(output, 'utf8')
    await expect(text).toMatchFileSnapshot('./expected/community-runners.txt')
    expect(text).toContain('signing_mode=community')
    expect(text).toContain('macos-15-intel')
    expect(text).toContain('windows-latest')
    expect(text).not.toContain('self-hosted')
  })

  it('stages completed packages and previews the executable CLI without credentials or network', async () => {
    const options = await fixture()
    const staged = await mkdtemp(join(tmpdir(), 'hemi-github-staged-'))
    roots.push(staged)
    const environment = { ...DISTRIBUTION, GITHUB_REPOSITORY: options.repository, GITHUB_SHA: COMMIT,
      HEMI_RELEASE_VERSION: options.version, HEMI_RELEASE_CHANNEL: options.channel, HEMI_RELEASE_ARTIFACTS: staged }
    const services = { productVersion: options.version, desktopVersion: options.version,
      validateBuildVersion: (version: string) => version,
      loadEnvironment: () => DISTRIBUTION,
      artifactsDirectory: (target: string) => join(options.artifactsRoot, target) }
    const fetch = vi.fn(() => { throw new Error('preview must not contact GitHub') })
    vi.stubGlobal('fetch', fetch)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await runHemiGitHubReleaseCommand(services, ['stage', '--target', 'mac-arm64'], environment)
    await runHemiGitHubReleaseCommand(services, ['preview'], environment)
    const plan = JSON.parse(await readFile(join(staged, 'release-plan.json'), 'utf8')) as { version: string; assets: object[] }
    expect(plan.version).toBe(options.version)
    expect(plan.assets).toHaveLength(3)
    expect(fetch).not.toHaveBeenCalled()
    await expect(runHemiGitHubReleaseCommand({ ...services, loadEnvironment: () => ({ ...DISTRIBUTION,
      HEMI_DESKTOP_GITHUB_REPOSITORY: 'wrong/repo' }) }, ['check', '--target', 'mac-arm64'], environment))
      .rejects.toThrow('differs from this workflow')
  })

  it('records all platforms and channels without colliding macOS manifests', async () => {
    const options = await fixture(['mac-arm64', 'mac-x64', 'win-x64'])
    const plan = await prepareHemiGitHubRelease(options)
    expect(plan.assets).toHaveLength(8)
    await expect(JSON.stringify({ tag: plan.tag, assets: plan.assets.map(({ name }) => name), feeds: plan.feeds }, null, 2) + '\n')
      .toMatchFileSnapshot('./expected/github-release.json')
    expect((await prepareHemiGitHubRelease(options)).fingerprint).toBe(plan.fingerprint)
    const nightly = await prepareHemiGitHubRelease(await fixture(['win-x64'], 'nightly'))
    expect(nightly.feeds[0]!.path).toBe('feeds/win-x64/nightly.yml')
    expect(nightly.tag).toBe('hemi-desktop-nightly-v1.2.3-alpha.1')
  })

  it.each(['dirty', 'commit', 'publicUrl', 'channel', 'version', 'schemaVersion', 'target', 'environment'])('rejects mismatched completion field %s', async (field) => {
    const options = await fixture()
    const path = join(options.artifactsRoot, 'mac-arm64/mac-arm64-release.json')
    const record = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    record[field] = field === 'dirty' ? true : 'different'
    await writeFile(path, JSON.stringify(record))
    await expect(prepareHemiGitHubRelease(options)).rejects.toThrow('completion record')
  })

  it.each(['sha512', 'size', 'url', 'version'])('rejects inconsistent metadata %s', async (field) => {
    const options = await fixture()
    const path = join(options.artifactsRoot, 'mac-arm64/stable-mac.yml')
    const data = JSON.parse(JSON.stringify(load(await readFile(path, 'utf8')))) as { version: string; files: Record<string, unknown>[] }
    if (field === 'version') data.version = '0.1.0'
    else data.files[0]![field] = field === 'size' ? 12345 : '../different.zip'
    await writeFile(path, dump(data))
    await expect(prepareHemiGitHubRelease(options)).rejects.toThrow()
  })

  it('rejects unsigned or unnotarized artifacts without a completion record', async () => {
    const options = await fixture()
    await rm(join(options.artifactsRoot, 'mac-arm64/mac-arm64-release.json'))
    await expect(prepareHemiGitHubRelease(options)).rejects.toThrow()
  })

  it('rejects symlinked artifacts and changed updater bytes', async () => {
    const options = await fixture()
    const path = join(options.artifactsRoot, 'mac-arm64/deepseek-harness-1.2.3-mac-arm64.zip')
    await writeFile(path, 'different payload')
    await expect(prepareHemiGitHubRelease(options)).rejects.toThrow('checksum')
    await rm(path)
    // Windows directory junctions need no developer-mode or symbolic-link privilege.
    await symlink(process.platform === 'win32' ? options.artifactsRoot : 'deepseek-harness-1.2.3-mac-arm64.dmg', path,
      process.platform === 'win32' ? 'junction' : 'file')
    await expect(prepareHemiGitHubRelease(options)).rejects.toThrow('regular artifact')
  })
})

describe('single-publisher recovery and feed advancement', () => {
  it('stops on malformed existing feed trees rather than dropping unrelated files', async () => {
    const plan = await prepareHemiGitHubRelease(await fixture())
    const github = new GitHub()
    github.head = 'old-commit'
    const original = github.request
    github.request = async (...args) => args[1].includes('/git/commits/') ? {} : original(...args)
    await expect(publishHemiGitHubRelease(plan, github)).rejects.toThrow('existing feeds must be preserved')
    expect(github.calls.every(call => call.method === 'GET')).toBe(true)
  })

  it('requires a public repository before creating tags or releases', async () => {
    const plan = await prepareHemiGitHubRelease(await fixture())
    const github = new GitHub()
    const original = github.request
    github.request = async (...args) => args[1] === 'repos/example/hemi-dsh' ? { private: true } : original(...args)
    await expect(publishHemiGitHubRelease(plan, github)).rejects.toThrow('public repository')
    expect(github.release).toBeUndefined()
    expect(github.uploads).toBe(0)
  })

  it('publishes verified assets before creating the feed branch, then reruns without writes', async () => {
    const plan = await prepareHemiGitHubRelease(await fixture())
    const github = new GitHub()
    await publishHemiGitHubRelease(plan, github)
    const publish = github.calls.findIndex(call => call.method === 'PATCH' && call.path.includes('/releases/'))
    const advance = github.calls.findIndex(call => call.path.endsWith('/git/refs')
      && call.body !== undefined && 'ref' in call.body && call.body.ref === `refs/heads/${plan.branch}`)
    expect(publish).toBeGreaterThan(-1)
    expect(advance).toBeGreaterThan(publish)
    expect(github.tagCommit).toBe(COMMIT)
    expect(github.files.get(plan.feeds[0]!.path)).toBe(plan.feeds[0]!.contents)
    expect(github.calls.find(call => call.method === 'POST' && call.path.endsWith('/releases'))!.body)
      .toMatchObject({ generate_release_notes: true })
    github.release!.body += '\n\nGenerated release notes\n'
    github.calls.length = 0
    expect((await publishHemiGitHubRelease(plan, github)).commit).toBeUndefined()
    expect(github.calls.every(call => call.method === 'GET')).toBe(true)
    expect(github.uploads).toBe(plan.assets.length)
  })

  it('preserves other architectures and channels while advancing an older feed', async () => {
    const plan = await prepareHemiGitHubRelease(await fixture())
    const github = new GitHub()
    github.head = 'old-commit'
    github.files.set('feeds/mac-x64/stable-mac.yml', 'older intel feed')
    github.files.set('feeds/mac-arm64/nightly-mac.yml', 'independent nightly feed')
    github.files.set(plan.feeds[0]!.path, dump({ version: '1.2.2' }))
    await publishHemiGitHubRelease(plan, github)
    expect(github.files.get('feeds/mac-x64/stable-mac.yml')).toBe('older intel feed')
    expect(github.files.get('feeds/mac-arm64/nightly-mac.yml')).toBe('independent nightly feed')
    expect(github.calls.find(call => call.path.endsWith('/git/commits') && call.method === 'POST')!.body)
      .toMatchObject({ parents: ['old-commit'] })
    expect(github.calls.find(call => call.method === 'PATCH' && call.path.includes('/git/refs/'))!.body)
      .toMatchObject({ force: false })
  })

  it('reconciles an upload whose response was lost without duplicate or destructive uploads', async () => {
    const plan = await prepareHemiGitHubRelease(await fixture())
    const github = new GitHub()
    github.failUpload = true
    await expect(publishHemiGitHubRelease(plan, github)).rejects.toThrow('response lost')
    expect(github.uploads).toBe(1)
    expect(github.head).toBeUndefined()
    await publishHemiGitHubRelease(plan, github)
    expect(github.uploads).toBe(plan.assets.length)
  })

  it('reconciles a published Release after a lost publication response', async () => {
    const plan = await prepareHemiGitHubRelease(await fixture())
    const github = new GitHub()
    github.failPublish = true
    await expect(publishHemiGitHubRelease(plan, github)).rejects.toThrow('response lost')
    expect(github.head).toBeUndefined()
    await publishHemiGitHubRelease(plan, github)
    expect(github.uploads).toBe(plan.assets.length)
    expect(github.head).toBe('new-commit')
  })

  it('retains a published package when feed advancement fails, then resumes only feeds', async () => {
    const plan = await prepareHemiGitHubRelease(await fixture())
    const github = new GitHub()
    github.failFeed = true
    await expect(publishHemiGitHubRelease(plan, github)).rejects.toThrow('branch movement')
    expect(github.release!.draft).toBe(false)
    expect(github.head).toBeUndefined()
    github.failFeed = false
    await publishHemiGitHubRelease(plan, github)
    expect(github.uploads).toBe(plan.assets.length)
  })

  it.each(['1.2.3', '1.2.4', 'invalid'])('does not replace a conflicting feed at %s', async (version) => {
    const plan = await prepareHemiGitHubRelease(await fixture())
    const github = new GitHub()
    github.head = 'old'
    github.files.set(plan.feeds[0]!.path, dump({ version }))
    await expect(publishHemiGitHubRelease(plan, github)).rejects.toThrow('older valid version')
    expect(github.calls.every(call => call.method === 'GET')).toBe(true)
  })

  it('never overwrites mismatched remote assets or a conflicting source tag', async () => {
    const plan = await prepareHemiGitHubRelease(await fixture())
    const github = new GitHub()
    github.tagCommit = 'b'.repeat(40)
    await expect(publishHemiGitHubRelease(plan, github)).rejects.toThrow('different source commit')
    expect(github.uploads).toBe(0)
    github.tagCommit = COMMIT
    github.assets.push({ name: plan.assets[0]!.name, size: 1, state: 'uploaded', digest: 'sha256:wrong' })
    await expect(publishHemiGitHubRelease(plan, github)).rejects.toThrow('differs')
    expect(github.uploads).toBe(0)
    expect(github.head).toBeUndefined()
  })

  it('rejects changed local bytes before any remote mutation', async () => {
    const plan = await prepareHemiGitHubRelease(await fixture())
    await writeFile(plan.assets[0]!.path, 'changed after preview')
    const github = new GitHub()
    await expect(publishHemiGitHubRelease(plan, github)).rejects.toThrow('changed after preview')
    expect(github.calls.every(call => call.method === 'GET')).toBe(true)
  })
})

describe('production GitHub HTTP client', () => {
  it('uploads actual file bytes to the fixed GitHub upload origin', async () => {
    const plan = await prepareHemiGitHubRelease(await fixture())
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ digest: `sha256:${plan.assets[0]!.sha256}` })))
    vi.stubGlobal('fetch', fetch)
    await createHemiGitHubClient('test-token').upload(plan.repository, 7, plan.assets[0]!)
    const [url, init] = fetch.mock.calls[0]! as [string, RequestInit]
    expect(new URL(url).origin).toBe('https://uploads.github.com')
    expect(init.redirect).toBe('error')
    expect(init.body).toBeInstanceOf(Blob)
    expect(Buffer.from(await (init.body as Blob).arrayBuffer())).toEqual(await readFile(plan.assets[0]!.path))
  })

  it('requires a publishing token and treats only an explicit 404 as absence', async () => {
    expect(() => createHemiGitHubClient('')).toThrow('GH_TOKEN')
    const fetch = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 404 }))
      .mockResolvedValueOnce(new Response('secret server detail', { status: 403 }))
    vi.stubGlobal('fetch', fetch)
    const client = createHemiGitHubClient('test-token')
    expect(await client.request('GET', 'repos/example/repo', undefined, true)).toBeUndefined()
    await expect(client.request('GET', 'repos/example/repo', undefined, true)).rejects.toThrow('HTTP 403')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[0]![1]).toMatchObject({ redirect: 'error' })
  })

  it('reports unknown request outcomes without leaking errors or automatically retrying', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('test-token raw transport detail'))
    vi.stubGlobal('fetch', fetch)
    await expect(createHemiGitHubClient('test-token').request('POST', 'repos/example/repo/releases', {}))
      .rejects.toThrow('did not confirm completion')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
