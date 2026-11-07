/** Native Desktop operations used by the independently owned Hemi release CLI. */
export interface HemiGitHubCommandServices {
  readonly productVersion: string
  readonly desktopVersion: string
  validateBuildVersion(version: string, productVersion: string): string
  loadEnvironment(platform: 'darwin' | 'win32'): NodeJS.ProcessEnv
  prepareComputerUse?(): Promise<void>
  artifactsDirectory(target: 'mac-arm64' | 'mac-x64' | 'win-x64'): string
}

/**
 * Run the selected command; omitted arguments/environment use the current process.
 * Without a target group in either source, selects all three Desktop targets.
 */
export function runHemiGitHubReleaseCommand(
  services: HemiGitHubCommandServices,
  argv?: string[],
  environment?: NodeJS.ProcessEnv,
): Promise<void>
