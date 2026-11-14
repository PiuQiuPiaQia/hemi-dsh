/** Credential store and session persistence behavior. */

import XCTest
@testable import HemiMobileCore

final class KeychainStoreTests: XCTestCase {
    func testMemoryStoreRoundTripAndDelete() throws {
        let store = MemoryCredentialStore()
        XCTAssertNil(try store.read(account: "session"))
        try store.write(account: "session", Data("x".utf8))
        XCTAssertEqual(try store.read(account: "session"), Data("x".utf8))
        try store.write(account: "session", nil)
        XCTAssertNil(try store.read(account: "session"))
        // Deleting a missing item is not an error.
        try store.write(account: "session", nil)
    }

    func testSessionStoreRoundTrip() throws {
        let store = MemoryCredentialStore()
        XCTAssertNil(try SessionStore.load(store))
        let secret = SessionSecret(
            origin: "https://192.168.1.4:4317",
            fingerprint: String(repeating: "ab", count: 32),
            deviceId: UUID(),
            secret: "SECRETSECRETSECRETSECRETSECRETSECRETSECR",
            serverName: "Studio Mac",
            createdAt: Date(timeIntervalSince1970: 5)
        )
        try SessionStore.save(secret, to: store)
        XCTAssertEqual(try SessionStore.load(store), secret)
        try SessionStore.save(nil, to: store)
        XCTAssertNil(try SessionStore.load(store))
    }

    func testKeychainRoundTripWithIsolatedService() throws {
        // A unique service keeps this test independent of any real session slot.
        let service = "ai.hemi.dsh.mobile.tests.\(UUID().uuidString)"
        let store = KeychainStore(service: service)
        do {
            try store.write(account: "probe", Data("v".utf8))
            XCTAssertEqual(try store.read(account: "probe"), Data("v".utf8))
            try store.write(account: "probe", nil)
            XCTAssertNil(try store.read(account: "probe"))
        } catch {
            throw XCTSkip("host keychain unavailable: \(error)")
        }
    }

    func testSecretGeneratorIsBase64Url43() {
        let secret = SessionSecretGenerator.generate()
        XCTAssertEqual(secret.count, 43)
        XCTAssertNotNil(secret.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression))
    }
}
