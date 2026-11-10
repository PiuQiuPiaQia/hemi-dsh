// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { bindSnapshotSelector, contextMenuHook, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { ResourceSnapshot } from '@deepseek-ai/dsh-client-resources/client'
import type { SshRemoteDirectory } from '@deepseek-ai/dsh-hemi-ssh-servers/workspace-types'
import type { SshServer, SshServerId } from '@deepseek-ai/dsh-hemi-ssh-servers/types'
import type {} from '@deepseek-ai/dsh-hemi-ssh-servers/remote'
import { AddServerAction } from '../src/client/AddServerAction.tsx'
import { ServerOverlay } from '../src/client/ServerOverlay.tsx'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { createEditorStore } from '../src/client/store.ts'
import type { AddServerProps, ServerOverlayProps } from '../src/client/types.ts'
import { zh, en } from '../src/client/locales.ts'

const server: SshServer = {
  id: 'server-1' as SshServerId, revision: 'r1', name: '生产服务器', host: 'prod', port: 22, username: '', identityFile: '',
}
const unused = (): never => { throw new Error('Unused framework hook') }

function bench(resource: ResourceSnapshot<readonly SshServer[]> = { status: 'live', value: [server], failure: undefined }) {
  const store = createEditorStore().create()
  let directory: ResourceSnapshot<SshRemoteDirectory> = { status: 'loading', value: undefined, failure: undefined }
  const useResource = vi.fn((address: string) => address.includes('hemi-ssh-editor-folders') ? directory : resource)
  const standard: GlobalStandardProps = {
    useSessions: unused, useSessionStatus: unused, useSessionRetainInfo: unused, useSessionAccess: () => true,
    useRemoteAccess: () => true, useWorkspaceAccess: () => true, usePanelInfo: unused,
    useContextMenu: contextMenuHook(), useWorkspaces: unused, useResource: useResource as GlobalStandardProps['useResource'],
  }
  const shared = { ...standard, actions: store.actions, useStore: bindSnapshotSelector(store), t: makeTranslate(zh) }
  const overlay: ServerOverlayProps = { ...shared, save: vi.fn(), remove: vi.fn(), refresh: vi.fn() }
  const add: AddServerProps = { ...shared, disabled: false, onDismiss: vi.fn() }
  return { store, standard, shared, overlay, add, useResource, directory: (value: typeof directory) => { directory = value } }
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('dismisses the add menu and opens the independent form with port 22 and no credential contents', () => {
  const b = bench()
  render(<><AddServerAction {...b.add} /><ServerOverlay {...b.overlay} /></>)
  fireEvent.click(screen.getByRole('menuitem', { name: '添加 SSH' }))
  expect(b.add.onDismiss).toHaveBeenCalledOnce()
  const dialog = screen.getByRole('dialog', { name: zh.addTitle })
  expect(within(dialog).getByText(zh.description)).toBeTruthy()
  expect(within(dialog).getByRole<HTMLInputElement>('textbox', { name: '端口' }).value).toBe('22')
  const address = within(dialog).getByRole<HTMLInputElement>('textbox', { name: zh.address })
  expect(address.value).toBe('')
  expect(address.type).toBe('text')
  expect(address.getAttribute('inputmode')).toBe('email')
  expect(within(dialog).queryByRole('textbox', { name: '用户名' })).toBeNull()
  expect(within(dialog).getByText(zh.inherited)).toBeTruthy()
  expect(within(dialog).queryByLabelText('密码')).toBeNull()
  expect(document.activeElement).toBe(within(dialog).getByRole('textbox', { name: zh.name }))
  expect(within(dialog).getAllByRole('textbox').map(input => input.getAttribute('aria-label'))).toMatchInlineSnapshot(`
    [
      "显示名称",
      "SSH 地址",
      "端口",
      "私钥文件路径",
      "远端目录",
    ]
  `)
})

it('keeps the form and explicit optional blanks until the durable operation completes', () => {
  const b = bench()
  b.store.actions.open({ kind: 'create' })
  render(<ServerOverlay {...b.overlay} />)
  fireEvent.change(screen.getByRole('textbox', { name: zh.name }), { target: { value: '新服务器' } })
  fireEvent.change(screen.getByRole('textbox', { name: zh.address }), { target: { value: 'prod-alias' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  expect(b.overlay.save).toHaveBeenCalledWith(null, {
    name: '新服务器', host: 'prod-alias', port: 22, username: '', identityFile: '',
  })
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(screen.getByRole('button', { name: '正在保存…' }).hasAttribute('disabled')).toBe(true)
  act(() => { b.store.actions.complete('saved') })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('alert').textContent).toBe(zh.saved)
  expect(screen.queryByText('已连接')).toBeNull()
})

it('submits username and host from one field while keeping a rejected address editable', () => {
  const b = bench()
  b.store.actions.open({ kind: 'edit', server })
  render(<ServerOverlay {...b.overlay} />)
  const address = screen.getByRole('textbox', { name: zh.address })
  fireEvent.change(address, { target: { value: 'root@192.168.1.10:2222' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  expect(b.overlay.save).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(address)
  expect(screen.getByText(zh.addressError)).toBeTruthy()
  fireEvent.change(address, { target: { value: 'root@192.168.1.10' } })
  fireEvent.change(screen.getByRole('textbox', { name: zh.port }), { target: { value: '2222' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  expect(b.overlay.save).toHaveBeenCalledWith(server, {
    name: server.name, username: 'root', host: '192.168.1.10', port: 2222, identityFile: '',
  })
})

it('shows localized field errors, focuses the first invalid input and never dispatches invalid data', () => {
  const b = bench()
  b.store.actions.open({ kind: 'create' })
  render(<ServerOverlay {...b.overlay} />)
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  expect(screen.getByText(zh.nameError)).toBeTruthy()
  expect(screen.getByText(zh.addressError)).toBeTruthy()
  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: zh.name }))
  fireEvent.change(screen.getByRole('textbox', { name: zh.name }), { target: { value: 'New' } })
  fireEvent.change(screen.getByRole('textbox', { name: zh.address }), { target: { value: 'prod' } })
  fireEvent.change(screen.getByRole('textbox', { name: '端口' }), { target: { value: '0' } })
  expect(screen.getByText(zh.portError)).toBeTruthy()
  expect(b.overlay.save).not.toHaveBeenCalled()
})

it('does not save while the user is composing text and uses the same submit path afterwards', () => {
  const b = bench()
  b.store.actions.open({ kind: 'edit', server })
  const view = render(<ServerOverlay {...b.overlay} />)
  const name = screen.getByRole('textbox', { name: zh.name })
  const form = view.baseElement.querySelector('form')!
  fireEvent.compositionStart(name)
  fireEvent.keyDown(name, { key: 'Enter', isComposing: true })
  fireEvent.submit(form)
  expect(b.overlay.save).not.toHaveBeenCalled()
  fireEvent.compositionEnd(name)
  fireEvent.submit(form)
  expect(b.overlay.save).toHaveBeenCalledWith(server, {
    name: server.name, host: server.host, port: 22, username: '', identityFile: '',
  })
})

it('keeps a rejected draft, renders the structured field error, and blocks stale-revision retries', () => {
  const b = bench()
  b.store.actions.open({ kind: 'edit', server })
  render(<ServerOverlay {...b.overlay} />)
  fireEvent.change(screen.getByRole('textbox', { name: zh.name }), { target: { value: '保留草稿' } })
  act(() => { b.store.actions.fail('invalid', 'identityFile') })
  expect(screen.getByRole('textbox', { name: zh.identityFile }).getAttribute('aria-invalid')).toBe('true')
  expect(screen.getByText(zh.identityFileError)).toBeTruthy()
  act(() => { b.store.actions.fail('conflict', null) })
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: zh.name }).value).toBe('保留草稿')
  expect(screen.getByRole('button', { name: '保存' }).hasAttribute('disabled')).toBe(true)
  expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toBe(zh.conflict)
})

it.each(['edit', 'remove'] as const)('keeps the durable %s cleanup warning visible and blocks repeated submission', (kind) => {
  const b = bench()
  b.store.actions.open({ kind, server })
  render(<ServerOverlay {...b.overlay} />)
  act(() => { b.store.actions.fail('credentialCleanupFailed', null) })
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByRole('alert').textContent).toBe(zh.credentialCleanupFailed)
  const submit = within(dialog).getByRole<HTMLButtonElement>('button', { name: kind === 'remove' ? zh.remove : zh.save })
  expect(submit.disabled).toBe(true)
  fireEvent.click(submit)
  expect(b.overlay.save).not.toHaveBeenCalled()
  expect(b.overlay.remove).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: zh.closeRefresh }))
  expect(b.overlay.refresh).toHaveBeenCalledOnce()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('keeps full saved connection fields in the editor without creating sidebar rows', () => {
  const b = bench()
  const item = { ...server, name: '一台名称很长的服务器'.repeat(8), host: 'very-long-host-name.example.com', username: 'alice', port: 2200 }
  b.store.actions.open({ kind: 'edit', server: item })
  render(<ServerOverlay {...b.overlay} />)
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: zh.name }).value).toBe(item.name)
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: zh.address }).value).toBe('alice@very-long-host-name.example.com')
  expect(document.querySelector('[data-hemi-ssh-servers]')).toBeNull()
})

