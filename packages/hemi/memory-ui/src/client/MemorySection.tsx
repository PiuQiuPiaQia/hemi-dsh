import { useEffect, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { MemorySnapshot, StoreTarget } from '@deepseek-ai/dsh-hemi-memory/settings'
import css from './MemorySection.module.css'

export interface MemoryActions {
  read: (target: StoreTarget, date: string | undefined) => Promise<MemorySnapshot>
  save: (target: StoreTarget, content: string, revision: string, date: string | undefined) => Promise<string | null>
}

const stores = ['long_term', 'daily', 'scratchpad'] as const
type Notice = 'loading' | 'loadFailed' | 'saving' | 'saved' | 'saveFailed' | 'conflict'

function localDate(): string {
  const now = new Date()
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-')
}

/** Edit one file at a time and keep the draft visible if saving fails. */
export function MemorySection({ t, actions }: PropsLocale<'hemi-memory'> & { actions: MemoryActions }) {
  const [target, setTarget] = useState<StoreTarget>('long_term')
  const [date, setDate] = useState(localDate)
  const [reload, setReload] = useState(0)
  const [base, setBase] = useState<MemorySnapshot | null>(null)
  const [draft, setDraft] = useState('')
  const [notice, setNotice] = useState<Notice | null>('loading')

  const logDate = target === 'daily' ? date : undefined
  const dirty = base !== null && draft !== base.content
  const busy = notice === 'loading' || notice === 'saving'

  useEffect(() => {
    if (logDate === '') return
    let active = true
    void actions.read(target, logDate).then((snapshot) => {
      if (!active) return
      setBase(snapshot)
      setDraft(snapshot.content)
      setNotice(null)
    }, () => {
      if (active) setNotice('loadFailed')
    })
    return () => { active = false }
  }, [actions, target, logDate, reload])

  function resetEditor(nextNotice: Notice | null): void {
    setBase(null)
    setDraft('')
    setNotice(nextNotice)
  }

  async function save(): Promise<void> {
    if (base === null || !dirty || busy || notice === 'conflict') return
    setNotice('saving')
    try {
      const revision = await actions.save(target, draft, base.revision, logDate)
      if (revision === null) {
        setNotice('conflict')
        return
      }
      setBase({ content: draft, revision })
      setNotice('saved')
    } catch {
      setNotice('saveFailed')
    }
  }

  return (
    <section className={css.section} aria-label={t('nav')}>
      <h2 className={css.title}>{t('nav')}</h2>
      <div className={css.card}>
        <div className={css.controls}>
          <label>
            {t('store')}
            <select className={css.select} value={target} disabled={dirty || notice === 'saving'} onChange={(event) => {
              const next = stores.find(store => store === event.currentTarget.value)
              if (next === undefined || next === target) return
              resetEditor(next === 'daily' && date === '' ? null : 'loading')
              setTarget(next)
            }}>
              {stores.map(store => <option key={store} value={store}>{t(store)}</option>)}
            </select>
          </label>
          {target === 'daily' && (
            <label>
              {t('date')}
              <Input className={css.date ?? ''} type="date" value={date} disabled={dirty || notice === 'saving'} onChange={(event) => {
                const next = event.currentTarget.value
                if (next === date) return
                resetEditor(next === '' ? null : 'loading')
                setDate(next)
              }} />
            </label>
          )}
        </div>
        <label className={css.editor}>
          {t('content')}
          <textarea value={draft} placeholder={base === null ? undefined : t('placeholder')}
            disabled={base === null || notice === 'saving'}
            onChange={(event) => {
              setDraft(event.currentTarget.value)
              if (notice === 'saved') setNotice(null)
            }} />
        </label>
        <div className={css.actions}>
          <Button variant="primary" size="sm" disabled={!dirty || busy || notice === 'conflict'} onClick={() => { void save() }}>
            {t('save')}
          </Button>
          <Button variant="outline" size="sm" disabled={busy || logDate === ''} onClick={() => {
            resetEditor('loading')
            setReload(count => count + 1)
          }}>
            {t(dirty ? 'discard' : 'reload')}
          </Button>
        </div>
        <div className={css.status} role="status">{notice === null ? dirty && t('unsaved') : t(notice)}</div>
      </div>
    </section>
  )
}
