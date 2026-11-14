/**
 * Bridge script contract tests in JavaScriptCore: the injected half of
 * `ConnectionWebSocket` (`packages/client/connection/src/client/socket.ts`)
 * and the `__DSH_TRANSPORT__` hooks shape.
 */

import JavaScriptCore
import XCTest
@testable import HemiMobileCore

final class BridgeScriptTests: XCTestCase {
    private var context: JSContext!
    private var posted: [String] = []

    override func setUp() {
        super.setUp()
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
        context.evaluateScript(
            """
            var __posted = [];
            var webkit = { messageHandlers: { dshSocket: {
              postMessage: function (m) { __posted.push(m); }
            } } };
            """
        )
        // Record posted messages through the JS shim for Swift-side assertions.
        context.setObject(postMessage, forKeyedSubscript: "__swiftCapture" as NSString)
        context.evaluateScript(
            "webkit.messageHandlers.dshSocket.postMessage = function (m) { __swiftCapture(m); __posted.push(m); }"
        )
        context.evaluateScript(bridgeScript(origin: "https://192.168.1.4:4317"))
    }

    private func lastPosted() -> [String: Any] {
        guard let raw = posted.last, let data = raw.data(using: .utf8),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return value
    }

    private func dispatch(_ call: String) {
        context.evaluateScript(call)
    }

    func testInstallsTransportWithStreamBaseUrl() {
        let baseUrl = context.evaluateScript("window.__DSH_TRANSPORT__.streamBaseUrl").toString()
        XCTAssertEqual(baseUrl, "https://192.168.1.4:4317")
        XCTAssertEqual(context.evaluateScript("typeof window.__DSH_TRANSPORT__.createWebSocket").toString(), "function")
    }

    func testSocketLifecycleMatchesConnectionWebSocketContract() {
        dispatch("var s = window.__DSH_TRANSPORT__.createWebSocket('wss://192.168.1.4:4317/api/remote.mux'); s.readyState")
        XCTAssertEqual(context.evaluateScript("s.readyState").toInt32(), 0, "starts CONNECTING")
        XCTAssertEqual(lastPosted()["op"] as? String, "open")
        XCTAssertEqual(lastPosted()["url"] as? String, "wss://192.168.1.4:4317/api/remote.mux")

        dispatch("var seen = []; s.addEventListener('open', function (e) { seen.push(['open', typeof e]); }, { once: true });")
        dispatch("window.__dshNativeSocketDispatch(s._id, 'open', null)")
        XCTAssertEqual(context.evaluateScript("s.readyState").toInt32(), 1, "OPEN after dispatch")

        dispatch("s.send('hello')")
        XCTAssertEqual(lastPosted()["op"] as? String, "send")
        XCTAssertEqual(lastPosted()["data"] as? String, "hello")

        dispatch("var got = []; s.addEventListener('message', function (e) { got.push(e.data); });")
        dispatch("window.__dshNativeSocketDispatch(s._id, 'message', '{\"a\":1}')")
        XCTAssertEqual(context.evaluateScript("got.length").toInt32(), 1)
        XCTAssertEqual(context.evaluateScript("got[0]").toString(), "{\"a\":1}")

        // The once-listener fired once and was removed.
        dispatch("window.__dshNativeSocketDispatch(s._id, 'open', null)")
        XCTAssertEqual(context.evaluateScript("seen.length").toInt32(), 1)

        dispatch("s.close(1000, 'done')")
        XCTAssertEqual(context.evaluateScript("s.readyState").toInt32(), 2, "CLOSING after close()")
        XCTAssertEqual(lastPosted()["op"] as? String, "close")
        XCTAssertEqual(lastPosted()["code"] as? Int, 1000)
        XCTAssertEqual(lastPosted()["reason"] as? String, "done")

        dispatch("var closed = []; s.addEventListener('close', function () { closed.push(1); });")
        dispatch("window.__dshNativeSocketDispatch(s._id, 'close', null)")
        XCTAssertEqual(context.evaluateScript("s.readyState").toInt32(), 3, "CLOSED after close event")
        XCTAssertEqual(context.evaluateScript("closed.length").toInt32(), 1)
    }

