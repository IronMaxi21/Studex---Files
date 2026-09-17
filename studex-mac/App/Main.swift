import AppKit

/// Entry point.
///
/// Built without Xcode, so the application object, its delegate and the
/// activation policy are set up by hand rather than by a nib.
@main
enum Main {
    static func main() {
        let app = NSApplication.shared
        // Held for the process lifetime: NSApplication does not retain its
        // delegate, and a released one takes the backend down with it.
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
        withExtendedLifetime(delegate) {}
    }
}
