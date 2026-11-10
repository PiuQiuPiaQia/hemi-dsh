// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { RemoteDirectoryPicker, type RemoteDirectoryPickerProps } from '../src/client/RemoteDirectoryPicker.tsx'
import { en, zh } from '../src/client/locales.ts'

const directory = {
  path: '/remote/project', parentPath: '/remote',
  directories: [{ name: 'src', path: '/remote/project/src' }, { name: '.hidden', path: '/remote/project/.hidden' }],
}

function pickerProps(): RemoteDirectoryPickerProps {
  return {
    hostLabel: 'user@prod.example:22', initialPath: '/preferred', preferredPath: '/preferred', recentPaths: [],
    directory, navigationRevision: 1, pending: false, ready: true, navigationDisabled: false, canConfirm: true,
    busy: false, problem: undefined, diagnostic: undefined, t: makeTranslate(zh),
    onNavigate: vi.fn(), onConfirm: vi.fn(), onCancel: vi.fn(),
  }
}

function bench(overrides: Partial<RemoteDirectoryPickerProps> = {}) {
  let props = { ...pickerProps(), ...overrides }
  const view = render(<RemoteDirectoryPicker {...props} />)
  return { view, get props() { return props }, update: (next: Partial<RemoteDirectoryPickerProps>) => {
    props = { ...props, ...next }
    view.rerender(<RemoteDirectoryPicker {...props} />)
  } }
}

beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('shows the Hemi picker sections with a generic title and separate remote host', () => {
  const b = bench()
  expect(screen.getByRole('dialog', { name: zh.folderTitle })).toBeTruthy()
  expect(screen.getByText('user@prod.example:22')).toBeTruthy()
  expect(b.view.baseElement.textContent?.match(/user@prod\.example:22/gu)).toHaveLength(1)
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: zh.remotePath }).value).toBe(directory.path)
  expect(screen.getByRole('navigation', { name: zh.folderLocations })).toBeTruthy()
  expect(screen.getByRole('region', { name: zh.currentFolder })).toBeTruthy()
  expect(screen.getByRole('button', { name: zh.useDirectory }).hasAttribute('disabled')).toBe(false)
})

it('enters a folder on one row click without confirming it', () => {
  const b = bench()
  fireEvent.click(screen.getByRole('button', { name: '浏览 src' }))
  expect(b.props.onNavigate).toHaveBeenCalledExactlyOnceWith('/remote/project/src')
  expect(b.props.onConfirm).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: zh.useDirectory }).hasAttribute('disabled')).toBe(true)
})

it('offers remote home, the preferred location and at most three unique recent folders', () => {
  const b = bench({ recentPaths: ['/preferred', '/projects/one', '/projects/one', '/projects/two', '/projects/three', '/projects/four'] })
  fireEvent.click(screen.getByRole('button', { name: zh.homeFolder }))
  expect(b.props.onNavigate).toHaveBeenLastCalledWith('')
  fireEvent.click(screen.getByRole('button', { name: zh.preferredFolder }))
  expect(b.props.onNavigate).toHaveBeenLastCalledWith('/preferred')
  fireEvent.click(screen.getByRole('button', { name: 'two' }))
  expect(b.props.onNavigate).toHaveBeenLastCalledWith('/projects/two')
  expect(screen.getByRole('button', { name: 'one' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'three' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'four' })).toBeNull()
})

it('disables parent navigation at the remote root and still permits its selection', () => {
  const b = bench({ directory: { path: '/', parentPath: '/', directories: [] } })
  const parent = screen.getByRole('button', { name: zh.parentFolder })
  expect(parent.hasAttribute('disabled')).toBe(true)
  fireEvent.click(parent)
  expect(b.props.onNavigate).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: zh.useDirectory }))
  expect(b.props.onConfirm).toHaveBeenCalledExactlyOnceWith('/')
})

it('keeps typed paths auxiliary and does not confirm an unsubmitted address', () => {
  const b = bench()
  const input = screen.getByRole('textbox', { name: zh.remotePath })
  fireEvent.change(input, { target: { value: '/remote/other folder' } })
  expect(screen.getByRole('button', { name: zh.useDirectory }).hasAttribute('disabled')).toBe(true)
  expect(b.props.onNavigate).not.toHaveBeenCalled()
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(b.props.onNavigate).toHaveBeenCalledExactlyOnceWith('/remote/other folder')
  expect(b.props.onConfirm).not.toHaveBeenCalled()
})

