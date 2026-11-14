/** Manual unread actions contributed to the shared Session menu. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { IconClockOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { dictionaries, type UnreadKey } from './locales.ts'

const NS = 'hemi-session-unread'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Manual unread action text. */
    'hemi-session-unread': UnreadKey
  }
}

/** Services owning menus, Session status, archive visibility, and localization. */
export const inject = ['contextMenus', 'uiSession', 'workspaces', 'slots', 'locale']

/**
 * Add an unread reminder without opening or mutating the captured Session.
 * @param ctx - browser plugin context owning reversible contributions.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'hemi-session-unread: copy')
  ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({
    name: 'contextMenu.icon', key: 'hemi-session-unread.reminder',
  }, IconClockOutlineRegular))
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.contextMenus.register({
    id: 'hemi-session-unread.mark', target: 'session', order: 350,
    observe: () => [ctx.workspaces.list, ctx.locale],
    resolve: ({ sessionId }) => ctx.workspaces.list.getSnapshot().archivedSessionIds.includes(sessionId) ? [] : [{
      id: 'mark-unread', label: t('markUnread'), icon: { key: 'hemi-session-unread.reminder' },
      run: () => { ctx.uiSession.markUnread(sessionId) },
    }],
  }), 'hemi-session-unread: menu')
}
