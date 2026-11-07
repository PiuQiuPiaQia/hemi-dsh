/** Hemi's flat composer picker, adapted from the upstream ModelSelect. */
import { Menu, MenuGroup, MenuSurface, observeStickyMenuGroups, useAnchoredPosition } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type KeyboardEvent, type FocusEvent,
} from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import type { ModelReasoningEffort, ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconCloseFillRegular,
  IconDataOutlineRegular, IconWarningOutlineRegular, Input, rankByName, StateDot, Tag, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelLabelOwner, ModelSelectInjected } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import css from './ModelSelect.module.css'
import flat from './HemiModelSelect.module.css'
import type { ModelMenuModeSnapshot } from './menu-mode.ts'

/** Hemi's catalog order, independent of upstream picker presentation changes. */
const providerRanks: Readonly<Record<string, number>> = { 'deepseek-account': 0, 'deepseek-official': 1 }

/** The inherited model directory and the alternative's saved selection source. */
export interface HemiModelSelectInjected extends Omit<ModelSelectInjected, 'directory'> {
  hooks: {
    directory: HostObservable<ReturnType<ModelSelectInjected['directory']['getSnapshot']>>
    menuMode: HostObservable<ModelMenuModeSnapshot | null>
  }
}

/** One dynamic effort row; undefined means preserve the provider default. */
interface EffortChoice {
  key: string
  effort: string | undefined
  label: string
}

/** Unplaced portal card: hidden but laid out at a fixed origin so offsetWidth/offsetHeight are real (Menu primitive's measure pass). */
const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

/**
 * Render the Hemi model menu and a separate capability-gated reasoning-effort selector.
 * @param props - Session, directory, locale and menu-slot bindings.
 * @returns adjacent model and reasoning-effort controls with anchored menus.
 */
