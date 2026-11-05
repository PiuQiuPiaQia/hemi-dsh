// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { makeTranslate, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { zh } from '@deepseek-ai/dsh-client-ui-model-selection/src/client/locales.ts'
import type { ModelSelectInjected } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { HemiModelSelect } from '../src/client/model-picker/ModelSelect.tsx'

type Props = ComponentProps<typeof HemiModelSelect>
type Directory = ReturnType<ModelSelectInjected['directory']['getSnapshot']>

function directory(defaultEffort: string | null = 'high', supportsReasoning = true): Directory {
  return {
    current: { provider: 'provider', model: 'model' }, routable: true,
    groups: [{ id: 'provider', name: 'Provider', models: [{ id: 'model', name: 'Reasoning model',
      ...supportsReasoning ? { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
        ...defaultEffort === null ? {} : { defaultEffort } } } : {},
    }] }],
    status: 'ready', failures: [], pending: null, error: null,
  }
}

function props(state = directory()): Props {
  return {
    sessionId: SessionId('effort-picker'), locked: false, available: true,
    useDirectory: select => select(state), useMenuMode: select => select(null),
    load: vi.fn(), select: vi.fn(async () => ({ ok: true as const, value: undefined })),
    resolveText: text => typeof text === 'string' ? text : text.en,
    t: makeTranslate(zh), renderSlot: (_name, _owner, options) => options?.fallback ?? null,
  }
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('shows effort beside the model and saves it through the same selection service', async () => {
  const bindings = props()
  render(<HemiModelSelect {...bindings} />)
  const model = screen.getByRole('button', { name: '选择模型，当前 Reasoning model' })
  const effort = screen.getByRole('button', { name: '推理等级' })
  expect(model.textContent).toBe('Reasoning model')
  expect(model.compareDocumentPosition(effort) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(effort.textContent).toBe('High')
  fireEvent.click(model)
  expect(screen.queryByRole('menuitem', { name: /推理等级/ })).toBeNull()
  fireEvent.click(effort)
  expect(screen.queryByRole('menuitemradio', { name: 'Reasoning model' })).toBeNull()
  await expect(`${[model, effort, ...screen.getAllByRole('menuitem')].map(row => row.textContent).join('\n')}\n`)
    .toMatchFileSnapshot('./expected/effort-picker.txt')
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Low' })) })
  expect(bindings.select).toHaveBeenCalledWith({ provider: 'provider', model: 'model', reasoningEffort: 'low' })
  expect(screen.queryByRole('menu')).toBeNull()
  expect(document.activeElement).toBe(effort)
})

it('dismisses independently with Escape, outside click, and the model trigger', async () => {
  render(<HemiModelSelect {...props()} />)
  const effort = screen.getByRole('button', { name: '推理等级' })
  fireEvent.click(effort)
  await waitFor(() => { expect(document.activeElement?.getAttribute('role')).toBe('menuitem') })
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
  expect(document.activeElement).toBe(effort)
  fireEvent.click(effort)
  fireEvent.pointerDown(document.body)
  expect(screen.queryByRole('menu')).toBeNull()
  fireEvent.click(effort)
  fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
  expect(screen.queryByRole('menuitem', { name: 'Low' })).toBeNull()
  expect(screen.getByRole('menuitemradio', { name: 'Reasoning model' })).toBeTruthy()
})

it('offers the provider default without inventing an effort value', async () => {
  const state = directory(null)
  state.current = { provider: 'provider', model: 'model', reasoningEffort: 'high' }
  const bindings = props(state)
  render(<HemiModelSelect {...bindings} />)
  fireEvent.click(screen.getByRole('button', { name: '推理等级' }))
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Default' })) })
  expect(bindings.select).toHaveBeenCalledWith({ provider: 'provider', model: 'model' })
})

it('retains the saved effort and reports a refused write', async () => {
  const bindings = props()
  bindings.select = vi.fn(async () => ({ ok: false as const,
    error: new RemoteError('session/writer-held', 'Busy', { sessionId: bindings.sessionId }),
  }))
  render(<HemiModelSelect {...bindings} />)
  const effort = screen.getByRole('button', { name: '推理等级' })
  fireEvent.click(effort)
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Low' })) })
  expect(effort.textContent).toBe('High')
  expect(screen.getByText(zh['error.sessionInUse'])).toBeTruthy()
  expect(screen.getByRole('menu')).toBeTruthy()
  expect(document.activeElement).toBe(effort)
})

it('hides effort for unsupported models and automatic routing, and locks writes', () => {
  const state = directory('high', false)
  const view = render(<HemiModelSelect {...props(state)} />)
  expect(screen.queryByRole('button', { name: '推理等级' })).toBeNull()
  view.rerender(<HemiModelSelect {...props()} useMenuMode={select => select({ label: '自动路由', sessions: { 'effort-picker': true } })} />)
  expect(screen.queryByRole('button', { name: '推理等级' })).toBeNull()
  view.rerender(<HemiModelSelect {...props()} locked />)
  expect(screen.getByRole('button', { name: '推理等级' }).hasAttribute('disabled')).toBe(true)
})
