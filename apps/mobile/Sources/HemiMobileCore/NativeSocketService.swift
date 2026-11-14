/**
 * Native WebSocket carrier for the bridge: one pinned, cookie-authenticated
 * `URLSessionWebSocketTask` per page socket.
 *
 * The session delegate explicitly conforms to `URLSessionWebSocketDelegate`
 * (which inherits `URLSessionTaskDelegate`), so both the WebSocket
 * open/close callbacks and the redirect refusal are exposed to the Objective-C
 * runtime and actually invoked — `URLSessionDelegate` alone would not surface
 * the task-level optional methods.
 *
 * Event discipline: `open` is emitted only from
 * `urlSession(_:webSocketTask:didOpenWithProtocol:)`; every terminal path
 * (delegate close, receive failure, send failure, page close, suspend) funnels
 * through one exactly-once `close` per socket, which also cancels the task;
 * after `closeAll()` the session is invalidated and no further event escapes.
 * Events are delivered on the session queue; the owner hops to the page.
 *
 * Security scope: sockets open only `wss://` URLs on the paired host and port
 * (`OriginPolicy.websocketAllowed`); the cookie rides a request header.
 */

import Foundation

public final class NativeSocketService: NSObject {
    /** One page-visible socket event; `payload` carries text for `message`. */
    public struct Event: Equatable, Sendable {
        public let socketId: String
        public let type: String
        public let payload: String?

        public init(socketId: String, type: String, payload: String?) {
            self.socketId = socketId
            self.type = type
            self.payload = payload
        }
    }

    private let policy: OriginPolicy
    private let cookieHeader: String
    private let sink: @Sendable (Event) -> Void
    private let sessionDelegate: SocketSessionDelegate
    private let session: URLSession
    private let lock = NSLock()
    /// Serial event delivery: emit blocks and the teardown fence below run on
    /// this queue, so delivery order is FIFO and no event can pass the fence
    /// once teardown has started.
    private let eventQueue = DispatchQueue(label: "ai.hemi.dsh.mobile.socket-events")
    private var tasks: [String: URLSessionWebSocketTask] = [:]
    private var ids: [ObjectIdentifier: String] = [:]
    private var closedIds: Set<String> = []
    private var tornDown = false

    /**
     * @param policy - paired-origin rules; every open command is checked.
     * @param cookieValue - `__Host-hemi-mobile` cookie value carried as a header.
     * @param fingerprint - invite pin for the socket session.
     * @param sink - receiver of socket events; called on the session queue.
     */
    public init(
        policy: OriginPolicy,
        cookieValue: String,
        fingerprint: String,
        sink: @escaping @Sendable (Event) -> Void
    ) {
        self.policy = policy
        self.cookieHeader = "\(MobileProtocol.cookieName)=\(cookieValue)"
        self.sink = sink
        let delegate = SocketSessionDelegate(pin: fingerprint)
        self.sessionDelegate = delegate
        self.session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
        super.init()
        delegate.owner = self
    }

    // MARK: - Page commands

    /// Handle one `dshSocket` message body (JSON text) from the main frame.
    public func handle(commandText: String) {
        guard let data = commandText.data(using: .utf8),
              let command = try? JSONDecoder().decode(SocketCommand.self, from: data) else { return }
        switch command.op {
        case "open":
            open(command)
        case "send":
            send(command)
        case "close":
            closeFromPage(command)
        default:
            break
        }
    }

    private func open(_ command: SocketCommand) {
        guard let text = command.url, let url = URL(string: text), policy.websocketAllowed(url: url) else {
            closeOnce(id: command.id)
            return
        }
        lock.lock()
        guard tasks[command.id] == nil, !tornDown else {
            lock.unlock()
            return
        }
        lock.unlock()
        var request = URLRequest(url: url)
        request.setValue(cookieHeader, forHTTPHeaderField: "Cookie")
        let task = session.webSocketTask(with: request)
        lock.lock()
        guard tasks[command.id] == nil, !tornDown else {
            lock.unlock()
            task.cancel()
            return
        }
        tasks[command.id] = task
        ids[ObjectIdentifier(task)] = command.id
        lock.unlock()
        task.resume()
        receiveLoop(id: command.id, task: task)
    }

    private func send(_ command: SocketCommand) {
        lock.lock()
        let task = tasks[command.id]
        lock.unlock()
        guard let task, let data = command.data else { return }
        task.send(.string(data)) { [weak self] error in
            if error != nil {
                // The socket is unusable; report the loss, never retry the frame.
                self?.closeOnce(id: command.id)
            }
        }
    }

    private func closeFromPage(_ command: SocketCommand) {
        closeOnce(id: command.id, code: .normalClosure, reason: Data((command.reason ?? "").utf8))
    }