export function HemiModelSelect(
  { sessionId, locked, available, useDirectory, useMenuMode, load, select, resolveText, t, renderSlot }:
  InjectFace<HemiModelSelectInjected> & Pick<PropsRuntime<'conversation.input.model'>, 'locked' | 'sessionId'> & PropsLocale<'model'>
    & Omit<PropsRenderSlots<'conversation.input.model.label' | 'conversation.input.model.options' | 'conversation.input.model.alternative' | 'conversation.input.model.effort'>, 'SessionProvider'>,
) {
  const state = useDirectory(value => value)
  const alternativeLabel = useMenuMode(mode => mode?.sessions?.[sessionId] === true ? mode.label : undefined)
  const alternativeSelected = alternativeLabel !== undefined
  const [open, setOpen] = useState(false)
  const [effortOpen, setEffortOpen] = useState(false)
  const [alternativePending, setAlternativePending] = useState(false)
  const choosing = useRef(false)
  const [query, setQuery] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null)
  const [selectionFocus, setSelectionFocus] = useState(false)
  // The in-menu error strip serves catalog loads (its Retry re-runs the
  // load); a rejected SELECTION announces through the transient toast
  // instead, so the strip renders only while the latest failure-capable
  // action was a load.
  const lastActionRef = useRef<'load' | 'select'>('load')
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSeq = useRef(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const groupsRef = useRef<HTMLDivElement | null>(null)
  const effortToggleRef = useRef<HTMLButtonElement | null>(null)
  const menuPos = useAnchoredPosition({
    open: open && available,
    anchorRef: triggerRef,
    panelRef: menuRef,
    side: 'top',
    align: 'end',
    gap: 8,
    margin: 12,
  })
  const id = useId()

  const accountProviderName = t('provider.account')
  const groups = useMemo(() => state.groups
    .toSorted((left, right) => (providerRanks[left.id] ?? 2) - (providerRanks[right.id] ?? 2)).map(group => ({
      ...group,
      provider: {
        id: group.id,
        name: group.id === 'deepseek-account' ? accountProviderName : group.name,
      },
    })), [state.groups, accountProviderName])
  const choices = useMemo(() => groups.flatMap(group =>
    group.models.map(model => ({
      group,
      model,
      selection: {
        provider: group.id,
        model: model.id,
        ...model.reasoning?.defaultEffort === undefined
          ? {}
          : { reasoningEffort: model.reasoning.defaultEffort },
      } satisfies ModelSelection,
    }))), [groups])
  const showSearch = choices.length > 4
  const filteredGroups = useMemo(() => groups.map(group => ({
    ...group, models: rankByName(group.models, showSearch ? query.trim() : ''),
  })).filter(group => group.models.length > 0), [groups, query, showSearch])
  const visibleModels = useMemo(() => filteredGroups.flatMap(group => group.models.map(model => ({
    provider: group.id, model: model.id,
  }))), [filteredGroups])
  const currentVisibleIndex = alternativeSelected ? -1 : visibleModels.findIndex(model =>
    model.provider === state.current?.provider && model.model === state.current.model)
  const activeModelIndex = Math.min(highlightedIndex ?? Math.max(0, currentVisibleIndex), visibleModels.length - 1)
  const selectedIndex = state.current === null
    ? -1
    : choices.findIndex(c => c.selection.provider === state.current?.provider && c.selection.model === state.current.model)
  const currentChoice = choices[selectedIndex]
  const reasoning = alternativeSelected ? undefined : currentChoice?.model.reasoning
  const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort
  const effortLabel = reasoning === undefined ? undefined : effectiveEffort === undefined
    ? t('effort.providerDefault')
    : reasoning.efforts.find(level => level.id === effectiveEffort)?.name ?? effectiveEffort
  const effortChoices = useMemo<readonly EffortChoice[]>(() => reasoning === undefined
    ? []
    : [
      ...reasoning.defaultEffort === undefined
        ? [{ key: 'provider-default', effort: undefined, label: t('effort.providerDefault') }]
        : [],
      ...reasoning.efforts.map((effort: ModelReasoningEffort) => ({
        key: `effort:${effort.id}`,
        effort: effort.id,
        label: effort.name,
      })),
    ], [reasoning, t])
  const { pending } = state
  const busy = pending !== null || alternativePending

  useEffect(() => {
    if (reasoning === undefined || locked || !available) setEffortOpen(false)
  }, [reasoning, locked, available])

  const reload = (): void => {
    lastActionRef.current = 'load'
    load()
  }

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      // The portaled card is outside the trigger subtree; check both.
      if (rootRef.current?.contains(event.target as Node) === true) return
      if (menuRef.current?.contains(event.target as Node) === true) return
      setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])

  useLayoutEffect(() => {
    if (!showSearch) {
      setQuery('')
      setHighlightedIndex(null)
    }
  }, [showSearch])

  useEffect(() => {
    const viewport = groupsRef.current
    if (viewport === null) return
    return observeStickyMenuGroups(viewport)
  }, [available, open, filteredGroups])

  useLayoutEffect(() => {
    if (open && activeModelIndex >= 0 && document.activeElement === searchRef.current) {
      if (activeModelIndex === 0 && groupsRef.current !== null) {
        groupsRef.current.scrollTop = 0
      } else {
        document.getElementById(`${id}-model-${activeModelIndex}`)?.scrollIntoView({ block: 'nearest' })
      }
    }
  }, [open, id, activeModelIndex, visibleModels])

  if (!available) return null

  const show = (): void => {
    setSelectionFocus(false)
    triggerRef.current?.focus()
    setQuery('')
    setHighlightedIndex(null)
    setEffortOpen(false)
    setOpen(true)
    reload()
  }

  const changeQuery = (next: string): void => {
    setQuery(next)
    setHighlightedIndex(0)
  }

  const close = (restoreFocus = false): void => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }

  const closeAfterSelection = (target = triggerRef.current): void => {
    setSelectionFocus(true)
    close()
    setEffortOpen(false)
    target?.focus()
  }

  const rows = (): HTMLButtonElement[] => Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>(
    'button[role="menuitem"]:not([disabled]), button[role="menuitemradio"]:not([disabled]), button[role="switch"]:not([disabled])',
  ) ?? [])

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing || !open) return
    if (event.key === 'Escape' || (event.key === 'Tab' && event.shiftKey)) {
      event.preventDefault()
      close(true)
      return
    }
    const inSearch = event.target === searchRef.current
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      if (inSearch) {
        if (!busy && visibleModels.length > 0) {
          setHighlightedIndex((activeModelIndex + direction + visibleModels.length) % visibleModels.length)
        }
        return
      }
      const items = rows()
      const active = items.findIndex(item => item === document.activeElement)
      const next = active === -1 ? (direction > 0 ? 0 : items.length - 1) : (active + direction + items.length) % items.length
      items[next]?.focus()
      return
    }
    if (inSearch && (event.key === 'Enter' || event.key === 'Tab')) {
      const highlighted = visibleModels[activeModelIndex]
      if (highlighted !== undefined) {
        event.preventDefault()
        if (!busy) choose(highlighted)
      }
      return
    }
    if (event.key !== 'Tab') return
    const focused = document.activeElement
    const items = rows()
    if (focused === triggerRef.current) {
      event.preventDefault()
      if (showSearch) searchRef.current?.focus()
      else (items.find(item => item.getAttribute('aria-checked') === 'true') ?? items[0])?.focus()
    } else if (focused instanceof HTMLButtonElement && items.includes(focused)) {
      event.preventDefault()
      focused.click()
    }
  }

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && (
      rootRef.current?.contains(event.relatedTarget) === true
      || menuRef.current?.contains(event.relatedTarget) === true
    )) return
    close()
  }

  const settleSelection = (result: Awaited<ReturnType<ModelSelectInjected['select']>>, target: HTMLButtonElement | null): void => {
    if (result === undefined) return
    if (result.ok) {
      if (rootRef.current !== null) closeAfterSelection(target)
      return
    }
    const { error } = result
    toastSeq.current += 1
    setToast({
      seq: toastSeq.current,
      text: error.code === 'session/writer-held'
        ? t('error.sessionInUse')
        : t('error.action', { message: `${error.code}: ${error.message}` }),
    })
  }

  const submit = (selection: ModelSelection, target = triggerRef.current): void => {
    if (locked || busy || choosing.current) return
    lastActionRef.current = 'select'
    // Disabled option rows cannot retain focus while a selection is pending.
    setSelectionFocus(true)
    target?.focus()
    choosing.current = true
    void select(selection).then((result) => { settleSelection(result, target) }, (error: unknown) => {
      reportFailure(t('error.action', { message: error instanceof Error ? error.message : String(error) }))
    }).finally(() => { choosing.current = false })
  }

  const reportFailure = (message: string): void => { setToast({ seq: ++toastSeq.current, text: message }) }

  const selectAlternative = (activate: () => Promise<string | null>): void => {
    if (locked || busy || choosing.current) return
    choosing.current = true
    triggerRef.current?.focus()
    setAlternativePending(true)
    void Promise.resolve().then(activate).then((failure) => {
      if (rootRef.current === null) return
      if (failure === null) closeAfterSelection()
      else reportFailure(failure)
    }, (error: unknown) => {
      if (rootRef.current !== null) reportFailure(t('error.action', { message: error instanceof Error ? error.message : String(error) }))
    }).finally(() => {
      choosing.current = false
      setAlternativePending(false)
    })
  }

  const choose = (selection: ModelSelection): void => {
    if (state.current?.provider === selection.provider && state.current.model === selection.model) {
      submit(state.current)
      return
    }
    submit(selection)
  }

  const chooseEffort = (effort: string | undefined): void => {
    if (state.current === null) return
    const selection: ModelSelection = {
      provider: state.current.provider,
      model: state.current.model,
      ...effort === undefined ? {} : { reasoningEffort: effort },
    }
    submit(selection, effortToggleRef.current)
  }

  const waiting = !alternativeSelected && currentChoice === undefined && state.status === 'loading'
  const modelLabel = alternativeLabel !== undefined ? resolveText(alternativeLabel)
    : waiting ? t('trigger.loading') : currentChoice?.model.name ?? t('trigger.fallback')
  const triggerAria = waiting
    ? t('trigger.loading')
    : currentChoice === undefined && !alternativeSelected
      ? t('trigger.selectAria')
      : t('trigger.aria', { model: modelLabel })
  const renderModelLabel = (
    provider: ModelLabelOwner['provider'], model: ModelLabelOwner['model'],
    placement: ModelLabelOwner['placement'], selected: boolean,
  ) => (
    <span data-provider-id={provider.id} data-model-id={model.id}>
      {renderSlot('conversation.input.model.label', {
        provider, model, placement, selected,
      }, {
        fallback: model.badge === undefined ? model.name : (
          <span className={css.badgedName}>
            {placement === 'trigger' ? <><Tag className={css.badge} tone={model.badge.tone}>{resolveText(model.badge.text)}</Tag>{' '}</> : null}
            <span className={css.badgedNameText}>{model.name}</span>
            {placement === 'trigger' ? null : <>{' '}<Tag className={css.badge} tone={model.badge.tone}>{resolveText(model.badge.text)}</Tag></>}
          </span>
        ),
      })}
    </span>
  )
  let modelIndex = 0
  const optionOwner = { locked: locked || busy, dismiss: () => { close(true) }, reportFailure }

  return (
    <div
      ref={rootRef}
      className={css.root}
      onKeyDown={onRootKeyDown}
      onBlur={onBlur}
      onMouseDown={(event) => {
        // WebKit blurs a focused row before click unless the button's mousedown keeps focus.
        if (event.target instanceof Element && event.target.closest('button') !== null) event.preventDefault()
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-label={triggerAria}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title={modelLabel}
        aria-busy={busy}
        data-selection-focus={selectionFocus ? '' : undefined}
        onBlur={() => { setSelectionFocus(false) }}
        disabled={locked}
        onClick={() => {
          if (open) {
            close(true)
          } else {
            show()
          }
        }}
      >
        <IconDataOutlineRegular className={css.triggerIcon} size={16} />
        <span className={css.triggerLabel}>
          {alternativeSelected || currentChoice === undefined ? modelLabel : renderModelLabel(currentChoice.group.provider, currentChoice.model, 'trigger', true)}
        </span>
        {busy
          ? <StateDot state="ongoing" />
          : <IconChevronDownOutlineRegular className={clsx(css.chevron, open && css.chevronOpen)} />}
      </button>

      {alternativeSelected && renderSlot('conversation.input.model.effort', optionOwner)}

      {reasoning !== undefined && (
        <Menu
          open={effortOpen && !locked}
          onClose={() => { setEffortOpen(false) }}
          portal side="top" align="end" autoFocus
          items={effortChoices.map(level => ({ id: level.key, label: level.label, disabled: busy }))}
          selectedId={effortChoices.find(level => level.effort === effectiveEffort)?.key}
          onSelect={(key) => {
            const level = effortChoices.find(choice => choice.key === key)
            if (level !== undefined) chooseEffort(level.effort)
          }}
          anchor={(
            <button ref={effortToggleRef} type="button" className={clsx(css.trigger, css.effortTrigger)}
              disabled={locked} aria-label={t('menu.effort')} aria-description={effortLabel}
              aria-haspopup="menu" aria-expanded={effortOpen && !locked} aria-busy={busy}
              onClick={() => {
                close()
                effortToggleRef.current?.focus()
                setEffortOpen(!effortOpen)
              }}>
              <span className={css.effortLabel}>{effortLabel}</span>
              <IconChevronDownOutlineRegular className={clsx(css.chevron, effortOpen && css.chevronOpen)} />
            </button>
          )}
        />
      )}

      {/* Portaled to body (Menu primitive's portal mode) so the sidebar and
          column overflow clips cannot crop the card; synthetic events still
          bubble through this React subtree, keeping onKeyDown/onBlur live. */}
      {open && createPortal(
        <MenuSurface
          ref={menuRef}
          id={`${id}-menu`}
          className={clsx(css.menu, flat.menu)}
          style={menuPos ?? MEASURE_STYLE}
          role="menu"
          aria-label={t('menu.aria')}
          aria-busy={state.status === 'loading' || busy}
        >
          <div className={flat.alternative}>
            {renderSlot('conversation.input.model.alternative', { ...optionOwner, selectAlternative })}
          </div>
          {showSearch && <div className={css.searchRow}>
            <Input
              ref={searchRef}
              className={clsx(css.search, query !== '' && css.searchWithQuery)}
              type="text"
              role="searchbox"
              aria-label={t('search.placeholder')}
              aria-controls={`${id}-models`}
              aria-activedescendant={activeModelIndex < 0 ? undefined : `${id}-model-${activeModelIndex}`}
              placeholder={t('search.placeholder')}
              value={query}
              readOnly={busy}
              onFocus={(event) => {
                const index = event.relatedTarget === triggerRef.current ? currentVisibleIndex : activeModelIndex
                setHighlightedIndex(Math.max(0, index))
              }}
              onChange={(event) => { changeQuery(event.target.value) }}
            />
            {query !== '' && (
              <button
                type="button"
                className={css.searchClear}
                aria-label={t('search.clear')}
                disabled={busy}
                onClick={() => {
                  changeQuery('')
                  searchRef.current?.focus()
                }}
              >
                <IconCloseFillRegular />
              </button>
            )}
          </div>}
          {state.status === 'loading' && (
            <div className={css.status}>{t('status.loading')}</div>
          )}
          {state.error !== null && lastActionRef.current === 'load' && (
            <div className={css.error}>
              <span>{t('error.action', { message: state.error })}</span>
              <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
            </div>
          )}
          {state.failures.map(failure => (
            <div className={css.warning} key={failure.id}>
              <span>{t('warning.groupLoad', { name: failure.id === 'deepseek-account' ? t('provider.account') : failure.name, message: failure.message })}</span>
              <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
            </div>
          ))}
          <div
            ref={groupsRef}
            id={`${id}-models`}
            className={clsx(flat.body, 'scrollable')}
            role="group"
            aria-label={t('menu.model')}
          >
            {filteredGroups.map((group) => {
              return (
                <MenuGroup key={group.id} label={group.provider.name}>
                  {group.models.map((model) => {
                    const index = modelIndex++
                    const selected = !alternativeSelected && state.current?.provider === group.id && state.current.model === model.id
                    const highlighted = index === activeModelIndex && highlightedIndex !== null
                    return (
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={selected}
                        id={`${id}-model-${index}`}
                        tabIndex={0}
                        onFocus={() => { setHighlightedIndex(index) }}
                        data-highlighted={highlighted ? '' : undefined}
                        className={clsx(
                          css.option, css.modelOption, selected && css.selected, highlighted && css.optionActive,
                        )}
                        onMouseMove={busy || index === activeModelIndex ? undefined : () => {
                          setHighlightedIndex(index)
                        }}
                        key={model.id}
                        title={model.name}
                        disabled={busy}
                        onClick={() => { choose({ provider: group.id, model: model.id }) }}
                      >
                        <span className={css.optionCopy}>
                          <span className={css.modelName}>{renderModelLabel(group.provider, model, 'option', selected)}</span>
                        </span>
                        <span className={css.check}>
                          {pending?.provider === group.id && pending.model === model.id
                            ? <StateDot state="ongoing" />
                            : selected ? <IconCheckOutlineRegular /> : null}
                        </span>
                      </button>
                    )
                  })}
                </MenuGroup>
              )
            })}
            {state.status === 'ready' && filteredGroups.length === 0 && (
              <div className={css.empty} role="status">{t(choices.length === 0 ? 'empty.models' : 'search.empty')}</div>
            )}
          </div>
          <div className={clsx(flat.utilities, 'scrollable')}>
            {renderSlot('conversation.input.model.options', { ...optionOwner, flatMenu: true })}
          </div>
        </MenuSurface>,
        document.body,
      )}
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutlineRegular />}
          anchor={rootRef.current?.closest<HTMLElement>('[data-composer-card]') ?? null}
          onDone={() => { setToast(null) }}
        />
      )}
    </div>
  )
}
