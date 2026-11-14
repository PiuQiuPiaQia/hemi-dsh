/**
 * Keychain-backed credential store. Borrowed from the previous Hemi shell's
 * `HemiKeychainStore` (`HemiDeviceClient.swift` lines 45-62 in the old
 * repository): update-then-add, `WhenUnlockedThisDeviceOnly`, delete on nil.
 */

import Foundation
import Security

public enum KeychainFailure: Error, Equatable, Sendable {
    case read
    case write
    case delete
}

public protocol CredentialStore: Sendable {
    func read(account: String) throws -> Data?
    func write(account: String, _ data: Data?) throws
}

/** Generic-password Keychain store for one service. */
public struct KeychainStore: CredentialStore {
    public let service: String

    /** @param service - Keychain service name; the shell uses its bundle id. */
    public init(service: String = "ai.hemi.dsh.mobile") {
        self.service = service
    }

    private func query(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    public func read(account: String) throws -> Data? {
        var search = query(account)
        search[kSecReturnData as String] = true
        search[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(search as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainFailure.read }
        return item as? Data
    }

    public func write(account: String, _ data: Data?) throws {
        let base = query(account)
        guard let data = data else {
            let status = SecItemDelete(base as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainFailure.delete }
            return
        }
        let changes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        let status = SecItemUpdate(base as CFDictionary, changes as CFDictionary)
        if status == errSecItemNotFound {
            var add = base
            changes.forEach { add[$0.key] = $0.value }
            guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { throw KeychainFailure.write }
        } else if status != errSecSuccess {
            throw KeychainFailure.write
        }
    }
}

/** Keychain codec for the single stored session. */
public enum SessionStore {
    public static let account = "session"

    /**
     * Load the persisted session, if any.
     *
     * @param store - credential store backing the session slot.
     * @throws `KeychainFailure.read` when the entry exists but does not decode;
     * callers surface that instead of treating corruption as "no session".
     */
    public static func load(_ store: CredentialStore = KeychainStore()) throws -> SessionSecret? {
        guard let data = try store.read(account: account) else { return nil }
        guard let value = try? JSONDecoder().decode(SessionSecret.self, from: data) else {
            throw KeychainFailure.read
        }
        return value
    }

    /** Persist or clear the session slot. */
    public static func save(_ value: SessionSecret?, to store: CredentialStore = KeychainStore()) throws {
        let data = try value.map { try JSONEncoder().encode($0) }
        try store.write(account: account, data)
    }
}
