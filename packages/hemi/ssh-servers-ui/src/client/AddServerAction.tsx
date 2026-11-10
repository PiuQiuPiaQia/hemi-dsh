/** Saved-connection creation remains below the native Workspace action. */
import { IconGlobeOutlineRegular, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AddServerProps } from './types.ts'

/**
 * Open the existing connection editor without creating a directory Workspace.
 * @param props - native menu dismissal, permissions and registered editor state.
 * @returns one ordinary menu action, or none without read/write access.
 */
export function AddServerAction({ onDismiss, disabled, actions, useStore, useRemoteAccess, t }: AddServerProps) {
  const busy = useStore(state => state.busy)
  const canCreate = useRemoteAccess('hemiSshServers/create')
  const canList = useRemoteAccess('hemiSshServers/list')
  if (!canCreate || !canList) return null
  return <MenuItemButton icon={<IconGlobeOutlineRegular />} disabled={disabled || busy} onSelect={() => {
    onDismiss()
    actions.open({ kind: 'create' })
  }}>{t('add')}</MenuItemButton>
}
