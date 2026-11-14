/**
 * Client-safe type surface of the Hemi mobile-access Host plugin: the owner
 * Peer's management view, the one-time pairing invitation, and the phone wire
 * contract. Types only — no runtime code — so a Client compilation face and
 * the generated Remote surface read exactly the shapes the Host emits.
 *
 * @module @deepseek-ai/dsh-hemi-mobile-access/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque identity of one approved phone; a UUID on the wire. */
export type MobileDeviceId = Branded<'MobileDeviceId'>

/** Opaque identity of one pairing request; a UUID on the wire. */
export type MobileRequestId = Branded<'MobileRequestId'>

/** One candidate bind address enumerated from the Host's network interfaces. */
export interface MobileAddress {
  /** IPv4 literal text, for example `192.168.1.5`. */
  readonly address: string
  /** Interface name as `os.networkInterfaces()` reports it, for example `en0`. */
  readonly interface: string
  /** `private` covers RFC1918 ranges; `link-local` covers `169.254.0.0/16`. */
  readonly scope: 'private' | 'link-local'
}

/**
 * The complete one-time pairing payload. The desktop owner sees it exactly
 * once, from `createInvitation()`, and transfers it to the phone (QR code or
 * copy-paste); `getState` never repeats it, so a same-origin iframe polling
 * management state cannot steal a live invitation token.
 */
export interface MobileInvitation {
  /** Protocol discriminator. */
  readonly kind: 'hemi-dsh-mobile'
  /** Protocol version. */
  readonly version: 1
  /** Listener origin the phone connects to, `https://<IPv4>:<port>`. */
  readonly origin: string
  /** Actual bound alternatives, primary first; omitted for a single address. Maximum 32, same port and certificate. */
  readonly origins?: readonly string[]
  /** SHA-256 of the leaf certificate DER, lowercase hex, no colons. */
  readonly fingerprint: string
  /** Random 32-byte invitation token, base64url; claimable once. */
  readonly token: string
  /** Expiry in epoch milliseconds. */
  readonly expiresAt: number
}

/** Management view of the live invitation with no credential fields. */
export interface MobileInvitationView {
  /** Creation time in epoch milliseconds. */
  readonly createdAt: number
  /** Expiry in epoch milliseconds. */
  readonly expiresAt: number
  /** Listener origin at creation time. */
  readonly origin: string
  /** Leaf certificate fingerprint at creation time. */
  readonly fingerprint: string
}

/** Lifecycle status of one pairing request; settled rows stay visible. */
export type MobilePairStatus = 'pending' | 'approved' | 'rejected' | 'expired'

/** One phone pairing request as the desktop owner reviews it. */
export interface MobilePairRequest {
  readonly requestId: MobileRequestId
  /** Device name the phone presented at claim time. */
  readonly deviceName: string
  /** Claim time in epoch milliseconds. */
  readonly createdAt: number
  /** Expiry of the pending claim in epoch milliseconds. */
  readonly expiresAt: number
  readonly status: MobilePairStatus
  /**
   * Six-digit code shown on both the phone and this desktop so the owner can
   * compare them before approving. No secret value; meaningful only together
   * with the human comparison.
   */
  readonly verificationCode: string
}

/** One approved phone; carries no secret and no hash. */
export interface MobileDeviceView {
  readonly deviceId: MobileDeviceId
  /** Name presented at pairing time. */
  readonly name: string
  /** Approval time in epoch milliseconds. */
  readonly createdAt: number
  /** Last authenticated request time in epoch milliseconds, or null. */
  readonly lastSeenAt: number | null
  /** Whether an authenticated socket or WebSocket is currently open. */
  readonly connected: boolean
}

/** Persisted listener facts that survive a Host restart. */
export interface MobileListenerRecord {
  /** Bind address of the last successful start. */
  readonly host: string
  /** Port the listener last bound; reused by the next start. */
  readonly port: number
}

/** Authoritative management state returned by every Remote method. */
export interface MobileAccessState {
  /** Whether the TLS listener currently accepts phone connections. */
  readonly listening: boolean
  /** `https://<IPv4>:<port>` while listening, otherwise null. */
  readonly origin: string | null
  /** Bind candidates re-enumerated on every read. */
  readonly addresses: readonly MobileAddress[]
  /** Safe view of the live invitation, or null when none is live. */
  readonly invitation: MobileInvitationView | null
  /** Pending and recently settled pairing requests. */
  readonly requests: readonly MobilePairRequest[]
  /** Approved phones in approval order. */
  readonly devices: readonly MobileDeviceView[]
  /** Last successfully bound listener facts persisted in the credential store, or null before the first start. */
  readonly lastListener: MobileListenerRecord | null
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The call arrived from a Peer other than the desktop browser owner Peer. */
    'hemi-mobile/unauthorized': {}
    /** The listener is already accepting connections. */
    'hemi-mobile/already-listening': {}
    /** The listener is not running. */
    'hemi-mobile/not-listening': {}
    /** No usable local network address is currently available. */
    'hemi-mobile/no-network': {}
    /** No pairing request with this id is open for the operation. */
    'hemi-mobile/request-not-found': { readonly requestId: string }
    /** The presented verification code does not match. */
    'hemi-mobile/wrong-code': {}
    /** No approved device carries this id. */
    'hemi-mobile/device-not-found': { readonly deviceId: string }
    /** The device directory reached its configured cap; remove a device first. */
    'hemi-mobile/device-limit': { readonly maxDevices: number }
    /** The listener could not bind; the reason names the failing step. */
    'hemi-mobile/listen-failed': { readonly reason: string }
    /** The credential store is unavailable, so no record can be read or written. */
    'hemi-mobile/credentials-unavailable': {}
  }
}
