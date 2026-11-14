// swift-tools-version:5.9
// Shared logic for the Hemi DSH iOS shell. No UI, no WebKit: everything here
// is unit-testable on the host with `swift test` from apps/mobile.
import PackageDescription

let package = Package(
    name: "HemiMobileCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "HemiMobileCore", targets: ["HemiMobileCore"]),
    ],
    targets: [
        .target(name: "HemiMobileCore"),
        .testTarget(name: "HemiMobileCoreTests", dependencies: ["HemiMobileCore"]),
    ]
)
