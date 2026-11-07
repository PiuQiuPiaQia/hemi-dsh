// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createModelActionFeedback, ModelActionToast } from '../src/client/ModelActionToast.tsx'
import { en, zh } from '../src/client/copy.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })

it.each([en, zh])('keeps model failures visible after the reporting surface closes', (dictionary) => {
  const feedback = createModelActionFeedback()
  const t = makeTranslate(dictionary)
  render(<ModelActionToast useModelActionNotice={bindSnapshotSelector(feedback.hooks.modelActionNotice)}
    dismiss={feedback.dismiss} t={t} />)
  const panel = render(<button onClick={() => { feedback.reportModelFailure({ operation: 'test', model: 'model/a' }) }}>{t('testModel')}</button>)
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: t('testModel') }))
  panel.unmount()
  expect(screen.getByRole('alert').textContent).toBe(t('modelTestFailed', { model: 'model/a' }))
  expect(screen.getByRole('alert').querySelector('[data-icon="dsw-icon-warning-outline-regular"]')).not.toBeNull()
  expect(screen.queryByRole('button')).toBeNull()
})

it('queues concurrent failures for a full toast lifetime and ignores stale dismissals', () => {
  vi.useFakeTimers()
  const feedback = createModelActionFeedback()
  const t = makeTranslate(en)
  render(<ModelActionToast useModelActionNotice={bindSnapshotSelector(feedback.hooks.modelActionNotice)}
    dismiss={feedback.dismiss} t={t} />)
  act(() => { feedback.reportModelFailure({ operation: 'test', model: 'model/a' }) })
  const first = screen.getByRole('alert')
  act(() => {
    feedback.reportModelFailure({ operation: 'remove', model: 'model/b' })
    feedback.reportModelFailure({ operation: 'test', model: 'model/a' })
  })
  expect(screen.getByRole('alert')).toBe(first)
  expect(screen.getByRole('alert').textContent).toBe(t('modelTestFailed', { model: 'model/a' }))
  act(() => { vi.advanceTimersByTime(4000) })
  expect(screen.getByRole('alert').textContent).toBe(t('modelRemoveFailed', { model: 'model/b' }))
  act(() => { feedback.dismiss(1) })
  expect(screen.getByRole('alert').textContent).toBe(t('modelRemoveFailed', { model: 'model/b' }))
  act(() => { vi.advanceTimersByTime(4000) })
  expect(screen.getByRole('alert')).not.toBe(first)
  expect(screen.getByRole('alert').textContent).toBe(t('modelTestFailed', { model: 'model/a' }))
  act(() => { vi.advanceTimersByTime(4000) })
  expect(feedback.hooks.modelActionNotice.getSnapshot()).toEqual([])
  expect(screen.queryByRole('alert')).toBeNull()
})

it('keeps feedback isolated between plugin instances', () => {
  const first = createModelActionFeedback()
  const second = createModelActionFeedback()
  first.reportModelFailure({ operation: 'test', model: 'model/a' })
  expect(second.hooks.modelActionNotice.getSnapshot()).toEqual([])
})
