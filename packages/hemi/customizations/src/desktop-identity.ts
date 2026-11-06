/** Apply the packaged fork identity before Electron resolves preferences, locks or logs. */
import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveHemiDesktopIdentity } from '@deepseek-ai/dsh-hemi-customizations/desktop-branding'

/** Only the Electron path and name operations required before ready. */
interface DesktopIdentityApplication {
  isPackaged: boolean
  commandLine: { getSwitchValue(name: string): string }
  getAppPath(): string
  getPath(name: 'appData'): string
  setName(name: string): void
  setPath(name: 'userData' | 'sessionData', path: string): void
}

/**
 * Select independent defaults only for explicitly branded packages; existing data is never moved.
 * @param application Electron application before ready or any userData access.
 * @param environment Environment inherited by the Host; explicit DSH_HOME retains precedence.
 * @param userHome Operating-system home for the fork's default Harness directory.
 * @returns Selected fork identity, or undefined for original DSH and unbranded development builds.
 */
export function configureHemiDesktopIdentity(
  application: DesktopIdentityApplication, environment: NodeJS.ProcessEnv = process.env, userHome = homedir(),
): ReturnType<typeof resolveHemiDesktopIdentity> {
  if (!application.isPackaged) return undefined
  const metadata: unknown = JSON.parse(readFileSync(join(application.getAppPath(), 'package.json'), 'utf8'))
  const identity = resolveHemiDesktopIdentity(metadata)
  if (identity === undefined) return undefined
  application.setName(identity.productName)
  if (!application.commandLine.getSwitchValue('user-data-dir')) {
    const preferences = join(application.getPath('appData'), identity.productName)
    mkdirSync(preferences, { recursive: true, mode: 0o700 })
    application.setPath('userData', preferences)
    application.setPath('sessionData', preferences)
  }
  if (!environment.DSH_HOME?.trim()) environment.DSH_HOME = join(userHome, identity.homeDirectory)
  return identity
}
