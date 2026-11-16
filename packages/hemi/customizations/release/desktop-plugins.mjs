/**
 * Hemi Desktop adapter for the preinstalled plugin bundles (`dsh-pocket`, `dsh-mnemon`).
 *
 * The bundled dsh CLI installation declares both packages as direct dependencies, so the
 * native profile layer resolves them from the installation. This adapter selects them into
 * `dsh.profile.bundles` exactly once per profile: the same atomic manifest write records the
 * Hemi-owned `hemiDesktop.preinstalledBundles` marker, so a restart, a user disable, or a
 * removal never re-adds them. Recovery marking keeps that promise when the recovery runs
 * before the first launch preparation. The staging helper copies each pinned third-party
 * source distribution that the bundled dsh CLI carries beside its manifest below the prepared
 * runtime root; it never extracts, executes, or fetches anything.
 * @module
 */

import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { assertBundlePlatform, bundlePatchFiles, readProfileManifest } from '@deepseek-ai/dsh-app-boot'

/** Package names this Hemi release preinstalls as profile bundles, in seeding order. */
export const hemiDesktopPreinstalledBundles = Object.freeze(['dsh-pocket', 'dsh-mnemon'])

/** Whether `value` is a JSON object record rather than an array or null. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Serialize a manifest the way the native profile writer does: 2-space JSON with a trailing newline. */
function manifestText(manifest) {
  return `${JSON.stringify(manifest, undefined, 2)}\n`
}

/**
 * Read the desktop profile manifest and validate every field this adapter reads or rewrites,
 * so a malformed manifest fails before any replacement write instead of being silently
 * rebuilt with its unknown fields lost.
 * @param {string} profileDir Desktop profile package directory.
 * @returns {Record<string, unknown>} The parsed manifest with unknown fields preserved.
 */
function readValidatedDesktopManifest(profileDir) {
  const manifest = readProfileManifest('dsh', profileDir)
  if (manifest.dependencies !== undefined && !isRecord(manifest.dependencies)) {
    throw new Error(`Hemi Desktop: profile manifest field 'dependencies' in ${profileDir} must hold a JSON object`)
  }
  if (manifest.dsh !== undefined && !isRecord(manifest.dsh)) {
    throw new Error(`Hemi Desktop: profile manifest field 'dsh' in ${profileDir} must hold a JSON object`)
  }
  const profile = manifest.dsh?.profile
  if (profile !== undefined && !isRecord(profile)) {
    throw new Error(`Hemi Desktop: profile manifest field 'dsh.profile' in ${profileDir} must hold a JSON object`)
  }
  const bundles = profile?.bundles
  if (bundles !== undefined && (!Array.isArray(bundles) || !bundles.every(name => typeof name === 'string'))) {
    throw new Error(`Hemi Desktop: profile manifest field 'dsh.profile.bundles' in ${profileDir} must hold a list of bundle names`)
  }
  if (manifest.hemiDesktop !== undefined && !isRecord(manifest.hemiDesktop)) {
    throw new Error(`Hemi Desktop: profile manifest field 'hemiDesktop' in ${profileDir} must hold a JSON object`)
  }
  const handled = manifest.hemiDesktop?.preinstalledBundles
  if (handled !== undefined && (!Array.isArray(handled) || !handled.every(name => typeof name === 'string'))) {
    throw new Error(`Hemi Desktop: profile manifest field 'hemiDesktop.preinstalledBundles' in ${profileDir} must hold a list of bundle names`)
  }
  return manifest
}

/**
 * Decide whether the installation declares the preinstalled bundles.
 * @param {string} installAnchor Absolute package.json path of the bundled dsh CLI installation.
 * @returns {string[] | undefined} The declared names, or undefined when the installation
 * declares none of them (an upstream or older runtime; seeding stays a no-op).
 */
