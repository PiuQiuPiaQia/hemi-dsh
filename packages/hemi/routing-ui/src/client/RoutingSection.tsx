/** Shared route editor, rendered only inside the shell-owned configuration modal. */
import { Button, IconWarningOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RoutingEditorInjected, RoutingField, RoutingRole } from './types.ts'
import type { NS, RoutingLocaleKey } from './locales.ts'
import { RoutePicker } from './RoutePicker.tsx'
import { configuredRoleRoute } from './editor-state.ts'
import css from './RoutingSection.module.css'

/** Form props supplied by the shared editor registration. */
export type RoutingSectionProps = InjectFace<RoutingEditorInjected> & PropsLocale<typeof NS>

const ROLES: readonly { id: RoutingRole; labelKey: RoutingLocaleKey; helpKey: RoutingLocaleKey }[] = [
  { id: 'explorer', labelKey: 'roleExplorer', helpKey: 'roleExplorerHelp' },
  { id: 'oracle', labelKey: 'roleOracle', helpKey: 'roleOracleHelp' },
  { id: 'fixer', labelKey: 'roleFixer', helpKey: 'roleFixerHelp' },
  { id: 'designer', labelKey: 'roleDesigner', helpKey: 'roleDesignerHelp' },
]

/**
 * Localize the field being saved without exposing implementation role ids.
 * @param field - Main model or one of the four preset roles.
 * @param t - Typed routing dictionary.
 * @returns the field's visible name.
 */
export function routingFieldLabel(field: RoutingField, t: PropsLocale<typeof NS>['t']): string {
  switch (field) {
    case 'main': return t('main')
    case 'explorer': return t('roleExplorer')
    case 'oracle': return t('roleOracle')
    case 'fixer': return t('roleFixer')
    case 'designer': return t('roleDesigner')
  }
}

/**
 * Keep write feedback in the modal footer, visible while the route list scrolls.
 * @param props - Write observation and localized copy from the editor registration.
 * @returns the persistent save status or actionable failure.
 */
export function RoutingSaveStatus({ useRoutingWrite, t }: Pick<RoutingSectionProps, 'useRoutingWrite' | 't'>) {
  const write = useRoutingWrite(value => value)
  if (write.status === 'idle') return null
  const field = routingFieldLabel(write.field, t)
  const text = write.status === 'failed'
    ? write.message === null ? t('saveFailed', { field }) : t('saveError', { field, message: write.message })
    : write.status === 'saving' ? t('saving', { field }) : t('saved', { field })
  return <p className={write.status === 'failed' ? css.writeError : css.writeStatus} role={write.status === 'failed' ? 'alert' : 'status'}>
    {write.status === 'saving' && <StateDot state="ongoing" />}
    {write.status === 'failed' && <IconWarningOutlineRegular className={css.errorIcon} size={14} aria-hidden="true" />}
    {text}
  </p>
}

/**
 * Render saved values directly from the settings mirror; choices save one field at a time.
 * @param props - Bound settings/catalog/write hooks and narrow commands.
 * @returns the configuration form with loading, failure and read-only states.
 */
export function RoutingSection({
  useRoutingSettings, useRoutingCatalog, useRoutingWrite, modelChoiceMenu, saveRoute, refreshCatalog, t,
}: RoutingSectionProps) {
  const settings = useRoutingSettings(value => value)
  const catalog = useRoutingCatalog(value => value)
  const saving = useRoutingWrite(value => value.status === 'saving')
  if (settings.status === 'unavailable') return <p className={css.notice} role="status">{t('unavailable')}</p>
  if (settings.status === 'loading' || catalog.status === 'loading' || catalog.status === 'idle') {
    return <div className={css.loading} role="status" aria-label={t('loading')}><StateDot state="ongoing" /></div>
  }
  if (settings.value === undefined) return <p className={css.notice} role="status">{t('unavailable')}</p>
  const config = settings.value
  const disabled = !settings.writable || saving || catalog.status !== 'ready'
  return (
    <div className={css.editor} data-routing-editor>
      {!settings.writable && <p className={css.notice} role="status">{t('readOnly')}</p>}
      {catalog.status === 'failed' && (
        <div className={css.catalogNotice} role="alert">
          <p className={css.error}><IconWarningOutlineRegular className={css.errorIcon} size={14} aria-hidden="true" />{t('catalogError', { message: catalog.error ?? '' })}</p>
          <Button variant="outline" size="sm" disabled={saving} onClick={refreshCatalog}>{t('reload')}</Button>
        </div>
      )}
      {catalog.status === 'ready' && (catalog.failures.length > 0 || catalog.groups.every(group => group.models.length === 0)) && (
        <div className={css.catalogNotice} role="status">
          <p className={css.warning}><IconWarningOutlineRegular className={css.warningIcon} size={14} aria-hidden="true" />{catalog.failures.length > 0
            ? t('catalogPartial', { providers: catalog.failures.map(failure => failure.name).join(', ') })
            : t('catalogEmpty')}</p>
          <Button variant="outline" size="sm" disabled={saving} onClick={refreshCatalog}>{t('reload')}</Button>
        </div>
      )}
      <div className={css.main}>
        <div className={css.row}>
          <div className={css.roleCell}>
            <h3 className={css.fieldLabel}>{t('main')}</h3>
            <p className={css.help}>{t('mainHelp')}</p>
          </div>
          <RoutePicker fieldLabel={t('main')} route={config.main ?? null} groups={catalog.groups} followMain={false} t={t}
            disabled={disabled} catalogReady={catalog.status === 'ready'} onSelect={(route) => { saveRoute('main', route) }} />
        </div>
      </div>
      <section className={css.roles} aria-label={t('roles')}>
        <h3 className={css.groupTitle}>{t('roles')}</h3>
        {ROLES.map(role => (
          <div className={css.row} key={role.id}>
            <div className={css.roleCell}>
              <h4 className={css.fieldLabel}>{t(role.labelKey)}</h4>
              <p className={css.help}>{t(role.helpKey)}</p>
            </div>
            <RoutePicker fieldLabel={t(role.labelKey)} route={configuredRoleRoute(config.roles, role.id) ?? null} groups={catalog.groups}
              followMain t={t} disabled={disabled} catalogReady={catalog.status === 'ready'}
              onSelect={(route) => { saveRoute(role.id, route) }} />
          </div>
        ))}
      </section>
      {modelChoiceMenu !== true && <div className={css.notes}><p>{t('sameModel')}</p></div>}
    </div>
  )
}
