/**
 * Read-only origin probing shared by invitation pairing and stored-session
 * recovery.
 *
 * Each candidate answers one credential-free `GET /mobile/session` on its own
 * ephemeral URLSession and pin delegate, so one candidate's TLS rejection can
 * never describe another candidate's connection. A candidate wins only when
 * the pinned host answers `401` with `{"error":"unauthorized"}` — the
 * unauthenticated reply of the real pairing endpoint. Anything else (2xx, 404,
 * 503, redirect, wrong pin, timeout) is not evidence that this host owns the
 * invitation. Probes carry no cookie, credential, cache entry, token, or
 * secret: a losing or hostile candidate learns nothing but the request line.
 */

import Foundation

enum OriginResolver {
    /** Candidates probed concurrently; bounds fan-out on slow interfaces. */
    static let waveSize = 4
    /** Per-attempt budget in seconds, for connect and response together. */
    static let attemptTimeout: TimeInterval = 2

    /**
     * Probe candidates in waves of `waveSize`; the earliest candidate in wire
     * order whose probe succeeds wins, and every later wave is never started.
     *
     * @param candidates - deduplicated candidate origins, wire order.
     * @param fingerprint - invitation pin applied to every probe connection.
     * @param protocolClasses - transport override inherited from the client
     *   configuration (test mock protocols); nil uses the system stack.
     * @returns the winning candidate origin.
     * @throws CancellationError when the caller cancelled;
     *   PairingFailure.unreachable when no candidate answered the probe.
     */
    static func resolve(candidates: [URL], fingerprint: String, protocolClasses: [AnyClass]? = nil) async throws -> URL {
        try Task.checkCancellation()
        var start = 0
        while start < candidates.count {
            let end = Swift.min(start + waveSize, candidates.count)
            if let winner = try await probeWave(Array(candidates[start..<end]), fingerprint: fingerprint, protocolClasses: protocolClasses) {
                return winner
            }
            start = end
        }
        throw PairingFailure.unreachable
    }

    /**
     * Probe one wave concurrently and return its lowest-index success.
     * Every task in the wave settles before the decision: the winner is
     * deterministic regardless of completion order.
     */
    private static func probeWave(_ candidates: [URL], fingerprint: String, protocolClasses: [AnyClass]?) async throws -> URL? {
        try await withThrowingTaskGroup(of: (Int, Bool).self) { group in
            for (offset, candidate) in candidates.enumerated() {
                group.addTask {
                    (offset, try await probe(candidate, fingerprint: fingerprint, protocolClasses: protocolClasses))
                }
            }
            var successes: [Int] = []
            for try await (offset, success) in group {
                if success { successes.append(offset) }
            }
            guard let winner = successes.min() else { return nil }
            return candidates[winner]
        }
    }

    /**
     * One credential-free probe request. Only CancellationError escapes;
     * every transport or protocol answer that is not the 401 proof of the
     * pairing endpoint counts as "candidate failed".
     */
    private static func probe(_ candidate: URL, fingerprint: String, protocolClasses: [AnyClass]?) async throws -> Bool {
        try Task.checkCancellation()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = attemptTimeout
        configuration.timeoutIntervalForResource = attemptTimeout
        configuration.protocolClasses = protocolClasses
        let delegate = PinnedTLSDelegate(pin: fingerprint)
        let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        var request = URLRequest(url: candidate.appendingPathComponent(MobileProtocol.sessionPath))
        request.httpMethod = "GET"
        request.timeoutInterval = attemptTimeout
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 401 else { return false }
            guard let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  value["error"] as? String == "unauthorized" else { return false }
            return true
        } catch {
            if Task.isCancelled { throw CancellationError() }
            return false
        }
    }
}
