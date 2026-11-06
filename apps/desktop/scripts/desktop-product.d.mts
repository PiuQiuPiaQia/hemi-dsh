/** Resolve matching application, executable, artifact and external protocol names. */
export function resolveDesktopProduct(environment?: NodeJS.ProcessEnv): { productName: string; artifactPrefix: string; protocol: string }
