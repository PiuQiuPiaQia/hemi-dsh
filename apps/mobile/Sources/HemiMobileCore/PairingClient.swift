/** Native pairing client for `kind: hemi-dsh-mobile`, `version: 1` invitations. */

import Foundation

/** Server answer to a pair request: displayed before approval. */
public struct PairPending: Equatable, Sendable {
    public let requestId: UUID
    public let verificationCode: String
    public let expiresAt: Double
    public let serverName: String
}

/** Server answer to a status poll. */
public enum PairStatus: Equatable, Sendable {
    case pending(verificationCode: String?, expiresAt: Double?, serverName: String)
    case approved(deviceId: UUID, serverName: String)
    case rejected(serverName: String)
    case expired
}

/** Facts returned by `GET /mobile/session`, including the cookie to install. */
public struct SessionFacts: Equatable, Sendable {
    public let deviceId: UUID
    public let serverName: String
    /** Raw value of the `__Host-hemi-mobile` cookie (`<id>.<secret>`), or nil when the host set none. */
    public let cookieValue: String?
}

/** Typed pairing failure; the connect screen localizes the display text from the discriminant. */
public enum PairingFailure: Error, Equatable, Sendable {
    /** 403: invitation refused or unknown request; indistinguishable by design. */
    case refused
    /** 401: the stored session was revoked; re-pairing requires a new invitation. */
    case unauthorized
    /** 404: wrong server or path. */
    case notFound
    /** 429: back off and retry the same poll later. */
    case rateLimited
    /** 2xx response that violated the protocol. */
    case badResponse(String)
    /** Client-side precondition violated (never sent). */
    case invalid(String)
    /** Transport failed; the request outcome is unknown. */
    case network(String)
    /** The request budget expired without an answer; the outcome is unknown. */
    case timedOut
    /** No probed origin answered the credential-free reachability proof. */
    case unreachable
    /** Pin gate rejected the connection. */
    case certificateChanged(String)
    case tlsRejected(String)
    case tlsNoChain

    public static func from(_ transport: TransportFailure) -> PairingFailure {
        switch transport {
        case .certificateChanged(let actual): return .certificateChanged(actual)
        case .tlsRejected(let detail): return .tlsRejected(detail)
        case .tlsNoChain: return .tlsNoChain
        case .network(let detail): return .network(detail)
        case .timedOut: return .timedOut
        }
    }
}

/**
 * One-shot protocol calls over a pinned URLSession. Polling cadence, retry,
 * and UI state live in the caller: this type never repeats a request on its
 * own, so unknown outcomes stay visible to the owner.
 */
public final class PairingClient: @unchecked Sendable {
    /**
     * Hard budget for one protocol request, connection plus response body, in
     * seconds. Wire-adjacent fixed bound, not configuration: it keeps a
     * dropped-packet address from holding the flow open for the system default
     * minute, and matches the pair POST's existing budget.
     */
    public static let requestBudget: TimeInterval = 15

    private let session: URLSession
    private let pinDelegate: PinnedTLSDelegate
    /**
     * Owned copy of the injected configuration, retained so origin probes
     * inherit the same (possibly mocked) transport. The request budget lives
     * on this copy: a caller-shared configuration object is never mutated.
     * Internal so tests can assert the bounds.
     */
    let configuration: URLSessionConfiguration

    /**
     * @param fingerprint - invite fingerprint pinned for every request.
     * @param configuration - session configuration; tests inject a mock protocol.
     * @param onReject - observer for pin-gate rejections.
     */
    public init(
        fingerprint: String,
        configuration: URLSessionConfiguration = .ephemeral,
        onReject: (@Sendable (TransportFailure) -> Void)? = nil
    ) {
        self.pinDelegate = PinnedTLSDelegate(pin: fingerprint, onReject: onReject)
        // Copy before touching timeouts: the injected object may be shared.
        let owned = configuration.copy() as! URLSessionConfiguration
        // Never wait indefinitely for a "suitable" network path: an unreachable
        // address must hit the budget, not park below it.
        owned.waitsForConnectivity = false
        owned.timeoutIntervalForResource = Self.requestBudget
        self.configuration = owned
        self.session = URLSession(configuration: owned, delegate: pinDelegate, delegateQueue: nil)
    }

