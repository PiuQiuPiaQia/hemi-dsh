/** Deterministic in-memory phone state; no test opens a listener or credential store. */
import { vi } from 'vitest'
import type { MobileAccessRemote, MobileAccessState, MobileInvitation, MobilePairRequest, MobileDeviceView } from '../src/types.ts'

export const invitation: MobileInvitation = {
  kind: 'hemi-dsh-mobile', version: 1, origin: 'https://192.168.1.5:4444', fingerprint: 'ab'.repeat(32),
  token: 'one-time-fixture-token', expiresAt: 1_800_000_120_000,
}
export const request: MobilePairRequest = {
  requestId: 'request-fixture' as MobilePairRequest['requestId'], deviceName: '我的 iPhone',
  verificationCode: '042891', createdAt: 1_800_000_000_000, expiresAt: invitation.expiresAt, status: 'pending',
}
export const device: MobileDeviceView = {
  deviceId: 'device-fixture' as MobileDeviceView['deviceId'], name: '家人的 iPhone',
  createdAt: 1_800_000_000_000, lastSeenAt: null, connected: false,
}
export const off: MobileAccessState = {
  listening: false, origin: null,
  addresses: [{ address: '192.168.1.5', interface: 'en0', scope: 'private' }],
  invitation: null, requests: [], devices: [], lastListener: null,
}
export const on: MobileAccessState = {
  ...off, listening: true, origin: invitation.origin,
  invitation: {
    createdAt: 1_800_000_000_000, expiresAt: invitation.expiresAt,
    origin: invitation.origin, fingerprint: invitation.fingerprint,
  },
  requests: [request], devices: [device],
}

export function remoteFixture() {
  return {
    getState: vi.fn<MobileAccessRemote['getState']>(async () => ({ ok: true, value: off })),
    start: vi.fn<MobileAccessRemote['start']>(async () => ({ ok: true, value: on })),
    stop: vi.fn<MobileAccessRemote['stop']>(async () => ({ ok: true, value: { ...off, devices: on.devices } })),
    createInvitation: vi.fn<MobileAccessRemote['createInvitation']>(async () => ({ ok: true, value: { state: on, invitation } })),
    approve: vi.fn<MobileAccessRemote['approve']>(async () => ({ ok: true, value: { ...on, requests: [{ ...request, status: 'approved' }] } })),
    reject: vi.fn<MobileAccessRemote['reject']>(async () => ({ ok: true, value: { ...on, requests: [{ ...request, status: 'rejected' }] } })),
    revoke: vi.fn<MobileAccessRemote['revoke']>(async () => ({ ok: true, value: { ...on, devices: [] } })),
  }
}
