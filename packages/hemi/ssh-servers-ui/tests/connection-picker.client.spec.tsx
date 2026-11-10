// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { bindSnapshotSelector, contextMenuHook, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ContextMenuTarget, MenuPoint } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { ResourceSnapshot } from '@deepseek-ai/dsh-client-resources/client'
import type { SshServer, SshServerId } from '@deepseek-ai/dsh-hemi-ssh-servers/types'
import type {} from '@deepseek-ai/dsh-hemi-ssh-servers/remote'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { ConnectionPicker, type ConnectionPickerProps } from '../src/client/ConnectionPicker.tsx'
import { createEditorStore } from '../src/client/store.ts'
import { zh } from '../src/client/locales.ts'

const server: SshServer = {
  id: 'connection-1' as SshServerId, revision: 'r1', name: '生产服务器',
  host: 'prod.example.com', port: 2222, username: 'deploy', identityFile: '',
}
const unused = (): never => { throw new Error('Unused framework hook') }

function bench(resource: ResourceSnapshot<readonly SshServer[]> = { status: 'live', value: [server], failure: undefined }) {
  const store = createEditorStore().create()
  const useResource = vi.fn(() => resource)
  const calls: string[] = []
  const openMenu = vi.fn<(target: ContextMenuTarget, point: MenuPoint) => void>()
  const standard: GlobalStandardProps = {
    useSessions: unused, useSessionStatus: unused, useSessionRetainInfo: unused, useSessionAccess: () => true,
    useRemoteAccess: () => true, useWorkspaceAccess: () => true, usePanelInfo: unused,
    useContextMenu: contextMenuHook(openMenu), useWorkspaces: unused, useResource: useResource as GlobalStandardProps['useResource'],
  }
  const props: ConnectionPickerProps = {
    ...standard, actions: store.actions, useStore: bindSnapshotSelector(store), t: makeTranslate(zh), disabled: false,
    onDismiss: vi.fn(() => { calls.push('dismiss') }), onPicked: vi.fn(),
    openConnection: vi.fn((_server: SshServer) => { calls.push('open') }),
    menuTarget: vi.fn((server: SshServer) => ({ server, occurrence: 1 })),
    refresh: vi.fn(),
  }
  const selectWorkspace = vi.fn()
  const closeMenu = vi.fn()
  const element = (overrides: Partial<ConnectionPickerProps> = {}) => <Menu open anchor={<button type="button">工作区</button>}
    items={[{ id: 'local-workspace', label: '本地项目' }]} selectedId="local-workspace"
    onSelect={selectWorkspace} onClose={closeMenu}>
    <ConnectionPicker {...props} {...overrides} />
  </Menu>
  return { store, useResource, openMenu, calls, props, selectWorkspace, closeMenu, element }
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('offers a named connection group and dispatches only the chosen connection after dismissing the picker', () => {
  const b = bench()
  render(b.element())
  const group = screen.getByRole('group', { name: zh.connections })
  expect(within(group).getByText(server.name)).toBeTruthy()
  expect(within(group).getByText('deploy@prod.example.com:2222')).toBeTruthy()
  expect(group.querySelector('[aria-current]')).toBeNull()
  expect(within(group).queryByText('已连接')).toBeNull()
  expect(group.textContent).toMatchInlineSnapshot('"SSH 连接生产服务器 deploy@prod.example.com:2222"')
  fireEvent.click(within(group).getByRole('menuitem', { name: /生产服务器 deploy@prod\.example\.com:2222/ }))
  expect(b.props.openConnection).toHaveBeenCalledExactlyOnceWith(server, b.props.onPicked)
  expect(b.calls).toEqual(['dismiss', 'open'])
  expect(b.selectWorkspace).not.toHaveBeenCalled()
  expect(b.props.menuTarget).not.toHaveBeenCalled()
})

it('keeps the native workspace selection independent of SSH choices', () => {
  const b = bench()
  render(b.element())
  fireEvent.click(screen.getByRole('menuitem', { name: '本地项目' }))
  expect(b.selectWorkspace).toHaveBeenCalledExactlyOnceWith('local-workspace')
  expect(b.props.onDismiss).not.toHaveBeenCalled()
  expect(b.props.openConnection).not.toHaveBeenCalled()
})

it('formats an alias without an invented user and keeps separate saved identities', () => {
  const second: SshServer = { ...server, id: 'connection-2' as SshServerId, name: '内网服务器', host: 'internal-alias', username: '', port: 22 }
  const b = bench({ status: 'live', value: [server, second], failure: undefined })
  render(b.element())
  expect(screen.getByText('internal-alias:22')).toBeTruthy()
  fireEvent.click(screen.getByRole('menuitem', { name: /内网服务器 internal-alias:22/ }))
  expect(b.props.openConnection).toHaveBeenCalledExactlyOnceWith(second, b.props.onPicked)
  expect(b.selectWorkspace).not.toHaveBeenCalled()
})

it.each(['owner', 'editor'] as const)('blocks picking and context actions while %s is busy', (owner) => {
  const b = bench()
  if (owner === 'editor') b.store.actions.begin()
  render(b.element({ disabled: owner === 'owner' }))
  const row = screen.getByRole('menuitem', { name: /生产服务器 deploy@prod\.example\.com:2222/ })
  expect(row.hasAttribute('disabled')).toBe(true)
  fireEvent.click(row)
  fireEvent.contextMenu(row)
  expect(b.openMenu).not.toHaveBeenCalled()
  expect(b.calls).toEqual([])
})

it('reports loading without offering fake connection or directory choices', () => {
  const b = bench({ status: 'loading', value: undefined, failure: undefined })
  render(b.element())
  const group = screen.getByRole('group', { name: zh.connections })
  expect(within(group).getByRole('status', { name: zh.connectionsLoading })).toBeTruthy()
  expect(within(group).queryByRole('menuitem')).toBeNull()
  expect(b.calls).toEqual([])
})

it.each(['empty', 'none'] as const)('renders no group or divider for %s resources', (state) => {
  const b = bench(state === 'empty'
    ? { status: 'live', value: [], failure: undefined }
    : { status: 'none', value: undefined, failure: undefined })
  render(b.element())
  expect(screen.queryByRole('group', { name: zh.connections })).toBeNull()
  expect(screen.queryByRole('separator')).toBeNull()
  expect(screen.getAllByRole('menuitem')).toHaveLength(1)
})

it('retains saved choices after a failed refresh and retries without closing or dispatching a connection', () => {
  const b = bench({ status: 'failed', value: [server], failure: new RemoteError('gateway/internal', '/private/storage/path', {}) })
  render(b.element())
  const group = screen.getByRole('group', { name: zh.connections })
  expect(within(group).getByRole('alert').textContent).toBe(zh.connectionsReadFailed)
  expect(within(group).getByText(server.name)).toBeTruthy()
  expect(group.textContent).not.toContain('/private/storage/path')
  fireEvent.click(within(group).getByRole('menuitem', { name: zh.retry }))
  expect(b.props.refresh).toHaveBeenCalledOnce()
  expect(b.calls).toEqual([])
  expect(b.selectWorkspace).not.toHaveBeenCalled()
})

it('offers retry before the first successful read and respects disabled ownership', () => {
  const b = bench({ status: 'failed', value: undefined, failure: new RemoteError('gateway/internal', 'offline', {}) })
  const view = render(b.element({ disabled: true }))
  expect(screen.getByRole('menuitem', { name: zh.retry }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('menuitem', { name: zh.retry }))
  expect(b.props.refresh).not.toHaveBeenCalled()
  view.rerender(b.element())
  fireEvent.click(screen.getByRole('menuitem', { name: zh.retry }))
  expect(b.props.refresh).toHaveBeenCalledOnce()
  expect(b.props.onDismiss).not.toHaveBeenCalled()
})

it('does not acquire the connection resource without list permission', () => {
  const b = bench()
  render(b.element({ useRemoteAccess: () => false }))
  expect(b.useResource).not.toHaveBeenCalled()
  expect(screen.queryByRole('group', { name: zh.connections })).toBeNull()
  expect(b.calls).toEqual([])
})

it('captures a right-click target without connecting or selecting a Workspace', () => {
  const b = bench()
  render(b.element())
  expect(screen.queryByText('管理 SSH 连接…')).toBeNull()
  const row = screen.getByRole('menuitem', { name: /生产服务器 deploy@prod\.example\.com:2222/ })
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 })
  fireEvent(row, event)
  expect(event.defaultPrevented).toBe(true)
  const [target, point] = b.openMenu.mock.calls[0]!
  if (target.kind !== 'hemi-ssh-connection') throw new Error('Expected SSH context target')
  expect(target.value).toEqual({ server, occurrence: 1 })
  expect(JSON.parse(JSON.stringify(target))).toEqual(target)
  expect(b.props.menuTarget).toHaveBeenCalledExactlyOnceWith(server, b.props.onDismiss)
  expect(point).toEqual({ x: 40, y: 60 })
  expect(b.calls).toEqual([])
  expect(b.props.openConnection).not.toHaveBeenCalled()
  expect(b.selectWorkspace).not.toHaveBeenCalled()
})

it.each([{ key: 'ContextMenu' }, { key: 'F10', shiftKey: true }])('opens context actions from a focused row with $key', (key) => {
  const b = bench()
  render(b.element())
  const row = screen.getByRole('menuitem', { name: /生产服务器 deploy@prod\.example\.com:2222/ })
  row.focus()
  fireEvent.keyDown(row, key)
  expect(b.openMenu).toHaveBeenCalledOnce()
  expect(document.activeElement).toBe(row)
  expect(b.props.openConnection).not.toHaveBeenCalled()
})

it('keeps ordinary keyboard selection and refuses context actions without edit or delete permission', () => {
  const b = bench()
  render(b.element({ useRemoteAccess: action => action === 'hemiSshServers/list' }))
  const row = screen.getByRole('menuitem', { name: /生产服务器 deploy@prod\.example\.com:2222/ })
  fireEvent.contextMenu(row)
  expect(b.openMenu).not.toHaveBeenCalled()
  expect(row.hasAttribute('disabled')).toBe(false)
  fireEvent.click(row)
  expect(b.props.openConnection).toHaveBeenCalledExactlyOnceWith(server, b.props.onPicked)
})
