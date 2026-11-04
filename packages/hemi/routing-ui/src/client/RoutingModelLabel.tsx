/** Non-interactive model labels preserve the native catalog badge semantics. */
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { RoutingConfig } from './types.ts'
import type { ModelLabelOwner } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { NS } from './locales.ts'
import css from './RoutingModelLabel.module.css'

/** Locale resolution remains owned by the shared locale service. */
export interface RoutingLabelInjected {
  hooks: { routingSettings: HostObservable<ConfigFormSnapshot<RoutingConfig>> }
  resolveText: (text: NonNullable<ModelLabelOwner['model']['badge']>['text']) => string
}

/** Derived inline label props. */
export type RoutingLabelProps = PropsRuntime<'conversation.input.model.label'> & PropsLocale<typeof NS> & InjectFace<RoutingLabelInjected>

/**
 * Change only the root Session's trigger caption while automatic routing is on.
 * @param props - Catalog owner data, profile preference and localized badge resolver.
 * @returns automatic-routing text or the original model name and badge.
 */
export function RoutingModelLabel(props: RoutingLabelProps) {
  const addressedChild = props.useSession(snapshot => snapshot.subagent !== null)
  const listedChild = props.useSessions(state => state.byId[props.sessionId]?.origin === 'subagent')
  if (addressedChild || listedChild) return <CatalogModelLabel {...props} />
  return <RootRoutingModelLabel {...props} />
}

function RootRoutingModelLabel(props: RoutingLabelProps) {
  const enabled = props.useRoutingSettings(snapshot => snapshot.status === 'ready'
    && snapshot.value?.sessionModes?.[props.sessionId] === true)
  if (enabled && props.placement === 'trigger') return <span data-routing-label="auto">{props.t('auto')}</span>
  return <CatalogModelLabel {...props} />
}

/** Native badge order: leading in the trigger, trailing in menus and options. */
function CatalogModelLabel({ model, placement, resolveText }: Pick<RoutingLabelProps, 'model' | 'placement' | 'resolveText'>) {
  if (model.badge === undefined) return <>{model.name}</>
  const badge = <Tag className={css.badge} tone={model.badge.tone}>{resolveText(model.badge.text)}</Tag>
  return (
    <span className={css.badgedName}>
      {placement === 'trigger' && <>{badge}{' '}</>}
      <span className={css.name}>{model.name}</span>
      {placement !== 'trigger' && <>{' '}{badge}</>}
    </span>
  )
}
