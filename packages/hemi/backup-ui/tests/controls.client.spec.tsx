// @vitest-environment jsdom
/** Shared-control semantics of the backup section: labeled selects, the schedule switch, and button states. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { BackupStateView, BackupTarget } from '@deepseek-ai/dsh-hemi-backup/client'
import { BackupSection, type BackupSectionInjected } from '../src/client/BackupSection.tsx'
import type {} from '../src/client/index.ts'
import { en, type BackupLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

async function mount(target: BackupTarget | null = null) {
  const state: BackupStateView = {
    settings: { schemaVersion: 1, target, schedule: { enabled: false, interval: 'daily' }, keep: 5, lastRun: null },
    hasPassword: false, isRunning: false, progress: null,
  }
  const operations = {
    getState: vi.fn(async () => state),
    saveTarget: vi.fn<BackupSectionInjected['saveTarget']>(async () => state),
    saveSchedule: vi.fn(async () => state),
    testConnection: vi.fn(async () => ({ ok: true })),
    runNow: vi.fn(async () => ({ ok: true })),
    listBackups: vi.fn(async () => []),
    deleteSet: vi.fn(async () => ({ ok: true })),
    restorePrepare: vi.fn(async () => ({ ok: true })),
    restoreApply: vi.fn(async () => ({ ok: true })),
    restoreCancel: vi.fn(async () => ({ ok: true })),
  } satisfies BackupSectionInjected
  // This section uses none of the framework's global hooks.
  const runtime = {} as PropsRuntime<'settings.section'>
  render(<BackupSection {...runtime} {...operations} t={key => key in en ? en[key as BackupLocaleKey] : key} />)
  await waitFor(() => { expect(screen.getByRole('button', { name: en.save }).hasAttribute('disabled')).toBe(false) })
  return operations
}

it('exposes the page heading and both selects through accessible labels', async () => {
  await mount()
  expect(screen.getByRole('heading', { level: 2, name: en.title })).toBeTruthy()
  expect(screen.getByRole('combobox', { name: en.targetKind })).toBeTruthy()
  expect(screen.getByRole('combobox', { name: en.scheduleTitle })).toHaveProperty('value', 'daily')
})

it('toggles the automatic-backup switch before saving the schedule', async () => {
  const operations = await mount()
  const toggle = screen.getByRole('switch', { name: en.scheduleEnabled })
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  expect(screen.getByRole('combobox', { name: en.scheduleTitle }).hasAttribute('disabled')).toBe(true)
  await act(async () => { fireEvent.click(toggle) })
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  expect(screen.getByRole('combobox', { name: en.scheduleTitle }).hasAttribute('disabled')).toBe(false)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.saveSchedule })) })
  expect(operations.saveSchedule).toHaveBeenCalledWith({ enabled: true, interval: 'daily' }, 5)
})

it('keeps the run action unavailable until a target is saved', async () => {
  await mount()
  expect(screen.getByRole('button', { name: en.runNow }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: en.refresh }).hasAttribute('disabled')).toBe(true)
})
