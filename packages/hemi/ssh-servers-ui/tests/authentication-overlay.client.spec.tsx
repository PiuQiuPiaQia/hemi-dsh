// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { bindSnapshotSelector, contextMenuHook, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SshAuthenticationChallenge, SshAuthenticationChallengeId } from '@deepseek-ai/dsh-hemi-ssh-servers/workspace-types'
import { AuthenticationOverlay } from '../src/client/AuthenticationOverlay.tsx'
import type { AuthenticationOverlayProps } from '../src/client/types.ts'
import { createEditorStore } from '../src/client/store.ts'
import { zh } from '../src/client/locales.ts'

const challenge: SshAuthenticationChallenge = {
  id: brandString<SshAuthenticationChallengeId>('native-1'), kind: 'input', prompt: 'root@fixture password:', canRemember: true,
  endpoint: { host: 'fixture', username: 'root', port: 22, identityFile: '' },
}
const unused = (): never => { throw new Error('Unused framework hook') }
function bench(value: SshAuthenticationChallenge = challenge) {
  const store = createEditorStore().create()
  const standard: GlobalStandardProps = {
    useSessions: unused, useSessionStatus: unused, useSessionRetainInfo: unused, useSessionAccess: () => true,
    useRemoteAccess: () => true, useWorkspaceAccess: () => true, usePanelInfo: unused,
    useContextMenu: contextMenuHook(), useWorkspaces: unused,
    useResource: (() => ({ status: 'live', value: [value], failure: undefined })) as GlobalStandardProps['useResource'],
  }
  const props: AuthenticationOverlayProps = { ...standard, useStore: bindSnapshotSelector(store), actions: store.actions,
    t: makeTranslate(zh), answerAuthentication: vi.fn(async () => 'accepted' as const) }
  return { props, store }
}
afterEach(cleanup)

it('defaults each eligible password prompt to unchecked and explains local plain-text storage', () => {
  const b = bench()
  const view = render(<AuthenticationOverlay {...b.props} />)
  const checkbox = screen.getByRole<HTMLInputElement>('checkbox', { name: zh.authenticationRemember })
  expect(checkbox.checked).toBe(false)
  expect(screen.getByText(zh.authenticationRememberHelp)).toBeTruthy()
  fireEvent.click(checkbox)
  const retry = { ...challenge, id: brandString<SshAuthenticationChallengeId>('native-retry') }
  b.props.useResource = (() => ({ status: 'live', value: [retry], failure: undefined })) as GlobalStandardProps['useResource']
  view.rerender(<AuthenticationOverlay {...b.props} />)
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: zh.authenticationRemember }).checked).toBe(false)
})

it('submits a checked password as an explicit remember opt-in without putting it in the store', async () => {
  const b = bench()
  render(<AuthenticationOverlay {...b.props} />)
  fireEvent.change(screen.getByLabelText(zh.authenticationResponse), { target: { value: 'fixture-remember-secret' } })
  fireEvent.click(screen.getByRole('checkbox', { name: zh.authenticationRemember }))
  fireEvent.click(screen.getByRole('button', { name: zh.authenticationContinue }))
  await waitFor(() => { expect(b.props.answerAuthentication).toHaveBeenCalledWith(challenge.id, 'fixture-remember-secret', true) })
  expect(JSON.stringify(b.store.getSnapshot())).not.toContain('fixture-remember-secret')
  expect(screen.getByLabelText<HTMLInputElement>(zh.authenticationResponse).value).toBe('')
})

it.each([
  { kind: 'input' as const, prompt: 'Enter verification code:', canRemember: false },
  { kind: 'input' as const, prompt: 'Enter passphrase for key:', canRemember: false },
  { kind: 'input' as const, prompt: 'Unclassified password:', canRemember: false },
  { kind: 'confirm' as const, prompt: 'Continue connecting?', canRemember: false },
  { kind: 'notification' as const, prompt: 'Authentication notice', canRemember: false },
  { kind: 'confirm' as const, prompt: 'Continue connecting?', canRemember: true },
])('hides remember for $kind / $prompt', (fields) => {
  const b = bench({ ...challenge, ...fields })
  render(<AuthenticationOverlay {...b.props} />)
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(screen.queryByText(zh.authenticationRememberHelp)).toBeNull()
})

