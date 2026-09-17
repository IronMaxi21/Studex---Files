import AppKit
import PDFKit

/**
 Photographing something with the phone that is already in your hand.

 macOS calls this Continuity Camera, and it is not a camera API: nothing here
 opens a capture session, and `VNDocumentCameraViewController` — the class an
 iOS app would present — does not exist on this platform at all. What happens
 instead is that AppKit offers the nearby devices as *services*. The app says
 what it is willing to be handed back, an empty submenu in the File menu fills
 itself with "Take Photo", "Scan Documents" and "Add Sketch" for every iPhone
 and iPad signed into the same account, and when the shutter is pressed over
 there the result arrives here on a pasteboard.

 So the whole of the feature on this side is: declare the types, be reachable
 on the responder chain, and know what to do with what comes back.

 What comes back is a photograph or a scan, and Studex has exactly one place
 that shape of thing belongs — the PDF reader, which already renders, stores,
 annotates, searches and prints. A scan arrives as PDF already; a photograph
 arrives as an image and is wrapped in a single page here, so that both land in
 the library as the same kind of thing and neither needs a viewer of its own.
 */
final class ContinuityCamera: NSObject, NSServicesMenuRequestor {
    /// What the app is prepared to be handed. Registered with AppKit as the
    /// return types of a service, which is what makes the devices appear.
    ///
    /// `.fileURL` is here because "Scan Documents" hands over a file rather
    /// than its bytes when the scan is large.
    static let returnTypes: [NSPasteboard.PasteboardType] = [.pdf, .tiff, .png, .fileURL]

    /// Called with a finished PDF and the name it should be filed under.
    var onCapture: ((String, Data) -> Void)?

    /// Whether the machine has anything to offer. AppKit populates the submenu
    /// on its own; this only decides whether the placeholder is worth enabling
    /// before it has, which it always is — a Mac with no device nearby shows an
    /// empty list, and that is a truthful answer rather than a broken one.
    func readSelection(from pasteboard: NSPasteboard) -> Bool {
        guard let (data, kind) = Self.payload(from: pasteboard) else { return false }
        guard let pdf = Self.asPDF(data, kind: kind) else { return false }
        onCapture?(Self.filename(for: kind), pdf)
        return true
    }

    // MARK: - Reading the pasteboard

    private enum Kind { case scan, photo }

    /// The capture, whichever way it was handed over.
    ///
    /// Order matters: a scan puts a PDF *and* a preview image on the
    /// pasteboard, and taking the image first would quietly turn a six-page
    /// scan into a picture of its first page.
    private static func payload(from pasteboard: NSPasteboard) -> (Data, Kind)? {
        if let pdf = pasteboard.data(forType: .pdf) { return (pdf, .scan) }

        if let url = pasteboard.readObjects(forClasses: [NSURL.self]) as? [URL],
           let file = url.first,
           let data = try? Data(contentsOf: file) {
            return (data, file.pathExtension.lowercased() == "pdf" ? .scan : .photo)
        }

        for type in [NSPasteboard.PasteboardType.tiff, .png] {
            if let image = pasteboard.data(forType: type) { return (image, .photo) }
        }
        return nil
    }

    /// Bytes to a PDF. A scan already is one; a photograph becomes a page the
    /// size of the image, so nothing is scaled and nothing is cropped.
    private static func asPDF(_ data: Data, kind: Kind) -> Data? {
        if kind == .scan {
            // Trusted only as far as PDFKit agrees it is a PDF: the file came
            // off a pasteboard, and the reader on the other side should not be
            // the first thing to find out that it is not one.
            return PDFDocument(data: data) != nil ? data : nil
        }
        guard let image = NSImage(data: data),
              let page = PDFPage(image: image) else { return nil }
        let document = PDFDocument()
        document.insert(page, at: 0)
        return document.dataRepresentation()
    }

    /// Something a student will recognise in a list a week later. The colon a
    /// short time carries is a path separator on this platform, and the slashes
    /// a short date carries are the same, so both go.
    private static func filename(for kind: Kind) -> String {
        let stamp = DateFormatter()
        stamp.dateStyle = .medium
        stamp.timeStyle = .short
        let when = stamp.string(from: Date())
            .replacingOccurrences(of: "/", with: "-")
            .replacingOccurrences(of: ":", with: ".")
        return "\(kind == .scan ? "Scan" : "Photo") \(when).pdf"
    }
}
