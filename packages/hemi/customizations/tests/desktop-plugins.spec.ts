import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { hemiDesktopPreinstalledBundles, markHemiDesktopBundlesSeeded, seedHemiDesktopBundles, stageHemiDesktopPluginSources } from '../release/desktop-plugins.mjs'

/** The pinned third-party distributions the dsh CLI package carries in the workspace. */
const canonicalSources = fileURLToPath(new URL('../../../../apps/cli/third-party', import.meta.url))
const canonicalDistribution = join(canonicalSources, 'dsh-pocket')

const roots: string[] = []
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-hemi-desktop-plugins-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface DesktopManifest {
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
  hemiDesktop?: Record<string, unknown>
  [field: string]: unknown
}

function manifestPath(profileDir: string): string {
  return join(profileDir, 'package.json')
}
function readManifest(profileDir: string): DesktopManifest {
  return JSON.parse(readFileSync(manifestPath(profileDir), 'utf8')) as DesktopManifest
}
function readManifestText(profileDir: string): string {
  return readFileSync(manifestPath(profileDir), 'utf8')
}
function writeManifest(profileDir: string, manifest: Record<string, unknown>, mode?: number): void {
  writeFileSync(manifestPath(profileDir), `${JSON.stringify(manifest, undefined, 2)}\n`, mode === undefined ? {} : { mode })
}

/** Profile content mirroring the native initializer, plus one unknown user field. */
function profileFixture(overrides: DesktopManifest = {}): DesktopManifest {
  return {
    name: 'dsh-profile-desktop',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    userNote: 'retain',
    ...overrides,
  }
}

function writeBundlePackage(modules: string, name: string, options: { declared?: boolean; patchFile?: boolean } = {}): void {
  const directory = join(modules, name)
  mkdirSync(directory, { recursive: true })
  const manifest: Record<string, unknown> = { name, version: '1.0.0' }
  if (options.declared !== false) manifest.dsh = { bundle: { patch: './bundle.yml' } }
  writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest))
  if (options.patchFile !== false) writeFileSync(join(directory, 'bundle.yml'), '[]\n')
}

/**
 * Runtime whose dsh CLI manifest declares the requested preinstalled names with their
 * packages installed beside it.
 */
