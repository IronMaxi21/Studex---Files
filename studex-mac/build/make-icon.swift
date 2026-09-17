import AppKit
import Foundation

/// Renders Studex.icns.
///
/// The mark is the one the app draws for itself on the sign-in screen — the
/// mortarboard whose tassel is an exclamation mark — set on the same dark
/// chrome the window uses, so the icon in the Dock and the window it opens are
/// recognisably the same thing. The geometry is the same path data as
/// web/js/logo.js, in that file's 38×24 coordinate space.

let accent = NSColor(srgbRed: 0.569, green: 0.518, blue: 0.851, alpha: 1) // #9184d9
let base = NSColor(srgbRed: 0.086, green: 0.094, blue: 0.149, alpha: 1)   // #161826
let lift = NSColor(srgbRed: 0.145, green: 0.153, blue: 0.243, alpha: 1)   // #25273e

func render(size: Int) -> Data {
    let s = CGFloat(size)
    let image = NSImage(size: NSSize(width: s, height: s))
    image.lockFocus()
    guard let ctx = NSGraphicsContext.current?.cgContext else { fatalError("no context") }

    ctx.setShouldAntialias(true)
    ctx.interpolationQuality = .high

    // macOS icons sit in a rounded tile with a margin, not edge to edge.
    let inset = s * 0.0977
    let tile = CGRect(x: inset, y: inset, width: s - inset * 2, height: s - inset * 2)
    let radius = tile.width * 0.2237
    let tilePath = CGPath(roundedRect: tile, cornerWidth: radius, cornerHeight: radius, transform: nil)

    ctx.saveGState()
    ctx.addPath(tilePath)
    ctx.clip()
    let gradient = CGGradient(
        colorsSpace: CGColorSpaceCreateDeviceRGB(),
        colors: [lift.cgColor, base.cgColor] as CFArray,
        locations: [0, 1]
    )!
    ctx.drawLinearGradient(gradient, start: CGPoint(x: tile.minX, y: tile.maxY),
                           end: CGPoint(x: tile.maxX, y: tile.minY), options: [])

    // The glow the design puts behind the mark, as a wash inside the tile.
    let glow = CGGradient(
        colorsSpace: CGColorSpaceCreateDeviceRGB(),
        colors: [accent.withAlphaComponent(0.32).cgColor, accent.withAlphaComponent(0).cgColor] as CFArray,
        locations: [0, 1]
    )!
    ctx.drawRadialGradient(glow, startCenter: CGPoint(x: tile.midX, y: tile.midY), startRadius: 0,
                           endCenter: CGPoint(x: tile.midX, y: tile.midY), endRadius: tile.width * 0.46,
                           options: [])
    ctx.restoreGState()

    // A hairline edge keeps the tile from dissolving into a dark background.
    ctx.addPath(tilePath)
    ctx.setStrokeColor(NSColor(white: 1, alpha: 0.09).cgColor)
    ctx.setLineWidth(max(s * 0.004, 0.5))
    ctx.strokePath()

    // The mark itself, in logo.js coordinates (38 wide, 24 tall, y downwards).
    let markWidth = tile.width * 0.62
    let unit = markWidth / 38
    let markHeight = 24 * unit
    let originX = tile.midX - markWidth / 2
    let originY = tile.midY - markHeight / 2
    // The SVG's y grows downwards; this context's grows up.
    func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
        CGPoint(x: originX + x * unit, y: originY + (24 - y) * unit)
    }

    let cap = CGMutablePath()
    cap.move(to: p(15, 3))
    cap.addLine(to: p(27, 8.5))
    cap.addLine(to: p(15, 14))
    cap.addLine(to: p(3, 8.5))
    cap.closeSubpath()

    let body = CGMutablePath()
    body.move(to: p(7.5, 10.6))
    body.addLine(to: p(7.5, 17))
    body.addCurve(to: p(15, 20.5), control1: p(7.5, 19.1), control2: p(10.9, 20.5))
    body.addCurve(to: p(22.5, 17), control1: p(19.1, 20.5), control2: p(22.5, 19.1))
    body.addLine(to: p(22.5, 10.6))

    let tassel = CGMutablePath()
    tassel.move(to: p(32.5, 4.5))
    tassel.addLine(to: p(32.5, 15))

    ctx.saveGState()
    // Below 32pt a shadow only muddies the stroke, which is the whole subject.
    if size >= 64 {
        ctx.setShadow(offset: .zero, blur: s * 0.035, color: accent.withAlphaComponent(0.6).cgColor)
    }
    ctx.setStrokeColor(NSColor(white: 0.97, alpha: 1).cgColor)
    ctx.setLineWidth(max(2.4 * unit, 1))
    ctx.setLineJoin(.round)
    ctx.setLineCap(.round)
    for path in [cap, body, tassel] {
        ctx.addPath(path)
        ctx.strokePath()
    }
    ctx.restoreGState()

    // Only the tassel's dot is accent — the one part that still reads at 16px.
    let dot = p(32.5, 19.6)
    let dotRadius = 2.3 * unit
    ctx.setFillColor(accent.cgColor)
    ctx.fillEllipse(in: CGRect(x: dot.x - dotRadius, y: dot.y - dotRadius, width: dotRadius * 2, height: dotRadius * 2))

    image.unlockFocus()

    guard let tiff = image.tiffRepresentation,
          let rep = NSBitmapImageRep(data: tiff),
          let png = rep.representation(using: .png, properties: [:]) else {
        fatalError("could not encode \(size)px")
    }
    return png
}

let arguments = CommandLine.arguments
guard arguments.count == 2 else {
    FileHandle.standardError.write(Data("usage: make-icon <output.iconset>\n".utf8))
    exit(2)
}

let outputDirectory = URL(fileURLWithPath: arguments[1])
try? FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)

// The set iconutil expects: each nominal point size at 1x and 2x.
let variants: [(name: String, pixels: Int)] = [
    ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024),
]

for variant in variants {
    let data = render(size: variant.pixels)
    try data.write(to: outputDirectory.appendingPathComponent(variant.name))
}
