/** Origin boundary rules: main frame, subframes, bridge eligibility, WebSocket scope. */

import XCTest
@testable import HemiMobileCore

final class OriginPolicyTests: XCTestCase {
    let policy = OriginPolicy(origin: URL(string: "https://192.168.1.4:4317")!)

    func testMainFrameAllowsOnlyPairedOrigin() {
        XCTAssertEqual(policy.mainFrameDecision(for: URL(string: "https://192.168.1.4:4317/")!), .allow)
        XCTAssertEqual(policy.mainFrameDecision(for: URL(string: "https://192.168.1.4:4317/plugins/x")!), .allow)
        XCTAssertEqual(policy.mainFrameDecision(for: URL(string: "https://192.168.1.4:4318/")!), .external)
        XCTAssertEqual(policy.mainFrameDecision(for: URL(string: "https://192.168.1.5:4317/")!), .external)
        XCTAssertEqual(policy.mainFrameDecision(for: URL(string: "http://192.168.1.4:4317/")!), .external)
        XCTAssertEqual(policy.mainFrameDecision(for: URL(string: "https://evil.example/")!), .external)
    }

    func testSubframesAllowOnlySameOrigin() {
        XCTAssertTrue(policy.subframeAllowed(url: URL(string: "https://192.168.1.4:4317/frame.html")!))
        XCTAssertFalse(policy.subframeAllowed(url: URL(string: "https://elsewhere.example/frame.html")!))
    }

    func testBridgeEligibleOnlyForMainFrameOfPairedOrigin() {
        XCTAssertTrue(policy.bridgeEligible(
            isMainFrame: true, securityOriginScheme: "https", securityOriginHost: "192.168.1.4", securityOriginPort: 4317
        ))
        XCTAssertFalse(policy.bridgeEligible(
            isMainFrame: false, securityOriginScheme: "https", securityOriginHost: "192.168.1.4", securityOriginPort: 4317
        ))
        XCTAssertFalse(policy.bridgeEligible(
            isMainFrame: true, securityOriginScheme: "https", securityOriginHost: "evil.example", securityOriginPort: 4317
        ))
        XCTAssertFalse(policy.bridgeEligible(
            isMainFrame: true, securityOriginScheme: "https", securityOriginHost: "192.168.1.4", securityOriginPort: 4318
        ))
    }

    func testWebSocketAllowedOnlyForPairedWss() {
        XCTAssertTrue(policy.websocketAllowed(url: URL(string: "wss://192.168.1.4:4317/api/remote.mux")!))
        XCTAssertFalse(policy.websocketAllowed(url: URL(string: "ws://192.168.1.4:4317/api/remote.mux")!))
        XCTAssertFalse(policy.websocketAllowed(url: URL(string: "wss://192.168.1.5:4317/api/remote.mux")!))
        XCTAssertFalse(policy.websocketAllowed(url: URL(string: "wss://192.168.1.4:4318/api/remote.mux")!))
    }
}
