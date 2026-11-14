/** Owns the connect screen ↔ remote screen transition and lifecycle forwarding. */

import UIKit
import HemiMobileCore

final class RootCoordinator {
    let rootController: UINavigationController
    private var remote: RemoteWebViewController?

    init() {
        rootController = UINavigationController(rootViewController: ConnectFlowViewController())
        rootController.navigationBar.prefersLargeTitles = true
    }

    func start() {}

    func openRemote(session: SessionSecret) {
        let controller = RemoteWebViewController(session: session)
        remote = controller
        rootController.pushViewController(controller, animated: true)
    }

    func remoteDidBecomeActive() {
        remote?.bridgeDidBecomeActive()
    }

    func remoteDidEnterBackground() {
        remote?.bridgeDidEnterBackground()
    }

    /**
     * The remote screen closed itself. Pops it and, for fail-closed paths,
     * explains why on the connect screen.
     */
    func remoteDidClose(_ controller: RemoteWebViewController, message: String? = nil) {
        if remote === controller {
            remote = nil
        }
        let pop = { [rootController] in
            if controller.isViewLoaded, controller.view.window != nil {
                rootController.popToRootViewController(animated: true)
            }
        }
        guard let message else {
            pop()
            return
        }
        let alert = UIAlertController(title: L10n.t(.appTitle), message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: L10n.t(.ok), style: .default))
        pop()
        rootController.present(alert, animated: true)
    }
}
