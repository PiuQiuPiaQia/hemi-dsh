// @vitest-environment jsdom
import { contextMenuHook } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  WorkspaceId, WorkspaceSnapshot, WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { allowAllAccess, bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { DirectoryFlowOwnerProps, WorkspacePickerProps } from '../src/client/contract/slots.ts'
import { WorkspacePicker } from '../src/client/WorkspacePicker.tsx'
import { zh } from '../src/client/locales.ts'
import { MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'

// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

const anchors = new Set<HTMLElement>()
afterEach(() => {
  cleanup()
  for (const element of anchors) element.remove()
  anchors.clear()
})

// The seat's key domain is workspace ∪ common; the stub mirrors the real
// lookup chain (namespace, then common vocabulary, then the key).
const t: WorkspacePickerProps['t'] = makeTranslate(zh, commonZh)

const wid = (id: string) => id as WorkspaceId
function workspace(id: string, title = id): WorkspaceView {
  return {
    workspaceId: wid(id), path: `/projects/${id}`, title, sessionIds: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }
}
function hook<T>(snapshot: T) {
  return function select<S>(selector: (state: T) => S): S { return selector(snapshot) }
}
const sessions: SessionListState = {
  ids: [], byId: {}, phase: 'ready', projectionsBySession: {},
}
const noPendingInteraction: SessionStatusSnapshot = new Map()
const workspaceState = (items: readonly WorkspaceView[]): WorkspaceSnapshot => ({
  items, archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
})
function anchor(): { current: HTMLElement } {
  const element = document.createElement('button')
  // Menu dismisses disconnected anchors; the fixture owns a real trigger for its full lifetime.
  document.body.append(element)
  anchors.add(element)
  element.getBoundingClientRect = () => ({
    top: 10, left: 20, width: 30, height: 40, right: 50, bottom: 50,
    x: 20, y: 10, toJSON: () => ({}),
  })
  return { current: element }
}

/**
 * Probe occupant of the directory-flow hole: records the latest owner
 * conversation so tests drive onPicked/onCancel/onError like a composed flow
 * package would, and renders a marker element while the flow is open.
 */
function flowProbe() {
  const probe: { owner: DirectoryFlowOwnerProps | undefined } = { owner: undefined }
  const renderSlot = ((_name: string, owner: DirectoryFlowOwnerProps) => {
    probe.owner = owner
    return owner.open ? <div data-testid="directory-flow" data-busy={owner.busy} /> : null
  }) as never
  return { probe, renderSlot }
}

/** Manual occupancy source bound like the renderer would: flip() drives the hook like a real registration change. */
function occupancySource(initial = true) {
  let occupied = initial
  const listeners = new Set<() => void>()
  const useDirectoryFlow = bindSnapshotSelector({
    getSnapshot: () => occupied,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  })
  return {
    useDirectoryFlow,
    flip: (next: boolean) => {
      occupied = next
      for (const listener of [...listeners]) listener()
    },
  }
}

function mount(
  items: readonly WorkspaceView[] = [workspace('alpha', 'Alpha')],
  createWorkspace = vi.fn(),
  occupancy = occupancySource(),
  extra?: Pick<WorkspacePickerProps, 'useAddActions' | 'renderSlot'> & Partial<Pick<WorkspacePickerProps, 'useConnections'>>,
) {
  const onPick = vi.fn()
  const onClose = vi.fn()
  const anchorRef = anchor()
  const { probe, renderSlot } = flowProbe()
  let pickerOpen = true
  const renderPicker = (nextItems: readonly WorkspaceView[]) => (
    <WorkspacePicker
      open={pickerOpen}
      anchorRef={anchorRef}
      useSessions={hook(sessions)}
      useSessionStatus={hook(noPendingInteraction)}
      useSessionRetainInfo={() => undefined}
      usePanelInfo={usePanelInfo} useContextMenu={contextMenuHook()} useResource={useResource}
      useWorkspaces={hook(workspaceState(nextItems))}
      {...allowAllAccess}
      onPick={onPick}
      onClose={onClose}
      createWorkspace={createWorkspace}
      useDirectoryFlow={occupancy.useDirectoryFlow}
      useAddActions={extra?.useAddActions ?? hook(false)}
      useConnections={extra?.useConnections ?? hook(false)}
      renderSlot={extra?.renderSlot ?? renderSlot}
      t={t}
    />
  )
  const view = render(
    renderPicker(items),
  )
  return {
    view, onPick, onClose, createWorkspace, probe, occupancy,
    setOpen: (open: boolean) => { pickerOpen = open; view.rerender(renderPicker(items)) },
    rerenderItems: (nextItems: readonly WorkspaceView[]) => { view.rerender(renderPicker(nextItems)) },
  }
}

function chooseAdd(): void {
  fireEvent.click(screen.getByRole('menuitem', { name: '添加工作区…' }))
}

function extraActions(): Pick<WorkspacePickerProps, 'useAddActions' | 'renderSlot'> {
  return {
    useAddActions: hook(true),
    renderSlot: (name: string, owner: object) => {
      if (name !== 'conversation.hero.workspace.add.actions') return null
      const action = owner as { onDismiss: () => void; disabled: boolean }
      return <MenuItemButton disabled={action.disabled} onSelect={action.onDismiss}>添加 SSH</MenuItemButton>
    },
  }
}

describe('WorkspacePicker', () => {
  it('uses projected names for existing remote Workspaces while preserving local names and selection identity', () => {
    const executionTarget = { provider: 'hemi-ssh', id: 'target' } as NonNullable<WorkspaceView['executionTarget']>
    const b = mount([
      { ...workspace('remote-one', 'modyzer'), path: '/home/modyzer', executionTarget, displayTitle: 'modyzer（aimuxr）' },
      { ...workspace('remote-two', 'modyzer'), path: '/home/modyzer', executionTarget, displayTitle: 'modyzer（staging）' },
      { ...workspace('local', 'Custom local'), path: '/home/modyzer' },
    ])
    expect(screen.getAllByRole('menuitem').map(row => row.textContent))
      .toEqual(['modyzer（aimuxr）', 'modyzer（staging）', 'Custom local', '添加工作区…'])
    expect(screen.getByText('modyzer（aimuxr）').getAttribute('title')).toBe('modyzer（aimuxr）')
    expect(screen.getByRole('menuitem', { name: 'modyzer（aimuxr）' }).querySelector('[data-icon="dsw-icon-globe-outline-regular"]')).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Custom local' }).querySelector('[data-icon="dsw-icon-folder-close-regular"]')).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'modyzer（staging）' }))
    expect(b.onPick).toHaveBeenCalledWith(wid('remote-two'))
    expect(b.createWorkspace).not.toHaveBeenCalled()
  })

  it('keeps complete long provider titles and same-name directory suffixes available in the menu', () => {
    const title = `A deliberately long directory name（${'long-connection-name-'.repeat(8)}）`
    mount([
      { ...workspace('one', 'directory'), path: '/one/directory', displayTitle: title },
      { ...workspace('two', 'directory'), path: '/two/directory', displayTitle: title },
    ])
    expect(screen.getByRole('menuitem', { name: `${title} one/directory` })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: `${title} two/directory` })).toBeTruthy()
    expect(screen.getAllByText(title).every(label => label.getAttribute('title') === title)).toBe(true)
  })

  it('keeps connection sources between directory Workspaces and add actions without selecting a Workspace', () => {
    const openConnection = vi.fn()
    const b = mount([workspace('alpha', 'Alpha')], vi.fn(), occupancySource(), {
      useAddActions: hook(true),
      useConnections: hook(true),
      renderSlot: (name: string, owner: object) => {
        const action = owner as { onDismiss: () => void; disabled: boolean }
        if (name === 'conversation.hero.workspace.connections') {
          return <MenuItemButton disabled={action.disabled} onSelect={() => { action.onDismiss(); openConnection() }}>生产服务器</MenuItemButton>
        }
        if (name === 'conversation.hero.workspace.add.actions') {
          return <MenuItemButton onSelect={action.onDismiss}>添加 SSH</MenuItemButton>
        }
        return null
      },
    })
    expect(screen.getAllByRole('menuitem').map(row => row.textContent)).toEqual(['Alpha', '生产服务器', '添加工作区…', '添加 SSH'])
    fireEvent.click(screen.getByRole('menuitem', { name: '生产服务器' }))
    expect(b.onClose).toHaveBeenCalledOnce()
    expect(openConnection).toHaveBeenCalledOnce()
    expect(b.onPick).not.toHaveBeenCalled()
    expect(b.createWorkspace).not.toHaveBeenCalled()
  })

  it('offers a connection before choosing a directory when no Workspace exists', () => {
    const b = mount([], vi.fn(), occupancySource(), {
      useAddActions: hook(false),
      useConnections: hook(true),
      renderSlot: (name: string, owner: object) => name === 'conversation.hero.workspace.connections'
        ? <MenuItemButton onSelect={(owner as { onDismiss: () => void }).onDismiss}>生产服务器</MenuItemButton> : null,
    })
    expect(screen.getAllByRole('menuitem').map(row => row.textContent)).toEqual(['生产服务器', '添加工作区…'])
    expect(b.createWorkspace).not.toHaveBeenCalled()
    expect(b.onClose).not.toHaveBeenCalled()
  })

  it('pins contributed actions below Add workspace without selecting a Workspace', () => {
    const b = mount([workspace('alpha', 'Alpha')], vi.fn(), occupancySource(), extraActions())
    expect(screen.getAllByRole('menuitem').map(row => row.textContent)).toEqual(['Alpha', '添加工作区…', '添加 SSH'])
    const add = screen.getByRole('menuitem', { name: '添加工作区…' })
    const ssh = screen.getByRole('menuitem', { name: '添加 SSH' })
    expect(ssh.parentElement?.parentElement).toBe(add.parentElement?.parentElement)
    fireEvent.click(ssh)
    expect(b.onClose).toHaveBeenCalledOnce()
    expect(b.onPick).not.toHaveBeenCalled()
    expect(b.createWorkspace).not.toHaveBeenCalled()
  })

  it.each([true, false])('keeps contributed actions reachable without Workspaces, directory flow %s', (directory) => {
    const b = mount([], vi.fn(), occupancySource(directory), extraActions())
    expect(screen.getByRole('menuitem', { name: '添加 SSH' })).toBeTruthy()
    expect(screen.queryByTestId('directory-flow')).toBeNull()
    if (directory) expect(screen.getByRole('menuitem', { name: '添加工作区…' })).toBeTruthy()
    else expect(screen.queryByRole('menuitem', { name: '添加工作区…' })).toBeNull()
    expect(b.createWorkspace).not.toHaveBeenCalled()
  })

  it('does not turn withdrawn extra actions into a directory request during the same gesture', () => {
    const actions = occupancySource(true)
    const b = mount([], vi.fn(), occupancySource(), { ...extraActions(), useAddActions: actions.useDirectoryFlow })
    expect(screen.getByRole('menuitem', { name: '添加 SSH' })).toBeTruthy()
    act(() => { actions.flip(false) })
    expect(screen.getByRole('menuitem', { name: '添加工作区…' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: '添加 SSH' })).toBeNull()
    expect(b.onClose).not.toHaveBeenCalled()
    expect(b.createWorkspace).not.toHaveBeenCalled()
    b.setOpen(false)
    b.setOpen(true)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(b.onClose).toHaveBeenCalledOnce()
  })

  it('labels same-title Workspaces with distinguishing path suffixes and forwards the selected id', () => {
    const b = mount([
      { ...workspace('alpha', 'Shared'), path: '/one/a/Shared' },
      { ...workspace('beta', 'Shared'), path: '/two/a/Shared' },
      workspace('gamma', 'Alone'),
    ])
    expect(screen.getAllByRole('menuitem').map(entry => entry.textContent))
      .toEqual(['Shared one/a/Shared', 'Shared two/a/Shared', 'Alone', '添加工作区…'])
    // The full path stays reachable when a narrow menu truncates the row.
    expect(screen.getByText('two/a/Shared').parentElement?.title).toBe('/two/a/Shared')
    expect(screen.getByRole('menuitem', { name: 'Alone' }).querySelector('[title]')).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Shared two/a/Shared' }))
    expect(b.onPick).toHaveBeenCalledWith(wid('beta'))
  })

  it('opens the composed directory flow, adopts its picked path, and selects the returned Workspace', async () => {
    const created = { ...workspace('adopted'), path: '/tmp/project', title: 'project' }
    const createWorkspace = vi.fn(async () => created)
    const b = mount([workspace('alpha', 'Alpha')], createWorkspace)
    expect(screen.queryByTestId('directory-flow')).toBeNull()
    chooseAdd()
    expect(b.onClose).toHaveBeenCalled()
    expect(screen.getByTestId('directory-flow')).toBeTruthy()
    await act(async () => { b.probe.owner!.onPicked('/tmp/project') })
    expect(createWorkspace).toHaveBeenCalledWith({ path: '/tmp/project' })
    await waitFor(() => { expect(b.onPick).toHaveBeenCalledWith(created.workspaceId) })
    // Successful adoption withdraws the flow request.
    expect(screen.queryByTestId('directory-flow')).toBeNull()
  })

  it('raises the flow straight from the anchor gesture when adding is the only entry', () => {
    // Nothing to list and one action left: a one-row menu would offer no
    // choice, so the owner's open request lands in the flow itself.
    const b = mount([])
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.queryByRole('menuitem', { name: '添加工作区…' })).toBeNull()
    expect(b.onClose).toHaveBeenCalled()
    expect(screen.getByTestId('directory-flow')).toBeTruthy()
  })

  it('treats flow cancellation as a silent no-op', () => {
    const b = mount([workspace('alpha', 'Alpha')])
    chooseAdd()
    act(() => { b.probe.owner!.onCancel() })
    expect(screen.queryByTestId('directory-flow')).toBeNull()
    expect(b.createWorkspace).not.toHaveBeenCalled()
    expect(b.onPick).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('reports a non-Error adoption failure in the folder-error surface', async () => {
    const b = mount([workspace('alpha', 'Alpha')], vi.fn(async () => { throw 'permission denied' }))
    chooseAdd()
    await act(async () => { b.probe.owner!.onPicked('/one/project') })
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: '无法打开文件夹' })).toBeTruthy()
    })
    expect(screen.getByRole('alert').textContent).toBe('permission denied')
    expect(b.probe.owner!.open).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '重新选择' }))
    expect(b.probe.owner!.open).toBe(true)
    expect(b.onPick).not.toHaveBeenCalled()
  })

  it('disables every menu action from flow open through adoption, and reports busy to the flow', async () => {
    let resolve!: (workspace: WorkspaceView) => void
    const pending = new Promise<WorkspaceView>((settle) => { resolve = settle })
    const created = workspace('adopted')
    const b = mount([workspace('alpha', 'Alpha')], vi.fn(() => pending))
    chooseAdd()
    // The flow is open but nothing is picked yet: a chooser pending on the
    // host display must already block concurrent workspace actions.
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Alpha' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: '添加工作区…' }).disabled).toBe(true)
    act(() => { b.probe.owner!.onPicked('/tmp/project') })
    expect(b.probe.owner!.busy).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Alpha' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: '添加工作区…' }).disabled).toBe(true)
    await act(async () => { resolve(created); await pending })
    expect(b.probe.owner!.busy).toBe(false)
  })

  it('shows the flow-reported failure in the folder-error surface', () => {
    const b = mount([workspace('alpha', 'Alpha')])
    chooseAdd()
    act(() => { b.probe.owner!.onError('no chooser installed') })
    expect(screen.getByRole('alert').textContent).toBe('no chooser installed')
    expect(screen.queryByTestId('directory-flow')).toBeNull()
    expect(b.createWorkspace).not.toHaveBeenCalled()
  })

  it('closes the folder-error surface when the user cancels', () => {
    const b = mount([workspace('alpha', 'Alpha')])
    chooseAdd()
    act(() => { b.probe.owner!.onError('no chooser installed') })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('waits to show its menu until an optional anchor is available', () => {
    const { renderSlot } = flowProbe()
    render(
      <WorkspacePicker
        open useSessions={hook(sessions)} useWorkspaces={hook(workspaceState([workspace('alpha', 'Alpha')]))}
        useSessionStatus={hook(noPendingInteraction)}
        useSessionRetainInfo={() => undefined}
        usePanelInfo={usePanelInfo} useContextMenu={contextMenuHook()} useResource={useResource}
        {...allowAllAccess}
        onPick={vi.fn()} onClose={vi.fn()} createWorkspace={vi.fn()}
        useDirectoryFlow={occupancySource().useDirectoryFlow} useAddActions={hook(false)} useConnections={hook(false)}
        renderSlot={renderSlot} t={t}
      />,
    )
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('keeps the menu up while the list baseline is still in flight', () => {
    const state: WorkspaceSnapshot = {
      ...workspaceState([]), phase: 'pending', state: 'loading',
    }
    const { renderSlot } = flowProbe()
    render(
      <WorkspacePicker
        open anchorRef={anchor()} useSessions={hook(sessions)} useWorkspaces={hook(state)}
        useSessionStatus={hook(noPendingInteraction)}
        useSessionRetainInfo={() => undefined}
        usePanelInfo={usePanelInfo} useContextMenu={contextMenuHook()} useResource={useResource}
        {...allowAllAccess}
        onPick={vi.fn()} onClose={vi.fn()} createWorkspace={vi.fn()}
        useDirectoryFlow={occupancySource().useDirectoryFlow} useAddActions={hook(false)} useConnections={hook(false)}
        renderSlot={renderSlot} t={t}
      />,
    )
    // An empty list is not final yet: jumping into the directory flow here
    // would pre-empt the workspaces about to arrive.
    expect(screen.getByRole('status').textContent).toBe('正在加载工作区…')
    expect(screen.queryByTestId('directory-flow')).toBeNull()
    expect(screen.getByRole('menuitem', { name: '添加工作区…' })).toBeTruthy()
  })

  it('shows no popover at all when nothing is listed and nothing can be added', () => {
    // A composition mounting this package without any directory-picker: the
    // hero anchor has neither a Workspace to pick nor a way to add one, so it
    // must not claim a choice with an empty menu.
    const b = mount([], vi.fn(), occupancySource(false))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.queryByTestId('directory-flow')).toBeNull()
    expect(b.createWorkspace).not.toHaveBeenCalled()
  })

  it('holds the anchor gesture while an adoption is still settling', async () => {
    // The auto-open path obeys the same busy rule as the disabled menu entry:
    // an occupant that re-registers mid-adoption must not raise a second flow.
    let resolve!: (workspace: WorkspaceView) => void
    const pending = new Promise<WorkspaceView>((settle) => { resolve = settle })
    const created = workspace('adopted')
    const b = mount([workspace('alpha', 'Alpha')], vi.fn(() => pending))
    chooseAdd()
    act(() => { b.probe.owner!.onPicked('/tmp/project') })
    expect(b.probe.owner!.busy).toBe(true)
    // The list empties under the still-settling adoption (the workspace was
    // deleted elsewhere), which would otherwise make add the only entry.
    act(() => { b.rerenderItems([]) })
    expect(b.createWorkspace).toHaveBeenCalledTimes(1)
    await act(async () => { resolve(created); await pending })
    expect(b.probe.owner!.busy).toBe(false)
  })

  it('hides the add entry while the directory-flow hole is empty', () => {
    mount([workspace('alpha', 'Alpha')], vi.fn(), occupancySource(false))
    expect(screen.getByRole('menuitem', { name: 'Alpha' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: '添加工作区…' })).toBeNull()
  })

  it('shows the add entry when a flow package activates after the first paint', () => {
    const b = mount([workspace('alpha', 'Alpha')], vi.fn(), occupancySource(false))
    expect(screen.queryByRole('menuitem', { name: '添加工作区…' })).toBeNull()
    // Registration changes flow through the subscription, no re-render needed.
    act(() => { b.occupancy.flip(true) })
    expect(screen.getByRole('menuitem', { name: '添加工作区…' })).toBeTruthy()
  })

  it('keeps Choose again inert while the flow occupant is gone, and snaps back a flow opened over an empty hole', async () => {
    const b = mount([workspace('alpha', 'Alpha')], vi.fn(async () => { throw new Error('adoption failed') }))
    chooseAdd()
    await act(async () => { b.probe.owner!.onPicked('/one/project') })
    await waitFor(() => { expect(screen.getByRole('dialog', { name: '无法打开文件夹' })).toBeTruthy() })
    // The occupant unloads while the error dialog is up: retrying would open
    // a flow nobody can serve or cancel, so the button goes inert.
    act(() => { b.occupancy.flip(false) })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '重新选择' }).disabled).toBe(true)
    // Cancel stays the way out, and the menu actions are usable again.
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Alpha' }).disabled).toBe(false)
  })

  it('withdraws an open flow when its occupant unloads, re-enabling the menu actions', () => {
    const b = mount([workspace('alpha', 'Alpha')])
    chooseAdd()
    expect(screen.getByTestId('directory-flow')).toBeTruthy()
    // The flow plugin unloads mid-interaction (HMR): nobody is left to
    // cancel, so the owner withdraws and the actions come back.
    act(() => { b.occupancy.flip(false) })
    expect(b.probe.owner!.open).toBe(false)
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Alpha' }).disabled).toBe(false)
    expect(screen.queryByRole('menuitem', { name: '添加工作区…' })).toBeNull()
  })
})