    /**
     * `POST /mobile/pair`: ask the host to approve this device.
     * @param invite - parsed invitation.
     * @param deviceName - 1...64 characters, shown on the host approval prompt.
     * @param requestId - client-generated request identity.
     * @param secret - client-generated base64url 32-byte session secret.
     * @returns the pending answer carrying the six-digit verification code.
     */
    public func requestPair(
        invite: MobileInvitation,
        deviceName: String,
        requestId: UUID,
        secret: String
    ) async throws -> PairPending {
        guard (1...64).contains(deviceName.count) else { throw PairingFailure.invalid("deviceName length") }
        let body: [String: Any] = [
            "version": MobileProtocol.version,
            "invitationToken": invite.token,
            "requestId": requestId.uuidString.lowercased(),
            "deviceName": deviceName,
            "secret": secret,
        ]
        let value = try await post(MobileProtocol.pairPath, body: body, invite: invite)
        guard let requestIdText = value["requestId"] as? String, requestIdText == requestId.uuidString.lowercased(),
              let code = value["verificationCode"] as? String,
              code.range(of: "^[0-9]{6}$", options: .regularExpression) != nil,
              value["status"] as? String == "pending",
              let expiresAt = value["expiresAt"] as? Double,
              let serverName = value["serverName"] as? String else {
            throw PairingFailure.badResponse("pair payload")
        }
        return PairPending(requestId: requestId, verificationCode: code, expiresAt: expiresAt, serverName: serverName)
    }

    /**
     * `POST /mobile/pair/status`: read the request outcome. Idempotent.
     * @returns `.approved` once the host approved, or the pending/terminal state.
     */
    public func pollStatus(invite: MobileInvitation, requestId: UUID, secret: String) async throws -> PairStatus {
        let body: [String: Any] = [
            "requestId": requestId.uuidString.lowercased(),
            "secret": secret,
        ]
        let value = try await post(MobileProtocol.pairStatusPath, body: body, invite: invite)
        guard let status = value["status"] as? String else { throw PairingFailure.badResponse("status payload") }
        let serverName = value["serverName"] as? String ?? ""
        switch status {
        case "pending":
            return .pending(
                verificationCode: value["verificationCode"] as? String,
                expiresAt: value["expiresAt"] as? Double,
                serverName: serverName
            )
        case "approved":
            guard let deviceId = (value["deviceId"] as? String).flatMap(UUID.init(uuidString:)) else {
                throw PairingFailure.badResponse("approved without deviceId")
            }
            return .approved(deviceId: deviceId, serverName: serverName)
        case "rejected":
            return .rejected(serverName: serverName)
        case "expired":
            return .expired
        default:
            throw PairingFailure.badResponse("status \(status)")
        }
    }

    /**
     * `GET /mobile/session` with the stored bearer: exchange it for the page
     * cookie and confirm the session identity.
     *
     * One bounded attempt: the request carries {@link requestBudget}, and a
     * caller cancellation surfaces as `CancellationError` — never a retry, a
     * credential write, or any other request.
     *
     * @param secret - stored session credentials.
     * @returns session facts plus the raw `__Host-hemi-mobile` cookie value.
     */
    public func openSession(_ secret: SessionSecret) async throws -> SessionFacts {
        guard let origin = secret.parsedOrigin else { throw PairingFailure.invalid("stored origin") }
        var request = URLRequest(url: origin.appendingPathComponent(MobileProtocol.sessionPath))
        request.httpMethod = "GET"
        request.timeoutInterval = Self.requestBudget
        request.setValue("Bearer \(secret.bearerValue)", forHTTPHeaderField: "Authorization")
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            if Task.isCancelled { throw CancellationError() }
            throw PairingFailure.from(pinDelegate.classify(error, cancelledByCaller: false))
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        try PairingClient.checkStatus(status, body: data, path: MobileProtocol.sessionPath)
        guard let value = decode(data),
              value["version"] as? Int == MobileProtocol.version,
              let deviceId = (value["deviceId"] as? String).flatMap(UUID.init(uuidString:)),
              deviceId == secret.deviceId,
              let serverName = value["serverName"] as? String else {
            throw PairingFailure.badResponse("session payload")
        }
        let cookie = PairingClient.cookieValue(from: response, name: MobileProtocol.cookieName)
        return SessionFacts(deviceId: deviceId, serverName: serverName, cookieValue: cookie)
    }

    /**
     * Choose the reachable origin of a multi-candidate invitation.
     *
     * Single-address invitations (`origins` nil or one candidate) return
     * unchanged without touching the network. Otherwise every candidate answers
     * one credential-free `GET /mobile/session` on its own ephemeral pinned
     * session (see `OriginResolver`); only `401 {"error":"unauthorized"}`
     * proves the invitation's host. The returned invitation keeps the whole
     * candidate list with the chosen origin as `origin` and moved to the front
     * of `origins`; call sites authorize only `origin` and later protocol calls
     * (`requestPair`, `pollStatus`) stay one-shot against that single address.
     *
     * @param invite - parsed invitation.
     * @returns the invitation narrowed to the chosen origin.
     * @throws CancellationError when the caller cancels;
     *   PairingFailure.unreachable when no candidate answered the probe.
     */
    public func resolveInvitation(_ invite: MobileInvitation) async throws -> MobileInvitation {
        guard let candidates = invite.origins, candidates.count > 1 else { return invite }
        let chosen = try await OriginResolver.resolve(
            candidates: candidates,
            fingerprint: invite.fingerprint,
            protocolClasses: configuration.protocolClasses
        )
        return invite.narrowingOrigin(to: chosen)
    }

