/** Shared remote directory picker; resource reads and directory ownership stay with its caller. */
import { useRef, useState } from 'react'
import {
  Button, IconChevronRightOutlineRegular, IconChevronUpOutlineRegular, IconFolderCloseRegular,
  IconGlobeOutlineRegular, Input, Modal, StateDot, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SshRemoteDirectory } from '@deepseek-ai/dsh-hemi-ssh-servers/workspace-types'
import type { SharedProps } from './types.ts'
import css from './RemoteDirectoryPicker.module.css'

/** Presentational inputs; no directory operation or cached listing belongs to the picker. */
export interface RemoteDirectoryPickerProps {
  readonly hostLabel: string
  readonly initialPath: string
  readonly preferredPath: string | undefined
  readonly recentPaths: readonly string[]
  readonly directory: SshRemoteDirectory | undefined
  readonly navigationRevision: number
  readonly pending: boolean
  readonly ready: boolean
  readonly navigationDisabled: boolean
  readonly canConfirm: boolean
  readonly busy: boolean
  readonly problem: string | undefined
  readonly diagnostic: string | undefined
  readonly t: SharedProps['t']
  readonly onNavigate: (path: string) => void
  readonly onConfirm: (path: string) => void
  readonly onCancel: () => void
}

interface PathDraft {
  readonly value: string
  readonly revision: number
  readonly submitted: boolean
}

/**
 * Show the remote host, address bar, common locations and one browsable directory level.
 * @param props - resource-owned directory data, interaction state and owner commands.
 * @returns a shared Modal whose confirmation uses only the successful, unchanged path.
 */
export function RemoteDirectoryPicker(props: RemoteDirectoryPickerProps) {
  const { directory, preferredPath, t } = props
  const entries = directory?.directories.filter(entry => !entry.name.startsWith('.')) ?? []
  const [draft, setDraft] = useState<PathDraft | null>(null)
  const composing = useRef(false)
  // A completed navigation supplies the canonical spelling without overwriting a newer edit.
  const landed = draft?.submitted === true && props.ready && props.navigationRevision !== draft.revision
  const path = draft === null || landed ? directory?.path ?? props.initialPath : draft.value
  const canConfirm = props.canConfirm && props.ready && !props.pending && !props.busy
    && directory !== undefined && path === directory.path
  const navigate = (target: string): void => {
    if (props.navigationDisabled || props.busy) return
    setDraft({ value: target, revision: props.navigationRevision, submitted: true })
    props.onNavigate(target)
  }
  const submitPath = (): void => { if (path.trim() !== '') navigate(path) }
  const recent = [...new Set(props.recentPaths)].filter(value => value !== preferredPath).slice(0, 3)
  const disabled = props.navigationDisabled || props.busy
  return <Modal open title={t('folderTitle')} closeLabel={t('close')} onClose={props.onCancel}
    className={css.dialog ?? ''} contentClassName={`${css.content} scrollable`}
    footer={<>
      <Button variant="outline" onClick={props.onCancel}>{t('cancel')}</Button>
      <Button variant="primary" disabled={!canConfirm} aria-busy={props.busy}
        onClick={() => { if (canConfirm) props.onConfirm(directory.path) }}>
        {t(props.busy ? 'openingFolder' : 'useDirectory')}
      </Button>
    </>}>
    <div className={css.body}>
      <p className={css.host}><IconGlobeOutlineRegular size={14} /><span>{props.hostLabel}</span></p>
      <form className={css.address} onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); submitPath() }}>
        <Tooltip label={t('parentFolder')}>
          <Button variant="ghost" className={css.parent} aria-label={t('parentFolder')}
            disabled={disabled || props.pending || directory === undefined || directory.parentPath === directory.path}
            onClick={() => { if (directory !== undefined) navigate(directory.parentPath) }}>
            <IconChevronUpOutlineRegular size={16} />
          </Button>
        </Tooltip>
        <Input className={css.pathInput} aria-label={t('remotePath')} value={path} disabled={disabled}
          placeholder={t('remotePathPlaceholder')} maxLength={4096} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
          onChange={(event) => { setDraft({ value: event.currentTarget.value, revision: props.navigationRevision, submitted: false }) }}
          onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault(); event.stopPropagation()
            // oxlint-disable-next-line typescript/no-deprecated -- IME 229 covers engines without isComposing.
            if (!composing.current && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) submitPath()
          }} />
        <Button type="submit" variant="outline" disabled={disabled || path.trim() === ''}>{t('goToFolder')}</Button>
      </form>
      <nav className={css.shortcuts} aria-label={t('folderLocations')}>
        {preferredPath !== undefined && preferredPath !== '' && <Button size="sm" variant="ghost" disabled={disabled}
          onClick={() => { navigate(preferredPath) }}>{t('preferredFolder')}</Button>}
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => { navigate('') }}>{t('homeFolder')}</Button>
        {recent.map(value => <Tooltip key={value} label={value} onlyWhenClipped>
          <Button size="sm" variant="ghost" className={css.shortcut} disabled={disabled}
            onClick={() => { navigate(value) }}>{value.split('/').filter(Boolean).at(-1) ?? '/'}</Button>
        </Tooltip>)}
      </nav>
      <section className={`${css.folders} scrollable`} aria-label={t('currentFolder')} aria-busy={props.pending}>
        {props.pending && directory === undefined && <div role="status" aria-label={t('browseLoading')}>
          {[0, 1, 2].map(row => <div key={row} className={css.skeleton} aria-hidden="true"><span /><span /></div>)}
        </div>}
        {props.problem !== undefined && <div className={directory === undefined ? css.failure : css.notice}>
          <p className={css.problem} role="alert">{props.problem}</p>
          {props.diagnostic !== undefined && <p className={css.diagnostic}>{props.diagnostic}</p>}
        </div>}
        {directory !== undefined && <>
          <ul className={css.list}>
            {entries.map(entry => <li key={entry.path}>
              <button type="button" className={css.row} disabled={disabled || props.pending}
                aria-label={t('enterFolder', { name: entry.name })} onClick={() => { navigate(entry.path) }}>
                <IconFolderCloseRegular size={16} /><span>{entry.name}</span><IconChevronRightOutlineRegular size={14} />
              </button>
            </li>)}
          </ul>
          {entries.length === 0 && <p className={css.empty}>{t('noSubfolders')}</p>}
          {props.pending && <span className={css.pending} role="status" aria-label={t('browseLoading')}><StateDot state="ongoing" /></span>}
        </>}
      </section>
    </div>
  </Modal>
}
