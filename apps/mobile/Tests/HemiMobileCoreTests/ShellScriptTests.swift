/**
 * Shell control script contract tests in JavaScriptCore: the injected
 * `window.__HEMI_MOBILE__` global — frozen shape, injected server name, and
 * the fixed disconnect action — the owned conversation scroll-containment
 * style sheet, plus the native routing guarantees around them.
 */

import JavaScriptCore
import XCTest
@testable import HemiMobileCore

final class ShellScriptTests: XCTestCase {
    private var context: JSContext!
    private var posted: [String] = []

    override func setUp() {
        super.setUp()
        install(serverName: "Studio Mac")
    }

    /** Fresh context with the `dshSocket` shim and one installed shell script. */
    private func install(serverName: String) {
        makeContext()
        context.evaluateScript(shellScript(serverName: serverName))
    }

    /** Fresh context with the WKWebView host shims but no script evaluated. */
    private func makeContext() {
        posted = []
        context = JSContext()
        context.exceptionHandler = { _, exception in
            XCTFail("script threw: \(exception?.toString() ?? "unknown")")
        }
        // Minimal host shims the script expects in WKWebView.
        context.evaluateScript("var window = this;")
        let captured = self
        let postMessage: @convention(block) (String) -> Void = { message in
            captured.posted.append(message)
        }
        context.setObject(postMessage, forKeyedSubscript: "__swiftCapture" as NSString)
        context.evaluateScript(
            """
            var webkit = { messageHandlers: { dshSocket: {
              postMessage: function (m) { __swiftCapture(m); }
            } } };
            """
        )
    }

    /**
     * Minimal DOM shim standing in for the WKWebView document: ready state,
     * one `<head>` recording appended children, and `DOMContentLoaded`
     * listeners fired by `fireDOMContentLoaded()`.
     */
    private func installDocumentShim(readyState: String) {
        context.evaluateScript(
            """
            var document = {
              readyState: '\(readyState)',
              __listeners: [],
              head: { children: [] },
              documentElement: {},
              createElement: function (tag) {
                return {
                  tagName: tag,
                  id: '',
                  attributes: {},
                  textContent: '',
                  setAttribute: function (name, value) { this.attributes[name] = value; }
                };
              },
              getElementById: function (id) {
                for (var i = 0; i < document.head.children.length; i++) {
                  if (document.head.children[i].id === id) return document.head.children[i];
                }
                return null;
              },
              addEventListener: function (type, listener, options) {
                document.__listeners.push({
                  type: type, listener: listener, once: !!(options && options.once)
                });
              },
              fireDOMContentLoaded: function () {
                var pending = document.__listeners;
                document.__listeners = [];
                for (var i = 0; i < pending.length; i++) {
                  if (pending[i].type === 'DOMContentLoaded') pending[i].listener();
                }
              }
            };
            document.head.appendChild = function (el) { document.head.children.push(el); };
            """
        )
    }

    // MARK: - Installed global shape

    func testInstallsFrozenShellWithExactFields() {
        XCTAssertEqual(context.evaluateScript("window.__HEMI_MOBILE__.version").toInt32(), 1)
        XCTAssertEqual(context.evaluateScript("window.__HEMI_MOBILE__.serverName").toString(), "Studio Mac")
        XCTAssertEqual(context.evaluateScript("typeof window.__HEMI_MOBILE__.disconnect").toString(), "function")
        // Exactly version, serverName, disconnect: no origin, secret, or token field.
        XCTAssertEqual(
            context.evaluateScript("Object.keys(window.__HEMI_MOBILE__).sort().join(',')").toString(),
            "disconnect,serverName,version"
        )
        XCTAssertEqual(context.evaluateScript("Object.isFrozen(window.__HEMI_MOBILE__)").toBool(), true)
    }

    func testShellGlobalCannotBeReplacedOrDeleted() {
        context.evaluateScript("window.__HEMI_MOBILE__ = { version: 9 };")
        XCTAssertEqual(context.evaluateScript("window.__HEMI_MOBILE__.version").toInt32(), 1, "defineProperty keeps the shell in place")
        context.evaluateScript("window.__HEMI_MOBILE__.version = 9;")
        XCTAssertEqual(context.evaluateScript("window.__HEMI_MOBILE__.version").toInt32(), 1, "frozen object ignores writes")
        XCTAssertEqual(context.evaluateScript("delete window.__HEMI_MOBILE__").toBool(), false)
    }

    func testDoubleInjectionKeepsFirstInstall() {
        context.evaluateScript(shellScript(serverName: "Other Mac"))
        XCTAssertEqual(context.evaluateScript("window.__HEMI_MOBILE__.serverName").toString(), "Studio Mac")
        XCTAssertEqual(posted.count, 0, "installation posts nothing")
    }

    // MARK: - Disconnect is one fixed action

