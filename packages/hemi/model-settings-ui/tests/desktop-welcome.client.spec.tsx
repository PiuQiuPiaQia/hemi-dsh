// @vitest-environment jsdom
/** Desktop introduction navigates to the shared connection page without provider authentication. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DesktopWelcome } from '../src/client/DesktopWelcome.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

it.each([en, zh])('offers model setup and workspace entry using localized copy', async (copy) => {
  const acknowledge = vi.fn(async () => {})
  const complete = vi.fn()
  const openSection = vi.fn()
  render(<DesktopWelcome stepId="hemi-desktop-welcome" loadFailed={false} reload={async () => ({ enabled: true, completed: false })}
    acknowledge={acknowledge} complete={complete} openSection={openSection} t={key => copy[key]} />)
  await expect(screen.getByRole('dialog').textContent + '\n').toMatchFileSnapshot(`./expected/desktop-welcome-${copy === en ? 'en' : 'zh'}.txt`)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: copy.configureModels })) })
  expect(acknowledge).toHaveBeenCalledOnce()
  expect(complete).toHaveBeenCalledOnce()
  expect(openSection).toHaveBeenCalledExactlyOnceWith('hemi-model-access')
})

it('retains a failed save and enters the workspace after a successful retry', async () => {
  const acknowledge = vi.fn(async () => {})
  acknowledge.mockRejectedValueOnce(new Error('settings unavailable'))
  const complete = vi.fn()
  const openSection = vi.fn()
  render(<DesktopWelcome stepId="hemi-desktop-welcome" loadFailed={false} reload={async () => ({ enabled: true, completed: false })}
    acknowledge={acknowledge} complete={complete} openSection={openSection} t={key => en[key]} />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.enterWorkspace })) })
  expect(screen.getByRole('alert').textContent).toBe(en.welcomeFailed)
  expect(complete).not.toHaveBeenCalled()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.enterWorkspace })) })
  expect(complete).toHaveBeenCalledOnce()
  expect(openSection).not.toHaveBeenCalled()
})

it('retries local setup reads and skips an introduction already completed elsewhere', async () => {
  const complete = vi.fn()
  const reload = vi.fn(async () => ({ enabled: true, completed: false }))
  reload.mockRejectedValueOnce(new Error('settings temporarily unavailable'))
  reload.mockResolvedValueOnce({ enabled: true, completed: true })
  render(<DesktopWelcome stepId="hemi-desktop-welcome" loadFailed reload={reload}
    acknowledge={vi.fn(async () => {})} complete={complete} openSection={vi.fn()} t={key => en[key]} />)
  expect(screen.getByRole('alert').textContent).toBe(en.welcomeLoadFailed)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(complete).not.toHaveBeenCalled()
  expect(reload).not.toHaveBeenCalled()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.retry })) })
  expect(complete).not.toHaveBeenCalled()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.retry })) })
  expect(complete).toHaveBeenCalledOnce()
})

it('keeps navigation disabled while the completion marker is being saved', async () => {
  const save = Promise.withResolvers<undefined>()
  const acknowledge = vi.fn(() => save.promise)
  const complete = vi.fn()
  render(<DesktopWelcome stepId="hemi-desktop-welcome" loadFailed={false} reload={async () => ({ enabled: true, completed: false })}
    acknowledge={acknowledge} complete={complete} openSection={vi.fn()} t={key => en[key]} />)
  fireEvent.click(screen.getByRole('button', { name: en.configureModels }))
  fireEvent.click(screen.getByRole('button', { name: en.enterWorkspace }))
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(acknowledge).toHaveBeenCalledOnce()
  expect(complete).not.toHaveBeenCalled()
  await act(async () => { save.resolve(undefined); await save.promise })
  expect(complete).toHaveBeenCalledOnce()
})
