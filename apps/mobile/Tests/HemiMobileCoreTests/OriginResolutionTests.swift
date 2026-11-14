/**
 * Multi-candidate origin resolution against the mock protocol: probe shape,
 * winner selection, failure isolation, cancellation, and the one-shot pair
 * call after resolution.
 */

import XCTest
@testable import HemiMobileCore

final class OriginResolutionTests: XCTestCase {
    private let primary = "https://192.168.1.4:4317"
    private let second = "https://10.0.0.7:4317"
    private let third = "https://172.16.0.9:4317"

    override func setUp() {
        super.setUp()
        MockURLProtocol.reset()
    }

    override func tearDown() {
        MockURLProtocol.reset()
        super.tearDown()
    }

    private func makeClient() -> PairingClient {
        PairingClient(fingerprint: String(repeating: "ab", count: 32), configuration: MockURLProtocol.makeConfiguration())
    }

    /// 401 with the unauthenticated-endpoint proof body; any other answer is a failure below.
    private func unauthorized() -> (Int, [String: String], Data) {
        (401, ["Content-Type": "application/json"], Data(#"{"error":"unauthorized"}"#.utf8))
    }

    func testSingleAddressInvitationReturnsUnchangedWithoutNetwork() async throws {
        let invite = try makeInvite()
        let resolved = try await makeClient().resolveInvitation(invite)
        XCTAssertEqual(resolved, invite)
        XCTAssertTrue(MockURLProtocol.requests.isEmpty)
    }

    func testProbesAreGetOnlyAndCarryNoAuthOrCookies() async throws {
        let invite = try makeInvite(origins: [primary, second])
        MockURLProtocol.handler = { _, _ in self.unauthorized() }

        let resolved = try await makeClient().resolveInvitation(invite)

        // Both candidates share one wave, so both answer one probe each.
        XCTAssertEqual(MockURLProtocol.requests.count, 2)
        for (request, body) in MockURLProtocol.requests {
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/mobile/session")
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
            XCTAssertNil(body)
        }
        XCTAssertEqual(Set(MockURLProtocol.requests.map { $0.0.url?.host }), ["192.168.1.4", "10.0.0.7"])
        XCTAssertEqual(resolved.origin.absoluteString, primary)
        XCTAssertEqual(resolved.origins?.map(\.absoluteString), [primary, second])
    }

    func testEarliestReachableCandidateWinsDeterministically() async throws {
        let invite = try makeInvite(origins: [primary, second, third])
        MockURLProtocol.handler = { _, _ in self.unauthorized() }

        let resolved = try await makeClient().resolveInvitation(invite)

        XCTAssertEqual(resolved.origin.absoluteString, primary)
        XCTAssertEqual(resolved.origins?.first, resolved.origin)
        XCTAssertEqual(resolved.origins?.count, 3)
    }

    func testFirstCandidateFailureDoesNotBlockLaterCandidates() async throws {
        let invite = try makeInvite(origins: [primary, second])
        struct Boom: Error {}
        let firstAnswers: [(URLRequest, Data?) throws -> (Int, [String: String], Data)] = [
            // Wrong endpoint answer: not the 401 proof.
            { _, _ in (503, [:], Data(#"{"error":"unavailable"}"#.utf8)) },
            // Transport failure on the first candidate.
            { _, _ in throw Boom() },
            // Redirect: the pinned delegate refuses it, which is a failure.
            { _, _ in (302, ["Location": "/login"], Data()) },
            // 401 with the wrong error code is not the proof either.
            { _, _ in (401, [:], Data(#"{"error":"other"}"#.utf8)) },
        ]
        for firstAnswer in firstAnswers {
            MockURLProtocol.reset()
            MockURLProtocol.handler = { request, body in
                if request.url?.host == "192.168.1.4" { return try firstAnswer(request, body) }
                return self.unauthorized()
            }
            let resolved = try await makeClient().resolveInvitation(invite)
            XCTAssertEqual(resolved.origin.absoluteString, second, "later candidate must win after first fails")
            XCTAssertEqual(resolved.origins?.map(\.absoluteString), [second, primary])
        }
    }

    func testAnswersOtherThanUnauthorized401AreNeverSuccess() async throws {
        let invite = try makeInvite(origins: [primary, second])
        let answers: [(Int, String)] = [
            (200, #"{"error":"unauthorized"}"#),
            (404, #"{"error":"unauthorized"}"#),
            (429, #"{"error":"unauthorized"}"#),
            (401, #"{"error":"expired"}"#),
            (401, #"not json"#),
        ]
        for (status, payload) in answers {
            MockURLProtocol.reset()
            MockURLProtocol.handler = { _, _ in (status, [:], Data(payload.utf8)) }
            do {
                _ = try await makeClient().resolveInvitation(invite)
                XCTFail("expected unreachable failure for \(status) \(payload)")
            } catch let error as PairingFailure {
                // The case carries no detail string, so nothing candidate- or
                // host-shaped can leak into the surfaced failure.
                guard case .unreachable = error else { return XCTFail("expected unreachable, got \(error)") }
            }
        }
    }

    func testAllCandidatesFailingThrowsTypedUnreachableFailure() async throws {
        let invite = try makeInvite(origins: [primary, second, third])
        MockURLProtocol.handler = { _, _ in (503, [:], Data()) }
        do {
            _ = try await makeClient().resolveInvitation(invite)
            XCTFail("expected unreachable failure")
        } catch let error as PairingFailure {
            guard case .unreachable = error else { return XCTFail("expected unreachable, got \(error)") }
        }
    }

    func testCallerCancellationSurfacesAsCancellationError() async throws {
        let invite = try makeInvite(origins: [primary, second])
        MockURLProtocol.handler = { _, _ in
            Thread.sleep(forTimeInterval: 2)
            return (200, [:], Data())
        }
        let client = makeClient()
        let task = Task { try await client.resolveInvitation(invite) }
        try await Task.sleep(nanoseconds: 200_000_000)
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("expected cancellation")
        } catch {
            XCTAssertTrue(error is CancellationError, "expected CancellationError, got \(error)")
        }
    }

    func testRequestPairAfterResolutionPostsOnceToChosenOriginWithoutFallback() async throws {
        let invite = try makeInvite(origins: [primary, second])
        MockURLProtocol.handler = { request, _ in
            if request.url?.host == "192.168.1.4" { return (503, [:], Data()) }
            if request.url?.path == "/mobile/session" { return self.unauthorized() }
            // The single POST to the chosen origin fails; the client must surface it, not re-send elsewhere.
            return (503, [:], Data(#"{"error":"unavailable"}"#.utf8))
        }
        let client = makeClient()
        let resolved = try await client.resolveInvitation(invite)
        XCTAssertEqual(resolved.origin.host, "10.0.0.7")
        let postsBeforePair = MockURLProtocol.requests.filter { $0.0.httpMethod == "POST" }.count
        XCTAssertEqual(postsBeforePair, 0)

        do {
            _ = try await client.requestPair(
                invite: resolved, deviceName: "iPhone", requestId: UUID(), secret: String(repeating: "d", count: 43)
            )
            XCTFail("expected pair failure")
        } catch let error as PairingFailure {
            guard case .network = error else { return XCTFail("expected network, got \(error)") }
        }

        let posts = MockURLProtocol.requests.filter { $0.0.httpMethod == "POST" }
        XCTAssertEqual(posts.count, 1, "requestPair stays one-shot")
        XCTAssertEqual(posts[0].0.url?.host, "10.0.0.7")
        XCTAssertEqual(posts[0].0.url?.path, "/mobile/pair")
    }

    // MARK: - resolveSession

    private func makeSavedSession(_ origin: String, _ candidates: [String]?) -> SessionSecret {
        SessionSecret(
            origin: origin,
            fingerprint: String(repeating: "ab", count: 32),
            deviceId: UUID(uuidString: "123e4567-e89b-12d3-a456-426614174000")!,
            secret: "SECRETSECRETSECRETSECRETSECRETSECRETSECR",
            serverName: "Studio Mac",
            createdAt: Date(timeIntervalSince1970: 700),
            candidateOrigins: candidates
        )
    }

    func testResolveSessionWithoutCandidateCapableOriginReturnsUnchanged() async throws {
        // A hostname origin has no probeable candidate under the invitation
        // rules: recovery falls through to the bounded openSession and never
        // touches the network here.
        let hostname = "https://studio.local:4317"
        for candidates in [nil, [String](), ["not a url"]] {
            let saved = makeSavedSession(hostname, candidates)
            let resolved = try await makeClient().resolveSession(saved)
            XCTAssertEqual(resolved, saved)
        }
        XCTAssertTrue(MockURLProtocol.requests.isEmpty)
    }

    func testResolveSessionHostnameOriginNeverOverridesCandidateField() async throws {
        // The stored hostname origin is not a candidate-rules address; when
        // the field still holds probeable entries they stay authoritative, and
        // the hostname is never probed or substituted for them.
        let saved = makeSavedSession("https://studio.local:4317", [primary, second])
        MockURLProtocol.handler = { request, _ in
            request.url?.host == "studio.local" ? self.unauthorized() : (503, [:], Data())
        }
        do {
            _ = try await makeClient().resolveSession(saved)
            XCTFail("expected unreachable failure")
        } catch let error as PairingFailure {
            guard case .unreachable = error else { return XCTFail("expected unreachable, got \(error)") }
        }
        XCTAssertTrue(
            MockURLProtocol.requests.allSatisfy { $0.0.url?.host != "studio.local" },
            "the hostname origin is never probed"
        )
    }

    func testResolveSessionSingleLegacyCandidateProbesCredentialFreeBeforeOpening() async throws {
        // Legacy storage: no `candidateOrigins` field, the stored origin is the
        // only probeable address. Recovery must confirm it credential-free
        // first, keep the stored fields (and the nil field) unchanged, and send
        // no POST.
        let saved = makeSavedSession(primary, nil)
        MockURLProtocol.handler = { _, _ in self.unauthorized() }

        let resolved = try await makeClient().resolveSession(saved)

        XCTAssertEqual(resolved, saved, "a confirmed single candidate must not rewrite stored fields")
        XCTAssertEqual(MockURLProtocol.requests.count, 1)
        let (request, body) = MockURLProtocol.requests[0]
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/mobile/session")
        XCTAssertEqual(request.url?.host, "192.168.1.4")
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"), "probes carry no credential")
        XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
        XCTAssertNil(body)
        XCTAssertEqual(MockURLProtocol.requests.filter { $0.0.httpMethod == "POST" }.count, 0)
    }

    func testResolveSessionSingleUnreachableCandidateFailsTypedWithoutCredentials() async throws {
        // The reported failure mode: the saved address no longer answers.
        // Recovery learns that in one probe, fails typed, and never sends the
        // bearer or any POST to it.
        let saved = makeSavedSession(primary, nil)
        MockURLProtocol.handler = { _, _ in (503, [:], Data()) }
        do {
            _ = try await makeClient().resolveSession(saved)
            XCTFail("expected unreachable failure")
        } catch let error as PairingFailure {
            guard case .unreachable = error else { return XCTFail("expected unreachable, got \(error)") }
        }
        for (request, _) in MockURLProtocol.requests {
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"), "probes carry no credential")
            XCTAssertEqual(request.httpMethod, "GET")
        }
        XCTAssertEqual(MockURLProtocol.requests.filter { $0.0.httpMethod == "POST" }.count, 0)
    }

    func testResolveSessionSingleCandidateCancellationSurfacesWithoutPost() async throws {
        let saved = makeSavedSession(primary, nil)
        MockURLProtocol.handler = { _, _ in
            Thread.sleep(forTimeInterval: 2)
            return (200, [:], Data())
        }
        let client = makeClient()
        let task = Task { try await client.resolveSession(saved) }
        try await Task.sleep(nanoseconds: 200_000_000)
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("expected cancellation")
        } catch {
            XCTAssertTrue(error is CancellationError, "expected CancellationError, got \(error)")
        }
        XCTAssertEqual(MockURLProtocol.requests.filter { $0.0.httpMethod == "POST" }.count, 0)
    }

    func testResolveSessionPicksEarliestReachableCandidate() async throws {
        let saved = makeSavedSession(primary, [primary, second, third])
        MockURLProtocol.handler = { request, _ in
            request.url?.host == "192.168.1.4" ? (503, [:], Data()) : self.unauthorized()
        }
        let resolved = try await makeClient().resolveSession(saved)
        XCTAssertEqual(resolved.origin, second)
        XCTAssertEqual(resolved.candidateOrigins, [second, primary, third])
        XCTAssertEqual(resolved.deviceId, saved.deviceId)
        XCTAssertEqual(resolved.secret, saved.secret)
        XCTAssertEqual(resolved.serverName, saved.serverName)
    }

    func testResolveSessionAllFailingThrowsTypedUnreachableFailure() async throws {
        let saved = makeSavedSession(primary, [primary, second])
        MockURLProtocol.handler = { _, _ in (503, [:], Data()) }
        do {
            _ = try await makeClient().resolveSession(saved)
            XCTFail("expected unreachable failure")
        } catch let error as PairingFailure {
            guard case .unreachable = error else { return XCTFail("expected unreachable, got \(error)") }
        }
    }
}
