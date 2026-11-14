/** Deterministic intake decisions: auto single mutation, duplicate suppression, staleness. */

import Foundation
import XCTest
@testable import HemiMobileCore

final class PairingIntakeTests: XCTestCase {
    /** Fixed clock: 1000 s epoch, invitations valid for ten minutes. */
    private let now = Date(timeIntervalSince1970: 1_000)
    private var validExpiryMs: Double { (1_000 + 600) * 1000 }
    private var expiredExpiryMs: Double { (1_000 - 1) * 1000 }

    private func makeInvite(
        token: String,
        expiresAt: Double? = nil,
        origins: [String]? = nil
    ) -> MobileInvitation {
        MobileInvitation(
            origin: URL(string: "https://192.168.1.4:4317")!,
            fingerprint: String(repeating: "ab", count: 32),
            token: token,
            expiresAt: expiresAt ?? validExpiryMs,
            origins: origins.map { $0.compactMap(URL.init(string:)) }
        )
    }

    private func token(_ character: Character) -> String {
        String(repeating: character, count: 43)
    }

    /// One delivered modal: present, then deliver after its dismissal.
    private func deliver(
        _ policy: inout PairingIntakePolicy,
        _ invite: MobileInvitation,
        now: Date
    ) -> IntakeAction {
        let ticket = policy.presentIntakeModal()
        return policy.deliver(invite, ticket: ticket, modalEnded: true, now: now)
    }

    func testScanStartsExactlyOneMutationPerModal() throws {
        var policy = PairingIntakePolicy()
        let invite = makeInvite(token: token("c"))
        XCTAssertEqual(deliver(&policy, invite, now: now), .begin)
        policy.beganMutation(invite)
        // A re-scan of the same QR is a new modal; the live attempt keeps, so
        // one scan still maps to exactly one mutation.
        XCTAssertEqual(deliver(&policy, invite, now: now), .keep)
        XCTAssertEqual(policy.live?.token, invite.token)
    }

    func testOneModalDeliversAtMostOnce() throws {
        var policy = PairingIntakePolicy()
        let ticket = policy.presentIntakeModal()
        let invite = makeInvite(token: token("c"))
        XCTAssertEqual(policy.deliver(invite, ticket: ticket, modalEnded: true, now: now), .begin)
        policy.beganMutation(invite)
        // A late second callback of the same spent modal mutates nothing.
        XCTAssertEqual(policy.deliver(invite, ticket: ticket, modalEnded: true, now: now), .drop)
    }

    func testDuplicateLiveInviteKeepsAttemptWithoutNewPost() throws {
        var policy = PairingIntakePolicy()
        let invite = makeInvite(token: token("c"))
        XCTAssertEqual(deliver(&policy, invite, now: now), .begin)
        policy.beganMutation(invite)
        // While requesting, pending, or checking, the live attempt keeps its
        // own requestId and secret: no begin decision can mint a new pair.
        let actions = (0..<3).map { _ in deliver(&policy, invite, now: now) }
        XCTAssertEqual(actions, [.keep, .keep, .keep])
        XCTAssertEqual(policy.live, invite)
    }

    func testResolvedInvitationIdentityKeepsOriginalQRSinglePost() throws {
        // The host resolved to the second candidate, so the live attempt
        // carries a reordered invitation; the original QR parses to the
        // pre-resolution form. Token identity is the only stable comparison.
        let original = makeInvite(token: token("c"), origins: ["https://192.168.1.4:4317", "https://192.168.1.5:4317"])
        let second = try XCTUnwrap(URL(string: "https://192.168.1.5:4317"))
        let resolved = original.narrowingOrigin(to: second)
        XCTAssertNotEqual(original, resolved)

        var policy = PairingIntakePolicy()
        XCTAssertEqual(deliver(&policy, resolved, now: now), .begin)
        policy.beganMutation(resolved)
        XCTAssertEqual(deliver(&policy, original, now: now), .keep)
        XCTAssertEqual(policy.live, resolved)
    }

