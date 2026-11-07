/** Desktop New API sign-in, token creation and recovery in one retained dialog. */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  BrowserImportAction, BrowserImportInput, BrowserImportResponse, BrowserImportState, NewApiDesktopBridge,
} from '@deepseek-ai/dsh-hemi-model-access/desktop-import'
import type { NS } from './copy.ts'
import css from './page.module.css'
import picker from './ModelPicker.module.css'

type Props = PropsLocale<typeof NS> & {
  bridge: NewApiDesktopBridge
  open: boolean
  onClose: () => void
  onImported: () => void
}
type Pending = NonNullable<BrowserImportResponse['pending']>
type ImportCommand = BrowserImportAction | 'importSelected'
type SelectionDraft = {
  operationId: string
  group: string
  models: string[]
  budget: string
  days: string
}
const steps = ['newApiStepLogin', 'newApiStepModels', 'newApiStepToken'] as const

function terminal(phase: string | undefined): boolean {
  return phase === undefined || ['success', 'cancelled', 'cleanup-pending'].includes(phase)
}

/**
 * Closing hides the dialog without cancelling the native transaction or discarding drafts.
 * @param props - Native commands, localized copy, visibility and completion callbacks.
 * @returns the guided sign-in, selection and token import dialog.
 */
export function BrowserImportSection({ bridge, t, open, onClose, onImported }: Props) {
  const [state, setState] = useState<BrowserImportState | null>(null)
  const [pending, setPending] = useState<Pending>([])
  const [siteAddress, setSiteAddress] = useState('')
  const [siteProtocol, setSiteProtocol] = useState<'https' | 'http'>('https')
  const siteAddressId = useId()
  const [draft, setDraft] = useState<SelectionDraft | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [statusUnavailable, setStatusUnavailable] = useState(false)
  const generation = useRef(0)
  // The coordinator retains its last success after the dialog dismisses it.
  const trackedOperation = useRef<string | null>(null)
  const completed = useRef<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const publish = useCallback((next: BrowserImportState | null, fromCommand = false): void => {
    if (next?.phase === 'success' && !fromCommand && trackedOperation.current !== next.operationId) {
      trackedOperation.current = null
      setState(null)
      return
    }
    trackedOperation.current = next?.operationId ?? null
    setState(next)
    if (next?.phase === 'success' && completed.current !== next.operationId) {
      completed.current = next.operationId
      onImported()
    }
  }, [onImported])
  const observing = open || state !== null && !terminal(state.phase)
  useEffect(() => {
    if (!observing) return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const isCurrent = (before: number): boolean => alive && generation.current === before
    async function poll(): Promise<void> {
      const before = generation.current
      try {
        const current = await bridge.invoke('getState')
        if (isCurrent(before)) {
          publish(current.state ?? null)
          setLoaded(true)
          if (terminal(current.state?.phase)) {
            const recoveries = await bridge.invoke('listPending')
            if (isCurrent(before)) setPending(recoveries.pending ?? [])
          }
          if (isCurrent(before)) setStatusUnavailable(false)
        }
      } catch {
        if (isCurrent(before)) setStatusUnavailable(true)
      }
      if (alive) timer = setTimeout(() => { void poll() }, 1000)
    }
    void poll()
    return () => { alive = false; clearTimeout(timer) }
  }, [bridge, observing, publish])

  async function command(action: ImportCommand, fields?: BrowserImportInput): Promise<void> {
    if (busy) return
    generation.current += 1
    setBusy(true)
    setError('')
    try {
      let result = await bridge.invoke(action === 'importSelected' ? 'setSelection' : action, {
        ...state === null || action === 'getState' ? {} : { operationId: state.operationId, revision: state.revision },
        ...fields,
      })
      if (action === 'importSelected' && result.ok) {
        const prepared = result.state
        if (prepared?.preview == null) {
          if (mounted.current) setError(t('browserImportStartFailed'))
          return
        }
        result = await bridge.invoke('submit', {
          operationId: prepared.operationId,
          revision: prepared.revision,
          planHash: prepared.preview.planHash,
        })
      }
      if (!mounted.current) return
      if (result.state !== undefined) {
        publish(result.state, action !== 'getState')
        setLoaded(true)
      }
      if (!result.ok) setError(result.code === 'LOGIN_REQUIRED' ? t('browserLoginRequired')
        : result.code === 'CATALOG_UNAVAILABLE' ? t('fetchModelsFailed') : result.message ?? t('failed'))
      if (result.ok && action === 'getState') setStatusUnavailable(false)
    } catch {
      if (mounted.current) {
        if (action === 'getState') setStatusUnavailable(true)
        else if (action === 'setSelection') setError(t('fetchModelsFailed'))
        else if (action === 'importSelected') setError(t('browserImportStartFailed'))
        else setError(t('browserFailed'))
      }
    } finally {
      generation.current += 1
      if (mounted.current) setBusy(false)
    }
  }

  function closeDialog(): void {
    if (state?.phase === 'success') {
      trackedOperation.current = null
      setState(null)
      setDraft(null)
      setSiteAddress('')
      setSiteProtocol('https')
      setError('')
      setStatusUnavailable(false)
    }
    onClose()
  }

  const phase = state?.phase === 'failed' ? state.error?.retryTarget : state?.phase
  const step = phase === undefined || ['opening', 'login'].includes(phase) ? 0 : ['discovering', 'selecting'].includes(phase) ? 1 : 2
  const login = state?.phase === 'login' ? state : null
  const showStart = terminal(state?.phase) && state?.phase !== 'success'
  const stateError = state?.error?.code === 'OPEN_SITE' ? t('browserOpenFailed') : state?.error?.message
  const errorMessage = error || stateError || (statusUnavailable ? t('browserStatusFailed') : '')
  const status = state?.control === 'paused' ? 'browserPaused'
    : state?.phase === 'cancelling' ? 'browserCancelling'
      : state?.phase === 'opening' ? 'browserStarting'
        : state?.phase === 'discovering' ? 'browserPreparing'
          : state !== null && !terminal(state.phase) && !['login', 'selecting', 'failed'].includes(state.phase) ? 'browserCreating' : null
  const selectionDraft: SelectionDraft | null = state?.phase !== 'selecting' ? null
    : draft?.operationId === state.operationId ? draft : {
      operationId: state.operationId,
      group: state.selection?.group ?? state.candidatesGroup ?? (state.groups.length === 1 ? state.groups[0]?.name ?? '' : ''),
      models: state.selection?.models.map(model => model.modelName) ?? [],
      budget: state.selection?.budgetUsd?.toString() ?? '',
      days: state.selection?.expiryDays?.toString() ?? '',
    }

  const progress = <ol className={css.importSteps} aria-label={t('newApiSetup')}>
    {steps.map((label, index) => <li key={label} aria-current={index === step ? 'step' : undefined}
      data-complete={state?.phase === 'success' || index < step}>{t(label)}</li>)}
  </ol>
  const alert = errorMessage && <p role="alert">{errorMessage}
    {statusUnavailable && !error && !stateError && <Button variant="ghost" size="sm" disabled={busy}
      onClick={() => { void command('getState') }}>{t('retryImport')}</Button>}
  </p>

  return (
    <>
      {!open && (state !== null || errorMessage) && <p className={css.importSummary}
        role={errorMessage || state?.cleanupPending ? 'alert' : 'status'}>
        {state?.cleanupPending ? t('cleanupPending') : errorMessage
          || (state?.phase === 'success' ? t('imported', { count: state.result?.modelKeys.length ?? 0 })
            : state?.phase === 'cancelled' ? t('browserCancelled') : t(status ?? 'newApiClosedProgress'))}
      </p>}
      <Modal open={open} title={t('newApiSetup')} onClose={closeDialog}
        {...login === null ? { closeLabel: t('close') } : { headless: true }}
        className={(login === null ? css.importDialog : css.loginDialog) ?? ''} contentClassName={`${css.importContent} scrollable`}
        footer={<Button variant="outline" onClick={closeDialog}>{t(state?.phase === 'success' ? 'done' : 'close')}</Button>}>
        {login !== null ? (
          <section className={css.loginBody} aria-label={t('browserImport')}>
            <header className={css.loginHeader}>
              <h2>{t('newApiSetup')}</h2>
              {progress}
              <p>{login.siteOrigin}{login.accountLabel ? ` · ${login.accountLabel}` : ''}</p>
              <p>{t('browserLoginHelp')}</p>
            </header>
            <LoginViewport bridge={bridge} t={t} operationId={login.operationId} loading={login.siteLoading === true} />
            <footer className={css.loginFooter}>
              {alert}
              {login.siteNavigationBlocked && <p role="status">{t('browserNavigationBlocked')}</p>}
              <div className={css.actions}>
                <Button variant="primary" disabled={busy || login.siteLoading === true} aria-busy={busy}
                  onClick={() => { void command('checkLogin') }}>{t(busy ? 'browserChecking' : 'checkBrowserLogin')}</Button>
                <Button variant="outline" onClick={closeDialog}>{t('close')}</Button>
                {login.can?.cancel && <Button variant="ghost" disabled={busy}
                  onClick={() => { void command('cancel') }}>{t('cancel')}</Button>}
              </div>
            </footer>
          </section>
        ) : <section className={css.importBody} aria-label={t('browserImport')}>
          {progress}
          {!loaded && !errorMessage && <p role="status">{t('loading')}</p>}
          {state !== null && <p>{state.siteOrigin}{state.accountLabel ? ` · ${state.accountLabel}` : ''}</p>}
          {status !== null && <p role="status">{t(status)}</p>}
          {state?.phase === 'selecting' && selectionDraft !== null
          && <SelectionForm state={state} t={t} busy={busy} command={command} draft={selectionDraft} change={setDraft} />}
          {state?.tokenName && <p>{t('createdToken', { token: state.tokenName })}</p>}
          {state?.validation?.map(item => (
            <p key={JSON.stringify([item.modelName, item.api])}>{item.modelName} · {item.ok === true ? t('passed') : item.code ?? t('failed')}</p>
          ))}
          {state?.phase === 'success' && <p role="status">{t('imported', { count: state.result?.modelKeys.length ?? 0 })}</p>}
          {state?.phase === 'cancelled' && <p role="status">{t('browserCancelled')}</p>}
          {state?.cleanupPending && <p role="alert">{t('cleanupPending')}</p>}
          {alert}
          {state?.phase === 'failed' && state.siteNavigationBlocked && <p>{t('browserNavigationBlocked')}</p>}
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
          {showStart && pending.length > 0 && (
            <div className={css.dialogForm}>
              <h3>{t('pendingImports')}</h3>
              {pending.map(item => (
                <div className={css.row} key={item.operationId}>
                  <span>{item.siteOrigin ?? item.operationId}</span>
                  <Button variant="outline" size="sm" disabled={!item.readable || busy}
                    onClick={() => { void command('resumePending', { operationId: item.operationId }) }}>{t('resumeImport')}</Button>
                </div>
              ))}
            </div>
          )}
          {showStart && (
            <form className={css.dialogForm} onSubmit={(event) => {
              event.preventDefault()
              if (siteAddress.trim() !== '') void command('start', { siteUrl: `${siteProtocol}://${siteAddress.trim()}` })
            }}>
              <label htmlFor={siteAddressId}>{t('browserSite')}</label>
              <div className={css.siteFields}>
                <select aria-label={t('siteProtocol')} value={siteProtocol} disabled={!loaded || busy}
                  onChange={(event) => { setSiteProtocol(event.currentTarget.value === 'http' ? 'http' : 'https') }}>
                  <option value="https">{t('siteHttps')}</option>
                  <option value="http">{t('siteHttp')}</option>
                </select>
                <Input id={siteAddressId} className={css.input ?? ''} inputMode="url" value={siteAddress}
                  disabled={!loaded || busy} autoComplete="url" onChange={(event) => {
                    const value = event.currentTarget.value
                    const prefix = /^\s*(https?):\/\//i.exec(value)
                    if (prefix !== null) setSiteProtocol(prefix[1]?.toLowerCase() === 'http' ? 'http' : 'https')
                    setSiteAddress(prefix === null ? value : value.slice(prefix[0].length))
                  }} />
              </div>
              {siteProtocol === 'http' && <p>{t('insecureSite')}</p>}
              <Button variant="outline" size="sm" type="submit" disabled={!loaded || busy || siteAddress.trim() === ''}>
                {t('browserLogin')}
              </Button>
            </form>
          )}
        </section>}
      </Modal>
    </>
  )
}

