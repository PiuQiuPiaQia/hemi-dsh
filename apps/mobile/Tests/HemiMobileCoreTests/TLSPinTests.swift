/** Leaf pin verdicts from raw DER bytes. */

import XCTest
@testable import HemiMobileCore

final class TLSPinTests: XCTestCase {
    func testFingerprintIsLowercaseHexSha256() {
        let der = Data([0x30, 0x03, 0x02, 0x01, 0x0a])
        let digest = SHA256Helper.hex(of: der)
        XCTAssertEqual(fingerprintHex(ofDer: der), digest)
        XCTAssertEqual(digest.count, 64)
        XCTAssertNotNil(digest.range(of: "^[0-9a-f]{64}$", options: .regularExpression))
    }

    func testPinVerdictComparesExactly() {
        XCTAssertEqual(pinVerdict(actual: "aa", expected: "aa"), .accepted)
        XCTAssertEqual(pinVerdict(actual: "aa", expected: "bb"), .mismatch(actual: "aa"))
    }

    func testFingerprintMatchesOpensslOutput() {
        // sha256 of the empty input, as `openssl dgst -sha256` prints it.
        XCTAssertEqual(fingerprintHex(ofDer: Data()), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    }
}

import CryptoKit

enum SHA256Helper {
    static func hex(of data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