function declaredPreinstalledBundles(installAnchor) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(installAnchor, 'utf8'))
  } catch (error) {
    throw new Error(`Hemi Desktop: failed to read the dsh installation manifest ${installAnchor}: ${String(error)}`)
  }
  if (!isRecord(parsed)) throw new Error(`Hemi Desktop: the dsh installation manifest ${installAnchor} must hold a JSON object`)
  if (parsed.dependencies !== undefined && !isRecord(parsed.dependencies)) {
    throw new Error(`Hemi Desktop: the dsh installation manifest ${installAnchor} declares a malformed dependencies field`)
  }
  const declared = hemiDesktopPreinstalledBundles.filter(name => Object.hasOwn(parsed.dependencies ?? {}, name))
  if (declared.length === 0) return undefined
  if (declared.length !== hemiDesktopPreinstalledBundles.length) {
    throw new Error(`Hemi Desktop: the dsh installation manifest ${installAnchor} preinstalls only ${JSON.stringify(declared)} of ${JSON.stringify([...hemiDesktopPreinstalledBundles])}`)
  }
  return declared
}

/**
 * Resolve a preinstalled bundle's package directory from the installation alone. The profile
 * fallback of the native resolver stays unused on purpose: a missing runtime package is a
 * packaging defect that a profile-local copy must not mask.
 * @param {string} installAnchor Absolute package.json path of the bundled dsh CLI installation.
 * @param {string} name Preinstalled bundle package name.
 * @returns {string} Absolute package directory.
 */
function installationBundleDir(installAnchor, name) {
  // resolve.paths returns null only for builtins, which no package name is.
  for (const searchPath of createRequire(installAnchor).resolve.paths(name) ?? []) {
    const candidate = join(searchPath, name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  throw new Error(`Hemi Desktop: the dsh installation declares the preinstalled bundle ${JSON.stringify(name)} but its package files are missing from the installation`)
}

/**
 * Verify that a preinstalled package is a loadable bundle of this installation: its manifest
 * declares `dsh.bundle`, every declared patch file ships, and the declaration admits the Host
 * platform. Seeding a package that the profile layer would silently skip would fake success.
 * @param {string} installAnchor Absolute package.json path of the bundled dsh CLI installation.
 * @param {string} name Preinstalled bundle package name.
 */
function validateBundlePackage(installAnchor, name) {
  const packageDir = installationBundleDir(installAnchor, name)
  const manifest = readProfileManifest('dsh', packageDir)
  const bundle = manifest.dsh?.bundle
  if (!isRecord(bundle)) {
    throw new Error(`Hemi Desktop: the preinstalled bundle ${JSON.stringify(name)} at ${packageDir} declares no dsh.bundle in its manifest`)
  }
  let patchFiles
  try {
    patchFiles = bundlePatchFiles(bundle)
    assertBundlePlatform(bundle.platforms, process.platform)
  } catch (error) {
    throw new Error(`Hemi Desktop: the preinstalled bundle ${JSON.stringify(name)} at ${packageDir}: ${error instanceof Error ? error.message : String(error)}`)
  }
  for (const file of patchFiles) {
    if (!existsSync(join(packageDir, file))) {
      throw new Error(`Hemi Desktop: the preinstalled bundle ${JSON.stringify(name)} at ${packageDir} is missing its declared patch file ${JSON.stringify(file)}`)
    }
  }
}

/**
 * Select the preinstalled bundles into a profile's `dsh.profile.bundles` once. The same
 * atomic manifest write records `hemiDesktop.preinstalledBundles`, so later launches,
 * disables, or removals never re-add them. An installation declaring none of the packages
 * leaves the profile untouched; a partial declaration or a package that cannot serve as a
 * bundle fails without writing. The caller owns profile write exclusion.
 * @param {{ profileDir: string, installAnchor: string }} location Profile package directory
 * and absolute package.json path of the bundled dsh CLI installation.
 * @returns {Promise<void>} Resolves after the single atomic write, or immediately without
 * touching the profile when seeding is already recorded or not applicable.
 */
export async function seedHemiDesktopBundles(location) {
  const { profileDir, installAnchor } = location
  if (declaredPreinstalledBundles(installAnchor) === undefined) return
  const manifest = readValidatedDesktopManifest(profileDir)
  const manifestPath = join(profileDir, 'package.json')
  const bundles = [...(manifest.dsh?.profile?.bundles ?? [])]
  const previous = manifest.hemiDesktop?.preinstalledBundles ?? []
  const handled = [...previous]
  const added = []
  for (const name of hemiDesktopPreinstalledBundles) {
    if (handled.includes(name)) continue
    handled.push(name)
    // A profile dependency without a selection is the user's disable decision, and an
    // existing selection stays at the position its owner chose; both stay as they are.
    if (bundles.includes(name) || Object.hasOwn(manifest.dependencies ?? {}, name)) continue
    added.push(name)
  }
  if (added.length === 0 && handled.length === previous.length) return
  for (const name of added) validateBundlePackage(installAnchor, name)
  // The marker always lands in the same write; the selection changes only with a real addition,
  // so a metadata-only update never invents a bundle list a profile did not have.
  const selection = { ...manifest, hemiDesktop: { ...manifest.hemiDesktop, preinstalledBundles: handled } }
  if (added.length > 0) {
    selection.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...bundles, ...added] } }
  }
  await writeFileAtomic(manifestPath, manifestText(selection), { mode: lstatSync(manifestPath).mode & 0o777 })
}

