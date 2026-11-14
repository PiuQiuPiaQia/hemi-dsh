/** Show SSH execution availability beside the composer without changing its draft or history. */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NS } from './locales.ts'
import css from './SessionConnectionNotice.module.css'

type Props = PropsRuntime<'conversation.input.dock'> & PropsLocale<typeof NS>

/**
 * Render reconnect guidance for a retained SSH conversation without a live Agent.
 * @param props - Session list and composer state projected by the Client.
 * @returns the inline notice while SSH execution is unavailable.
 */
export function SessionConnectionNotice({ useSessions, session, t }: Props) {
  const row = useSessions(state => state.byId[session.sessionId])
  if (row?.executionTarget?.provider !== 'hemi-ssh' || row.agentAvailable !== false || session.openState !== 'open') {
    return null
  }
  const failed = session.promptError?.op === 'send' && session.promptError.error.code === 'session/execution-unavailable'
  return <p className={css.notice} role="status">{t(failed ? 'sessionReconnectFailed' : 'sessionDisconnected')}</p>
}
