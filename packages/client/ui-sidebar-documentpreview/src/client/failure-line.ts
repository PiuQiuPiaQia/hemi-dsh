/**
 * The failure line one Remote code deserves.
 *
 * Kept apart from the component so the mapping is testable on its own. Codes
 * this reader does not name fall to the shared safe operation summary, never
 * to the carrier's own message.
 */
import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { userErrorMessage } from '@deepseek-ai/dsh-client-ui-primitives'

/** Render a byte count the way a person reads one. */
function humanBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/**
 * Say what went wrong, in terms of the file rather than of the transport.
 * @param t - namespace-bound translate.
 * @param failure - the settled Remote failure.
 * @returns the line to show in place of the file.
 */
export function failureLine(t: TranslateNS<'sidebarDocumentPreview'>, failure: RemoteFailure): string {
  switch (failure.code) {
    case 'workspace-file/not-found': return t('error.notFound')
    case 'workspace-file/too-large':
      return t('error.tooLarge', { limit: humanBytes(failure.details.limit) })
    case 'workspace-file/not-text': return t('error.notText')
    case 'workspace-file/not-regular-file': return t('error.notRegularFile')
    // Hemi fork: carrier and unclassified host failures show the shared safe
    // summary, because their diagnostic message can carry paths, response
    // bodies, or stack text; the failure object stays on the store for
    // developer diagnosis.
    default: return userErrorMessage(t, failure)
  }
}

/** The action an empty preview offers beside its failure line. */
export type EmptyFailureRecourse = 'open' | 'retry' | 'none'

/**
 * Choose the empty state's action for one settled read failure.
 * @param failure - the settled Remote failure.
 * @returns `open` for a readable file this preview cannot render, `none` for a
 * path with nothing to show or open, `retry` for the rest: carrier and
 * unclassified failures a second read may resolve.
 */
export function emptyFailureRecourse(failure: RemoteFailure): EmptyFailureRecourse {
  switch (failure.code) {
    case 'workspace-file/not-text':
    case 'workspace-file/too-large':
      return 'open'
    case 'workspace-file/not-found':
    case 'workspace-file/not-regular-file':
      return 'none'
    default: return 'retry'
  }
}
