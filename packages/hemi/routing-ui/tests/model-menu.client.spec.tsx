// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import '../src/client/model-picker/slots.ts'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { RoutingModeChoice, RoutingModeToggle, type RoutingModeChoiceProps, type RoutingModeProps } from '../src/client/RoutingModeToggle.tsx'
import { RoutingModelLabel, type RoutingLabelProps } from '../src/client/RoutingModelLabel.tsx'
import { en, zh } from '../src/client/locales.ts'

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function modeProps(enabled: boolean | null = false, child?: 'addressed' | 'listed'): RoutingModeProps {
  return {
    sessionId: SessionId('root'),
    useSession: (select: (value: { subagent: object | null }) => unknown) => select({ subagent: child === 'addressed' ? {} : null }),
    useSessions: (select: (value: { byId: object }) => unknown) => select({ byId: child === 'listed' ? { root: { origin: 'subagent' } } : {} }),
    useRoutingSettings: (select: (value: object) => unknown) => select({
      status: enabled === null ? 'unavailable' : 'ready', writable: true,
      value: { main: { provider: 'p', model: 'm' }, roles: {}, sessionModes: { root: enabled === true } },
    }),
    locked: false, dismiss: vi.fn(), reportFailure: vi.fn(), setEnabled: vi.fn(async () => null),
    openConfiguration: vi.fn(), t: makeTranslate(zh),
  } as RoutingModeProps
}

it('resubmits the selected automatic mode through the model-menu owner', async () => {
  const props: RoutingModeChoiceProps = {
    ...modeProps(true), selectAlternative: vi.fn((activate: () => Promise<string | null>) => { void activate() }),
  }
  const view = render(<RoutingModeChoice {...props} />)
  await act(async () => { fireEvent.click(screen.getByRole('menuitemradio', { name: '自动路由' })) })
  expect(props.selectAlternative).toHaveBeenCalledOnce()
  expect(props.setEnabled).toHaveBeenCalledWith(true)
  expect(props.dismiss).not.toHaveBeenCalled()
  view.rerender(<RoutingModeChoice {...props} useRoutingSettings={select => select({
    status: 'ready', writable: false, revision: 1, base: {}, user: {},
    value: { main: { provider: 'p', model: 'm' }, roles: {}, sessionModes: { root: true } },
  })} />)
  expect(screen.getByRole('menuitemradio', { name: '自动路由' }).hasAttribute('disabled')).toBe(true)
})

it('reads saved preferences rather than optimistic mode and disables while pending', async () => {
  const operation = Promise.withResolvers<string | null>()
  const props = modeProps()
  props.setEnabled = vi.fn(() => operation.promise)
  const view = render(<RoutingModeToggle {...props} />)
  const toggle = screen.getByRole('switch', { name: '自动路由' })
  fireEvent.click(toggle)
  expect(props.setEnabled).toHaveBeenCalledWith(true)
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  expect(toggle.hasAttribute('disabled')).toBe(true)
  await act(async () => { operation.resolve(null) })
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  view.rerender(<RoutingModeToggle {...props} useRoutingSettings={modeProps(true).useRoutingSettings} />)
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  expect(toggle.hasAttribute('disabled')).toBe(false)
  await act(async () => { fireEvent.click(toggle) })
  expect(props.setEnabled).toHaveBeenLastCalledWith(false)
})

it.each(['refused', 'error', 'string'] as const)('reports %s changes through the native menu owner', async (kind) => {
  const props = modeProps()
  props.setEnabled = vi.fn(async () => {
    if (kind === 'error') throw new Error('offline')
    if (kind === 'string') throw 'offline'
    return 'offline'
  })
  render(<RoutingModeToggle {...props} />)
  await act(async () => { fireEvent.click(screen.getByRole('switch')) })
  expect(props.reportFailure).toHaveBeenCalledWith('自动路由切换失败：offline')
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
})

it.each([false, true])('dismisses the menu before opening configuration, including locked composers (%s)', (locked) => {
  const props = modeProps()
  render(<RoutingModeToggle {...props} locked={locked} />)
  const gear = screen.getByRole('menuitem', { name: '配置模型路由' })
  fireEvent.focus(gear)
  expect(screen.getByRole('tooltip', { hidden: true }).textContent).toBe('配置模型路由')
  expect(gear.hasAttribute('disabled')).toBe(false)
  fireEvent.click(gear)
  expect(props.dismiss).toHaveBeenCalledBefore(vi.mocked(props.openConfiguration))
  expect(props.openConfiguration).toHaveBeenCalledOnce()
  expect(props.setEnabled).not.toHaveBeenCalled()
  expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(locked)
})

