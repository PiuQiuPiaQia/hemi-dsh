import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LoginState, QuotaWindow, Subscription } from '@deepseek-ai/dsh-hemi-model-access/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './copy.ts'
import { ModelPicker } from './ModelPicker.tsx'
import { ModelConnectionTest } from './ModelConnectionTest.tsx'
import type { ModelAccessActions, ModelTest } from './types.ts'
import css from './page.module.css'

type Props = PropsLocale<typeof NS> & { actions: ModelAccessActions }
type SubscriptionProps = Props & { test: ModelTest }

export function SubscriptionSection({ actions, test, t }: SubscriptionProps) {
  const [subscriptions, setSubscriptions] = useState<Subscription[] | null>(null)
  const [attempt, setAttempt] = useState<LoginState | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    void Promise.all([actions.subscriptions(), actions.state()]).then(([rows, state]) => {
      if (!active) return
      setSubscriptions(rows)
      setAttempt(state)
    }, () => { if (active) setFailed(true) })
    return () => { active = false }
  }, [actions])

  const pendingId = attempt?.phase === 'pending' ? attempt.id : undefined
  useEffect(() => {
    if (pendingId === undefined) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    async function poll(): Promise<void> {
      try {
        const state = await actions.state()
        const rows = state?.phase !== 'pending' ? await actions.subscriptions() : undefined
        if (!active) return
        if (rows !== undefined) setSubscriptions(rows)
        setAttempt(state)
        setFailed(false)
        if (state?.phase === 'pending') timer = setTimeout(() => { void poll() }, 700)
      } catch {
        if (active) {
          setFailed(true)
          timer = setTimeout(() => { void poll() }, 1500)
        }
      }
    }
    timer = setTimeout(() => { void poll() }, 300)
    return () => { active = false; clearTimeout(timer) }
  }, [actions, pendingId])

  async function change(run: () => Promise<void>): Promise<void> {
    setBusy(true)
    setFailed(false)
    try { await run() } catch { setFailed(true) } finally { setBusy(false) }
  }

  return (
    <section className={css.section} aria-label={t('subscriptions')}>
      <h3>{t('subscriptions')}</h3>
      {subscriptions === null ? (!failed && <p>{t('loading')}</p>) : subscriptions.length === 0 ? <p>{t('empty')}</p> : null}
      {subscriptions?.map(row => (
        <section className={css.card} aria-label={row.name} key={row.id}>
          <div className={css.subscriptionHeader}>
            <div className={css.subscriptionIdentity}>
              <div><strong>{row.name}</strong><p>{t(row.connected ? 'connected' : 'disconnected')}</p></div>
              {row.connected && row.quota && <Quota key={attempt?.id ?? row.id} provider={row.id} actions={actions} t={t} />}
            </div>
            <div className={css.actions}>
              <Button variant="outline" size="sm" disabled={busy || pendingId !== undefined}
                onClick={() => { void change(async () => { setAttempt(await actions.start(row.id)) }) }}>
                {t(row.connected ? 'reconnect' : 'connect')}
              </Button>
              {row.connected && (
                <Button variant="outline" size="sm" disabled={busy || pendingId !== undefined}
                  onClick={() => {
                    if (!window.confirm(t('confirmDisconnect'))) return
                    void change(async () => {
                      await actions.disconnect(row.id)
                      setSubscriptions(await actions.subscriptions())
                      if (attempt?.provider === row.id) setAttempt(null)
                    })
                  }}>{t('disconnect')}</Button>
              )}
            </div>
          </div>
          {row.connected && row.models.map(model => (
            <ModelConnectionTest key={model} provider={row.id} model={model} test={test} t={t} actions={actions}
              saved={async () => { setSubscriptions(await actions.subscriptions()) }}
              remove={async () => {
                await actions.changeSubscriptionModel(row.id, model, false)
                setSubscriptions(await actions.subscriptions())
              }} />
          ))}
          {row.connected && <ModelPicker current={row.models} t={t}
            load={signal => actions.subscriptionCandidates(row.id, signal)}
            add={async (models) => {
              try {
                for (const model of models) await actions.changeSubscriptionModel(row.id, model, true)
              } finally {
                setSubscriptions(await actions.subscriptions())
              }
            }} />}
          {attempt?.provider === row.id && (
            attempt.phase === 'pending'
              ? <LoginAttempt attempt={attempt} actions={actions} change={change} busy={busy} t={t} />
              : attempt.phase !== 'connected' && (
                <p role="status">{t(attempt.phase === 'route-failed' ? 'routeFailed' : attempt.phase)}</p>
              )
          )}
        </section>
      ))}
      {failed && <p role="alert">{t('failed')}</p>}
    </section>
  )
}

