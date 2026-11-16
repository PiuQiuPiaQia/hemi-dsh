/** VVCode directory reads are read-only; staged model selections prepare connections only on save. */
import { useEffect, useId, useRef, useState } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { VvcodeDirectory, VvcodeGroupView, VvcodeModelSelection } from '@deepseek-ai/dsh-hemi-model-access/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { ModelConnectionTest } from './ModelConnectionTest.tsx'
import type { ModelAccessActions, ModelTest } from './types.ts'
import type { NS } from './copy.ts'
import css from './page.module.css'
import picker from './ModelPicker.module.css'

/** One unified directory read per authorization; staged selections commit only on save. */
export interface VvcodeGroupControls {
  directory: VvcodeDirectory | null
  loading: boolean
  failed: boolean
  mutationBusy: boolean
  /** Read once when this authorization has no usable snapshot; reuse the snapshot otherwise. */
  ensure: () => void
  /** Read the directory again unconditionally; the button disables itself while a read is pending. */
  refresh: () => void
  saved: () => Promise<void>
  save: (selections: VvcodeModelSelection[], signal: AbortSignal) => Promise<void>
}

type Props = PropsLocale<typeof NS> & {
  controls: VvcodeGroupControls
  disabled: boolean
  actions: ModelAccessActions
  test: ModelTest
}
type Choices = {
  draft: Record<string, boolean>
  saving: boolean
  choose: (provider: string, model: string, enabled: boolean) => void
}

/** @param props - Account directory, localized copy and group-scoped operations. @returns the saved summary and staged selection dialog. */
export function VvcodeGroups({ controls, disabled, actions, test, t }: Props) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [draft, setDraft] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const active = useRef<AbortController | null>(null)
  useEffect(() => () => { active.current?.abort() }, [])
  const groups = controls.directory?.groups ?? []
  const query = search.trim().toLocaleLowerCase()
  const authorized = !disabled && controls.directory?.state !== 'sign-in-required'
  const matching = groups.some(group => matches(group, query))
  const selected = groups.reduce((sum, group) => sum + group.models.filter(model => model.enabled).length, 0)
  const selectedGroups = groups.filter(group => group.models.some(model => model.enabled)).length
  const selections = groups.flatMap((group): VvcodeModelSelection[] => {
    const models = group.models.filter(model => enabled(group, model, draft, !authorized)).map(model => model.id)
    return group.models.some(model => model.enabled !== models.includes(model.id)) ? [{ provider: group.provider, models }] : []
  })
  const canSave = !saving && !controls.mutationBusy && selections.length > 0
  function choose(provider: string, model: string, checked: boolean): void {
    setDraft(old => ({ ...old, [choiceKey(provider, model)]: checked }))
  }
  function close(): void {
    if (saving) return
    setOpen(false)
    setDraft({})
  }
  async function save(): Promise<void> {
    if (active.current !== null || selections.length === 0) return
    const connections = groups.filter(group => !group.hasConnection && selections.some(selection => selection.provider === group.provider
      && selection.models.some(id => !group.models.some(model => model.id === id && model.enabled))))
    if (connections.length > 0 && !window.confirm(t('vvcodeConfirmSave', { groups: connections.map(group => group.name).join(', ') }))) return
    const request = new AbortController()
    active.current = request
    setSaving(true)
    setSaveFailed(false)
    try {
      // The save rejects on abort or refresh failure, so reaching here means both settled.
      await controls.save(selections, request.signal)
      setOpen(false)
      setDraft({})
    } catch (_error: unknown) {
      if (!request.signal.aborted) setSaveFailed(true)
    } finally {
      if (active.current === request) active.current = null
      if (!request.signal.aborted) setSaving(false)
    }
  }
  return <>
    <div className={css.row}>
      <p role="status">{controls.directory === null
        ? t(controls.failed && !controls.loading ? 'vvcodeSummaryUnknown' : 'vvcodeSummaryLoading')
        : t('vvcodeModelSummary', { models: selected, groups: selectedGroups })}</p>
      <Button variant="outline" size="sm" disabled={saving} onClick={() => {
        setDraft({}); setSearch(''); setSaveFailed(false); setOpen(true); controls.ensure()
      }}>{t('vvcodeManage')}</Button>
    </div>
    <Modal open={open} title={t('vvcodeManage')} closeLabel={t('close')} onClose={close}
      className={`${css.modelDialog} ${css.vvcodeDialog}`} contentClassName={`${css.vvcodeDialogContent} scrollable`}
      footer={<div className={picker.footer}>
        <Button variant="outline" disabled={saving} onClick={close}>{t('cancel')}</Button>
        <Button variant={canSave ? 'primary' : 'outline'} className={canSave ? picker.confirm : ''} disabled={!canSave}
          aria-busy={saving} onClick={() => { void save() }}>{t(saving ? 'vvcodeSavingSelection' : 'vvcodeSaveSelection')}</Button>
      </div>}>
      <div className={css.vvcodeGroups} aria-busy={saving}>
        <div className={css.vvcodeGroupActions}>
          <Input className={`${css.input ?? ''} ${css.vvcodeSearch ?? ''}`} data-modal-autofocus
            aria-label={t('vvcodeSearch')} placeholder={t('vvcodeSearch')} value={search}
            onChange={(event) => { setSearch(event.currentTarget.value) }} />
          <Button variant="outline" size="sm" disabled={saving || controls.loading} aria-busy={controls.loading}
            onClick={controls.refresh}>{t(controls.loading ? 'loading' : 'vvcodeRefreshDirectory')}</Button>
        </div>
        {(controls.failed || controls.directory?.state === 'unavailable') && <p role="alert">{t('vvcodeGroupsFailed')}</p>}
        {!authorized && <p role="alert">{t('vvcodeExpired')}</p>}
        {!controls.loading && !controls.failed && controls.directory?.state === 'ready' && groups.length === 0
          && <p role="status">{t('vvcodeNoGroups')}</p>}
        {groups.map(group => <VvcodeGroup key={group.name} group={group} query={query} hidden={!matches(group, query)}
          controls={controls} disabled={!authorized} actions={actions} test={test} t={t} draft={draft} saving={saving} choose={choose} />)}
        {groups.length > 0 && !matching && <p role="status">{t('noMatches')}</p>}
        {saveFailed && <p role="alert">{t('vvcodeSelectionFailed')}</p>}
      </div>
    </Modal>
  </>
}

