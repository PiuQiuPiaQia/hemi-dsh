import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { MenuContribution } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as plugin from '../src/client/index.ts'

it('captures the Session, hides archived actions, and removes contributions on unload', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('locale', new LocaleRuntime(ctx))
  await ctx.plugin(SlotRegistry).await()
  const workspaces = createSnapshotStore({ archivedSessionIds: [] as ReturnType<typeof SessionId>[] })
  ctx.provide('workspaces', { list: workspaces } as never)
  const markUnread = vi.fn()
  ctx.provide('uiSession', { markUnread } as never)
  const entries = new Map<string, MenuContribution<'session'>>()
  ctx.provide('contextMenus', { register: (entry: MenuContribution<'session'>) => {
    entries.set(entry.id, entry)
    return () => { entries.delete(entry.id) }
  } } as never)
  const fiber = ctx.plugin(plugin)
  await fiber.await()
  const contribution = entries.get('hemi-session-unread.mark')!
  const target = { sessionId: SessionId('captured'), displayTitle: 'Captured' }
  const signal = new AbortController().signal
  const rows = await contribution.resolve(target, signal)
  expect(rows).toHaveLength(1)
  expect(contribution.order).toBe(350)
  expect(rows[0]!.label).toBe('Mark as unread')
  expect(contribution.observe?.(target)).toContain(workspaces)
  await rows[0]!.run?.()
  expect(markUnread).toHaveBeenCalledExactlyOnceWith(target.sessionId)
  workspaces.set({ archivedSessionIds: [target.sessionId] })
  expect(await contribution.resolve(target, signal)).toEqual([])
  await fiber.dispose()
  expect(entries.size).toBe(0)
})