function LoginViewport({ bridge, t, operationId, loading }: PropsLocale<typeof NS> & {
  bridge: NewApiDesktopBridge
  operationId: string
  loading: boolean
}) {
  const viewport = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const element = viewport.current
    if (element === null) return
    let active = true
    const update = () => {
      const { x, y, width, height } = element.getBoundingClientRect()
      const bounds = width > 0 && height > 0 ? { x, y, width, height } : null
      void bridge.invoke('setBrowserBounds', { operationId, bounds }).catch(() => {
        if (active) setFailed(true)
      })
    }
    const observer = new ResizeObserver(update)
    observer.observe(element)
    window.addEventListener('resize', update)
    update()
    return () => {
      active = false
      observer.disconnect()
      window.removeEventListener('resize', update)
      void bridge.invoke('setBrowserBounds', { operationId, bounds: null }).catch((_error: unknown) => {
        // The desktop owner also hides the view when it navigates or closes.
      })
    }
  }, [bridge, operationId, attempt])

  return <div className={css.loginViewport} ref={viewport}>
    {failed ? <div role="alert">
      <p>{t('browserViewportFailed')}</p>
      <Button variant="outline" onClick={() => { setFailed(false); setAttempt(value => value + 1) }}>{t('retryImport')}</Button>
    </div> : loading ? <p role="status">{t('browserStarting')}</p>
      : <Button variant="outline" onClick={() => {
        void bridge.invoke('focusBrowser', { operationId }).catch(() => { setFailed(true) })
      }}>{t('focusBrowser')}</Button>}
  </div>
}