function runtimeFixture(root: string, declared: readonly string[] = [...hemiDesktopPreinstalledBundles]): string {
  for (const name of hemiDesktopPreinstalledBundles) writeBundlePackage(join(root, 'node_modules'), name)
  const anchor = join(root, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(anchor, { recursive: true })
  writeFileSync(join(anchor, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0', dependencies: Object.fromEntries(declared.map(name => [name, '1.0.0'])) }))
  return join(anchor, 'package.json')
}

/** One preinstalled package absent from the runtime's node_modules. */
function withoutBundlePackage(runtime: string, name: string): void {
  rmSync(join(runtime, 'node_modules', name), { recursive: true, force: true })
}

/** Replace one installed package's files, so a rewritten fixture cannot retain the original's files. */
function rewriteBundlePackage(runtime: string, name: string, options: { declared?: boolean; patchFile?: boolean }): void {
  withoutBundlePackage(runtime, name)
  writeBundlePackage(join(runtime, 'node_modules'), name, options)
}

/**
 * Assert one seeding call in a child process without NODE_PATH. Vitest computes the global
 * module search paths from its injected NODE_PATH at process start, so an in-process
 * deletion cannot stop the resolution walk from reaching the repository's pnpm store, which
 * holds the real preinstalled packages a fixture may remove.
 * @param profileDir Profile package directory the child seeds.
 * @param installAnchor Absolute package.json path of the child's fixture installation.
 * @param failure Message pattern the rejected seeding must match.
 */
function expectSeedFailureWithoutNodePath(profileDir: string, installAnchor: string, failure: RegExp): void {
  const script = `
    import { seedHemiDesktopBundles } from ${JSON.stringify(new URL('../release/desktop-plugins.mjs', import.meta.url).href)};
    try {
      await seedHemiDesktopBundles({ profileDir: ${JSON.stringify(profileDir)}, installAnchor: ${JSON.stringify(installAnchor)} });
      console.log('resolved');
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
    }
  `
  const run = spawnSync(process.execPath, ['--input-type=module', '--eval', script],
    { cwd: tmpdir(), encoding: 'utf8', env: { PATH: process.env.PATH ?? '' }, timeout: 60_000 })
  expect(run.error, 'child exited early').toBeUndefined()
  expect(run.status).toBe(0)
  const [line] = run.stdout.trim().split('\n')
  expect(line).not.toBe('resolved')
  expect(line).toMatch(failure)
}

describe('seedHemiDesktopBundles', () => {
  it('selects the preinstalled packages once, records the marker in the same write, and keeps them across restarts', async () => {
    const root = temporaryRoot()
    const profileDir = join(root, 'profile')
    mkdirSync(profileDir)
    writeManifest(profileDir, profileFixture())
    const anchor = runtimeFixture(join(root, 'runtime'))

    await seedHemiDesktopBundles({ profileDir, installAnchor: anchor })
    const manifest = readManifest(profileDir)
    expect(manifest.dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-pocket', 'dsh-mnemon', 'dsh-native-browser'])
    expect(manifest.hemiDesktop?.preinstalledBundles).toEqual(['dsh-pocket', 'dsh-mnemon', 'dsh-native-browser'])
    expect(manifest.userNote).toBe('retain')

    const before = readManifestText(profileDir)
    await seedHemiDesktopBundles({ profileDir, installAnchor: anchor })
    expect(readManifestText(profileDir)).toBe(before)
  })

  it('preserves the manifest file mode', async () => {
    const root = temporaryRoot()
    const profileDir = join(root, 'profile')
    mkdirSync(profileDir)
    writeManifest(profileDir, profileFixture(), 0o600)
    const modeBefore = lstatSync(manifestPath(profileDir)).mode & 0o777
    await seedHemiDesktopBundles({ profileDir, installAnchor: runtimeFixture(join(root, 'runtime')) })
    expect(lstatSync(manifestPath(profileDir)).mode & 0o777).toBe(modeBefore)
  })

  it('keeps an existing selection at its owner position without duplicating it', async () => {
    const root = temporaryRoot()
    const profileDir = join(root, 'profile')
    mkdirSync(profileDir)
    writeManifest(profileDir, profileFixture({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-pocket', '@deepseek-ai/dsh-web-app'] } } }))
    await seedHemiDesktopBundles({ profileDir, installAnchor: runtimeFixture(join(root, 'runtime')) })
    expect(readManifest(profileDir).dsh?.profile?.bundles)
      .toEqual(['@deepseek-ai/dsh-base', 'dsh-pocket', '@deepseek-ai/dsh-web-app', 'dsh-mnemon', 'dsh-native-browser'])
    expect(readManifest(profileDir).hemiDesktop?.preinstalledBundles).toEqual(['dsh-pocket', 'dsh-mnemon', 'dsh-native-browser'])
  })

  it('records an installed but unselected dependency as the user disable decision it is', async () => {
    const root = temporaryRoot()
    const profileDir = join(root, 'profile')
    mkdirSync(profileDir)
    writeManifest(profileDir, profileFixture({ dependencies: { 'dsh-pocket': '2.13.0' } }))
    await seedHemiDesktopBundles({ profileDir, installAnchor: runtimeFixture(join(root, 'runtime')) })
    const manifest = readManifest(profileDir)
    expect(manifest.dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-mnemon', 'dsh-native-browser'])
    expect(manifest.dependencies).toEqual({ 'dsh-pocket': '2.13.0' })
    expect(manifest.hemiDesktop?.preinstalledBundles).toEqual(['dsh-pocket', 'dsh-mnemon', 'dsh-native-browser'])

    const before = readManifestText(profileDir)
    await seedHemiDesktopBundles({ profileDir, installAnchor: join(root, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json') })
    expect(readManifestText(profileDir)).toBe(before)
  })

  it('leaves the profile untouched when the installation declares none of the packages', async () => {
    const root = temporaryRoot()
    const profileDir = join(root, 'profile')
    mkdirSync(profileDir)
    writeManifest(profileDir, profileFixture())
    const before = readManifestText(profileDir)
    await seedHemiDesktopBundles({ profileDir, installAnchor: runtimeFixture(join(root, 'runtime'), []) })
    expect(readManifestText(profileDir)).toBe(before)
    expect(readManifest(profileDir).hemiDesktop).toBeUndefined()
  })

  it('rejects a partially preinstalling installation without touching the profile', async () => {
    const root = temporaryRoot()
    const profileDir = join(root, 'profile')
    mkdirSync(profileDir)
    writeManifest(profileDir, profileFixture())
    const before = readManifestText(profileDir)
    await expect(seedHemiDesktopBundles({ profileDir, installAnchor: runtimeFixture(join(root, 'runtime'), ['dsh-pocket']) }))
      .rejects.toThrow(/preinstalls only/)
    expect(readManifestText(profileDir)).toBe(before)
  })

  it.each([
    { name: 'a package without a bundle declaration', prepare: (runtime: string) => { rewriteBundlePackage(runtime, 'dsh-mnemon', { declared: false }) }, failure: /declares no dsh\.bundle/ },
    { name: 'a package missing its declared patch file', prepare: (runtime: string) => { rewriteBundlePackage(runtime, 'dsh-mnemon', { patchFile: false }) }, failure: /missing its declared patch file/ },
  ])('fails loudly on $name instead of seeding a bundle the profile would skip', async ({ prepare, failure }) => {
    const root = temporaryRoot()
    const profileDir = join(root, 'profile')
    mkdirSync(profileDir)
    writeManifest(profileDir, profileFixture())
    const anchor = runtimeFixture(join(root, 'runtime'))
    prepare(join(root, 'runtime'))
    const before = readManifestText(profileDir)
    await expect(seedHemiDesktopBundles({ profileDir, installAnchor: anchor })).rejects.toThrow(failure)
    expect(readManifestText(profileDir)).toBe(before)
  })

  it('fails a declared package missing from the installation, verified in a clean child process', () => {
    const root = temporaryRoot()
    const profileDir = join(root, 'profile')
    mkdirSync(profileDir)
    writeManifest(profileDir, profileFixture())
    const anchor = runtimeFixture(join(root, 'runtime'))
    withoutBundlePackage(join(root, 'runtime'), 'dsh-mnemon')
    expectSeedFailureWithoutNodePath(profileDir, anchor, /missing from the installation/)
    expect(readManifestText(profileDir)).toBe(`${JSON.stringify(profileFixture(), undefined, 2)}\n`)
  })

  it.each([
    { field: 'dsh.profile.bundles', manifest: { ...profileFixture(), dsh: { profile: { bundles: 'x' } } }, failure: /dsh\.profile\.bundles/ },
    { field: 'hemiDesktop', manifest: { ...profileFixture(), hemiDesktop: 5 }, failure: /'hemiDesktop'/ },
    { field: 'hemiDesktop.preinstalledBundles', manifest: { ...profileFixture(), hemiDesktop: { preinstalledBundles: 5 } }, failure: /preinstalledBundles/ },
  ])('rejects a malformed $field without rewriting the manifest', async ({ manifest: malformed, failure }) => {
    const root = temporaryRoot()
    const profileDir = join(root, 'profile')
    mkdirSync(profileDir)
    writeManifest(profileDir, malformed)
    const before = readManifestText(profileDir)
    await expect(seedHemiDesktopBundles({ profileDir, installAnchor: runtimeFixture(join(root, 'runtime')) })).rejects.toThrow(failure)
    expect(readManifestText(profileDir)).toBe(before)
  })

  it('reports a malformed profile manifest without replacing it', async () => {
    const root = temporaryRoot()
    const profileDir = join(root, 'profile')
    mkdirSync(profileDir)
    writeFileSync(manifestPath(profileDir), '{broken')
    await expect(seedHemiDesktopBundles({ profileDir, installAnchor: runtimeFixture(join(root, 'runtime')) })).rejects.toThrow()
    expect(readManifestText(profileDir)).toBe('{broken')
  })

  it('preserves unknown fields beside the Hemi marker', async () => {
    const root = temporaryRoot()
    const profileDir = join(root, 'profile')
    mkdirSync(profileDir)
    writeManifest(profileDir, profileFixture({ hemiDesktop: { note: 'keep-me' } }))
    await seedHemiDesktopBundles({ profileDir, installAnchor: runtimeFixture(join(root, 'runtime')) })
    expect(readManifest(profileDir).hemiDesktop).toEqual({ note: 'keep-me', preinstalledBundles: ['dsh-pocket', 'dsh-mnemon', 'dsh-native-browser'] })
  })
})

describe('markHemiDesktopBundlesSeeded', () => {
  it('creates nothing when the profile has no manifest', async () => {
    const profileDir = join(temporaryRoot(), 'absent')
    await expect(markHemiDesktopBundlesSeeded({ profileDir })).resolves.toBeUndefined()
    expect(existsSync(profileDir)).toBe(false)
  })

  it('marks a legacy profile without changing its bundle list, so later seeding stays a no-op', async () => {
    const root = temporaryRoot()
    const profileDir = join(root, 'profile')
    mkdirSync(profileDir)
    writeManifest(profileDir, profileFixture({ dependencies: { plugin: '1.0.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'plugin'] } } }))
    const before = readManifestText(profileDir)
    await markHemiDesktopBundlesSeeded({ profileDir })
    const manifest = readManifest(profileDir)
    expect(manifest.hemiDesktop?.preinstalledBundles).toEqual(['dsh-pocket', 'dsh-mnemon', 'dsh-native-browser'])
    expect(manifest.dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'plugin'])

    await seedHemiDesktopBundles({ profileDir, installAnchor: runtimeFixture(join(root, 'runtime')) })
    expect(readManifestText(profileDir)).not.toBe(before)
    expect(readManifest(profileDir).dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'plugin'])
  })

  it('leaves an already marked profile byte-identical', async () => {
    const root = temporaryRoot()
    const profileDir = join(root, 'profile')
    mkdirSync(profileDir)
    writeManifest(profileDir, profileFixture({ hemiDesktop: { preinstalledBundles: ['dsh-pocket', 'dsh-mnemon', 'dsh-native-browser'] } }))
    const before = readManifestText(profileDir)
    await markHemiDesktopBundlesSeeded({ profileDir })
    expect(readManifestText(profileDir)).toBe(before)
  })
})

interface SourceDistributionFixture {
  archiveText?: string
  recordedBytes?: number
  recordedSha256?: string
  omitDigest?: boolean
  licenseFile?: boolean
  name?: string
  version?: string
  file?: string
}

/** One pinned third-party source distribution under a caller-owned sources root. */
function sourceDistributionFixture(root: string, fixture: SourceDistributionFixture = {}): string {
  const sourceDir = join(root, 'dsh-pocket')
  mkdirSync(sourceDir, { recursive: true })
  const archive = Buffer.from(fixture.archiveText ?? 'pocket-source-archive', 'utf8')
  writeFileSync(join(sourceDir, 'source.tar.gz'), archive)
  const source: Record<string, unknown> = { file: fixture.file ?? 'source.tar.gz', bytes: fixture.recordedBytes ?? archive.byteLength }
  if (fixture.omitDigest !== true) source.sha256 = fixture.recordedSha256 ?? createHash('sha256').update(archive).digest('hex')
  writeFileSync(join(sourceDir, 'upstream.json'), JSON.stringify({
    name: fixture.name ?? 'dsh-pocket',
    version: fixture.version ?? '1.0.0',
    license: 'GPL-2.0',
    source,
  }))
  if (fixture.licenseFile !== false) writeFileSync(join(sourceDir, 'LICENSE'), 'GPL-2.0\n')
  return sourceDir
}

function runtimePackageFixture(runtimeDir: string, version = '1.0.0'): void {
  const directory = join(runtimeDir, 'node_modules', 'dsh-pocket')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'dsh-pocket', version }))
}

describe('stageHemiDesktopPluginSources', () => {
  it('includes corresponding source in the shared CLI publication and pins every preinstalled package', () => {
    const cli = JSON.parse(readFileSync(new URL('../../../../apps/cli/package.json', import.meta.url), 'utf8')) as {
      files: string[]
      dependencies: Record<string, string>
    }
    const upstream = JSON.parse(readFileSync(join(canonicalDistribution, 'upstream.json'), 'utf8')) as { version: string }
    expect(cli.files).toContain('third-party')
    expect(cli.dependencies['dsh-pocket']).toBe(upstream.version)
    for (const name of hemiDesktopPreinstalledBundles) expect(cli.dependencies[name]).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('stages the CLI-carried dsh-pocket distribution through the default sources root with a verified archive', () => {
    const root = temporaryRoot()
    runtimePackageFixture(root, '2.13.0')
    const carried = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'third-party', 'dsh-pocket')
    mkdirSync(dirname(carried), { recursive: true })
    cpSync(canonicalDistribution, carried, { recursive: true })

    expect(() => { stageHemiDesktopPluginSources(root) }).not.toThrow()

    const destination = join(root, 'third-party', 'dsh-pocket')
    for (const file of ['LICENSE', 'README.md', 'README.zh.md', 'source.tar.gz', 'upstream.json']) {
      expect(existsSync(join(destination, file)), file).toBe(true)
    }
    const upstream = JSON.parse(readFileSync(join(destination, 'upstream.json'), 'utf8')) as {
      version: string
      source: { bytes: number; sha256: string }
    }
    const archive = readFileSync(join(destination, 'source.tar.gz'))
    expect(upstream.version).toBe('2.13.0')
    expect(archive.byteLength).toBe(upstream.source.bytes)
    expect(createHash('sha256').update(archive).digest('hex')).toBe(upstream.source.sha256)
  })

  it('restages idempotently over an existing distribution copy', () => {
    const root = temporaryRoot()
    runtimePackageFixture(root, '2.13.0')
    stageHemiDesktopPluginSources(root, canonicalSources)
    stageHemiDesktopPluginSources(root, canonicalSources)
    expect(existsSync(join(root, 'third-party', 'dsh-pocket', 'source.tar.gz'))).toBe(true)
    expect(existsSync(join(root, 'third-party', 'dsh-pocket', 'LICENSE'))).toBe(true)
  })

  it.each([
    { name: 'an installed version differing from the pinned version', runtimeVersion: '9.9.9', failure: /not the pinned/ },
    { name: 'an archive byte length differing from the record', recordedBytes: 3, failure: /not the recorded/ },
    { name: 'an archive digest differing from the record', recordedSha256: 'f'.repeat(64), failure: /hashes to/ },
    { name: 'a missing LICENSE file', licenseFile: false, failure: /carries no LICENSE/ },
    { name: 'a record without a usable digest', omitDigest: true, failure: /verified source fields/ },
    { name: 'an archive reference leaving the distribution', file: '../escape.tar.gz', failure: /single file name/ },
    { name: 'an archive reference into a nested path', file: 'nested/escape.tar.gz', failure: /single file name/ },
  ])('fails loudly on $name before copying', ({ runtimeVersion, recordedBytes, recordedSha256, omitDigest, licenseFile, file, failure }) => {
    const root = temporaryRoot()
    const sources = join(root, 'sources')
    mkdirSync(sources)
    sourceDistributionFixture(sources, {
      ...(recordedBytes === undefined ? {} : { recordedBytes }),
      ...(recordedSha256 === undefined ? {} : { recordedSha256 }),
      ...(omitDigest === undefined ? {} : { omitDigest }),
      ...(licenseFile === undefined ? {} : { licenseFile }),
      ...(file === undefined ? {} : { file }),
    })
    const runtime = join(root, 'runtime')
    runtimePackageFixture(runtime, runtimeVersion ?? '1.0.0')
    expect(() => { stageHemiDesktopPluginSources(runtime, sources) }).toThrow(failure)
    expect(existsSync(join(runtime, 'third-party'))).toBe(false)
  })

  it('rejects a source distribution whose record names another package', () => {
    const root = temporaryRoot()
    const sources = join(root, 'sources')
    mkdirSync(sources)
    sourceDistributionFixture(sources, { name: 'other' })
    const runtime = join(root, 'runtime')
    runtimePackageFixture(runtime)
    expect(() => { stageHemiDesktopPluginSources(runtime, sources) }).toThrow(/verified source fields/)
    expect(existsSync(join(runtime, 'third-party'))).toBe(false)
  })

  it('rejects an empty sources root', () => {
    const root = temporaryRoot()
    const sources = join(root, 'sources')
    mkdirSync(sources)
    expect(() => { stageHemiDesktopPluginSources(join(root, 'runtime'), sources) }).toThrow(/holds no source distributions/)
  })
})
