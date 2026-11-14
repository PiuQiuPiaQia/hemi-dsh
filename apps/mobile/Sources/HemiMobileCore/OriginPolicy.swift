/**
 * Origin rules for the remote page: which navigations stay in the app, which go
 * to Safari, and which frames may talk to the native bridge.
 */

import Foundation

/**
 * Boundary decisions for the paired host. All comparisons are scheme + host +
 * port; path and query never grant authority.
 */
public struct OriginPolicy: Sendable {
    public let origin: URL

    /** @param origin - the paired origin, e.g. `https://192.168.1.4:4317`. */
    public init(origin: URL) {
        self.origin = origin
    }

    private func sameAuthority(as url: URL) -> Bool {
        guard let base = URLComponents(url: origin, resolvingAgainstBaseURL: false),
              let other = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        return base.scheme == other.scheme
            && base.host == other.host
            && base.port == other.port
    }

    /**
     * Main-frame navigation decision.
     * @returns `allow` for the paired origin, `external` for everything else
     * (the shell opens it in Safari and keeps no in-app copy).
     */
    public func mainFrameDecision(for url: URL) -> MainFrameDecision {
        sameAuthority(as: url) ? .allow : .external
    }

    /** Subframe decision: same-origin frames load; anything else is cancelled. */
    public func subframeAllowed(url: URL) -> Bool {
        sameAuthority(as: url)
    }

    /**
     * May the native bridge serve this frame? Only the main frame of the paired
     * origin; subframes never see the bridge.
     */
    public func bridgeEligible(isMainFrame: Bool, securityOriginScheme: String, securityOriginHost: String, securityOriginPort: Int) -> Bool {
        guard isMainFrame else { return false }
        guard let base = URLComponents(url: origin, resolvingAgainstBaseURL: false) else { return false }
        return base.scheme == securityOriginScheme && base.host == securityOriginHost && (base.port ?? defaultPort) == securityOriginPort
    }

    /**
     * May the native socket bridge open this URL? Only `wss://` to the paired
     * host and port; the path is owned by the Host mount.
     */
    public func websocketAllowed(url: URL) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        guard components.scheme == "wss", let host = components.host else { return false }
        guard let base = URLComponents(url: origin, resolvingAgainstBaseURL: false), let baseHost = base.host else { return false }
        return host == baseHost && (components.port ?? 443) == (base.port ?? defaultPort)
    }

    private var defaultPort: Int { origin.scheme == "https" ? 443 : 80 }

    public enum MainFrameDecision: Equatable, Sendable {
        case allow
        case external
    }
}
