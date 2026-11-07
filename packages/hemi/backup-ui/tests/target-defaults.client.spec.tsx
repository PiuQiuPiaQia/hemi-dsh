// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { BackupStateView, BackupTarget } from '@deepseek-ai/dsh-hemi-backup/client'
import { BackupSection, type BackupSectionInjected } from '../src/client/BackupSection.tsx'
import type {} from '../src/client/index.ts'
import { en, zh, type BackupLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

async function mount(copy = en, target: BackupTarget | null = null) {
  const state: BackupStateView = {
    settings: { schemaVersion: 1, target, schedule: { enabled: false, interval: 'daily' }, keep: 5, lastRun: null },
    hasPassword: false, isRunning: false, progress: null,
  }
  const operations = {
    getState: vi.fn(async () => state),
    saveTarget: vi.fn<BackupSectionInjected['saveTarget']>(async () => state),
    saveSchedule: vi.fn(async () => state),
    testConnection: vi.fn<BackupSectionInjected['testConnection']>(async () => ({ ok: true })),
    runNow: vi.fn(async () => ({ ok: true })),
    listBackups: vi.fn(async () => []),
    deleteSet: vi.fn(async () => ({ ok: true })),
    restorePrepare: vi.fn(async () => ({ ok: true })),
    restoreApply: vi.fn(async () => ({ ok: true })),
    restoreCancel: vi.fn(async () => ({ ok: true })),
  } satisfies BackupSectionInjected
  // This section uses none of the framework's global hooks.
  const runtime = {} as PropsRuntime<'settings.section'>
  render(<BackupSection {...runtime} {...operations} t={key => key in copy ? copy[key as BackupLocaleKey] : key} />)
  await waitFor(() => { expect(screen.getByRole('button', { name: copy.save }).hasAttribute('disabled')).toBe(false) })
  return operations
}

it.each([en, zh].flatMap(copy => [null, { kind: 'local' as const, dir: '/backups' }].map(target => ({ copy, target }))))(
  'prefills a usable WebDAV address when switching from $target',
  async ({ copy, target }) => {
    await mount(copy, target)
    fireEvent.change(screen.getByDisplayValue(copy.targetLocal), { target: { value: 'webdav' } })
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: copy.targetUrl }).value)
      .toBe('https://dav.jianguoyun.com/dav/')
  },
)

it('uses the default address for connection testing and saving', async () => {
  const operations = await mount()
  fireEvent.change(screen.getByDisplayValue(en.targetLocal), { target: { value: 'webdav' } })
  fireEvent.change(screen.getByLabelText(en.targetUsername), { target: { value: 'test@example.com' } })
  fireEvent.change(screen.getByLabelText(en.targetPassword), { target: { value: 'test-app-password' } })
  const draft = {
    kind: 'webdav', dir: '', url: 'https://dav.jianguoyun.com/dav/',
    username: 'test@example.com', password: 'test-app-password', remoteDir: 'hemi-backups',
  }
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.test })) })
  expect(operations.testConnection).toHaveBeenCalledWith(draft)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.save })) })
  expect(operations.saveTarget).toHaveBeenCalledWith(draft)
})

it('preserves saved and edited custom addresses when switching target types', async () => {
  await mount(en, { kind: 'webdav', url: 'https://backup.example.com/dav/', username: 'tester', remoteDir: 'custom' })
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: en.targetUrl })
  expect(input.value).toBe('https://backup.example.com/dav/')
  fireEvent.change(input, { target: { value: 'https://edited.example.com/dav/' } })
  fireEvent.change(screen.getByDisplayValue(en.targetWebdav), { target: { value: 'local' } })
  fireEvent.change(screen.getByDisplayValue(en.targetLocal), { target: { value: 'webdav' } })
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: en.targetUrl }).value).toBe('https://edited.example.com/dav/')
})
