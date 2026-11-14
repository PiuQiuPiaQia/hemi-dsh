/**
 * Pairing state machine: one live one-time invitation, claimed by phones into
 * pending requests that the desktop owner approves with a six-digit code or
 * rejects. Purely in-memory by design — an invitation outlives at most its
 * short TTL, and settled request rows stay visible only until the next
 * invitation replaces them or the listener stops.
 */

import { randomBytes, randomInt, randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MobileInvitation, MobileInvitationView, MobilePairRequest, MobileRequestId } from '../types.ts'
import { hashDeviceSecret, verificationCodeMatches } from './wire.ts'

/** Invitation kind discriminator the phone verifies before anything else. */
export const MOBILE_INVITATION_KIND = 'hemi-dsh-mobile'

/** Internal live invitation state; only the token hash is retained. */
interface InvitationState {
  readonly tokenHash: string
  readonly origin: string
  readonly fingerprint: string
  readonly createdAt: number
  readonly expiresAt: number
  claimed: boolean
}

/** Internal pairing-request state. */
interface RequestState {
  readonly requestId: string
  readonly deviceName: string
  readonly secretHash: string
  readonly verificationCode: string
  readonly createdAt: number
  readonly expiresAt: number
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  deviceId: string | undefined
  /** An approval reservation holds the row for its durable device write. */
  reserved: boolean
}

/** Fixed pairing-validation grammar. */
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const DEVICE_NAME_MAX_LENGTH = 64
const DEVICE_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/

/** Why a claim was refused; the wire carries an opaque refusal either way. */
export type ClaimRefusal =
  | 'invitation-invalid'
  | 'invitation-used'
  | 'request-conflict'

/** Result of one pair claim. */
export type ClaimResult =
  | { readonly kind: 'claimed'; readonly verificationCode: string; readonly expiresAt: number }
  | { readonly kind: 'repeated'; readonly status: MobilePairRequest['status']; readonly verificationCode: string; readonly expiresAt: number }
  | { readonly kind: 'refused'; readonly reason: ClaimRefusal }

/** Result of one status poll. */
export type StatusResult =
  | {
    readonly kind: 'status'
    readonly status: MobilePairRequest['status']
    readonly verificationCode: string
    readonly expiresAt: number
    readonly deviceId: string | undefined
  }
  | { readonly kind: 'unknown' }

/**
 * Pairing transitions. All methods take the current time so expiry is
 * testable; none of them performs I/O.
 */
export class PairingEngine {
  private invitation: InvitationState | undefined
  private readonly requests = new Map<string, RequestState>()

  /**
   * @param invitationTtlMs - one-time invitation lifetime.
   * @param requestTtlMs - pending claim lifetime.
   */
  constructor(
    private readonly invitationTtlMs: number,
    private readonly requestTtlMs: number,
  ) {}

  /** Drop the live invitation and every request row. */
  reset(): void {
    this.invitation = undefined
    this.requests.clear()
  }

  /**
   * Mint a new invitation, replacing any live one.
   * @param origin - listener origin the phone connects to.
   * @param fingerprint - leaf certificate fingerprint.
   * @param now - current epoch milliseconds.
   * @param origins - Actual bound alternatives, primary first; omission retains a single origin.
   * @returns the complete invitation payload; the token exists only in this return value.
   */
  createInvitation(origin: string, fingerprint: string, now: number, origins: readonly string[] = [origin]): MobileInvitation {
    const token = randomBytes(32).toString('base64url')
    this.requests.clear()
    this.invitation = {
      tokenHash: createHash('sha256').update(token, 'utf8').digest('hex'),
      origin,
      fingerprint,
      createdAt: now,
      expiresAt: now + this.invitationTtlMs,
      claimed: false,
    }
    return {
      kind: MOBILE_INVITATION_KIND,
      version: 1,
      origin,
      ...(origins.length > 1 ? { origins: [...origins] } : {}),
      fingerprint,
      token,
      expiresAt: this.invitation.expiresAt,
    }
  }

  /**
   * Safe view of an unclaimed invitation for management state, without the token.
   * @returns the view, or null when no unclaimed invitation remains.
   */
  invitationView(): MobileInvitationView | null {
    const invitation = this.invitation
    if (invitation === undefined || invitation.claimed) return null
    return {
      createdAt: invitation.createdAt,
      expiresAt: invitation.expiresAt,
      origin: invitation.origin,
      fingerprint: invitation.fingerprint,
    }
  }

