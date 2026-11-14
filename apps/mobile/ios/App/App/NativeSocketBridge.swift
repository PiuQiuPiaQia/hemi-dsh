/**
 * Page-facing half of the transport bridge: forwards page commands to
 * {@link NativeSocketService} and dispatches its events into the page world
 * through `window.__dshNativeSocketDispatch`.
 *
 * Delivery lifetime: an owned `Delivery` controller is checked at execution
 * time on the main queue and retired synchronously by `closeAll()` before the
 * Core service tears down, so events that already left the service (drained
 * there) but still sit on the main queue never reach the page. The WebView is
 * held weakly in the delivery closure.
 *
 * The WebView is only the event sink; all socket state, pinning, and terminal
 * discipline live in the Core service, which is unit-tested against a real
 * pinned TLS server.
 */

import Foundation
import HemiMobileCore
import WebKit

final class NativeSocketBridge {
    /// Delivery fence shared by the Core sink and the main-queue closure.
    private final class Delivery: @unchecked Sendable {
        private let lock = NSLock()
        private var retired = false

        func retire() {
            lock.lock()
            retired = true
            lock.unlock()
        }

        var isRetired: Bool {
            lock.lock()
            defer { lock.unlock() }
            return retired
        }
    }

    private let delivery = Delivery()
    private let service: NativeSocketService

    /**
     * @param policy - paired-origin rules; every open command is checked.
     * @param cookieValue - `__Host-hemi-mobile` cookie value carried as a header.
     * @param fingerprint - invite pin for the socket session.
     * @param webView - page receiving events; weakly held.
     */
    init(policy: OriginPolicy, cookieValue: String, fingerprint: String, webView: WKWebView) {
        let delivery = delivery
        self.service = NativeSocketService(
            policy: policy,
            cookieValue: cookieValue,
            fingerprint: fingerprint
        ) { [weak webView] event in
            let arguments: [Any] = [
                event.socketId,
                event.type,
                event.payload ?? NSNull(),
            ]
            guard let data = try? JSONSerialization.data(withJSONObject: arguments, options: [.sortedKeys]),
                  let encoded = String(data: data, encoding: .utf8) else { return }
            let script = "window.__dshNativeSocketDispatch && window.__dshNativeSocketDispatch.apply(null, \(encoded))"
            DispatchQueue.main.async { [weak webView] in
                // Fence re-checked on the main queue: retire() after this block
                // was enqueued still suppresses the evaluation.
                guard !delivery.isRetired else { return }
                guard let webView = webView, webView.isLoading || webView.url != nil else { return }
                webView.evaluateJavaScript(script, in: nil, in: .page) { _ in }
            }
        }
    }

    /// Handle one `dshSocket` message body (JSON text) from the main frame.
    func handle(commandText: String) {
        service.handle(commandText: commandText)
    }

    /// App backgrounded: close sockets, keep the page.
    func suspendAll() {
        service.suspendAll()
    }

    /// Screen torn down: retire delivery first, then tear down the service.
    /// No queued page event survives this call.
    func closeAll() {
        delivery.retire()
        service.closeAll()
    }
}
