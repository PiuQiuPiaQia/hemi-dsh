/** Shared subscription card for account actions, usage and model management. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, IconRefreshOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LoginState, QuotaWindow, Subscription } from '@deepseek-ai/dsh-hemi-model-access/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './copy.ts'
import { ModelPicker } from './ModelPicker.tsx'
import { ModelConnectionTest } from './ModelConnectionTest.tsx'
import type { ModelAccessActions, ModelTest } from './types.ts'
import css from './page.module.css'

type Props = PropsLocale<typeof NS> & { actions: ModelAccessActions }

/** Account-owned balance rows, already formatted by the account provider. */
export interface SubscriptionBalance {
  rows: { id: string; label: string; value: string }[]
  unavailable: boolean
  usageUrl?: string
}

/** Data and operations shared by every subscription card. */
export type SubscriptionCardProps = Props & {
  row: Subscription
  test: ModelTest
  pending: boolean
  attempt?: LoginState
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  modelsChanged: () => Promise<void>
  /** True while the selected model list loads; omitted means it is ready. */
  modelLoading?: boolean
  accountFailed?: boolean
  balance?: SubscriptionBalance
  refreshBalance?: () => Promise<void>
}

/** @param props - account facts and native account operations. @returns the shared subscription card. */
export function SubscriptionCard({ row, actions, test, t, pending, attempt, connect, disconnect, modelsChanged,
  balance, refreshBalance, accountFailed, modelLoading }: SubscriptionCardProps) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  async function change(run: () => Promise<void>): Promise<void> {
    setBusy(true)
    setFailed(false)
    try { await run() } catch { setFailed(true) } finally { setBusy(false) }
  }
  return <section className={css.card} aria-label={row.name}>
    <div className={css.subscriptionHeader}>
      <div className={css.subscriptionIdentity}>
        <div><strong>{row.name}</strong><p>{t(row.connected ? 'connected' : 'disconnected')}</p></div>
        {row.connected && row.quota && <Quota key={attempt?.id ?? row.id} provider={row.id} actions={actions} t={t} />}
        {row.connected && balance !== undefined && <div className={css.quotaInline}>
          <div className={css.quotaBars}>
            {balance.rows.map(value => <div className={css.balanceLine} key={value.id}>
              <span>{value.label}</span><span>{value.value}</span>
            </div>)}
            {balance.unavailable && <a href={balance.usageUrl} target="_blank" rel="noreferrer">{t('balanceUnavailable')}</a>}
          </div>
          {refreshBalance !== undefined && <UsageRefreshButton label={t('refreshBalance')} loading={busy}
            refresh={() => { void change(refreshBalance) }} />}
        </div>}
      </div>
      <div className={css.actions}>
        {row.connected && <ModelPicker current={row.models} t={t} iconOnly disabled={busy || pending || modelLoading === true}
          load={signal => actions.subscriptionCandidates(row.id, signal)}
          add={async (models) => {
            try { for (const model of models) await actions.changeSubscriptionModel(row.id, model, true) }
            finally { await modelsChanged() }
          }} />}
        <Button variant="outline" size="sm" disabled={busy || pending} onClick={() => { void change(connect) }}>
          {t(row.connected ? 'reconnect' : 'connect')}
        </Button>
        {row.connected && <Button variant="outline" size="sm" disabled={busy || pending}
          onClick={() => { void change(disconnect) }}>{t('disconnect')}</Button>}
      </div>
    </div>
    {row.connected && row.models.map(model => <ModelConnectionTest key={model} provider={row.id} model={model}
      test={test} t={t} actions={actions} saved={modelsChanged}
      remove={async () => {
        await actions.changeSubscriptionModel(row.id, model, false)
        await modelsChanged()
      }} />)}
    {row.connected && modelLoading && <p role="status">{t('loading')}</p>}
    {attempt !== undefined && (attempt.phase === 'pending'
      ? <LoginAttempt attempt={attempt} actions={actions} change={change} busy={busy} t={t} />
      : attempt.phase !== 'connected' && <p role="status">{t(attempt.phase === 'route-failed' ? 'routeFailed' : attempt.phase)}</p>)}
    {(failed || accountFailed) && <p role="alert">{t('failed')}</p>}
  </section>
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

function UsageRefreshButton({ label, loading, refresh }: { label: string; loading: boolean; refresh: () => void }) {
  return <Tooltip label={label}>
    <Button variant="ghost" size="sm" aria-label={label} aria-busy={loading}
      icon={<IconRefreshOutlineRegular size={14} />} disabled={loading} onClick={refresh} />
  </Tooltip>
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
      <UsageRefreshButton label={t('quota')} loading={loading} refresh={() => { void read() }} />
      {failed && <small role="status">{t('quotaUnavailable')}</small>}
    </div>
  )
}