    func testSendRejectsNonTextAndClosedSockets() {
        dispatch("var s = window.__DSH_TRANSPORT__.createWebSocket('wss://h/x');")
        dispatch("window.__dshNativeSocketDispatch(s._id, 'open', null)")
        dispatch("var threw = ''; try { s.send({binary: 1}); } catch (e) { threw = e.name; }")
        XCTAssertEqual(context.evaluateScript("threw").toString(), "TypeError")

        dispatch("var s2 = window.__DSH_TRANSPORT__.createWebSocket('wss://h/y');")
        dispatch("var threw2 = ''; try { s2.send('early'); } catch (e) { threw2 = e.name; }")
        XCTAssertEqual(context.evaluateScript("threw2").toString(), "Error", "send before open is rejected")
    }

    func testRemoveEventListenerStopsDelivery() {
        dispatch("var s = window.__DSH_TRANSPORT__.createWebSocket('wss://h/x');")
        dispatch("var calls = []; function listener (e) { calls.push(1); }")
        dispatch("s.addEventListener('message', listener);")
        dispatch("s.removeEventListener('message', listener);")
        dispatch("window.__dshNativeSocketDispatch(s._id, 'open', null)")
        dispatch("window.__dshNativeSocketDispatch(s._id, 'message', 'x')")
        XCTAssertEqual(context.evaluateScript("calls.length").toInt32(), 0)
    }

    func testMessageBeforeOpenIsDropped() {
        dispatch("var s = window.__DSH_TRANSPORT__.createWebSocket('wss://h/x');")
        dispatch("var got = []; s.addEventListener('message', function (e) { got.push(e.data); });")
        dispatch("window.__dshNativeSocketDispatch(s._id, 'message', 'early')")
        XCTAssertEqual(context.evaluateScript("got.length").toInt32(), 0)
    }

    func testDoubleInjectionIsIdempotent() {
        context.evaluateScript(bridgeScript(origin: "https://192.168.1.4:4317"))
        XCTAssertEqual(context.evaluateScript("window.__dshNativeSocketDispatch instanceof Function ? 1 : 0").toInt32(), 1)
        XCTAssertEqual(context.evaluateScript("window.__DSH_TRANSPORT__.streamBaseUrl").toString(), "https://192.168.1.4:4317")
    }

    func testCloseEventObjectHasNoDataField() {
        dispatch("var s = window.__DSH_TRANSPORT__.createWebSocket('wss://h/x');")
        dispatch("var shape = null; s.addEventListener('close', function (e) { shape = Object.keys(e).join(','); });")
        dispatch("window.__dshNativeSocketDispatch(s._id, 'close', null)")
        XCTAssertEqual(context.evaluateScript("shape").toString(), "", "close event carries no fields")
    }

    // MARK: - Lifetime regressions (reconnect cycles, late open, dispatch mutation)

    func testRepeatedOpenCloseCyclesDoNotLeakRegistryEntries() {
        dispatch(
            """
            var counts = [];
            for (var i = 0; i < 5; i++) {
              var s = window.__DSH_TRANSPORT__.createWebSocket('wss://h/x');
              window.__dshNativeSocketDispatch(s._id, 'open', null);
              window.__dshNativeSocketDispatch(s._id, 'close', null);
              counts.push(s.readyState);
            }
            """
        )
        XCTAssertEqual(context.evaluateScript("counts.join(',')").toString(), "3,3,3,3,3", "every socket ends CLOSED")
        XCTAssertEqual(context.evaluateScript("window.__dshNativeSocketCount()").toInt32(), 0, "registry emptied by close")
        // An externally held closed socket still reads CLOSED and dispatch is a no-op.
        dispatch("var held = s; held.readyState")
        XCTAssertEqual(context.evaluateScript("held.readyState").toInt32(), 3)
        dispatch("window.__dshNativeSocketDispatch(held._id, 'open', null)")
        XCTAssertEqual(context.evaluateScript("held.readyState").toInt32(), 3, "no resurrection")
    }