/**
 * Record the preinstalled bundles as handled without changing the bundle selection. Recovery
 * calls this after sanitizing so a recovery before the first launch preparation cannot lead
 * to automatic re-seeding. A directory without a profile manifest stays without one.
 * @param {{ profileDir: string }} location Profile package directory.
 * @returns {Promise<void>} Resolves after the single atomic marker write, or immediately
 * when the profile is absent or already records both names.
 */
export async function markHemiDesktopBundlesSeeded(location) {
  const manifestPath = join(location.profileDir, 'package.json')
  if (!existsSync(manifestPath)) return
  const manifest = readValidatedDesktopManifest(location.profileDir)
  const previous = manifest.hemiDesktop?.preinstalledBundles ?? []
  const handled = [...previous]
  for (const name of hemiDesktopPreinstalledBundles) {
    if (!handled.includes(name)) handled.push(name)
  }
  if (handled.length === previous.length) return
  const marked = { ...manifest, hemiDesktop: { ...manifest.hemiDesktop, preinstalledBundles: handled } }
  await writeFileAtomic(manifestPath, manifestText(marked), { mode: lstatSync(manifestPath).mode & 0o777 })
}

/**
 * Read the pinned upstream record of one source distribution and validate the fields the
 * staging verification relies on.
 * @param {string} sourceDir Source distribution directory.
 * @param {string} name Distribution directory name, which the record's `name` must repeat.
 * @returns {{ name: string, version: string, license: string, source: { file: string, bytes: number, sha256: string } }} Validated record.
 */
function readUpstreamRecord(sourceDir, name) {
  const path = join(sourceDir, 'upstream.json')
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`Hemi Desktop: failed to read the pinned upstream record ${path}: ${String(error)}`)
  }
  const source = isRecord(parsed) ? parsed.source : undefined
  if (!isRecord(parsed) || parsed.name !== name || typeof parsed.version !== 'string' || parsed.version === ''
    || typeof parsed.license !== 'string' || parsed.license === ''
    || !isRecord(source) || typeof source.file !== 'string' || source.file === ''
    || !Number.isSafeInteger(source.bytes) || source.bytes <= 0
    || typeof source.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(source.sha256)) {
    throw new Error(`Hemi Desktop: the pinned upstream record ${path} lacks its name, version, license, or verified source fields`)
  }
  // A single file name keeps every source archive read inside the distribution directory.
  if (isAbsolute(source.file) || source.file.includes('/') || source.file.includes('\\') || source.file === '.' || source.file === '..') {
    throw new Error(`Hemi Desktop: the pinned upstream record ${path} must reference its archive by a single file name inside the distribution`)
  }
  return parsed
}

