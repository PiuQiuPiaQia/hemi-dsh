// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { bindSnapshotSelector, contextMenuHook, makeTranslate, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { RoutingDialog, type RoutingDialogProps } from '../src/client/RoutingDialog.tsx'
import { RoutingSettingsEntry } from '../src/client/RoutingSettingsEntry.tsx'
import type { RoutingConfig, RoutingCatalog, RoutingWrite } from '../src/client/types.ts'
import { createRoutingEditor } from '../src/client/editor-state.ts'
import { en, zh } from '../src/client/locales.ts'

const main = { provider: 'provider/a', model: 'model/a', reasoningEffort: 'high' }
const alternative = { provider: 'provider/a', model: 'model/b' }
const initial: RoutingConfig = { main, roles: { oracle: { provider: 'removed', model: 'retired/model', reasoningEffort: 'low' } } }
const groups = [{ id: 'provider/a', name: 'Provider A', models: [{ id: 'model/a', name: 'Main catalog model' }, { id: 'model/b', name: 'Alternative model' }] }]
const unused = (): never => { throw new Error('This isolated component does not consume framework hooks') }
const standard: GlobalStandardProps = {
  useSessions: unused, useSessionStatus: unused, useSessionRetainInfo: unused,
  useSessionAccess: () => true, useRemoteAccess: () => true, useWorkspaceAccess: () => true,
  usePanelInfo: unused, useContextMenu: contextMenuHook(), useResource: unused, useWorkspaces: unused,
}
let scrollDescriptor: PropertyDescriptor | undefined
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  if (scrollDescriptor === undefined) Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
  else Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollDescriptor)
})

function props(options: {
  settings?: Partial<ConfigFormSnapshot<RoutingConfig>>
  catalog?: Partial<RoutingCatalog>
  write?: RoutingWrite
  dictionary?: typeof en
} = {}): RoutingDialogProps {
  const settings = createSnapshotStore<ConfigFormSnapshot<RoutingConfig>>({
    status: 'ready', value: initial, writable: true, revision: 1, base: undefined, user: undefined, ...options.settings,
  })
  const catalog = createSnapshotStore<RoutingCatalog>({ status: 'ready', groups, failures: [], error: null, ...options.catalog })
  const write = createSnapshotStore<RoutingWrite>(options.write ?? { status: 'idle' })
  return {
    useRoutingOpen: () => true,
    useRoutingSettings: bindSnapshotSelector(settings),
    useRoutingCatalog: bindSnapshotSelector(catalog),
    useRoutingWrite: bindSnapshotSelector(write),
    saveRoute: vi.fn(), refreshCatalog: vi.fn(), closeConfiguration: vi.fn(),
    t: makeTranslate(options.dictionary ?? zh),
  } as RoutingDialogProps
}

it('renders the main model, four preset roles and same-model limitation without idle hints', () => {
  render(<RoutingDialog {...props()} />)
  expect(screen.getByRole('dialog', { name: '模型路由' })).toBeTruthy()
  expect(screen.getAllByRole('button', { name: /^(主智能体|研究|评审|执行|设计)：/ })).toHaveLength(5)
  expect(screen.getByRole('button', { name: '评审：retired/model' })).toBeTruthy()
  expect(screen.getByText('removed · retired/model')).toBeTruthy()
  expect(screen.getByText('当前目录中找不到此型号，原配置已保留，选择新模型后才会替换')).toBeTruthy()
  expect(screen.getByText('推理强度：low')).toBeTruthy()
  expect(screen.getByText('要固定使用当前同一型号，请先关闭自动路由')).toBeTruthy()
  expect(screen.queryByText('每次选择都会自动保存')).toBeNull()
  expect(screen.queryByText('主模型与角色模型改动从下一回合生效；已准备的请求和已派出的子任务不变')).toBeNull()
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
})

it('selects only catalog models and allows a role to follow the main model', async () => {
  const p = props()
  render(<RoutingDialog {...p} />)
  fireEvent.click(screen.getByRole('button', { name: '研究：跟随主模型' }))
  await screen.findByRole('menuitem', { name: 'Alternative model' })
  fireEvent.click(screen.getByRole('menuitem', { name: 'Alternative model' }))
  expect(p.saveRoute).toHaveBeenCalledWith('explorer', alternative)
  fireEvent.click(screen.getByRole('button', { name: '评审：retired/model' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '跟随主模型' }))
  expect(p.saveRoute).toHaveBeenLastCalledWith('oracle', null)
  expect(screen.queryByRole('menu')).toBeNull()
})