  /**
   * Claim the live invitation for one phone. The first claim consumes it; the
   * same `requestId` with the same secret repeats its answer.
   * @param token - invitation token exactly as the phone received it.
   * @param requestId - phone-generated UUID identifying this pairing attempt.
   * @param deviceName - phone-presented display name.
   * @param secret - phone-generated 32-byte secret; only its hash is stored.
   * @param now - current epoch milliseconds.
   * @returns the claim outcome for the wire response.
   */
  claim(token: string, requestId: string, deviceName: string, secret: string, now: number): ClaimResult {
    if (!REQUEST_ID_PATTERN.test(requestId)
      || deviceName.length === 0 || deviceName.length > DEVICE_NAME_MAX_LENGTH
      || !DEVICE_SECRET_PATTERN.test(secret)) {
      return { kind: 'refused', reason: 'invitation-invalid' }
    }
    this.sweep(now)
    const invitation = this.invitation
    if (invitation === undefined) return { kind: 'refused', reason: 'invitation-invalid' }
    const existing = this.requests.get(requestId)
    if (existing !== undefined) {
      if (existing.secretHash !== hashDeviceSecret(secret)) return { kind: 'refused', reason: 'request-conflict' }
      return { kind: 'repeated', status: existing.status, verificationCode: existing.verificationCode, expiresAt: existing.expiresAt }
    }
    if (invitation.claimed) return { kind: 'refused', reason: 'invitation-used' }
    // A sweep at the top of this call already dropped an expired invitation,
    // so an unclaimed-but-expired invitation reads as invalid here.
    const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex')
    if (tokenHash !== invitation.tokenHash) return { kind: 'refused', reason: 'invitation-invalid' }
    invitation.claimed = true
    const request: RequestState = {
      requestId,
      deviceName,
      secretHash: hashDeviceSecret(secret),
      verificationCode: formatVerificationCode(randomInt(0, 1_000_000)),
      createdAt: now,
      expiresAt: now + this.requestTtlMs,
      status: 'pending',
      deviceId: undefined,
      reserved: false,
    }
    this.requests.set(requestId, request)
    return { kind: 'claimed', verificationCode: request.verificationCode, expiresAt: request.expiresAt }
  }

  /**
   * Poll one pairing attempt. An unknown id and a wrong secret answer alike,
   * so the endpoint reveals neither which one failed.
   * @param requestId - pairing attempt identity.
   * @param secret - secret presented at claim time.
   * @param now - current epoch milliseconds.
   * @returns the current row for a matching attempt.
   */
  statusOf(requestId: string, secret: string, now: number): StatusResult {
    this.sweep(now)
    const request = this.requests.get(requestId)
    if (request === undefined || request.secretHash !== hashDeviceSecret(secret)) return { kind: 'unknown' }
    return {
      kind: 'status',
      status: request.status,
      verificationCode: request.verificationCode,
      expiresAt: request.expiresAt,
      deviceId: request.deviceId,
    }
  }

  /**
   * Reject one pending request; a request with an approval reservation in
   * flight cannot be rejected underneath it.
   * @param requestId - pairing attempt identity.
   * @returns true when a pending row was rejected.
   */
  reject(requestId: string): boolean {
    const request = this.requests.get(requestId)
    if (request === undefined || request.status !== 'pending' || request.reserved) return false
    request.status = 'rejected'
    return true
  }

  /**
   * Reserve one pending approval for the durable device write. The call first
   * sweeps expiry, so a request past its TTL can never be reserved however
   * long it sat unswept; while the reservation stands, {@link reject}, a new
   * invitation, and reset cannot settle the row underneath the writer.
   * @param requestId - pairing attempt identity.
   * @param code - verification code as the desktop owner entered it.
   * @param now - current epoch milliseconds.
   * @returns why approval cannot proceed, or the reservation with its commit
   * and release operations.
   */
  reserveApproval(requestId: string, code: string, now: number):
    | { readonly kind: 'missing' }
    | { readonly kind: 'wrong-code'; readonly deviceName: string }
    | { readonly kind: 'ok'; readonly deviceName: string; readonly secretHash: string; readonly commit: (deviceId: string) => boolean; readonly release: () => void } {
    this.sweep(now)
    const request = this.requests.get(requestId)
    if (request === undefined || request.status !== 'pending' || request.reserved) return { kind: 'missing' }
    if (!verificationCodeMatches(code, request.verificationCode)) return { kind: 'wrong-code', deviceName: request.deviceName }
    request.reserved = true
    return {
      kind: 'ok',
      deviceName: request.deviceName,
      secretHash: request.secretHash,
      commit: (deviceId: string): boolean => {
        // The row must still be the live entry: reset or a new invitation
        // removed it, so publishing would approve a request nobody can poll.
        if (this.requests.get(requestId) !== request || request.status !== 'pending' || !request.reserved) return false
        request.reserved = false
        request.status = 'approved'
        request.deviceId = deviceId
        return true
      },
      release: (): void => {
        if (this.requests.get(requestId) === request && request.status === 'pending' && request.reserved) request.reserved = false
      },
    }
  }

  /**
   * Expire pending rows past their TTL and drop a dead invitation; exposed so
   * management state reads current lifecycle facts.
   * @param now - current epoch milliseconds.
   */
  sweepRequests(now: number): void {
    this.sweep(now)
  }

  /**
   * Safe request rows for management state, pending first, in claim order.
   * @returns one row per live pairing request.
   */
  requestViews(): readonly MobilePairRequest[] {
    return [...this.requests.values()]
      .map(request => ({
        requestId: brandString<MobileRequestId>(request.requestId),
        deviceName: request.deviceName,
        createdAt: request.createdAt,
        expiresAt: request.expiresAt,
        status: request.status,
        verificationCode: request.verificationCode,
      }))
      .sort((left, right) => Number(left.status !== 'pending') - Number(right.status !== 'pending')
        || left.createdAt - right.createdAt)
  }

  /** Expire pending rows past their TTL and drop a dead invitation. */
  private sweep(now: number): void {
    for (const request of this.requests.values()) {
      if (request.status === 'pending' && request.expiresAt <= now) request.status = 'expired'
    }
    const invitation = this.invitation
    if (invitation !== undefined && invitation.expiresAt <= now) this.invitation = undefined
  }
}

/** Six decimal digits with leading zeros. */
function formatVerificationCode(value: number): string {
  return String(value).padStart(6, '0')
}

/**
 * Fresh phone request id; exported for tests that stand in for a phone.
 * @returns a new lowercase UUID.
 */
export function newRequestId(): string {
  return randomUUID()
}
