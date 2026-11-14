/** Sheet for pasting an invitation JSON by hand. 16pt mono input, paste assist. */

import UIKit

final class ManualInviteController: UIViewController, UITextViewDelegate {
    private let text = UITextView()
    private let onParse: (String) -> Void

    init(onParse: @escaping (String) -> Void) {
        self.onParse = onParse
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = L10n.t(.manualTitle)
        view.backgroundColor = .systemBackground
        Style.applyMonochromeTint(to: view)
        navigationItem.leftBarButtonItem = UIBarButtonItem(
            title: L10n.t(.cancel), style: .plain,
            target: self, action: #selector(close)
        )
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            title: L10n.t(.parse), style: .done,
            target: self, action: #selector(parse)
        )

        text.font = .monospacedSystemFont(ofSize: 16, weight: .regular)
        text.adjustsFontForContentSizeCategory = true
        text.autocapitalizationType = .none
        text.autocorrectionType = .no
        text.smartQuotesType = .no
        text.smartDashesType = .no
        text.layer.borderColor = UIColor.separator.cgColor
        text.layer.borderWidth = 1
        text.layer.cornerRadius = 10
        text.delegate = self
        text.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(text)

        let paste = Style.secondaryButton(title: L10n.t(.paste)) { [weak self] _ in
            guard let value = UIPasteboard.general.string, !value.isEmpty else { return }
            self?.text.text = value
        }
        paste.heightAnchor.constraint(equalToConstant: 44).isActive = true
        paste.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(paste)

        NSLayoutConstraint.activate([
            text.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            text.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
            text.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
            text.heightAnchor.constraint(equalToConstant: 160),
            paste.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            paste.topAnchor.constraint(equalTo: text.bottomAnchor, constant: 12),
        ])
    }

    @objc private func close() {
        dismiss(animated: true)
    }

    @objc private func parse() {
        let value = text.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        dismiss(animated: true) { [onParse] in
            onParse(value)
        }
    }
}
