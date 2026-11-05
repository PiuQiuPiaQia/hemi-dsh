/** Searchable model discovery dialog shared by subscriptions and API connections. */
import { useEffect, useRef, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './copy.ts'
import css from './page.module.css'

/**
 * Fetch candidates only on demand and apply selections only after confirmation.
 * @param props - Current IDs, cancellable discovery, explicit addition and localized copy.
 * @returns a discovery button and its selection dialog.
 */
export function ModelPicker({ current, load, add, t, buttonText, disabled = false }: PropsLocale<typeof NS> & {
  current: string[]
  load: (signal: AbortSignal) => Promise<string[]>
  add: (models: string[]) => Promise<void>
  buttonText?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [candidates, setCandidates] = useState<string[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const active = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; active.current?.abort() }
  }, [])
  function close(): void {
    if (saving) return
    active.current?.abort()
    setOpen(false)
  }
  async function discover(): Promise<void> {
    active.current?.abort()
    const request = new AbortController()
    active.current = request
    setOpen(true); setLoading(true); setFailed(false); setCandidates([]); setSelected([]); setQuery('')
    try {
      const value = await load(request.signal)
      if (!request.signal.aborted) setCandidates([...new Set(value)])
    } catch {
      if (!request.signal.aborted) setFailed(true)
    } finally {
      if (!request.signal.aborted) setLoading(false)
    }
  }
  const available = candidates.filter(model => !current.includes(model))
  const visible = available.filter(model => model.toLowerCase().includes(query.trim().toLowerCase()))
  const allVisible = visible.length > 0 && visible.every(model => selected.includes(model))
  return (
    <div className={css.modelPicker}>
      <Button variant="ghost" size="sm" disabled={disabled} onClick={() => { void discover() }}>{buttonText ?? t('fetchModels')}</Button>
      <Modal open={open} title={t('chooseModels')} closeLabel={t('close')} onClose={close}
        description={t('liveModelCatalog')}
        className={css.modelDialog ?? ''} contentClassName={`${css.dialogContent} scrollable`}
        footer={<div className={css.actions}>
          <Button variant="outline" disabled={saving} onClick={close}>{t('cancel')}</Button>
          <Button variant="primary" disabled={loading || saving || selected.length === 0} onClick={() => {
            setSaving(true); setFailed(false)
            void add(selected).then(() => { if (mounted.current) setOpen(false) }, () => { if (mounted.current) setFailed(true) })
              .finally(() => { if (mounted.current) setSaving(false) })
          }}>{t(saving ? 'loading' : 'addModels')}</Button>
        </div>}>
        <div className={css.dialogForm}>
          <div className={css.row}>
            <label className={css.searchField}>{t('searchModels')}<input type="search" value={query} disabled={loading || saving}
              onChange={(event) => { setQuery(event.currentTarget.value) }} /></label>
            <Button variant="ghost" size="sm" disabled={loading || saving || visible.length === 0} onClick={() => {
              setSelected(allVisible ? selected.filter(model => !visible.includes(model)) : [...new Set([...selected, ...visible])])
            }}>{t(allVisible ? 'deselectAll' : 'selectAll')}</Button>
            <Button variant="ghost" size="sm" disabled={loading || saving} onClick={() => { void discover() }}>{t('refreshModels')}</Button>
          </div>
          {loading ? <p role="status">{t('loading')}</p> : !failed && available.length === 0 ? <p>{t('noNewModels')}</p>
            : visible.length === 0 && !failed ? <p>{t('noMatches')}</p> : null}
          <div className={`${css.candidates} scrollable`}>
            {visible.map(model => <label className={css.modelChoice} key={model}>
              <input type="checkbox" checked={selected.includes(model)} disabled={saving}
                onChange={(event) => {
                  setSelected(event.currentTarget.checked ? [...selected, model] : selected.filter(id => id !== model))
                }} />
              <span className={css.modelName}>{model}</span>
            </label>)}
          </div>
          {failed && <p role="alert">{t('fetchModelsFailed')} <Button variant="ghost" size="sm" disabled={saving}
            onClick={() => { void discover() }}>{t('retryImport')}</Button></p>}
        </div>
      </Modal>
    </div>
  )
}
