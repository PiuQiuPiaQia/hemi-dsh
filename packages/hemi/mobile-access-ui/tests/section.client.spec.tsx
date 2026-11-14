// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { ResourceSnapshot } from '@deepseek-ai/dsh-client-resources/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { MobileSection } from '../src/client/MobileSection.tsx'
import { nativeConnection } from '../src/client/native.ts'
import type { MobileResourceView, MobileSectionProps } from '../src/client/types.ts'
import { en, zh } from '../src/client/locales.ts'
import { device, invitation, off, on, request } from './fixtures.client.ts'

const ready = { ...on, requests: [] }
const claimed = { ...on, invitation: null }
const unused = (): never => { throw new Error('Unused framework hook') }
function bench(state = off) {
  let resource: ResourceSnapshot<MobileResourceView> = { status: 'live', value: { kind: 'state', state }, failure: undefined }
  const standard: GlobalStandardProps = {
    useSessions: unused, useSessionStatus: unused, useSessionRetainInfo: unused, useSessionAccess: unused,
    useRemoteAccess: unused, useWorkspaceAccess: unused, usePanelInfo: unused,
    useContextMenu: unused, useWorkspaces: unused,
    useResource: (() => resource) as GlobalStandardProps['useResource'],
  }
  const props: MobileSectionProps = {
    ...standard, close: vi.fn(), t: makeTranslate(zh), nativeConnection: null, refresh: vi.fn(),
    start: vi.fn(async () => ({ kind: 'complete' as const, invitation })),
    stop: vi.fn(async () => ({ kind: 'complete' as const, invitation: null })),
    createInvitation: vi.fn(async () => ({ kind: 'complete' as const, invitation })),
    approve: vi.fn(async () => ({ kind: 'complete' as const, invitation: null })),
    reject: vi.fn(async () => ({ kind: 'complete' as const, invitation: null })),
    revoke: vi.fn(async () => ({ kind: 'complete' as const, invitation: null })),
    copy: vi.fn(async () => true),
  }
  const element = () => <MobileSection {...props} />
  const setResource = (next: ResourceSnapshot<MobileResourceView>) => { resource = next }
  return { props, element, setResource }
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000) })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

it('shows only the connected computer and native disconnect without holding or polling a management resource', async () => {
  const b = bench(ready)
  const disconnect = vi.fn()
  const serverName = '我的电脑'.repeat(30)
  b.props.nativeConnection = nativeConnection(Object.freeze({ version: 1, serverName, disconnect }))
  b.props.useResource = vi.fn(unused)
  const view = render(b.element())
  expect(screen.getByRole('heading', { name: zh.computer })).toBeTruthy()
  expect(screen.getByText(serverName)).toBeTruthy()
  expect(screen.getAllByRole('button')).toHaveLength(1)
  expect(screen.queryByRole('img')).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.queryByText(zh.localOnly)).toBeNull()
  expect(view.container.textContent).toMatchInlineSnapshot('"连接的电脑我的电脑我的电脑我的电脑我的电脑我的电脑我的电脑我的电脑我的电脑我的电脑我的电脑我的电脑我的电脑我的电脑我的电脑我的电脑我的电脑我的电脑我的电脑我的电脑我的电脑我的电脑我的电脑我的电脑我的电脑我的电脑我的电脑我的电脑我的电脑我的电脑我的电脑断开连接"')
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(b.props.useResource).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  expect(b.props.start).not.toHaveBeenCalled()
  const action = screen.getByRole('button', { name: zh.disconnect })
  fireEvent.click(action)
  fireEvent.click(action)
  expect(disconnect).toHaveBeenCalledExactlyOnceWith()
  expect(action.hasAttribute('disabled')).toBe(true)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(b.props.stop).not.toHaveBeenCalled()
  expect(b.props.revoke).not.toHaveBeenCalled()
  view.unmount()
  render(b.element())
  fireEvent.click(screen.getByRole('button', { name: zh.disconnect }))
  expect(disconnect).toHaveBeenCalledOnce()
})

