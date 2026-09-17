import AppKit

/**
 The day's work, in the menu bar.

 The Dock badge says how many cards are due, but only while the Dock is showing
 and only as a number. This puts the same count beside the clock, together with
 the next lesson, and keeps Start Review one click away — so a spare five
 minutes before a lesson does not begin with finding the window.

 Both facts come from the page, the same way the Dock badge does: the session
 lives there, and this item never reads the library on its own.
 */
final class StatusBar: NSObject {
    static let shared = StatusBar()

    weak var host: (any AutomationHost)?

    private var item: NSStatusItem?
    private var due = 0
    private var lesson: String?

    func start() {
        guard item == nil else { return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = NSImage(systemSymbolName: "graduationcap", accessibilityDescription: "Studex")
        item.button?.imagePosition = .imageLeading
        self.item = item
        redraw()
    }

    func update(due: Int) {
        self.due = max(0, due)
        redraw()
    }

    func update(lesson: String?) {
        let trimmed = lesson?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.lesson = (trimmed?.isEmpty ?? true) ? nil : trimmed
        redraw()
    }

    private func redraw() {
        guard let item else { return }
        item.button?.title = due > 0 ? " \(due)" : ""
        item.button?.toolTip = due > 0 ? "\(due) card\(due == 1 ? "" : "s") due" : "Studex"

        let menu = NSMenu()
        let count = NSMenuItem(title: due > 0 ? "\(due) card\(due == 1 ? "" : "s") due today" : "Nothing due right now", action: nil, keyEquivalent: "")
        count.isEnabled = false
        menu.addItem(count)
        let next = NSMenuItem(title: lesson.map { "Next: \($0)" } ?? "No more lessons today", action: nil, keyEquivalent: "")
        next.isEnabled = false
        menu.addItem(next)
        menu.addItem(.separator())
        menu.addItem(entry("Start Review", #selector(startReview)))
        menu.addItem(entry("Timetable", #selector(showTimetable)))
        menu.addItem(entry("Open Studex", #selector(openApp)))
        item.menu = menu
    }

    private func entry(_ title: String, _ action: Selector) -> NSMenuItem {
        let menuItem = NSMenuItem(title: title, action: action, keyEquivalent: "")
        menuItem.target = self
        return menuItem
    }

    @objc private func startReview() { host?.go(to: "review") }
    @objc private func showTimetable() { host?.go(to: "timetable") }
    @objc private func openApp() { host?.go(to: "home") }
}
