/** Shared subscription card for account actions, usage and model management. */
import { useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LoginState, Subscription } from '@deepseek-ai/dsh-hemi-model-access/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './copy.ts'
import { ProviderCardContent } from './ProviderCardContent.tsx'
import type { SubscriptionBalance } from './ProviderUsage.tsx'
export type { SubscriptionBalance } from './ProviderUsage.tsx'
import type { ModelAccessActions, ModelTest } from './types.ts'
import css from './page.module.css'

type Props = PropsLocale<typeof NS> & { actions: ModelAccessActions }

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
    <ProviderCardContent provider={row.id} name={row.name} description={t(row.connected ? 'connected' : 'disconnected')}
      models={row.connected ? row.models : []} actions={actions} test={test} t={t} saved={modelsChanged}
      modelLoading={row.connected && modelLoading === true}
      remove={async (model) => {
        await actions.changeSubscriptionModel(row.id, model, false)
        await modelsChanged()
      }}
      {...row.connected ? {
        discovery: {
          disabled: busy || pending || modelLoading === true,
          load: (signal: AbortSignal) => actions.subscriptionCandidates(row.id, signal),
          add: async (models: string[]) => {
            try { for (const model of models) await actions.changeSubscriptionModel(row.id, model, true) }
            finally { await modelsChanged() }
          },
        },
        usage: {
          actions, t, busy,
          ...row.quota ? { quota: { provider: row.id, identity: attempt?.id ?? row.id } } : {},
          ...balance === undefined ? {} : { balance },
          ...refreshBalance === undefined ? {} : { refreshBalance: () => { void change(refreshBalance) } },
        },
      } : {}}
      buttons={[
        { id: 'connect', label: t(row.connected ? 'reconnect' : 'connect'), disabled: busy || pending,
          run: () => { void change(connect) } },
        ...row.connected ? [{ id: 'disconnect', label: t('disconnect'), disabled: busy || pending,
          run: () => { void change(disconnect) } }] : [],
      ]} />
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
              ? <Input className={css.input ?? ''} name="answer" type={attempt.prompt.kind === 'secret' ? 'password' : 'text'} autoComplete="off" />
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
