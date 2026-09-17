import AppKit

/**
 One window, and whatever is inside it.

 The app used to be one window by definition: the delegate held a single
 `NSWindow!` and a single controller, and every menu command went to them. That
 made two documents side by side impossible, and a canvas on one display with
 its notes on the other impossible — which is how people actually revise.

 Everything that used to be a property of the application is a property of one
 of these instead: the web view, the page it is showing, the route it is on and
 the activity that records that route. What stays shared is everything the
 windows are windows *onto* — one backend process, one session cookie (the web
 views all use `.default()`, which is per-bundle and not per-view), one lock and
 one theme.
 */
final class StudexWindow: NSObject, NSWindowDelegate {
    let window: NSWindow
    private(set) var controller: WebViewController?

    /// The hash route the page is showing, e.g. `doc/<uuid>`.
    ///
    /// Kept here rather than read back out of the web view because it has to
    /// survive the web view: it is what a reopened window is pointed at, and
    /// what the delegate writes down when the app quits.
    private(set) var route: String

    /// Called when the window has gone, so the delegate can forget it.
    var onClose: ((StudexWindow) -> Void)?
    /// Called when the page reports the theme it settled on.
    var onThemeChange: ((String) -> Void)?
    /// Called when the page moves to another screen, with this window.
    var onRouteChange: ((StudexWindow) -> Void)?
    /// Called when the page asks for another window, with the route it wants.
    var onNewWindow: ((String?) -> Void)?

    private var theme: String

    /**
     What this window is doing, in the form macOS understands.

     It earns two things. Handoff: the same account on another Mac offers the
     window's document in its Dock. And a name for the window — with one window
     the title bar was a design detail nobody needed, but three windows called
     "Studex" in the Window menu is a menu that tells you nothing.
     */
    private let activity = NSUserActivity(activityType: StudexWindow.activityType)

    static let activityType = "com.studex.desktop.route"

    init(theme: String, route: String, frameAutosave: String?) {
        self.theme = theme
        self.route = route
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
            // `fullSizeContentView` lets the page draw its own title bar strip
            // behind the traffic lights, which is what the design expects.
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        super.init()

        window.title = "Studex"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.minSize = NSSize(width: 960, height: 620)
        window.backgroundColor = Theme.chromeColor(for: theme)
        window.appearance = Theme.appearance(for: theme)
        // Dragging is granted explicitly by the title bar strip; without this
        // a drag anywhere on the page would move the window.
        window.isMovableByWindowBackground = false
        // The app restores its own windows, by route, from the list the
        // delegate keeps. Leaving AppKit's restoration on as well would mean
        // two mechanisms arguing over how many windows there should be.
        window.isRestorable = false
        window.delegate = self
        window.contentView = LaunchView(theme: theme)
        window.center()
        if let frameAutosave {
            // Restores the size and position from last time, if there is one;
            // the centred default stands otherwise.
            window.setFrameAutosaveName(frameAutosave)
        }

        activity.isEligibleForHandoff = true
        activity.userInfo = ["route": route]
    }

    // MARK: - Contents

    /// Puts the page in, at the route this window was opened for.
    func showInterface(at url: URL, zoom: CGFloat) {
        let controller = WebViewController(baseURL: url, theme: theme)
        controller.onThemeChange = { [weak self] theme in self?.onThemeChange?(theme) }
        controller.onNewWindow = { [weak self] route in self?.onNewWindow?(route) }
        controller.onRouteChange = { [weak self] route, title in self?.pageMoved(to: route, title: title) }
        self.controller = controller

        // Assigning a content view controller resizes the window to the fitting
        // size of its view, and a web view has no intrinsic size — left alone
        // it collapses the window to its minimum. The frame is what the user
        // chose, so it is put back.
        let frame = window.frame
        window.contentViewController = controller
        window.setFrame(frame, display: true)

        controller.setZoom(zoom)
        controller.load(route: route)
        window.makeFirstResponder(controller.webView)
        // A backend that took a long minute to come up may have been left
        // alone in the meantime, in which case the app is already locked.
        controller.apply(lock: AppLock.shared.state)
    }

    /// Takes the page back out, for a backend that has stopped and is coming
    /// back: the route is kept, so the restart returns to the same screen.
    func showLaunch() {
        let frame = window.frame
        window.contentViewController = nil
        window.contentView = LaunchView(theme: theme)
        window.setFrame(frame, display: true)
        controller = nil
    }

    func apply(theme: String) {
        self.theme = theme
        window.appearance = Theme.appearance(for: theme)
        window.backgroundColor = Theme.chromeColor(for: theme)
        controller?.webView.underPageBackgroundColor = Theme.chromeColor(for: theme)
    }

    func show() {
        window.makeKeyAndOrderFront(nil)
        activity.becomeCurrent()
    }

    /// Sends the page somewhere, for a Spotlight result or a Handoff arriving
    /// at a window that is already open.
    func navigate(to route: String) {
        self.route = route
        controller?.navigate(to: route)
    }

    // MARK: - Where the page is

    private func pageMoved(to route: String, title: String) {
        self.route = route
        // The window's own title is hidden — the page draws its own chrome —
        // but it is what the Window menu, Mission Control and the ⌘` cycle
        // read, and with several windows open that is the only way to tell
        // them apart.
        window.title = title.isEmpty ? "Studex" : title
        activity.title = window.title
        activity.userInfo = ["route": route]
        activity.needsSave = true
        if window.isKeyWindow { activity.becomeCurrent() }
        onRouteChange?(self)
    }

    // MARK: - NSWindowDelegate

    func windowDidBecomeKey(_ notification: Notification) {
        activity.becomeCurrent()
    }

    func windowWillClose(_ notification: Notification) {
        activity.invalidate()
        onClose?(self)
    }
}
