// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector, contextMenuHook, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { GlobalStandardProps, ResourceProtocolMap } from '@deepseek-ai/dsh-client-ui-slots'
import type { ResourceSnapshot } from '@deepseek-ai/dsh-client-resources/client'
import type { SshServer, SshServerId } from '@deepseek-ai/dsh-hemi-ssh-servers/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { DirectoryField } from '../src/client/DirectoryField.tsx'
import { FolderOverlay } from '../src/client/FolderOverlay.tsx'
import { createEditorStore } from '../src/client/store.ts'
import { directoryHistoryKey } from '../src/client/draft.ts'
import type { FolderOverlayProps, ServerOverlayProps } from '../src/client/types.ts'
import { zh } from '../src/client/locales.ts'

const server: SshServer = { id: brandString<SshServerId>('connection-1'), revision: 'r1', name: '生产服务器',
  host: 'prod.example', username: 'user', port: 22, identityFile: '' }
const unused = (): never => { throw new Error('Unused framework hook') }
type Folders = ResourceSnapshot<ResourceProtocolMap['hemi-ssh-folders']>

function bench(selected: SshServer = server) {
  const store = createEditorStore().create()
  store.actions.open({ kind: 'folder', server: selected, selection: 1 })
  const query = createSnapshotStore(1)
  let folders: Folders = { status: 'loading', value: undefined, failure: undefined }
  const standard: GlobalStandardProps = {
    useSessions: unused, useSessionStatus: unused, useSessionRetainInfo: unused, useSessionAccess: () => true,
    useRemoteAccess: () => true, useWorkspaceAccess: () => true, usePanelInfo: unused,
    useContextMenu: contextMenuHook(), useWorkspaces: unused, useResource: (() => folders) as GlobalStandardProps['useResource'],
  }
  const props: FolderOverlayProps = {
    ...standard, actions: store.actions, useStore: bindSnapshotSelector(store), t: makeTranslate(zh),
    useDirectoryRequest: bindSnapshotSelector(query), browse: vi.fn(() => { query.set(query.getSnapshot() + 1) }), openFolder: vi.fn(),
    closeFolder: vi.fn(() => { store.actions.close() }),
  }
  const view = render(<FolderOverlay {...props} />)
  const rerender = (overrides: Partial<FolderOverlayProps> = {}): void => { view.rerender(<FolderOverlay {...props} {...overrides} />) }
  const ready = (path = '/remote/project', empty = false, parentPath = '/remote'): void => {
    folders = { status: 'live', failure: undefined, value: { request: query.getSnapshot(),
      directory: { path, parentPath, directories: empty ? [] : [{ name: 'src', path: `${path}/src` }] } } }
    rerender()
  }
  return { store, query, props, view, ready, rerender, snapshot: () => folders,
    folders: (value: Folders) => { folders = value; rerender() } }
}

function editorBench() {
  const store = createEditorStore().create()
  store.actions.open({ kind: 'edit', server: { ...server, directory: '/preferred' } })
  let directory: ResourceSnapshot<ResourceProtocolMap['hemi-ssh-editor-folders']> = {
    status: 'loading', value: undefined, failure: undefined,
  }
  const props: ServerOverlayProps = {
    useSessions: unused, useSessionStatus: unused, useSessionRetainInfo: unused, useSessionAccess: () => true,
    useRemoteAccess: () => true, useWorkspaceAccess: () => true, usePanelInfo: unused,
    useContextMenu: contextMenuHook(), useWorkspaces: unused,
    useResource: (() => directory) as GlobalStandardProps['useResource'],
    actions: store.actions, useStore: bindSnapshotSelector(store), t: makeTranslate(zh),
    save: vi.fn(), remove: vi.fn(), refresh: vi.fn(),
  }
  const view = render(<DirectoryField {...props} fieldId="directory" invalid={false} writable />)
  return { props, store, view, directory: (value: typeof directory) => {
    directory = value
    view.rerender(<DirectoryField {...props} fieldId="directory" invalid={false} writable />)
  } }
}

const addressInput = () => screen.getByRole<HTMLInputElement>('textbox', { name: zh.remotePath })
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('loads SSH folders automatically while exposing an auxiliary address bar instead of a setup form', () => {
  const b = bench()
  expect(screen.getByRole('status', { name: zh.browseLoading })).toBeTruthy()
  expect(addressInput().value).toBe('')
  expect(screen.queryByRole('button', { name: zh.browse })).toBeNull()
  expect(screen.queryByRole('button', { name: zh.retry })).toBeNull()
  expect(screen.queryByText(zh.remotePathHelp)).toBeNull()
  expect(screen.getByRole('button', { name: zh.useDirectory }).hasAttribute('disabled')).toBe(true)
  expect(b.props.browse).not.toHaveBeenCalled()
  expect(b.view.baseElement.textContent).not.toMatch(/helper|SHA-256|bootstrap|启动方式|保存设置/iu)
})

