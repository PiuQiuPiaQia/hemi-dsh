/** Saved SSH connections in the workspace picker, separate from actual folder workspaces. */
import {
  IconGlobeOutlineRegular, MenuGroup, MenuItemButton,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SshServer } from '@deepseek-ai/dsh-hemi-ssh-servers/types'
import type {} from '@deepseek-ai/dsh-hemi-ssh-servers/remote'
import type { ContextMenuTargetMap } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type { SharedProps } from './types.ts'
import { endpointLabel } from './draft.ts'
import { SERVER_ADDRESS } from './addresses.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/types'
import css from './servers.module.css'

declare module '@deepseek-ai/dsh-client-ui-context-menu/client' {
  interface ContextMenuTargetMap {
    /** Saved connection and gesture identity; callbacks remain in the root owner. */
    'hemi-ssh-connection': {
      readonly server: SshServer
      readonly occurrence: number
    }
  }
}

/** Parent-owned transitions; no callback treats a connection identity as a Workspace identity. */
export interface ConnectionPickerInjected {
  /** Begin real remote-folder selection for the chosen saved connection. */
  openConnection: (server: SshServer, onPicked: (workspaceId: WorkspaceId) => void) => void
  /** Capture root-owned commands for the current context-menu gesture. */
  menuTarget: (server: SshServer, dismiss: () => void) => ContextMenuTargetMap['hemi-ssh-connection']
  /** Reread the authoritative saved-connection resource. */
  refresh: () => void
}

/** Framework owner, interaction store, locale and injected transition shares. */
export type ConnectionPickerProps = PropsRuntime<'conversation.hero.workspace.connections'>
  & SharedProps & InjectFace<ConnectionPickerInjected>

/**
 * Contribute saved connections without creating or selecting a folder Workspace.
 * @param props - Picker ownership, resource reads and parent-owned transitions.
 * @returns Saved connection choices, or no group without read access.
 */
export function ConnectionPicker(props: ConnectionPickerProps) {
  const allowed = props.useRemoteAccess('hemiSshServers/list')
  if (!allowed) return null
  return <ConnectionResourcePicker {...props} />
}

function ConnectionResourcePicker(props: ConnectionPickerProps) {
  const resource = props.useResource<'hemi-ssh-servers'>(SERVER_ADDRESS)
  const busy = props.useStore(state => state.busy)
  const canEdit = props.useRemoteAccess('hemiSshServers/update')
  const canRemove = props.useRemoteAccess('hemiSshServers/removeServer')
  const { getTriggerProps } = props.useContextMenu()
  const disabled = props.disabled || busy
  const servers = resource.value ?? []
  const canManage = canEdit || canRemove
  if (resource.status === 'none' || (resource.status === 'live' && servers.length === 0)) return null
  const choose = (server: SshServer, action: (connection: SshServer) => void): void => {
    props.onDismiss()
    action(server)
  }
  return <MenuGroup label={props.t('connections')}>
    {resource.status === 'loading' && <div role="status" aria-label={props.t('connectionsLoading')}>
      {[0, 1].map(row => <div key={row} className={css.skeleton} aria-hidden="true"><span /><span /></div>)}
    </div>}
    {resource.status === 'failed' && <>
      <div className={css.readError} role="alert">{props.t('connectionsReadFailed')}</div>
      <MenuItemButton disabled={disabled} onSelect={props.refresh}>{props.t('retry')}</MenuItemButton>
    </>}
    {servers.map((server) => {
      // The inner menu button owns the keyboard stop; its wrapper only forwards gestures.
      const { onContextMenu, onKeyDown } = getTriggerProps(disabled || !canManage ? undefined : () => {
        return { kind: 'hemi-ssh-connection', value: props.menuTarget(server, props.onDismiss) }
      })
      return <div key={server.id} onContextMenu={onContextMenu} onKeyDown={onKeyDown}>
        <MenuItemButton icon={<IconGlobeOutlineRegular />} disabled={disabled}
          onSelect={() => { choose(server, (value) => { props.openConnection(value, props.onPicked) }) }}>
          <span className={css.rowCopy}>
            <span className={css.rowName}>{server.name}</span>{' '}
            <span className={css.endpoint}>{endpointLabel(server)}</span>
          </span>
        </MenuItemButton>
      </div>
    })}

  </MenuGroup>
}
