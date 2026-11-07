import { useEffect, useState } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { NewApiLogin, NewApiToken } from '@deepseek-ai/dsh-hemi-model-access/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './copy.ts'
import type { ModelAccessActions } from './types.ts'
import css from './page.module.css'

const blank: NewApiLogin = { site: '', userId: '', accessToken: '' }

function siteLink(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash) return url.origin
  } catch { /* The form can contain a partial URL. */ }
  return undefined
}

/**
 * Import an existing token without the desktop bridge; closing retains the form and active request.
 * @param props - Connection actions, localized copy, dialog visibility and completion callbacks.
 * @returns the existing-token import dialog.
 */
export function NewApiSection({ actions, t, open, onClose, onImported }: PropsLocale<typeof NS> & {
  actions: ModelAccessActions
  open: boolean
  onClose: () => void
  onImported: () => void
}) {
  const [login, setLogin] = useState(blank)
  const [tokens, setTokens] = useState<NewApiToken[] | null>(null)
  const [selected, setSelected] = useState('')
  const [imported, setImported] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)
  const [request, setRequest] = useState<AbortController | null>(null)
  useEffect(() => () => { request?.abort() }, [request])
  const site = siteLink(login.site)
  const ready = site !== undefined && login.userId.trim() !== '' && login.accessToken.trim() !== ''

  function field(key: keyof NewApiLogin, value: string): void {
    setLogin({ ...login, [key]: value })
    setTokens(null)
    setSelected('')
    setImported(null)
    setFailed(false)
  }

  async function run(importing: boolean): Promise<void> {
    if (request !== null || !ready) return
    const signal = new AbortController()
    setRequest(signal)
    setFailed(false)
    setImported(null)
    const input = { site: login.site.trim(), userId: login.userId.trim(), accessToken: login.accessToken.trim() }
    try {
      if (importing) {
        const count = await actions.importNewApi(input, Number(selected), signal.signal)
        if (signal.signal.aborted) return
        setLogin({ ...blank, site: login.site })
        setTokens(null)
        setSelected('')
        setImported(count)
        onImported()
      } else {
        setTokens(null)
        setSelected('')
        const rows = await actions.listNewApi(input, signal.signal)
        if (!signal.signal.aborted) setTokens(rows)
      }
    } catch {
      if (!signal.signal.aborted) setFailed(true)
    } finally {
      if (!signal.signal.aborted) setRequest(null)
    }
  }

  return (
    <>
      {!open && (failed || imported !== null || request !== null) && <p className={css.importSummary} role={failed ? 'alert' : 'status'}>
        {failed ? t('failed') : imported !== null ? t('imported', { count: imported }) : t('newApiClosedProgress')}
      </p>}
      <Modal open={open} title={t('newApiSetup')} description={t('newApiWebHelp')} closeLabel={t('close')} onClose={onClose}
        className={css.importDialog ?? ''} contentClassName={`${css.importContent} scrollable`}
        footer={<Button variant="outline" onClick={onClose}>{t(imported === null ? 'close' : 'done')}</Button>}>
        <form className={css.importBody} aria-label={t('newApi')} onSubmit={(event) => { event.preventDefault(); void run(false) }}>
          <p>{t('newApiHelp')}</p>
          <label>{t('site')}
            <Input className={css.input ?? ''} type="url" autoComplete="url" value={login.site} disabled={request !== null}
              onChange={(event) => { field('site', event.currentTarget.value) }} />
          </label>
          {site !== undefined && <a href={site} target="_blank" rel="noreferrer">{t('openSite')}</a>}
          <label>{t('userId')}
            <Input className={css.input ?? ''} inputMode="numeric" value={login.userId} disabled={request !== null}
              onChange={(event) => { field('userId', event.currentTarget.value) }} />
          </label>
          <label>{t('accessToken')}
            <Input className={css.input ?? ''} type="password" autoComplete="off" value={login.accessToken} disabled={request !== null}
              onChange={(event) => { field('accessToken', event.currentTarget.value) }} />
          </label>
          <Button type="submit" variant="outline" size="sm" disabled={!ready || request !== null}>{t('listTokens')}</Button>
          {tokens !== null && (tokens.length === 0 ? <p>{t('noTokens')}</p> : (
            <div className={css.form}>
              <label>{t('token')}
                <select value={selected} disabled={request !== null} onChange={(event) => { setSelected(event.currentTarget.value) }}>
                  <option value="">{t('choose')}</option>
                  {tokens.map(row => <option key={row.id} value={row.id}>{row.group ? `${row.name} · ${row.group}` : row.name}</option>)}
                </select>
              </label>
              <Button type="button" variant="outline" size="sm" disabled={selected === '' || request !== null}
                onClick={() => { void run(true) }}>{t('import')}</Button>
            </div>
          ))}
          {request !== null && <p role="status">{t('loading')}</p>}
          {failed && <p role="alert">{t('failed')}</p>}
          {imported !== null && <p role="status">{t('imported', { count: imported })}</p>}
        </form>
      </Modal>
    </>
  )
}
