/**
 * Hemi model routing settings section: one model picker per preset role,
 * persisted through the `hemi-routing-settings` namespace.
 */
import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RoutingLocaleKey } from './locales.ts'
import css from './RoutingSection.module.css'

/** One model option offered for a role, resolved from the session catalog. */
export interface CatalogModelOption {
  /** Provider id owning the model. */
  provider: string
  /** Model id within the provider. */
  model: string
  /** Display name from the catalog. */
  name: string
}

/** One provider group of catalog options. */
export interface CatalogGroup {
  /** Provider id. */
  id: string
  /** Provider display name. */
  name: string
  /** Models within the provider. */
  models: readonly CatalogModelOption[]
}

/** Injected business face: snapshot read, save write, and catalog load. */
export interface RoutingSectionInjected {
  /** Read the persisted role-to-route table. */
  getRoutes: () => Record<string, { provider: string; model: string; reasoningEffort?: string }>
  /** Persist the whole role-to-route table. */
  saveRoutes: (roles: Record<string, { provider: string; model: string; reasoningEffort?: string }>) => Promise<boolean>
  /** Load the routable model catalog, grouped by provider. */
  loadCatalog: () => Promise<readonly CatalogGroup[]>
}

/** Full component props: runtime share + locale seat + injected face + shell close. */
export type RoutingSectionProps = PropsRuntime<'settings.section'>
  & PropsLocale<'hemi-routing'>
  & InjectFace<RoutingSectionInjected>
  & { close: () => void }

type SaveState = 'idle' | 'saving' | 'saved' | 'failed'

/** The preset roles in display order. */
const ROLES: readonly { id: 'research' | 'review' | 'execution' | 'design'; labelKey: RoutingLocaleKey; helpKey: RoutingLocaleKey }[] = [
  { id: 'research', labelKey: 'roleResearch', helpKey: 'roleResearchHelp' },
  { id: 'review', labelKey: 'roleReview', helpKey: 'roleReviewHelp' },
  { id: 'execution', labelKey: 'roleExecution', helpKey: 'roleExecutionHelp' },
  { id: 'design', labelKey: 'roleDesign', helpKey: 'roleDesignHelp' },
]

/**
 * Render the model routing editor: one catalog picker per preset role.
 * @param props - composed slot props.
 * @returns the section element tree.
 */
export function RoutingSection(props: RoutingSectionProps) {
  const { t, getRoutes, saveRoutes, loadCatalog } = props
  const [groups, setGroups] = useState<readonly CatalogGroup[]>([])
  const [catalogState, setCatalogState] = useState<'loading' | 'ok' | 'failed'>('loading')
  const [values, setValues] = useState<Record<string, string>>(() => {
    const routes = getRoutes()
    const current: Record<string, string> = {}
    for (const role of ROLES) {
      const route = routes[role.id]
      current[role.id] = route === undefined ? '' : `${route.provider}/${route.model}`
    }
    return current
  })
  const [saveState, setSaveState] = useState<SaveState>('idle')

  useEffect(() => {
    let alive = true
    loadCatalog().then((catalog) => {
      if (!alive) return
      setGroups(catalog)
      setCatalogState('ok')
    }).catch(() => {
      if (!alive) return
      setGroups([])
      setCatalogState('failed')
    })
    return () => { alive = false }
  }, [loadCatalog])

  const setValue = (id: string, value: string): void => {
    setValues(current => ({ ...current, [id]: value }))
    setSaveState('idle')
  }
  const save = async (): Promise<void> => {
    const roles: Record<string, { provider: string; model: string; reasoningEffort?: string }> = {}
    for (const role of ROLES) {
      const value = values[role.id]
      if (value === undefined || value === '') continue
      const [provider, ...rest] = value.split('/')
      const model = rest.join('/')
      if (provider === undefined || provider === '' || model === '') continue
      roles[role.id] = { provider, model, reasoningEffort: '' }
    }
    setSaveState('saving')
    const ok = await saveRoutes(roles)
    setSaveState(ok ? 'saved' : 'failed')
  }

  return (
    <div className={css.section}>
      <div className={css.header}>
        <span className={css.title}>{t('title')}</span>
        {props.close !== undefined ? <button type="button" aria-label="close" onClick={props.close} className={css.close}>✕</button> : null}
      </div>
      <p className={css.description}>{t('description')}</p>
      <div className={css.rows}>
        {ROLES.map(role => (
          <div key={role.id} className={css.row}>
            <div className={css.roleCell}>
              <span className={css.roleLabel}>{t(role.labelKey)}</span>
              <span className={css.roleHelp}>{t(role.helpKey)}</span>
            </div>
            <select
              className={css.select}
              value={values[role.id] ?? ''}
              aria-label={t(role.labelKey)}
              onChange={e => setValue(role.id, e.target.value)}
            >
              <option value="">{t('followMain')}</option>
              {catalogState === 'failed' ? <option disabled>{t('catalogError')}</option> : null}
              {groups.map(group => (
                <optgroup key={group.id} label={group.name}>
                  {group.models.map(model => (
                    <option key={`${model.provider}/${model.model}`} value={`${model.provider}/${model.model}`}>{model.name}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
        ))}
      </div>
      <div className={css.footer}>
        <span className={css.status}>
          {saveState === 'saving' ? t('saving') : saveState === 'saved' ? t('saved') : saveState === 'failed' ? t('saveFailed') : catalogState === 'failed' ? t('catalogError') : ''}
        </span>
        <button type="button" className={css.save} disabled={saveState === 'saving'} onClick={() => { void save() }}>
          {saveState === 'saving' ? t('saving') : t('save')}
        </button>
      </div>
      <p className={css.restartNote}>{t('restartNote')}</p>
    </div>
  )
}
