/** Shared value types for the mobile pairing protocol (kind `hemi-dsh-mobile`, version 1). */

import Foundation

/** Stable protocol constants; wire values, not configuration. */
public enum MobileProtocol {
    public static let inviteKind = "hemi-dsh-mobile"
    public static let version = 1
    /** Longest invitation lifetime accepted from a QR/manual paste, in milliseconds. */
    public static let maxInviteWindowMs: Double = 24 * 60 * 60 * 1000
    public static let pairPath = "/mobile/pair"
    public static let pairStatusPath = "/mobile/pair/status"
    public static let sessionPath = "/mobile/session"
    public static let cookieName = "__Host-hemi-mobile"
    /** Upper bound on `origins` entries accepted in one invitation. */
    public static let maxCandidateOrigins = 32
}

/** A parsed invitation: everything needed to request pairing. */
public struct MobileInvitation: Equatable, Sendable {
    public let origin: URL
    /**
     * All origins the host advertised in the `origins` wire field, deduplicated
     * in wire order with `origin` first; nil keeps the single-address format.
     * Callers must not assume `origin == origins?.first` after resolution.
     */
    public let origins: [URL]?
    public let fingerprint: String
    public let token: String
    public let expiresAt: Double

    /**
     * @param origin - primary origin of the host.
     * @param origins - parsed `origins` field; nil for single-address invitations.
     */
    public init(origin: URL, fingerprint: String, token: String, expiresAt: Double, origins: [URL]? = nil) {
        self.origin = origin
        self.origins = origins
        self.fingerprint = fingerprint
        self.token = token
        self.expiresAt = expiresAt
    }

    /** Effective host of {@link origin} without IPv6 brackets. */
    public var host: String { origin.host ?? "" }
    /** Effective port of {@link origin}. */
    public var port: Int { origin.port ?? 443 }
    /** Origin string as printed on the wire, without a trailing slash. */
    public var originString: String { canonicalOriginString(origin) }

    /** Copy narrowed to `chosen`: it becomes `origin` and moves to the front of `origins`; no candidate is dropped. */
    func narrowingOrigin(to chosen: URL) -> MobileInvitation {
        let key = originAuthority(chosen)
        let rest = (origins ?? []).filter { originAuthority($0) != key }
        return MobileInvitation(
            origin: chosen, fingerprint: fingerprint, token: token, expiresAt: expiresAt, origins: [chosen] + rest
        )
    }
}

/** Typed invitation rejection with a stable discriminant; UI localizes the text. */
public enum InviteInvalid: Error, Equatable, Sendable {
    case tooLong
    case notJson
    case wrongKind
    case wrongVersion
    case badOrigin
    case badFingerprint
    case badToken
    case expired
    case expiresTooFar
}

/**
 * Parse and validate a pairing invitation payload.
 *
 * Accepted input: JSON object `{kind, version, origin, origins?, fingerprint,
 * token, expiresAt}` with `kind == "hemi-dsh-mobile"`, `version == 1`, an
 * `https` origin without userinfo, path, query, or fragment, a 64-character
 * lowercase hex SHA-256 of the server leaf certificate DER, a base64url
 * 32-byte invitation token, and an expiry in the future but within the
 * accepted window. The optional `origins` array adds more origins of the same
 * host under the candidate rules of `parseOriginCandidateList`; when it is
 * absent the invitation keeps the legacy single-address form.
 *
 * @param text - scanned or pasted payload, at most 4096 bytes.
 * @param now - clock injection for expiry checks.
 * @returns the parsed invitation.
 * @throws InviteInvalid naming the first violated field.
 */
public func parseInvitation(_ text: String, now: Date = Date()) -> Result<MobileInvitation, InviteInvalid> {
    guard text.utf8.count <= 4096 else { return .failure(.tooLong) }
    guard let data = text.data(using: .utf8),
          let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
        return .failure(.notJson)
    }
    guard value["kind"] as? String == MobileProtocol.inviteKind else { return .failure(.wrongKind) }
    guard value["version"] as? Int == MobileProtocol.version else { return .failure(.wrongVersion) }
    guard let originText = value["origin"] as? String, let origin = URL(string: originText) else {
        return .failure(.badOrigin)
    }
    guard origin.scheme == "https", origin.host != nil, origin.user == nil, origin.password == nil,
          origin.query == nil, origin.fragment == nil, origin.path.isEmpty || origin.path == "/" else {
        return .failure(.badOrigin)
    }
    guard let fingerprint = value["fingerprint"] as? String,
          fingerprint.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else {
        return .failure(.badFingerprint)
    }
    guard let token = value["token"] as? String,
          token.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else {
        return .failure(.badToken)
    }
    guard let expiresAt = value["expiresAt"] as? Double else { return .failure(.expired) }
    let nowMs = now.timeIntervalSince1970 * 1000
    guard expiresAt > nowMs else { return .failure(.expired) }
    guard expiresAt <= nowMs + MobileProtocol.maxInviteWindowMs else { return .failure(.expiresTooFar) }
    var origins: [URL]? = nil
    if value["origins"] != nil {
        guard let list = value["origins"] as? [String], let candidates = parseOriginCandidateList(list, origin: origin) else {
            return .failure(.badOrigin)
        }
        origins = candidates
    }
    return .success(
        MobileInvitation(origin: origin, fingerprint: fingerprint, token: token, expiresAt: expiresAt, origins: origins)
    )
}

