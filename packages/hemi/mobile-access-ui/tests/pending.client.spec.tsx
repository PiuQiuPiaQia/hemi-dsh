// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { ResourceSnapshot } from '@deepseek-ai/dsh-client-resources/client'
import { MobileSection } from '../src/client/MobileSection.tsx'
import type { CommandOutcome, MobileResourceView, MobileSectionProps } from '../src/client/types.ts'
import { zh } from '../src/client/locales.ts'
import type { MobileAccessState } from '../src/types.ts'
import { on, request } from './fixtures.client.ts'

const unused = (): never => { throw new Error('Unused framework hook') }
function bench() {
  let state: MobileAccessState = { ...on, invitation: null }
  let status: ResourceSnapshot<MobileResourceView>['status'] = 'live'
  const props: MobileSectionProps = {
    useSessions: unused, useSessionStatus: unused, useSessionRetainInfo: unused, useSessionAccess: unused,
    useRemoteAccess: unused, useWorkspaceAccess: unused, usePanelInfo: unused, useContextMenu: unused, useWorkspaces: unused,
    useResource: (() => ({ status, value: { kind: 'state', state }, failure: undefined })) as GlobalStandardProps['useResource'],
    close: vi.fn(), t: makeTranslate(zh), nativeConnection: null, refresh: vi.fn(),
    start: vi.fn(), stop: vi.fn(), createInvitation: vi.fn(), copy: vi.fn(),
    approve: vi.fn(async () => ({ kind: 'complete' as const, invitation: null })),
    reject: vi.fn(async () => ({ kind: 'complete' as const, invitation: null })), revoke: vi.fn(),
  }
  return { props, element: () => <MobileSection {...props} />,
    update: (next: typeof state) => { state = next }, fail: () => { status = 'failed' } }
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000) })
afterEach(() => { cleanup(); vi.useRealTimers() })

it('replaces claimed QR controls with one current confirmation rather than a request list', () => {
  const b = bench()
  const view = render(b.element())
  expect(screen.getAllByRole('heading', { name: `确认连接 ${request.deviceName}` })).toHaveLength(1)
  expect(screen.queryByRole('img')).toBeNull()
  expect(screen.queryByRole('button', { name: zh.regenerate })).toBeNull()
  expect(screen.queryByText(zh.invitationMissing)).toBeNull()
  expect(screen.queryByText(zh.manual)).toBeNull()
  expect(view.container.querySelectorAll('li')).toHaveLength(1)
  expect(screen.getByText(on.devices[0]!.name)).toBeTruthy()
  expect(b.props.createInvitation).not.toHaveBeenCalled()
})

it('hides expired approval and offers an explicit fresh invitation path', async () => {
  const b = bench()
  render(b.element())
  const oldAllow = screen.getByRole('button', { name: zh.approve })
  vi.setSystemTime(request.expiresAt)
  fireEvent.click(oldAllow)
  expect(b.props.approve).not.toHaveBeenCalled()
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(screen.queryByRole('button', { name: zh.approve })).toBeNull()
  expect(screen.queryByRole('button', { name: zh.reject })).toBeNull()
  expect(screen.getByRole('button', { name: zh.generate })).toBeTruthy()
  expect(b.props.createInvitation).not.toHaveBeenCalled()
})

it('withdraws old authorization after rekey and compares only the newly claimed code', async () => {
  const b = bench()
  const view = render(b.element())
  const previous = screen.getByRole('button', { name: zh.approve })
  // A fresh invitation replaces all claims on the Host.
  b.update(on)
  view.rerender(b.element())
  fireEvent.click(previous)
  expect(b.props.approve).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: zh.approve })).toBeNull()
  const next = { ...request, requestId: 'next-request' as typeof request.requestId, verificationCode: '654321' }
  b.update({ ...on, invitation: null, requests: [next] })
  view.rerender(b.element())
  expect(screen.queryByText('042891')).toBeNull()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.approve })) })
  expect(b.props.approve).toHaveBeenCalledExactlyOnceWith(next.requestId, '654321')
})

it('serializes repeated approval and opposing actions while awaiting a Host result', async () => {
  const b = bench()
  let settle: (result: CommandOutcome) => void = () => { throw new Error('Not dispatched') }
  vi.mocked(b.props.approve).mockImplementationOnce(() => new Promise((resolve) => { settle = resolve }))
  render(b.element())
  const allow = screen.getByRole('button', { name: zh.approve })
  const deny = screen.getByRole('button', { name: zh.reject })
  fireEvent.click(allow)
  fireEvent.click(allow)
  fireEvent.click(deny)
  expect(b.props.approve).toHaveBeenCalledOnce()
  expect(b.props.reject).not.toHaveBeenCalled()
  expect(allow.hasAttribute('disabled')).toBe(true)
  await act(async () => { settle({ kind: 'failed', problem: 'unknown' }) })
  expect(screen.getByRole('alert').textContent).toBe(zh.unknown)
  expect(allow.hasAttribute('disabled')).toBe(false)
})

it('keeps the current code visible but disables approval and rejection after refresh failure', () => {
  const b = bench()
  const view = render(b.element())
  b.fail()
  view.rerender(b.element())
  expect(screen.getByText(request.verificationCode)).toBeTruthy()
  expect(screen.getByRole('button', { name: zh.approve }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: zh.reject }).hasAttribute('disabled')).toBe(true)
})

it('shows only the active pending claim alongside settled Host history', () => {
  const b = bench()
  b.update({ ...on, invitation: null, requests: [
    { ...request, status: 'approved', deviceName: 'old allowed phone' },
    { ...request, status: 'rejected', deviceName: 'old rejected phone' }, request,
  ] })
  const view = render(b.element())
  expect(view.container.textContent).not.toContain('old allowed phone')
  expect(view.container.textContent).not.toContain('old rejected phone')
  expect(screen.getAllByRole('button', { name: zh.approve })).toHaveLength(1)
  expect(screen.queryByRole('checkbox')).toBeNull()
})