it('keeps configuration reachable without a main model and permits turning auto off', async () => {
  const settings = (enabled: boolean): RoutingModeProps['useRoutingSettings'] =>
    ((select: (value: object) => unknown) => select({
      status: 'ready', writable: true, value: { main: null, roles: {}, sessionModes: { root: enabled } },
    })) as RoutingModeProps['useRoutingSettings']
  const props = modeProps()
  const view = render(<RoutingModeToggle {...props} useRoutingSettings={settings(false)} />)
  expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(true)
  expect(screen.getByText('请先配置主模型')).toBeTruthy()
  fireEvent.click(screen.getByRole('menuitem', { name: '配置模型路由' }))
  expect(props.openConfiguration).toHaveBeenCalledOnce()
  view.rerender(<RoutingModeToggle {...props} useRoutingSettings={settings(true)} />)
  expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(false)
  await act(async () => { fireEvent.click(screen.getByRole('switch')) })
  expect(props.setEnabled).toHaveBeenCalledWith(false)
})

it('does not offer writes to read-only settings', () => {
  const settings = ((select: (value: object) => unknown) => select({
    status: 'ready', writable: false,
    value: { main: { provider: 'p', model: 'm' }, roles: {}, sessionModes: { root: true } },
  })) as RoutingModeProps['useRoutingSettings']
  render(<RoutingModeToggle {...modeProps(true)} useRoutingSettings={settings} />)
  expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
})

it('renders nothing without the routing settings namespace', () => {
  render(<RoutingModeToggle {...modeProps(null)} />)
  expect(screen.queryByRole('switch')).toBeNull()
})

it('does not reuse another conversation’s enabled preference', () => {
  render(<RoutingModeToggle {...modeProps(true)} sessionId={SessionId('other')} />)
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
})

it.each(['addressed', 'listed'] as const)('hides independent routing on child Sessions (%s)', (child) => {
  const settings = vi.fn((): never => { throw new Error('child must not read root routing preferences') })
  render(<RoutingModeToggle {...modeProps(false, child)} useRoutingSettings={settings} />)
  expect(screen.queryByRole('switch')).toBeNull()
  expect(screen.queryByRole('menuitem')).toBeNull()
  expect(settings).not.toHaveBeenCalled()
})

function labelProps(enabled: boolean, placement: RoutingLabelProps['placement'] = 'trigger', child?: 'addressed' | 'listed'): RoutingLabelProps {
  return {
    ...modeProps(enabled, child), provider: { id: 'p', name: 'Provider' },
    model: { id: 'm', name: 'Original model', badge: { text: { en: 'Official', zh: '官方' }, tone: 'info' } },
    placement, selected: true, resolveText: vi.fn(() => '官方'),
  }
}

it.each(['trigger', 'menu', 'option'] as const)('changes only the trigger to automatic routing (%s)', (placement) => {
  const props = labelProps(true, placement)
  const { container } = render(<RoutingModelLabel {...props} />)
  if (placement === 'trigger') {
    expect(container.textContent).toBe('自动路由')
    expect(screen.queryByText('Original model')).toBeNull()
    expect(props.resolveText).not.toHaveBeenCalled()
  } else {
    expect(container.textContent).toBe('Original model 官方')
    expect(props.resolveText).toHaveBeenCalledWith({ en: 'Official', zh: '官方' })
    expect(screen.queryByText('自动路由')).toBeNull()
  }
})

it.each(['trigger', 'menu', 'option'] as const)('preserves names and badge order in fixed mode (%s)', (placement) => {
  const { container } = render(<RoutingModelLabel {...labelProps(false, placement)} />)
  expect(container.textContent).toBe(placement === 'trigger' ? '官方 Original model' : 'Original model 官方')
  expect(container.querySelector('[data-tone="info"]')).not.toBeNull()
})

it('preserves a model without a badge or available routing settings', () => {
  render(<RoutingModelLabel {...labelProps(false)} model={{ id: 'plain', name: 'Plain model' }}
    useRoutingSettings={modeProps(null).useRoutingSettings} />)
  expect(screen.getByText('Plain model')).toBeTruthy()
})

it('does not label a different conversation as automatic', () => {
  const { container } = render(<RoutingModelLabel {...labelProps(true)} sessionId={SessionId('other')} />)
  expect(container.textContent).toBe('官方 Original model')
})

it.each(['addressed', 'listed'] as const)('shows a child Session’s actual model (%s)', (child) => {
  const { container } = render(<RoutingModelLabel {...labelProps(true, 'trigger', child)} />)
  expect(container.textContent).toBe('官方 Original model')
})

it.each([en, zh])('provides localized labels and the same-model limitation', (dictionary) => {
  render(<RoutingModeToggle {...modeProps()} t={makeTranslate(dictionary)} />)
  expect(screen.getByRole('switch', { name: dictionary.auto })).toBeTruthy()
  expect(screen.getByRole('menuitem', { name: dictionary.configure })).toBeTruthy()
  expect(dictionary.sameModel).toBeTruthy()
  expect(Object.keys(dictionary).sort()).toEqual(Object.keys(en).sort())
})
