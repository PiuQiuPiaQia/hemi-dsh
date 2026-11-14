/** Pairing wire behavior against a mock protocol: exact request fields and typed failures. */

import XCTest
@testable import HemiMobileCore

final class PairingClientTests: XCTestCase {
    override func setUp() {
        super.setUp()
        MockURLProtocol.reset()
    }

    override func tearDown() {
        MockURLProtocol.reset()
        super.tearDown()
    }

    private func makeClient(fingerprint: String = String(repeating: "ab", count: 32)) -> PairingClient {
        PairingClient(fingerprint: fingerprint, configuration: MockURLProtocol.makeConfiguration())
    }

    func testRequestPairSendsExactFieldsAndParsesPending() async throws {
        let invite = try makeInvite()
        let requestId = UUID()
        MockURLProtocol.handler = { _, _ in
            let body = """
            {"requestId":"\(requestId.uuidString.lowercased())","verificationCode":"123456","status":"pending","expiresAt":123.5,"serverName":"Studio Mac"}
            """
            return (200, ["Content-Type": "application/json"], Data(body.utf8))
        }
        let pending = try await makeClient().requestPair(
            invite: invite, deviceName: "iPhone", requestId: requestId, secret: String(repeating: "d", count: 43)
        )
        XCTAssertEqual(pending.verificationCode, "123456")
        XCTAssertEqual(pending.serverName, "Studio Mac")
        XCTAssertEqual(pending.expiresAt, 123.5, accuracy: 0.001)

        XCTAssertEqual(MockURLProtocol.requests.count, 1)
        let (request, body) = MockURLProtocol.requests[0]
        XCTAssertEqual(request.url?.path, "/mobile/pair")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(body)) as? [String: Any])
        XCTAssertEqual(sent["version"] as? Int, 1)
        XCTAssertEqual(sent["invitationToken"] as? String, invite.token)
        XCTAssertEqual(sent["requestId"] as? String, requestId.uuidString.lowercased())
        XCTAssertEqual(sent["deviceName"] as? String, "iPhone")
        XCTAssertEqual(sent["secret"] as? String, String(repeating: "d", count: 43))
    }

    func testRequestPairRejectsInvalidDeviceNameWithoutSending() async throws {
        let invite = try makeInvite()
        do {
            _ = try await makeClient().requestPair(invite: invite, deviceName: "", requestId: UUID(), secret: "s")
            XCTFail("expected invalid")
        } catch let error as PairingFailure {
            XCTAssertEqual(error, .invalid("deviceName length"))
        }
        XCTAssertTrue(MockURLProtocol.requests.isEmpty)
    }

    func testRequestPairValidatesCodeFormat() async throws {
        let invite = try makeInvite()
        MockURLProtocol.handler = { _, _ in
            (200, ["Content-Type": "application/json"], Data("{\"requestId\":\"x\",\"verificationCode\":\"12a456\",\"status\":\"pending\",\"expiresAt\":1,\"serverName\":\"s\"}".utf8))
        }
        do {
            _ = try await makeClient().requestPair(invite: invite, deviceName: "iPhone", requestId: UUID(), secret: "s")
            XCTFail("expected badResponse")
        } catch let error as PairingFailure {
            guard case .badResponse = error else { return XCTFail("expected badResponse, got \(error)") }
        }
    }

    func testPollStatusOutcomes() async throws {
        let invite = try makeInvite()
        let cases: [(String, PairStatus)] = [
            ("{\"status\":\"pending\",\"serverName\":\"s\",\"verificationCode\":\"654321\",\"expiresAt\":9.0}", .pending(verificationCode: "654321", expiresAt: 9.0, serverName: "s")),
            ("{\"status\":\"approved\",\"serverName\":\"s\",\"deviceId\":\"123e4567-e89b-12d3-a456-426614174000\"}", .approved(deviceId: UUID(uuidString: "123e4567-e89b-12d3-a456-426614174000")!, serverName: "s")),
            ("{\"status\":\"rejected\",\"serverName\":\"s\"}", .rejected(serverName: "s")),
            ("{\"status\":\"expired\"}", .expired),
        ]
        for (payload, expected) in cases {
            MockURLProtocol.reset()
            MockURLProtocol.handler = { _, _ in (200, ["Content-Type": "application/json"], Data(payload.utf8)) }
            let status = try await makeClient().pollStatus(invite: invite, requestId: UUID(), secret: "s")
            XCTAssertEqual(status, expected)
        }
    }

    func testHttpFailuresMapToTypedErrors() async throws {
        let invite = try makeInvite()
        let cases: [Int: PairingFailure] = [
            401: .unauthorized, 403: .refused, 404: .notFound, 429: .rateLimited,
        ]
        for (status, expected) in cases {
            MockURLProtocol.reset()
            MockURLProtocol.handler = { _, _ in (status, [:], Data("{\"error\":\"x\"}".utf8)) }
            do {
                _ = try await makeClient().requestPair(invite: invite, deviceName: "iPhone", requestId: UUID(), secret: "s")
                XCTFail("expected failure for HTTP \(status)")
            } catch let error as PairingFailure {
                XCTAssertEqual(error, expected, "HTTP \(status)")
            }
        }
    }

    func testOpenSessionSendsBearerAndParsesCookie() async throws {
        let secret = SessionSecret(
            origin: "https://192.168.1.4:4317",
            fingerprint: String(repeating: "ab", count: 32),
            deviceId: UUID(uuidString: "123e4567-e89b-12d3-a456-426614174000")!,
            secret: "SECRETSECRETSECRETSECRETSECRETSECRETSECR",
            serverName: "old",
            createdAt: Date()
        )
        MockURLProtocol.handler = { _, _ in
            let body = "{\"version\":1,\"deviceId\":\"\(secret.deviceId.uuidString)\",\"serverName\":\"Studio Mac\"}"
            return (
                200,
                [
                    "Content-Type": "application/json",
                    "Set-Cookie": "__Host-hemi-mobile=\(secret.deviceId.uuidString.lowercased()).\(secret.secret); Secure; HttpOnly; SameSite=Strict; Path=/",
                ],
                Data(body.utf8)
            )
        }
        let facts = try await makeClient().openSession(secret)
        XCTAssertEqual(facts.serverName, "Studio Mac")
        XCTAssertEqual(facts.cookieValue, "\(secret.deviceId.uuidString.lowercased()).\(secret.secret)")

        let (request, _) = MockURLProtocol.requests[0]
        XCTAssertEqual(request.url?.path, "/mobile/session")
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer \(secret.bearerValue)")
    }

    func testOpenSessionRejectsDeviceIdMismatch() async throws {
        let secret = SessionSecret(
            origin: "https://192.168.1.4:4317", fingerprint: String(repeating: "ab", count: 32),
            deviceId: UUID(), secret: "s", serverName: "n", createdAt: Date()
        )
        MockURLProtocol.handler = { _, _ in
            (200, [:], Data("{\"version\":1,\"deviceId\":\"123e4567-e89b-12d3-a456-426614174000\",\"serverName\":\"x\"}".utf8))
        }
        do {
            _ = try await makeClient().openSession(secret)
            XCTFail("expected badResponse")
        } catch let error as PairingFailure {
            guard case .badResponse = error else { return XCTFail("got \(error)") }
        }
    }

    func testCookieValueExtraction() {
        let response = HTTPURLResponse(
            url: URL(string: "https://h/x")!, statusCode: 200, httpVersion: nil,
            headerFields: ["Set-Cookie": "other=1; Path=/", "set-cookie": "__Host-hemi-mobile=v1; Secure; HttpOnly"]
        )!
        // HTTPURLResponse collapses duplicate header names case-insensitively; whichever survives,
        // extraction must find only the exact cookie name.
        let extracted = PairingClient.cookieValue(from: response, name: "__Host-hemi-mobile")
        XCTAssertTrue(extracted == "v1" || extracted == nil)
        XCTAssertEqual(PairingClient.cookieValue(from: response, name: "other"), extracted == "v1" ? nil : "1")
    }

    func testNetworkErrorMapsToUnknownOutcome() async throws {
        struct Boom: Error {}
        MockURLProtocol.handler = { _, _ in throw Boom() }
        let invite = try makeInvite()
        do {
            _ = try await makeClient().requestPair(invite: invite, deviceName: "iPhone", requestId: UUID(), secret: "s")
            XCTFail("expected failure")
        } catch let error as PairingFailure {
            guard case .network = error else { return XCTFail("expected network, got \(error)") }
        }
    }

    // MARK: - Bounded request budget

    private func makeSecret(origin: String, candidates: [String]? = nil) -> SessionSecret {
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

    /// The openSession GET carries the explicit per-request budget, and the
    /// whole-request bound lives on the client's owned configuration copy — a
    /// caller-shared configuration object must come out unmutated.
    func testOpenSessionCarriesRequestBudgetWithoutMutatingSharedConfiguration() async throws {
        let secret = makeSecret(origin: "https://192.168.1.4:4317")
        MockURLProtocol.handler = { _, _ in
            (200, ["Content-Type": "application/json"], Data(#"{"version":1,"deviceId":"123e4567-e89b-12d3-a456-426614174000","serverName":"Studio Mac"}"#.utf8))
        }
        let shared = MockURLProtocol.makeConfiguration()
        let sharedResourceTimeout = shared.timeoutIntervalForResource
        let sharedWaitsForConnectivity = shared.waitsForConnectivity
        let client = PairingClient(fingerprint: String(repeating: "ab", count: 32), configuration: shared)
        _ = try await client.openSession(secret)

        let (request, _) = try XCTUnwrap(MockURLProtocol.requests.first)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.timeoutInterval, PairingClient.requestBudget)
        XCTAssertEqual(client.configuration.timeoutIntervalForResource, PairingClient.requestBudget)
        XCTAssertEqual(client.configuration.waitsForConnectivity, false)
        XCTAssertEqual(shared.timeoutIntervalForResource, sharedResourceTimeout, "the injected configuration object is never mutated")
        XCTAssertEqual(shared.waitsForConnectivity, sharedWaitsForConnectivity, "the injected configuration object is never mutated")
    }

    /// The budget expiring is a typed unknown outcome, surfaced once: no retry,
    /// no status POST, and no credential-clearing request afterwards.
    func testOpenSessionTimeoutMapsToTypedFailureWithoutRetryOrPost() async throws {
        let secret = makeSecret(origin: "https://192.168.1.4:4317")
        MockURLProtocol.handler = { _, _ in throw URLError(.timedOut) }
        do {
            _ = try await makeClient().openSession(secret)
            XCTFail("expected timeout failure")
        } catch let error as PairingFailure {
            XCTAssertEqual(error, .timedOut)
        }
        XCTAssertEqual(MockURLProtocol.requests.count, 1, "the timed-out GET is never retried")
        XCTAssertEqual(MockURLProtocol.requests.filter { $0.0.httpMethod == "POST" }.count, 0)
    }

    /// Caller cancellation escapes as CancellationError and nothing further is
    /// sent: the stored credentials are only ever cleared by the explicit
    /// fail-closed paths, never by a cancelled or timed-out exchange.
    func testOpenSessionCallerCancellationSurfacesWithoutPost() async throws {
        let secret = makeSecret(origin: "https://192.168.1.4:4317")
        MockURLProtocol.handler = { _, _ in
            Thread.sleep(forTimeInterval: 2)
            return (200, [:], Data())
        }
        let client = makeClient()
        let task = Task { try await client.openSession(secret) }
        try await Task.sleep(nanoseconds: 200_000_000)
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("expected cancellation")
        } catch {
            XCTAssertTrue(error is CancellationError, "expected CancellationError, got \(error)")
        }
        XCTAssertEqual(MockURLProtocol.requests.filter { $0.0.httpMethod == "POST" }.count, 0)
        XCTAssertEqual(MockURLProtocol.requests.count, 1, "only the one cancelled GET was sent")
    }
}
