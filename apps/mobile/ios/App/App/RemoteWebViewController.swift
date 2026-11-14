/**
 * Remote DSH Web UI screen.
 *
 * Loads the paired Host's served web app in a WKWebView behind the same leaf
 * pin used for pairing, exchanges the stored bearer for the HttpOnly
 * `__Host-hemi-mobile` cookie before the first request, and installs the
 * `__DSH_TRANSPORT__` bridge (`createWebSocket` + `streamBaseUrl`) for the
 * main frame only. The secret stays in the Keychain and the HttpOnly cookie;
 * it is never injected into page JavaScript.
 *
 * Lifetime: one owned bootstrap task guarded by a teardown fence — after
 * teardown (back gesture, disconnect, fail-closed, forget) no late bootstrap
 * step can install a cookie, load the page, or touch the UI. Teardown is
 * quiescent: sockets invalidated, message handler and user script removed,
 * loading stopped. The cookie store is `nonPersistent`, so nothing outlives
 * the screen. Background only suspends sockets; the page, its drafts, and
 * scroll position survive, and the in-page ConnectionController owns
 * reconnection through the bridge. Re-pairing is requested only on explicit
 * signals: revoked session (401), pin mismatch, or the user forgetting.
 *
 * Shell chrome: the screen draws no native navigation over the served Web UI.
 * The navigation bar is hidden while the screen is on top and restored for the
 * connect screen; the WebView fills the safe area. The Web settings page owns
 * connection information and disconnect through the frozen
 * `window.__HEMI_MOBILE__` global (`ShellScript.swift`); its `disconnect()`
 * posts one fixed `dshSocket` message that this screen routes to the same
 * `disconnectTapped()` path as the former menu — pairing stays in the
 * Keychain, only the screen closes. While the bootstrap loads or has failed,
 * the overlay carries a back button on that same path, so the screen stays
 * cancellable without the system back gesture; the session exchange runs on a
 * fixed request budget, so a stale or unreachable address ends in a retryable
 * failure instead of an open-ended spinner.
 */

import HemiMobileCore
import UIKit
import WebKit

enum RemoteTeardown {
    /**
     * Clear the stored session and its HttpOnly cookie. Awaits completion so a
     * new pairing cannot race a stale cookie; Keychain failures are surfaced,
     * not swallowed.
     *
     * @param store - cookie store to purge (the screen's isolated store).
     */
    @MainActor static func clearStoredSession(from store: WKWebsiteDataStore? = nil) async throws {
        do {
            try SessionStore.save(nil)
        } catch {
            throw HemiDeviceError.message(L10n.t(.storageFailure))
        }
        let cookieStore = (store ?? WKWebsiteDataStore.default()).httpCookieStore
        let cookies: [HTTPCookie] = await withCheckedContinuation { continuation in
            cookieStore.getAllCookies { cookies in
                continuation.resume(returning: cookies)
            }
        }
        for cookie in cookies where cookie.name == MobileProtocol.cookieName {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                cookieStore.delete(cookie) { continuation.resume() }
            }
        }
    }
}

final class RemoteWebViewController: UIViewController {
    private let session: SessionSecret
    private let policy: OriginPolicy
    private let client: PairingClient
    private var webView: WKWebView!
    private var cookieStore: WKWebsiteDataStore!
    private var messageHandler: BridgeMessageHandler?
    private var socketBridge: NativeSocketBridge?
    private var cookieValue: String?
    private var bootstrapTask: Task<Void, Never>?
    private var loadAttempted = false

    /// Set by teardown; every async continuation re-checks it before touching
    /// the WebView, cookie store, or UI.
    private var tornDown = false

    private let statusLabel = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let retryButton = UIButton(type: .system)
    private let backButton = UIButton(type: .system)
    private let overlay = UIView()