it('contains native dispatch failures with a short notice and never retries an unknown outcome', () => {
  const b = bench(ready)
  const disconnect = vi.fn(() => { throw new Error('/private/native-detail') })
  b.props.nativeConnection = nativeConnection({ version: 1, serverName: 'Mac', disconnect })
  b.props.useResource = vi.fn(unused)
  const view = render(b.element())
  fireEvent.click(screen.getByRole('button', { name: zh.disconnect }))
  expect(screen.getByRole('alert').textContent).toMatchInlineSnapshot('"无法确认是否已断开，请关闭 Hemi 后重新打开检查"')
  expect(view.container.textContent).not.toContain('/private/native-detail')
  expect(screen.getByRole('button', { name: zh.disconnect }).hasAttribute('disabled')).toBe(true)
  view.unmount()
  render(b.element())
  fireEvent.click(screen.getByRole('button', { name: zh.disconnect }))
  expect(disconnect).toHaveBeenCalledOnce()
  expect(b.props.useResource).not.toHaveBeenCalled()
})

it('contains unexpected injected callback defects and renders native English copy', () => {
  const b = bench()
  b.props.t = makeTranslate(en)
  b.props.nativeConnection = { serverName: 'Mac', disconnect: () => { throw new Error('injection defect') } }
  render(b.element())
  expect(screen.getByRole('heading', { name: en.computer })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.disconnect }))
  expect(screen.getByRole('alert').textContent).toBe(en.disconnectUnknown)
})

it('uses desktop management without a native capability even with a phone user agent', () => {
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' })
  const b = bench()
  expect(nativeConnection(undefined)).toBeNull()
  render(b.element())
  expect(screen.getByRole('button', { name: zh.start })).toBeTruthy()
  expect(screen.queryByText(zh.computer)).toBeNull()
})

it('starts phone access only after an explicit gesture without network configuration controls', async () => {
  const b = bench()
  const view = render(b.element())
  expect(b.props.start).not.toHaveBeenCalled()
  expect(screen.queryByRole('combobox')).toBeNull()
  expect(view.container.textContent).not.toContain('192.168.1.5')
  expect(screen.queryByRole('heading', { name: zh.devices })).toBeNull()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.start })) })
  expect(b.props.start).toHaveBeenCalledWith()
  b.setResource({ status: 'live', value: { kind: 'state', state: on }, failure: undefined })
  view.rerender(b.element())
  expect(screen.getByRole('img', { name: zh.qrAlt }).getAttribute('src')).toMatch(/^data:image\/svg\+xml/)
  expect(screen.queryByLabelText('fingerprint')).toBeNull()
})

it('enables immediately with multiple network interfaces without displaying or selecting an address', async () => {
  const b = bench({ ...off, addresses: [...off.addresses, { address: '10.0.0.5', interface: 'bridge0', scope: 'private' }] })
  const view = render(b.element())
  const enable = screen.getByRole('button', { name: zh.start })
  expect(enable.hasAttribute('disabled')).toBe(false)
  expect(screen.queryByRole('combobox')).toBeNull()
  expect(screen.queryByRole('menu')).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(view.container.textContent).not.toMatch(/192\.168\.1\.5|10\.0\.0\.5|en0|bridge0/)
  expect(view.container.querySelector('[aria-haspopup]')).toBeNull()
  await act(async () => { fireEvent.click(enable) })
  expect(b.props.start).toHaveBeenCalledExactlyOnceWith()
})

it('shows unavailable Wi-Fi guidance and retries discovery without asking for an IP address', () => {
  const b = bench({ ...off, addresses: [] })
  const view = render(b.element())
  expect(screen.getByText(zh.noNetwork)).toBeTruthy()
  expect(screen.queryByRole('textbox')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: zh.retry }))
  expect(b.props.refresh).toHaveBeenCalledOnce()
  b.setResource({ status: 'live', value: { kind: 'state', state: off }, failure: undefined })
  view.rerender(b.element())
  expect(screen.queryByText(zh.noNetwork)).toBeNull()
  expect(screen.getByRole('button', { name: zh.start }).hasAttribute('disabled')).toBe(false)
})

