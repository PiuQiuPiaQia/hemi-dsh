/** Root-owned modal and operation feedback, independent of the menu and sidebar lifetime. */
import { useId, useRef } from 'react'
import {
  Button, IconWarningOutlineRegular, Input, isMobileDevice, Modal, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ServerDraft, ServerOverlayProps } from './types.ts'
import { DirectoryField } from './DirectoryField.tsx'
import { FIELDS, invalidFields, serverInput } from './draft.ts'
import css from './servers.module.css'

const FIELD_ERROR = {
  name: 'nameError', address: 'addressError', port: 'portError', identityFile: 'identityFileError', directory: 'directoryError',
} as const

/**
 * Present the shared editor and operation feedback independently of sidebar visibility.
 * @param props - Shared draft and lifecycle-owned commands.
 * @returns Modal plus toast, never a connection indicator.
 */
export function ServerOverlay(props: ServerOverlayProps) {
  const state = props.useStore(value => value)
  const canCreate = props.useRemoteAccess('hemiSshServers/create')
  const canEdit = props.useRemoteAccess('hemiSshServers/update')
  const canRemove = props.useRemoteAccess('hemiSshServers/removeServer')
  const id = useId()
  const composing = useRef(false)
  const request = state.request?.kind === 'folder' ? null : state.request
  const writable = request?.kind === 'create' ? canCreate : request?.kind === 'remove' ? canRemove : canEdit
  const conflict = state.problem === 'conflict' || state.problem === 'notFound' || state.problem === 'credentialCleanupFailed'
  const invalid = invalidFields(state.draft)
  const fieldInvalid = (field: keyof ServerDraft): boolean => (state.validate && invalid.includes(field)) || state.invalidField === field
  const fieldId = (field: keyof ServerDraft): string => `${id}-${field}`
  const close = (): void => {
    if (state.busy) return
    props.actions.close()
    if (state.problem !== null) props.refresh()
  }
  const submit = (): void => {
    if (request === null || state.busy || !writable || conflict) return
    if (request.kind === 'remove') {
      props.actions.begin()
      props.remove(request.server)
      return
    }
    props.actions.validateFields()
    const [firstInvalid] = invalid
    if (firstInvalid !== undefined) {
      document.getElementById(fieldId(firstInvalid))?.focus()
      return
    }
    props.actions.begin()
    props.save(request.kind === 'create' ? null : request.server, serverInput(state.draft))
  }
  const title = request?.kind === 'remove' ? props.t('removeTitle')
    : request?.kind === 'create' ? props.t('addTitle') : props.t(writable ? 'editTitle' : 'view')
  const field = (name: keyof ServerDraft, optional = false) => <label className={css.field} key={name} htmlFor={fieldId(name)}>
    <span className={css.fieldLabel}>{props.t(name)}{optional && <span className={css.optional}>{props.t('optional')}</span>}</span>
    <Input id={fieldId(name)} name={name} className={css.input} value={state.draft[name]}
      disabled={state.busy} readOnly={!writable} aria-label={props.t(name)} aria-required={!optional} aria-invalid={fieldInvalid(name)}
      aria-describedby={[
        name === 'address' || optional ? `${fieldId(name)}-help` : '',
        name === 'identityFile' ? `${id}-key-help` : '',
        fieldInvalid(name) ? `${fieldId(name)}-error` : '',
      ].filter(Boolean).join(' ') || undefined}
      inputMode={name === 'port' ? 'numeric' : name === 'address' ? 'email' : 'text'} autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false}
      maxLength={{ name: 120, address: 382, port: 5, identityFile: 4096, directory: 4096 }[name]}
      placeholder={name === 'name' ? props.t('namePlaceholder') : name === 'address' ? props.t('addressPlaceholder')
        : name === 'identityFile' ? props.t('keyPlaceholder') : undefined}
      {...name === 'name' && !isMobileDevice() ? { 'data-modal-autofocus': true } : {}}
      onChange={(event) => { props.actions.setField(name, event.currentTarget.value) }} />
    {name === 'address' && <span id={`${fieldId(name)}-help`} className={css.help}>{props.t('addressHelp')}</span>}
    {optional && <span id={`${fieldId(name)}-help`} className={css.help}>{props.t('inherited')}</span>}
    {fieldInvalid(name) && <span id={`${fieldId(name)}-error`} className={css.fieldError}>{props.t(FIELD_ERROR[name])}</span>}
  </label>
  const successful = state.notice !== null
    && (state.notice.key === 'saved' || state.notice.key === 'removed' || state.notice.key === 'folderOpened')
  return <>
    <Modal open={request !== null} title={title} closeLabel={props.t('close')} onClose={close}
      className={css.dialog ?? ''} contentClassName={`${css.dialogContent} scrollable`}
      description={request?.kind === 'remove' ? props.t('removeDescription', { name: request.server.name }) : props.t('description')}
      footer={<>
        <Button variant="outline" disabled={state.busy} onClick={close}>{props.t(state.problem !== null ? 'closeRefresh' : writable ? 'cancel' : 'close')}</Button>
        {writable && <Button variant={request?.kind === 'remove' ? 'outline' : 'primary'}
          className={request?.kind === 'remove' ? css.removeButton : undefined}
          type="submit" form={`${id}-form`} disabled={state.busy || conflict} aria-busy={state.busy}>
          {props.t(request?.kind === 'remove' ? (state.busy ? 'removing' : 'remove') : (state.busy ? 'saving' : 'save'))}
        </Button>}
      </>}>
      <form id={`${id}-form`} className={css.form} noValidate aria-busy={state.busy}
        onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return
          // oxlint-disable-next-line typescript/no-deprecated -- IME 229 covers engines without isComposing.
          const inComposition = composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229
          if (inComposition) event.preventDefault()
        }}
        onSubmit={(event) => { event.preventDefault(); if (!composing.current) submit() }}>
        {request !== null && request.kind !== 'remove' && <>
          {FIELDS.filter(name => name !== 'directory').map(name => field(name, name === 'identityFile'))}
          <p id={`${id}-key-help`} className={css.help}>{props.t('keyHelp')}</p>
          <DirectoryField {...props} fieldId={fieldId('directory')} invalid={fieldInvalid('directory')} writable={writable} />
        </>}
        {state.problem !== null && <p className={css.problem} role="alert">{props.t(state.problem)}</p>}
      </form>
    </Modal>
    {state.notice !== null && <Toast key={state.notice.seq} text={props.t(state.notice.key)}
      {...successful ? { tone: 'success' as const } : { icon: <IconWarningOutlineRegular /> }}
      onDone={() => { if (state.notice !== null) props.actions.dismissNotice(state.notice.seq) }} />}
  </>
}
