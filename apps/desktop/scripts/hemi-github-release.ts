/** Hemi fork: expose native Desktop packaging operations to the independently owned GitHub release CLI. */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runHemiGitHubReleaseCommand } from '@deepseek-ai/dsh-hemi-customizations/github-release-command'
import { stageHemiComputerUse } from '@deepseek-ai/dsh-hemi-customizations/github-community-cua'
import { readCuaApplication } from '../../../scripts/cua-helper/payload.ts'
import { withMacOSSigningKeychain } from './macos-signing-keychain.mjs'
import { validateDesktopBuildVersion } from './desktop-build-version.mjs'
import { desktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { loadDesktopPackageEnvironment } from './desktop-package-environment.mjs'

const ROOT = resolve(import.meta.dirname, '../../..')

function version(path: string): string {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { version: string }
  return manifest.version
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  await runHemiGitHubReleaseCommand({
    productVersion: version(join(ROOT, 'package.json')),
    desktopVersion: version(join(ROOT, 'apps/desktop/package.json')),
    validateBuildVersion: validateDesktopBuildVersion,
    loadEnvironment: platform => loadDesktopPackageEnvironment(platform),
    artifactsDirectory: target => desktopTargetBuildPaths(target).artifacts,
    prepareComputerUse: () => withMacOSSigningKeychain(loadDesktopPackageEnvironment('darwin'),
      environment => stageHemiComputerUse(ROOT, environment, readCuaApplication)),
  })
}
