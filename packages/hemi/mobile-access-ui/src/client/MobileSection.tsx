/** Capability-selected phone settings; only private invitation and interaction state live in React. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MobileInvitation, MobilePairRequest } from '../types.ts'
import type { CommandOutcome, MobileSectionProps, NativeConnection, NativeDisconnectOutcome } from './types.ts'
import { MOBILE_ADDRESS } from './controller.ts'
import { invitationQr } from './qr.ts'
import css from './MobileSection.module.css'

/**
 * Show native connection controls or authoritative desktop management without conditional resource hooks.
 * @param props - Framework-derived settings, locale, capability, resource, and action inputs.
 * @returns Native connection controls when injected, otherwise the existing desktop/browser section.
 */
export function MobileSection(props: MobileSectionProps) {
  return props.nativeConnection === null ? <DesktopSection {...props} />
    : <NativeSection t={props.t} connection={props.nativeConnection} />
}

function NativeSection({ t, connection }: Pick<MobileSectionProps, 't'> & { connection: NativeConnection }) {
  const [outcome, setOutcome] = useState<NativeDisconnectOutcome | null>(null)
  const dispatched = useRef(false)
  return <section className={css.section} aria-label={t('nav')}>
    <h2 className={css.title}>{t('computer')}</h2>
    <div className={css.card}>
      <p className={css.computerName}>{connection.serverName}</p>
      <div className={css.actions}>
        <Button variant="outline" disabled={outcome !== null} onClick={() => {
          if (dispatched.current) return
          dispatched.current = true
          try { setOutcome(connection.disconnect()) } catch (_error: unknown) {
            setOutcome('unknown')
          }
        }}>{t('disconnect')}</Button>
      </div>
    </div>
    <div className={css.feedback} aria-live="polite">
      {outcome === 'unknown' ? <p className={css.error} role="alert">{t('disconnectUnknown')}</p> : null}
    </div>
  </section>
}