    init(session: SessionSecret) {
        self.session = session
        guard let origin = session.parsedOrigin else {
            fatalError("stored session has no origin")
        }
        self.policy = OriginPolicy(origin: origin)
        self.client = PairingClient(fingerprint: session.fingerprint)
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        Style.applyMonochromeTint(to: view)

        // Isolated, non-persistent store: cookies never outlive this screen
        // and never leak into another paired host's page.
        let store = WKWebsiteDataStore.nonPersistent()
        cookieStore = store
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = store
        configuration.userContentController.addUserScript(
            WKUserScript(
                source: bridgeScript(origin: session.origin),
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
        )
        configuration.userContentController.addUserScript(
            WKUserScript(
                source: shellScript(serverName: session.serverName),
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
        )
        let handler = BridgeMessageHandler(owner: self)
        configuration.userContentController.add(handler, contentWorld: .page, name: "dshSocket")
        messageHandler = handler

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        // The Web app owns its scroll regions; the outer shell must not rubber-band.
        webView.scrollView.bounces = false
        webView.scrollView.alwaysBounceVertical = false
        webView.scrollView.alwaysBounceHorizontal = false
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)

        overlay.isHidden = true
        overlay.backgroundColor = .systemBackground
        overlay.translatesAutoresizingMaskIntoConstraints = false
        spinner.startAnimating()
        statusLabel.text = L10n.t(.loadingSession)
        statusLabel.font = .systemFont(ofSize: 15)
        statusLabel.textColor = .secondaryLabel
        statusLabel.numberOfLines = 0
        statusLabel.textAlignment = .center
        retryButton.setTitle(L10n.t(.retry), for: .normal)
        retryButton.tintColor = Style.ink
        retryButton.layer.borderWidth = 1
        retryButton.layer.borderColor = UIColor.separator.cgColor
        retryButton.layer.cornerRadius = 8
        retryButton.addTarget(self, action: #selector(retryTapped), for: .touchUpInside)
        retryButton.heightAnchor.constraint(equalToConstant: 44).isActive = true
        retryButton.isHidden = true
        // The overlay is the screen's own exit while the bootstrap loads or has
        // failed: the system back gesture is never the only way out.
        backButton.setTitle(L10n.t(.back), for: .normal)
        backButton.tintColor = Style.ink
        backButton.layer.borderWidth = 1
        backButton.layer.borderColor = UIColor.separator.cgColor
        backButton.layer.cornerRadius = 8
        backButton.addTarget(self, action: #selector(disconnectTapped), for: .touchUpInside)
        backButton.heightAnchor.constraint(equalToConstant: 44).isActive = true
        let column = UIStackView(arrangedSubviews: [spinner, statusLabel, retryButton, backButton])
        column.axis = .vertical
        column.spacing = 12
        column.alignment = .center
        column.translatesAutoresizingMaskIntoConstraints = false
        overlay.addSubview(column)
        view.addSubview(overlay)

        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            overlay.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            overlay.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            overlay.topAnchor.constraint(equalTo: view.topAnchor),
            overlay.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            column.leadingAnchor.constraint(equalTo: overlay.leadingAnchor, constant: 24),
            column.trailingAnchor.constraint(equalTo: overlay.trailingAnchor, constant: -24),
            column.centerYAnchor.constraint(equalTo: overlay.centerYAnchor),
        ])

        start()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // The served Web UI owns its chrome; the shell draws no bar over it.
        navigationController?.setNavigationBarHidden(true, animated: animated)
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        // Every disappearance ends at the connect screen; hand the bar back.
        navigationController?.setNavigationBarHidden(false, animated: animated)
        // Back gesture or programmatic pop: the screen must not linger with a
        // hidden WebView and live sockets while the coordinator holds it.
        if isMovingFromParent, !tornDown {
            quiescentTeardown()
            coordinator?.remoteDidClose(self)
        }
    }

    // MARK: - Session bootstrap

    private func start() {
        bootstrapTask?.cancel()
        showOverlay(status: L10n.t(.loadingSession), retryable: false)
        bootstrapTask = Task { [weak self] in
            guard let self else { return }
            do {
                let facts = try await self.client.openSession(self.session)
                guard !self.tornDown, !Task.isCancelled else { return }
                self.cookieValue = facts.cookieValue ?? self.session.bearerValue
                await self.installCookie()
                guard !self.tornDown, !Task.isCancelled else { return }
                self.loadPage()
            } catch {
                guard !self.tornDown, !Task.isCancelled else { return }
                self.handleStartFailure(error)
            }
        }
    }

    private func installCookie() async {
        guard let origin = session.parsedOrigin, let host = origin.host, let cookieValue else { return }
        let cookie = HTTPCookie(properties: [
            .name: MobileProtocol.cookieName,
            .value: cookieValue,
            .domain: host,
            .path: "/",
            .secure: "TRUE",
            HTTPCookiePropertyKey("HttpOnly"): "TRUE",
            .sameSitePolicy: "Strict",
        ])
        guard let cookie else { return }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            cookieStore.httpCookieStore.setCookie(cookie) {
                continuation.resume()
            }
        }
    }