it('offers no follow-main or clear choice for the main model and never writes a null main route', async () => {
  const p = props()
  render(<RoutingDialog {...p} />)
  fireEvent.click(screen.getByRole('button', { name: '主智能体：Main catalog model' }))
  const menu = await screen.findByRole('menu')
  expect(within(menu).queryByRole('menuitem', { name: '跟随主模型' })).toBeNull()
  expect(within(menu).getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Main catalog model', 'Alternative model'])
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
  expect(p.saveRoute).not.toHaveBeenCalled()
})

it('retains the effort when reselecting the same catalog model', async () => {
  const p = props()
  render(<RoutingDialog {...p} />)
  fireEvent.click(screen.getByRole('button', { name: '主智能体：Main catalog model' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Main catalog model' }))
  expect(p.saveRoute).toHaveBeenCalledWith('main', main)
})

it('displays saved values only after the Host mirror accepts a field change', async () => {
  const form = stubConfigForm<RoutingConfig>()
  form.publish({ status: 'ready', writable: true, revision: 1, value: initial })
  const editor = createRoutingEditor(form.scope, async () => ({ default: main, routableProviders: ['provider/a'], groups, failures: [] }))
  onTestFinished(() => editor.dispose())
  editor.injected.refreshCatalog()
  await vi.waitFor(() => { expect(editor.injected.hooks.routingCatalog.getSnapshot().status).toBe('ready') })
  const operation = Promise.withResolvers<boolean>()
  form.mutate.mockReturnValueOnce(operation.promise)
  const p = props()
  const view = render(<RoutingDialog {...p}
    useRoutingSettings={bindSnapshotSelector(form.scope)}
    useRoutingCatalog={bindSnapshotSelector(editor.injected.hooks.routingCatalog)}
    useRoutingWrite={bindSnapshotSelector(editor.injected.hooks.routingWrite)}
    saveRoute={editor.injected.saveRoute} />)
  fireEvent.click(screen.getByRole('button', { name: '主智能体：Main catalog model' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Alternative model' }))
  expect(screen.getByRole('button', { name: '主智能体：Main catalog model' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByText('正在保存主智能体…')).toBeTruthy()
  await act(async () => {
    form.publish({ revision: 2, value: { ...initial, main: alternative } })
    operation.resolve(true)
  })
  expect(screen.getByRole('button', { name: '主智能体：Alternative model' }).hasAttribute('disabled')).toBe(false)
  expect(screen.getByText('主智能体已保存，从下一回合生效')).toBeTruthy()
  view.unmount()
  await editor.dispose()
})

it.each(['readOnly', 'saving', 'catalogFailed'] as const)('blocks model changes while %s', (state) => {
  const p = props(state === 'readOnly' ? { settings: { writable: false } }
    : state === 'saving' ? { write: { status: 'saving', field: 'main' } }
      : { catalog: { status: 'failed', error: 'offline' } })
  render(<RoutingDialog {...p} />)
  const buttons = screen.getAllByRole('button', { name: /^(主智能体|研究|评审|执行|设计)：/ })
  expect(buttons.every(button => button.hasAttribute('disabled'))).toBe(true)
  if (state === 'readOnly') expect(screen.getByText('当前设置仅可查看')).toBeTruthy()
  if (state === 'catalogFailed') {
    expect(screen.getByRole('alert').textContent).toContain('模型目录加载失败：offline')
    fireEvent.click(screen.getByRole('button', { name: '重新加载目录' }))
    expect(p.refreshCatalog).toHaveBeenCalledOnce()
  }
  expect(p.saveRoute).not.toHaveBeenCalled()
})

it.each(['loading', 'unavailable', 'empty', 'partial', 'saveRefused', 'saveError'] as const)('makes %s visible', (state) => {
  const p = props(state === 'loading' ? { settings: { status: 'loading' } }
    : state === 'unavailable' ? { settings: { status: 'unavailable', value: undefined } }
      : state === 'empty' ? { catalog: { groups: [] } }
        : state === 'partial' ? { catalog: { failures: [{ id: 'down', name: 'Down provider', message: 'offline' }] } }
          : state === 'saveRefused' ? { write: { status: 'failed', field: 'explorer', message: null } }
            : { write: { status: 'failed', field: 'main', message: 'offline' } })
  render(<RoutingDialog {...p} />)
  expect(screen.getByRole('dialog').textContent).toMatchSnapshot()
  if (state === 'loading') expect(screen.getByRole('status', { name: '正在加载模型路由' })).toBeTruthy()
  if (state === 'saveRefused' || state === 'saveError') expect(screen.getByRole('alert')).toBeTruthy()
})

it('gives an open picker Escape first, then closes the dialog and restores its invoking control', async () => {
  const trigger = document.createElement('button')
  document.body.append(trigger)
  trigger.focus()
  const open = createSnapshotStore(true)
  const close = vi.fn(() => { open.set(false) })
  const view = render(<RoutingDialog {...props()} useRoutingOpen={bindSnapshotSelector(open)} closeConfiguration={close} />)
  const picker = screen.getByRole('button', { name: '主智能体：Main catalog model' })
  fireEvent.click(picker)
  await screen.findByRole('menu')
  fireEvent.keyDown(document, { key: 'ArrowDown' })
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
  expect(close).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(picker)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(close).toHaveBeenCalledOnce()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  view.unmount()
  trigger.remove()
})

it('keeps the Models settings footer as a launcher, not a second editor', () => {
  const openConfiguration = vi.fn()
  render(<RoutingSettingsEntry {...standard} openConfiguration={openConfiguration} t={makeTranslate(zh)} />)
  fireEvent.click(screen.getByRole('button', { name: '配置模型路由' }))
  expect(openConfiguration).toHaveBeenCalledOnce()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('combobox')).toBeNull()
})

it.each([en, zh])('localizes every editor state and keeps provider/model ids unchanged', (dictionary) => {
  render(<RoutingDialog {...props({ dictionary, write: { status: 'failed', field: 'main', message: 'network error' } })} />)
  expect(screen.getByRole('dialog', { name: dictionary.title }).textContent).toMatchSnapshot()
  expect(screen.getByText('removed · retired/model')).toBeTruthy()
})
