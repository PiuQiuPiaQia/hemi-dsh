/**
 * URLSession delegate enforcing the paired leaf pin on every connection.
 *
 * Borrowed from the previous Hemi shell's `hemiPinnedTLS` verification block
 * (`HemiDeviceClient.swift` lines 82-99 in the old repository), moved from
 * Network.framework TLS options to a URLSession delegate. The old hand-written
 * HTTP/1.1 Content-Length parser is intentionally not carried over: DSH
 * responses include multipart and streaming bodies, which URLSession handles
 * natively.
 */

import Foundation

public enum TransportFailure: Error, Equatable, Sendable {
    /** Pin mismatch: the server certificate changed since pairing. */
    case certificateChanged(actualFingerprint: String)
    /** TLS failed for another reason under the pinned policy. */
    case tlsRejected(String)
    /** No certificate chain was presented. */
    case tlsNoChain
    /** Transport-level failure; the outcome of the request is unknown. */
    case network(String)
    /** The request budget expired without an answer; the outcome is unknown. */
    case timedOut
}

/**
 * Challenge handler shared by the pairing URLSession and the native WebSocket
 * bridge session. Declared as `URLSessionTaskDelegate` (not just
 * `URLSessionDelegate`) so the redirect refusal below is exposed to the
 * Objective-C runtime and actually invoked.
 *
 * Fails closed on any challenge whose pin does not match, and records the
 * rejection so request errors can be classified deterministically instead of
 * parsed from error messages.
 */
public final class PinnedTLSDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let pin: String
    private let onReject: (@Sendable (TransportFailure) -> Void)?
    private let lock = NSLock()
    private var lastRejection: TransportFailure?

    /**
     * @param pin - invite fingerprint (SHA-256 of the leaf DER, lowercase hex).
     * @param onReject - optional observer for pin-gate rejections (fail-closed reporting).
     */
    public init(pin: String, onReject: (@Sendable (TransportFailure) -> Void)? = nil) {
        self.pin = pin
        self.onReject = onReject
    }

    public func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        let verdict: PinVerdict = evaluatePinnedTrust(trust, host: challenge.protectionSpace.host, expectedPin: pin)
        switch verdict {
        case .accepted:
            completionHandler(.useCredential, URLCredential(trust: trust))
        case .mismatch(let actual):
            reject(.certificateChanged(actualFingerprint: actual), completionHandler)
        case .invalidChain(let detail):
            reject(.tlsRejected(detail), completionHandler)
        case .noChain:
            reject(.tlsNoChain, completionHandler)
        }
    }

    /// Pairing endpoints never redirect; a redirect means the wrong origin answered.
    public func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }

    private func reject(
        _ failure: TransportFailure,
        _ completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        lock.lock()
        lastRejection = failure
        lock.unlock()
        onReject?(failure)
        completionHandler(.cancelAuthenticationChallenge, nil)
    }

    /**
     * Classify a request error: pin-gate rejections recorded by this delegate
     * win over generic transport codes; a task cancelled by the pin gate is a
     * TLS failure, while user cancellation stays a network/unknown outcome.
     *
     * @param error - error thrown by the URLSession call.
     * @param cancelledByCaller - whether the caller cancelled the task itself.
     * @returns typed failure; `.network` means the request outcome is unknown.
     */
    public func classify(_ error: Error, cancelledByCaller: Bool) -> TransportFailure {
        lock.lock()
        let rejection = lastRejection
        lock.unlock()
        if let rejection = rejection { return rejection }
        if let urlError = error as? URLError {
            if urlError.code == .cancelled { return cancelledByCaller ? .network("cancelled") : .tlsRejected("connection cancelled") }
            if urlError.code == .timedOut { return .timedOut }
            if urlError.code == .serverCertificateUntrusted { return .tlsRejected(urlError.localizedDescription) }
        }
        return .network(error.localizedDescription)
    }
}
