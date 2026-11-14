/** Leaf-pinning evaluation shared by the URLSession and WKWebView trust gates. */

import Foundation
import CryptoKit

/** Verdict of comparing a presented chain against the paired fingerprint. */
public enum PinVerdict: Equatable, Sendable {
    case accepted
    /** Leaf fingerprint differs: the certificate changed; pairing must be redone. */
    case mismatch(actual: String)
    /** Chain failed host/policy evaluation after anchoring to the pinned leaf. */
    case invalidChain(String)
    /** The peer presented no certificate chain. */
    case noChain
}

/**
 * Lowercase hex SHA-256 of a certificate's DER encoding.
 * @param der - certificate bytes as stored in `SecCertificateCopyData`.
 * @returns 64 lowercase hex characters, the invite `fingerprint` format.
 */
public func fingerprintHex(ofDer der: Data) -> String {
    SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined()
}

/**
 * Compare a presented fingerprint against the paired pin.
 * @param actual - computed leaf fingerprint.
 * @param expected - paired fingerprint from the invitation.
 * @returns `.accepted` or `.mismatch` with the actual value for reporting.
 */
public func pinVerdict(actual: String, expected: String) -> PinVerdict {
    actual == expected ? .accepted : .mismatch(actual: actual)
}

/**
 * Evaluate a `SecTrust` against the paired pin exactly like the shell's gates:
 * pin the leaf by SHA-256(DER), anchor only to that leaf, apply the SSL host
 * policy, and forbid network fetches during evaluation.
 *
 * @param trust - server trust from the challenge.
 * @param host - expected host (no IPv6 brackets).
 * @param expectedPin - invite fingerprint.
 * @returns the verdict; `.accepted` means the caller may create a credential.
 */
public func evaluatePinnedTrust(_ trust: SecTrust, host: String, expectedPin: String) -> PinVerdict {
    guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first else {
        return .noChain
    }
    let actual = fingerprintHex(ofDer: SecCertificateCopyData(leaf) as Data)
    guard case .accepted = pinVerdict(actual: actual, expected: expectedPin) else {
        return .mismatch(actual: actual)
    }
    SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString))
    SecTrustSetAnchorCertificates(trust, [leaf] as CFArray)
    SecTrustSetAnchorCertificatesOnly(trust, true)
    SecTrustSetNetworkFetchAllowed(trust, false)
    var error: CFError?
    guard SecTrustEvaluateWithError(trust, &error) else {
        return .invalidChain(error.map(String.init(describing: )) ?? "unknown")
    }
    return .accepted
}
