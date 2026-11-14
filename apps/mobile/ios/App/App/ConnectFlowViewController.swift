/**
 * Connect screen: saved pairing, QR scan, manual invitation paste, pair
 * request, six-digit verification code, and status polling with backoff.
 *
 * Attempt model: a scanned or pasted invitation that passes the intake policy
 * starts exactly one pairing attempt automatically — no preview step and no
 * second confirmation tap. Intake runs only in the presenting modal's dismiss
 * completion, so the presentation teardown cannot cancel the task it starts.
 * The attempt first resolves the invitation's reachable origin, then sends
 * exactly one pair POST. The attempt's requestId, secret, and chosen
 * invitation are kept before the POST, so an unknown POST outcome — an
 * interrupted request, a transport failure, or a 2xx answer the protocol
 * rejects — keeps the same attempt: the screen shows a local `checking` state
 * and only polls status on the chosen origin. A failure during resolution
 * sends nothing, so the screen offers a safe retry. A new POST happens only
 * after the attempt ends by explicit rejection, expiry, the user abandoning
 * it, or a new invitation with a different token; delivering the same
 * invitation again while an attempt is live keeps the live attempt. Only the
 * idempotent status poll repeats, and only while its task is alive.
 *
 * The stored pairing auto-connects on cold start: it probes the saved address
 * credential-free first (a single saved address included, bounded by the same
 * request budget), so a stale or unreachable address settles on the connect
 * screen with the shared-Wi-Fi hint instead of holding the remote screen open,
 * and the connect stays cancellable while it runs.
 */

import UIKit
import AVFoundation
import HemiMobileCore

@MainActor
final class ConnectFlowViewController: UIViewController {
    private enum Phase: Equatable {
        case idle
        /** Origin resolution failed before the POST: a fresh attempt is safe. */
        case resolveFailed(MobileInvitation)
        case requesting(MobileInvitation, attempt: UUID)
        case pending(MobileInvitation, attempt: UUID, code: String, serverName: String)
        case checking(MobileInvitation, attempt: UUID)
    }

    /** One pairing attempt: one chosen origin, one requestId/secret pair, one POST. */
    private struct PairAttempt {
        let id: UUID
        let requestId: UUID
        let secret: String
        let invite: MobileInvitation
        let client: PairingClient
        /** Server-reported deadline of the pair request; empty until a receipt or poll answer. */
        var requestClock = PairingRequestClock()
    }

    private var phase: Phase = .idle
    private var saved: SessionSecret?
    private var attempt: PairAttempt?
    private var pairingTask: Task<Void, Never>?
    private var statusTask: Task<Void, Never>?
    private var statusError: String?
    /** Duplicate-suppression and staleness decisions for invitation intake. */
    private var intake = PairingIntakePolicy()

    private var connectTask: Task<Void, Never>?
    private var connectTicket = UUID()
    private var savedConnecting = false

    /// Set by the first `viewDidAppear`; the stored pairing auto-connects only
    /// on that cold-start appearance, never when the screen returns.
    private var didColdStartConnect = false

    private let scrollView = UIScrollView()
    private let stack = UIStackView()
    private let statusLabel = UILabel()
    private var keyboard: KeyboardObserver?

