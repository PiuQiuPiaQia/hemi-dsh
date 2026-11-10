/** Remote folder selection inside the connection editor; transport values remain in the resource model. */
import { useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SshServerInput } from '@deepseek-ai/dsh-hemi-ssh-servers/types'
import type { ServerOverlayProps } from './types.ts'
import { directoryHistoryKey, EMPTY_DIRECTORY_HISTORY, endpointLabel, invalidFields, serverInput } from './draft.ts'
import { editorDirectoryAddress } from './editor-directories.ts'
import { connectionDiagnostic, connectionProblem } from './connection-problem.ts'
import { RemoteDirectoryPicker } from './RemoteDirectoryPicker.tsx'
import css from './servers.module.css'

interface Query { readonly input: SshServerInput; readonly path: string; readonly request: number }
type Props = ServerOverlayProps & { readonly fieldId: string; readonly invalid: boolean; readonly writable: boolean }

/**
 * Edit or choose the preferred remote directory without saving staged connection fields.
 * @param props - registered editor state, access hooks and field identifiers.
 * @returns the directory field and its explicitly opened remote picker.
 */
export function DirectoryField(props: Props) {
  const { t } = props
  const state = props.useStore(value => value)
  const canBrowse = props.useRemoteAccess('hemiSshWorkspaces/browseServer')
  const [query, setQuery] = useState<Query | null>(null)
  const input = serverInput(state.draft)
  const matching = query !== null && directoryHistoryKey(query.input) === directoryHistoryKey(input)
  const browse = (path: string): void => {
    if (!props.writable || !canBrowse || state.busy) return
    if (invalidFields(state.draft).length > 0) { props.actions.validateFields(); return }
    setQuery(previous => ({ input, path, request: (previous?.request ?? 0) + 1 }))
  }
  return <div className={css.directoryField}>
    <div className={css.field}>
      <label className={css.fieldLabel} htmlFor={props.fieldId}>{t('directory')}</label>
      <div className={css.directoryInput}>
        <Input id={props.fieldId} value={state.draft.directory} aria-label={t('directory')}
          aria-invalid={props.invalid} aria-describedby={props.invalid ? `${props.fieldId}-help` : undefined} readOnly={!props.writable}
          disabled={state.busy} maxLength={4096} autoComplete="off" spellCheck={false} className={css.input}
          placeholder={t('remotePathPlaceholder')}
          onChange={(event) => { props.actions.setField('directory', event.currentTarget.value) }} />
        {props.writable && <Button variant="outline" disabled={state.busy || !canBrowse} aria-expanded={matching} aria-haspopup="dialog"
          onClick={() => { if (matching) setQuery(null); else browse(state.draft.directory.trim()) }}>{t('chooseDirectory')}</Button>}
      </div>
      {props.invalid && <span id={`${props.fieldId}-help`} className={css.fieldError}>{t('directoryError')}</span>}
    </div>
    {matching && <DirectoryPickerResource {...props} query={query} onBrowse={browse}
      onUse={(path) => { props.actions.setField('directory', path); setQuery(null) }} onCancel={() => { setQuery(null) }} />}
  </div>
}

type BrowserProps = Props & { query: Query; onBrowse: (path: string) => void; onUse: (path: string) => void; onCancel: () => void }

function DirectoryPickerResource(props: BrowserProps) {
  const { t, query } = props
  const resource = props.useResource<'hemi-ssh-editor-folders'>(editorDirectoryAddress(query.input, query.path, query.request))
  const state = props.useStore(value => value)
  const historyKey = directoryHistoryKey(query.input)
  const recentPaths = props.useStore(value => value.directoryHistory[historyKey] ?? EMPTY_DIRECTORY_HISTORY)
  const ready = resource.status === 'live'
  const directory = resource.value
  const canBrowse = props.useRemoteAccess('hemiSshWorkspaces/browseServer')
  const navigationDisabled = state.busy || !props.writable || !canBrowse || resource.status === 'none'
  const problem = resource.status === 'failed' ? t(connectionProblem(resource.failure))
    : resource.status === 'none' ? t('folderUnavailable') : undefined
  const remember = (): void => {
    if (ready && directory !== undefined) props.actions.rememberDirectory(historyKey, directory.path)
  }
  return <RemoteDirectoryPicker hostLabel={endpointLabel(query.input)} initialPath={query.path} preferredPath={query.input.directory}
    recentPaths={recentPaths} directory={directory} navigationRevision={query.request} pending={resource.status === 'loading'}
    ready={ready} navigationDisabled={navigationDisabled} busy={state.busy} canConfirm={ready && !navigationDisabled}
    problem={problem} diagnostic={connectionDiagnostic(resource.failure)} t={t} onCancel={props.onCancel}
    onNavigate={(path) => { if (!navigationDisabled) { remember(); props.onBrowse(path) } }}
    onConfirm={(path) => { if (ready && !navigationDisabled) { remember(); props.onUse(path) } }} />
}