function DesktopSection(props: MobileSectionProps) {
  const { t, useResource, refresh, start, stop, createInvitation, approve, reject, revoke, copy } = props
  const resource = useResource<'hemi-mobile-access'>(MOBILE_ADDRESS)
  const [invitation, setInvitation] = useState<MobileInvitation | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)
  const [now, setNow] = useState(Date.now)
  const lifetime = useRef({ active: true, pending: false })
  useEffect(() => {
    lifetime.current.active = true
    // This timer only redraws expiry; the resource owns every business read and its cancellation.
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { lifetime.current.active = false; clearInterval(timer) }
  }, [])

  const state = resource.value?.kind === 'state' ? resource.value.state : undefined
  const pending = state?.listening === true && state.invitation === null
    ? state.requests.find(request => request.status === 'pending' && request.expiresAt > now) : undefined
  const usable = pending === undefined && invitation !== null && invitation.expiresAt > now && state?.listening === true
    && state.invitation !== null && state.invitation.expiresAt === invitation.expiresAt
    && state.invitation.origin === invitation.origin && state.invitation.fingerprint === invitation.fingerprint
  const content = usable ? JSON.stringify(invitation) : ''
  const qr = useMemo(() => content === '' ? null : invitationQr(content), [content])
  const blocked = busy || resource.status !== 'live'

  const run = async (action: () => Promise<CommandOutcome>, success?: 'stopped' | 'revoked' | 'denied'): Promise<void> => {
    if (lifetime.current.pending) return
    lifetime.current.pending = true
    setBusy(true)
    setNotice(null)
    try {
      const result = await action()
      if (!lifetime.current.active || result.kind === 'withdrawn') return
      if (result.kind === 'failed') setNotice({ error: true, text: t(result.problem) })
      else {
        if (result.invitation !== null) { setNow(Date.now()); setInvitation(result.invitation) }
        if (success !== undefined) setNotice({ error: false, text: t(success) })
      }
    } catch (_error: unknown) {
      // Injection defects and unexpected command failures cannot produce a success message.
      if (lifetime.current.active) setNotice({ error: true, text: t('unknown') })
    } finally {
      lifetime.current.pending = false
      if (lifetime.current.active) setBusy(false)
    }
  }

  if (resource.value?.kind === 'unauthorized') return <section className={css.section} aria-label={t('nav')}>
    <h2 className={css.title}>{t('nav')}</h2><p className={css.help}>{t('localOnly')}</p>
  </section>

  return <section className={css.section} aria-label={t('nav')} aria-busy={busy}>
    <header className={css.header}>
      <h2 className={css.title}>{t('nav')}</h2>
      <p className={css.description}>{t('description')}</p>
    </header>

    {resource.status === 'failed' || resource.status === 'none' ? <div className={css.notice}>
      <p role="alert">{t('readFailed')}</p>
      <Button variant="outline" disabled={busy} onClick={refresh}>{t('retry')}</Button>
    </div> : null}
    {state === undefined && resource.status === 'loading' ? <div className={css.loading} role="status" aria-label={t('loading')}><StateDot state="ongoing" /></div> : null}

    {state !== undefined ? <>
      <div className={css.card}>
        <div className={css.row}>
          <span className={css.subheading}>{t(state.listening ? 'on' : 'off')}</span>
          <Button variant={state.listening ? 'outline' : 'primary'} disabled={blocked}
            onClick={() => {
              if (state.listening) void run(stop, 'stopped')
              else void run(start)
            }}>
            {busy ? t('busy') : t(state.listening ? 'stop' : 'start')}
          </Button>
        </div>
        {!state.listening && state.addresses.length === 0 ? <div className={css.notice}>
          <p className={css.help}>{t('noNetwork')}</p><Button variant="outline" disabled={busy} onClick={refresh}>{t('retry')}</Button>
        </div> : null}
      </div>

      {pending !== undefined ? <PendingPanel key={pending.requestId} request={pending} blocked={blocked} t={t}
        approve={() => { void run(() => approve(pending.requestId, pending.verificationCode)) }}
        reject={() => { void run(() => reject(pending.requestId), 'denied') }} />
        : state.listening ? <div className={css.card}>
          <h3 className={css.subheading}>{t('pairTitle')}</h3>
          <p className={css.help}>{t('pairHelp')}</p>
          {usable ? <div className={css.pairing}>
            {qr === null ? <p className={css.help} role="alert">{t('qrFailed')}</p>
              : <img className={css.qr} src={qr} alt={t('qrAlt')} />}
            <p className={css.help} role="timer">{t('remaining', { seconds: Math.max(0, Math.ceil((invitation.expiresAt - now) / 1000)) })}</p>
            <details className={css.manual}>
              <summary>{t('manual')}</summary>
              <p className={css.help}>{t('manualHelp')}</p>
              <textarea className={css.payload} aria-label={t('copy')} readOnly value={content}
                onFocus={(event) => { event.currentTarget.select() }} />
              <Button variant="outline" disabled={busy} onClick={() => {
                void copy(content).then((ok) => {
                  if (lifetime.current.active) setNotice({ error: !ok, text: t(ok ? 'copied' : 'copyFailed') })
                }).catch((_error: unknown) => {
                  if (lifetime.current.active) setNotice({ error: true, text: t('copyFailed') })
                })
              }}>{t('copy')}</Button>
            </details>
          </div> : <p className={css.help} role="status">{invitation !== null && invitation.expiresAt <= now ? t('expired') : t('invitationMissing')}</p>}
          <div className={css.actions}>
            <Button variant={usable ? 'outline' : 'primary'} disabled={blocked} onClick={() => { void run(createInvitation) }}>
              {t(invitation !== null || state.invitation !== null ? 'regenerate' : 'generate')}
            </Button>
          </div>
        </div> : null}

      {state.devices.length > 0 ? <div className={css.card}>
        <h3 className={css.subheading}>{t('devices')}</h3>
        <ul className={css.list}>{state.devices.map(device => <li key={device.deviceId} className={css.device}>
          <div className={css.deviceText}><span>{device.name}</span><span className={css.help}>{t(device.connected ? 'connected' : 'paired')}</span></div>
          <Button variant="outline" disabled={blocked} onClick={() => { void run(() => revoke(device.deviceId), 'revoked') }}>{t('revoke')}</Button>
        </li>)}</ul>
      </div> : null}
    </> : null}
    <div className={css.feedback} aria-live="polite">
      {notice !== null ? <>
        <p className={notice.error ? css.error : css.help} role={notice.error ? 'alert' : 'status'}>{notice.text}</p>
        {notice.error ? <Button variant="outline" disabled={busy} onClick={refresh}>{t('retry')}</Button> : null}
      </> : null}
    </div>
  </section>
}

function PendingPanel({ request, blocked, t, approve, reject }: {
  request: MobilePairRequest
  blocked: boolean
  t: MobileSectionProps['t']
  approve: () => void
  reject: () => void
}) {
  return <div className={css.card}>
    <h3 className={css.subheading}>{t('confirmTitle', { device: request.deviceName })}</h3>
    <div className={css.codeRow}><span className={css.help}>{t('code')}</span><span className={css.code}>{request.verificationCode}</span></div>
    <p className={css.help}>{t('risk')}</p>
    <div className={css.actions}>
      <Button variant="primary" disabled={blocked} onClick={() => {
        if (blocked || request.expiresAt <= Date.now()) return
        approve()
      }}>{t('approve')}</Button>
      <Button variant="outline" disabled={blocked} onClick={() => {
        if (blocked || request.expiresAt <= Date.now()) return
        reject()
      }}>{t('reject')}</Button>
    </div>
  </div>
}