function choiceKey(provider: string, model: string): string { return JSON.stringify([provider, model]) }

function enabled(group: VvcodeGroupView, model: VvcodeGroupView['models'][number], draft: Choices['draft'], blocked: boolean): boolean {
  if (!model.enabled && (blocked || group.state === 'unavailable' || group.state === 'creation-unknown' || group.catalogError)) return false
  return draft[choiceKey(group.provider, model.id)] ?? model.enabled
}

function matches(group: VvcodeGroupView, query: string): boolean {
  return group.name.toLocaleLowerCase().includes(query) || group.models.some(model => model.id.toLocaleLowerCase().includes(query))
}

function VvcodeGroup({ group, query, hidden, controls, disabled, actions, test, t, draft, saving, choose }: Props & Choices & {
  group: VvcodeGroupView
  query: string
  hidden: boolean
}) {
  const panelId = useId()
  const [expanded, setExpanded] = useState(group.models.some(model => model.enabled))
  const selected = group.models.filter(model => enabled(group, model, draft, disabled)).length
  const unknown = group.state === 'creation-unknown'
  const known = !group.catalogError
  const unavailable = group.state === 'unavailable'
  const readFailed = group.catalogError
  const groupMatch = group.name.toLocaleLowerCase().includes(query)
  return <section className={css.vvcodeGroup} aria-label={t('vvcodeGroupRegion', { group: group.name })} hidden={hidden}>
    <div className={css.vvcodeGroupHeader}>
      <button type="button" className={css.vvcodeGroupToggle} aria-expanded={expanded || query.length > 0} aria-controls={panelId}
        onClick={() => { setExpanded(value => !value) }}>
        <span aria-hidden="true">{expanded || query.length > 0 ? '−' : '+'}</span>
        <span>{group.name}</span>
        <small>{t(known ? 'vvcodeEnabledCount' : 'vvcodeEnabledUnknown', { enabled: selected, total: group.models.length })}</small>
        {group.state === 'not-synced' && <small>{t('vvcodeNotSynced')}</small>}
        {(unknown || readFailed || group.state === 'unavailable') && <small>{t(unknown ? 'vvcodeCreationBlocked' : group.state === 'unavailable' ? 'vvcodeAccessUnavailable' : 'vvcodeSyncFailed')}</small>}
      </button>
      <div className={css.actions}>
        <small>{group.ratio === 'auto' ? t('vvcodeAutoRatio') : group.ratio === null
          ? t('vvcodeUnknownRatio') : t('vvcodeRatio', { ratio: group.ratio })}</small>
      </div>
    </div>
    <div id={panelId} className={css.vvcodeGroupBody} hidden={!expanded && query.length === 0}>
      {unknown ? <p role="alert">{t('vvcodeCreationUnknown')}</p>
        : group.state === 'unavailable' ? <p role="alert">{t('vvcodeGroupUnavailable')}</p>
          : readFailed ? <p role="alert">{t('vvcodeGroupSyncFailed')}</p>
            : group.models.length === 0 && <p role="status">{t('vvcodeNoModels')}</p>}
      {group.models.map((model) => {
        const checked = enabled(group, model, draft, disabled)
        return <div key={model.id} hidden={!groupMatch && !model.id.toLocaleLowerCase().includes(query)}>
          <ModelConnectionTest provider={group.provider} model={model.id} actions={actions} test={test} t={t}
            saved={controls.saved}
            modelUnavailable={saving || disabled || unknown || unavailable || !known || !group.hasConnection || !model.enabled || !checked}
            selection={{ enabled: checked, busy: saving, disabled: saving || ((disabled || unknown || unavailable || !known) && !checked),
              label: t('vvcodeEnableModel', { group: group.name, model: model.id }),
              change: (add) => { choose(group.provider, model.id, add) } }} />
        </div>
      })}
    </div>
  </section>
}
