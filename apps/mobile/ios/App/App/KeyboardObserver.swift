/**
 * Keyboard inset adaptation for the connect screen's scroll view, matching the
 * keyboard handling the previous Hemi shell tuned (no native WebView resize;
 * the shell keeps inputs above the keyboard with content insets).
 */

import UIKit

final class KeyboardObserver {
    private let scrollView: UIScrollView
    private weak var owningView: UIView?
    private var observer: (NotificationCenter, NSObjectProtocol)?

    init(scrollView: UIScrollView, owningView: UIView) {
        self.scrollView = scrollView
        self.owningView = owningView
        let center = NotificationCenter.default
        let token = center.addObserver(
            forName: UIResponder.keyboardWillChangeFrameNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            self?.keyboardWillChange(notification)
        }
        self.observer = (center, token)
    }

    deinit {
        if let (center, token) = observer {
            center.removeObserver(token)
        }
    }

    private func keyboardWillChange(_ notification: Notification) {
        guard let view = owningView,
              let frame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect,
              let duration = notification.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double
        else { return }
        let converted = view.convert(frame, from: view.window)
        let overlap = max(0, view.bounds.maxY - converted.minY)
        let extra = overlap > 0 ? overlap + 12 : 0
        UIView.animate(withDuration: duration) { [scrollView] in
            scrollView.contentInset.bottom = extra
            scrollView.verticalScrollIndicatorInsets.bottom = extra
        }
    }
}
