/** Root-owned remote directory selection; its resource remains independent of the picker presentation. */
import type { EditorRequest, FolderOverlayProps } from './types.ts'
import { foldersAddress } from './addresses.ts'
import { directoryHistoryKey, EMPTY_DIRECTORY_HISTORY, endpointLabel } from './draft.ts'
import { connectionDiagnostic, connectionProblem } from './connection-problem.ts'
import { RemoteDirectoryPicker } from './RemoteDirectoryPicker.tsx'

type Request = Extract<EditorRequest, { kind: 'folder' }>

/**
 * Render the captured connection's directory picker, independent of sidebar lifetime.
 * @param props - registered interaction state, remote resources and owned commands.
 * @returns one directory picker, or no active folder selection.
 */
export function FolderOverlay(props: FolderOverlayProps) {
  const request = props.useStore(state => state.request)
  return request?.kind === 'folder' ? <FolderDialog key={request.selection} {...props} request={request} /> : null
}

function FolderDialog(props: FolderOverlayProps & { request: Request }) {
  const { request, t } = props
  const state = props.useStore(value => value)
  const historyKey = directoryHistoryKey(request.server)
  const recentPaths = props.useStore(value => value.directoryHistory[historyKey] ?? EMPTY_DIRECTORY_HISTORY)
  const folders = props.useResource<'hemi-ssh-folders'>(foldersAddress(request.server.id, request.selection))
  const desired = props.useDirectoryRequest(value => value)
  const canBrowse = props.useRemoteAccess('hemiSshWorkspaces/browseSavedFolders')
  const canPrepare = props.useRemoteAccess('hemiSshWorkspaces/prepareServerFolder')
  const canCreate = props.useRemoteAccess('workspace/create')
  const directory = folders.value?.directory ?? undefined
  const pending = folders.status === 'loading' || folders.status === 'live' && folders.value?.request !== desired
  const current = folders.status === 'live' && folders.value?.request === desired && directory !== undefined
  const changed = folders.failure?.code === 'hemi-ssh/connection-changed'
  const navigationDisabled = state.busy || !canBrowse || changed || folders.status === 'none'
  const problem = folders.status === 'failed' ? changed ? 'runtimeChanged' : connectionProblem(folders.failure)
    : folders.status === 'none' || folders.status === 'live' && !pending && directory === undefined ? 'folderUnavailable' : state.problem
  const remember = (): void => {
    if (current && !pending) props.actions.rememberDirectory(historyKey, directory.path)
  }
  return <RemoteDirectoryPicker hostLabel={endpointLabel(request.server)} initialPath={request.server.directory ?? ''}
    preferredPath={request.server.directory} recentPaths={recentPaths} directory={directory} navigationRevision={desired}
    pending={pending} ready={current} navigationDisabled={navigationDisabled} busy={state.busy}
    canConfirm={!state.busy && !pending && current && canPrepare && canCreate}
    problem={problem === null ? undefined : t(problem)} diagnostic={connectionDiagnostic(folders.failure)} t={t}
    onNavigate={(path) => { if (!navigationDisabled) { remember(); props.browse(request.selection, path) } }}
    onCancel={props.closeFolder} onConfirm={(path) => {
      if (!current || pending || state.busy || !canPrepare || !canCreate) return
      remember()
      props.actions.begin()
      props.openFolder(request.selection, path)
    }} />
}
