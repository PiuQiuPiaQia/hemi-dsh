/** Deterministic request-deadline decisions for one pairing attempt. */

import Foundation
import XCTest
@testable import HemiMobileCore

final class PairingRequestClockTests: XCTestCase {
    func testReceiptSetsDeadlineWithBoundaryEnd() {
        var clock = PairingRequestClock()
        let deadlineSeconds = 2_000.0
        clock.reportedRequestExpiry(deadlineSeconds * 1000)
        // One millisecond before the deadline the request is still live.
        XCTAssertFalse(clock.isOverdue(now: Date(timeIntervalSince1970: deadlineSeconds - 0.001)))
        // At the deadline the request ends, like the host's `expiresAt <= now` sweep.
        XCTAssertTrue(clock.isOverdue(now: Date(timeIntervalSince1970: deadlineSeconds)))
    }

    func testStatusAnswerRefreshesDeadline() {
        var clock = PairingRequestClock()
        clock.reportedRequestExpiry(2_000_000)
        clock.reportedRequestExpiry(5_000_000)
        XCTAssertFalse(clock.isOverdue(now: Date(timeIntervalSince1970: 2_000)))
        XCTAssertTrue(clock.isOverdue(now: Date(timeIntervalSince1970: 5_000)))
    }

    func testUnknownOutcomeWithoutReceiptNeverTimesOutLocally() {
        let clock = PairingRequestClock()
        // Without a pair receipt the outcome is unknown: no local deadline
        // inference, and only a server answer or the user ends the attempt.
        XCTAssertFalse(clock.isOverdue(now: Date(timeIntervalSince1970: 1_000_000_000)))
    }

    func testLiveRequestOutlivesInvitationExpiry() {
        var clock = PairingRequestClock()
        clock.reportedRequestExpiry(2_000_000)
        // The invitation expired minutes ago while the request is still live:
        // polling continues and an approval is still accepted.
        XCTAssertFalse(clock.isOverdue(now: Date(timeIntervalSince1970: 1_500)))
        // Only the request deadline ends the attempt.
        XCTAssertTrue(clock.isOverdue(now: Date(timeIntervalSince1970: 2_000)))
    }
}