it('reports unavailable Wi-Fi after an enable attempt and offers Retry without configuration fields', async () => {
  const b = bench()
  vi.mocked(b.props.start).mockResolvedValueOnce({ kind: 'failed', problem: 'noNetwork' })
  render(b.element())
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.start })) })
  expect(screen.getByRole('alert').textContent).toMatchInlineSnapshot('"Wi-Fi 不可用，请让此电脑连接 Wi-Fi 后重试"')
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.queryByRole('img')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: zh.retry }))
  expect(b.props.refresh).toHaveBeenCalledOnce()
})

it('hides stale requests while off and retains device revocation', () => {
  const b = bench({ ...off, requests: [request], devices: [device] })
  render(b.element())
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(screen.queryByRole('button', { name: zh.approve })).toBeNull()
  expect(screen.queryByRole('button', { name: zh.reject })).toBeNull()
  expect(screen.getByRole('button', { name: zh.revoke }).hasAttribute('disabled')).toBe(false)
})

it('never repeats an invitation secret from management state; generating and copying uses exactly the returned JSON', async () => {
  const b = bench(ready)
  render(b.element())
  expect(screen.queryByRole('img')).toBeNull()
  expect(screen.getByText(zh.invitationMissing)).toBeTruthy()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.regenerate })) })
  expect(screen.getByRole('img', { name: zh.qrAlt })).toBeTruthy()
  const fallback = screen.getByText(zh.manual).closest('details')!
  expect(fallback.open).toBe(false)
  expect(screen.getByRole('button', { name: zh.copy }).closest('details')).toBe(fallback)
  fireEvent.click(screen.getByText(zh.manual))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.copy })) })
  expect(b.props.copy).toHaveBeenCalledWith(JSON.stringify(invitation))
  expect(screen.getByRole('textbox', { name: zh.copy }).getAttribute('readonly')).not.toBeNull()
  expect(screen.getByText(zh.copied)).toBeTruthy()
})

it('serializes optional invitation origins unchanged without adding a network selection widget', async () => {
  const multiOriginInvitation = { ...invitation, origins: [invitation.origin, 'https://10.0.0.5:4444'] }
  const b = bench(ready)
  vi.mocked(b.props.createInvitation).mockResolvedValueOnce({ kind: 'complete', invitation: multiOriginInvitation })
  const view = render(b.element())
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.regenerate })) })
  fireEvent.click(screen.getByText(zh.manual))
  const payload = screen.getByRole('textbox', { name: zh.copy })
  expect(payload.textContent).toBe(JSON.stringify(multiOriginInvitation))
  expect(screen.getByRole('img', { name: zh.qrAlt })).toBeTruthy()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.copy })) })
  expect(b.props.copy).toHaveBeenCalledWith(JSON.stringify(multiOriginInvitation))
  expect(screen.queryByRole('combobox')).toBeNull()
  expect(view.container.querySelector('[aria-haspopup]')).toBeNull()
})

it('starts a fresh invitation countdown from its confirmed receipt rather than a stale timer tick', async () => {
  const fresh = { ...invitation, expiresAt: invitation.expiresAt + 1000 }
  const b = bench({ ...on, invitation: { createdAt: 1_800_000_001_000, expiresAt: fresh.expiresAt,
    origin: fresh.origin, fingerprint: fresh.fingerprint } })
  vi.mocked(b.props.createInvitation).mockResolvedValueOnce({ kind: 'complete', invitation: fresh })
  render(b.element())
  vi.setSystemTime(1_800_000_001_000)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.regenerate })) })
  expect(screen.getByRole('timer').textContent).toBe('120 秒后过期')
})

it('uses one explicit comparison action without a checkbox and passes the displayed six-digit code', async () => {
  const b = bench(claimed)
  render(b.element())
  const allow = screen.getByRole('button', { name: zh.approve })
  expect(screen.getByRole('heading', { name: `确认连接 ${request.deviceName}` })).toBeTruthy()
  expect(screen.getByText('042891')).toBeTruthy()
  expect(screen.getByText(zh.risk)).toBeTruthy()
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(allow.hasAttribute('disabled')).toBe(false)
  expect(b.props.approve).not.toHaveBeenCalled()
  await act(async () => { fireEvent.click(allow) })
  expect(b.props.approve).toHaveBeenCalledExactlyOnceWith(request.requestId, '042891')
})

