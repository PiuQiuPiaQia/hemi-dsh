/** Localized plan-owned failures and the shared safe summary for everything else. */
import type { RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { userErrorMessage } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Explain a failed plan read in the current locale.
 * @param t - Plan namespace translator.
 * @param failure - Failure reported by the resource provider.
 * @returns localized plan copy, or the shared safe operation summary.
 */
export function planFailureLine(t: TranslateNS<'plan'>, failure: RemoteFailure): string {
  switch (failure.code) {
    case 'plan/invalid-address': return t('preview.invalidAddress')
    case 'plan/not-found': return t('preview.notFound')
    // Hemi fork: transport failures, including plan/read-failed, show the
    // shared safe summary instead of the carrier's message, which can carry
    // host paths or response text; the failure object stays on the resource
    // for developer diagnosis.
    default: return userErrorMessage(t, failure)
  }
}