it('shows a generic title and separate server caption while adopting the returned physical path', () => {
  const b = bench({ ...server, directory: '/preferred' })
  expect(screen.getByRole('dialog', { name: zh.folderTitle })).toBeTruthy()
  expect(screen.queryByText(server.name)).toBeNull()
  expect(b.view.baseElement.textContent?.match(/user@prod\.example:22/gu)).toHaveLength(1)
  expect(addressInput().value).toBe('/preferred')
  b.ready('/physical/preferred')
  expect(addressInput().value).toBe('/physical/preferred')
})

it('opens only the successful physical directory without treating a connection id as a Workspace id', () => {
  const b = bench()
  b.ready('/physical/project')
  fireEvent.click(screen.getByRole('button', { name: zh.useDirectory }))
  expect(b.props.openFolder).toHaveBeenCalledExactlyOnceWith(1, '/physical/project')
  expect(b.store.getSnapshot().directoryHistory[directoryHistoryKey(server)]).toEqual(['/physical/project'])
})

it('browses children and parents without selecting a Workspace or remembering an unverified target', () => {
  const b = bench()
  b.ready()
  fireEvent.click(screen.getByRole('button', { name: '浏览 src' }))
  expect(b.props.browse).toHaveBeenLastCalledWith(1, '/remote/project/src')
  expect(b.store.getSnapshot().directoryHistory[directoryHistoryKey(server)]).toEqual(['/remote/project'])
  b.ready('/remote/project/src', false, '/remote/project')
  fireEvent.click(screen.getByRole('button', { name: zh.parentFolder }))
  expect(b.props.browse).toHaveBeenLastCalledWith(1, '/remote/project')
  expect(b.props.openFolder).not.toHaveBeenCalled()
})

it('keeps the root selectable without navigating outside it', () => {
  const b = bench()
  b.ready('/', true, '/')
  expect(screen.getByRole('button', { name: zh.parentFolder }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: zh.useDirectory }).hasAttribute('disabled')).toBe(false)
})

it('retains old rows but blocks confirmation until the requested directory revision arrives', () => {
  const b = bench()
  b.ready()
  fireEvent.click(screen.getByRole('button', { name: '浏览 src' }))
  expect(screen.getByRole('status', { name: zh.browseLoading })).toBeTruthy()
  expect(screen.getByRole('button', { name: '浏览 src' })).toBeTruthy()
  expect(screen.getByRole('button', { name: zh.useDirectory }).hasAttribute('disabled')).toBe(true)
  b.ready('/remote/project/src')
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.getByRole('button', { name: zh.useDirectory }).hasAttribute('disabled')).toBe(false)
})

it('explains password-save failure after sign-in without displaying credential diagnostics', () => {
  const b = bench()
  b.ready()
  b.folders({ status: 'failed', value: b.snapshot().value,
    failure: new RemoteError('hemi-ssh/remember-failed', '/private/credential secret', { host: server.host, reason: 'credentials-write' }) })
  expect(screen.getByRole('alert').textContent).toBe(zh.passwordRememberFailed)
  expect(b.view.baseElement.textContent).not.toContain('/private/credential')
  expect(b.view.baseElement.textContent).not.toContain('credentials-write')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.useDirectory }).disabled).toBe(true)
  expect(b.props.openFolder).not.toHaveBeenCalled()
})

it('retains a failed read’s old directory but refuses its selection and private failure details', () => {
  const b = bench()
  b.ready()
  b.folders({ status: 'failed', value: b.snapshot().value,
    failure: new RemoteError('hemi-ssh/connection-failed', '/private/key', { serverId: server.id, operation: 'browse' }) })
  expect(addressInput().value).toBe('/remote/project')
  expect(screen.getByText(zh.connectionReadFailed)).toBeTruthy()
  expect(b.view.baseElement.textContent).not.toContain('/private/key')
  expect(screen.getByRole('button', { name: zh.useDirectory }).hasAttribute('disabled')).toBe(true)
  expect(screen.queryByRole('button', { name: zh.retry })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: zh.parentFolder }))
  expect(b.props.browse).toHaveBeenLastCalledWith(1, '/remote')
  expect(b.store.getSnapshot().directoryHistory).toEqual({})
})

