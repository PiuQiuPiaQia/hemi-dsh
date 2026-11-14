/**
 * App-owned monochrome palette (the Hemi default is black/white, not the
 * UIKit system blue). Dynamic pairs flip with Dark Mode; error text stays
 * `systemRed`. Per-control application only — no global appearance proxies.
 */

import UIKit

enum Style {
    /// Ink: black in light mode, white in dark mode.
    static var ink: UIColor {
        UIColor { trait in
            trait.userInterfaceStyle == .dark ? .white : .black
        }
    }

    /// Paper: the ink counterpart background.
    static var paper: UIColor {
        UIColor { trait in
            trait.userInterfaceStyle == .dark ? .black : .white
        }
    }

    /** Filled primary button: ink background, paper label. 44px+ targets. */
    static func primaryButton(title: String, handler: @escaping UIActionHandler) -> UIButton {
        let button = UIButton(configuration: .filled(), primaryAction: UIAction(title: title, handler: handler))
        button.configuration?.baseBackgroundColor = ink
        button.configuration?.baseForegroundColor = paper
        button.configuration?.cornerStyle = .medium
        return button
    }

    /** Secondary button: paper background, ink label and border. */
    static func secondaryButton(title: String, handler: @escaping UIActionHandler) -> UIButton {
        let button = UIButton(configuration: .tinted(), primaryAction: UIAction(title: title, handler: handler))
        button.configuration?.baseBackgroundColor = paper
        button.configuration?.baseForegroundColor = ink
        button.configuration?.background.strokeColor = ink
        button.configuration?.background.strokeWidth = 1
        button.configuration?.cornerStyle = .medium
        return button
    }

    /** Apply the monochrome tint to a screen (buttons adopt it). */
    static func applyMonochromeTint(to view: UIView) {
        view.tintColor = ink
    }
}