    /**
     * Choose the reachable origin of a stored session before opening it, using
     * the same credential-free probes and the session's own pin.
     *
     * Every probeable candidate — the parsed `candidateOrigins`, or, when the
     * field is nil or holds nothing that still parses under the invitation
     * rules, the stored `origin` parsed under the same rules — answers one
     * credential-free probe first, so recovery of a stale address learns it is
     * gone in seconds instead of holding the credentialed `openSession` open
     * for the full budget. A session with no probeable candidate (its origin
     * is not a candidate-rules address, for example a LAN hostname) returns
     * unchanged and falls through to the bounded `openSession`. Resolution
     * only confirms or reorders known addresses: it never changes the pin, the
     * secrets, or adds addresses, and a session without the `candidateOrigins`
     * field keeps that legacy storage form.
     *
     * @param saved - persisted session credentials.
     * @returns the session with `origin` set to the chosen candidate and,
     *   when the field existed, `candidateOrigins` reordered chosen first;
     *   secrets are untouched.
     * @throws CancellationError when the caller cancels;
     *   PairingFailure.unreachable when no candidate answered the probe.
     */
    public func resolveSession(_ saved: SessionSecret) async throws -> SessionSecret {
        var candidates = (saved.candidateOrigins ?? []).compactMap { parseOriginCandidateURL($0) }
        if candidates.isEmpty { candidates = [saved.origin].compactMap { parseOriginCandidateURL($0) } }
        guard !candidates.isEmpty else { return saved }
        let chosen = try await OriginResolver.resolve(
            candidates: candidates,
            fingerprint: saved.fingerprint,
            protocolClasses: configuration.protocolClasses
        )
        let key = originAuthority(chosen)
        let rest = candidates.filter { originAuthority($0) != key }
        let chosenText = canonicalOriginString(chosen)
        return SessionSecret(
            origin: chosenText,
            fingerprint: saved.fingerprint,
            deviceId: saved.deviceId,
            secret: saved.secret,
            serverName: saved.serverName,
            createdAt: saved.createdAt,
            candidateOrigins: saved.candidateOrigins.map { _ in [chosenText] + rest.map(canonicalOriginString) }
        )
    }

    // MARK: - Internals

    private func post(_ path: String, body: [String: Any], invite: MobileInvitation) async throws -> [String: Any] {
        let payload = try JSONSerialization.data(withJSONObject: body)
        var request = URLRequest(url: invite.origin.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = payload
        request.timeoutInterval = Self.requestBudget
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            if Task.isCancelled { throw CancellationError() }
            // System error identities only; never log invitation, headers, or credential bytes.
            let failure = error as NSError
            var line = "HemiPair transport path=\(path) domain=\(failure.domain) code=\(failure.code) cancelled=\(Task.isCancelled)"
            if let underlying = failure.userInfo[NSUnderlyingErrorKey] as? NSError {
                line += " underlyingDomain=\(underlying.domain) underlyingCode=\(underlying.code)"
            }
            if let route = failure.userInfo["_NSURLErrorNWPathKey"] as? String {
                line += " networkPath=\(route.prefix(180))"
            }
            FileHandle.standardError.write(Data((line + "\n").utf8))
            throw PairingFailure.from(pinDelegate.classify(error, cancelledByCaller: false))
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if !(200..<300).contains(status) { NSLog("HemiPair response path=%@ status=%ld", path, status) }
        try PairingClient.checkStatus(status, body: data, path: path)
        guard let value = decode(data) else { throw PairingFailure.badResponse("\(path) payload") }
        return value
    }

    private func decode(_ data: Data) -> [String: Any]? {
        (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    /// Map HTTP status to typed failures; success passes through.
    static func checkStatus(_ status: Int, body data: Data, path: String) throws {
        switch status {
        case 200..<300: return
        case 401: throw PairingFailure.unauthorized
        case 403: throw PairingFailure.refused
        case 404: throw PairingFailure.notFound
        case 429: throw PairingFailure.rateLimited
        default:
            let text = String(data: data.prefix(200), encoding: .utf8) ?? ""
            throw PairingFailure.network("HTTP \(status) at \(path) \(text)")
        }
    }

    /// Extract one cookie value from a response's `Set-Cookie` headers.
    static func cookieValue(from response: URLResponse, name: String) -> String? {
        guard let http = response as? HTTPURLResponse else { return nil }
        let headers = http.allHeaderFields
        let candidates: [String] = headers.compactMap { key, value in
            guard let keyText = key as? String, keyText.lowercased() == "set-cookie" else { return nil }
            return value as? String
        }
        for line in candidates {
            let parts = line.split(separator: ";", maxSplits: 1, omittingEmptySubsequences: false)
            guard let first = parts.first else { continue }
            let pair = first.split(separator: "=", maxSplits: 1)
            guard pair.count == 2, pair[0].trimmingCharacters(in: .whitespaces) == name else { continue }
            return String(pair[1])
        }
        return nil
    }
}
