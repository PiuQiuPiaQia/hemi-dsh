/** Intake policy for scanned or pasted pairing invitations. */

import Foundation

/**
 * Decide what a delivered invitation does to a pairing attempt.
 *
 * The connect flow delivers one parsed invitation per modal dismissal and
 * executes the returned action; this type owns the duplicate-suppression and
 * staleness rules so they stay deterministic and host-testable:
 *
 * - A delivery while a mutation is live either keeps that attempt (same
 *   invitation token — origin resolution reorders origins, so token identity
 *   is the only stable comparison) or replaces it (a different token). Same
 *   identity wins over the invitation's paper expiry: the pair request runs
 *   on its own host TTL and may still be live.
 * - A delivery starts a mutation only after its modal finished dismissing,
 *   only with the ticket of the currently open modal, and only once per
 *   modal; anything else is stale.
 * - An invitation already expired at intake is refused without a mutation.
 */
public struct PairingIntakePolicy: Sendable {
    /** The invitation the live mutation is committed to; nil when none is live. */
    public private(set) var live: MobileInvitation?
    /** Ticket of the currently open intake modal; earlier tickets are stale. */
    public private(set) var ticket = 0
    /** Ticket that already delivered; one modal yields at most one delivery. */
    private var deliveredTicket = 0

    public init() {}

    /**
     * A scanner or paste sheet is about to be presented.
     * @returns the ticket its delivery must carry; earlier tickets stop being valid.
     */
    @discardableResult
    public mutating func presentIntakeModal() -> Int {
        ticket += 1
        return ticket
    }

    /**
     * The open modal closed without a delivery: user cancellation or a camera
     * failure. Its ticket stops being valid, so a late callback cannot deliver.
     */
    public mutating func discardIntakeModal() {
        ticket += 1
    }

    /**
     * Record that a mutation — origin resolution, then one pair POST — became
     * live for an invitation.
     * @param invite - parsed invitation the mutation is committed to.
     */
    public mutating func beganMutation(_ invite: MobileInvitation) {
        live = invite
    }

    /** The live mutation ended: abandonment, rejection, expiry, approval, or a definite failure. */
    public mutating func endedMutation() {
        live = nil
    }

    /**
     * Decide what one delivered invitation does to the pairing attempt.
     *
     * @param invite - invitation parsed from the scan or the paste.
     * @param ticket - ticket returned when the delivering modal was presented.
     * @param modalEnded - true only after the modal finished dismissing; intake
     *   that ran earlier would race the presentation teardown and let
     *   `viewWillDisappear` cancel the mutation it starts.
     * @param now - clock injection for the expiry check.
     * @returns the action the connect flow executes; a non-drop answer consumes
     *   the modal's ticket, so it delivers at most once.
     */
    public mutating func deliver(
        _ invite: MobileInvitation,
        ticket: Int,
        modalEnded: Bool,
        now: Date = Date()
    ) -> IntakeAction {
        guard modalEnded, ticket == self.ticket, ticket != deliveredTicket else { return .drop }
        deliveredTicket = ticket
        if live?.token == invite.token { return .keep }
        guard invite.expiresAt > now.timeIntervalSince1970 * 1000 else { return .refuseExpired }
        return live == nil ? .begin : .replace
    }
}

/** Action for one delivered invitation; the connect flow executes it. */
public enum IntakeAction: Equatable, Sendable {
    /** Start one mutation: resolve the origin, then send exactly one pair POST. */
    case begin
    /** A live mutation carries a different invitation: end it, start one mutation. */
    case replace
    /** A live mutation already carries this invitation: keep it untouched; no POST. */
    case keep
    /** The invitation expired before intake: refuse it without a mutation. */
    case refuseExpired
    /** Stale delivery: superseded or discarded ticket, a modal still presented, or a spent modal. */
    case drop
}
