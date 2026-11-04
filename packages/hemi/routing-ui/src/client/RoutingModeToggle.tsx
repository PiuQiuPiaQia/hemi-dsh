/** Session-owned automatic-routing switch inside the native model menu. */
import { useId, useState } from 'react'
import { Button, IconCheckOutlineRegular, IconSettingsOutlineRegular, StateDot, Switch, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { RoutingConfig } from './types.ts'
import type { NS } from './locales.ts'
import css from './RoutingModeToggle.module.css'

/** Narrow commands and settings observation for one Session. */
export interface RoutingModeInjected {
  hooks: { routingSettings: HostObservable<ConfigFormSnapshot<RoutingConfig>> }
  /** Null means accepted; failures remain owned by the model menu. */
  setEnabled: (enabled: boolean) => Promise<string | null>
  /** Open the shared editor after the owner has dismissed its menu. */
  openConfiguration: () => void
}

/** Derived model-menu slot props. */
export type RoutingModeProps = PropsRuntime<'conversation.input.model.options'>
  & PropsLocale<typeof NS> & InjectFace<RoutingModeInjected>

/**
 * Hide independent routing controls in addressed and listed child Sessions.
 * @param props - Session hooks, menu ownership, settings and commands.
 * @returns the root Session's switch when the plugin settings are available.
 */
export function RoutingModeToggle(props: RoutingModeProps) {
  const addressedChild = props.useSession(snapshot => snapshot.subagent !== null)
  const listedChild = props.useSessions(state => state.byId[props.sessionId]?.origin === 'subagent')
  if (props.flatMenu || addressedChild || listedChild) return null
  return <RootRoutingModeToggle {...props} />
}

/** Derived props for the first radio option in Hemi's model menu. */
export type RoutingModeChoiceProps = PropsRuntime<'conversation.input.model.alternative'>
  & PropsLocale<typeof NS> & InjectFace<RoutingModeInjected>

/**
 * Offer automatic routing as an alternative to a concrete model.
 * @param props - Session hooks, picker actions and saved settings.
 * @returns the automatic option and a separate configuration action.
 */
export function RoutingModeChoice(props: RoutingModeChoiceProps) {
  const {
    sessionId, useRoutingSettings, locked, dismiss, selectAlternative, setEnabled, openConfiguration, t,
  } = props
  const addressedChild = props.useSession(snapshot => snapshot.subagent !== null)
  const listedChild = props.useSessions(state => state.byId[sessionId]?.origin === 'subagent')
  const settings = useRoutingSettings(value => value)
  const hintId = useId()
  if (addressedChild || listedChild || settings.status === 'unavailable') return null
  const enabled = settings.status === 'ready' && settings.value?.sessionModes?.[sessionId] === true
  const hasMain = settings.status === 'ready' && settings.value?.main != null
  return (
    <div className={css.choiceRow} data-routing-mode={enabled ? 'auto' : 'fixed'}>
      <button type="button" role="menuitemradio" className={css.choice} aria-checked={enabled}
        aria-label={t('auto')} aria-describedby={!hasMain && !enabled ? hintId : undefined}
        title={t('autoDescription')} disabled={locked || (!enabled && (!settings.writable || !hasMain))}
        onClick={() => {
          if (enabled) {
            dismiss()
            return
          }
          selectAlternative(async () => {
            const failure = await setEnabled(true)
            return failure === null ? null : t('modeFailed', { message: failure })
          })
        }}>
        <span className={css.copy}>
          <span>{t('auto')}</span>
          {!hasMain && !enabled && <span id={hintId} className={css.hint}>{t('needsMain')}</span>}
        </span>
        {enabled && <IconCheckOutlineRegular className={css.choiceCheck} aria-hidden="true" />}
      </button>
      <Tooltip label={t('configure')} side="top" delayMs={300} portal>
        <Button variant="ghost" size="sm" role="menuitem" className={css.gear} aria-label={t('configure')}
          onClick={() => { dismiss(); openConfiguration() }}>
          <IconSettingsOutlineRegular size={14} aria-hidden="true" />
        </Button>
      </Tooltip>
    </div>
  )
}

function RootRoutingModeToggle({
  sessionId, useRoutingSettings, locked, dismiss, reportFailure, setEnabled, openConfiguration, t,
}: RoutingModeProps) {
  const settings = useRoutingSettings(value => value)
  const [pending, setPending] = useState(false)
  if (settings.status === 'unavailable') return null
  const enabled = settings.status === 'ready' && settings.value?.sessionModes?.[sessionId] === true
  const hasMain = settings.status === 'ready' && settings.value?.main != null
  const select = (enabled: boolean): void => {
    if (locked || pending || !settings.writable || (enabled && !hasMain)) return
    setPending(true)
    void setEnabled(enabled).then((failure) => {
      if (failure !== null) reportFailure(t('modeFailed', { message: failure }))
    }, (error: unknown) => {
      reportFailure(t('modeFailed', { message: error instanceof Error ? error.message : String(error) }))
    }).finally(() => { setPending(false) })
  }
  return (
    <div className={css.row} data-routing-mode={enabled ? 'auto' : 'fixed'} aria-busy={pending}>
      <div className={css.copy}>
        <span>{t('auto')}</span>
        {!hasMain && !enabled && <span className={css.hint}>{t('needsMain')}</span>}
      </div>
      <Tooltip label={t('configure')} side="top" delayMs={300} portal>
        <Button variant="ghost" size="sm" role="menuitem" className={css.gear} aria-label={t('configure')}
          onClick={() => { dismiss(); openConfiguration() }}>
          <IconSettingsOutlineRegular size={14} aria-hidden="true" />
        </Button>
      </Tooltip>
      <span className={css.state}>
        {pending && <StateDot state="ongoing" />}
        <Switch checked={enabled} label={t('auto')} title={t('autoDescription')}
          disabled={locked || pending || !settings.writable || (!enabled && !hasMain)} onChange={select} />
      </span>
    </div>
  )
}
