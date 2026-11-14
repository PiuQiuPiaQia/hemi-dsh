// WKWebView self-signed trust experiment client.
//
// Loads https://127.0.0.1:<port>/main.html in a WKWebView whose navigation
// delegate accepts the server only when the leaf SHA256(DER) equals the pin
// passed as `pin=<hex>` on the command line. Logs every authentication
// challenge, every page-reported subtest result, and exits by itself.

import Cocoa
import CryptoKit
import WebKit

let arguments = Dictionary(uniqueKeysWithValues: CommandLine.arguments.dropFirst().map { argument -> (String, String) in
    let parts = argument.split(separator: "=", maxSplits: 1)
    return parts.isEmpty ? ("", "") : (String(parts[0]), parts.count > 1 ? String(parts[1]) : "")
})
setvbuf(stdout, nil, _IOLBF, 4096)

let origin = arguments["origin"] ?? "https://127.0.0.1:8443"
var pin = arguments["pin"] ?? ""
if arguments["mode"] == "wrongpin", !pin.isEmpty {
    // Flip the first nibble so the pin cannot match: fail-closed negative control.
    let first = pin.first!
    pin.replaceSubrange(pin.startIndex...pin.startIndex, with: String(first == "0" ? "1" : "0"))
}
if pin.isEmpty {
    FileHandle.standardError.write("usage: pin=<sha256 hex> [origin=…] [mode=wrongpin]\n".data(using: .utf8)!)
    exit(2)
}

final class ExperimentController: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var web: WKWebView!
    var challenges = 0
    var results: [(String, Bool, String)] = []
    var done = false
    var watchdog: Timer?
    let finishLock = NSLock()
    let runMode = arguments["mode"] ?? "pin"

    func applicationDidFinishLaunching(_ notification: Notification) {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, contentWorld: .page, name: "tls")
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 460, height: 700), configuration: configuration)
        web.navigationDelegate = self
        window = NSWindow(
            contentRect: NSRect(x: 200, y: 200, width: 460, height: 700),
            styleMask: [.titled, .closable], backing: .buffered, defer: false
        )
        window.title = "WK TLS trust experiment (\(runMode))"
        window.contentView = web
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        print("CLIENT mode=\(runMode) origin=\(origin) pin=\(pin.prefix(12))…", terminator: "")
        print("")  // keep log lines clean if stdout is line-buffered oddly
        watchdog = Timer.scheduledTimer(withTimeInterval: 90, repeats: false) { [weak self] _ in
            self?.finish(summaryOverride: "watchdog-timeout")
        }
        web.load(URLRequest(url: URL(string: origin + "/main.html")!))
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        print("COMMIT url=\(webView.url?.absoluteString ?? "-")")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        print("FINISH url=\(webView.url?.absoluteString ?? "-")")
        Timer.scheduledTimer(withTimeInterval: 4, repeats: false) { [weak self] _ in
            guard let self = self else { return }
            self.web.evaluateJavaScript(
                "'exec=' + (window.__NAVIGATION_OK === true) + ' subtest=' + (window.__REACHED_SUBTEST || 'undef') + ' results=' + (window.RESULTS ? window.RESULTS.length : -1) + ' loglen=' + (document.getElementById('log') ? document.getElementById('log').textContent.length : -1) + ' ready=' + document.readyState + ' log=' + (document.getElementById('log') ? document.getElementById('log').textContent.slice(0, 400) : '-')"
            ) { value, error in
                print("PROBE \(value ?? "nil") error=\(error.map(String.init(describing:)) ?? "-")")
            }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        print("NAVFAIL \(error.localizedDescription) code=\((error as NSError).code)")
        finish(summaryOverride: "navigation-failed")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        print("NAVFAIL-provisional \(error.localizedDescription) code=\((error as NSError).code)")
        finish(summaryOverride: "provisional-navigation-failed")
    }

    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let method = challenge.protectionSpace.authenticationMethod
        let host = challenge.protectionSpace.host
        guard method == NSURLAuthenticationMethodServerTrust, let trust = challenge.protectionSpace.serverTrust else {
            challenges += 1
            print("CHALLENGE #\(challenges) host=\(host) method=\(method) -> default")
            completionHandler(.performDefaultHandling, nil)
            return
        }
        challenges += 1
        print("CHALLENGE #\(challenges) host=\(host) method=serverTrust")
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first else {
            print("PIN no-chain")
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        let fingerprint = SHA256.hash(data: SecCertificateCopyData(leaf) as Data).map { String(format: "%02x", $0) }.joined()
        guard fingerprint == pin else {
            print("PIN mismatch got=\(fingerprint.prefix(16))… want=\(pin.prefix(16))… -> cancel")
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString))
        SecTrustSetAnchorCertificates(trust, [leaf] as CFArray)
        SecTrustSetAnchorCertificatesOnly(trust, true)
        SecTrustSetNetworkFetchAllowed(trust, false)
        var error: CFError?
        guard SecTrustEvaluateWithError(trust, &error) else {
            print("EVAL error=\(error.map(String.init(describing:)) ?? "unknown") -> cancel")
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        print("PIN accepted host=\(host) -> useCredential")
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    // MARK: WKScriptMessageHandler

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let text = message.body as? String else { return }
        if text.hasPrefix("@@DONE@@") {
            print("PAGEDONE \(text.dropFirst("@@DONE@@ ".count))")
            finish(summaryOverride: nil)
            return
        }
        print("RESULT \(text)")
        if let data = text.data(using: .utf8),
           let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let test = value["test"] as? String {
            results.append((test, value["ok"] as? Bool ?? false, value["detail"] as? String ?? ""))
        }
    }

    func finish(summaryOverride: String?) {
        finishLock.lock()
        let already = done
        done = true
        finishLock.unlock()
        guard !already else { return }
        watchdog?.invalidate()
        let failed = results.filter { !$0.1 }.map { $0.0 }
        print("SUMMARY mode=\(runMode) challenges=\(challenges) tests=\(results.count) failed=\(failed) override=\(summaryOverride ?? "-")")
        exit(0)
    }
}

let app = NSApplication.shared
let controller = ExperimentController()
app.delegate = controller
app.setActivationPolicy(.regular)
app.run()
