import { useEffect, useState } from 'react'
import type { LoginState, Subscription } from '@deepseek-ai/dsh-hemi-model-access/types'
import type { PropsLocale, PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './copy.ts'
import { SubscriptionCard } from './SubscriptionCard.tsx'
import { DeepSeekSubscription } from './DeepSeekSubscription.tsx'
import type { ModelAccessActions, ModelTest } from './types.ts'
import css from './page.module.css'

type Props = PropsLocale<typeof NS> & { actions: ModelAccessActions }
type SubscriptionProps = Props & PropsRenderFactories & { test: ModelTest }

export function SubscriptionSection({ actions, test, t, renderFactorySlot }: SubscriptionProps) {
  const [subscriptions, setSubscriptions] = useState<Subscription[] | null>(null)
  const [attempt, setAttempt] = useState<LoginState | null>(null)
  const [failed, setFailed] = useState(false)

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

  return (
    <section className={css.section} aria-label={t('subscriptions')}>
      <h3>{t('subscriptions')}</h3>
      {renderFactorySlot('account.connection', { title: t('deepseekAccount') }, { slots: { content: DeepSeekSubscription } })}
      {subscriptions === null ? (!failed && <p>{t('loading')}</p>) : subscriptions.length === 0 ? <p>{t('empty')}</p> : null}
      {subscriptions?.map(row => (
        <SubscriptionCard key={row.id} row={row} actions={actions} test={test} t={t} pending={pendingId !== undefined}
          {...attempt?.provider === row.id ? { attempt } : {}}
          connect={async () => { setAttempt(await actions.start(row.id)) }}
          disconnect={async () => {
            if (!window.confirm(t('confirmDisconnect'))) return
            await actions.disconnect(row.id)
            setSubscriptions(await actions.subscriptions())
            if (attempt?.provider === row.id) setAttempt(null)
          }}
          modelsChanged={async () => { setSubscriptions(await actions.subscriptions()) }} />
      ))}
      {failed && <p role="alert">{t('failed')}</p>}
    </section>
  )
}
