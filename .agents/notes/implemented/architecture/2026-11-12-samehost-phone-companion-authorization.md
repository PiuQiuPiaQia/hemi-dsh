# Agent Note: Same-host phone companion authorization

Status: implemented

English | [中文](2026-11-12-samehost-phone-companion-authorization.zh.md)

## Problem

A phone on the same home network needs the full Web UI of the desktop Host that is already running — not a reduced remote and not a second Host. Reusing the browser launch token or its cookie would hand a process-start credential to a device that leaves the house and cannot be revoked per device. Duplicating sessions, queues, or agent state for the phone would fork one runtime into two. The home LAN itself is not a trust anchor: any device on it can reach the listener.

## Decision

The [mobile-access plugin](../../../../packages/hemi/mobile-access/README.md) adds one authenticated carrier to the same Host, not a second runtime. Its TLS listener group is off by default; the desktop owner enables it without selecting an address, and the Host binds concrete private or link-local IPv4 candidates on one shared port, and the management Remote methods answer only the desktop browser owner Peer (`hemi-mobile/unauthorized` otherwise).

- **Carrier reuse.** HTTP requests enter through `connection.serveHttp`, keeping the `connection/request` admission waterfall, body limits, and response backpressure; WebSocket upgrades transfer through `typertGateway.websocket.acceptUpgrade`, sharing the Gateway mux, heartbeat, readiness gating, and Peer disposal. Page resources are read with `webServer.readResource`. No session, queue, or agent implementation is copied.
- **Pairing.** One live invitation at a time: a 32-byte one-time token (default 120 s) moved by QR or copy-paste, carrying the listener origin and the leaf-certificate fingerprint the phone pins. The claiming phone presents its own name and a self-generated 32-byte secret. Approval is explicit: the owner compares a six-digit code shown on both screens, and the durable device record — name, creation time, and the SHA-256 secret hash — is written before the request publishes `approved`.
- **Credentials.** The phone keeps `deviceId` and `secret` in its Keychain and exchanges the bearer for an `__Host-hemi-mobile` cookie (Secure, HttpOnly, SameSite=Strict). The Host stores only the SHA-256 hash, in the `hemi-mobile-access` scope of the DSH credential store; it never stores or emits the secret, and the browser launch token and cookie are never given to a phone.
- **Peer.** Each approved device authenticates to its own Peer with a full owner principal (`createPeer({ principal: { kind: 'owner' }, interactions: 'answer' })`), so the phone is a full owner screen, not a viewer. Revocation removes the durable record first — new requests fail authentication immediately — then disposes the Peer and closes its socket. The directory defaults to a limit of 10 devices; pairing claims are rate-limited per address.

## Alternatives considered

- **Reuse the browser launch token or cookie for the phone.** The launch token is a process-start credential with no per-device identity and no per-device revocation; losing the phone would mean rotating Host credentials. Lost to per-device hashed secrets with individual revocation.
- **Run a copied Host surface for the phone.** Duplicating sessions, queues, and agent state forks the runtime and doubles persistence. Lost to reusing the existing carriers.

## Consequences

Cost: a second authorization surface beside the [browser token](2026-08-24-browser-token-authentication.md) and the [API connect handshake](2026-10-09-operator-scoped-connect-handshake.md); a self-signed certificate the phone pins, so a changed certificate requires a fresh invitation and changed interfaces require restarting the bind group; and a manual approve and revoke burden on the owner. Bought: per-device revocable credentials with hash-only Host storage, the complete Web UI on the phone from one Host, and unchanged desktop authority — the phone is an additional owner Peer, and the Peer and principal vocabulary stays owned by the [Peer principal decision](2026-10-12-peer-principal-and-remote-access.md).

## Testing

The suites in `packages/hemi/mobile-access/tests` pin the pairing lifecycle (single-use invitation, expiry, reservation-then-commit approval ordering, reservation exclusivity), listener admission fences (refusal before readiness, foreign Host and Origin, malformed or oversized bodies, bursts), authenticated endpoints (cookie issue, `/api` through the device Peer, upgrade transfer, idempotent stop), records, and wire parsing. The Host tests also exercise in-flight cache invalidation and concurrent start, stop, and disposal. Browser integration verifies that the phone reads the desktop's recorded history, submits into the same Session, and loses access after revocation. Real iOS acceptance remains unverified: WebKit same-origin and pinning evidence ran on macOS, and iOS builds establish compilation rather than device behavior ([mobile app README](../../../../apps/mobile/README.md)).
