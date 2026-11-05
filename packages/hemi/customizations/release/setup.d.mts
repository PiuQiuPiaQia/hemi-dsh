/** Prepare an isolated hosted-runner configuration; never generate or rotate the pinned key. */
export function setupHemiCommunitySigning(environment: NodeJS.ProcessEnv, target: string): string

/** Delete only this target's marked temporary credential directory on a disposable hosted runner. */
export function cleanupHemiCommunitySigning(environment: NodeJS.ProcessEnv, target: string): void
