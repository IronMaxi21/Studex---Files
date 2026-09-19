import AppKit

/**
 The day's work, in the menu bar.

 The Dock badge says how many cards are due, but only while the Dock is showing
 and only as a number. This puts the same count beside the clock, together with
 the next lesson, the running focus block and the handful of things worth doing
 without going to find the window first — so a spare five minutes before a
 lesson does not begin with hunting for it.

 Everything here comes from the page, the same way the Dock badge does: the
 session lives there, and this item never reads the library on its own. What it
 sends back are the same command names the application menu sends, so nothing
 in the app has to know the difference between a menu bar press and a ⌘ key.
 */
struct FocusSnapshot {
    var phase = "idle"          // idle | focus | break | between
    var status = ""             // running | paused | break | between
    var endsAt: TimeInterval = 0 // ms since epoch; zero while paused or idle
    var remaining = 0           // seconds, for when there is no end to count to
    var goal = ""

    var isIdle: Bool { phase == "idle" }
    var isPaused: Bool { status == "paused" }

    /// Seconds left, counted down from the end the page sent. A paused block
    /// has no end to count towards, so its frozen figure stands.
    var left: Int {
        guard endsAt > 0 else { return remaining }
        return max(0, Int((endsAt / 1000 - Date().timeIntervalSince1970).rounded()))
    }

    var clock: String {
        let seconds = left
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    /// What the block is, in the words the overlay uses.
    var label: String {
        switch phase {
        case "break": return "Break"
        case "between": return "Between blocks"
        default: return isPaused ? "Focus paused" : "Focus"
        }
    }
}

final class StatusBar: NSObject {
    static let shared = StatusBar()

    weak var host: (any AutomationHost)?

    private var item: NSStatusItem?
    private var due = 0
    private var lesson: String?
    private var reviewed = 0
    private var streak = 0
    private var focus = FocusSnapshot()

    /// Only runs while a block is counting down, and only touches the two
    /// titles that hold a clock — rebuilding the menu every second would close
    /// it under anyone reading it.
    private var ticker: Timer?
    private weak var focusRow: NSMenuItem?

