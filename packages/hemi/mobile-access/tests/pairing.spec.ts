/** Pairing-engine lifecycle: one-time invitations, idempotent claims, and reservation-guarded approval. */

import { describe, expect, it } from 'vitest'
import { hashDeviceSecret } from '../src/internal/wire.ts'
import { PairingEngine } from '../src/internal/pairing.ts'

const ORIGIN = 'https://192.168.1.10:43211'
const FINGERPRINT = 'a'.repeat(64)
const SECRET = 's'.repeat(43)
const OTHER_SECRET = 'o'.repeat(43)
const REQUEST = '11111111-1111-4111-8111-111111111111'

function engine(invitationTtlMs = 120_000, requestTtlMs = 300_000): PairingEngine {
  return new PairingEngine(invitationTtlMs, requestTtlMs)
}

/** Mint an invitation and return its token for claims. */
function mint(pairing: PairingEngine, now: number): string {
  return pairing.createInvitation(ORIGIN, FINGERPRINT, now).token
}

function claim(pairing: PairingEngine, now: number, token: string, requestId = REQUEST, secret = SECRET) {
  return pairing.claim(token, requestId, 'iPhone', secret, now)
}

function codeOf(pairing: PairingEngine): string {
  const row = pairing.requestViews().find(request => String(request.requestId) === REQUEST)
  if (row === undefined) throw new Error('request row missing')
  return row.verificationCode
}

function reserved(pairing: PairingEngine, now = 1_200): Extract<ReturnType<PairingEngine['reserveApproval']>, { kind: 'ok' }> {
  const reservation = pairing.reserveApproval(REQUEST, codeOf(pairing), now)
  if (reservation.kind !== 'ok') throw new Error(`reservation failed: ${reservation.kind}`)
  return reservation
}

describe('PairingEngine invitations', () => {
  it('claims a fresh invitation exactly once', () => {
    const pairing = engine()
    const token = mint(pairing, 1_000)
    expect(pairing.invitationView()).not.toBeNull()
    expect(claim(pairing, 1_100, token)).toMatchObject({ kind: 'claimed' })
    expect(pairing.invitationView()).toBeNull()
    expect(claim(pairing, 1_200, token, '22222222-2222-4222-8222-222222222222'))
      .toEqual({ kind: 'refused', reason: 'invitation-used' })
  })

  it('refuses a missing, wrong, or expired invitation', () => {
    const pairing = engine()
    expect(claim(pairing, 1_000, 't'.repeat(43))).toEqual({ kind: 'refused', reason: 'invitation-invalid' })
    const token = mint(pairing, 1_000)
    expect(claim(pairing, 1_000, 'x'.repeat(43))).toEqual({ kind: 'refused', reason: 'invitation-invalid' })
    expect(claim(pairing, 121_001, token)).toEqual({ kind: 'refused', reason: 'invitation-invalid' })
  })

  it('repeats the same claim idempotently and refuses the same id with a different secret', () => {
    const pairing = engine()
    const token = mint(pairing, 1_000)
    const first = claim(pairing, 1_100, token)
    expect(first.kind).toBe('claimed')
    expect(claim(pairing, 1_200, token)).toMatchObject({ kind: 'repeated', status: 'pending' })
    expect(claim(pairing, 1_300, token, REQUEST, OTHER_SECRET)).toEqual({ kind: 'refused', reason: 'request-conflict' })
  })

  it('refuses malformed claim fields as an invalid invitation', () => {
    const pairing = engine()
    const token = mint(pairing, 1_000)
    expect(pairing.claim(token, 'not-a-uuid', 'iPhone', SECRET, 1_100)).toEqual({ kind: 'refused', reason: 'invitation-invalid' })
    expect(pairing.claim(token, REQUEST, '', SECRET, 1_100)).toEqual({ kind: 'refused', reason: 'invitation-invalid' })
    expect(pairing.claim(token, REQUEST, 'iPhone', 'short', 1_100)).toEqual({ kind: 'refused', reason: 'invitation-invalid' })
  })

  it('replaces requests when a new invitation is minted and hides the token from views', () => {
    const pairing = engine()
    const token = mint(pairing, 1_000)
    claim(pairing, 1_100, token)
    const second = mint(pairing, 2_000)
    expect(pairing.requestViews()).toHaveLength(0)
    expect(JSON.stringify(pairing.invitationView())).not.toContain(second)
    expect(pairing.invitationView()).toMatchObject({ origin: ORIGIN, fingerprint: FINGERPRINT, createdAt: 2_000 })
  })
})

