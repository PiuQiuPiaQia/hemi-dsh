// @vitest-environment jsdom
/** Localized backup failures never render diagnostic messages or server response bodies. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { BackupSection, type BackupSectionInjected } from '../src/client/BackupSection.tsx'
import type { BackupFailureCode, BackupOperationResult, BackupStateView } from '../src/client/types.ts'
import type {} from '../src/client/index.ts'
import { en, zh, type BackupLocaleKey } from '../src/client/locales.ts'

const diagnostic = 'PUT private-backups/part-0000.gz: HTTP 403 <d:error><s:exception>TrafficRateExhausted</s:exception><s:message>private-server-detail</s:message></d:error>'
const initialState = (): BackupStateView => ({
  settings: {
    schemaVersion: 1, target: { kind: 'local', dir: '/backup-fixture' },
    schedule: { enabled: false, interval: 'daily' }, keep: 5, lastRun: null,
  },
  hasPassword: false, isRunning: false, progress: null,
})

/** Shared operation summaries in the fixture's language, so common fallbacks resolve to real copy. */
const shared = (dictionary: typeof en): Record<'unknown' | 'unavailable', string> => {
  const common = dictionary === zh ? commonZh : commonEn
  return { unknown: common['uiError.unknown'], unavailable: common['uiError.unavailable'] }
}

afterEach(cleanup)

async function mount(dictionary = zh, state = initialState(), overrides: Partial<BackupSectionInjected> = {}) {
  const operations: BackupSectionInjected = {
    getState: async () => state,
    saveTarget: async () => state,
    saveSchedule: async () => state,
    testConnection: async () => ({ ok: true }),
    runNow: async () => ({ ok: true }),
    listBackups: async () => [],
    deleteSet: async () => ({ ok: true }),
    restorePrepare: async () => ({ ok: true }),
    restoreApply: async () => ({ ok: true }),
    restoreCancel: async () => ({ ok: true }),
    ...overrides,
  }
  const runtime = {} as PropsRuntime<'settings.section'>
  const view = render(<BackupSection {...runtime} {...operations} t={makeTranslate(dictionary, dictionary === zh ? commonZh : commonEn)} />)
  await waitFor(() => { expect(screen.getByRole('button', { name: dictionary.save }).hasAttribute('disabled')).toBe(false) })
  return { ...view, runtime, operations }
}

function expectNoDiagnostics(): void {
  expect(document.body.textContent).not.toMatch(/private-backups|private-server-detail|TrafficRateExhausted|<d:error>|HTTP 403/u)
}

it.each([en, zh])('hides legacy last-run diagnostics and retains the failed status', async (dictionary) => {
  const initial = initialState()
  const state: BackupStateView = { ...initial, settings: { ...initial.settings, lastRun: { at: '2026-11-16T12:14:27Z', ok: false, trigger: 'scheduled', message: diagnostic } } }
  await mount(dictionary, state)
  expect(screen.getByText(new RegExp(dictionary.lastRunFailed)).textContent).toContain(shared(dictionary).unknown)
  expectNoDiagnostics()
})

it.each([en, zh])('shows the transfer-quota hint for both last-run status and a failed manual run', async (dictionary) => {
  const initial = initialState()
  const state: BackupStateView = { ...initial, settings: { ...initial.settings, lastRun: { at: '2026-11-16T12:14:27Z', ok: false, trigger: 'manual', code: 'TRAFFIC_EXHAUSTED', message: diagnostic } } }
  await mount(dictionary, state, { runNow: async () => ({ ok: false, code: 'TRAFFIC_EXHAUSTED', message: diagnostic }) })
  expect(screen.getByText(new RegExp(dictionary.lastRunFailed)).textContent).toContain(dictionary.errorTraffic)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: dictionary.runNow })) })
  expect(screen.getByRole('status').textContent).toBe(dictionary.errorTraffic)
  expectNoDiagnostics()
})

it.each<[BackupFailureCode, BackupLocaleKey]>([
  ['BUSY', 'errorBusy'], ['NO_TARGET', 'errorNoTarget'], ['NO_RESTORE', 'errorNoRestore'],
  ['INVALID_NAME', 'errorInvalidName'], ['NO_PASSWORD', 'errorNoPassword'],
  ['AUTH_FAILED', 'errorAuth'], ['NOT_FOUND', 'errorNotFound'], ['REQUEST_FAILED', 'errorRequest'],
  ['FORBIDDEN', 'errorForbidden'], ['TRAFFIC_EXHAUSTED', 'errorTraffic'], ['PARTIAL_RESTORE', 'errorPartialRestore'],
])('localizes connection failure %s without using its message', async (code, key) => {
  await mount(zh, initialState(), { testConnection: async () => ({ ok: false, code, message: diagnostic }) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.test })) })
  expect(screen.getByRole('status').textContent).toBe(zh[key])
  expectNoDiagnostics()
})

it.each([en, zh])('shows the shared summary for the generic FAILED outcome in status and last-run rows', async (dictionary) => {
  const initial = initialState()
  const state: BackupStateView = { ...initial, settings: { ...initial.settings, lastRun: { at: '2026-11-16T12:14:27Z', ok: false, trigger: 'manual', code: 'FAILED', message: diagnostic } } }
  await mount(dictionary, state, { runNow: async () => ({ ok: false, code: 'FAILED', message: diagnostic }) })
  expect(screen.getByText(new RegExp(dictionary.lastRunFailed)).textContent).toContain(shared(dictionary).unknown)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: dictionary.runNow })) })
  expect(screen.getByRole('status').textContent).toBe(shared(dictionary).unknown)
  expectNoDiagnostics()
})

