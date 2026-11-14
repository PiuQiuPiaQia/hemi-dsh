/** In-memory credential store and URLProtocol mock shared by Core tests. */

import Foundation
import XCTest
@testable import HemiMobileCore

final class MemoryCredentialStore: CredentialStore {
    private let lock = NSLock()
    private var items: [String: Data] = [:]

    func read(account: String) throws -> Data? {
        lock.lock(); defer { lock.unlock() }
        return items[account]
    }

    func write(account: String, _ data: Data?) throws {
        lock.lock(); defer { lock.unlock() }
        if let data = data { items[account] = data } else { items.removeValue(forKey: account) }
    }
}

/// URLProtocol mock capturing request bodies; HTTP bodies arrive as a stream.
final class MockURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest, Data?) throws -> (Int, [String: String], Data))?
    nonisolated(unsafe) static var requests: [(URLRequest, Data?)] = []

    static func reset() {
        handler = nil
        requests = []
    }

    static func makeConfiguration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        return configuration
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let body = MockURLProtocol.readBody(of: request)
        MockURLProtocol.requests.append((request, body))
        guard let handler = MockURLProtocol.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        do {
            let (status, headers, data) = try handler(request, body)
            let response = HTTPURLResponse(
                url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}

    static func readBody(of request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let bufferSize = 4096
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
        defer { buffer.deallocate() }
        while stream.hasBytesAvailable {
            let read = stream.read(buffer, maxLength: bufferSize)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}

func makeInvite(origin: String = "https://192.168.1.4:4317", origins: [String]? = nil) throws -> MobileInvitation {
    let expiresAt = Date().timeIntervalSince1970 * 1000 + 10 * 60 * 1000
    var originsField = ""
    if let origins {
        let list = origins.map { "\"\($0)\"" }.joined(separator: ",")
        originsField = ",\"origins\":[\(list)]"
    }
    let text = """
    {"kind":"hemi-dsh-mobile","version":1,"origin":"\(origin)"\(originsField),"fingerprint":"\(String(repeating: "ab", count: 32))","token":"\(String(repeating: "c", count: 43))","expiresAt":\(expiresAt)}
    """
    guard case .success(let invite) = parseInvitation(text) else {
        throw XCTSkip("fixture invite must parse")
    }
    return invite
}