it('confirms removing only the saved connection and keeps a refused removal visible', () => {
  const b = bench()
  b.store.actions.open({ kind: 'remove', server })
  render(<ServerOverlay {...b.overlay} />)
  expect(screen.getByRole('dialog', { name: zh.removeTitle })).toBeTruthy()
  expect(screen.getByText(zh.removeDescription.replace('{name}', server.name))).toBeTruthy()
  expect(b.overlay.remove).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: zh.remove }))
  expect(b.overlay.remove).toHaveBeenCalledWith(server)
  act(() => { b.store.actions.fail('failed', null) })
  expect(screen.getByRole('dialog')).toBeTruthy()
})

it('keeps read-only details available without edit or save permission', () => {
  const b = bench()
  b.store.actions.open({ kind: 'edit', server })
  const access: GlobalStandardProps['useRemoteAccess'] = action => action === 'hemiSshServers/list'
  render(<ServerOverlay {...b.overlay} useRemoteAccess={access} />)
  expect(screen.getByRole('dialog', { name: zh.view })).toBeTruthy()
  expect(screen.queryByRole('button', { name: zh.save })).toBeNull()
  expect(screen.getByRole('textbox', { name: zh.address }).hasAttribute('readonly')).toBe(true)
})

it('closes with Escape and returns focus to the invoking connection action', () => {
  const b = bench()
  render(<><button onClick={() => { b.store.actions.open({ kind: 'edit', server }) }}>编辑连接</button><ServerOverlay {...b.overlay} /></>)
  const trigger = screen.getByRole('button', { name: '编辑连接' })
  trigger.focus(); fireEvent.click(trigger)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

it('does not offer connection creation without list and create access', () => {
  const b = bench()
  render(<AddServerAction {...b.add} useRemoteAccess={() => false} />)
  expect(screen.queryByRole('menuitem')).toBeNull()
})

it.each(['footer', 'escape', 'icon'] as const)('refreshes the saved list after explicitly closing a failed operation by %s', (path) => {
  const b = bench()
  b.store.actions.open({ kind: 'edit', server })
  b.store.actions.fail('conflict', null)
  render(<ServerOverlay {...b.overlay} />)
  expect(screen.getByRole('button', { name: '关闭并刷新' })).toBeTruthy()
  if (path === 'footer') fireEvent.click(screen.getByRole('button', { name: '关闭并刷新' }))
  else if (path === 'escape') fireEvent.keyDown(document, { key: 'Escape' })
  else fireEvent.click(screen.getByRole('button', { name: /^关闭$/ }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(b.overlay.refresh).toHaveBeenCalledOnce()
})

it('does not refresh the list when an unchanged editor is cancelled', () => {
  const b = bench()
  b.store.actions.open({ kind: 'edit', server })
  render(<ServerOverlay {...b.overlay} />)
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(b.overlay.refresh).not.toHaveBeenCalled()
})

it('keeps both dictionaries aligned and uses sentence case in English actions', () => {
  expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  expect(en.add).toBe('Add SSH')
  expect(en.removeTitle).toBe('Remove SSH server?')
})

it('chooses a real remote directory while editing and saves it with the same captured connection', () => {
  const b = bench()
  b.store.actions.open({ kind: 'edit', server: { ...server, directory: '/old' } })
  b.directory({ status: 'live', value: { path: '/remote/project', parentPath: '/remote', directories: [] }, failure: undefined })
  render(<ServerOverlay {...b.overlay} />)
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: zh.directory }).value).toBe('/old')
  fireEvent.click(screen.getByRole('button', { name: zh.chooseDirectory }))
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: zh.remotePath }).value).toBe('/remote/project')
  expect(b.overlay.save).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: zh.useDirectory }))
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: zh.directory }).value).toBe('/remote/project')
  fireEvent.click(screen.getByRole('button', { name: zh.save }))
  expect(b.overlay.save).toHaveBeenCalledWith({ ...server, directory: '/old' }, expect.objectContaining({ directory: '/remote/project' }))
})

it('shows directory connection failures without replacing an existing choice or allowing stale selection', () => {
  const b = bench()
  b.store.actions.open({ kind: 'edit', server: { ...server, directory: '/old' } })
  b.directory({ status: 'failed', value: { path: '/stale', parentPath: '/', directories: [] },
    failure: new RemoteError('gateway/internal', 'private diagnostic', {}) })
  render(<ServerOverlay {...b.overlay} />)
  fireEvent.click(screen.getByRole('button', { name: zh.chooseDirectory }))
  expect(screen.getByText(zh.connectionReadFailed)).toBeTruthy()
  expect(screen.getByRole('button', { name: zh.useDirectory }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: zh.directory }).value).toBe('/old')
  expect(screen.queryByText('private diagnostic')).toBeNull()
})