function LoginAttempt({ attempt, actions, change, busy, t }: Props & {
  attempt: LoginState
  busy: boolean
  change: (run: () => Promise<void>) => Promise<void>
}) {
  return (
    <div className={css.form}>
      <p role="status">{t('pending')}</p>
      {attempt.url && <a href={attempt.url} target="_blank" rel="noreferrer">{t('openLogin')}</a>}
      {attempt.code && <p>{t('code')} <code>{attempt.code}</code></p>}
      {attempt.prompt && (
        <form className={css.form} key={attempt.prompt.id} onSubmit={(event) => {
          event.preventDefault()
          const value = new FormData(event.currentTarget).get('answer')
          const id = attempt.prompt?.id
          if (typeof value === 'string' && id !== undefined) {
            event.currentTarget.reset()
            void change(() => actions.answer(attempt.id, id, value))
          }
        }}>
          <label>
            {attempt.prompt.message}
            {attempt.prompt.options === undefined
              ? <input name="answer" type={attempt.prompt.kind === 'secret' ? 'password' : 'text'} autoComplete="off" />
              : <select name="answer">{attempt.prompt.options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select>}
          </label>
          <Button type="submit" variant="outline" size="sm" disabled={busy}>{t('answer')}</Button>
        </form>
      )}
      <Button variant="outline" size="sm" disabled={busy} onClick={() => { void change(() => actions.cancel(attempt.id)) }}>
        {t('cancel')}
      </Button>
    </div>
  )
}

function Quota({ actions, provider, t }: Props & { provider: string }) {
  const active = useRef<AbortController | null>(null)
  const [loading, setLoading] = useState(false)
  const [windows, setWindows] = useState<QuotaWindow[]>([])
  const [failed, setFailed] = useState(false)
  const read = useCallback(async (): Promise<void> => {
    active.current?.abort()
    const request = new AbortController()
    active.current = request
    setLoading(true)
    setFailed(false)
    try {
      const value = await actions.quota(provider, request.signal)
      if (!request.signal.aborted) setWindows(value)
    } catch {
      if (!request.signal.aborted) setFailed(true)
    } finally {
      if (!request.signal.aborted) setLoading(false)
    }
  }, [actions, provider])
  useEffect(() => {
    void read()
    return () => { active.current?.abort() }
  }, [read])
  const seconds = provider === 'bigmodel' ? [604800, 18000] : windows.map(window => window.seconds).sort((a, b) => b - a)
  return (
    <div className={css.quotaInline}>
      <div className={css.quotaBars}>
        {seconds.map((duration) => {
          const window = windows.find(item => item.seconds === duration)
          const label = duration === 604800 ? t('weeklyQuota') : duration === 18000 ? t('shortQuota') : t('quotaWindow', { hours: duration / 3600 })
          return (
            <div className={css.quotaLine} key={duration}
              title={window?.resetAt === undefined ? undefined : t('reset', { at: new Date(window.resetAt).toLocaleString() })}>
              <span>{label}</span>
              {window === undefined ? <span className={css.quotaTrack} aria-hidden="true" />
                : <progress max={100} value={window.remainingPercent} aria-label={label} />}
              <span>{window === undefined ? '—' : t('quotaPercent', { percent: Math.round(window.remainingPercent) })}</span>
            </div>
          )
        })}
      </div>
      <Button variant="ghost" size="sm" disabled={loading} onClick={() => { void read() }}>{t(loading ? 'loading' : 'quota')}</Button>
      {failed && <small role="status">{t('quotaUnavailable')}</small>}
    </div>
  )
}