/**
 * Verify a pinned source archive against its recorded byte length and SHA-256 digest.
 * @param {string} sourceDir Source distribution directory.
 * @param {{ source: { file: string, bytes: number, sha256: string } }} upstream Validated upstream record.
 */
function verifySourceArchive(sourceDir, upstream) {
  const archivePath = join(sourceDir, upstream.source.file)
  let archive
  try {
    archive = readFileSync(archivePath)
  } catch (error) {
    throw new Error(`Hemi Desktop: failed to read the pinned source archive ${archivePath}: ${String(error)}`)
  }
  if (archive.byteLength !== upstream.source.bytes) {
    throw new Error(`Hemi Desktop: the pinned source archive ${archivePath} is ${archive.byteLength} bytes, not the recorded ${upstream.source.bytes}`)
  }
  const sha256 = createHash('sha256').update(archive).digest('hex')
  if (sha256 !== upstream.source.sha256) {
    throw new Error(`Hemi Desktop: the pinned source archive ${archivePath} hashes to ${sha256}, not the recorded ${upstream.source.sha256}`)
  }
}

/**
 * Verify one source distribution against the installed runtime package and copy it below the
 * runtime root; the copy overwrites an existing destination, so the caller prepares a cleared
 * runtime root. The copy stays byte-identical: no extraction, no execution, no network.
 * @param {string} sourcesRoot Directory holding one subdirectory per source distribution.
 * @param {string} name Distribution directory name.
 * @param {string} runtimeDir Prepared runtime root holding the installed packages.
 */
function stageSourceDistribution(sourcesRoot, name, runtimeDir) {
  const sourceDir = join(sourcesRoot, name)
  const upstream = readUpstreamRecord(sourceDir, name)
  const manifestPath = join(runtimeDir, 'node_modules', name, 'package.json')
  let installed
  try {
    installed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`Hemi Desktop: failed to read the installed ${JSON.stringify(name)} manifest ${manifestPath}: ${String(error)}`)
  }
  if (!isRecord(installed) || installed.version !== upstream.version) {
    throw new Error(`Hemi Desktop: the runtime installs ${JSON.stringify(name)} version ${JSON.stringify(installed?.version ?? null)}, not the pinned ${JSON.stringify(upstream.version)}`)
  }
  if (!existsSync(join(sourceDir, 'LICENSE'))) {
    throw new Error(`Hemi Desktop: the ${JSON.stringify(name)} source distribution at ${sourceDir} carries no LICENSE file`)
  }
  verifySourceArchive(sourceDir, upstream)
  const destination = join(runtimeDir, 'third-party', name)
  mkdirSync(destination, { recursive: true })
  cpSync(sourceDir, destination, { recursive: true })
}

/**
 * Stage every pinned third-party source distribution below a prepared runtime root, so the
 * runtime inventory seals the complete corresponding source next to each distributed
 * package. Build-time only: verifies each distribution's recorded archive digest and the
 * installed package version before copying, and never extracts, executes, or fetches.
 * @param {string} runtimeDir Prepared runtime root whose `node_modules` holds the installed packages.
 * @param {string} [sourcesRoot] Source distribution root; defaults to the `third-party/`
 * source directory the bundled dsh CLI carries beside its manifest.
 */
export function stageHemiDesktopPluginSources(runtimeDir, sourcesRoot = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'third-party')) {
  let entries
  try {
    entries = readdirSync(sourcesRoot, { withFileTypes: true })
  } catch (error) {
    throw new Error(`Hemi Desktop: failed to read the third-party source directory ${sourcesRoot}: ${String(error)}`)
  }
  const distributions = entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
  if (distributions.length === 0) {
    throw new Error(`Hemi Desktop: the third-party source directory ${sourcesRoot} holds no source distributions`)
  }
  for (const name of distributions) stageSourceDistribution(sourcesRoot, name, runtimeDir)
}
