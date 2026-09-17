import AppKit

/**
 The app, driven from outside it.

 The point of this is the thing you want at 9pm with an exam timetable open in
 another app: "add an exam", "how many cards are due", without stopping to find
 the window. On a Mac that means Shortcuts, and Shortcuts reaches an app in two
 ways — App Intents, which are compiled out of the source by a build phase that
 only Xcode runs, and scripting, which is a plist entry and a definition file.
 This app is built by `swiftc` from a shell script and has no Xcode project, so
 App Intents cannot be produced here at all: the metadata they are discovered
 through would be missing and Shortcuts would show nothing. Scripting is the
 route that actually works, and it works everywhere the other one would have —
 Shortcuts' Run AppleScript action, Automator, the Script Editor, a login item,
 `osascript` in a terminal:

     tell application "Studex" to get cards due
     tell application "Studex" to add exam
     tell application "Studex" to show "review"

 and, for a Shortcut that would rather not write a script, the same screens are
 reachable as `studex://review`.

 What is deliberately not here is anything that reads the library. The session
 lives in the page, the database is the server's, and a scripting interface
 that could enumerate somebody's notes is a much larger promise than "open the
 thing I am looking for". The one number that does cross is the count the app
 already puts on its own Dock icon, where anyone walking past can read it.
 */
protocol AutomationHost: AnyObject {
    /// False while the app is locked behind Touch ID or a password.
    var isUnlocked: Bool { get }
    /// Runs one of the interface's own menu commands, in the window in front.
    func runCommand(_ name: String)
    /// Shows a route, in the window in front or in a new one.
    func go(to route: String)
    /// Shows a route in a window of its own.
    func goInNewWindow(_ route: String)
}

final class Automation {
    static let shared = Automation()
    private init() {}

    weak var delegate: (any AutomationHost)?

    /// The last due count the interface reported, which is the same number the
    /// Dock badge is showing. Zero before the app has signed in and counted.
    var cardsDue = 0

    /// A script asking the app to do something while it is locked gets the
    /// lock screen and nothing else — the same answer a person clicking the
    /// Dock icon would get, rather than a silent success.
    fileprivate func addExam() throws {
        try requireUnlocked()
        delegate?.runCommand("new-event")
    }

    fileprivate func show(_ route: String, inNewWindow: Bool) throws {
        try requireUnlocked()
        let trimmed = route.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "#/"))
        let wanted = trimmed.isEmpty ? "home" : trimmed
        if inNewWindow { delegate?.goInNewWindow(wanted) } else { delegate?.go(to: wanted) }
    }

    private func requireUnlocked() throws {
        guard let delegate else { throw AutomationError.notReady }
        guard delegate.isUnlocked else { throw AutomationError.locked }
    }
}

enum AutomationError: LocalizedError {
    case locked
    case notReady

    var errorDescription: String? {
        switch self {
        case .locked: return "Studex is locked. Unlock it and try again."
        case .notReady: return "Studex is still starting up."
        }
    }
}

/**
 The scriptable surface of the application object itself.

 AppleScript reads `cards due` as a property of the app, which Cocoa scripting
 resolves by key-value coding against `NSApplication` — so the property has to
 hang off that class and not off the delegate.
 */
extension NSApplication {
    @objc var studexCardsDue: NSNumber { NSNumber(value: Automation.shared.cardsDue) }
}

/// `tell application "Studex" to add exam`
///
/// The explicit Objective-C name matters: Cocoa scripting finds the class the
/// .sdef names with `NSClassFromString`, and a Swift class is registered under
/// its mangled `Module.Class` name unless it is told otherwise — which fails
/// as "the handler is not defined" at the other end, with nothing in the log.
@objc(AddExamCommand)
final class AddExamCommand: NSScriptCommand {
    override func performDefaultImplementation() -> Any? {
        do {
            try Automation.shared.addExam()
        } catch {
            scriptErrorNumber = errAEEventFailed
            scriptErrorString = error.localizedDescription
        }
        return nil
    }
}

/// `tell application "Studex" to show "review"`
@objc(ShowRouteCommand)
final class ShowRouteCommand: NSScriptCommand {
    override func performDefaultImplementation() -> Any? {
        do {
            let args = evaluatedArguments ?? [:]
            try Automation.shared.show(
                directParameter as? String ?? "home",
                inNewWindow: (args["inNewWindow"] as? Bool) ?? false
            )
        } catch {
            scriptErrorNumber = errAEEventFailed
            scriptErrorString = error.localizedDescription
        }
        return nil
    }
}