    func start() {
        guard item == nil else { return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
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

    func update(reviewed: Int, streak: Int) {
        self.reviewed = max(0, reviewed)
        self.streak = max(0, streak)
        redraw()
    }

    func update(focus: FocusSnapshot) {
        self.focus = focus
        redraw()
    }

    // MARK: - drawing

    private func redraw() {
        guard let item else { return }
        item.button?.image = NSImage(
            systemSymbolName: focus.isIdle ? "graduationcap" : "timer",
            accessibilityDescription: "Studex")
        drawClock()

        let menu = NSMenu()
        menu.autoenablesItems = false

        if focus.isIdle {
            menu.addItem(entry("Start Focus Block", #selector(focusStart)))
        } else {
            let row = info("\(focus.label) · \(focus.clock) left")
            focusRow = row
            menu.addItem(row)
            if !focus.goal.isEmpty { menu.addItem(info("Goal: \(focus.goal)")) }
            if focus.phase == "focus" {
                menu.addItem(entry(focus.isPaused ? "Resume" : "Pause",
                                   focus.isPaused ? #selector(focusResume) : #selector(focusPause)))
            }
            menu.addItem(entry("End Session", #selector(focusStop)))
        }
        menu.addItem(.separator())

        menu.addItem(info(due > 0 ? "\(due) card\(due == 1 ? "" : "s") due today" : "Nothing due right now"))
        if reviewed > 0 || streak > 0 { menu.addItem(info(progressLine())) }
        menu.addItem(info(lesson.map { "Next: \($0)" } ?? "No more lessons today"))
        menu.addItem(.separator())

        menu.addItem(entry("Start Review", #selector(startReview)))
        menu.addItem(submenu("New", [
            ("Document", #selector(newDoc)),
            ("Flashcard Deck", #selector(newDeck)),
            ("Canvas", #selector(newCanvas)),
            ("Folder", #selector(newFolder)),
            ("Calendar Event", #selector(newEvent)),
        ]))
        menu.addItem(submenu("Go To", [
            ("Home", #selector(openApp)),
            ("Library", #selector(goLibrary)),
            ("Calendar", #selector(goCalendar)),
            ("Timetable", #selector(showTimetable)),
            ("Topics", #selector(goTopics)),
            ("Statistics", #selector(goStats)),
        ]))
        menu.addItem(entry("Search…", #selector(openPalette)))
        menu.addItem(.separator())
        menu.addItem(entry("Focus Settings", #selector(focusSettings)))
        menu.addItem(entry("Open Studex", #selector(openApp)))
        item.menu = menu

        // Counting only while something is counting: a timer that fires every
        // second all day so it can redraw a number that has not moved is the
        // kind of thing people notice in Activity Monitor.
        let counting = !focus.isIdle && !focus.isPaused
        if counting && ticker == nil {
            ticker = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
                self?.drawClock()
            }
            ticker.map { RunLoop.main.add($0, forMode: .common) }
        } else if !counting {
            ticker?.invalidate()
            ticker = nil
        }
    }

    /// The two places a clock appears. Safe to call with a menu open: setting a
    /// title on an existing item redraws the row in place.
    private func drawClock() {
        guard let item else { return }
        if focus.isIdle {
            item.button?.title = due > 0 ? " \(due)" : ""
            item.button?.toolTip = due > 0 ? "\(due) card\(due == 1 ? "" : "s") due" : "Studex"
        } else {
            item.button?.title = " \(focus.clock)"
            item.button?.toolTip = "\(focus.label) · \(focus.clock) left"
            focusRow?.title = "\(focus.label) · \(focus.clock) left"
        }
    }

    private func progressLine() -> String {
        var parts: [String] = []
        if reviewed > 0 { parts.append("\(reviewed) reviewed today") }
        if streak > 0 { parts.append("\(streak)-day streak") }
        return parts.joined(separator: " · ")
    }

    // MARK: - items

    private func info(_ title: String) -> NSMenuItem {
        let menuItem = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        menuItem.isEnabled = false
        return menuItem
    }

    private func entry(_ title: String, _ action: Selector) -> NSMenuItem {
        let menuItem = NSMenuItem(title: title, action: action, keyEquivalent: "")
        menuItem.target = self
        menuItem.isEnabled = true
        return menuItem
    }

    private func submenu(_ title: String, _ entries: [(String, Selector)]) -> NSMenuItem {
        let parent = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        let menu = NSMenu(title: title)
        menu.autoenablesItems = false
        for (label, action) in entries { menu.addItem(entry(label, action)) }
        parent.submenu = menu
        return parent
    }

    // MARK: - actions

    @objc private func startReview() { host?.go(to: "review") }
    @objc private func showTimetable() { host?.go(to: "timetable") }
    @objc private func openApp() { host?.go(to: "home") }
    @objc private func goLibrary() { host?.go(to: "library") }
    @objc private func goCalendar() { host?.go(to: "calendar") }
    @objc private func goTopics() { host?.go(to: "topics") }
    @objc private func goStats() { host?.go(to: "stats") }
    @objc private func focusSettings() { host?.go(to: "settings/focus") }

    @objc private func newDoc() { host?.runCommand("new-doc") }
    @objc private func newDeck() { host?.runCommand("new-deck") }
    @objc private func newCanvas() { host?.runCommand("new-canvas") }
    @objc private func newFolder() { host?.runCommand("new-folder") }
    @objc private func newEvent() { host?.runCommand("new-event") }
    @objc private func openPalette() { host?.runCommand("palette") }

    @objc private func focusStart() { host?.runCommand("focus-start") }
    @objc private func focusPause() { host?.runCommand("focus-pause") }
    @objc private func focusResume() { host?.runCommand("focus-resume") }
    @objc private func focusStop() { host?.runCommand("focus-stop") }
}
