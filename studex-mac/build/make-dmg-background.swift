import AppKit
import Foundation

/// Renders the background of the Studex disk image, at 1x and 2x.
///
/// The window the installer opens is 640×400, and Finder places Studex.app on
/// the left and the Applications alias on the right, both centred at y=218 in
/// the window's own coordinates (origin top left). Everything drawn here is
/// positioned around those two icons, so the picture and the icons Finder puts
/// on top of it read as one composition. Same palette as make-icon.swift.

let accent = NSColor(srgbRed: 0.569, green: 0.518, blue: 0.851, alpha: 1) // #9184d9
let base = NSColor(srgbRed: 0.086, green: 0.094, blue: 0.149, alpha: 1)   // #161826
let lift = NSColor(srgbRed: 0.145, green: 0.153, blue: 0.243, alpha: 1)   // #25273e

let width: CGFloat = 640
let height: CGFloat = 400
/// Where Finder centres the two icons, in window coordinates (y downwards).
let appIcon = CGPoint(x: 168, y: 218)
let applicationsIcon = CGPoint(x: 472, y: 218)

func render(scale: CGFloat) -> Data {
    // Drawn into a bitmap of an exact pixel size rather than through
    // NSImage.lockFocus(), which would quietly add the screen's own backing
    // scale on a Retina Mac and hand back a 2x image for the 1x file.
    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: Int(width * scale), pixelsHigh: Int(height * scale),
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    ), let graphics = NSGraphicsContext(bitmapImageRep: rep) else {
        fatalError("could not make a \(scale)x bitmap")
    }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = graphics
    let ctx = graphics.cgContext
    ctx.setShouldAntialias(true)
    ctx.interpolationQuality = .high
    // Draw in window points; the scale factor does the rest.
    ctx.scaleBy(x: scale, y: scale)

    /// Window coordinates (y downwards) into this context's (y upwards).
    func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x, y: height - y) }

    // ── ground ──────────────────────────────────────────────────────────
    let gradient = CGGradient(
        colorsSpace: CGColorSpaceCreateDeviceRGB(),
        colors: [lift.cgColor, base.cgColor] as CFArray,
        locations: [0, 1]
    )!
    ctx.drawLinearGradient(gradient, start: p(0, 0), end: p(width, height), options: [])

    // A wash behind each icon well, so the two icons sit in light rather than
    // on a flat field.
    let glow = CGGradient(
        colorsSpace: CGColorSpaceCreateDeviceRGB(),
        colors: [accent.withAlphaComponent(0.20).cgColor, accent.withAlphaComponent(0).cgColor] as CFArray,
        locations: [0, 1]
    )!
    for centre in [appIcon, applicationsIcon] {
        ctx.drawRadialGradient(glow, startCenter: p(centre.x, centre.y), startRadius: 0,
                               endCenter: p(centre.x, centre.y), endRadius: 150, options: [])
    }

    // ── type ────────────────────────────────────────────────────────────
    func draw(_ text: String, font: NSFont, color: NSColor, centredAt centre: CGPoint, tracking: CGFloat = 0) {
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font, .foregroundColor: color, .kern: tracking,
        ]
        let line = NSAttributedString(string: text, attributes: attributes)
        let size = line.size()
        line.draw(at: CGPoint(x: centre.x - size.width / 2, y: centre.y - size.height / 2))
    }

    draw("Studex", font: .systemFont(ofSize: 30, weight: .semibold),
         color: NSColor(white: 0.97, alpha: 1), centredAt: p(width / 2, 74))
    draw("DRAG THE APP INTO YOUR APPLICATIONS FOLDER",
         font: .systemFont(ofSize: 11, weight: .medium),
         color: NSColor(white: 1, alpha: 0.5), centredAt: p(width / 2, 108), tracking: 1.6)

    // ── the drag ────────────────────────────────────────────────────────
    // A dashed run between the two icon wells, clear of both, ending in an
    // arrow head that points at the Applications alias.
    let y = appIcon.y
    let start = p(appIcon.x + 84, y)
    let end = p(applicationsIcon.x - 84, y)

    ctx.saveGState()
    ctx.setStrokeColor(accent.withAlphaComponent(0.85).cgColor)
    ctx.setLineWidth(2)
    ctx.setLineCap(.round)
    ctx.setLineDash(phase: 0, lengths: [7, 7])
    ctx.move(to: start)
    ctx.addLine(to: CGPoint(x: end.x - 12, y: end.y))
    ctx.strokePath()
    ctx.restoreGState()

    let head = CGMutablePath()
    head.move(to: end)
    head.addLine(to: CGPoint(x: end.x - 15, y: end.y + 9))
    head.addLine(to: CGPoint(x: end.x - 15, y: end.y - 9))
    head.closeSubpath()
    ctx.addPath(head)
    ctx.setFillColor(accent.withAlphaComponent(0.85).cgColor)
    ctx.fillPath()

    // Finder draws each icon's own name under it, so nothing is labelled here.
    draw("macOS 13 or later  ·  Apple silicon",
         font: .systemFont(ofSize: 11, weight: .regular),
         color: NSColor(white: 1, alpha: 0.3), centredAt: p(width / 2, height - 40))

    NSGraphicsContext.restoreGraphicsState()

    guard let png = rep.representation(using: .png, properties: [:]) else {
        fatalError("could not encode the background at \(scale)x")
    }
    return png
}

let arguments = CommandLine.arguments
guard arguments.count == 2 else {
    FileHandle.standardError.write(Data("usage: make-dmg-background <output-directory>\n".utf8))
    exit(2)
}

let outputDirectory = URL(fileURLWithPath: arguments[1])
try? FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)
try render(scale: 1).write(to: outputDirectory.appendingPathComponent("background.png"))
try render(scale: 2).write(to: outputDirectory.appendingPathComponent("background@2x.png"))
