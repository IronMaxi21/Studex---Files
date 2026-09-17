import AppKit

/// Builds the menu bar.
///
/// Most items are commands the web layer already implements, forwarded by name
/// — a menu key equivalent is swallowed by AppKit and never reaches the page as
/// a keydown, so the shortcuts the UI defines for itself have to be re-declared
/// here to keep working. The Edit menu is the exception: those selectors go to
/// the responder chain, where the web view handles them natively.
enum MainMenu {
    static func build(target: AnyObject) -> NSMenu {
        let menu = NSMenu()
        menu.addItem(submenu(appMenu(target), title: "Studex"))
        menu.addItem(submenu(fileMenu(target), title: "File"))
        menu.addItem(submenu(editMenu(), title: "Edit"))
        menu.addItem(submenu(viewMenu(target), title: "View"))
        menu.addItem(submenu(goMenu(target), title: "Go"))
        menu.addItem(submenu(windowMenu(), title: "Window"))
        menu.addItem(submenu(helpMenu(target), title: "Help"))
        return menu
    }

    // MARK: - Menus

    private static func appMenu(_ target: AnyObject) -> NSMenu {
        let menu = NSMenu(title: "Studex")
        menu.addItem(item("About Studex", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), target: nil))
        menu.addItem(.separator())
        menu.addItem(command("Check for Updates…", "check-updates", target: target))
        menu.addItem(command("Settings…", "go-settings", key: ",", target: target))
        menu.addItem(.separator())

        let services = NSMenu(title: "Services")
        menu.addItem(submenu(services, title: "Services"))
        NSApp.servicesMenu = services

