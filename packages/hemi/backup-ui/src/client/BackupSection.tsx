/**
 * Hemi data backup settings section: target configuration, manual and
 * scheduled runs, the backup-set list, and the staged restore dialog, all
 * through the `hemiBackup` Remote namespace.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { BackupSetView, BackupStateView, RestorePreview } from './types.ts'
import css from './BackupSection.module.css'

/** Target editor draft; the password is sent only when filled in. */
export interface TargetDraft {
  /** Target kind. */
  kind: 'local' | 'webdav'
  /** Local backup folder. */
  dir: string
  /** WebDAV server address. */
  url: string
  /** WebDAV account name. */
  username: string
  /** Fresh application password; empty keeps the stored one. */
  password: string
  /** Remote directory under the WebDAV root. */
  remoteDir: string
}

/** Injected business face over the `hemiBackup` Remote namespace. */
export interface BackupSectionInjected {
  /** Read settings, password presence, run flag, and live progress. */
  getState: () => Promise<BackupStateView>
  /** Save target and optionally a fresh application password. */
  saveTarget: (target: TargetDraft) => Promise<BackupStateView>
  /** Save schedule preferences. */
  saveSchedule: (schedule: { enabled: boolean; interval: 'daily' | 'weekly' }, keep: number) => Promise<BackupStateView>
  /** Probe a target draft without saving it. */
  testConnection: (target: TargetDraft) => Promise<{ ok: boolean; message?: string }>
  /** Run one backup now. */
  runNow: () => Promise<{ ok: boolean; message?: string }>
  /** List backup sets on the configured target. */
  listBackups: () => Promise<readonly BackupSetView[]>
  /** Delete one backup set. */
  deleteSet: (name: string) => Promise<{ ok: boolean; message?: string }>
  /** Stage one set and return the restore preview. */
  restorePrepare: (name: string) => Promise<{ ok: boolean; preview?: RestorePreview; message?: string }>
  /** Apply the staged restore. */
  restoreApply: () => Promise<{ ok: boolean; message?: string }>
  /** Discard the staged restore. */
  restoreCancel: () => Promise<{ ok: boolean }>
}

/** Full component props: runtime share + locale seat + injected face. */
export type BackupSectionProps = PropsRuntime<'settings.section'>
  & PropsLocale<'hemi-backup'>
  & InjectFace<BackupSectionInjected>

type Busy = 'load' | 'target' | 'test' | 'run' | 'schedule' | 'list' | 'delete' | 'prepare' | 'apply' | null

