/** Fixed-certificate Hemi builds, independent of Apple Developer ID and EV signing. */
import { X509Certificate } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveHemiGitHubDistribution } from './config.mjs'

/** Public certificate only; its private key remains outside the checkout and application. */
export const hemiMacCertificate = fileURLToPath(new URL('./macos-signing.cer', import.meta.url))

/**
 * Resolve explicitly selected non-commercial-certificate signing for this GitHub fork.
 * @param {NodeJS.ProcessEnv} environment File-owned packaging configuration.
 * @param {'darwin' | 'win32'} platform Packaging platform.
 * @returns {import('./signing.mjs').HemiCommunitySigning | undefined} Fixed Mac certificate or unsigned Windows mode; absent preserves DSH signing.
 */
export function resolveHemiCommunitySigning(environment, platform) {
  const mode = environment.HEMI_DESKTOP_SIGNING_MODE
  if (mode === undefined) return undefined
  if (mode !== 'community' || resolveHemiGitHubDistribution(environment) === undefined) {
    throw new Error('Hemi Desktop: community signing requires explicit GitHub distribution settings')
  }
  if (environment.DSH_DESKTOP_UNSIGNED === '1') throw new Error('Hemi Desktop: community signing cannot use the local unsigned debug mode')
  if (platform === 'win32') return { kind: 'windows-unsigned' }
  if (platform !== 'darwin') throw new Error('Hemi Desktop: unsupported community signing platform')
  const certificate = new X509Certificate(readFileSync(hemiMacCertificate))
  return { kind: 'mac-self-signed', certificate: hemiMacCertificate,
    identity: certificate.fingerprint.replaceAll(':', ''), sha256: certificate.fingerprint256.replaceAll(':', '').toLowerCase() }
}

/**
 * Create the certificate-bound designated requirement retained across Mac builds.
 * @param {string} applicationId Validated reverse-DNS bundle identifier.
 * @param {string} identity Public SHA-1 certificate fingerprint.
 * @returns {string} Code requirement without an Apple trust-anchor dependency.
 */
export function hemiMacRequirement(applicationId, identity) {
  if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u.test(applicationId) || !/^[A-Fa-f0-9]{40}$/u.test(identity)) {
    throw new Error('Hemi Desktop: invalid fixed-certificate signing identity')
  }
  return `identifier "${applicationId}" and certificate leaf = H"${identity.toLowerCase()}"`
}

/**
 * Run a signing command without exposing argument-bearing child-process errors.
 * @param {string} command Absolute executable path.
 * @param {string[]} args Tool arguments, which may include credential paths.
 * @returns {string} Tool output for public signature inspection.
 */
function run(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe', timeout: 120_000 })
  } catch (error) {
    throw new Error(`Hemi Desktop: ${basename(command)} ${args[0]} failed; check the fixed signing certificate and package`)
  }
}

/**
 * Verify every architecture and nested component against the pinned application identity.
 * @param {string} application Assembled application path.
 * @param {import('./signing.mjs').HemiMacSigning} signing Fixed certificate identity.
 * @param {string} applicationId Bundle identifier used by the installed application.
 * @param {(command: string, args: string[]) => string} execute Signature tool runner; omitted uses codesign.
 * @returns {void} Throws when signed content or its designated requirement differs.
 */
export function verifyHemiMacApplication(application, signing, applicationId, execute = run) {
  const requirement = hemiMacRequirement(applicationId, signing.identity)
  execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--all-architectures', '-R', `=${requirement}`, application])
  const display = execute('/usr/bin/codesign', ['--display', '-r-', application])
  const actual = /^designated => (.+)$/mu.exec(display)?.[1]
  if (actual !== requirement) throw new Error('Hemi Desktop: application must retain the fixed certificate designated requirement')
}

const MACH_O = new Set([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca])

function isCode(path) {
  if (basename(path).startsWith('._')) return false
  if (statSync(path).isDirectory()) return /\.(app|framework)$/u.test(path)
  const file = openSync(path, 'r')
  try {
    const magic = Buffer.alloc(4)
    return readSync(file, magic, 0, 4, 0) === 4 && MACH_O.has(magic.readUInt32BE())
  } finally { closeSync(file) }
}

