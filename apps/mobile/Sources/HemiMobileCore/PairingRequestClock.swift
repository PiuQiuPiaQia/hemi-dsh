/** Server-reported deadline of one pair request. */

import Foundation

/**
 * Deadline state of one pairing attempt's pair request.
 *
 * The host gives every pair request its own TTL, returned as `expiresAt` in
 * the pair receipt and in every pending status answer, so a request outlives
 * its invitation. An attempt without a receipt — the pair POST's outcome is
 * unknown — never times out locally: only a server answer or the user ends it.
 */
public struct PairingRequestClock: Equatable, Sendable {
    /** Epoch-ms deadline of the pair request; nil until the server reported one. */
    public private(set) var requestExpiresAt: Double?

    /**
     * @param requestExpiresAt - deadline already reported earlier in this
     *   attempt, so a resumed poll keeps the known deadline; nil starts receipt-less.
     */
    public init(requestExpiresAt: Double? = nil) {
        self.requestExpiresAt = requestExpiresAt
    }

    /**
     * Record the server-reported request deadline.
     * @param expiresAt - epoch-ms deadline from the pair receipt or a status answer.
     */
    public mutating func reportedRequestExpiry(_ expiresAt: Double) {
        requestExpiresAt = expiresAt
    }

    /**
     * Whether the request deadline has passed, matching the host's own
     * `expiresAt <= now` expiry sweep.
     *
     * @param now - current time.
     * @returns true only when a deadline was reported and `now` reached it.
     */
    public func isOverdue(now: Date) -> Bool {
        guard let requestExpiresAt else { return false }
        return now.timeIntervalSince1970 * 1000 >= requestExpiresAt
    }
}
