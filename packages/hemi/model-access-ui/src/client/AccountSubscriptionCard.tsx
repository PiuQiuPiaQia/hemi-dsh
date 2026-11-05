/** Native account model discovery feeding the common subscription card. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import { SubscriptionCard } from './SubscriptionCard.tsx'
import type { SubscriptionBalance } from './SubscriptionCard.tsx'

/** Native account facts and operations supplied by the account presentation factory. */
export interface AccountSubscriptionInput {
  title: string
  connected: boolean
  pending: boolean
  identity: string
  failed: boolean
  balance: SubscriptionBalance
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  refreshBalance: () => Promise<void>
}

/** @param props - account facts and model service actions. @returns the shared card with the native model catalog. */
export function AccountSubscriptionCard({ title, connected, pending, identity, failed, balance, connect, disconnect,
  refreshBalance, actions, test, t }: FactoryComponentPropsOf<'hemi.models.account-subscription'>) {
  const active = useRef<AbortController | null>(null)
  const [catalog, setCatalog] = useState<{ identity: string; models: string[]; loading: boolean; failed: boolean } | null>(null)
  const read = useCallback(async (): Promise<void> => {
    active.current?.abort()
    const request = new AbortController()
    active.current = request
    setCatalog(previous => ({ identity, models: previous?.identity === identity ? previous.models : [], loading: true, failed: false }))
    try {
      const models = await actions.subscriptionModels('deepseek-account', request.signal)
      if (!request.signal.aborted) setCatalog({ identity, models, loading: false, failed: false })
    } catch {
      if (!request.signal.aborted) setCatalog({ identity, models: [], loading: false, failed: true })
    }
  }, [actions, identity])
  useEffect(() => {
    if (connected) void read()
    return () => { active.current?.abort() }
  }, [connected, read])
  const current = catalog?.identity === identity ? catalog : null
  return <SubscriptionCard row={{ id: 'deepseek-account', name: title, connected, quota: false, models: current?.models ?? [] }}
    actions={actions} test={test} t={t} pending={pending} connect={connect} disconnect={disconnect}
    balance={balance} refreshBalance={refreshBalance} accountFailed={failed || current?.failed === true} modelsChanged={read}
    modelLoading={current?.loading ?? connected} />
}