    // MARK: - Delegate callbacks (session queue)

    fileprivate func socketDidOpen(_ task: URLSessionWebSocketTask) {
        lock.lock()
        let id = ids[ObjectIdentifier(task)]
        let isCurrent = id.map { tasks[$0] === task } ?? false
        let alreadyClosed = id.map { closedIds.contains($0) } ?? true
        lock.unlock()
        guard let id, isCurrent, !alreadyClosed else { return }
        emit(Event(socketId: id, type: "open", payload: nil))
    }

    fileprivate func socketDidClose(_ task: URLSessionWebSocketTask) {
        lock.lock()
        let id = ids[ObjectIdentifier(task)]
        lock.unlock()
        guard let id else { return }
        closeOnce(id: id)
    }

    private func receiveLoop(id: String, task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                if case .string(let text) = message {
                    self.lock.lock()
                    let isCurrent = self.tasks[id] === task && !self.closedIds.contains(id)
                    self.lock.unlock()
                    if isCurrent {
                        self.emit(Event(socketId: id, type: "message", payload: text))
                    }
                }
                self.receiveLoop(id: id, task: task)
            case .failure:
                // Includes normal close after cancel; both funnel to one close.
                self.closeOnce(id: id)
            }
        }
    }

    // MARK: - Terminal discipline

    private func closeOnce(id: String, code: URLSessionWebSocketTask.CloseCode = .normalClosure, reason: Data? = nil) {
        lock.lock()
        guard !tornDown, !closedIds.contains(id) else {
            lock.unlock()
            return
        }
        closedIds.insert(id)
        let task = tasks.removeValue(forKey: id)
        if let task {
            ids.removeValue(forKey: ObjectIdentifier(task))
        }
        lock.unlock()
        // Cancel and emit outside the lock: the sink may call back into handle().
        task?.cancel(with: code, reason: reason)
        emit(Event(socketId: id, type: "close", payload: nil))
    }

    private func emit(_ event: Event) {
        eventQueue.async { [weak self] in
            guard let self else { return }
            // Fence checked at delivery time, not enqueue time: a teardown that
            // starts after this block was queued still suppresses it.
            self.lock.lock()
            let deliver = !self.tornDown
            self.lock.unlock()
            guard deliver else { return }
            self.sink(event)
        }
    }

    // MARK: - Lifecycle

    /// App backgrounded: close every socket so no stale connection survives
    /// suspension. The page owns reconnecting when it becomes active again.
    public func suspendAll() {
        lock.lock()
        let all = Array(tasks.keys)
        lock.unlock()
        for id in all {
            closeOnce(id: id, code: .goingAway, reason: nil)
        }
    }

    /**
     * Screen torn down or pairing forgotten. Cancels every task, invalidates
     * the session (`invalidateAndCancel`), and fences event delivery: after
     * this returns, no callback already in flight or still queued can reach
     * the sink. Must not be called from the event queue itself.
     */
    public func closeAll() {
        lock.lock()
        guard !tornDown else {
            lock.unlock()
            return
        }
        tornDown = true
        let captured = tasks
        tasks = [:]
        ids = [:]
        lock.unlock()
        for task in captured.values {
            task.cancel(with: .normalClosure, reason: nil)
        }
        session.invalidateAndCancel()
        // Drain: wait for an executing emit block, and let queued blocks see
        // the fence. Sink re-entrancy into handle()/closeOnce() is safe (those
        // paths take only `lock`, never this queue); re-entering closeAll()
        // from the event queue would deadlock on sync, so this method must be
        // called from the owner's thread — enforced below.
        dispatchPrecondition(condition: .notOnQueue(eventQueue))
        eventQueue.sync { }
    }
}

/** URL command JSON from the page bridge. */
struct SocketCommand: Decodable {
    let id: String
    let op: String
    let url: String?
    let data: String?
    let code: Int?
    let reason: String?
}

/**
 * Session delegate for {@link NativeSocketService}: pinned challenges, refused
 * redirects, and WebSocket open/close callbacks.
 */
private final class SocketSessionDelegate: NSObject, URLSessionWebSocketDelegate {
    weak var owner: NativeSocketService?
    let pin: String

    init(pin: String) {
        self.pin = pin
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        switch evaluatePinnedTrust(trust, host: challenge.protectionSpace.host, expectedPin: pin) {
        case .accepted:
            completionHandler(.useCredential, URLCredential(trust: trust))
        case .mismatch, .invalidChain, .noChain:
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    /// WebSocket endpoints never redirect; a 3xx means the wrong origin answered.
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        owner?.socketDidOpen(webSocketTask)
    }

    func urlSession(
        _ session: URLSession, webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?
    ) {
        owner?.socketDidClose(webSocketTask)
    }
}