const formatBytes = (bytes: number | null | undefined): string => {
  if (bytes === null || bytes === undefined) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[unit]}`
}

const formatTime = (iso: string | null): string =>
  iso === null || !Number.isFinite(Date.parse(iso)) ? '' : new Date(iso).toLocaleString()

/**
 * Render the backup settings section.
 * @param props - composed slot props.
 * @returns the section element tree.
 */
export function BackupSection(props: BackupSectionProps) {
  const {
    t,
    getState,
    saveTarget,
    saveSchedule,
    testConnection,
    runNow,
    listBackups,
    deleteSet,
    restorePrepare,
    restoreApply,
    restoreCancel,
  } = props
  const [state, setState] = useState<BackupStateView | null>(null)
  const [draft, setDraft] = useState<TargetDraft>({ kind: 'local', dir: '', url: 'https://dav.jianguoyun.com/dav/', username: '', password: '', remoteDir: 'hemi-backups' })
  const [schedule, setSchedule] = useState<{ enabled: boolean; interval: 'daily' | 'weekly' }>({ enabled: false, interval: 'daily' })
  const [keep, setKeep] = useState('5')
  const [sets, setSets] = useState<readonly BackupSetView[]>([])
  const [busy, setBusy] = useState<Busy>('load')
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [restore, setRestore] = useState<{ name: string; preview: RestorePreview } | null>(null)
  const alive = useRef(true)

  const refreshList = useCallback(async () => {
    const next = await listBackups()
    if (alive.current) setSets(next)
  }, [listBackups])

  const refresh = useCallback(async () => {
    const next = await getState()
    if (!alive.current) return
    setState(next)
    const target = next.settings.target
    if (target !== null) {
      setDraft(previous => ({
        ...previous,
        kind: target.kind,
        dir: target.kind === 'local' ? target.dir : previous.dir,
        url: target.kind === 'webdav' ? target.url : previous.url,
        username: target.kind === 'webdav' ? target.username : previous.username,
        remoteDir: target.kind === 'webdav' ? target.remoteDir : previous.remoteDir,
        password: '',
      }))
    }
    setSchedule(next.settings.schedule)
    setKeep(String(next.settings.keep))
  }, [getState])

  useEffect(() => {
    alive.current = true
    void (async () => {
      try {
        await refresh()
        await refreshList()
      } catch (error) {
        if (alive.current) setNotice({ ok: false, text: error instanceof Error ? error.message : String(error) })
      } finally {
        if (alive.current) setBusy(null)
      }
    })()
    return () => {
      alive.current = false
    }
  }, [refresh, refreshList])

  // Progress polling: while a run executes, poll state until it settles.
  useEffect(() => {
    if (!state?.isRunning) return
    const timer = setInterval(() => {
      void getState().then((next) => {
        if (alive.current) setState(next)
      }).catch(() => {})
    }, 2000)
    return () => {
      clearInterval(timer)
    }
  }, [state?.isRunning, getState])

  // Discard any staged restore when the section unmounts.
  const restoreRef = useRef<typeof restore>(null)
  restoreRef.current = restore
  useEffect(() => () => {
    if (restoreRef.current !== null) void restoreCancel().catch(() => {})
  }, [restoreCancel])

  const bindDraft = (apply: (previous: TargetDraft, value: string) => TargetDraft) =>
    (event: { target: { value: string } }): void => {
      setDraft(previous => apply(previous, event.target.value))
    }

  const guard = async (mark: Exclude<Busy, null>, action: () => Promise<void>): Promise<void> => {
    if (busy !== null) return
    setBusy(mark)
    setNotice(null)
    try {
      await action()
    } catch (error) {
      setNotice({ ok: false, text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(null)
    }
  }

  const lastRun = state?.settings.lastRun ?? null
  const hasTarget = state?.settings.target != null

  return (
    <section className={css.section} aria-label={t('nav')}>
      <header className={css.header}>
        <h2 className={css.title}>{t('title')}</h2>
        <p className={css.description}>{t('description')}</p>
      </header>

      <div className={css.card}>
        <div className={css.row}>
          <span className={css.key}>{t('lastRun')}</span>
          <span className={css.value}>
            {lastRun === null
              ? (hasTarget ? t('lastRunNone') : '')
              : lastRun.ok
                ? `${t('lastRunOk')} · ${formatTime(lastRun.at)} · ${formatBytes(lastRun.packedBytes)}`
                : `${t('lastRunFailed')} · ${formatTime(lastRun.at)} · ${lastRun.message ?? ''}`}
          </span>
        </div>

        <div className={css.row}>
          <label className={css.key} htmlFor="hemi-backup-kind">{t('targetKind')}</label>
          <select
            id="hemi-backup-kind"
            className={css.select}
            value={draft.kind}
            disabled={busy !== null}
            onChange={bindDraft((previous, value) => ({ ...previous, kind: value as TargetDraft['kind'] }))}
          >
            <option value="local">{t('targetLocal')}</option>
            <option value="webdav">{t('targetWebdav')}</option>
          </select>
        </div>
        {draft.kind === 'local' ? (
          <div className={css.row}>
            <label className={css.key} htmlFor="hemi-backup-dir">{t('targetDir')}</label>
            <Input
              id="hemi-backup-dir"
              className={css.input ?? ''}
              value={draft.dir}
              placeholder={t('localPathHint')}
              onChange={bindDraft((previous, value) => ({ ...previous, dir: value }))}
            />
          </div>
        ) : (
          <>
            <div className={css.row}>
              <label className={css.key} htmlFor="hemi-backup-url">{t('targetUrl')}</label>
              <Input id="hemi-backup-url" className={css.input ?? ''} value={draft.url} placeholder={t('webdavUrlHint')} onChange={bindDraft((previous, value) => ({ ...previous, url: value }))} />
            </div>
            <div className={css.row}>
              <label className={css.key} htmlFor="hemi-backup-user">{t('targetUsername')}</label>
              <Input id="hemi-backup-user" className={css.input ?? ''} value={draft.username} onChange={bindDraft((previous, value) => ({ ...previous, username: value }))} />
            </div>
            <div className={css.row}>
              <label className={css.key} htmlFor="hemi-backup-password">{t('targetPassword')}</label>
              <Input
                id="hemi-backup-password"
                className={css.input ?? ''}
                type="password"
                value={draft.password}
                placeholder={state?.hasPassword === true ? t('targetPasswordSaved') : ''}
                onChange={bindDraft((previous, value) => ({ ...previous, password: value }))}
              />
            </div>
            <div className={css.row}>
              <label className={css.key} htmlFor="hemi-backup-remote">{t('targetRemoteDir')}</label>
              <Input id="hemi-backup-remote" className={css.input ?? ''} value={draft.remoteDir} onChange={bindDraft((previous, value) => ({ ...previous, remoteDir: value }))} />
            </div>
            <p className={css.help}>{t('targetHelp')}</p>
            <p className={css.help}>{t('plaintextNote')}</p>
          </>
        )}
        <div className={css.actions}>
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void guard('test', async () => {
            const result = await testConnection(draft)
            setNotice({ ok: result.ok, text: result.ok ? t('testOk') : result.message ?? t('saveFailed') })
          })}>
            {busy === 'test' ? t('testing') : t('test')}
          </Button>
          <Button variant="primary" size="sm" disabled={busy !== null} onClick={() => void guard('target', async () => {
            await saveTarget(draft)
            setNotice({ ok: true, text: t('saved') })
            await refresh()
            await refreshList()
          })}>
            {busy === 'target' ? t('saving') : t('save')}
          </Button>
          <Button variant="primary" size="sm" disabled={busy !== null || !hasTarget} onClick={() => void guard('run', async () => {
            const result = await runNow()
            setNotice({ ok: result.ok, text: result.ok ? t('saved') : result.message ?? t('saveFailed') })
            await refresh()
            await refreshList()
          })}>
            {busy === 'run' || state?.isRunning === true ? t('running') : t('runNow')}
          </Button>
        </div>
      </div>

      <div className={css.card}>
        <div className={css.row}>
          <span className={css.key}>{t('scheduleEnabled')}</span>
          <Switch
            checked={schedule.enabled}
            label={t('scheduleEnabled')}
            disabled={busy !== null}
            onChange={(next) => {
              setSchedule(previous => ({ ...previous, enabled: next }))
            }}
          />
        </div>
        <div className={css.row}>
          <label className={css.key} htmlFor="hemi-backup-interval">{t('scheduleTitle')}</label>
          <select
            id="hemi-backup-interval"
            className={css.select}
            value={schedule.interval}
            disabled={busy !== null || !schedule.enabled}
            onChange={(event) => {
              setSchedule(previous => ({ ...previous, interval: event.target.value === 'weekly' ? 'weekly' : 'daily' }))
            }}
          >
            <option value="daily">{t('scheduleDaily')}</option>
            <option value="weekly">{t('scheduleWeekly')}</option>
          </select>
        </div>
        <div className={css.row}>
          <label className={css.key} htmlFor="hemi-backup-keep">{t('keepCount')}</label>
          <Input
            id="hemi-backup-keep"
            className={css.input ?? ''}
            type="number"
            min={1}
            max={50}
            value={keep}
            disabled={busy !== null}
            onChange={(event) => {
              setKeep(event.target.value)
            }}
          />
        </div>
        <p className={css.help}>{t('keepHelp')}</p>
        <div className={css.actions}>
          <Button variant="primary" size="sm" disabled={busy !== null} onClick={() => void guard('schedule', async () => {
            await saveSchedule(schedule, Math.min(Math.max(Number(keep) || 5, 1), 50))
          })}>
            {busy === 'schedule' ? t('saving') : t('saveSchedule')}
          </Button>
        </div>
      </div>

      <div className={css.card}>
        <div className={css.listHead}>
          <span className={css.key}>{t('listTitle')}</span>
          <Button variant="outline" size="sm" disabled={busy !== null || !hasTarget} onClick={() => void guard('list', refreshList)}>
            {busy === 'list' ? t('refreshing') : t('refresh')}
          </Button>
        </div>
        {!hasTarget
          ? <p className={css.help}>{t('listConfigureFirst')}</p>
          : sets.length === 0
            ? <p className={css.help}>{t('listEmpty')}</p>
            : (
              <ul className={css.list}>
                {sets.map(set => (
                  <li key={`${set.source}:${set.name}`} className={css.listItem}>
                    <span className={css.listMain}>
                      {formatTime(set.createdAt) || set.name}
                      {set.broken === true ? ` · ${t('broken')}` : ` · ${formatBytes(set.packedBytes)}`}
                    </span>
                    <span className={css.listAside}>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy !== null || set.broken === true}
                        onClick={() => void guard('prepare', async () => {
                          const result = await restorePrepare(set.name)
                          if (result.ok && result.preview !== undefined) setRestore({ name: set.name, preview: result.preview })
                          else setNotice({ ok: false, text: result.message ?? t('applyFailed') })
                        })}
                      >
                        {busy === 'prepare' ? t('preparing') : t('restore')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => void guard('delete', async () => {
                          if (!window.confirm(t('deleteConfirm'))) return
                          const result = await deleteSet(set.name)
                          setNotice({ ok: result.ok, text: result.ok ? '' : result.message ?? t('saveFailed') })
                          await refreshList()
                        })}
                      >
                        {busy === 'delete' ? t('deleting') : t('delete')}
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
      </div>

      {restore !== null ? (
        <div className={css.card} role="dialog" aria-label={t('restore')}>
          <div className={css.row}>
            <span className={css.key}>{restore.name}</span>
          </div>
          <p className={css.help}>
            {restore.preview.files} {t('previewFiles')} · {restore.preview.sessions} {t('previewSessions')} · {restore.preview.skills} {t('previewSkills')}
          </p>
          <p className={css.help}>
            {t('previewNew')} {restore.preview.estimate.newFiles} · {t('previewIdentical')} {restore.preview.estimate.identical} · {t('previewConflicts')} {restore.preview.estimate.conflicts}
          </p>
          <p className={css.help}>{t('mergeNote')}</p>
          <p className={css.help}>{t('restartNote')}</p>
          <div className={css.actions}>
            <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => {
              setRestore(null)
              void restoreCancel().catch(() => {})
            }}>
              {t('cancel')}
            </Button>
            <Button variant="primary" size="sm" disabled={busy !== null} onClick={() => void guard('apply', async () => {
              const result = await restoreApply()
              setNotice({ ok: result.ok, text: result.ok ? t('applied') : result.message ?? t('applyFailed') })
              setRestore(null)
            })}>
              {busy === 'apply' ? t('applying') : t('apply')}
            </Button>
          </div>
        </div>
      ) : null}

      {notice !== null && notice.text !== '' ? <p className={notice.ok ? css.noticeOk : css.noticeBad} role="status">{notice.text}</p> : null}
      {state?.progress != null && state.isRunning ? <p className={css.help} role="status">{state.progress.detail ?? state.progress.phase}</p> : null}
    </section>
  )
}