describe('PairingEngine status', () => {
  it('answers a matching poll and treats everything else as unknown', () => {
    const pairing = engine()
    const token = mint(pairing, 1_000)
    claim(pairing, 1_100, token)
    expect(pairing.statusOf(REQUEST, SECRET, 1_200)).toMatchObject({ kind: 'status', status: 'pending' })
    expect(pairing.statusOf(REQUEST, OTHER_SECRET, 1_200)).toEqual({ kind: 'unknown' })
    expect(pairing.statusOf('33333333-3333-4333-8333-333333333333', SECRET, 1_200)).toEqual({ kind: 'unknown' })
  })

  it('expires a pending row past its TTL', () => {
    const pairing = engine(120_000, 1_000)
    const token = mint(pairing, 1_000)
    claim(pairing, 1_000, token)
    expect(pairing.statusOf(REQUEST, SECRET, 2_001)).toMatchObject({ kind: 'status', status: 'expired' })
  })
})

describe('PairingEngine approval reservation', () => {
  it('publishes approval only through commit after the durable write', () => {
    const pairing = engine()
    const token = mint(pairing, 1_000)
    claim(pairing, 1_100, token)
    const reservation = reserved(pairing)
    expect(reservation.deviceName).toBe('iPhone')
    expect(reservation.secretHash).toBe(hashDeviceSecret(SECRET))
    expect(pairing.statusOf(REQUEST, SECRET, 1_300)).toMatchObject({ kind: 'status', status: 'pending' })
    expect(reservation.commit('44444444-4444-4444-8444-444444444444')).toBe(true)
    expect(pairing.statusOf(REQUEST, SECRET, 1_300)).toMatchObject({
      kind: 'status', status: 'approved', deviceId: '44444444-4444-4444-8444-444444444444',
    })
    expect(reservation.commit('55555555-5555-4555-8555-555555555555')).toBe(false)
  })

  it('refuses an expired request even when nothing has swept it yet', () => {
    const pairing = engine(120_000, 1_000)
    const token = mint(pairing, 1_000)
    claim(pairing, 1_000, token)
    expect(pairing.reserveApproval(REQUEST, codeOf(pairing), 2_000)).toEqual({ kind: 'missing' })
    expect(pairing.statusOf(REQUEST, SECRET, 2_000)).toMatchObject({ kind: 'status', status: 'expired' })
  })

  it('refuses a wrong code and an unknown request without reserving', () => {
    const pairing = engine()
    const token = mint(pairing, 1_000)
    claim(pairing, 1_100, token)
    const wrongCode = codeOf(pairing) === '000000' ? '000001' : '000000'
    expect(pairing.reserveApproval(REQUEST, wrongCode, 1_200)).toMatchObject({ kind: 'wrong-code', deviceName: 'iPhone' })
    expect(pairing.reserveApproval('66666666-6666-4666-8666-666666666666', codeOf(pairing), 1_200)).toEqual({ kind: 'missing' })
  })

  it('holds one reservation: a second approval and reject cannot interleave it', () => {
    const pairing = engine()
    const token = mint(pairing, 1_000)
    claim(pairing, 1_100, token)
    const reservation = reserved(pairing)
    expect(pairing.reserveApproval(REQUEST, codeOf(pairing), 1_300)).toEqual({ kind: 'missing' })
    expect(pairing.reject(REQUEST)).toBe(false)
    reservation.release()
    expect(pairing.reject(REQUEST)).toBe(true)
    expect(pairing.statusOf(REQUEST, SECRET, 1_400)).toMatchObject({ kind: 'status', status: 'rejected' })
  })

  it('invalidates a reservation whose row was cleared by stop or a new invitation', () => {
    const pairing = engine()
    const token = mint(pairing, 1_000)
    claim(pairing, 1_100, token)
    const reservation = reserved(pairing)
    pairing.reset()
    expect(reservation.commit('44444444-4444-4444-8444-444444444444')).toBe(false)
  })

  it('leaves the row pending after a failed durable write released it', () => {
    const pairing = engine()
    const token = mint(pairing, 1_000)
    claim(pairing, 1_100, token)
    reserved(pairing).release()
    expect(pairing.reserveApproval(REQUEST, codeOf(pairing), 1_500).kind).toBe('ok')
  })
})

describe('PairingEngine request views', () => {
  it('keeps a settled row visible until the next invitation or reset clears it', () => {
    const pairing = engine()
    const token = mint(pairing, 1_000)
    claim(pairing, 1_100, token)
    pairing.reject(REQUEST)
    const settled = pairing.requestViews()
    expect(settled).toHaveLength(1)
    expect(settled[0]).toMatchObject({ status: 'rejected', deviceName: 'iPhone' })
    expect(settled[0]?.verificationCode).toMatch(/^\d{6}$/)
    mint(pairing, 2_000)
    expect(pairing.requestViews()).toHaveLength(0)
  })

  it('sweeps expiry on demand so state reads current lifecycle facts', () => {
    const pairing = engine(120_000, 1_000)
    const token = mint(pairing, 1_000)
    claim(pairing, 1_000, token)
    pairing.sweepRequests(2_001)
    expect(pairing.requestViews()[0]?.status).toBe('expired')
  })
})
