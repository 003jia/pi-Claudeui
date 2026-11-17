import Foundation

struct SessionHistory {
    private let keys: Set<URLResourceKey> = [.isRegularFileKey, .isSymbolicLinkKey, .contentModificationDateKey]

    func recent(in directory: URL) -> [[String: String]] {
        let files = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: Array(keys),
                                                   options: [.skipsHiddenFiles, .skipsPackageDescendants])
        var candidates: [(url: URL, modified: Date)] = []
        while let url = files?.nextObject() as? URL {
            guard url.pathExtension == "jsonl",
                  let attrs = try? url.resourceValues(forKeys: keys),
                  attrs.isRegularFile == true, attrs.isSymbolicLink != true else { continue }
            candidates.append((url, attrs.contentModificationDate ?? .distantPast))
        }
        return candidates.sorted { $0.modified > $1.modified }.prefix(80).compactMap { preview($0.url) }
    }

    private func preview(_ file: URL) -> [String: String]? {
        guard let reader = try? FileHandle(forReadingFrom: file) else { return nil }
        defer { try? reader.close() }
        guard let bytes = try? reader.read(upToCount: 512 * 1024) else { return nil }
        let lines = bytes.split(separator: 0x0a)
        guard let first = lines.first, let header = object(first),
              header["type"] as? String == "session",
              let folder = header["cwd"] as? String, folder.hasPrefix("/") else { return nil }

        var name: String?
        var prompt: String?
        for line in lines.dropFirst() {
            guard let entry = object(line) else { continue }
            if entry["type"] as? String == "session_info" { name = entry["name"] as? String }
            guard prompt == nil, let message = entry["message"] as? [String: Any],
                  message["role"] as? String == "user" else { continue }
            prompt = (message["content"] as? String) ??
                (message["content"] as? [[String: Any]])?.compactMap { $0["text"] as? String }.joined(separator: " ")
        }
        let display = prompt?.components(separatedBy: "\n\n[Pi Desktop 文件附件]\n").first
        let title = (name ?? display ?? "").split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return ["path": file.path, "folder": folder, "title": title.isEmpty ? "未命名会话" : String(title.prefix(110))]
    }

    private func object(_ bytes: Data.SubSequence) -> [String: Any]? {
        (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any]
    }
}
