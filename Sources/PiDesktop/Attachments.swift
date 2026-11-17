import AppKit
import ImageIO
import PDFKit
import UniformTypeIdentifiers

enum AttachmentReader {
    static let countLimit = 4
    private static let byteLimit = 8 * 1024 * 1024
    private static let textLimit = 64_000
    private static let imageTypes = [
        UTType.png.identifier: "image/png", UTType.jpeg.identifier: "image/jpeg",
        UTType.gif.identifier: "image/gif", UTType.webP.identifier: "image/webp"
    ]

    static func read(_ url: URL) throws -> [String: String] {
        let name = url.lastPathComponent
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard values.isRegularFile == true else { throw DesktopError.message("请选择单个文件。") }
        guard let size = values.fileSize, size <= byteLimit else { throw DesktopError.message("单个附件最大为 8 MB。") }
        let file = try FileHandle(forReadingFrom: url)
        defer { try? file.close() }
        let bytes = try file.read(upToCount: byteLimit + 1) ?? Data()
        guard bytes.count <= byteLimit else { throw DesktopError.message("单个附件最大为 8 MB。") }

        if let source = CGImageSourceCreateWithData(bytes as CFData, nil), CGImageSourceGetCount(source) > 0,
           let type = CGImageSourceGetType(source) as String?,
           UTType(type)?.conforms(to: .image) == true {
            let (data, mimeType) = try imageData(source, original: bytes, identifier: type)
            return ["type": "image", "name": name, "data": data.base64EncodedString(), "mimeType": mimeType]
        }

        let text: String?
        switch url.pathExtension.lowercased() {
        case "pdf":
            text = try pdfText(bytes)
        case "docx":
            text = try documentText(bytes, type: .officeOpenXML)
        case "rtf":
            text = try documentText(bytes, type: .rtf)
        default:
            if UTType(filenameExtension: url.pathExtension)?.conforms(to: .image) == true {
                throw DesktopError.message("无法解码这张图片。")
            }
            if bytes.starts(with: [0xff, 0xfe]) || bytes.starts(with: [0xfe, 0xff]) {
                text = String(data: bytes, encoding: .utf16)
            } else {
                text = String(data: bytes, encoding: .utf8)
            }
        }
        guard let text, !text.contains("\0") else {
            throw DesktopError.message("支持图片、文本、PDF、DOCX 和 RTF 文件。")
        }
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw DesktopError.message("这份文件没有可提取的文字。")
        }
        guard text.count <= textLimit else { throw DesktopError.message("文件正文超过 64,000 个字符。") }
        return ["type": "file", "name": name, "text": text]
    }

    private static func imageData(_ source: CGImageSource, original: Data, identifier: String) throws -> (Data, String) {
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int, width > 0, height > 0 else {
            throw DesktopError.message("无法解码这张图片。")
        }
        if max(width, height) <= 1600, let mime = imageTypes[identifier] { return (original, mime) }
        let options = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                       kCGImageSourceThumbnailMaxPixelSize: 1600] as [CFString: Any]
        let converted = NSMutableData()
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary),
              let encoder = CGImageDestinationCreateWithData(converted, UTType.png.identifier as CFString, 1, nil) else {
            throw DesktopError.message("无法转换这张图片。")
        }
        CGImageDestinationAddImage(encoder, image, nil)
        guard CGImageDestinationFinalize(encoder), converted.length <= byteLimit else {
            throw DesktopError.message("这张图片转换后超过 8 MB。")
        }
        return (converted as Data, "image/png")
    }

    private static func documentText(_ data: Data, type: NSAttributedString.DocumentType) throws -> String {
        try NSAttributedString(data: data, options: [.documentType: type], documentAttributes: nil).string
    }

    private static func pdfText(_ data: Data) throws -> String {
        guard let document = PDFDocument(data: data), !document.isLocked else {
            throw DesktopError.message("无法读取 PDF，文件可能受密码保护。")
        }
        var pages: [String] = []
        var size = 0
        for index in 0..<document.pageCount {
            guard let text = document.page(at: index)?.string, !text.isEmpty else { continue }
            size += text.count
            guard size <= textLimit else { throw DesktopError.message("PDF 正文超过 64,000 个字符。") }
            pages.append(text)
        }
        return pages.joined(separator: "\n\n")
    }
}