/**
 * Validate and normalize the `origins` wire field against the primary origin.
 *
 * Every entry must be an `https` URL to a private (RFC 1918) or link-local
 * (RFC 3927) IPv4 literal without userinfo, path (empty or `/` only), query, or
 * fragment; all entries share one effective port; the first entry must be the
 * same origin as `origin`; the list is bounded and deduplicated in order.
 *
 * @param list - raw `origins` strings from the wire.
 * @param origin - the already-validated primary origin.
 * @returns the deduplicated candidate list, or nil when any rule is violated.
 */
func parseOriginCandidateList(_ list: [String], origin: URL) -> [URL]? {
    guard !list.isEmpty, list.count <= MobileProtocol.maxCandidateOrigins else { return nil }
    let urls = list.compactMap { parseOriginCandidateURL($0) }
    guard urls.count == list.count, let first = urls.first, originAuthority(first) == originAuthority(origin) else {
        return nil
    }
    let port = first.port ?? 443
    guard urls.allSatisfy({ ($0.port ?? 443) == port }) else { return nil }
    var seen = Set<String>()
    var unique: [URL] = []
    for url in urls where seen.insert(originAuthority(url)).inserted {
        unique.append(url)
    }
    return unique
}

/// Parse one `origins` entry under the candidate rules; nil when the entry violates any of them.
func parseOriginCandidateURL(_ text: String) -> URL? {
    guard let url = URL(string: text),
          url.scheme?.lowercased() == "https",
          let host = url.host, isPrivateOrLinkLocalIPv4(host),
          url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
          url.path.isEmpty || url.path == "/" else { return nil }
    return url
}

/** `host:effectivePort` origin identity; candidate schemes are always `https`. */
func originAuthority(_ url: URL) -> String {
    "\(url.host?.lowercased() ?? ""):\(url.port ?? 443)"
}

/// Dotted-quad IPv4 literal in a private (10/8, 172.16/12, 192.168/16) or link-local (169.254/16) range.
func isPrivateOrLinkLocalIPv4(_ host: String) -> Bool {
    let parts = host.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 4 else { return false }
    var octets: [UInt8] = []
    for part in parts {
        guard (1...3).contains(part.count),
              part.allSatisfy({ $0.isASCII && $0.isNumber }),
              let value = Int(part), value <= 255 else { return false }
        if part.count > 1 && part.first == "0" { return false }  // one canonical address form
        octets.append(UInt8(value))
    }
    switch (octets[0], octets[1]) {
    case (10, _), (192, 168), (169, 254): return true
    case (172, let second) where (16...31).contains(second): return true
    default: return false
    }
}

/** `scheme://host[:port]` text for storage and comparison; path, query, and fragment are dropped. */
func canonicalOriginString(_ url: URL) -> String {
    var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
    components?.path = ""
    return components?.url?.absoluteString ?? url.absoluteString
}

/** Credentials persisted in the Keychain after approval. `secret` never enters page JavaScript. */
public struct SessionSecret: Codable, Equatable, Sendable {
    public let origin: String
    /**
     * Origin strings the host advertised at pairing time, chosen origin first
     * after resolution. Stored sessions without the field decode as nil.
     */
    public let candidateOrigins: [String]?
    public let fingerprint: String
    public let deviceId: UUID
    public let secret: String
    public let serverName: String
    public let createdAt: Date

    /**
     * @param origin - origin the session was approved on.
     * @param candidateOrigins - other advertised origins, chosen first; nil for single-origin sessions.
     */
    public init(
        origin: String,
        fingerprint: String,
        deviceId: UUID,
        secret: String,
        serverName: String,
        createdAt: Date,
        candidateOrigins: [String]? = nil
    ) {
        self.origin = origin
        self.fingerprint = fingerprint
        self.deviceId = deviceId
        self.secret = secret
        self.serverName = serverName
        self.createdAt = createdAt
        self.candidateOrigins = candidateOrigins
    }

    public var parsedOrigin: URL? { URL(string: origin) }
    /** `Authorization: Bearer <deviceId>.<secret>` value used by native requests only. */
    public var bearerValue: String { "\(deviceId.uuidString.lowercased()).\(secret)" }
}

/** Random 32-byte secret, base64url encoded without padding (43 characters). */
public enum SessionSecretGenerator {
    /**
     * Generate the device half of the session credential.
     * @returns base64url text suitable for `pair.secret` and the `__Host-hemi-mobile` cookie.
     */
    public static func generate() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        precondition(status == errSecSuccess, "SecRandomCopyBytes failed")
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
