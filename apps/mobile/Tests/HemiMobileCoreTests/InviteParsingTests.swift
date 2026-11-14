/** Invitation parsing behavior: accepted payloads and each typed rejection. */

import XCTest
@testable import HemiMobileCore

final class InviteParsingTests: XCTestCase {
    private func fixture(
        kind: String = "hemi-dsh-mobile",
        version: Any = 1,
        origin: String = "https://192.168.1.4:4317",
        origins: Any? = nil,
        fingerprint: String = String(repeating: "ab", count: 32),
        token: String = String(repeating: "c", count: 43),
        expiresAt: Double = 9900000000000
    ) -> String {
        var object: [String: Any] = [
            "kind": kind, "version": version, "origin": origin,
            "fingerprint": fingerprint, "token": token, "expiresAt": expiresAt,
        ]
        if let origins { object["origins"] = origins }
        let data = try! JSONSerialization.data(withJSONObject: object)
        return String(data: data, encoding: .utf8)!
    }

    func testAcceptsValidInvitation() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let result = parseInvitation(fixture(expiresAt: 1_000_000 * 1000 + 60_000), now: now)
        guard case .success(let invite) = result else { return XCTFail("expected success, got \(result)") }
        XCTAssertEqual(invite.host, "192.168.1.4")
        XCTAssertEqual(invite.port, 4317)
        XCTAssertEqual(invite.fingerprint, String(repeating: "ab", count: 32))
        XCTAssertEqual(invite.token, String(repeating: "c", count: 43))
        XCTAssertEqual(invite.originString, "https://192.168.1.4:4317")
    }

    func testRejectsWrongKindAndVersion() {
        guard case .failure(.wrongKind) = parseInvitation(fixture(kind: "hemi-bot-pair")) else {
            return XCTFail("expected wrongKind")
        }
        guard case .failure(.wrongVersion) = parseInvitation(fixture(version: 2)) else {
            return XCTFail("expected wrongVersion")
        }
    }

    func testRejectsBadOrigins() {
        for origin in ["http://192.168.1.4:4317", "https://user:pass@192.168.1.4:4317", "https://192.168.1.4:4317/path", "https://192.168.1.4:4317?q=1", "not a url"] {
            guard case .failure(.badOrigin) = parseInvitation(fixture(origin: origin)) else {
                return XCTFail("expected badOrigin for \(origin)")
            }
        }
    }

    func testRejectsBadFingerprintAndToken() {
        guard case .failure(.badFingerprint) = parseInvitation(fixture(fingerprint: String(repeating: "AB", count: 32))) else {
            return XCTFail("expected badFingerprint for uppercase")
        }
        guard case .failure(.badFingerprint) = parseInvitation(fixture(fingerprint: String(repeating: "ab", count: 31))) else {
            return XCTFail("expected badFingerprint for short value")
        }
        guard case .failure(.badToken) = parseInvitation(fixture(token: "short")) else {
            return XCTFail("expected badToken")
        }
    }

    func testRejectsExpiredAndFarFuture() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        guard case .failure(.expired) = parseInvitation(fixture(expiresAt: 999_999 * 1000.0), now: now) else {
            return XCTFail("expected expired")
        }
        guard case .failure(.expiresTooFar) = parseInvitation(fixture(expiresAt: now.timeIntervalSince1970 * 1000 + MobileProtocol.maxInviteWindowMs + 1), now: now) else {
            return XCTFail("expected expiresTooFar")
        }
    }

    func testRejectsNonJsonAndOversized() {
        guard case .failure(.notJson) = parseInvitation("{") else { return XCTFail("expected notJson") }
        guard case .failure(.tooLong) = parseInvitation(String(repeating: "x", count: 4097)) else {
            return XCTFail("expected tooLong")
        }
    }

    // MARK: - origins wire field

    private var fixtureNow: Date { Date(timeIntervalSince1970: 1_000_000) }
    private var fixtureExpiry: Double { 1_000_000 * 1000 + 60_000 }

    func testMissingOriginsKeepsLegacySingleAddressShape() {
        guard case .success(let invite) = parseInvitation(fixture(expiresAt: fixtureExpiry), now: fixtureNow) else {
            return XCTFail("expected success")
        }
        XCTAssertNil(invite.origins)
        XCTAssertEqual(invite.originString, "https://192.168.1.4:4317")
    }

    func testParsesOriginCandidatesWithFirstEqualPrimary() {
        let origins = [
            "https://192.168.1.4:4317",
            "https://10.1.2.3:4317",
            "https://172.16.0.9:4317",
            "https://169.254.10.11:4317",
        ]
        let result = parseInvitation(fixture(origins: origins, expiresAt: fixtureExpiry), now: fixtureNow)
        guard case .success(let invite) = result else { return XCTFail("expected success, got \(result)") }
        XCTAssertEqual(invite.origins?.map(\.absoluteString), origins)
        XCTAssertEqual(invite.origins?.first, invite.origin)
    }

    func testDedupesOriginCandidatesInWireOrder() {
        let origins = [
            "https://192.168.1.4:4317",
            "https://192.168.1.4:4317/",
            "https://10.0.0.7:4317",
            "https://10.0.0.7:4317",
        ]
        let result = parseInvitation(fixture(origins: origins, expiresAt: fixtureExpiry), now: fixtureNow)
        guard case .success(let invite) = result else { return XCTFail("expected success, got \(result)") }
        XCTAssertEqual(invite.origins?.map(\.originStringInTests), [
            "https://192.168.1.4:4317", "https://10.0.0.7:4317",
        ])
    }

    func testFirstCandidateMayOmitDefaultPort() {
        // Same authority with an explicit default port is still the primary origin.
        let origins = ["https://192.168.1.4:443", "https://10.0.0.7:443"]
        let result = parseInvitation(
            fixture(origin: "https://192.168.1.4", origins: origins, expiresAt: fixtureExpiry), now: fixtureNow
        )
        guard case .success(let invite) = result else { return XCTFail("expected success, got \(result)") }
        XCTAssertEqual(invite.origin.host, "192.168.1.4")
        XCTAssertEqual(invite.port, 443)
        XCTAssertEqual(invite.origins?.count, 2)
    }

    func testRejectsBadOriginCandidates() {
        let origin = "https://192.168.1.4:4317"
        let cases: [String: Any] = [
            "empty": [String](),
            "not an array": "https://192.168.1.4:4317",
            "non-string entry": [1, 2],
            "first is another host": ["https://10.0.0.5:4317", "https://192.168.1.4:4317"],
            "first has another port": ["https://192.168.1.4:4318"],
            "mixed ports": [origin, "https://10.0.0.5:4318"],
            "public IPv4": [origin, "https://8.8.8.8:4317"],
            "loopback": [origin, "https://127.0.0.1:4317"],
            "hostname": [origin, "https://studio.local:4317"],
            "http scheme": [origin, "http://10.0.0.5:4317"],
            "path": [origin, "https://10.0.0.5:4317/pair"],
            "query": [origin, "https://10.0.0.5:4317?q=1"],
            "fragment": [origin, "https://10.0.0.5:4317#f"],
            "userinfo": [origin, "https://user@10.0.0.5:4317"],
            "IPv6": [origin, "https://[fe80::1]:4317"],
            "not a url": [origin, "://"],
            "bounded": [origin] + Array(repeating: "https://10.0.0.5:4317", count: MobileProtocol.maxCandidateOrigins),
        ]
        for (name, origins) in cases {
            let result = parseInvitation(fixture(origins: origins, expiresAt: fixtureExpiry), now: fixtureNow)
            guard case .failure(.badOrigin) = result else {
                return XCTFail("expected badOrigin for \(name), got \(result)")
            }
        }
    }

    func testSessionSecretCodableStaysBackwardCompatible() throws {
        let legacy = Data(
            #"{"origin":"https://192.168.1.4:4317","fingerprint":"\#(String(repeating: "ab", count: 32))","deviceId":"123E4567-e89b-12d3-a456-426614174000","secret":"s","serverName":"mac","createdAt":700000000}"#.utf8
        )
        let decoded = try JSONDecoder().decode(SessionSecret.self, from: legacy)
        XCTAssertNil(decoded.candidateOrigins)
        XCTAssertEqual(decoded.origin, "https://192.168.1.4:4317")

        let current = SessionSecret(
            origin: "https://10.0.0.7:4317",
            fingerprint: String(repeating: "ab", count: 32),
            deviceId: UUID(uuidString: "123e4567-e89b-12d3-a456-426614174000")!,
            secret: "s",
            serverName: "mac",
            createdAt: Date(timeIntervalSince1970: 700),
            candidateOrigins: ["https://10.0.0.7:4317", "https://192.168.1.4:4317"]
        )
        let roundTrip = try JSONDecoder().decode(SessionSecret.self, from: JSONEncoder().encode(current))
        XCTAssertEqual(roundTrip, current)
        // The old reader ignores the new key entirely.
        let oldShape = try JSONDecoder().decode(SessionSecret.self, from: legacy)
        XCTAssertEqual(oldShape.deviceId.uuidString.lowercased(), "123e4567-e89b-12d3-a456-426614174000")
    }
}

private extension URL {
    /// Wire-order origin text of a candidate, without a trailing slash.
    var originStringInTests: String { canonicalOriginString(self) }
}
