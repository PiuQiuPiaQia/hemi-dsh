/** Locale-owned UI copy: every product string resolves through this type. */

import Foundation

enum L10n {
    static var isChinese: Bool {
        Bundle.main.preferredLocalizations.first?.hasPrefix("zh") ?? false
    }

    static func t(_ key: Key) -> String {
        isChinese ? key.chinese : key.english
    }

    struct Key {
        let chinese: String
        let english: String

        init(_ chinese: String, _ english: String) {
            self.chinese = chinese
            self.english = english
        }

        static let appTitle = Key("Hemi DSH", "Hemi DSH")
        static let connectTitle = Key("连接电脑", "Connect a computer")
        static let savedSection = Key("已配对电脑", "Paired computer")
        static let connect = Key("连接", "Connect")
        static let forget = Key("忘记此设备", "Forget this device")
        static let forgetConfirmTitle = Key("忘记配对？", "Forget pairing?")
        static let forgetConfirmMessage = Key("电脑将无法再识别此设备，重新连接需要新的邀请码。", "The computer will no longer recognize this device; reconnecting needs a new invitation.")
        static let forgetConfirmAction = Key("忘记", "Forget")
        static let scanAction = Key("扫码连接", "Scan pairing code")
        static let manualAction = Key("改用粘贴邀请码", "Paste an invitation instead")
        static let manualTitle = Key("粘贴邀请 JSON", "Paste invitation JSON")
        static let paste = Key("粘贴", "Paste")
        static let parse = Key("解析", "Parse")
        static let cancel = Key("取消", "Cancel")
        static let requesting = Key("正在发送配对请求…", "Sending pairing request…")
        static let pendingHint = Key("核对两端代码一致后，在电脑上确认", "If both codes match, confirm on your computer")
        static let rejectedTitle = Key("电脑拒绝了连接，请重新扫码", "The computer declined. Scan a new code to connect.")
        static let expiredTitle = Key("配对请求已过期，请重新扫码", "The pairing request expired. Scan a new code.")
        static let revokedMessage = Key("配对已被撤销，请重新扫码配对。", "Pairing was revoked. Scan a new invitation to pair again.")
        static let certChanged = Key("服务器证书已变化，为安全起见已断开，请重新配对。", "The server certificate changed. Disconnected for safety; pair again.")
        static let networkUnknown = Key("未能确认连接结果，请检查网络", "Could not confirm the connection. Check your network.")
        static let pairingStatusUnknown = Key("尚未确认配对结果，请继续确认", "Pairing is not confirmed. Continue checking.")
        static let retry = Key("重试", "Retry")
        static let invalidInvite = Key("这不是有效的 Hemi DSH 邀请，或已过期。", "Not a valid Hemi DSH invitation, or it already expired.")
        static let cameraDenied = Key("请在系统设置中允许 Hemi DSH 使用相机。", "Allow Hemi DSH to use the camera in Settings.")
        static let scannerTitle = Key("扫描电脑上的配对码", "Scan the code on your computer")
        static let scannerCancel = Key("取消", "Cancel")
        static let scannerUnavailable = Key("无法打开相机，请关闭其他使用相机的应用后重试。", "Could not open the camera. Close other camera apps and retry.")
        static let loadingSession = Key("正在连接电脑…", "Connecting to the computer…")
        static let back = Key("返回", "Back")
        static let ok = Key("好", "OK")
        static let refusedTitle = Key("电脑拒绝了配对请求", "The computer refused the pairing request")
        static let checkingStatus = Key("正在确认配对结果…", "Confirming the pairing result…")
        static let resumeStatus = Key("继续确认", "Continue checking")
        static let serverUnreachable = Key("无法连接电脑，请确认在同一 Wi-Fi 且电脑已启动。", "Could not reach the computer. Check the shared Wi-Fi and that the computer is running.")
        static let storageFailure = Key("无法清除本机连接信息，请稍后重试。", "Could not clear the stored pairing. Try again later.")
    }

    /** Format an epoch-ms expiry as a short local timestamp. */
    static func expiryText(_ epochMs: Double) -> String {
        let date = Date(timeIntervalSince1970: epochMs / 1000)
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .medium
        return formatter.string(from: date)
    }
}
