/**
 * QR scanner controller borrowed from the previous Hemi shell's
 * `HemiScannerController` (`HemiBotPlugin.swift` lines 243-281 in the old
 * repository), with localized copy. One shot, camera only, ≤4096 bytes.
 */

import AVFoundation
import UIKit

final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    private let capture = AVCaptureSession()
    private let queue = DispatchQueue(label: "ai.hemi.dsh.mobile.scanner")
    private var preview: AVCaptureVideoPreviewLayer?
    private var completed = false
    private let completion: (String?, String?) -> Void

    init(completion: @escaping (String?, String?) -> Void) {
        self.completion = completion
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        let preview = AVCaptureVideoPreviewLayer(session: capture)
        preview.videoGravity = .resizeAspectFill
        view.layer.addSublayer(preview)
        self.preview = preview

        let cancel = UIButton(type: .system)
        cancel.setTitle(L10n.t(.scannerCancel), for: .normal)
        cancel.tintColor = .white
        cancel.titleLabel?.font = .systemFont(ofSize: 17)
        cancel.addTarget(self, action: #selector(cancelScan), for: .touchUpInside)
        cancel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(cancel)

        let text = UILabel()
        text.text = L10n.t(.scannerTitle)
        text.textColor = .white
        text.font = .systemFont(ofSize: 16)
        text.textAlignment = .center
        text.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(text)

        NSLayoutConstraint.activate([
            cancel.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            cancel.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            cancel.widthAnchor.constraint(greaterThanOrEqualToConstant: 60),
            cancel.heightAnchor.constraint(equalToConstant: 44),
            text.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            text.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
            text.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -40),
        ])

        queue.async {
            do {
                guard let device = AVCaptureDevice.default(for: .video) else {
                    throw HemiDeviceError.message(L10n.t(.scannerUnavailable))
                }
                let input = try AVCaptureDeviceInput(device: device)
                let output = AVCaptureMetadataOutput()
                self.capture.beginConfiguration()
                guard self.capture.canAddInput(input), self.capture.canAddOutput(output) else {
                    self.capture.commitConfiguration()
                    throw HemiDeviceError.message(L10n.t(.scannerUnavailable))
                }
                self.capture.addInput(input)
                self.capture.addOutput(output)
                output.setMetadataObjectsDelegate(self, queue: .main)
                output.metadataObjectTypes = [.qr]
                self.capture.commitConfiguration()
                self.capture.startRunning()
            } catch {
                DispatchQueue.main.async { self.finish(nil, L10n.t(.scannerUnavailable)) }
            }
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        queue.async { self.capture.stopRunning() }
    }

    @objc private func cancelScan() {
        finish(nil, nil)
    }

    private func finish(_ value: String?, _ error: String?) {
        guard !completed else { return }
        completed = true
        queue.async { self.capture.stopRunning() }
        completion(value, error)
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard let value = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }
        guard value.utf8.count <= 4096 else {
            finish(nil, L10n.t(.invalidInvite))
            return
        }
        finish(value, nil)
    }
}

enum HemiDeviceError: LocalizedError {
    case message(String)

    var errorDescription: String? {
        if case let .message(text) = self { return text }
        return nil
    }
}
