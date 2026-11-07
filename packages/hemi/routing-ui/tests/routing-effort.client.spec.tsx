// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { RoutingEffortSelect, type RoutingEffortProps } from '../src/client/RoutingEffortSelect.tsx'
import { zh } from '../src/client/locales.ts'

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function bindings(): RoutingEffortProps {
  return {
    sessionId: SessionId('root'), locked: false, reportFailure: vi.fn(), t: makeTranslate(zh),
    useRoutingSettings: select => select({ status: 'ready', writable: true, revision: 1, base: {}, user: {},
      value: { main: null, roles: {}, sessionModes: { root: true }, sessionEfforts: { root: 'medium', other: 'low' } },
    }), setEffort: vi.fn(async () => null),
  }
}

it('shows exactly four localized levels and saves without selecting a concrete model', async () => {
  const props = bindings()
  render(<RoutingEffortSelect {...props} />)
  const trigger = screen.getByRole('button', { name: '推理强度' })
  expect(trigger.textContent).toBe('中')
  fireEvent.click(trigger)
  const labels = screen.getAllByRole('menuitem').map(row => row.textContent)
  expect(labels).toEqual(['低', '中', '高', '最高'])
  await expect(`${labels.join('\n')}\n`).toMatchFileSnapshot('./expected/routing-efforts.txt')
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: '最高' })) })
  expect(props.setEffort).toHaveBeenCalledWith('max')
  expect(screen.queryByRole('menu')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

it('resubmits the current level as an explicit preference for new conversations', async () => {
  const props = bindings()
  render(<RoutingEffortSelect {...props} />)
  fireEvent.click(screen.getByRole('button', { name: '推理强度' }))
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: '中' })) })
  expect(props.setEffort).toHaveBeenCalledWith('medium')
  expect(screen.queryByRole('menu')).toBeNull()
})

it('retains the accepted level and reports a rejected save', async () => {
  const props = bindings()
  props.setEffort = vi.fn(async () => 'offline')
  render(<RoutingEffortSelect {...props} />)
  fireEvent.click(screen.getByRole('button', { name: '推理强度' }))
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: '低' })) })
  expect(screen.getByRole('button', { name: '推理强度' }).textContent).toBe('中')
  expect(props.reportFailure).toHaveBeenCalledWith('推理强度保存失败：offline')
})

it('uses the routing default for a different conversation and disables locked controls', () => {
  render(<RoutingEffortSelect {...bindings()} sessionId={SessionId('fresh')} locked />)
  const trigger = screen.getByRole('button', { name: '推理强度' })
  expect(trigger.textContent).toBe('高')
  expect(trigger.hasAttribute('disabled')).toBe(true)
})