function SelectionForm({ state, t, busy, command, draft, change }: PropsLocale<typeof NS> & {
  state: BrowserImportState
  busy: boolean
  command: (action: ImportCommand, fields?: BrowserImportInput) => Promise<void>
  draft: SelectionDraft
  change: (draft: SelectionDraft) => void
}) {
  const selected = new Set(draft.models)
  const hasCatalog = draft.group !== '' && state.candidatesGroup === draft.group
  const selection: NonNullable<BrowserImportInput['selection']> = {
    group: draft.group, models: draft.models.map(modelName => ({ modelName })),
    ...(draft.budget === '' ? { budgetMode: 'unlimited' } : { budgetMode: 'usd', budgetUsd: Number(draft.budget) }),
    ...(draft.days === '' ? { expiryMode: 'never' } : { expiryMode: 'days', expiryDays: Number(draft.days) }),
  }

  function loadGroup(group: string): void {
    void command('setSelection', { selection: { group, models: [], budgetMode: 'unlimited', expiryMode: 'never' } })
  }

  return (
    <form className={css.dialogForm} onSubmit={(event) => {
      event.preventDefault()
      if (hasCatalog && selection.models.length > 0) void command('importSelected', { selection })
    }}>
      <label>{t('group')}
        <select aria-label={t('group')} value={draft.group} disabled={busy} onChange={(event) => {
          const group = event.currentTarget.value
          change({ ...draft, group, models: [] })
          if (group !== '') loadGroup(group)
        }}>
          <option value="">{t('chooseGroup')}</option>
          {state.groups.map(item => <option value={item.name} key={item.name}>{item.desc ? `${item.name} · ${item.desc}` : item.name}</option>)}
        </select>
      </label>
      {draft.group !== '' && !hasCatalog && (
        <Button type="button" variant="outline" size="sm" disabled={busy}
          onClick={() => { loadGroup(draft.group) }}>{t(busy ? 'loading' : 'fetchModels')}</Button>
      )}
      {hasCatalog && (state.candidates.length === 0 ? <p>{t('newApiNoModels')}</p> : (
        <>
          <div className={`${picker.candidates} scrollable`} role="group" aria-label={t('chooseModels')}>
            {state.candidates.map(model => (
              <label key={model.modelName} className={`${picker.choice} ${css.modelChoice}`}>
                <input type="checkbox" checked={selected.has(model.modelName)} disabled={busy || model.apis.length === 0}
                  onChange={(event) => {
                    if (event.currentTarget.checked) selected.add(model.modelName)
                    else selected.delete(model.modelName)
                    change({ ...draft, models: [...selected] })
                  }} />
                <span>{model.modelName}{model.apis.length === 0 && <small className={css.help}> · {t('newApiUnsupportedModel')}</small>}</span>
              </label>
            ))}
          </div>
          <p role="status">{t('selectedModels', { count: selected.size })}</p>
        </>
      ))}
      <label>{t('budget')}<Input className={css.input ?? ''} type="number" min="0.01" max="10000" step="0.01" disabled={busy} value={draft.budget}
        onChange={(event) => { change({ ...draft, budget: event.currentTarget.value }) }} /></label>
      <label>{t('expiry')}<Input className={css.input ?? ''} type="number" min="1" max="3650" disabled={busy} value={draft.days}
        onChange={(event) => { change({ ...draft, days: event.currentTarget.value }) }} /></label>
      <Button variant="primary" size="sm" type="submit" disabled={busy || !hasCatalog || selection.models.length === 0}>{t('import')}</Button>
    </form>
  )
}
