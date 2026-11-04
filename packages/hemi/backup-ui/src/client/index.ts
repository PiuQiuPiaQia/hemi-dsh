/** Hemi data backup settings section over the `hemiBackup` Remote namespace. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-hemi-backup/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-hemi-backup/remote'
import { BackupSection, type BackupSectionInjected, type TargetDraft } from './BackupSection.tsx'
import { en, zh, type BackupLocaleKey } from './locales.ts'
import type { BackupSetView, BackupStateView, RestorePreview } from './types.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'hemi-backup': BackupLocaleKey }
}

/** Unwrap one Remote result envelope or rethrow its error. */
async function unwrap<T>(call: Promise<RemoteResult<T>>): Promise<T> {
  const result = await call
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/** Services: slot registry, locale, and the `hemiBackup` Remote namespace. */
export const inject = ['slots', 'locale', 'remote']

/**
 * Register the backup settings section on the general settings page: target
 * configuration, manual and scheduled runs, the backup-set list, and the
 * staged restore dialog.
 * @param ctx - client plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('hemi-backup', { en, zh }), 'hemi-backup-ui: dictionaries')
  ctx.effect(() => ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'hemi-backup',
    order: 30,
    locale: 'hemi-backup',
    inject: (): BackupSectionInjected => {
      const remote = ctx.remote.hemiBackup
      const toTarget = (draft: TargetDraft) => draft.kind === 'local'
        ? { kind: 'local' as const, dir: draft.dir }
        : { kind: 'webdav' as const, url: draft.url, username: draft.username, remoteDir: draft.remoteDir }
      const toDraftPayload = (draft: TargetDraft) => ({
        target: toTarget(draft),
        ...draft.password !== '' ? { password: draft.password } : {},
      })
      return {
        getState: () => unwrap<BackupStateView>(remote.getState()),
        saveTarget: async draft => unwrap<BackupStateView>(remote.saveSettings(toDraftPayload(draft))),
        saveSchedule: (schedule, keep) => unwrap<BackupStateView>(remote.saveSettings({ schedule, keep })),
        testConnection: draft => unwrap<{ ok: boolean; message?: string }>(remote.testConnection({ ...toTarget(draft), ...draft.password !== '' ? { password: draft.password } : {} })),
        runNow: () => unwrap<{ ok: boolean; message?: string }>(remote.runNow()),
        listBackups: () => unwrap<readonly BackupSetView[]>(remote.listBackups()),
        deleteSet: name => unwrap<{ ok: boolean; message?: string }>(remote.deleteSet(name)),
        restorePrepare: name => unwrap<{ ok: boolean; preview?: RestorePreview; message?: string }>(remote.restorePrepare(name)),
        restoreApply: () => unwrap<{ ok: boolean; message?: string }>(remote.restoreApply()),
        restoreCancel: () => unwrap<{ ok: boolean }>(remote.restoreCancel()),
      }
    },
  }, BackupSection)), 'hemi-backup-ui: settings section')
}