it('offers rejection and revocation independently and keeps device rows on failed revocation', async () => {
  const b = bench(claimed)
  vi.mocked(b.props.revoke).mockResolvedValueOnce({ kind: 'failed', problem: 'unknown' })
  render(b.element())
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.reject })) })
  expect(b.props.reject).toHaveBeenCalledWith(request.requestId)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.revoke })) })
  expect(b.props.revoke).toHaveBeenCalledWith(device.deviceId)
  expect(screen.getByText(device.name)).toBeTruthy()
  expect(screen.getByRole('alert').textContent).toBe(zh.unknown)
  expect(screen.queryByText(zh.revoked)).toBeNull()
})

it('retains a live QR and lists after refresh failure, but removes the expired QR even while offline', async () => {
  const b = bench(ready)
  const view = render(b.element())
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.regenerate })) })
  b.setResource({ status: 'failed', value: { kind: 'state', state: ready }, failure: new RemoteError('gateway/internal', '/private/token', {}) })
  view.rerender(b.element())
  expect(screen.getByRole('img', { name: zh.qrAlt })).toBeTruthy()
  expect(screen.getByText(device.name)).toBeTruthy()
  expect(screen.getByText(zh.readFailed)).toBeTruthy()
  expect(view.container.textContent).not.toContain('/private/token')
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
  expect(screen.queryByRole('img')).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.getByText(zh.expired)).toBeTruthy()
  expect(screen.queryByRole('button', { name: zh.approve })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: zh.retry }))
  expect(b.props.refresh).toHaveBeenCalledOnce()
})

it('withdraws QR display after claim, stop, or authorization denial', async () => {
  const b = bench(ready)
  const view = render(b.element())
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.regenerate })) })
  b.setResource({ status: 'live', value: { kind: 'state', state: {
    ...claimed, requests: [{ ...request, expiresAt: request.expiresAt + 180_000 }],
  } }, failure: undefined })
  view.rerender(b.element())
  expect(screen.queryByRole('img')).toBeNull()
  expect(screen.queryByRole('button', { name: zh.regenerate })).toBeNull()
  expect(screen.queryByText(zh.invitationMissing)).toBeNull()
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
  expect(screen.getByRole('button', { name: zh.approve })).toBeTruthy()
  expect(screen.queryByText(zh.expired)).toBeNull()
  b.setResource({ status: 'live', value: { kind: 'unauthorized' }, failure: undefined })
  view.rerender(b.element())
  expect(screen.getByText(zh.localOnly)).toBeTruthy()
  expect(screen.queryByText(device.name)).toBeNull()
  expect(screen.queryByRole('button')).toBeNull()
})

it('omits settled request history and empty device cards', () => {
  const b = bench({ ...on, invitation: null, requests: [
    { ...request, status: 'approved', deviceName: 'approved history' },
    { ...request, status: 'rejected', deviceName: 'rejected history' },
    { ...request, status: 'expired', deviceName: 'expired history' },
  ], devices: [] })
  const view = render(b.element())
  expect(view.container.textContent).not.toContain('history')
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(screen.queryByRole('button', { name: zh.approve })).toBeNull()
  expect(screen.queryByRole('heading', { name: zh.devices })).toBeNull()
  expect(screen.queryByRole('list')).toBeNull()
})

it('reports clipboard failure and a thrown command without losing a usable invitation', async () => {
  const b = bench(ready)
  vi.mocked(b.props.copy).mockResolvedValueOnce(false)
  vi.mocked(b.props.stop).mockRejectedValueOnce(new Error('private'))
  render(b.element())
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.regenerate })) })
  fireEvent.click(screen.getByText(zh.manual))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.copy })) })
  expect(screen.getByRole('alert').textContent).toBe(zh.copyFailed)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.stop })) })
  expect(screen.getByRole('alert').textContent).toBe(zh.unknown)
  expect(screen.getByRole('img')).toBeTruthy()
})

it('renders typed English copy and releases expiry timers on unmount', () => {
  const b = bench()
  b.props.t = makeTranslate(en)
  const view = render(b.element())
  expect(screen.getByRole('button', { name: en.start })).toBeTruthy()
  expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  expect(en.nav).toBe('Phone connection')
  expect(vi.getTimerCount()).toBe(1)
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})
