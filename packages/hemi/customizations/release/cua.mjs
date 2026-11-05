/** Stage fixed-certificate native helpers for Hemi desktop builds, without official npm publication metadata. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { hemiMacRequirement, resolveHemiCommunitySigning, verifyHemiMacApplication } from './signing.mjs'

/**
 * Build both existing release helper variants with the same fixed certificate as the desktop app.
 * Default DSH/npm publication continues to require its own notarized producer manifest.
 * @param {string} repositoryRoot Source repository root.
 * @param {NodeJS.ProcessEnv} environment Scoped, unlocked keychain environment.
 * @param {(directory: string) => { application: string, bundle: string }} readApplication Native receipt and digest verifier.
 * @returns {Promise<void>} Both architectures staged, or owned partial output removed after children stop.
 */
export async function stageHemiComputerUse(repositoryRoot, environment, readApplication) {
  const signing = resolveHemiCommunitySigning(environment, 'darwin')
  if (signing?.kind !== 'mac-self-signed' || !environment.CSC_KEYCHAIN) throw new Error('Hemi Desktop: helper staging requires the scoped fixed signing keychain')
  const provider = join(repositoryRoot, 'packages/experimental/cua-macos')
  const plist = readFileSync(join(provider, 'native/Info.plist'), 'utf8')
  const applicationId = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/u.exec(plist)?.[1]
  if (!applicationId) throw new Error('Hemi Desktop: helper has no bundle identifier')
  const requirement = hemiMacRequirement(applicationId, signing.identity)
  const output = join(provider, 'native/bin')
  if (existsSync(output)) throw new Error('Hemi Desktop: native helper staging requires an empty native/bin in a clean checkout')
  const scratch = mkdtempSync(join(tmpdir(), 'hemi-cua-build-'))
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  let owned = false
  let complete = false
  try {
    mkdirSync(output)
    owned = true
    for (const architecture of ['arm64', 'x64']) {
      controller.signal.throwIfAborted()
      const directory = join(output, `darwin-${architecture}`)
      await execa('/usr/bin/xcrun', ['python3', join(provider, 'native/build_app.py'),
        '--arch', architecture === 'x64' ? 'x86_64' : architecture, '--scratch-path', join(scratch, architecture),
        '--output-directory', directory, '--identity', signing.identity, '--keychain', environment.CSC_KEYCHAIN,
        '--timestamp', 'none', '--requirements', `=designated => ${requirement}`], { cwd: repositoryRoot, env: environment, extendEnv: false, stdio: 'inherit',
        cancelSignal: controller.signal, killDescendants: true, timeout: 900_000 })
      const { application } = readApplication(directory)
      verifyHemiMacApplication(application, signing, applicationId)
    }
    complete = true
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    rmSync(scratch, { recursive: true, force: true })
    if (owned && !complete) rmSync(output, { recursive: true, force: true })
  }
}
