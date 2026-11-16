/** VVCode usage reads are scoped to one authorization and retain data only on safe refresh failures. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { VvcodeUsage } from '@deepseek-ai/dsh-hemi-model-access/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './copy.ts'
import type { SubscriptionCardProps, SubscriptionBalance } from './SubscriptionCard.tsx'

type Snapshot = {
  identity: string
  value?: VvcodeUsage
  latest?: VvcodeUsage
  loading: boolean
  failed: boolean
  blocked: boolean
}

/**
 * Read usage for the current authorization; expiry, sign-out and a new login discard prior account values.
 * @param props - Current account facts, authorization attempt and cancellable usage action.
 * @returns Formatted data and refresh operation for the existing inline balance presentation.
 */
export function useVvcodeUsage(props: SubscriptionCardProps): {
  balance?: SubscriptionBalance
  refreshBalance?: () => Promise<void>
} {
  const { row, attempt, actions, modelsChanged, t } = props
  const authorized = row.connected && row.vvcode?.expired !== true && attempt?.phase !== 'pending'
  const identity = `${authorized}/${row.vvcode?.expiresAt ?? ''}/${attempt?.id ?? ''}/${attempt?.phase ?? ''}`
  const [snapshot, setSnapshot] = useState<Snapshot>({ identity, loading: true, failed: false, blocked: false })
  const active = useRef<AbortController | null>(null)
  const read = useCallback(async (): Promise<void> => {
    if (!authorized) {
      setSnapshot({ identity, loading: false, failed: false, blocked: false })
      return
    }
    active.current?.abort()
    const request = new AbortController()
    active.current = request
    setSnapshot(old => ({ ...(old.identity === identity ? old : { identity, blocked: false }), loading: true, failed: false }))
    try {
      const value = await actions.vvcodeUsage(request.signal)
      if (request.signal.aborted) return
      setSnapshot((old) => {
        const previous = old.identity === identity && old.value?.unit.kind === value.unit.kind
          && old.value.unit.symbol === value.unit.symbol ? old.value : undefined
        return { identity, loading: false, failed: false, blocked: false, latest: value,
          value: { ...value,
            balance: value.balance.state === 'unavailable' && previous !== undefined ? previous.balance : value.balance,
            subscriptions: value.subscriptions.state === 'unavailable' && previous !== undefined ? previous.subscriptions : value.subscriptions,
          } }
      })
    } catch (error: unknown) {
      if (request.signal.aborted) return
      const blocked = typeof error === 'object' && error !== null && 'code' in error
        && (error.code === 'hemi/vvcode-management-auth-expired' || (error.code === 'hemi/vvcode-failed'
          && 'details' in error && typeof error.details === 'object' && error.details !== null && 'reason' in error.details
          && (error.details.reason === 'sign-in-required' || error.details.reason === 'account-changed')))
      setSnapshot(old => blocked ? { identity, loading: false, failed: true, blocked: true }
        : { ...old, identity, loading: false, failed: true })
      if (blocked) {
        try { await modelsChanged() } catch (_refreshError: unknown) {
          // Authorization remains blocked even when current account facts cannot be refreshed.
        }
      }
    } finally {
      if (active.current === request) active.current = null
    }
  }, [actions, authorized, identity, modelsChanged])
  useEffect(() => {
    void read()
    return () => { active.current?.abort() }
  }, [read])

  if (!authorized) return {}
  if (snapshot.identity === identity && snapshot.blocked) return {
    balance: { rows: [], unavailable: false, notices: [{ id: 'expired', text: t('vvcodeExpired'), failed: true }] },
  }
  const current = snapshot.identity === identity ? snapshot : undefined
  const balance = formatUsage(current?.value, current?.latest, current?.failed === true, t)
  balance.loading = current?.loading ?? true
  if (current?.failed) balance.notices?.push({ id: 'refresh-failed', text: t('vvcodeUsageFailed'), failed: true })
  return { balance, refreshBalance: read }
}

function formatUsage(value: VvcodeUsage | undefined, latest: VvcodeUsage | undefined, failed: boolean,
  t: PropsLocale<typeof NS>['t']): SubscriptionBalance {
  const rows: SubscriptionBalance['rows'] = []
  const notices: NonNullable<SubscriptionBalance['notices']> = []
  if (value === undefined) rows.push({ id: 'balance', label: t('vvcodeBalance'), value: '—' })
  else {
    const unit = value.unit
    const amount = (amount: number | null): string => amount === null ? t('vvcodeUnlimited') : valueWithUnit(amount)
    function valueWithUnit(amount: number): string {
      const number = amount.toLocaleString(undefined, { maximumFractionDigits: unit.kind === 'tokens' ? 0 : Math.abs(amount) < 0.01 ? 6 : 2 })
      return unit.kind === 'currency' ? `${unit.symbol}${number}` : `${number} ${unit.symbol}`
    }
    if (value.balance.state === 'ready') rows.push({ id: 'balance', label: t('vvcodeBalance'), value: valueWithUnit(value.balance.remaining) })
    if (value.subscriptions.state === 'ready') {
      const items = value.subscriptions.items.filter(item => item.expiresAt > Date.now())
      if (items.length === 0) {
        if (!failed && latest?.subscriptions.state === 'ready') notices.push({ id: 'empty', text: t('vvcodeNoSubscriptions') })
        else if (latest?.subscriptions.state !== 'unavailable') notices.push({ id: 'expired-cache', text: t('vvcodeSubscriptionsUnavailable'), failed: true })
      }
      for (const item of items) rows.push({ id: `subscription-${item.id}`,
        label: t('vvcodeSubscription', { id: item.id }),
        value: t('vvcodeSubscriptionQuota', { remaining: amount(item.remaining), total: amount(item.total) }),
        detail: t('vvcodeExpires', { at: new Date(item.expiresAt).toLocaleString() }),
      })
    }
  }
  if (latest?.balance.state === 'unavailable') notices.push({ id: 'balance-unavailable', text: t('vvcodeBalanceUnavailable'), failed: true })
  if (latest?.subscriptions.state === 'unavailable') notices.push({ id: 'subscriptions-unavailable', text: t('vvcodeSubscriptionsUnavailable'), failed: true })
  if (value?.subscriptions.state === 'reauthorize') notices.push({ id: 'reauthorize', text: t('vvcodeUsageReauthorize') })
  return { rows, notices, unavailable: false }
}