/**
 * Use electron-builder's maintained signer with the fixed Hemi certificate and no timestamp server.
 * Existing entitlements and exclusions remain owned by the Desktop builder.
 * @param {import('@electron/osx-sign').SignOptions} options Builder-provided signing options.
 * @param {import('./signing.mjs').HemiMacSigning} signing Pinned certificate.
 * @param {string} applicationId Installed application identifier.
 * @returns {Promise<void>} Verified signing completion, without notarization or trust-domain changes.
 */
export async function signHemiMacApplication(options, signing, applicationId) {
  const { signAsync } = await import('@electron/osx-sign')
  const original = options.ignore === undefined ? [] : Array.isArray(options.ignore) ? options.ignore : [options.ignore]
  await signAsync({ ...options, identity: signing.identity, identityValidation: false, preAutoEntitlements: false,
    ignore: path => !isCode(path) || original.some(rule => typeof rule === 'function' ? rule(path) : path.match(rule)),
    optionsForFile: path => ({ ...options.optionsForFile?.(path), timestamp: 'none',
      ...(resolve(path) === resolve(options.app) ? { requirements: `=designated => ${hemiMacRequirement(applicationId, signing.identity)}` } : {}) }) })
  verifyHemiMacApplication(options.app, signing, applicationId)
}

/**
 * Sign and verify a DMG using the same fixed certificate as its application.
 * @param {string} image Completed DMG path.
 * @param {import('./signing.mjs').HemiMacSigning} signing Fixed certificate.
 * @param {string | undefined} keychain Scoped signing keychain; absent lets codesign locate the fixed identity.
 * @param {(command: string, args: string[]) => string} execute Signing runner; omitted uses codesign.
 * @returns {void} Throws before publication on a signing or verification failure.
 */
export function signHemiMacDiskImage(image, signing, keychain, execute = run) {
  execute('/usr/bin/codesign', ['--force', '--sign', signing.identity, '--timestamp=none',
    ...(keychain === undefined ? [] : ['--keychain', keychain]), image])
  execute('/usr/bin/codesign', ['--verify', '--strict', '-R', `=certificate leaf = H"${signing.identity.toLowerCase()}"`, image])
}

/**
 * Supply fixed-certificate checks to the Desktop runtime's shared traversal and entitlement selection.
 * @param {import('./signing.mjs').HemiMacSigning} signing Pinned public identity.
 * @param {string | undefined} keychain Unlocked packaging-owned keychain.
 * @returns {import('./signing.mjs').HemiMacRuntimeSigner} Helper verifier and standalone native signer.
 */
export function createHemiMacRuntimeSigner(signing, keychain) {
  if (!keychain || !isAbsolute(keychain)) throw new Error('Hemi Desktop: native signing requires the scoped signing keychain')
  return {
    verifyApplication(application) {
      const plist = readFileSync(join(application, 'Contents/Info.plist'), 'utf8')
      const identifier = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/u.exec(plist)?.[1]
      if (!identifier) throw new Error('Hemi Desktop: native helper has no bundle identifier')
      verifyHemiMacApplication(application, signing, identifier)
    },
    async signFile(file, identifier, entitlements) {
      const requirement = hemiMacRequirement(identifier, signing.identity)
      const { execa } = await import('execa')
      const { default: plist } = await import('plist')
      const inherited = entitlements === undefined ? {} : plist.parse(readFileSync(entitlements, 'utf8'))
      if (inherited === null || typeof inherited !== 'object'
        || ![Object.prototype, null].includes(Object.getPrototypeOf(inherited))) {
        throw new Error('Hemi Desktop: native entitlements must be a plist dictionary')
      }
      // A fixed self-signed identity has no Apple Team ID for native library validation.
      const contents = plist.build({ ...inherited, 'com.apple.security.cs.disable-library-validation': true })
      const directory = mkdtempSync(join(tmpdir(), 'hemi-native-entitlements-'))
      try {
        const plistFile = join(directory, 'entitlements.plist')
        writeFileSync(plistFile, contents, { mode: 0o600, flag: 'wx' })
        try {
          await execa('/usr/bin/codesign', ['--force', '--sign', signing.identity, '--keychain', keychain,
            '--identifier', identifier, '--timestamp=none', '--options', 'runtime', '--requirements', `=designated => ${requirement}`,
            '--entitlements', plistFile, file], { timeout: 120_000, stdio: 'pipe' })
        } catch (error) {
          throw new Error(`Hemi Desktop: fixed-certificate native signing failed for ${basename(file)}`)
        }
        run('/usr/bin/codesign', ['--verify', '--strict', '--all-architectures', '-R', `=${requirement}`, file])
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
  }
}
