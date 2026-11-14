/**
 * Origin resolution against the real self-signed TLS fixture: the wrong-pin
 * and wrong-endpoint candidates fail over the real transport, without blocking
 * a later candidate answered by the mock. The selective URLProtocol yields
 * loopback hosts to the system TLS stack.
 *
 * Child processes are owned: the spawned server is terminated and reaped in
 * teardown; certificates live in a per-test temporary directory.
 */

import Foundation
import XCTest
@testable import HemiMobileCore

/// Mock answering only non-loopback hosts; loopback falls through to the real TLS loader.
final class SelectiveMockURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) -> (Int, [String: String], Data))?

    static func reset() {
        handler = nil
    }

    static func makeConfiguration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SelectiveMockURLProtocol.self]
        return configuration
    }

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host != "127.0.0.1"
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = SelectiveMockURLProtocol.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        let (status, headers, data) = handler(request)
        let response = HTTPURLResponse(
            url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class OriginResolverRealTLSTests: XCTestCase {
    private var server: Process?
    private var serverPipe: Pipe?
    private var serverOutput = ""
    private let outputLock = NSLock()
    private var workDirectory: URL?
    private var port = 0
    private var pin = ""

    override func setUpWithError() throws {
        try super.setUpWithError()
        SelectiveMockURLProtocol.reset()
        guard let python = Self.firstExisting(["/usr/bin/python3", "/opt/homebrew/bin/python3"]),
              let openssl = Self.firstExisting(["/opt/homebrew/bin/openssl", "/usr/bin/openssl"]) else {
            throw XCTSkip("python3 and openssl are required for the real-network resolver tests")
        }
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("hemi-dsh-mobile-resolver-tests-\(UUID().uuidString)", isDirectory: true)
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

        let script = URL(fileURLWithPath: #filePath)  // …/Tests/HemiMobileCoreTests/OriginResolverRealTLSTests.swift
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
        SelectiveMockURLProtocol.reset()
        super.tearDown()
    }

    // MARK: - Tests

    func testWrongPinCandidateFailsClosedWithoutBlockingLaterCandidate() async throws {
        var flipped = pin
        flipped.replaceSubrange(flipped.startIndex...flipped.startIndex, with: pin.first == "0" ? "1" : "0")
        let realOrigin = URL(string: "https://127.0.0.1:\(port)")!
        let mockOrigin = URL(string: "https://10.0.0.7:4317")!
        // Built directly: the fixture listens on loopback, which the wire rules
        // keep out of invitations; the resolver only probes what it is given.
        let invite = MobileInvitation(
            origin: realOrigin,
            fingerprint: flipped,
            token: String(repeating: "c", count: 43),
            expiresAt: Date().timeIntervalSince1970 * 1000 + 600_000,
            origins: [realOrigin, mockOrigin]
        )
        SelectiveMockURLProtocol.handler = { _ in (401, [:], Data(#"{"error":"unauthorized"}"#.utf8)) }
        let client = PairingClient(fingerprint: flipped, configuration: SelectiveMockURLProtocol.makeConfiguration())

        let resolved = try await client.resolveInvitation(invite)

        XCTAssertEqual(resolved.origin, mockOrigin)
        XCTAssertEqual(resolved.origins, [mockOrigin, realOrigin])
        // The wrong-pin probe must fail before any HTTP request reaches the server.
        let sawProbe = try await waitServerLog(containing: "GET /mobile/session", timeout: 1)
        XCTAssertFalse(sawProbe, "wrong-pin probe must never complete an HTTP request")
    }

    func testCorrectPinButWrongEndpointAnswerIsNotSuccess() async throws {
        let realOrigin = URL(string: "https://127.0.0.1:\(port)")!
        let invite = MobileInvitation(
            origin: realOrigin,
            fingerprint: pin,
            token: String(repeating: "c", count: 43),
            expiresAt: Date().timeIntervalSince1970 * 1000 + 600_000,
            origins: [realOrigin, URL(string: "https://10.0.0.7:4317")!]
        )
        // The fixture answers 404 for the probe path; the mock side fails too.
        SelectiveMockURLProtocol.handler = { _ in (404, [:], Data()) }
        let client = PairingClient(fingerprint: pin, configuration: SelectiveMockURLProtocol.makeConfiguration())

        do {
            _ = try await client.resolveInvitation(invite)
            XCTFail("expected unreachable failure")
        } catch let error as PairingFailure {
            guard case .unreachable = error else { return XCTFail("expected unreachable, got \(error)") }
        }
        // The probe really crossed TLS: the pinned server saw the request line.
        let sawProbe = try await waitServerLog(containing: "GET /mobile/session", timeout: 5)
        XCTAssertTrue(sawProbe, "probe must reach the real fixture; server log: \(serverSnapshot())")
    }

    // MARK: - Helpers

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
            throw NSError(domain: "OriginResolverRealTLSTests", code: Int(process.terminationStatus))
        }
        return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    }
}
