/** Four conversation-scoped effort choices for automatic model routing. */
import type {} from './model-picker/slots.ts'
import { useRef, useState } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { HemiRoutingEffort } from '@deepseek-ai/dsh-hemi-routing/client'
import type { RoutingConfig } from './types.ts'
import type { NS } from './locales.ts'
import css from './model-picker/ModelSelect.module.css'

/** Saved settings and command supplied by the routing registration. */
export interface RoutingEffortInjected {
  hooks: { routingSettings: HostObservable<ConfigFormSnapshot<RoutingConfig>> }
  /** Save the choice without changing automatic routing mode. */
  setEffort: (effort: HemiRoutingEffort) => Promise<string | null>
}

/** Rendered routing effort bindings, including the model-menu owner's failure surface. */
export type RoutingEffortProps = InjectFace<RoutingEffortInjected> & PropsLocale<typeof NS>
  & Pick<PropsRuntime<'conversation.input.model.effort'>, 'sessionId' | 'locked' | 'reportFailure'>

/**
 * Show accepted values and report rejected saves through the composer owner.
 * @param props - conversation settings, locale and persistence bindings.
 * @returns the independent routing effort button and menu.
 */
export function RoutingEffortSelect({ sessionId, locked, reportFailure, useRoutingSettings, setEffort, t }: RoutingEffortProps) {
  const settings = useRoutingSettings(value => value)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const choosing = useRef(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const level = settings.status === 'ready'
    ? settings.value?.sessionEfforts?.[sessionId] ?? settings.value?.defaultReasoningEffort ?? 'high' : 'high'
  const disabled = locked || settings.status !== 'ready' || !settings.writable
  const levels = ['low', 'medium', 'high', 'max'] as const
  const save = async (next: HemiRoutingEffort): Promise<void> => {
    if (disabled || choosing.current) return
    trigger.current?.focus()
    if (next === level) { setOpen(false); return }
    choosing.current = true
    setPending(true)
    try {
      const failure = await setEffort(next)
      if (failure === null) setOpen(false)
      else reportFailure(t('effort.failed', { message: failure }))
    } catch (error) {
      reportFailure(t('effort.failed', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      choosing.current = false
      setPending(false)
    }
  }
  return <Menu open={open && !disabled} onClose={() => { setOpen(false) }} portal side="top" align="end" autoFocus
    selectedId={level} items={levels.map(id => ({ id, label: t(`effort.${id}`), disabled: pending }))}
    onSelect={(id) => { const next = levels.find(level => level === id); if (next !== undefined) void save(next) }}
    anchor={<button ref={trigger} type="button" className={clsx(css.trigger, css.effortTrigger)}
      disabled={disabled} aria-label={t('effort.label')} aria-description={t(`effort.${level}`)}
      aria-haspopup="menu" aria-expanded={open && !disabled} aria-busy={pending}
      onClick={() => { trigger.current?.focus(); setOpen(!open) }}>
      <span className={css.effortLabel}>{t(`effort.${level}`)}</span>
      <IconChevronDownOutlineRegular className={clsx(css.chevron, open && css.chevronOpen)} />
    </button>}
  />
}
