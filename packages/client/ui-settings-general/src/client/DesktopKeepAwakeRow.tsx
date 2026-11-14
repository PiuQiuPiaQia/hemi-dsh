/** Desktop keep-awake switch; persistence and the power-save assertion remain in Electron. */
import { useState } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopKeepAwakeSource } from './desktop-keep-awake-source.ts'
import css from './DesktopKeepAwakeRow.module.css'

/** Framework-bound shell state and explicit toggle action. */
export interface DesktopKeepAwakeRowInjected {
  hooks: { keepAwake: DesktopKeepAwakeSource['store'] }
  setEnabled(enabled: boolean): Promise<void>
}

/**
 * Render the Desktop-only keep-awake control without depending on a Host settings service.
 * @param props - Shell observation, toggle action and localized copy.
 * @returns The General settings row.
 */
export function DesktopKeepAwakeRow({ useKeepAwake, setEnabled, t }:
  PropsRuntime<'settings.general.item'> & PropsLocale<'settings'> & InjectFace<DesktopKeepAwakeRowInjected>) {
  const { state, failed, pending } = useKeepAwake(value => value)
  const [writeFailed, setWriteFailed] = useState(false)
  const enabled = pending ?? state?.enabled ?? false
  return <div className={css.row} role="group" aria-label={t('desktop.keepAwake.title')}>
    <div className={css.rowText}>
      <div className={css.title}>{t('desktop.keepAwake.title')}</div>
      <div className={css.description}>{t('desktop.keepAwake.description')}</div>
      {(writeFailed || failed || state?.error !== undefined)
        && <div role="alert">{t(failed ? 'desktop.keepAwake.readError' : 'desktop.keepAwake.error')}</div>}
    </div>
    <Switch checked={enabled} disabled={pending !== undefined} label={t('desktop.keepAwake.title')}
      onChange={(next) => {
        setWriteFailed(false)
        void setEnabled(next).catch(() => { setWriteFailed(true) })
      }} />
  </div>
}
