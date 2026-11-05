/** Stage both release helpers with the fixed Hemi certificate after receipt and signature verification. */
export function stageHemiComputerUse(
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
  readApplication: (directory: string) => { application: string; bundle: string },
): Promise<void>