    private func loadPage() {
        guard let origin = session.parsedOrigin, !tornDown else { return }
        loadAttempted = true
        webView.load(URLRequest(url: origin))
    }

    private func handleStartFailure(_ error: Error) {
        loadAttempted = false
        guard let failure = error as? PairingFailure else {
            showOverlay(status: ConnectFlowViewController.describe(error), retryable: true)
            return
        }
        switch failure {
        case .unauthorized, .certificateChanged:
            // Revoked or certificate replaced: forget the pairing and ask for a
            // new invitation; nothing is retried automatically.
            failClosed(failure == .unauthorized ? L10n.t(.revokedMessage) : L10n.t(.certChanged))
        default:
            // Unknown outcome: visible, retried only by an explicit user action.
            showOverlay(status: ConnectFlowViewController.describe(error), retryable: true)
        }
    }

    /// Fail-closed path: clear pairing state to quiescence, then explain and
    /// return to the connect screen. Keychain failures surface instead of
    /// silently claiming the pairing was forgotten.
    private func failClosed(_ message: String) {
        bootstrapTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await RemoteTeardown.clearStoredSession(from: self.cookieStore)
            } catch {
                self.showOverlay(status: L10n.t(.storageFailure), retryable: false)
                return
            }
            guard !self.tornDown else { return }
            self.closeWithMessage(message)
        }
    }

    private func showOverlay(status: String, retryable: Bool) {
        guard !tornDown else { return }
        statusLabel.text = status
        retryButton.isHidden = !retryable
        // A settled failure never leaves a spinner running: the budget ended
        // the wait, so the screen shows text plus the retry/back actions.
        if retryable { spinner.stopAnimating() } else { spinner.startAnimating() }
        overlay.isHidden = false
    }

    private func hideOverlay() {
        overlay.isHidden = true
    }

    private func closeWithMessage(_ message: String) {
        quiescentTeardown()
        coordinator?.remoteDidClose(self, message: message)
    }

    @objc private func retryTapped() {
        guard !tornDown else { return }
        start()
    }

    /// Close the remote screen quiescently, keeping the stored pairing.
    /// Reached from the Web settings page through `__HEMI_MOBILE__.disconnect()`,
    /// from the back gesture via `viewWillDisappear`, and from the overlay's
    /// back button while the bootstrap loads or after it failed.
    @objc private func disconnectTapped() {
        // Keep the pairing; return to the connect screen quiescently.
        quiescentTeardown()
        coordinator?.remoteDidClose(self)
    }

    // MARK: - Bridge scope

    fileprivate func handleSocketMessage(_ text: String, frameInfo: WKFrameInfo) {
        guard !tornDown else { return }
        guard policy.bridgeEligible(
            isMainFrame: frameInfo.isMainFrame,
            securityOriginScheme: frameInfo.securityOrigin.protocol,
            securityOriginHost: frameInfo.securityOrigin.host,
            securityOriginPort: frameInfo.securityOrigin.port
        ) else {
            // Subframes and foreign origins never reach the native bridge.
            return
        }
        // Shell commands route here, not into the socket service: disconnect
        // stays a fixed action reachable only from the eligible main frame.
        if text == MobileShellCommand.disconnectPayload {
            disconnectTapped()
            return
        }
        ensureBridge()
        socketBridge?.handle(commandText: text)
    }

    private func ensureBridge() {
        guard socketBridge == nil, let cookieValue, let webView else { return }
        socketBridge = NativeSocketBridge(
            policy: policy,
            cookieValue: cookieValue,
            fingerprint: session.fingerprint,
            webView: webView
        )
    }

    // MARK: - Teardown and lifecycle

    /// One quiescent teardown: bootstrap cancelled, sockets invalidated, page
    /// loading stopped, message handler and user scripts removed. Idempotent.
    private func quiescentTeardown() {
        guard !tornDown else { return }
        tornDown = true
        bootstrapTask?.cancel()
        bootstrapTask = nil
        socketBridge?.closeAll()
        socketBridge = nil
        if let webView {
            webView.stopLoading()
            let controller = webView.configuration.userContentController
            if messageHandler != nil {
                controller.removeScriptMessageHandler(forName: "dshSocket")
            }
            controller.removeAllUserScripts()
        }
        messageHandler = nil
        hideOverlay()
    }

    func bridgeDidEnterBackground() {
        // Keep the page, its drafts, and scroll position; only sockets close.
        // The page reconnects through the bridge when it becomes active.
        socketBridge?.suspendAll()
    }

    func bridgeDidBecomeActive() {
        // Nothing to do: reconnection is page-owned through createWebSocket.
    }

    private var coordinator: RootCoordinator? {
        (view.window?.windowScene?.delegate as? SceneDelegate)?.coordinator
    }
}

