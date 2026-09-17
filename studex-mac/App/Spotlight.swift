import CoreSpotlight
import Foundation
import UniformTypeIdentifiers

/**
 The library, as macOS Spotlight sees it.

 Studex already has a full-text index — SQLite's FTS5, maintained by the server
 as documents, annotations and cards are written — and searching it from inside
 the app is ⌘K. This mirrors the file half of it into Spotlight, so that the
 note you are looking for can be found from the desktop, or from the Spotlight
 bar in the middle of writing an essay, without opening the app first to look
 for it.

 The page is the side that reads the library, because it is the side holding
 the session; the shell is the side that can talk to `CSSearchableIndex`. So
 what arrives here is the whole of what should be findable, and it replaces
 what was here before rather than adding to it. A deleted note has to stop
 being a Spotlight result, and "everything, again" is the only statement that
 says so without the two sides having to agree on a list of tombstones.

 Nothing is indexed unless the student has asked for it: the setting is off
 until switched on, and switching it off empties the index rather than leaving
 the contents of somebody's revision notes in a system-wide search.
 */
enum Spotlight {
    /// Namespaces the app's items inside an index it shares with every other
    /// app on the Mac, and gives the whole set one handle to delete by.
    private static let domain = "com.studex.desktop.files"

    /// Item identifiers are `studex.<kind>.<uuid>`, which is what comes back
    /// when a result is clicked and what a route has to be rebuilt from.
    private static func identifier(kind: String, id: String) -> String { "studex.\(kind).\(id)" }

    /**
     Replaces everything the app has indexed.

     Each item is `{ id, kind, title, text }` — the same four things the app's
     own search results are built from.
     */
    static func replaceAll(with items: [[String: Any]]) {
        let index = CSSearchableIndex.default()

        let searchable: [CSSearchableItem] = items.compactMap { item in
            guard let id = item["id"] as? String, !id.isEmpty,
                  let kind = item["kind"] as? String, !kind.isEmpty
            else { return nil }

            let attributes = CSSearchableItemAttributeSet(contentType: .content)
            let title = (item["title"] as? String) ?? ""
            attributes.title = title.isEmpty ? "Untitled" : title
            attributes.contentDescription = item["text"] as? String
            // What the app calls it, so a result says "Document" and not
            // "doc" — and so the kinds can be told apart in a list of hits.
            attributes.kind = label(for: kind)
            if let updated = item["updated_at"] as? NSNumber {
                attributes.contentModificationDate = Date(timeIntervalSince1970: updated.doubleValue / 1000)
            }

            return CSSearchableItem(
                uniqueIdentifier: identifier(kind: kind, id: id),
                domainIdentifier: domain,
                attributeSet: attributes
            )
        }

        // Emptied first, so that a note deleted since the last pass is gone
        // even if this pass fails to write anything.
        index.deleteSearchableItems(withDomainIdentifiers: [domain]) { _ in
            guard !searchable.isEmpty else { return }
            index.indexSearchableItems(searchable) { _ in }
        }
    }

    /// Takes the library back out of Spotlight, for the setting being switched
    /// off and for signing out.
    static func clear() {
        CSSearchableIndex.default().deleteSearchableItems(withDomainIdentifiers: [domain]) { _ in }
    }

    /**
     The route behind a result somebody clicked.

     The identifier carries the kind and the id, which is exactly what the hash
     route is made of, so nothing has to be looked up to answer this — which
     matters, because this runs before there is necessarily a window, let alone
     a signed-in page to ask.
     */
    static func route(forItem identifier: String) -> String? {
        let parts = identifier.split(separator: ".", maxSplits: 2, omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0] == "studex" else { return nil }
        let kind = String(parts[1])
        let id = String(parts[2])
        guard !kind.isEmpty, !id.isEmpty else { return nil }
        return "\(kind)/\(id)"
    }

    private static func label(for kind: String) -> String {
        switch kind {
        case "doc": return "Document"
        case "canvas": return "Canvas"
        case "deck": return "Flashcard deck"
        case "pdf": return "PDF"
        default: return "Studex"
        }
    }
}