    func testNewInvitationReplacesLiveAttempt() throws {
        var policy = PairingIntakePolicy()
        let first = makeInvite(token: token("c"))
        XCTAssertEqual(deliver(&policy, first, now: now), .begin)
        policy.beganMutation(first)
        let second = makeInvite(token: token("d"))
        XCTAssertEqual(deliver(&policy, second, now: now), .replace)
    }

    func testExpiredDeliveryRefusedWithoutMutation() throws {
        var policy = PairingIntakePolicy()
        let expired = makeInvite(token: token("c"), expiresAt: expiredExpiryMs)
        XCTAssertEqual(deliver(&policy, expired, now: now), .refuseExpired)
        XCTAssertEqual(policy.live, nil)
        // A different, expired invitation never replaces a live attempt either.
        let live = makeInvite(token: token("c"))
        policy.beganMutation(live)
        let otherExpired = makeInvite(token: token("d"), expiresAt: expiredExpiryMs)
        XCTAssertEqual(deliver(&policy, otherExpired, now: now), .refuseExpired)
        XCTAssertEqual(policy.live, live)
    }

    func testLiveSameInvitationKeepsEvenAfterInvitationExpiry() throws {
        // The invitation's paper expiry passed but the pair request runs on
        // its own host TTL: the same identity keeps the live attempt.
        var policy = PairingIntakePolicy()
        let valid = makeInvite(token: token("c"))
        XCTAssertEqual(deliver(&policy, valid, now: now), .begin)
        policy.beganMutation(valid)
        let lateInvite = makeInvite(token: token("c"), expiresAt: expiredExpiryMs)
        XCTAssertEqual(deliver(&policy, lateInvite, now: now), .keep)
        XCTAssertEqual(policy.live, valid)
    }

    func testStaleOrUnguardedDeliveryDropped() throws {
        var policy = PairingIntakePolicy()
        let invite = makeInvite(token: token("c"))
        // No modal is open: any ticket is stale.
        XCTAssertEqual(policy.deliver(invite, ticket: 1, modalEnded: true, now: now), .drop)
        let ticket = policy.presentIntakeModal()
        // A callback racing the dismissal, before the modal finished, mutates nothing.
        XCTAssertEqual(policy.deliver(invite, ticket: ticket, modalEnded: false, now: now), .drop)
        XCTAssertEqual(policy.deliver(invite, ticket: 0, modalEnded: true, now: now), .drop)
        // A newer modal supersedes the earlier ticket entirely.
        let freshTicket = policy.presentIntakeModal()
        XCTAssertEqual(policy.deliver(invite, ticket: ticket, modalEnded: true, now: now), .drop)
        XCTAssertEqual(policy.deliver(invite, ticket: freshTicket, modalEnded: true, now: now), .begin)
    }

    func testCancelledModalTicketCannotDeliver() throws {
        var policy = PairingIntakePolicy()
        let ticket = policy.presentIntakeModal()
        policy.discardIntakeModal()
        let invite = makeInvite(token: token("c"))
        // The modal closed by cancellation; a late callback cannot deliver.
        XCTAssertEqual(policy.deliver(invite, ticket: ticket, modalEnded: true, now: now), .drop)
        // A fresh modal works normally afterwards.
        XCTAssertEqual(deliver(&policy, invite, now: now), .begin)
    }

    func testIntakeRunsOnlyAfterModalDismissal() throws {
        var policy = PairingIntakePolicy()
        let ticket = policy.presentIntakeModal()
        let invite = makeInvite(token: token("c"))
        XCTAssertEqual(policy.deliver(invite, ticket: ticket, modalEnded: false, now: now), .drop)
        XCTAssertEqual(policy.live, nil)
        XCTAssertEqual(policy.deliver(invite, ticket: ticket, modalEnded: true, now: now), .begin)
    }

    func testEndedMutationAllowsSameInvitationAgain() throws {
        var policy = PairingIntakePolicy()
        let invite = makeInvite(token: token("c"))
        XCTAssertEqual(deliver(&policy, invite, now: now), .begin)
        policy.beganMutation(invite)
        policy.endedMutation()
        // Abandonment, rejection, expiry, and approval each end the attempt;
        // the same invitation may then start one fresh mutation.
        XCTAssertEqual(deliver(&policy, invite, now: now), .begin)
    }
}