    func testLateOpenCannotReviveClosingOrClosedSocket() {
        // close() called while connecting; late native open arrives afterwards.
        dispatch(
            """
            var s = window.__DSH_TRANSPORT__.createWebSocket('wss://h/x');
            var opened = 0, messaged = 0;
            s.addEventListener('open', function () { opened++; });
            s.addEventListener('message', function () { messaged++; });
            s.close(1000, 'bye');
            window.__dshNativeSocketDispatch(s._id, 'open', null);
            window.__dshNativeSocketDispatch(s._id, 'message', 'late');
            var closingState = s.readyState;
            window.__dshNativeSocketDispatch(s._id, 'close', null);
            """
        )
        XCTAssertEqual(context.evaluateScript("opened").toInt32(), 0, "late open ignored")
        XCTAssertEqual(context.evaluateScript("messaged").toInt32(), 0, "late message ignored")
        XCTAssertEqual(context.evaluateScript("closingState").toInt32(), 2, "still CLOSING before the close event")
        XCTAssertEqual(context.evaluateScript("s.readyState").toInt32(), 3, "CLOSED after the close event")
        XCTAssertEqual(context.evaluateScript("window.__dshNativeSocketCount()").toInt32(), 0)
    }

    func testRemoveDuringDispatchTakesEffect() {
        dispatch(
            """
            var s = window.__DSH_TRANSPORT__.createWebSocket('wss://h/x');
            window.__dshNativeSocketDispatch(s._id, 'open', null);
            var a = 0, b = 0;
            function first () { a++; s.removeEventListener('message', second); }
            function second () { b++; }
            s.addEventListener('message', first);
            s.addEventListener('message', second);
            window.__dshNativeSocketDispatch(s._id, 'message', '1');
            window.__dshNativeSocketDispatch(s._id, 'message', '2');
            """
        )
        XCTAssertEqual(context.evaluateScript("a").toInt32(), 2, "removing listener runs once per event")
        XCTAssertEqual(context.evaluateScript("b").toInt32(), 0, "listener removed during dispatch never fires again")
    }

    func testAddDuringDispatchDoesNotFireSameEvent() {
        dispatch(
            """
            var s = window.__DSH_TRANSPORT__.createWebSocket('wss://h/x');
            window.__dshNativeSocketDispatch(s._id, 'open', null);
            var late = 0;
            function starter () { s.addEventListener('message', function () { late++; }); }
            s.addEventListener('message', starter);
            window.__dshNativeSocketDispatch(s._id, 'message', 'first');
            var afterFirst = late;
            window.__dshNativeSocketDispatch(s._id, 'message', 'second');
            """
        )
        XCTAssertEqual(context.evaluateScript("afterFirst").toInt32(), 0, "listener added during dispatch waits for the next event")
        XCTAssertEqual(context.evaluateScript("late").toInt32(), 1, "and then fires normally")
    }

    func testOnceRemovalSurvivesDispatchAndRegistryCleanup() {
        dispatch(
            """
            var s = window.__DSH_TRANSPORT__.createWebSocket('wss://h/x');
            var calls = 0;
            s.addEventListener('open', function () { calls++; }, { once: true });
            window.__dshNativeSocketDispatch(s._id, 'open', null);
            window.__dshNativeSocketDispatch(s._id, 'open', null);
            s.close();
            window.__dshNativeSocketDispatch(s._id, 'close', null);
            s.addEventListener('close', function () { calls += 100; });
            window.__dshNativeSocketDispatch(s._id, 'close', null);
            """
        )
        XCTAssertEqual(context.evaluateScript("calls").toInt32(), 1, "once fired once; post-close listener cannot register on a released socket")
    }
}
