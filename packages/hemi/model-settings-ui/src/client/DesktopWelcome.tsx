/** Provider-neutral, device-local introduction hosted by the settings coordinator. */
import { useState } from 'react'
import type { SettingsOnboardingOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { en } from './locales.ts'
import css from './DesktopWelcome.module.css'

/** Local introduction actions; no provider account or credential values reach this view. */
export interface DesktopWelcomeInjected {
  t: (key: keyof typeof en) => string
  loadFailed: boolean
  reload: () => Promise<{ readonly enabled: boolean; readonly completed: boolean }>
  acknowledge: () => Promise<void>
}

/**
 * Show one provider-neutral introduction; failed persistence leaves it available for retry.
 * @param props - settings navigation, localized copy and local completion actions.
 * @returns the native-style welcome page with model setup and workspace entry.
 */
export function DesktopWelcome({ complete, openSection, loadFailed, reload, acknowledge, t }:
  SettingsOnboardingOwnerProps & DesktopWelcomeInjected) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(loadFailed ? 'load' : '')
  const finish = async (configure: boolean): Promise<void> => {
    if (busy) return
    setBusy(true)
    setFailed('')
    try {
      await acknowledge()
      complete()
      if (configure) openSection('hemi-model-access')
    } catch (_error: unknown) {
      setFailed('save')
      setBusy(false)
    }
  }
  const retry = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const state = await reload()
      if (!state.enabled || state.completed) complete()
      else setFailed('')
    } catch (_error: unknown) {
      setFailed('load')
    } finally { setBusy(false) }
  }
  return <Modal open headless title={t('welcomeTitle')} className={`${css.page}`} backdropBlur={false}
    onClose={() => { if (!busy && failed !== 'load') void finish(false) }}>
    <div className={css.titlebar} data-window-drag aria-hidden="true" />
    <main className={css.welcome} aria-busy={busy} aria-labelledby="hemi-welcome-heading">
      <div className={css.brand}>{t('welcomeBrand')}</div>
      <div className={css.tagline}>
        <h1 id="hemi-welcome-heading">{t('welcomeHeading')}</h1>
        <p>{t('welcomeDescription')}</p>
      </div>
      <div className={css.actions}>
        {failed === 'load' ? <Button className={css.primary} disabled={busy} data-modal-autofocus onClick={() => { void retry() }}>{t('retry')}</Button> : <>
          <Button className={css.primary} disabled={busy} data-modal-autofocus onClick={() => { void finish(true) }}>{t('configureModels')}</Button>
          <Button className={css.secondary} disabled={busy} onClick={() => { void finish(false) }}>{t('enterWorkspace')}</Button>
        </>}
        {failed !== '' && <p className={css.error} role="alert">{t(failed === 'load' ? 'welcomeLoadFailed' : 'welcomeFailed')}</p>}
      </div>
    </main>
  </Modal>
}