it('maps a rejected Remote call to its shared carrier summary without the diagnostic detail', async () => {
  await mount(zh, initialState(), {
    getState: vi.fn().mockRejectedValue(new RemoteError('gateway/service-unavailable', diagnostic, { endpoint: 'hemiBackup/getState' })),
    testConnection: vi.fn().mockRejectedValue(new RemoteError('gateway/service-unavailable', diagnostic, { endpoint: 'hemiBackup/testConnection' })),
  })
  expect(screen.getByRole('status').textContent).toBe(shared(zh).unavailable)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.test })) })
  expect(screen.getByRole('status').textContent).toBe(shared(zh).unavailable)
  expectNoDiagnostics()
})

it('uses a safe fallback for a rejected initial query and a rejected action', async () => {
  await mount(zh, initialState(), {
    getState: vi.fn().mockRejectedValue(new Error(diagnostic)),
    testConnection: vi.fn().mockRejectedValue(new Error(diagnostic)),
  })
  expect(screen.getByRole('status').textContent).toBe(shared(zh).unknown)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.test })) })
  expect(screen.getByRole('status').textContent).toBe(shared(zh).unknown)
  expectNoDiagnostics()
})

it('retains the backup row and authentication guidance without refreshing after a failed delete', async () => {
  const initial = initialState()
  const state: BackupStateView = { ...initial, hasPassword: true, settings: { ...initial.settings,
    target: { kind: 'webdav', url: 'https://dav.example.test', username: 'fixture-user', remoteDir: 'backups' },
  } }
  const name = 'hemi-backup-20261116-120000'
  const listBackups = vi.fn<BackupSectionInjected['listBackups']>()
    .mockResolvedValueOnce([{ name, createdAt: '2026-11-16T12:00:00Z', packedBytes: 1024, appVersion: null, source: 'webdav' }])
    .mockRejectedValue(new RemoteError('gateway/internal', diagnostic, {}))
  const deleteSet = vi.fn<BackupSectionInjected['deleteSet']>().mockResolvedValue({ ok: false, code: 'AUTH_FAILED', message: diagnostic })
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
  onTestFinished(() => { confirm.mockRestore() })
  await mount(zh, state, { listBackups, deleteSet })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.delete })) })
  expect(screen.getByRole('status').textContent).toBe(zh.errorAuth)
  expect(deleteSet).toHaveBeenCalledWith(name)
  expect(listBackups).toHaveBeenCalledTimes(1)
  expect(screen.getAllByRole('listitem')).toHaveLength(1)
  expect(screen.getByRole('button', { name: zh.restore })).toBeTruthy()
  expect(screen.getByRole('button', { name: zh.delete }).hasAttribute('disabled')).toBe(false)
  expectNoDiagnostics()
})

it('preserves unsaved fields and the pending action when the locale changes', async () => {
  const initial = initialState()
  const state: BackupStateView = { ...initial, settings: { ...initial.settings,
    target: { kind: 'webdav', url: 'https://dav.example.test', username: 'saved-user', remoteDir: 'backups' },
  } }
  const pending = Promise.withResolvers<BackupOperationResult>()
  const getState = vi.fn(async () => state)
  const { rerender, runtime, operations } = await mount(zh, state, { getState, testConnection: () => pending.promise })
  fireEvent.change(screen.getByLabelText(zh.targetUsername), { target: { value: 'draft-user' } })
  fireEvent.change(screen.getByLabelText(zh.targetPassword), { target: { value: 'draft-password' } })
  fireEvent.change(screen.getByLabelText(zh.keepCount), { target: { value: '8' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.test })) })
  await act(async () => {
    rerender(<BackupSection {...runtime} {...operations} t={makeTranslate(en, commonEn)} />)
  })
  expect(screen.getByLabelText(en.targetUsername)).toHaveProperty('value', 'draft-user')
  expect(screen.getByLabelText(en.targetPassword)).toHaveProperty('value', 'draft-password')
  expect(screen.getByLabelText(en.keepCount)).toHaveProperty('value', '8')
  expect(screen.getByRole('button', { name: en.testing }).hasAttribute('disabled')).toBe(true)
  expect(getState).toHaveBeenCalledTimes(1)
  await act(async () => { pending.resolve({ ok: true }) })
})

it('renders localized progress instead of host diagnostic details', async () => {
  const state = { ...initialState(), isRunning: true, progress: { phase: 'upload' as const, detail: diagnostic } }
  await mount(zh, state)
  expect(screen.getByRole('status').textContent).toBe(zh.progressUpload)
  expectNoDiagnostics()
})

it.each([false, true])('preserves the partial-restore warning when the apply request rejects: %s', async (reject) => {
  const safeCopyRoot = '/backup-fixture/restore-safety/restore-fixture'
  await mount(zh, initialState(), {
    listBackups: async () => [{ name: 'hemi-backup-20261116-120000', createdAt: '2026-11-16T12:00:00Z', packedBytes: 1024, appVersion: null, source: 'local' }],
    restorePrepare: async () => ({
      ok: true, preview: { files: 1, sessions: 0, skills: 0, estimate: { newFiles: 1, identical: 0, conflicts: 0 } },
    }),
    restoreApply: async () => {
      if (reject) throw new Error(diagnostic)
      return { ok: false, code: 'PARTIAL_RESTORE', message: diagnostic, safeCopyRoot }
    },
  })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.restore })) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.apply })) })
  expect(screen.getByRole('status').textContent).toContain(zh.errorPartialRestore)
  if (!reject) expect(screen.getByRole('status').textContent).toContain(`${zh.safeCopyLocation} ${safeCopyRoot}`)
  expectNoDiagnostics()
})