it('requires reopening a changed endpoint instead of navigating its captured connection', () => {
  const b = bench()
  b.folders({ status: 'failed', value: undefined,
    failure: new RemoteError('hemi-ssh/connection-changed', 'private diagnostic', { serverId: server.id }) })
  expect(screen.getByText(zh.runtimeChanged)).toBeTruthy()
  expect(addressInput().disabled).toBe(true)
  expect(screen.queryByRole('button', { name: zh.retry })).toBeNull()
})

it('allows an empty existing directory to open', () => {
  const b = bench()
  b.ready('/remote/empty', true)
  expect(screen.getByText(zh.noSubfolders)).toBeTruthy()
  expect(screen.getByRole('button', { name: zh.useDirectory }).hasAttribute('disabled')).toBe(false)
})

it('allows dismissal during connection preparation without trapping the user', () => {
  const b = bench()
  b.ready()
  fireEvent.click(screen.getByRole('button', { name: zh.useDirectory }))
  fireEvent.click(screen.getByRole('button', { name: zh.cancel }))
  expect(b.props.closeFolder).toHaveBeenCalledOnce()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('shows a first-load connection failure with an address recovery path but no retry setup form', () => {
  const b = bench()
  b.folders({ status: 'failed', value: undefined,
    failure: new RemoteError('hemi-ssh/ssh-unavailable', 'private diagnostic', { host: server.host, reason: '' }) })
  expect(screen.getByRole('alert').textContent).toBe(zh.sshUnavailable)
  expect(screen.queryByRole('list')).toBeNull()
  expect(screen.queryByRole('status')).toBeNull()
  expect(addressInput()).toBeTruthy()
  expect(screen.queryByRole('button', { name: zh.retry })).toBeNull()
  expect(screen.getByRole('button', { name: zh.useDirectory }).hasAttribute('disabled')).toBe(true)
})

it('reports provider withdrawal and keeps folder actions permission-gated', () => {
  const b = bench()
  b.folders({ status: 'none', value: undefined, failure: undefined })
  expect(screen.getByText(zh.folderUnavailable)).toBeTruthy()
  b.ready()
  b.rerender({ useRemoteAccess: () => false })
  for (const name of [zh.parentFolder, '浏览 src', zh.useDirectory]) {
    expect(screen.getByRole('button', { name }).hasAttribute('disabled')).toBe(true)
  }
})

it('uses the same picker from the editor without saving staged connection fields', () => {
  const b = editorBench()
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: zh.directory })
  fireEvent.change(input, { target: { value: '/typed' } })
  b.directory({ status: 'live', failure: undefined,
    value: { path: '/remote/project', parentPath: '/remote', directories: [{ name: 'src', path: '/remote/project/src' }] } })
  fireEvent.click(screen.getByRole('button', { name: zh.chooseDirectory }))
  expect(screen.getByRole('dialog', { name: zh.folderTitle })).toBeTruthy()
  expect(screen.getAllByRole('textbox')).toHaveLength(2)
  expect(screen.getByRole('button', { name: zh.chooseDirectory }).getAttribute('aria-expanded')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: '浏览 src' }))
  b.directory({ status: 'live', failure: undefined,
    value: { path: '/remote/project/src', parentPath: '/remote/project', directories: [] } })
  fireEvent.click(screen.getByRole('button', { name: zh.useDirectory }))
  expect(input.value).toBe('/remote/project/src')
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(b.props.save).not.toHaveBeenCalled()
  expect(b.store.getSnapshot().directoryHistory[directoryHistoryKey(server)]).toEqual(['/remote/project/src', '/remote/project'])
})

it('keeps a failed editor choice unchanged while permitting auxiliary address editing and cancellation', () => {
  const b = editorBench()
  fireEvent.click(screen.getByRole('button', { name: zh.chooseDirectory }))
  expect(screen.getByRole('status', { name: zh.browseLoading })).toBeTruthy()
  b.directory({ status: 'failed', value: undefined, failure: new RemoteError('gateway/internal', 'private diagnostic', {}) })
  expect(screen.getByRole('alert').textContent).toBe(zh.connectionReadFailed)
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.queryByRole('list')).toBeNull()
  expect(screen.queryByRole('button', { name: zh.retry })).toBeNull()
  expect(screen.getByRole('button', { name: zh.useDirectory }).hasAttribute('disabled')).toBe(true)
  fireEvent.change(addressInput(), { target: { value: '/manual' } })
  fireEvent.click(screen.getByRole('button', { name: zh.cancel }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: zh.directory }).value).toBe('/preferred')
})