it.each(['cancel', 'close'] as const)('never remembers a cancelled password through %s', (action) => {
  const b = bench()
  render(<AuthenticationOverlay {...b.props} />)
  fireEvent.click(screen.getByRole('checkbox', { name: zh.authenticationRemember }))
  fireEvent.change(screen.getByLabelText(zh.authenticationResponse), { target: { value: 'discarded-secret' } })
  fireEvent.click(screen.getByRole('button', { name: zh[action] }))
  expect(b.props.answerAuthentication).toHaveBeenCalledExactlyOnceWith(challenge.id, null, false)
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('disables remember and repeated submission while the answer is pending', async () => {
  const b = bench()
  const pending = Promise.withResolvers<'accepted'>()
  vi.mocked(b.props.answerAuthentication).mockReturnValueOnce(pending.promise)
  render(<AuthenticationOverlay {...b.props} />)
  fireEvent.click(screen.getByRole('checkbox', { name: zh.authenticationRemember }))
  const submit = screen.getByRole<HTMLButtonElement>('button', { name: zh.authenticationContinue })
  fireEvent.click(submit)
  expect(screen.getByRole<HTMLInputElement>('checkbox').disabled).toBe(true)
  expect(screen.getByLabelText<HTMLInputElement>(zh.authenticationResponse).disabled).toBe(true)
  expect(submit.disabled).toBe(true)
  fireEvent.click(submit)
  expect(b.props.answerAuthentication).toHaveBeenCalledTimes(1)
  pending.resolve('accepted')
  await pending.promise
})

it.each(['answer', 'remember'] as const)('disables remember without %s permission', async (denied) => {
  const b = bench()
  b.props.useRemoteAccess = endpoint => endpoint !== (denied === 'answer'
    ? 'hemiSshWorkspaces/answerAuthentication' : 'hemiSshWorkspaces/answerAuthenticationAndRemember')
  render(<AuthenticationOverlay {...b.props} />)
  expect(screen.getByRole<HTMLInputElement>('checkbox').disabled).toBe(true)
  const submit = screen.getByRole<HTMLButtonElement>('button', { name: zh.authenticationContinue })
  expect(submit.disabled).toBe(denied === 'answer')
  fireEvent.click(submit)
  if (denied === 'answer') expect(b.props.answerAuthentication).not.toHaveBeenCalled()
  else await waitFor(() => { expect(b.props.answerAuthentication).toHaveBeenCalledWith(challenge.id, '', false) })
})

it('does not retain remember consent when its permission is withdrawn', async () => {
  const b = bench()
  const view = render(<AuthenticationOverlay {...b.props} />)
  fireEvent.click(screen.getByRole('checkbox'))
  b.props.useRemoteAccess = endpoint => endpoint !== 'hemiSshWorkspaces/answerAuthenticationAndRemember'
  view.rerender(<AuthenticationOverlay {...b.props} />)
  expect(screen.getByRole<HTMLInputElement>('checkbox').checked).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: zh.authenticationContinue }))
  await waitFor(() => { expect(b.props.answerAuthentication).toHaveBeenCalledWith(challenge.id, '', false) })
})

it('asks for a masked native response without adding credentials to saved connection drafts', async () => {
  const b = bench()
  render(<AuthenticationOverlay {...b.props} />)
  const input = screen.getByLabelText<HTMLInputElement>(zh.authenticationResponse)
  expect(input.type).toBe('password')
  fireEvent.change(input, { target: { value: 'fixture-private-response' } })
  expect(JSON.stringify(b.store.getSnapshot())).not.toContain('fixture-private-response')
  fireEvent.click(screen.getByRole('button', { name: zh.authenticationContinue }))
  expect(input.value).toBe('')
  await waitFor(() => { expect(b.props.answerAuthentication).toHaveBeenCalledWith(challenge.id, 'fixture-private-response', false) })
})