    override func viewDidLoad() {
        super.viewDidLoad()
        title = L10n.t(.connectTitle)
        view.backgroundColor = .systemBackground
        navigationItem.largeTitleDisplayMode = .always

        Style.applyMonochromeTint(to: view)
        scrollView.bounces = false
        scrollView.alwaysBounceVertical = false
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scrollView)
        stack.axis = .vertical
        stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false
        scrollView.addSubview(stack)
        NSLayoutConstraint.activate([
            scrollView.frameLayoutGuide.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scrollView.frameLayoutGuide.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scrollView.frameLayoutGuide.topAnchor.constraint(equalTo: view.topAnchor),
            scrollView.frameLayoutGuide.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor, constant: 16),
            stack.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor, constant: -24),
            stack.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor, constant: -40),
        ])
        keyboard = KeyboardObserver(scrollView: scrollView, owningView: view)

        reloadSaved()
        render()
    }

    private func reloadSaved() {
        do {
            saved = try SessionStore.load()
        } catch {
            // A broken or corrupt store is visible, never disguised as "no session".
            saved = nil
            statusError = L10n.t(.storageFailure)
            render()
            return
        }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // The remote screen may have cleared the pairing (401, certificate
        // change, forget); refresh instead of reusing a stale card.
        reloadSaved()
        // A live attempt parked while away resumes its idempotent status poll.
        if attempt != nil, statusTask == nil {
            startStatusPolling()
        }
        render()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // Cold start auto-connect: only the very first appearance carries a
        // stored pairing into `connectSaved`, which re-resolves the reachable
        // origin before opening the remote screen. Returning from the remote —
        // by back gesture, explicit disconnect, or fail-closed — lands here
        // with the flag already set and never bounces back into the remote.
        guard !didColdStartConnect else { return }
        didColdStartConnect = true
        if saved != nil {
            connectSaved()
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        // Leaving the screen cancels the request and poll tasks so a late
        // approval cannot land on an abandoned flow; a live attempt stays
        // parked with its requestId, secret, and chosen origin, and polling
        // resumes when the screen returns.
        cancelPairingWork()
    }

    // MARK: - Rendering

    private func render() {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        statusLabel.textColor = .systemRed
        statusLabel.font = .preferredFont(forTextStyle: .subheadline)
        statusLabel.adjustsFontForContentSizeCategory = true
        statusLabel.numberOfLines = 0

        switch phase {
        case .idle:
            addStatusError()
            renderIdle()
        case .resolveFailed:
            addStatusError()
            addRetryAction()
            addCancelAction()
        case .requesting:
            stack.addArrangedSubview(activityRow(text: L10n.t(.requesting)))
            addCancelAction()
        case .pending(_, _, let code, let serverName):
            renderPending(code: code, serverName: serverName)
        case .checking:
            renderChecking()
        }
    }

    private func renderIdle() {
        if let saved {
            let card = UIView()
            card.layer.cornerRadius = 12
            card.layer.borderWidth = 1
            card.layer.borderColor = UIColor.separator.cgColor
            card.translatesAutoresizingMaskIntoConstraints = false
            stack.addArrangedSubview(card)

            let title = UILabel()
            title.text = saved.serverName
            title.font = .systemFont(ofSize: 17, weight: .semibold)
            title.numberOfLines = 0
            let detail = UILabel()
            detail.text = saved.origin
            detail.font = .monospacedSystemFont(ofSize: 14, weight: .regular)
            detail.textColor = .secondaryLabel
            detail.numberOfLines = 1
            detail.adjustsFontForContentSizeCategory = true

            let connect = Style.primaryButton(title: L10n.t(.connect)) { [weak self] _ in
                self?.connectSaved()
            }
            let forget = UIButton(type: .system)
            forget.setTitle(L10n.t(.forget), for: .normal)
            forget.tintColor = .systemRed
            forget.addTarget(self, action: #selector(forgetSaved), for: .touchUpInside)

            let inner = UIStackView(arrangedSubviews: [title, detail, connect, forget])
            inner.axis = .vertical
            inner.spacing = 10
            inner.translatesAutoresizingMaskIntoConstraints = false
            card.addSubview(inner)
            NSLayoutConstraint.activate([
                inner.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 14),
                inner.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -14),
                inner.topAnchor.constraint(equalTo: card.topAnchor, constant: 14),
                inner.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -14),
                connect.heightAnchor.constraint(equalToConstant: 44),
                forget.heightAnchor.constraint(equalToConstant: 44),
            ])
        }

        if savedConnecting {
            stack.addArrangedSubview(activityRow(text: L10n.t(.loadingSession)))
            let cancel = UIButton(configuration: .plain(), primaryAction: UIAction(title: L10n.t(.cancel)) { [weak self] _ in
                self?.cancelConnect()
            })
            cancel.heightAnchor.constraint(equalToConstant: 44).isActive = true
            stack.addArrangedSubview(cancel)
        }

        let scan = Style.primaryButton(title: L10n.t(.scanAction)) { [weak self] _ in
            self?.startScan()
        }
        scan.heightAnchor.constraint(equalToConstant: 50).isActive = true

        var manualConfiguration = UIButton.Configuration.plain()
        manualConfiguration.baseForegroundColor = .secondaryLabel
        manualConfiguration.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var attributes = attributes
            attributes.font = UIFont.preferredFont(forTextStyle: .subheadline)
            return attributes
        }
        let manual = UIButton(configuration: manualConfiguration, primaryAction: UIAction(title: L10n.t(.manualAction)) { [weak self] _ in
            self?.startManualEntry()
        })
        manual.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true

        stack.addArrangedSubview(scan)
        stack.addArrangedSubview(manual)
    }

    /** Offered only after a resolution failure: nothing was sent, so one fresh attempt is safe. */
    private func addRetryAction() {
        let retry = Style.primaryButton(title: L10n.t(.retry)) { [weak self] _ in
            guard let self, case .resolveFailed(let invite) = self.phase else { return }
            self.requestPairing(invite)
        }
        retry.heightAnchor.constraint(equalToConstant: 50).isActive = true
        stack.addArrangedSubview(retry)
    }

    private func renderChecking() {
        if statusTask == nil {
            addStatusError(L10n.t(.pairingStatusUnknown))
            addResumeStatusAction()
        } else {
            stack.addArrangedSubview(activityRow(text: L10n.t(.checkingStatus)))
        }
        addCancelAction()
    }

    private func renderPending(code: String, serverName: String) {
        let codeLabel = UILabel()
        codeLabel.text = code
        codeLabel.font = UIFontMetrics(forTextStyle: .largeTitle).scaledFont(
            for: .monospacedDigitSystemFont(ofSize: 56, weight: .medium)
        )
        codeLabel.textAlignment = .center
        codeLabel.adjustsFontForContentSizeCategory = true
        codeLabel.adjustsFontSizeToFitWidth = true
        codeLabel.minimumScaleFactor = 0.5
        stack.addArrangedSubview(codeLabel)

        let server = UILabel()
        server.text = serverName
        server.font = .preferredFont(forTextStyle: .body)
        server.adjustsFontForContentSizeCategory = true
        server.numberOfLines = 0
        server.textAlignment = .center
        stack.addArrangedSubview(server)

        addMessage(L10n.t(.pendingHint), alignment: .center)

        if statusTask == nil, statusError != nil {
            addStatusError(L10n.t(.pairingStatusUnknown))
            addResumeStatusAction()
        }
        addCancelAction()
    }

    private func addStatusError(_ message: String? = nil) {
        guard let message = message ?? statusError else { return }
        statusLabel.text = message
        stack.addArrangedSubview(statusLabel)
    }

    private func addMessage(_ text: String, alignment: NSTextAlignment = .natural) {
        let label = UILabel()
        label.text = text
        label.font = .preferredFont(forTextStyle: .subheadline)
        label.adjustsFontForContentSizeCategory = true
        label.textColor = .secondaryLabel
        label.numberOfLines = 0
        label.textAlignment = alignment
        stack.addArrangedSubview(label)
    }

    private func activityRow(text: String) -> UIView {
        let label = UILabel()
        label.text = text
        label.font = .systemFont(ofSize: 15)
        label.textColor = .secondaryLabel
        label.numberOfLines = 0
        let spinner = UIActivityIndicatorView(style: .medium)
        spinner.startAnimating()
        let row = UIStackView(arrangedSubviews: [spinner, label])
        row.axis = .horizontal
        row.spacing = 8
        row.alignment = .center
        return row
    }

    /** Plain cancel: explicit abandonment ends a live attempt. */
    private func addCancelAction() {
        let cancel = UIButton(configuration: .plain(), primaryAction: UIAction(title: L10n.t(.cancel)) { [weak self] _ in
            self?.abandonAttempt()
        })
        cancel.heightAnchor.constraint(equalToConstant: 44).isActive = true
        stack.addArrangedSubview(cancel)
    }

    /** Offered only while the poll is stopped but the attempt stays live. */
    private func addResumeStatusAction() {
        guard attempt != nil, statusTask == nil else { return }
        let resume = Style.secondaryButton(title: L10n.t(.resumeStatus)) { [weak self] _ in
            self?.resumeStatusPolling()
        }
        resume.heightAnchor.constraint(equalToConstant: 44).isActive = true
        stack.addArrangedSubview(resume)
    }

    // MARK: - Saved session

    private func connectSaved() {
        guard let saved, connectTask == nil else { return }
        statusError = nil
        savedConnecting = true
        let ticket = UUID()
        connectTicket = ticket
        render()
        let client = PairingClient(fingerprint: saved.fingerprint)
        connectTask = Task { [weak self] in
            guard let self else { return }
            do {
                // Pick the reachable origin first: the remote screen, its
                // origin policy, and its sockets must all use one address.
                let resolved = try await client.resolveSession(saved)
                guard self.connectTicket == ticket else { return }
                do {
                    try SessionStore.save(resolved)
                } catch {
                    self.savedConnecting = false
                    self.connectTask = nil
                    self.statusError = L10n.t(.storageFailure)
                    self.render()
                    return
                }
                self.savedConnecting = false
                self.connectTask = nil
                self.saved = resolved
                self.coordinator?.openRemote(session: resolved)
            } catch {
                guard self.connectTicket == ticket else { return }
                self.savedConnecting = false
                self.connectTask = nil
                if error is CancellationError { return }
                self.statusError = Self.describe(error)
                self.render()
            }
        }
    }

    /**
     * Cancel the saved-session connect. Bumping the ticket fences any late
     * settle inside the running task before it is cancelled, so neither a
     * resolved session nor a late failure can act after the cancel; the
     * spinner resets and the connect screen stays usable.
     */
    private func cancelConnect() {
        connectTicket = UUID()
        connectTask?.cancel()
        connectTask = nil
        savedConnecting = false
        render()
    }

    @objc private func forgetSaved() {
        let alert = UIAlertController(
            title: L10n.t(.forgetConfirmTitle),
            message: L10n.t(.forgetConfirmMessage),
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: L10n.t(.cancel), style: .cancel))
        alert.addAction(UIAlertAction(title: L10n.t(.forgetConfirmAction), style: .destructive) { [weak self] _ in
            self?.forgetPairing()
        })
        present(alert, animated: true)
    }

    private func forgetPairing() {
        Task { @MainActor in
            do {
                // Awaits cookie deletion so a new pairing cannot race a stale cookie.
                try await RemoteTeardown.clearStoredSession()
            } catch {
                statusError = L10n.t(.storageFailure)
                render()
                return
            }
            cancelPairingWork()
            intake.endedMutation()
            attempt = nil
            saved = nil
            phase = .idle
            statusError = nil
            render()
        }
    }

    // MARK: - Invitation intake

    private func startScan() {
        guard presentedViewController == nil else { return }
        AVCaptureDevice.requestAccess(for: .video) { [weak self] allowed in
            Task { @MainActor in
                guard let self else { return }
                guard allowed else {
                    self.statusError = L10n.t(.cameraDenied)
                    self.render()
                    return
                }
                // Intake runs in the dismiss completion only: intake fired
                // earlier would race the dismissal and let viewWillDisappear
                // cancel the pairing task it starts. The ticket marks this
                // modal, so a stale callback cannot start a mutation.
                guard self.presentedViewController == nil else { return }
                let ticket = self.intake.presentIntakeModal()
                let scanner = ScannerController { [weak self] value, error in
                    Task { @MainActor in
                        guard let self else { return }
                        self.dismiss(animated: true) {
                            if let value { self.acceptInvitationText(value, ticket: ticket) }
                            else {
                                // Cancelled or failed scan: the modal's ticket
                                // dies, so a late callback cannot deliver.
                                self.intake.discardIntakeModal()
                                if let error {
                                    self.statusError = error
                                    self.render()
                                }
                            }
                        }
                    }
                }
                scanner.modalPresentationStyle = .fullScreen
                self.present(scanner, animated: true)
            }
        }
    }

    private func startManualEntry() {
        guard presentedViewController == nil else { return }
        let ticket = intake.presentIntakeModal()
        // ManualInviteController already calls back from its dismiss
        // completion, so this intake also runs after the sheet is gone.
        let editor = ManualInviteController { [weak self] text in
            self?.acceptInvitationText(text, ticket: ticket)
        }
        let nav = UINavigationController(rootViewController: editor)
        nav.modalPresentationStyle = .pageSheet
        present(nav, animated: true)
    }

    /**
     * One delivered invitation: parse it, then follow the intake policy.
     * A parse failure or an expired invitation shows the short localized
     * refusal and leaves scanning available; no host, address, or
     * certificate diagnostics.
     */
    private func acceptInvitationText(_ text: String, ticket: Int) {
        let now = Date()
        statusError = nil
        let invite: MobileInvitation
        switch parseInvitation(text, now: now) {
        case .success(let parsed): invite = parsed
        case .failure:
            statusError = L10n.t(.invalidInvite)
            render()
            return
        }
        switch intake.deliver(invite, ticket: ticket, modalEnded: true, now: now) {
        case .begin:
            requestPairing(invite)
        case .replace:
            // A different invitation ends the live attempt and starts one new mutation.
            cancelPairingWork()
            attempt = nil
            requestPairing(invite)
        case .keep:
            // The live attempt already carries this invitation: keep its
            // requestId, secret, and chosen origin; no second POST.
            break
        case .refuseExpired:
            statusError = L10n.t(.invalidInvite)
            if Self.attemptId(of: phase) == nil { phase = .idle }
            render()
        case .drop:
            return
        }
    }

    // MARK: - Pairing

    private func requestPairing(_ invite: MobileInvitation) {
        cancelPairingWork()
        attempt = nil
        statusError = nil
        intake.beganMutation(invite)
        let attemptId = UUID()
        phase = .requesting(invite, attempt: attemptId)
        render()
        let requestId = UUID()
        let secret = SessionSecretGenerator.generate()
        let client = PairingClient(fingerprint: invite.fingerprint, onReject: { [weak self] failure in
            Task { @MainActor in self?.reportTransportRejection(failure, attempt: attemptId) }
        })
        pairingTask = Task { [weak self] in
            guard let self else { return }
            let resolved: MobileInvitation
            do {
                // Origin probing happens before any POST, so the pair request
                // and every later call of this attempt use one address.
                resolved = try await client.resolveInvitation(invite)
            } catch {
                self.settleResolveFailure(error, invite: invite, attempt: attemptId)
                return
            }
            guard case .requesting(let current, let currentAttempt) = self.phase,
                  current == invite, currentAttempt == attemptId else { return }
            // The invitation must still be valid when the POST fires; one that
            // expired during resolution never reaches the wire.
            guard Date().timeIntervalSince1970 * 1000 < invite.expiresAt else {
                await self.finishAttempt(attemptId: attemptId, withError: L10n.t(.expiredTitle))
                return
            }
            // Kept before the POST: an unknown POST outcome must reuse exactly
            // this requestId, secret, and chosen invitation.
            self.attempt = PairAttempt(
                id: attemptId, requestId: requestId, secret: secret, invite: resolved, client: client
            )
            do {
                let pending = try await client.requestPair(
                    invite: resolved,
                    deviceName: await MainActor.run { UIDevice.current.name },
                    requestId: requestId,
                    secret: secret
                )
                guard case .requesting(let current, let currentAttempt) = self.phase,
                      current == invite, currentAttempt == attemptId else { return }
                self.pairingTask = nil
                self.attempt?.requestClock.reportedRequestExpiry(pending.expiresAt)
                self.phase = .pending(
                    resolved, attempt: attemptId, code: pending.verificationCode, serverName: pending.serverName
                )
                self.startStatusPolling()
                self.render()
            } catch {
                self.settlePairFailure(error, invite: invite, resolved: resolved, attempt: attemptId)
            }
        }
    }

    /**
     * Resolution failed before any POST: nothing was sent, so the screen
     * offers a safe retry — one fresh attempt for the same invitation.
     */
    private func settleResolveFailure(_ error: Error, invite: MobileInvitation, attempt attemptId: UUID) {
        guard case .requesting(let current, let currentAttempt) = phase,
              current == invite, currentAttempt == attemptId else { return }
        pairingTask = nil
        intake.endedMutation()
        phase = .resolveFailed(invite)
        if !(error is CancellationError) {
            statusError = Self.describe(error)
        }
        render()
    }

    /**
     * Settle the one POST of an attempt.
     *
     * An interrupted POST or an unknown answer (`.network`, `.badResponse`,
     * `.timedOut`) may have created the pairing server-side: the attempt stays
     * alive, the screen switches to `checking`, and only the status poll runs,
     * still on the chosen origin. Definite answers — refusal, 429, wrong path,
     * TLS rejection, invalid input, pin change — end the attempt.
     */
    private func settlePairFailure(_ error: Error, invite: MobileInvitation, resolved: MobileInvitation, attempt attemptId: UUID) {
        guard case .requesting(let current, let currentAttempt) = phase,
              current == invite, currentAttempt == attemptId else { return }
        pairingTask = nil
        if Task.isCancelled || error is CancellationError {
            // The POST was interrupted in flight, so its outcome is unknown;
            // polling resumes when the screen returns.
            phase = .checking(resolved, attempt: attemptId)
            statusError = L10n.t(.networkUnknown)
            render()
            return
        }
        switch error as? PairingFailure {
        case .network, .badResponse, .timedOut:
            phase = .checking(resolved, attempt: attemptId)
            statusError = Self.describe(error)
            startStatusPolling()
            render()
        case .certificateChanged:
            intake.endedMutation()
            attempt = nil
            phase = .idle
            statusError = L10n.t(.certChanged)
            render()
        default:
            // A definite refusal ends the attempt: the host answered for
            // itself, so a fresh start needs a new invitation.
            intake.endedMutation()
            attempt = nil
            phase = .idle
            statusError = Self.describe(error)
            render()
        }
    }

    private func startStatusPolling() {
        guard let current = attempt, statusTask == nil else { return }
        let id = current.id
        statusTask = Task { [weak self] in
            var delayNs: UInt64 = 2_000_000_000
            // The request deadline comes from the pair receipt and from pending
            // answers; an invitation past its own expiry never ends a live
            // request, whose host TTL is independent and longer.
            var requestDeadline = current.requestClock.requestExpiresAt
            while !Task.isCancelled {
                do {
                    try await Task.sleep(nanoseconds: delayNs)
                } catch { return }
                guard !Task.isCancelled, let self else { return }
                do {
                    let status = try await current.client.pollStatus(
                        invite: current.invite, requestId: current.requestId, secret: current.secret
                    )
                    if Task.isCancelled { return }
                    switch status {
                    case .pending(let code, let expiresAt, let serverName):
                        delayNs = min(delayNs + 500_000_000, 5_000_000_000)
                        if let expiresAt,
                           self.recordRequestExpiry(expiresAt, attemptId: id) {
                            requestDeadline = expiresAt
                        }
                        if let code, case .checking(let shown, let shownAttempt) = self.phase, shownAttempt == id {
                            // The unknown POST resolved to a live code; show it.
                            self.phase = .pending(shown, attempt: id, code: code, serverName: serverName)
                            self.statusError = nil
                            self.render()
                        }
                    case .approved(let deviceId, let serverName):
                        await self.approve(attemptId: id, deviceId: deviceId, serverName: serverName)
                        return
                    case .rejected:
                        await self.finishAttempt(attemptId: id, withError: L10n.t(.rejectedTitle))
                        return
                    case .expired:
                        await self.finishAttempt(attemptId: id, withError: L10n.t(.expiredTitle))
                        return
                    }
                } catch PairingFailure.rateLimited {
                    delayNs = min(delayNs + 2_000_000_000, 10_000_000_000)
                } catch {
                    if Task.isCancelled { return }
                    // Unknown poll outcome: stop and show it. The attempt
                    // stays live; an explicit tap resumes the idempotent poll.
                    await self.suspendPolling(attemptId: id, withError: Self.describe(error))
                    return
                }
                // Only the server-reported request deadline ends the attempt
                // locally. Without a receipt the POST outcome is unknown, so
                // no deadline is inferred and nothing is lost.
                if let requestDeadline, Date().timeIntervalSince1970 * 1000 >= requestDeadline {
                    await self.finishAttempt(attemptId: id, withError: L10n.t(.expiredTitle))
                    return
                }
            }
        }
    }

    /**
     * Record the server-reported request deadline on the live attempt.
     * @returns true when the deadline was recorded for this attempt.
     */
    @discardableResult
    private func recordRequestExpiry(_ expiresAt: Double, attemptId: UUID) -> Bool {
        guard let current = attempt, current.id == attemptId else { return false }
        attempt?.requestClock.reportedRequestExpiry(expiresAt)
        return true
    }

    private func resumeStatusPolling() {
        guard attempt != nil, statusTask == nil else { return }
        startStatusPolling()
        render()
    }

    /** Cancel every owned task; a live attempt stays parked, its state intact. */
    private func cancelPairingWork() {
        pairingTask?.cancel()
        pairingTask = nil
        statusTask?.cancel()
        statusTask = nil
        connectTask?.cancel()
        connectTask = nil
        savedConnecting = false
    }

    /** Explicit abandonment is one of the ways a live attempt ends. */
    private func abandonAttempt() {
        cancelPairingWork()
        intake.endedMutation()
        attempt = nil
        phase = .idle
        statusError = nil
        render()
    }

    /** Stop the poll on an unknown outcome without ending the attempt. */
    private func suspendPolling(attemptId: UUID, withError message: String) async {
        guard Self.attemptId(of: phase) == attemptId else { return }
        statusTask?.cancel()
        statusTask = nil
        statusError = message
        render()
    }

    /** End a live attempt with a terminal answer: rejection, expiry, or a deadline. */
    private func finishAttempt(attemptId: UUID, withError message: String) async {
        guard Self.attemptId(of: phase) == attemptId else { return }
        statusTask?.cancel()
        statusTask = nil
        pairingTask = nil
        intake.endedMutation()
        attempt = nil
        phase = .idle
        statusError = message
        do { saved = try SessionStore.load() }
        catch { saved = nil; statusError = L10n.t(.storageFailure) }
        render()
    }

    /**
     * Approval completes the attempt, but only from `pending` or `checking`
     * while the phase still carries this attempt's identity.
     */
    private func approve(attemptId: UUID, deviceId: UUID, serverName: String) async {
        guard let current = attempt, current.id == attemptId else { return }
        switch phase {
        case .pending(_, let id, _, _) where id == attemptId,
             .checking(_, let id) where id == attemptId:
            break
        default:
            return
        }
        statusTask?.cancel()
        statusTask = nil
        pairingTask = nil
        intake.endedMutation()
        let session = SessionSecret(
            origin: current.invite.originString,
            fingerprint: current.invite.fingerprint,
            deviceId: deviceId,
            secret: current.secret,
            serverName: serverName,
            createdAt: Date(),
            candidateOrigins: current.invite.origins?.map(Self.canonicalOrigin)
        )
        do {
            try SessionStore.save(session)
        } catch {
            statusError = L10n.t(.networkUnknown)
            phase = .idle
            attempt = nil
            render()
            return
        }
        attempt = nil
        saved = session
        phase = .idle
        statusError = nil
        render()
        coordinator?.openRemote(session: session)
    }

    /** Pin-gate rejections observed by the pairing client, scoped to their attempt. */
    private func reportTransportRejection(_ failure: TransportFailure, attempt attemptId: UUID) {
        guard Self.attemptId(of: phase) == attemptId, attempt != nil else { return }
        guard case .certificateChanged = failure else { return }
        cancelPairingWork()
        intake.endedMutation()
        attempt = nil
        phase = .idle
        statusError = L10n.t(.certChanged)
        render()
    }

    /** Attempt identity carried by `requesting`, `pending`, and `checking`. */
    private static func attemptId(of phase: Phase) -> UUID? {
        switch phase {
        case .requesting(_, let attempt), .pending(_, let attempt, _, _), .checking(_, let attempt):
            return attempt
        case .idle, .resolveFailed:
            return nil
        }
    }

    /**
     * `scheme://host[:port]` text in Core's canonical origin form; Core keeps
     * its helper module-internal, and candidate URLs arrive pre-validated
     * without path, query, or fragment.
     */
    private static func canonicalOrigin(_ url: URL) -> String {
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        components?.path = ""
        return components?.url?.absoluteString ?? url.absoluteString
    }

    static func describe(_ error: Error) -> String {
        // System timeout identity — the client request budget or a WKWebView
        // load timeout: the computer did not answer in time, so the shared
        // Wi-Fi hint applies rather than the unknown-outcome copy.
        if let urlError = error as? URLError, urlError.code == .timedOut {
            return L10n.t(.serverUnreachable)
        }
        guard let failure = error as? PairingFailure else {
            return L10n.t(.networkUnknown)
        }
        switch failure {
        case .refused: return L10n.t(.refusedTitle)
        case .unauthorized: return L10n.t(.revokedMessage)
        case .notFound, .invalid: return L10n.t(.serverUnreachable)
        case .rateLimited: return L10n.t(.serverUnreachable)
        case .badResponse, .network: return L10n.t(.networkUnknown)
        case .timedOut, .unreachable: return L10n.t(.serverUnreachable)
        case .certificateChanged: return L10n.t(.certChanged)
        case .tlsRejected, .tlsNoChain: return L10n.t(.serverUnreachable)
        }
    }

    var coordinator: RootCoordinator? {
        let scene = view.window?.windowScene?.delegate as? SceneDelegate
        return scene?.coordinator
    }
}
