import AppKit

let iconset = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)

func draw(_ pixels: Int, name: String) throws {
    let image = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
                                 bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                 colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    let context = NSGraphicsContext(bitmapImageRep: image)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    let scale = CGFloat(pixels) / 1024
    context.cgContext.scaleBy(x: scale, y: scale)
    context.cgContext.clear(CGRect(x: 0, y: 0, width: 1024, height: 1024))
    let tile = NSBezierPath(roundedRect: NSRect(x: 92, y: 92, width: 840, height: 840),
                            xRadius: 189, yRadius: 189)
    NSColor(srgbRed: 0.676, green: 0.310, blue: 0.204, alpha: 1).setFill()
    tile.fill()

    let font = NSFont(name: "Georgia-BoldItalic", size: 610) ?? NSFont.boldSystemFont(ofSize: 610)
    let glyph = NSAttributedString(string: "π", attributes: [.font: font, .foregroundColor: NSColor.white])
    let line = CTLineCreateWithAttributedString(glyph)
    let bounds = CTLineGetBoundsWithOptions(line, .useGlyphPathBounds)
    context.cgContext.textPosition = CGPoint(x: 510 - bounds.midX, y: 516 - bounds.midY)
    CTLineDraw(line, context.cgContext)
    context.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()
    try image.representation(using: .png, properties: [:])!.write(to: iconset.appendingPathComponent(name))
}

for points in [16, 32, 128, 256, 512] {
    try draw(points, name: "icon_\(points)x\(points).png")
    try draw(points * 2, name: "icon_\(points)x\(points)@2x.png")
}
