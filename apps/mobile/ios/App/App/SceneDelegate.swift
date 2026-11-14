/**
 * Scene delegate, borrowed from the previous Hemi shell's `SceneDelegate.swift`
 * minus Capacitor, plus background/forwarding hooks for the remote bridge.
 */

import UIKit

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    var coordinator: RootCoordinator?

    func scene(
        _ scene: UIScene, willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let coordinator = RootCoordinator()
        self.coordinator = coordinator
        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = coordinator.rootController
        window?.makeKeyAndVisible()
        coordinator.start()
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        coordinator?.remoteDidBecomeActive()
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        coordinator?.remoteDidEnterBackground()
    }
}
