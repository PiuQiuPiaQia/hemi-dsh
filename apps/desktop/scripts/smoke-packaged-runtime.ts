// Hemi fork: filenames follow the selected distribution identity.
import { resolveDesktopProduct } from './desktop-product.mjs'
/** Validate the assembled application, including native Office conversion outside ASAR. */
// Hemi fork: community Windows releases keep release artifact paths while shipping without Authenticode.
import { resolveHemiCommunitySigning } from '@deepseek-ai/dsh-hemi-customizations/github-community-signing'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { desktopArtifactOutput, resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { readDesktopRuntime, verifyDesktopRuntime } from '../src/runtime-tree.ts'
import { verifyWindowsCode } from './windows-runtime-signature.mjs'
import { smokePreparedRuntime } from './smoke-prepared-runtime.ts'
import { resolveDesktopPackageTarget } from './package-target.ts'

/** Parsed command-line mode of the packaged-application smoke. */
export interface SmokePackagedRuntimeMode {
  readonly unsigned: boolean
  readonly skipNotarization: boolean
}

/**
 * Validate one assembled application, its packaged payload and Host, plus the required Windows signature checks.
 * @param mode - Parsed command-line mode; `unsigned` selects the local debug artifact directory.
 * @param environment - Packaging environment selecting the target, product identity, and Hemi community signing policy.
 * @returns Resolves after every payload, Host and signature check passes; rejects on the first failure.
 */
export async function smokePackagedRuntime(mode: SmokePackagedRuntimeMode, environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const paths = resolveDesktopTargetBuildPaths(environment)
  const target = resolveDesktopBuildTarget(environment)
  const product = resolveDesktopProduct(environment)
  const windows = target === 'win-x64'
  const artifacts = desktopArtifactOutput(paths, mode).directory
  const application = windows ? join(artifacts, 'win-unpacked')
    : join(artifacts, target === 'mac-arm64' ? 'mac-arm64' : 'mac', `${product.productName}.app`, 'Contents')
  const resources = join(application, windows ? 'resources' : 'Resources')
  const executable = windows ? join(application, `${product.productName}.exe`) : join(application, 'MacOS', product.productName)
  const descriptor = await verifyDesktopRuntime(paths.dsh, readDesktopRuntime(paths.dsh).release.version,
    resolveDesktopPackageTarget(target))
  // Hemi fork: community Windows releases ship without commercial Authenticode, so the signature requirement
  // follows the environment-owned signing policy; only the local debug flag moves the artifact directory above.
  if (windows && !mode.unsigned
    && resolveHemiCommunitySigning(environment, 'win32')?.kind !== 'windows-unsigned') await verifyWindowsCode(application)
  await smokePreparedRuntime(join(resources, 'app.asar', 'dsh'), executable, join(resources, 'runtime'), descriptor)
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { unsigned: { type: 'boolean', default: false }, 'skip-notarization': { type: 'boolean', default: false } }, allowPositionals: false })
  await smokePackagedRuntime({ unsigned: values.unsigned, skipNotarization: values['skip-notarization'] })
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main()
