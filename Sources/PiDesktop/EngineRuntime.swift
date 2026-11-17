import Foundation

final class EngineRuntime {
    private let bundleURL: URL
    private let bundleReference: NSURL?
    private var directory: URL?
    private var publishedPath: String?

    init(bundleURL: URL) {
        self.bundleURL = bundleURL
        bundleReference = (bundleURL as NSURL).fileReferenceURL() as NSURL?
    }

    private var currentBundle: URL {
        (bundleReference?.filePathURL ?? bundleURL).resolvingSymlinksInPath()
    }

    func extensionURL() throws -> URL {
        let name = "permission-modes.mjs"
        if let directory { return directory.appendingPathComponent(name) }

        // Pi loads its extension once, but launches the sandbox worker by path for each tool call.
        let files = FileManager.default
        let source = currentBundle.appendingPathComponent("Contents/Resources/Engine", isDirectory: true)
        let stage = files.temporaryDirectory
            .appendingPathComponent("pi-desktop-engine-\(UUID().uuidString)", isDirectory: true)
        try files.createDirectory(at: stage, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        do {
            // Keep the path identical to the one Node reports for the extension, including the /private prefix.
            guard let resolvedPath = realpath(stage.path, nil) else {
                throw DesktopError.message("无法解析 Pi 的沙箱组件目录。")
            }
            defer { free(resolvedPath) }
            let runtime = URL(fileURLWithPath: String(cString: resolvedPath), isDirectory: true)
            for asset in try files.contentsOfDirectory(at: source, includingPropertiesForKeys: nil, options: .skipsHiddenFiles) {
                try files.copyItem(at: asset, to: runtime.appendingPathComponent(asset.lastPathComponent))
            }
            let entry = runtime.appendingPathComponent(name)
            guard files.fileExists(atPath: entry.path) else {
                throw DesktopError.message("Pi 的权限模式组件缺失。")
            }
            directory = runtime
            try refreshBundleLocation()
            return entry
        } catch {
            try? files.removeItem(at: stage)
            directory = nil
            throw error
        }
    }

    func refreshBundleLocation() throws {
        guard let directory else { return }
        let current = currentBundle.path
        let path = FileManager.default.fileExists(atPath: current) ? current : ""
        guard path != publishedPath else { return }
        try path.write(to: directory.appendingPathComponent(".bundle-location"), atomically: true, encoding: .utf8)
        publishedPath = path
    }

    func remove() {
        guard let directory else { return }
        try? FileManager.default.removeItem(at: directory)
        self.directory = nil
        publishedPath = nil
    }
}