        menu.addItem(.separator())
        menu.addItem(item("Hide Studex", #selector(NSApplication.hide(_:)), key: "h", target: nil))
        menu.addItem(item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)),
                          key: "h", modifiers: [.command, .option], target: nil))
        menu.addItem(item("Show All", #selector(NSApplication.unhideAllApplications(_:)), target: nil))
        menu.addItem(.separator())
        // ⇧⌘L, because ⌃⌘Q is the system's own lock and this is the smaller
        // one: the app, not the Mac.
        menu.addItem(item("Lock Studex", #selector(AppDelegate.lockApp(_:)),
                          key: "l", modifiers: [.command, .shift], target: target))
        menu.addItem(command("Sign Out", "sign-out", target: target))
        menu.addItem(.separator())
        menu.addItem(item("Quit Studex", #selector(NSApplication.terminate(_:)), key: "q", target: nil))
        return menu
    }

    private static func fileMenu(_ target: AnyObject) -> NSMenu {
        let menu = NSMenu(title: "File")
        // ⌘N is New Window, as it is in Finder and Safari, and so New Folder
        // takes the shifted key it has in Finder too.
        menu.addItem(item("New Window", #selector(AppDelegate.newWindow(_:)), key: "n", target: target))
        menu.addItem(.separator())
        menu.addItem(command("New Canvas", "new-canvas", key: "1", target: target))
        menu.addItem(command("New Document", "new-doc", key: "2", target: target))
        menu.addItem(command("New Flashcard Deck", "new-deck", key: "3", target: target))
        menu.addItem(.separator())
        menu.addItem(command("New Folder", "new-folder", key: "n", modifiers: [.command, .shift], target: target))
        menu.addItem(command("Add Exam or Assignment…", "new-event", key: "e", target: target))
        menu.addItem(command("Add PDF…", "add-pdf", key: "o", target: target))
        menu.addItem(continuityCameraItem())
        menu.addItem(.separator())
        // The page arranges itself for paper first — a deck becomes a sheet of
        // cards, a canvas is fitted to its own content — and then asks the
        // shell for the print panel. See web/js/print.js.
        menu.addItem(command("Print…", "print", key: "p", target: target))
        menu.addItem(.separator())
        // Opens the screen the download is started from rather than starting
        // it: the save panel should follow a deliberate click, and the screen
        // is also where the archive is described.
        menu.addItem(command("Export Everything…", "export-all", key: "e", modifiers: [.command, .shift], target: target))
        menu.addItem(.separator())
        menu.addItem(item("Close Window", #selector(NSWindow.performClose(_:)), key: "w", target: nil))
        return menu
    }

    /// The Continuity Camera placeholder.
    ///
    /// Nothing here builds the items inside it. AppKit recognises the standard
    /// identifier, and when the File menu opens it fills the submenu with every
    /// iPhone and iPad signed into the same account — "Take Photo", "Scan
    /// Documents", "Add Sketch" under each of their names. That only happens
    /// while something on the responder chain is willing to be handed a picture
    /// back, which is StudexWebView's job; see ContinuityCamera.swift.
    ///
    /// An empty submenu is therefore the honest state and not a broken one: it
    /// means no device is nearby. Rather than leave a student staring at a
    /// blank rectangle wondering which half of it failed, the delegate below
    /// says so in words.
    private static func continuityCameraItem() -> NSMenuItem {
        let submenu = NSMenu(title: "Import from iPhone or iPad")
        submenu.delegate = emptyMenuNote
        let holder = NSMenuItem(title: "Import from iPhone or iPad", action: nil, keyEquivalent: "")
        holder.identifier = NSMenuItem.importFromDeviceIdentifier
        holder.submenu = submenu
        return holder
    }

    /// Retained for the lifetime of the process, because NSMenu holds its
    /// delegate weakly and a menu built once at launch would otherwise lose it
    /// before it was ever opened.
    private static let emptyMenuNote = EmptyMenuNote()

    private static func editMenu() -> NSMenu {
        let menu = NSMenu(title: "Edit")
        // No Swift declaration to point #selector at: these are handled by
        // whatever undo manager the first responder supplies.
        menu.addItem(item("Undo", Selector(("undo:")), key: "z", target: nil))
        menu.addItem(item("Redo", Selector(("redo:")), key: "z", modifiers: [.command, .shift], target: nil))
        menu.addItem(.separator())
        menu.addItem(item("Cut", #selector(NSText.cut(_:)), key: "x", target: nil))
        menu.addItem(item("Copy", #selector(NSText.copy(_:)), key: "c", target: nil))
        menu.addItem(item("Paste", #selector(NSText.paste(_:)), key: "v", target: nil))
        menu.addItem(item("Paste and Match Style", #selector(NSTextView.pasteAsPlainText(_:)),
                          key: "v", modifiers: [.command, .option, .shift], target: nil))
        menu.addItem(item("Delete", #selector(NSText.delete(_:)), target: nil))
        menu.addItem(item("Select All", #selector(NSText.selectAll(_:)), key: "a", target: nil))
        return menu
    }

    private static func viewMenu(_ target: AnyObject) -> NSMenu {
        let menu = NSMenu(title: "View")
        menu.addItem(command("Quick Open…", "palette", key: "k", target: target))
        menu.addItem(command("Hide or Show Sidebar", "toggle-sidebar", key: "\\", target: target))
        // A second page beside the first, in the same window. ⌥ of the sidebar
        // key, because they are the same question about how wide the work is.
        menu.addItem(command("Split the Window", "toggle-split", key: "\\",
                             modifiers: [.command, .option], target: target))
        menu.addItem(command("Swap the Two Pages", "swap-panes", key: "[",
                             modifiers: [.command, .option, .shift], target: target))
        menu.addItem(.separator())
        menu.addItem(item("Reload", #selector(AppDelegate.reloadInterface(_:)), key: "r", target: target))
        menu.addItem(.separator())
        menu.addItem(item("Actual Size", #selector(AppDelegate.resetZoom(_:)), key: "0", target: target))
        menu.addItem(item("Zoom In", #selector(AppDelegate.zoomIn(_:)), key: "+", target: target))
        menu.addItem(item("Zoom Out", #selector(AppDelegate.zoomOut(_:)), key: "-", target: target))
        menu.addItem(.separator())
        menu.addItem(item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)),
                          key: "f", modifiers: [.command, .control], target: nil))
        return menu
    }

    private static func goMenu(_ target: AnyObject) -> NSMenu {
        let menu = NSMenu(title: "Go")
        // ⌥⌘ digits, because ⌘ digits already create things in the File menu.
        let places: [(String, String, String)] = [
            ("Home", "go-home", "1"),
            ("Library", "go-library", "2"),
            ("Calendar", "go-calendar", "3"),
            ("Daily Review", "go-review", "4"),
            ("Topics", "go-topics", "5"),
            ("Timetable", "go-timetable", "6"),
            ("Statistics", "go-stats", "7"),
        ]
        for (title, name, key) in places {
            menu.addItem(command(title, name, key: key, modifiers: [.command, .option], target: target))
        }
        return menu
    }

    private static func windowMenu() -> NSMenu {
        let menu = NSMenu(title: "Window")
        menu.addItem(item("Minimize", #selector(NSWindow.performMiniaturize(_:)), key: "m", target: nil))
        menu.addItem(item("Zoom", #selector(NSWindow.performZoom(_:)), target: nil))
        menu.addItem(.separator())
        menu.addItem(item("Bring All to Front", #selector(NSApplication.arrangeInFront(_:)), target: nil))
        NSApp.windowsMenu = menu
        return menu
    }

    private static func helpMenu(_ target: AnyObject) -> NSMenu {
        let menu = NSMenu(title: "Help")
        menu.addItem(item("Show Studex Data Folder", #selector(AppDelegate.revealDataFolder(_:)), target: target))
        menu.addItem(item("Show Server Log", #selector(AppDelegate.revealServerLog(_:)), target: target))
        return menu
    }

    /// Puts a disabled line into a menu that came up with nothing in it.
    ///
    /// AppKit has already added its own items by the time a submenu is about to
    /// open, so an empty menu at this point really is empty. The note is
    /// removed again on the way in so that it never accumulates and never
    /// survives a device arriving.
    private final class EmptyMenuNote: NSObject, NSMenuDelegate {
        private static let noteIdentifier = NSUserInterfaceItemIdentifier("studex.empty-note")

        func menuNeedsUpdate(_ menu: NSMenu) {
            clear(menu)
            guard menu.items.isEmpty else { return }
            let note = NSMenuItem(title: "No iPhone or iPad nearby", action: nil, keyEquivalent: "")
            note.identifier = Self.noteIdentifier
            note.isEnabled = false
            menu.addItem(note)
        }

        /// Taken away again as soon as the menu is dismissed. AppKit fills the
        /// submenu when the File menu opens, and it fills an empty one — a note
        /// left behind from last time would be read as a menu that already has
        /// its items and would keep the devices out for good.
        func menuDidClose(_ menu: NSMenu) { clear(menu) }

        private func clear(_ menu: NSMenu) {
            for item in menu.items where item.identifier == Self.noteIdentifier {
                menu.removeItem(item)
            }
        }
    }

    // MARK: - Construction helpers

    private static func submenu(_ menu: NSMenu, title: String) -> NSMenuItem {
        let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        holder.submenu = menu
        return holder
    }

    /// `target: nil` sends the action down the responder chain, which is what
    /// makes the Edit menu and the window commands work without any code here.
    private static func item(
        _ title: String,
        _ action: Selector?,
        key: String = "",
        modifiers: NSEvent.ModifierFlags = .command,
        target: AnyObject?
    ) -> NSMenuItem {
        let menuItem = NSMenuItem(title: title, action: action, keyEquivalent: key)
        if !key.isEmpty { menuItem.keyEquivalentModifierMask = modifiers }
        menuItem.target = target
        return menuItem
    }

    private static func command(
        _ title: String,
        _ name: String,
        key: String = "",
        modifiers: NSEvent.ModifierFlags = .command,
        target: AnyObject
    ) -> NSMenuItem {
        let menuItem = item(title, #selector(AppDelegate.runWebCommand(_:)), key: key, modifiers: modifiers, target: target)
        menuItem.representedObject = name
        return menuItem
    }
}