it.each(['expired', 'failed'] as const)('clears both the password and opt-in after a %s submission', async (result) => {
  const b = bench()
  vi.mocked(b.props.answerAuthentication).mockResolvedValueOnce(result)
  render(<AuthenticationOverlay {...b.props} />)
  fireEvent.change(screen.getByLabelText(zh.authenticationResponse), { target: { value: 'discard-on-failure' } })
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: zh.authenticationContinue }))
  await waitFor(() => { expect(screen.getByRole('alert').textContent)
    .toBe(result === 'expired' ? zh.authenticationExpired : zh.authenticationFailed) })
  expect(screen.getByLabelText<HTMLInputElement>(zh.authenticationResponse).value).toBe('')
  expect(screen.getByRole<HTMLInputElement>('checkbox').checked).toBe(false)
  expect(JSON.stringify(b.store.getSnapshot())).not.toContain('discard-on-failure')
})

it('does not interpret an untyped native first-host prompt as permission to trust it automatically', () => {
  const b = bench({ ...challenge, prompt: 'Host fingerprint SHA256:fixture. Continue connecting (yes/no)?', canRemember: false })
  render(<AuthenticationOverlay {...b.props} />)
  expect(screen.getByLabelText(zh.authenticationResponse)).toBeTruthy()
  expect(screen.queryByRole('button', { name: zh.authenticationAllow })).toBeNull()
  expect(b.props.answerAuthentication).not.toHaveBeenCalled()
})

it('requires an explicit click for a native confirmation hint', async () => {
  const b = bench({ ...challenge, kind: 'confirm' })
  render(<AuthenticationOverlay {...b.props} />)
  expect(screen.queryByLabelText(zh.authenticationResponse)).toBeNull()
  expect(b.props.answerAuthentication).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: zh.authenticationAllow }))
  await waitFor(() => { expect(b.props.answerAuthentication).toHaveBeenCalledWith(challenge.id, 'yes', false) })
})

it('clears the local response and disables submission while its retained challenge is disconnected', () => {
  const b = bench()
  const live = b.props.useResource
  const view = render(<AuthenticationOverlay {...b.props} />)
  fireEvent.change(screen.getByLabelText(zh.authenticationResponse), { target: { value: 'discard-on-disconnect' } })
  b.props.useResource = (() => ({ status: 'failed', value: [challenge],
    failure: new RemoteError('gateway/internal', 'private detail', {}) })) as GlobalStandardProps['useResource']
  view.rerender(<AuthenticationOverlay {...b.props} />)
  expect(screen.queryByLabelText(zh.authenticationResponse)).toBeNull()
  expect(screen.queryByRole('button', { name: zh.authenticationContinue })).toBeNull()
  expect(screen.getByRole('alert').textContent).toBe(zh.authenticationUnavailable)
  expect(b.props.answerAuthentication).not.toHaveBeenCalled()
  b.props.useResource = live
  view.rerender(<AuthenticationOverlay {...b.props} />)
  expect(screen.getByLabelText<HTMLInputElement>(zh.authenticationResponse).value).toBe('')
})

it('does not open a global error dialog for an idle authentication resource failure', () => {
  const b = bench()
  b.props.useResource = (() => ({ status: 'failed', value: [],
    failure: new RemoteError('gateway/internal', 'private detail', {}) })) as GlobalStandardProps['useResource']
  render(<AuthenticationOverlay {...b.props} />)
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('lets the operator dismiss a login dialog while its reply is pending', async () => {
  const b = bench()
  const pending = Promise.withResolvers<'accepted'>()
  vi.mocked(b.props.answerAuthentication).mockImplementationOnce(() => pending.promise)
  render(<AuthenticationOverlay {...b.props} />)
  fireEvent.click(screen.getByRole('button', { name: zh.authenticationContinue }))
  fireEvent.click(screen.getByRole('button', { name: zh.cancel }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(b.props.answerAuthentication).toHaveBeenLastCalledWith(challenge.id, null, false)
  pending.resolve('accepted')
  await pending.promise
})
