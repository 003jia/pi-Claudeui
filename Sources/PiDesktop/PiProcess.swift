import Foundation

enum DesktopError: LocalizedError {
    case message(String)

    var errorDescription: String? {
        switch self {
        case .message(let text): return text
        }
    }
}

struct PiInstallation {
    let home = FileManager.default.homeDirectoryForCurrentUser
    var environment = ProcessInfo.processInfo.environment

    init() {
        let paths = (environment["PATH"] ?? "").split(separator: ":").map(String.init)
        let fallbacks = ["/opt/homebrew/bin", "/usr/local/bin", home.appendingPathComponent(".local/bin").path,
                         home.appendingPathComponent(".pi/agent/bin").path, "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        var seen = Set<String>()
        environment["PATH"] = (paths + fallbacks).filter { $0.hasPrefix("/") && seen.insert($0).inserted }.joined(separator: ":")
        environment["NO_COLOR"] = "1"
    }

    func executable() throws -> URL {
        for directory in (environment["PATH"] ?? "").split(separator: ":") {
            let url = URL(fileURLWithPath: String(directory), isDirectory: true).appendingPathComponent("pi")
            if FileManager.default.isExecutableFile(atPath: url.path) {
                return url
            }
        }
        throw DesktopError.message("找不到本机的 pi 命令。请确认终端里可以运行 pi，再重试。")
    }

    func sessionRoot(for folder: URL) -> URL {
        let agent = environment["PI_CODING_AGENT_DIR"].flatMap { $0.isEmpty ? nil : $0 }
            .map { absolutePath($0, relativeTo: home) } ?? home.appendingPathComponent(".pi/agent")
        if let override = environment["PI_CODING_AGENT_SESSION_DIR"], !override.isEmpty {
            return absolutePath(override, relativeTo: folder)
        }

        for settings in [folder.appendingPathComponent(".pi/settings.json"), agent.appendingPathComponent("settings.json")] {
            if let data = try? Data(contentsOf: settings),
               let file = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
               let directory = file["sessionDir"] as? String, !directory.isEmpty {
                return absolutePath(directory, relativeTo: folder)
            }
        }
        return agent.appendingPathComponent("sessions", isDirectory: true)
    }

    private func absolutePath(_ path: String, relativeTo folder: URL) -> URL {
        let expanded = (path as NSString).expandingTildeInPath
        if expanded.hasPrefix("/") { return URL(fileURLWithPath: expanded, isDirectory: true) }
        return folder.appendingPathComponent(expanded, isDirectory: true).standardizedFileURL
    }
}

final class PiProcess {
    private let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    private let diagnostics = Pipe()
    private let writers = DispatchQueue(label: "local.pi-desktop.stdin")
    private let readers = DispatchQueue(label: "local.pi-desktop.readers")
    private var partialLine = Data()
    private var stderr = Data()
    private var readEnd = false
    private var diagnosticEnd = false
    private var exitStatus: Int32?
    private var inputClosed = false

    private let onLines: ([String]) -> Void
    private let onExit: (Int32, String) -> Void

    init(installation: PiInstallation, folder: URL, session: String?, permissionExtension: URL,
         onLines: @escaping ([String]) -> Void, onExit: @escaping (Int32, String) -> Void) throws {
        self.onLines = onLines
        self.onExit = onExit
        process.executableURL = try installation.executable()
        process.currentDirectoryURL = folder
        process.environment = installation.environment
        process.arguments = ["--mode", "rpc", "--extension", permissionExtension.path] +
            (session.map { ["--session", $0] } ?? [])
        process.standardInput = input
        process.standardOutput = output
        process.standardError = diagnostics
        process.terminationHandler = { [weak self] process in
            let status = process.terminationStatus
            self?.readers.async { [weak self] in
                self?.exitStatus = status
                self?.deliverExit()
            }
        }

        try process.run()
        read(output.fileHandleForReading) { [weak self] in self?.receiveOutput($0) }
        read(diagnostics.fileHandleForReading) { [weak self] in self?.receiveDiagnostics($0) }
    }

    func send(_ record: [String: Any], completion: @escaping (String?) -> Void) {
        guard let json = try? JSONSerialization.data(withJSONObject: record) else {
            completion("无法将指令发送给 Pi。")
            return
        }
        writers.async {
            var error: String?
            do {
                guard !self.inputClosed else { throw DesktopError.message("Pi 已断开连接。") }
                try self.input.fileHandleForWriting.write(contentsOf: json + Data([0x0a]))
            } catch let failure {
                error = failure.localizedDescription
            }
            DispatchQueue.main.async { completion(error) }
        }
    }

    func close(abort: Bool = false) {
        writers.async {
            guard !self.inputClosed else { return }
            self.inputClosed = true
            if abort {
                try? self.input.fileHandleForWriting.write(contentsOf: Data("{\"type\":\"abort\"}\n".utf8))
            }
            try? self.input.fileHandleForWriting.close()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            guard let self, self.process.isRunning else { return }
            self.process.terminate()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
            guard let self, self.process.isRunning else { return }
            // The child can still be stuck inside an extension after SIGTERM.
            self.process.terminate()
        }
    }

    private func read(_ handle: FileHandle, receive: @escaping (Data) -> Void) {
        handle.readabilityHandler = { [weak self] handle in
            let bytes = handle.availableData
            if bytes.isEmpty { handle.readabilityHandler = nil }
            self?.readers.async { receive(bytes) }
        }
    }

    private func receiveOutput(_ chunk: Data) {
        if chunk.isEmpty { readEnd = true }
        partialLine.append(chunk)
        var lines: [String] = []
        var start = partialLine.startIndex
        while let end = partialLine[start...].firstIndex(of: 0x0a) {
            lines.append(String(decoding: partialLine[start..<end], as: UTF8.self))
            start = partialLine.index(after: end)
        }
        partialLine.removeSubrange(partialLine.startIndex..<start)
        if !lines.isEmpty { DispatchQueue.main.async { self.onLines(lines) } }
        deliverExit()
    }

    private func receiveDiagnostics(_ chunk: Data) {
        if chunk.isEmpty { diagnosticEnd = true }
        stderr.append(chunk)
        if stderr.count > 4096 { stderr.removeFirst(stderr.count - 4096) }
        deliverExit()
    }

    private func deliverExit() {
        guard readEnd, diagnosticEnd, let exitStatus else { return }
        self.exitStatus = nil
        let text = String(decoding: stderr, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        DispatchQueue.main.async { self.onExit(exitStatus, text) }
    }
}
