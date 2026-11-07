/** Inline provider quota and balance presentation. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, IconRefreshOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { QuotaWindow } from '@deepseek-ai/dsh-hemi-model-access/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './copy.ts'
import type { ModelAccessActions } from './types.ts'
import css from './page.module.css'

type Props = PropsLocale<typeof NS> & { actions: ModelAccessActions }

/** Account-owned balance rows, already formatted by the account provider. */
export interface SubscriptionBalance {
  rows: { id: string; label: string; value: string }[]
  unavailable: boolean
  usageUrl?: string
}

/** Optional usage facts and refresh operations for a provider header. */
export type ProviderUsageProps = Props & {
  quota?: { provider: string; identity: string }
  balance?: SubscriptionBalance
  refreshBalance?: () => void
  busy: boolean
}

/** @param props - Quota identity, formatted balances and refresh callbacks. @returns inline provider usage. */
export function ProviderUsage({ quota, balance, refreshBalance, busy, actions, t }: ProviderUsageProps) {
  return <>
    {quota !== undefined && <Quota key={quota.identity} provider={quota.provider} actions={actions} t={t} />}
    {balance !== undefined && <div className={css.quotaInline}>
      <div className={css.quotaBars}>
        {balance.rows.map(value => <div className={css.balanceLine} key={value.id}>
          <span>{value.label}</span><span>{value.value}</span>
        </div>)}
        {balance.unavailable && <a href={balance.usageUrl} target="_blank" rel="noreferrer">{t('balanceUnavailable')}</a>}
      </div>
      {refreshBalance !== undefined && <UsageRefreshButton label={t('refreshBalance')} loading={busy} refresh={refreshBalance} />}
    </div>}
  </>
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
