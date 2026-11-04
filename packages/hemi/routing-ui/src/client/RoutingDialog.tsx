/** One root overlay shared by the model menu and the Models settings footer. */
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { RoutingEditorInjected } from './types.ts'
import type { NS } from './locales.ts'
import { RoutingSaveStatus, RoutingSection } from './RoutingSection.tsx'
import css from './RoutingSection.module.css'

/** Root-owned open state plus the editor's shared observations. */
export interface RoutingDialogInjected extends RoutingEditorInjected {
  hooks: RoutingEditorInjected['hooks'] & { routingOpen: HostObservable<boolean> }
  closeConfiguration: () => void
}

/** Derived shell-overlay props. */
export type RoutingDialogProps = PropsRuntime<'shell.overlay'> & InjectFace<RoutingDialogInjected> & PropsLocale<typeof NS>

/**
 * Render configuration outside the model menu so dismissing it cannot remove the editor.
 * @param props - Shared open state, settings, commands and localized copy.
 * @returns the standard Modal while configuration is open.
 */
export function RoutingDialog(props: RoutingDialogProps) {
  const open = props.useRoutingOpen(value => value)
  return (
    <Modal open={open} title={props.t('title')} description={props.t('description')} closeLabel={props.t('close')}
      onClose={props.closeConfiguration} className={css.dialog ?? ''} contentClassName={`${css.dialogContent} scrollable`}
      footer={<div className={css.dialogFooter}><RoutingSaveStatus useRoutingWrite={props.useRoutingWrite} t={props.t} /><Button variant="primary" onClick={props.closeConfiguration}>{props.t('done')}</Button></div>}>
      {open && <RoutingSection {...props} />}
    </Modal>
  )
}
