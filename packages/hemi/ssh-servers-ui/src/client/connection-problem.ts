/** Localized connection failure classification; private SSH output never becomes UI copy. */
import type { RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'

type ConnectionProblem = 'connectionReadFailed' | 'sshUnavailable' | 'runtimeMissing'
  | 'runtimeProvisionFailed' | 'cacheUnavailable' | 'directoryUnavailable' | 'installationIncomplete' | 'authenticationCancelled'
  | 'passwordRememberFailed'

/**
 * Select safe recovery copy for a failed remote connection or staged directory request.
 * @param failure - structured failure returned by the remote operation.
 * @returns locale key naming the failed capability.
 */
export function connectionProblem(failure: RemoteFailure | undefined): ConnectionProblem {
  switch (failure?.code) {
    case 'hemi-ssh/authentication-cancelled': return 'authenticationCancelled'
    case 'hemi-ssh/remember-failed': return 'passwordRememberFailed'
    case 'hemi-ssh/remote-directory-unavailable': return 'directoryUnavailable'
    case 'hemi-ssh/helper-artifacts-missing': return 'installationIncomplete'
    case 'hemi-ssh/ssh-unavailable': return 'sshUnavailable'
    case 'hemi-ssh/remote-runtime-missing': return 'runtimeMissing'
    case 'hemi-ssh/runtime-provision-failed': return 'runtimeProvisionFailed'
    case 'hemi-ssh/remote-cache-unwritable': return 'cacheUnavailable'
    default: return 'connectionReadFailed'
  }
}

/**
 * Preserve the native operation's bounded explanation without classifying its text.
 * @param failure - typed remote error received by the authorized SSH owner.
 * @returns native SSH or directory diagnostic, not a password or internal exception dump.
 */
export function connectionDiagnostic(failure: RemoteFailure | undefined): string | undefined {
  switch (failure?.code) {
    case 'hemi-ssh/ssh-unavailable':
    case 'hemi-ssh/remote-directory-unavailable': return failure.details.reason
    default: return undefined
  }
}
