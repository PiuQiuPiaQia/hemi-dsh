/**
 * Real-network tests for {@link NativeSocketService}: a real self-signed TLS
 * server (the WK trust experiment fixture) and the production native bridge,
 * no mocks. Verifies the open→send→echo→close cycle, redirect refusal, wrong
 * pin fail-closed, and late-event suppression after teardown.
 *
 * Child processes are owned: every spawned server is terminated and reaped in
 * teardown; certificates live in a per-test temporary directory.
 */

import Foundation
import XCTest
@testable import HemiMobileCore

final class NativeSocketServiceTests: XCTestCase {
    private var server: Process?
    private var serverPipe: Pipe?
    private var serverOutput = ""
    private var outputLock = NSLock()
    private var workDirectory: URL?
    private var port = 0
    private var pin = ""

    override func setUpWithError() throws {
        try super.setUpWithError()
        guard let python = Self.firstExisting(["/usr/bin/python3", "/opt/homebrew/bin/python3"]),
              let openssl = Self.firstExisting(["/opt/homebrew/bin/openssl", "/usr/bin/openssl"]) else {
            throw XCTSkip("python3 and openssl are required for the real-network socket tests")
        }
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("hemi-dsh-mobile-socket-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        workDirectory = directory
        let key = directory.appendingPathComponent("key.pem").path
        let certificate = directory.appendingPathComponent("cert.pem").path
        let der = directory.appendingPathComponent("cert.der").path
        try Self.run(launchPath: openssl, arguments: [
            "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "2", "-nodes",
            "-keyout", key, "-out", certificate,
            "-subj", "/CN=127.0.0.1",
            "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
            "-addext", "basicConstraints=critical,CA:FALSE",
            "-addext", "keyUsage=digitalSignature,keyEncipherment",
            "-addext", "extendedKeyUsage=serverAuth",
        ])
        try Self.run(launchPath: openssl, arguments: ["x509", "-in", certificate, "-outform", "DER", "-out", der])
        let digest = try Self.run(launchPath: openssl, arguments: ["dgst", "-sha256", "-hex", der])
        guard let hex = digest.split(whereSeparator: { $0 == " " || $0 == "=" }).last else {
            throw XCTSkip("could not compute certificate digest")
        }
        pin = String(hex).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

        let script = URL(fileURLWithPath: #filePath)  // …/Tests/HemiMobileCoreTests/NativeSocketServiceTests.swift
            .deletingLastPathComponent()  // …/Tests/HemiMobileCoreTests
            .deletingLastPathComponent()  // …/Tests
            .deletingLastPathComponent()  // apps/mobile
            .appendingPathComponent("experiments/wk-tls-trust/server.py")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: python)
        process.arguments = [script.path, certificate, key, "0"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        let lock = outputLock
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let text = String(data: handle.availableData, encoding: .utf8) ?? ""
            lock.lock()
            self?.serverOutput += text
            lock.unlock()
        }
        try process.run()
        server = process
        serverPipe = pipe

        // Wait for the readiness line; the port is assigned by bind(0), so the
        // test never races a fixed port.
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline {
            outputLock.lock()
            let output = serverOutput
            outputLock.unlock()
            if let range = output.range(of: "listening https://127\\.0\\.0\\.1:(\\d+)", options: .regularExpression) {
                port = Int(output[range].split(separator: ":")[2]) ?? 0
                break
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
        guard port > 0 else {
            throw XCTSkip("fixture server did not start")
        }
    }

    override func tearDown() {
        if let server {
            serverPipe?.fileHandleForReading.readabilityHandler = nil
            server.terminate()
            server.waitUntilExit()
        }
        if let workDirectory {
            try? FileManager.default.removeItem(at: workDirectory)
        }
        super.tearDown()
    }

    // MARK: - Tests

    func testRealPinnedWebsocketOpenSendEchoClose() async {
        let harness = Harness(port: port, fingerprint: pin)
        harness.onEvent = { event, service in
            if event.type == "open" {
                service.handle(commandText: Harness.command(id: event.socketId, op: "send", data: "ping"))
            } else if event.type == "message", event.payload == "ws-echo" {
                service.handle(commandText: Harness.command(id: event.socketId, op: "close", reason: "done"))
            }
        }
        harness.service.handle(commandText: Harness.command(id: "s1", op: "open", url: "wss://127.0.0.1:\(port)/ws"))

        await harness.waitUntil("open, echo, and one close") { events in
            events.contains { $0.type == "open" }
                && events.contains { $0.type == "message" && $0.payload == "ws-echo" }
                && events.filter { $0.type == "close" }.count == 1
        }
        // Exactly-once close: nothing else may arrive for a late callback.
        try? await Task.sleep(nanoseconds: 600_000_000)
        let events = harness.recorder.snapshot
        XCTAssertEqual(events.map(\.type), ["open", "message", "close"], "events: \(events)")
        XCTAssertEqual(events.filter { $0.type == "close" }.count, 1)
    }

    func testRedirectIsRefused() async {
        let harness = Harness(port: port, fingerprint: pin)
        harness.service.handle(commandText: Harness.command(id: "s1", op: "open", url: "wss://127.0.0.1:\(port)/ws-redirect"))

        await harness.waitUntil("exactly one close, no open") { events in
            events.filter { $0.type == "close" }.count == 1
        }
        try? await Task.sleep(nanoseconds: 500_000_000)
        let events = harness.recorder.snapshot
        XCTAssertFalse(events.contains { $0.type == "open" }, "redirect must not open a socket: \(events)")
        XCTAssertEqual(events.filter { $0.type == "close" }.count, 1)
    }

    func testWrongPinFailsClosed() async {
        var flipped = pin
        flipped.replaceSubrange(flipped.startIndex...flipped.startIndex, with: pin.first == "0" ? "1" : "0")
        let harness = Harness(port: port, fingerprint: flipped)
        harness.service.handle(commandText: Harness.command(id: "s1", op: "open", url: "wss://127.0.0.1:\(port)/ws"))

        await harness.waitUntil("exactly one close, no open") { events in
            events.filter { $0.type == "close" }.count == 1
        }
        try? await Task.sleep(nanoseconds: 500_000_000)
        let events = harness.recorder.snapshot
        XCTAssertFalse(events.contains { $0.type == "open" }, "wrong pin must not open a socket: \(events)")
        XCTAssertEqual(events.filter { $0.type == "close" }.count, 1)
    }

    func testTeardownDuringConnectSuppressesAllEvents() async throws {
        let harness = Harness(port: port, fingerprint: pin)
        harness.service.handle(commandText: Harness.command(id: "s1", op: "open", url: "wss://127.0.0.1:\(port)/ws"))
        harness.service.closeAll()
        try await Task.sleep(nanoseconds: 800_000_000)
        XCTAssertTrue(harness.recorder.snapshot.isEmpty, "no event may escape after teardown: \(harness.recorder.snapshot)")
    }

    func testTeardownAfterOpenClosesServerSideSocketAndEmitsNothing() async throws {
        let harness = Harness(port: port, fingerprint: pin)
        harness.service.handle(commandText: Harness.command(id: "s1", op: "open", url: "wss://127.0.0.1:\(port)/ws"))
        await harness.waitUntil("socket open") { events in
            events.contains { $0.type == "open" }
        }
        harness.service.closeAll()
        // Client side: teardown emits nothing, not even the close event.
        try await Task.sleep(nanoseconds: 800_000_000)
        XCTAssertEqual(harness.recorder.snapshot.map(\.type), ["open"], "no event after closeAll: \(harness.recorder.snapshot)")
        // Server side: the established connection must actually close.
        let closed = try await waitServerLog(containing: "ws closed", timeout: 5)
        XCTAssertTrue(closed, "server must observe the socket close; server log: \(serverSnapshot())")
    }

    private func serverSnapshot() -> String {
        outputLock.lock()
        defer { outputLock.unlock() }
        return serverOutput
    }

    private func waitServerLog(containing marker: String, timeout: TimeInterval) async throws -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if serverSnapshot().contains(marker) { return true }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        return false
    }

    // MARK: - Helpers

    private static func firstExisting(_ paths: [String]) -> String? {
        paths.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    @discardableResult
    private static func run(launchPath: String, arguments: [String]) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: launchPath)
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw NSError(domain: "NativeSocketServiceTests", code: Int(process.terminationStatus))
        }
        return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    }
}