/// WKScriptMessageHandler wrapper that does not retain the web view owner.
private final class BridgeMessageHandler: NSObject, WKScriptMessageHandler {
    weak var owner: RemoteWebViewController?

    init(owner: RemoteWebViewController) {
        self.owner = owner
    }

    func userContentController(
        _ userContentController: WKUserContentController, didReceive message: WKScriptMessage
    ) {
        guard let owner, message.name == "dshSocket", let text = message.body as? String else { return }
        owner.handleSocketMessage(text, frameInfo: message.frameInfo)
    }
}

extension RemoteWebViewController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if navigationAction.targetFrame == nil {
            // New-window targets: never render in-app.
            decisionHandler(.cancel)
            if navigationAction.navigationType == .linkActivated {
                UIApplication.shared.open(url, options: [:], completionHandler: nil)
            }
            return
        }
        if navigationAction.targetFrame?.isMainFrame == true {
            switch policy.mainFrameDecision(for: url) {
            case .allow:
                decisionHandler(.allow)
            case .external:
                // External links open in Safari; the app never renders them.
                decisionHandler(.cancel)
                if navigationAction.navigationType == .linkActivated {
                    UIApplication.shared.open(url, options: [:], completionHandler: nil)
                }
            }
            return
        }
        decisionHandler(policy.subframeAllowed(url: url) ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let status = (navigationResponse.response as? HTTPURLResponse)?.statusCode ?? 200
        if navigationResponse.isForMainFrame, status == 401 || status == 403 {
            decisionHandler(.cancel)
            failClosed(L10n.t(.revokedMessage))
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        guard let origin = session.parsedOrigin, challenge.protectionSpace.host == origin.host else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        switch evaluatePinnedTrust(trust, host: challenge.protectionSpace.host, expectedPin: session.fingerprint) {
        case .accepted:
            completionHandler(.useCredential, URLCredential(trust: trust))
        case .mismatch, .invalidChain, .noChain:
            // Fail closed; the certificate can only be trusted again through a new invitation.
            completionHandler(.cancelAuthenticationChallenge, nil)
            failClosed(L10n.t(.certChanged))
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        hideOverlay()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if loadAttempted {
            showOverlay(status: ConnectFlowViewController.describe(error), retryable: true)
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        // Pin cancellations already reported through closeWithMessage.
        if (error as NSError).code != NSURLErrorCancelled {
            showOverlay(status: ConnectFlowViewController.describe(error), retryable: true)
        }
    }
}