it('uses the physical response path after navigation without overwriting a newer address edit', () => {
  const b = bench()
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: zh.remotePath })
  fireEvent.change(input, { target: { value: '/remote/../physical' } })
  fireEvent.click(screen.getByRole('button', { name: zh.goToFolder }))
  b.update({ navigationRevision: 2, pending: true, ready: false })
  expect(input.value).toBe('/remote/../physical')
  b.update({ pending: false, ready: true, directory: { path: '/physical', parentPath: '/', directories: [] } })
  expect(input.value).toBe('/physical')
  expect(screen.getByRole('button', { name: zh.useDirectory }).hasAttribute('disabled')).toBe(false)
  fireEvent.change(input, { target: { value: '/next' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  b.update({ navigationRevision: 3, pending: true, ready: false })
  fireEvent.change(input, { target: { value: '/newer draft' } })
  b.update({ pending: false, ready: true, directory: { path: '/next', parentPath: '/', directories: [] } })
  expect(input.value).toBe('/newer draft')
  expect(screen.getByRole('button', { name: zh.useDirectory }).hasAttribute('disabled')).toBe(true)
})

it('does not navigate when Enter confirms an IME candidate', () => {
  const b = bench()
  const input = screen.getByRole('textbox', { name: zh.remotePath })
  fireEvent.compositionStart(input)
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
  expect(b.props.onNavigate).not.toHaveBeenCalled()
  fireEvent.compositionEnd(input)
  fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })
  expect(b.props.onNavigate).not.toHaveBeenCalled()
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(b.props.onNavigate).toHaveBeenCalledExactlyOnceWith(directory.path)
})

it('hides dot folders in the list while allowing their absolute paths', () => {
  const b = bench()
  expect(screen.queryByRole('button', { name: '浏览 .hidden' })).toBeNull()
  fireEvent.change(screen.getByRole('textbox', { name: zh.remotePath }), { target: { value: '/remote/project/.hidden' } })
  fireEvent.click(screen.getByRole('button', { name: zh.goToFolder }))
  expect(b.props.onNavigate).toHaveBeenCalledExactlyOnceWith('/remote/project/.hidden')
})

it.each([
  { pending: true, ready: false, problem: undefined },
  { pending: false, ready: false, problem: zh.connectionReadFailed },
])('never confirms retained directory data while pending or failed', (status) => {
  const b = bench(status)
  expect(screen.getByRole('button', { name: zh.useDirectory }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: zh.useDirectory }))
  expect(b.props.onConfirm).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: '浏览 src' })).toBeTruthy()
  if (status.pending) expect(screen.getByRole('status', { name: zh.browseLoading })).toBeTruthy()
  else expect(screen.getByRole('alert').textContent).toBe(zh.connectionReadFailed)
})

it('shows initial loading and an empty readable folder without adding a setup or retry form', () => {
  const b = bench({ directory: undefined, pending: true, ready: false })
  expect(screen.getByRole('status', { name: zh.browseLoading })).toBeTruthy()
  expect(screen.queryByRole('button', { name: zh.retry })).toBeNull()
  b.update({ directory: { path: '/empty', parentPath: '/', directories: [] }, pending: false, ready: true })
  expect(screen.getByText(zh.noSubfolders)).toBeTruthy()
  expect(screen.getByRole('button', { name: zh.useDirectory }).hasAttribute('disabled')).toBe(false)
})

it('keeps all navigation permission-gated without blocking cancellation', () => {
  const b = bench({ navigationDisabled: true, canConfirm: false })
  expect(screen.getByRole('textbox', { name: zh.remotePath }).hasAttribute('disabled')).toBe(true)
  for (const name of [zh.goToFolder, zh.homeFolder, zh.preferredFolder, '浏览 src', zh.parentFolder, zh.useDirectory]) {
    expect(screen.getByRole('button', { name }).hasAttribute('disabled')).toBe(true)
  }
  fireEvent.click(screen.getByRole('button', { name: zh.cancel }))
  expect(b.props.onCancel).toHaveBeenCalledOnce()
})

function NestedPicker({ onSubmit }: { onSubmit: () => void }) {
  const [parentOpen, setParentOpen] = useState(true)
  const [pickerOpen, setPickerOpen] = useState(false)
  return <Modal open={parentOpen} title="Connection editor" closeLabel="Close editor" onClose={() => { setParentOpen(false) }}>
    <form onSubmit={(event) => { event.preventDefault(); onSubmit() }}>
      <button type="button" onClick={() => { setPickerOpen(true) }}>Choose folder</button>
      {pickerOpen && <RemoteDirectoryPicker {...pickerProps()} onCancel={() => { setPickerOpen(false) }} />}
    </form>
  </Modal>
}

it('keeps address submission and Escape in the foreground picker and restores its invoking control', () => {
  const submit = vi.fn()
  render(<NestedPicker onSubmit={submit} />)
  const trigger = screen.getByRole('button', { name: 'Choose folder' })
  trigger.focus(); fireEvent.click(trigger)
  const picker = screen.getByRole('dialog', { name: zh.folderTitle })
  const input = within(picker).getByRole('textbox', { name: zh.remotePath })
  fireEvent.submit(input.closest('form')!)
  expect(submit).not.toHaveBeenCalled()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('dialog', { name: zh.folderTitle })).toBeNull()
  expect(screen.getByRole('dialog', { name: 'Connection editor' })).toBeTruthy()
  expect(document.activeElement).toBe(trigger)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('uses the English locale for picker chrome and actions', () => {
  bench({ t: makeTranslate(en) })
  expect(screen.getByRole('dialog', { name: en.folderTitle })).toBeTruthy()
  expect(screen.getByRole('button', { name: en.homeFolder })).toBeTruthy()
  expect(screen.getByRole('button', { name: en.goToFolder })).toBeTruthy()
  expect(screen.getByRole('button', { name: en.useDirectory })).toBeTruthy()
})