/** Owns one service instance and a reactively driven event recorder. */
private final class Harness: @unchecked Sendable {
    private final class Wiring: @unchecked Sendable {
        var onEvent: (@Sendable (NativeSocketService.Event, NativeSocketService) -> Void)?
        var service: NativeSocketService?
    }

    private let wiring = Wiring()
    let recorder = EventRecorder()
    let service: NativeSocketService

    var onEvent: (@Sendable (NativeSocketService.Event, NativeSocketService) -> Void)? {
        get { wiring.onEvent }
        set { wiring.onEvent = newValue }
    }

    init(port: Int, fingerprint: String) {
        let recorder = recorder
        let wiring = wiring
        let service = NativeSocketService(
            policy: OriginPolicy(origin: URL(string: "https://127.0.0.1:\(port)")!),
            cookieValue: "test-cookie",
            fingerprint: fingerprint
        ) { event in
            recorder.append(event)
            // Hop queues like the page adapter; never re-enter the service
            // synchronously from its own emit.
            DispatchQueue.global().async {
                guard let service = wiring.service, let onEvent = wiring.onEvent else { return }
                onEvent(event, service)
            }
        }
        self.service = service
        wiring.service = service
    }

    static func command(id: String, op: String, data: String? = nil, url: String? = nil, reason: String? = nil) -> String {
        var object: [String: Any] = ["id": id, "op": op]
        if let data { object["data"] = data }
        if let url { object["url"] = url }
        if let reason { object["reason"] = reason }
        let encoded = (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
        return String(data: encoded, encoding: .utf8) ?? "{}"
    }

    func waitUntil(
        _ description: String,
        timeout: TimeInterval = 10,
        _ predicate: @escaping ([NativeSocketService.Event]) -> Bool
    ) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if predicate(recorder.snapshot) { return }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTFail("timed out waiting for \(description); events: \(recorder.snapshot)")
    }
}

/// Thread-safe event recorder shared by sink closures and assertions.
private final class EventRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [NativeSocketService.Event] = []

    func append(_ event: NativeSocketService.Event) {
        lock.lock()
        items.append(event)
        lock.unlock()
    }

    var snapshot: [NativeSocketService.Event] {
        lock.lock()
        defer { lock.unlock() }
        return items
    }
}
