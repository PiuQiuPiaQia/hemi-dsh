/** Catalog-only model picker over the shared Menu and Button primitives. */
import { useState } from 'react'
import { Button, IconChevronDownOutlineRegular, IconWarningOutlineRegular, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-session-controller/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { Route } from './types.ts'
import type { NS } from './locales.ts'
import css from './RoutingSection.module.css'

interface RoutePickerProps extends PropsLocale<typeof NS> {
  fieldLabel: string
  route: Route | null
  groups: readonly ModelProviderGroup[]
  /**
   * Offer the follow-main choice. The main model has no such choice: clearing it
   * is not a supported write, so its menu lists catalog models only.
   */
  followMain: boolean
  catalogReady: boolean
  disabled: boolean
  onSelect: (route: Route | null) => void
}

/** Provider and model ids are lookup keys, never slash-separated paths. */
function routeKey(route: Route): string {
  return JSON.stringify([route.provider, route.model])
}

/**
 * Keep unavailable configured routes visible without adding arbitrary-input controls.
 * @param props - Saved route, catalog choices, localized copy and field write callback.
 * @returns the model picker and complete saved route identity.
 */
export function RoutePicker({ fieldLabel, route, groups, followMain, catalogReady, disabled, onSelect, t }: RoutePickerProps) {
  const [open, setOpen] = useState(false)
  const group = route === null ? undefined : groups.find(candidate => candidate.id === route.provider)
  const model = route === null ? undefined : group?.models.find(candidate => candidate.id === route.model)
  const emptyLabel = followMain ? t('followMain') : t('noMain')
  const label = route === null ? emptyLabel : model?.name ?? route.model
  const choices = new Map<string, Route>()
  const items: MenuEntry[] = followMain ? [{ id: 'inherit', label: t('followMain') }] : []
  for (const provider of groups) {
    items.push({ type: 'label', id: JSON.stringify(['provider', provider.id]), text: provider.name })
    for (const entry of provider.models) {
      const value = { provider: provider.id, model: entry.id }
      const key = routeKey(value)
      choices.set(key, value)
      items.push({ id: key, label: <span className={css.optionText}>{entry.name}</span> })
    }
  }
  return (
    <div className={css.pickerCell}>
      <Menu open={open && !disabled} onClose={() => { setOpen(false) }} items={items}
        selectedId={route === null ? 'inherit' : routeKey(route)} portal autoFocus minWidthFromAnchor
        className={css.picker} listClassName={css.pickerMenu}
        onSelect={(key) => {
          setOpen(false)
          if (key === 'inherit') { onSelect(null); return }
          const next = choices.get(key)
          if (next === undefined) return
          // Re-selecting the saved model keeps its reasoning effort.
          onSelect(route !== null && routeKey(route) === key ? route : next)
        }}
        anchor={(
          <Button variant="outline" className={css.pickerButton} disabled={disabled}
            aria-label={t('chooseModel', { field: fieldLabel, model: label })}
            aria-haspopup="menu" aria-expanded={open && !disabled}
            onClick={() => { setOpen(!open) }}>
            <span className={css.pickerText}>{label}</span>
            <IconChevronDownOutlineRegular size={12} aria-hidden="true" />
          </Button>
        )}
      />
      {route !== null && <p className={css.routeDetail}>{t('routeIdentity', { provider: group?.name ?? route.provider, model: route.model })}</p>}
      {route?.reasoningEffort ? <p className={css.routeDetail}>{t('reasoningEffort', { effort: route.reasoningEffort })}</p> : null}
      {route === null && !followMain && <p className={css.routeDetail}>{t('mainRequired')}</p>}
      {catalogReady && route !== null && model === undefined && (
        <p className={css.warning}><IconWarningOutlineRegular className={css.warningIcon} size={14} aria-hidden="true" />{t('notInCatalog')}</p>
      )}
    </div>
  )
}
