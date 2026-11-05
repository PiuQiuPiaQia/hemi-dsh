/** Adapt the native account state and actions for the shared Hemi subscription card. */
import { useCallback } from 'react'
import type { FactoryLocalComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-account/client'
import type { SubscriptionBalance } from './SubscriptionCard.tsx'

type Props = FactoryLocalComponentPropsOf<'account.connection', 'content'>

/** @param props - native account state and operations. @returns the common Hemi subscription presentation. */
export function DeepSeekSubscription({
  title, useAccount, start, signOut, hasRunningAccountTasks, refreshAccount, formatBalance, renderFactorySlot, t,
}: Props) {
  const account = useAccount(value => value)
  const connected = account.view?.status === 'credential-stored'
  const attempt = account.view?.attempt
  const pending = attempt !== null && attempt !== undefined
    && ['initializing', 'waiting-browser', 'exchanging', 'committing'].includes(attempt.phase)
  const balance = account.details?.balance
  const disconnect = useCallback(async (): Promise<void> => {
    let running: boolean | 'unknown'
    try { running = await hasRunningAccountTasks() } catch { running = 'unknown' }
    if (window.confirm(t(running === 'unknown' ? 'signOutUnknownDescription' : running ? 'signOutRunningDescription' : 'signOutDescription'))) {
      await signOut()
    }
  }, [hasRunningAccountTasks, signOut, t])
  const rows: SubscriptionBalance['rows'] = []
  if (balance?.status === 'ready') {
    if (balance.value.length > 0) rows.push({ id: 'balance', label: t('balance'),
      value: balance.value.map(wallet => formatBalance(wallet.balance, wallet.currency === 'CNY' ? '¥' : '$')).join(' · ') })
    if (balance.bonusWallets.length > 0) rows.push({ id: 'bonus', label: t('bonusBalance'),
      value: balance.bonusWallets.map(wallet => formatBalance(wallet.balance, wallet.currency === 'CNY' ? '¥' : '$')).join(' · ') })
  } else if (balance === undefined) rows.push({ id: 'balance', label: t('balance'), value: t('loading') })
  const profile = account.details?.profile
  return renderFactorySlot('hemi.models.account-subscription', {
    title: title ?? '', connected, pending: pending || account.view === undefined,
    identity: `${attempt?.id ?? ''}/${profile?.status === 'ready' ? profile.value.id ?? '' : ''}`,
    failed: account.failed || account.loginFailed === true || attempt?.phase === 'failed',
    balance: { rows, unavailable: balance !== undefined && rows.length === 0,
      ...account.view === undefined ? {} : { usageUrl: account.view.links.usageUrl } },
    connect: start, disconnect, refreshBalance: refreshAccount,
  })
}
