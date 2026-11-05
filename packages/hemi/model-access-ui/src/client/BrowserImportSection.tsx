import { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  BrowserImportAction, BrowserImportInput, BrowserImportResponse, BrowserImportState, BrowserSelection, NewApiDesktopBridge,
} from '@deepseek-ai/dsh-hemi-model-access/desktop-import'
import type { NS } from './copy.ts'
import css from './page.module.css'

type Props = PropsLocale<typeof NS> & { bridge: NewApiDesktopBridge }
type Pending = NonNullable<BrowserImportResponse['pending']>

function terminal(phase: string | undefined): boolean {
  return phase === undefined || ['success', 'cancelled', 'cleanup-pending'].includes(phase)
}

/** Desktop-only browser login, explicit import plan and transaction recovery. */
export function BrowserImportSection({ bridge, t }: Props) {
  const [state, setState] = useState<BrowserImportState | null>(null)
  const [pending, setPending] = useState<Pending>([])
  const [siteUrl, setSiteUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const isCurrent = (before: number): boolean => alive && generation.current === before
    async function poll(): Promise<void> {
      const before = generation.current
      try {
        const current = await bridge.invoke('getState')
        if (isCurrent(before)) {
          setState(current.state ?? null)
          if (terminal(current.state?.phase)) {
            const recoveries = await bridge.invoke('listPending')
            if (isCurrent(before)) setPending(recoveries.pending ?? [])
          }
        }
      } catch {
        if (alive) setError(t('failed'))
      }
      if (alive) timer = setTimeout(() => { void poll() }, 1000)
    }
    void poll()
    return () => { alive = false; clearTimeout(timer) }
  }, [bridge, t])

  async function command(action: BrowserImportAction, fields?: BrowserImportInput): Promise<boolean> {
    if (busy) return false
    generation.current += 1
    setBusy(true)
    setError('')
    try {
      const result = await bridge.invoke(action, {
        ...state === null ? {} : { operationId: state.operationId, revision: state.revision },
        ...fields,
      })
      if (result.state !== undefined) setState(result.state)
      if (!result.ok) setError(result.message ?? t('failed'))
      return result.ok
    } catch {
      setError(t('browserFailed'))
      return false
    } finally {
      generation.current += 1
      setBusy(false)
    }
  }

  return (
    <section className={css.section} aria-label={t('browserImport')}>
      <h3>{t('browserImport')}</h3>
      <div className={css.card}>
        {terminal(state?.phase) && (
          <form className={css.form} onSubmit={(event) => {
            event.preventDefault()
            void command('start', { siteUrl: siteUrl.trim() })
          }}>
            <label>{t('browserSite')}
              <input value={siteUrl} onChange={(event) => { setSiteUrl(event.currentTarget.value) }} autoComplete="url" />
            </label>
            <Button variant="outline" size="sm" type="submit" disabled={busy || siteUrl.trim() === ''}>{t('browserLogin')}</Button>
          </form>
        )}
        {state?.accountLabel && <p>{state.accountLabel}</p>}
        {state?.phase === 'login' && <p>{t('browserLoginHelp')}</p>}
        {state?.phase === 'login' && (
          <div className={css.actions}>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => { void command('showBrowser') }}>{t('browserLogin')}</Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => { void command('checkLogin') }}>{t('checkBrowserLogin')}</Button>
          </div>
        )}
        {state?.phase === 'selecting' && <SelectionForm key={state.operationId} state={state} t={t} busy={busy} command={command} />}
        {state?.progress && <p role="status">{state.progress}</p>}
        {state?.tokenName && <p>{t('createdToken', { token: state.tokenName })}</p>}
        {state?.validation?.map(item => (
          <p key={JSON.stringify([item.modelName, item.api])}>{item.modelName} · {item.ok === true ? t('passed') : item.code ?? t('failed')}</p>
        ))}
        {state?.phase === 'success' && <p role="status">{t('imported', { count: state.result?.modelKeys.length ?? 0 })}</p>}
        {state?.cleanupPending && <p role="alert">{t('cleanupPending')}</p>}
        {error || state?.error?.message ? <p role="alert">{error || state?.error?.message}</p> : null}
        <div className={css.actions}>
          {state?.can?.pause && <Button variant="outline" size="sm" disabled={busy} onClick={() => { void command('pause') }}>{t('pauseImport')}</Button>}
          {state?.can?.resume && <Button variant="outline" size="sm" disabled={busy} onClick={() => { void command('resume') }}>{t('resumeImport')}</Button>}
          {state?.can?.retry && (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => {
              const target = state.error?.retryTarget
              if (target !== undefined) void command('retry', { target })
            }}>{t('retryImport')}</Button>
          )}
          {state?.can?.cancel && <Button variant="outline" size="sm" disabled={busy} onClick={() => { void command('cancel') }}>{t('cancel')}</Button>}
        </div>
        {terminal(state?.phase) && pending.length > 0 && (
          <div className={css.form}>
            <strong>{t('pendingImports')}</strong>
            {pending.map(item => (
              <div className={css.row} key={item.operationId}>
                <span>{item.siteOrigin ?? item.operationId}</span>
                <Button variant="outline" size="sm" disabled={!item.readable || busy}
                  onClick={() => { void command('resumePending', { operationId: item.operationId }) }}>{t('resumeImport')}</Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

function SelectionForm({ state, t, busy, command }: Omit<Props, 'bridge'> & {
  state: BrowserImportState
  busy: boolean
  command: (action: BrowserImportAction, fields?: BrowserImportInput) => Promise<boolean>
}) {
  const [group, setGroup] = useState(state.selection?.group ?? state.candidatesGroup ?? '')
  const [selected, setSelected] = useState(() => new Map(state.selection?.models.map(model => [model.modelName, model.api])))
  const [budget, setBudget] = useState(state.selection?.budgetUsd?.toString() ?? '')
  const [days, setDays] = useState(state.selection?.expiryDays?.toString() ?? '')
  const [dirty, setDirty] = useState(false)
  const selection: BrowserSelection = {
    group, models: [...selected].map(([modelName, api]) => ({ modelName, api })),
    ...(budget === '' ? { budgetMode: 'unlimited' } : { budgetMode: 'usd', budgetUsd: Number(budget) }),
    ...(days === '' ? { expiryMode: 'never' } : { expiryMode: 'days', expiryDays: Number(days) }),
  }
  return (
    <form className={css.form} onSubmit={(event) => {
      event.preventDefault()
      void command('setSelection', { selection }).then((saved) => { if (saved) setDirty(false) })
    }}>
      <label>{t('group')}
        <select value={group} disabled={busy} onChange={(event) => {
          const next = event.currentTarget.value
          setGroup(next)
          setSelected(new Map())
          setDirty(true)
          if (next !== '') void command('setSelection', { selection: { ...selection, group: next, models: [] } })
        }}>
          <option value="">{t('choose')}</option>
          {state.groups.map(item => <option value={item.name} key={item.name}>{item.desc ? `${item.name} · ${item.desc}` : item.name}</option>)}
        </select>
      </label>
      {state.candidatesGroup === group && state.candidates.length > 0 && (
        <div className={css.candidates}>
          {state.candidates.filter(model => model.apis.length > 0).map(model => (
            <label key={model.modelName}>{model.modelName}
              <select disabled={busy} value={selected.get(model.modelName) ?? ''} onChange={(event) => {
                const copy = new Map(selected)
                const api = event.currentTarget.value
                if (api === '') copy.delete(model.modelName)
                else copy.set(model.modelName, api)
                setSelected(copy)
                setDirty(true)
              }}>
                <option value="">{t('skipModel')}</option>
                {model.apis.map(api => <option key={api} value={api}>{api}</option>)}
              </select>
            </label>
          ))}
        </div>
      )}
      <label>{t('budget')}<input type="number" min="0.01" max="10000" step="0.01" disabled={busy} value={budget}
        onChange={(event) => { setBudget(event.currentTarget.value); setDirty(true) }} /></label>
      <label>{t('expiry')}<input type="number" min="1" max="3650" disabled={busy} value={days}
        onChange={(event) => { setDays(event.currentTarget.value); setDirty(true) }} /></label>
      <Button variant="outline" size="sm" type="submit" disabled={busy || selection.models.length === 0}>{t('preview')}</Button>
      {!dirty && state.preview && (
        <div className={css.form}>
          {state.preview.providers.map(provider => <p key={provider.api}>{provider.name} · {provider.models.join(', ')}</p>)}
          <Button variant="outline" size="sm" type="button" disabled={busy}
            onClick={() => { if (state.preview) void command('submit', { planHash: state.preview.planHash }) }}>{t('createAndImport')}</Button>
        </div>
      )}
    </form>
  )
}