    func testDisconnectPostsExactlyTheFixedAction() {
        context.evaluateScript("window.__HEMI_MOBILE__.disconnect();")
        XCTAssertEqual(posted, [MobileShellCommand.disconnectPayload])

        context.evaluateScript("window.__HEMI_MOBILE__.disconnect();")
        XCTAssertEqual(posted.count, 2, "exactly one message per call")
        XCTAssertTrue(posted.allSatisfy { $0 == MobileShellCommand.disconnectPayload })

        // The action carries no socket id, url, data, code, or reason.
        guard let data = MobileShellCommand.disconnectPayload.data(using: .utf8),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            XCTFail("disconnect payload must be valid JSON")
            return
        }
        XCTAssertEqual(Array(value.keys), ["op"])
        XCTAssertEqual(value["op"] as? String, "hemiMobileDisconnect")
    }

    func testDisconnectPayloadIsNotASocketCommand() throws {
        // Even if forwarded, the socket service's decoder needs `id` and must
        // drop the shell action instead of mis-handling it.
        let data = try XCTUnwrap(MobileShellCommand.disconnectPayload.data(using: .utf8))
        let decoded = try? JSONDecoder().decode(SocketCommand.self, from: data)
        XCTAssertNil(decoded)
    }

    // MARK: - Server name cannot inject script

    func testHostileServerNameCannotEscapeTheStringLiteral() {
        let hostile = "a'b\"c\\d</script><script>alert(1)</script>\ne\u{2028}f\u{2029}"
        install(serverName: hostile)
        // The script evaluated without throwing (exceptionHandler fails the
        // case), and the name round-trips byte for byte.
        let roundTripped = context.evaluateScript("window.__HEMI_MOBILE__.serverName").toString()
        XCTAssertEqual(roundTripped, hostile)
    }

    // MARK: - No credential material in the injection

    func testShellScriptCarriesNoCredentialOrOriginMaterial() {
        let source = shellScript(serverName: "Studio Mac")
        XCTAssertFalse(source.contains("__Host-hemi-mobile"))
        XCTAssertFalse(source.contains("Bearer"))
        XCTAssertFalse(source.contains("https://"))
        XCTAssertFalse(source.contains("wss://"))
        XCTAssertFalse(source.contains("secret"))
        XCTAssertFalse(source.contains("token"))
    }

    // MARK: - Conversation scroll containment style

    func testScrollStyleSheetIsExactlyTheTwoOwnedRules() {
        XCTAssertEqual(
            MobileShellScrollStyle.css,
            "html,body{overscroll-behavior-y:none!important}\n"
                + "[data-conversation-scroll]{overscroll-behavior-y:none!important}"
        )
    }

    func testScrollPolicyIsPreciseWithoutWildcardOrTouchInterruption() {
        let source = shellScript(serverName: "Studio Mac")
        XCTAssertTrue(source.contains("[data-conversation-scroll]{overscroll-behavior-y:none!important}"))
        XCTAssertTrue(source.contains("html,body{overscroll-behavior-y:none!important}"))
        XCTAssertFalse(source.contains("*{"), "no blanket wildcard selector")
        XCTAssertFalse(source.lowercased().contains("preventdefault"), "no touch or gesture interruption")
        XCTAssertFalse(source.contains("touchmove"))
        XCTAssertFalse(source.contains("touchstart"))
        XCTAssertFalse(source.contains("MutationObserver"), "no page-side observer")
    }

    func testScrollStyleWaitsForDOMContentLoadedThenInstallsOnce() {
        makeContext()
        installDocumentShim(readyState: "loading")
        context.evaluateScript(shellScript(serverName: "Studio Mac"))
        XCTAssertEqual(
            context.evaluateScript("document.head.children.length").toInt32(), 0,
            "the document-start injection cannot append into a head that does not exist yet"
        )
        XCTAssertEqual(context.evaluateScript("document.__listeners.length").toInt32(), 1)
        XCTAssertEqual(context.evaluateScript("document.__listeners[0].type").toString(), "DOMContentLoaded")
        XCTAssertEqual(context.evaluateScript("document.__listeners[0].once").toBool(), true)
        context.evaluateScript("document.fireDOMContentLoaded();")
        XCTAssertEqual(context.evaluateScript("document.head.children.length").toInt32(), 1)
        XCTAssertEqual(context.evaluateScript("document.head.children[0].id").toString(), MobileShellScrollStyle.elementID)
        XCTAssertEqual(
            context.evaluateScript("document.head.children[0].attributes['data-hemi-mobile']").toString(),
            MobileShellScrollStyle.ownerAttributeValue
        )
        XCTAssertEqual(context.evaluateScript("document.head.children[0].textContent").toString(), MobileShellScrollStyle.css)
        // A repeated event and a re-run of the same script add nothing.
        context.evaluateScript("document.fireDOMContentLoaded();")
        context.evaluateScript(shellScript(serverName: "Studio Mac"))
        XCTAssertEqual(context.evaluateScript("document.head.children.length").toInt32(), 1)
    }

    func testScrollStyleInstallsImmediatelyWhenDocumentAlreadyParsed() {
        makeContext()
        installDocumentShim(readyState: "complete")
        context.evaluateScript(shellScript(serverName: "Studio Mac"))
        XCTAssertEqual(context.evaluateScript("document.head.children.length").toInt32(), 1)
        XCTAssertEqual(context.evaluateScript("document.__listeners.length").toInt32(), 0)
    }

    func testDoubleInjectionInstallsOneScrollStyleAndKeepsTheFrozenShell() {
        makeContext()
        installDocumentShim(readyState: "complete")
        context.evaluateScript(shellScript(serverName: "Studio Mac"))
        context.evaluateScript(shellScript(serverName: "Other Mac"))
        XCTAssertEqual(context.evaluateScript("document.head.children.length").toInt32(), 1)
        XCTAssertEqual(
            context.evaluateScript("Object.keys(window.__HEMI_MOBILE__).sort().join(',')").toString(),
            "disconnect,serverName,version"
        )
        XCTAssertEqual(context.evaluateScript("Object.isFrozen(window.__HEMI_MOBILE__)").toBool(), true)
        XCTAssertEqual(posted.count, 0, "installation posts nothing")
    }
}
