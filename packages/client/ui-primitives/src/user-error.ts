/** Safe operation-error summaries; business-specific recovery remains with the owning feature. */

/** Common-namespace keys for cross-feature operation failures. */
export type UserErrorKey = 'uiError.unknown' | 'uiError.cancelled' | 'uiError.invalidInput' | 'uiError.unavailable'

/** An explicitly localized UI refusal, retaining the underlying failure only as its cause. */
export class UserFacingError extends Error {
  /**
   * @param summary - localized application copy, never a server response or diagnostic message.
   * @param options - original failure retained as the standard Error cause when present.
   */
  constructor(readonly summary: string, options?: ErrorOptions) {
    super(summary, options)
    this.name = 'UserFacingError'
  }
}

/**
 * Render a safe summary without reading diagnostic messages, response bodies, or causes.
 * Handle business-specific failures and partial effects before calling this fallback.
 * @param t - current locale translator, including the shared common keys.
 * @param failure - original caught value or Remote failure; retained unchanged for diagnostics.
 * @returns a localized summary; unknown outcomes require checking state before retrying.
 */
export function userErrorMessage(t: (key: UserErrorKey) => string, failure: unknown): string {
  if (failure instanceof UserFacingError) return failure.summary
  // RemoteError's marker survives module and realm copies; a bare code is not a Remote failure.
  const code = typeof failure === 'object' && failure !== null
    && 'isDSHRemoteError' in failure && failure.isDSHRemoteError === true
    && 'code' in failure && typeof failure.code === 'string' ? failure.code : undefined
  switch (code) {
    case 'gateway/cancelled':
      return t('uiError.cancelled')
    case 'gateway/bad-request':
    case 'gateway/arguments-invalid':
      return t('uiError.invalidInput')
    case 'gateway/service-unavailable':
    case 'gateway/context-unavailable':
    case 'gateway/definition-unavailable':
    case 'gateway/method-unavailable':
      return t('uiError.unavailable')
    // Domain codes and unclassified failures do not establish whether an operation committed.
    default:
      return t('uiError.unknown')
  }
}
