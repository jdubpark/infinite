// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "InfiniteDesktop",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "InfiniteDesktop", targets: ["InfiniteDesktop"])],
    targets: [
        .target(name: "InfiniteAtomics"),
        .target(name: "InfiniteCore", dependencies: ["InfiniteAtomics"]),
        .executableTarget(name: "InfiniteDesktop", dependencies: ["InfiniteCore", "InfiniteAtomics"], resources: [.copy("Resources")]),
        .testTarget(name: "InfiniteCoreTests", dependencies: ["InfiniteCore"]),
        .testTarget(name: "InfiniteDesktopTests", dependencies: ["InfiniteDesktop"]),
    ],
    swiftLanguageModes: [.v5]
)
