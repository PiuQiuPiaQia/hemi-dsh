/** Transient native SSH login prompts; responses stay local to this keyed form and are cleared on submission. */
import { useId, useState } from 'react'
import { Button, Checkbox, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SshAuthenticationChallenge } from '@deepseek-ai/dsh-hemi-ssh-servers/workspace-types'
import type { AuthenticationOverlayProps } from './types.ts'
import { AUTHENTICATION_ADDRESS } from './authentication-resources.ts'
import { endpointLabel } from './draft.ts'
import css from './authentication.module.css'

/**
 * Keep native SSH authentication available while a directory read or remote execution awaits it.
 * @param props - authoritative challenges and a root-owned, nonpersistent reply callback.
 * @returns at most one active native prompt, with no stored password field.
 */
export function AuthenticationOverlay(props: AuthenticationOverlayProps) {
  const authentication = props.useResource<'hemi-ssh-authentication'>(AUTHENTICATION_ADDRESS)
  const challenge = authentication.value?.[0]
  if (challenge === undefined) return null
  if (authentication.status === 'failed') return <AuthenticationUnavailable key={challenge.id} {...props} challenge={challenge} />
  return authentication.status === 'live' ? <AuthenticationPrompt key={challenge.id} {...props} challenge={challenge} /> : null
}

function AuthenticationUnavailable(props: AuthenticationOverlayProps & { challenge: SshAuthenticationChallenge }) {
  const [closed, setClosed] = useState(false)
  const close = (): void => { setClosed(true) }
  return <Modal open={!closed} title={props.t('authenticationTitle')} description={endpointLabel(props.challenge.endpoint)}
    closeLabel={props.t('close')} className={css.dialog ?? ''} contentClassName={`${css.content} scrollable`} onClose={close}
    footer={<Button variant="outline" onClick={close}>{props.t('close')}</Button>}>
    <p role="alert" className={css.problem}>{props.t('authenticationUnavailable')}</p>
  </Modal>
}

function AuthenticationPrompt(props: AuthenticationOverlayProps & { challenge: SshAuthenticationChallenge }) {
  const { challenge, t } = props
  const id = useId()
  const [answer, setAnswer] = useState('')
  const [remember, setRemember] = useState(false)
  const [closed, setClosed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<'authenticationExpired' | 'authenticationFailed' | null>(null)
  const canAnswer = props.useRemoteAccess('hemiSshWorkspaces/answerAuthentication')
  const canSavePassword = props.useRemoteAccess('hemiSshWorkspaces/answerAuthenticationAndRemember')
  const eligible = challenge.kind === 'input' && challenge.canRemember
  const reply = async (value: string | null): Promise<void> => {
    if (busy || !canAnswer) return
    const savePassword = value !== null && eligible && canSavePassword && remember
    setAnswer(''); setRemember(false); setBusy(true); setProblem(null)
    const result = await props.answerAuthentication(challenge.id, value, savePassword)
    if (result !== 'accepted') {
      setBusy(false)
      setProblem(result === 'expired' ? 'authenticationExpired' : 'authenticationFailed')
    }
  }
  const submit = (): void => {
    void reply(challenge.kind === 'confirm' ? 'yes' : challenge.kind === 'notification' ? '' : answer)
  }
  const close = (): void => {
    setAnswer(''); setRemember(false); setClosed(true)
    void props.answerAuthentication(challenge.id, null, false)
  }
  return <Modal open={!closed} title={t('authenticationTitle')} description={endpointLabel(challenge.endpoint)}
    closeLabel={t('close')} className={css.dialog ?? ''} contentClassName={`${css.content} scrollable`} onClose={close}
    footer={<>
      <Button variant="outline" onClick={close}>{t('cancel')}</Button>
      <Button variant="primary" type="submit" form={`${id}-form`} disabled={busy || !canAnswer}
        aria-busy={busy}>{t(challenge.kind === 'confirm' ? 'authenticationAllow' : 'authenticationContinue')}</Button>
    </>}>
    <form id={`${id}-form`} className={css.form} onSubmit={(event) => { event.preventDefault(); submit() }}
      onKeyDown={(event) => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault() }}>
      <p className={css.prompt}>{challenge.prompt}</p>
      {challenge.kind === 'input' && <Input className={css.response} type="password" value={answer} autoComplete="off" autoCorrect="off"
        autoCapitalize="none" spellCheck={false} maxLength={4096} data-modal-autofocus
        aria-label={t('authenticationResponse')} disabled={busy || !canAnswer}
        onChange={(event) => { setAnswer(event.currentTarget.value) }} />}
      {eligible && <div className={css.remember} role="group" aria-label={t('authenticationRemember')}
        aria-describedby={`${id}-remember-help`}>
        <p id={`${id}-remember-help`} className={css.rememberHelp}>{t('authenticationRememberHelp')}</p>
        <Checkbox checked={remember && canSavePassword} onChange={setRemember} label={t('authenticationRemember')}
          disabled={busy || !canAnswer || !canSavePassword} />
      </div>}
      {problem !== null && <p role="alert" className={css.problem}>{t(problem)}</p>}
    </form>
  </Modal>
}
