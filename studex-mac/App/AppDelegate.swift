import AppKit
import CoreSpotlight

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let backend = Backend()

    /**
     Every open window, in the order they were opened.

     One backend and one session sit behind all of them: the web views share
     the default website data store, so signing in once signs in everywhere,
     and a document saved in one window is the same row the other window is
     watching.
     */
    private var windows: [StudexWindow] = []

    /// Set once the app is on its way out, so that the windows closing behind
    /// it cannot rewrite the list of routes to reopen.
    private var isQuitting = false

    /// Where the backend is listening, once it is. Held because a window
    /// opened later has to be pointed at it too.
    private var serverURL: URL?

    /// The theme the window opens in, before the page has an opinion.
    ///
    /// The web layer resolves the account's setting and follows the system
    /// live, but it can say nothing at all until it has loaded — and "dark
    /// until told otherwise" meant a light-theme user got a dark window, a
    /// dark launch view and dark traffic lights on every single launch,
    /// followed by a flash. So the last answer is remembered beside the zoom
    /// level, and a first launch, having nothing to remember, asks the system
    /// rather than guessing.
    private var theme = "dark"

    private static let zoomKey = "InterfaceZoom"
    private static let themeKey = "InterfaceTheme"
    private static let frameName = "StudexMainWindow"
    private static let routesKey = "OpenWindowRoutes"

    /// Enough windows for two displays and a spare, and few enough that a
    /// stuck loop cannot paper the screen with them.
    private static let windowLimit = 8

    // MARK: - Lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        theme = Self.rememberedTheme()
        NSApp.mainMenu = MainMenu.build(target: self)
        for route in Self.rememberedRoutes() { open(route: route) }
        NSApp.activate(ignoringOtherApps: true)

        // Claimed before anything can post, so a notification tapped while the
        // app is running raises the window instead of doing nothing.
        Notifications.shared.prepare()

        // The cover follows the lock, and a controller may not exist yet —
        // there is nothing to hide behind a launch screen, so a state arriving
        // before one does is simply applied when it appears.
        AppLock.shared.onChange = { [weak self] state in
            guard let self else { return }
            for studex in self.windows { studex.controller?.apply(lock: state) }
        }
        AppLock.shared.start()

        Automation.shared.delegate = self
        StatusBar.shared.host = self
        StatusBar.shared.start()

        backend.onUnexpectedExit = { [weak self] code in self?.backendStopped(code) }
        startBackend()
    }

    func applicationWillTerminate(_ notification: Notification) {
        rememberRoutes()
        // An update downloaded and left for later goes in now, so the next
        // launch is already the new version.
        UpdateCenter.shared.installOnQuit()
        // Synchronous on purpose: the database has to be closed cleanly before
        // this process goes away, and there is no later moment to do it in.
        backend.stop()
    }

    /// The routes to reopen are taken here, before anything starts closing.
    /// Quitting closes the windows one at a time, and each close would
    /// otherwise shorten the list until only the last window was remembered.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        // Empty means the last window was closed by hand, and `forget` has
        // already left the route it held to reopen next launch.
        if !windows.isEmpty { rememberRoutes() }
        isQuitting = true
        return .terminateNow
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    /// Clicking the Dock icon with every window closed makes one, rather than
    /// bringing the app forward with nothing to show.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if windows.isEmpty { open(route: "home") }
        return true
    }

    // MARK: - Theme

    private static func rememberedTheme() -> String {
        if let stored = UserDefaults.standard.string(forKey: themeKey),
           stored == "light" || stored == "dark" {
            return stored
        }
        // Nothing remembered: the system's own answer is a far better opening
        // bid than a constant, and it is what a `system` account resolves to.
        return NSApp.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            ? "dark"
            : "light"
    }

    // MARK: - Windows

    /**
     What was open last time.

     Closing the app in the middle of a chapter and coming back to the library
     is a small daily tax, and it is the one thing a shell can fix for free —
     the route is three words and the page knows how to open itself at one.
     A first launch has nothing written down and starts at Home.
     */
    private static func rememberedRoutes() -> [String] {
        let stored = UserDefaults.standard.stringArray(forKey: routesKey) ?? []
        let routes = stored.filter { !$0.isEmpty }.prefix(windowLimit)
        return routes.isEmpty ? ["home"] : Array(routes)
    }

    private func rememberRoutes() {
        guard !isQuitting else { return }
        UserDefaults.standard.set(windows.map(\.route), forKey: Self.routesKey)
    }

    /// The window a menu command is about: the one in front.
    private var current: StudexWindow? {
        windows.first(where: { $0.window.isKeyWindow })
            ?? windows.first(where: { $0.window.isMainWindow })
            ?? windows.last
    }

    @discardableResult
    private func open(route: String) -> StudexWindow? {
        guard windows.count < Self.windowLimit else {
            // Not silently: a command that does nothing reads as a broken app.
            NSSound.beep()
            return nil
        }

        // The saved frame belongs to the first window. A second one taking it
        // would open exactly on top of the first, which is the opposite of
        // what asking for another window means.
        let previous = windows.last?.window
        let studex = StudexWindow(
            theme: theme,
            route: route,
            frameAutosave: windows.isEmpty ? Self.frameName : nil
        )
        if let previous {
            studex.window.setFrame(previous.frame, display: false)
            studex.window.cascadeTopLeft(from: previous.cascadeTopLeft(from: .zero))
        }

        studex.onClose = { [weak self] closed in self?.forget(closed) }
        studex.onThemeChange = { [weak self] theme in self?.applyTheme(theme) }
        studex.onRouteChange = { [weak self] _ in self?.rememberRoutes() }
        studex.onNewWindow = { [weak self] route in
            guard let self else { return }
            self.open(route: route ?? "home")?.show()
        }

        windows.append(studex)
        if let serverURL { studex.showInterface(at: serverURL, zoom: Self.rememberedZoom()) }
        studex.show()
        rememberRoutes()
        return studex
    }

    private func forget(_ closed: StudexWindow) {
        windows.removeAll { $0 === closed }
        // Written while the windows are still known. On the way out of the
        // last one this is the list the next launch reopens, and by the time
        // the app terminates it is already empty.
        if !windows.isEmpty { rememberRoutes() }
    }

    private static func rememberedZoom() -> CGFloat {
        CGFloat(UserDefaults.standard.double(forKey: zoomKey).nonZero ?? 1)
    }

    private func startBackend() {
        backend.start { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let url):
                self.serverURL = url
                for studex in self.windows {
                    studex.showInterface(at: url, zoom: Self.rememberedZoom())
                }
            case .failure(let error):
                self.presentFatal(error)
            }
        }
    }

    private func applyTheme(_ theme: String) {
        // Written every time, not only on a change: what the page reports is
        // the answer the next launch should open with, and on the launch that
        // already guessed right there is no change to hang the write on.
        UserDefaults.standard.set(theme, forKey: Self.themeKey)
        guard theme != self.theme else { return }
        self.theme = theme
        for studex in windows { studex.apply(theme: theme) }
    }

    // MARK: - Handoff, Spotlight and URLs

    /**
     Something outside the app asking for a particular screen.

     Three doors lead here and all of them mean the same thing. A Spotlight
     result carries the file's identifier; a Handoff from another Mac carries
     the route the window there was on; `studex://` carries a route typed by a
     Shortcut. Each is answered in the window in front, because that is the one
     the person is looking at — with none open, a window is made for it.
     */
    func application(
        _ application: NSApplication,
        continue userActivity: NSUserActivity,
        restorationHandler: @escaping ([any NSUserActivityRestoring]) -> Void
    ) -> Bool {
        if userActivity.activityType == CSSearchableItemActionType,
           let id = userActivity.userInfo?[CSSearchableItemActivityIdentifier] as? String,
           let route = Spotlight.route(forItem: id) {
            go(to: route)
            return true
        }
        if userActivity.activityType == StudexWindow.activityType,
           let route = userActivity.userInfo?["route"] as? String {
            go(to: route)
            return true
        }
        return false
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        // studex://doc/<uuid> — the path is the route, and nothing else about
        // the URL is honoured: this opens screens and never runs anything.
        for url in urls where url.scheme == "studex" {
            let route = ((url.host.map { $0 + "/" } ?? "") + url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")))
                .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            go(to: route.isEmpty ? "home" : route)
        }
    }

    /// Shows a route, in the window in front or in a new one.
    func go(to route: String) {
        NSApp.activate(ignoringOtherApps: true)
        if let studex = current {
            studex.navigate(to: route)
            studex.show()
        } else {
            open(route: route)?.show()
        }
        rememberRoutes()
    }

    // MARK: - Failure

    private func presentFatal(_ error: Error) {
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = (error as? LocalizedError)?.errorDescription ?? "Studex could not start."
        alert.informativeText = (error as? LocalizedError)?.recoverySuggestion ?? error.localizedDescription
        alert.addButton(withTitle: "Quit")
        alert.addButton(withTitle: "Show Log")
        let response = alert.runModal()
        if response == .alertSecondButtonReturn { revealServerLog(nil) }
        NSApp.terminate(nil)
    }

    private func backendStopped(_ code: Int32) {
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "The Studex backend stopped."
        alert.informativeText = """
        It exited with status \(code). Your library is unchanged — restarting reopens it from disk.
        """
        alert.addButton(withTitle: "Restart")
        alert.addButton(withTitle: "Quit")
        alert.addButton(withTitle: "Show Log")

        switch alert.runModal() {
        case .alertFirstButtonReturn:
            serverURL = nil
            // Every window goes back to its launch screen and comes back on
            // the screen it was showing: each one remembers its own route.
            for studex in windows { studex.showLaunch() }
            startBackend()
        case .alertThirdButtonReturn:
            revealServerLog(nil)
            NSApp.terminate(nil)
        default:
            NSApp.terminate(nil)
        }
    }

    // MARK: - Menu actions

    @objc func newWindow(_ sender: Any?) {
        open(route: "home")?.show()
    }

    @objc func runWebCommand(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String else { return }
        current?.controller?.send(command: name)
    }

    @objc func reloadInterface(_ sender: Any?) {
        current?.controller?.reload()
    }

    @objc func resetZoom(_ sender: Any?) { setZoom(1) }
    @objc func zoomIn(_ sender: Any?) { setZoom((current?.controller?.zoom ?? 1) + 0.1) }
    @objc func zoomOut(_ sender: Any?) { setZoom((current?.controller?.zoom ?? 1) - 0.1) }

    private func setZoom(_ factor: CGFloat) {
        guard let controller = current?.controller else { return }
        controller.setZoom(factor)
        // Remembered for the next window and the next launch: a zoom level is
        // a statement about this screen and these eyes, not about one window.
        UserDefaults.standard.set(Double(controller.zoom), forKey: Self.zoomKey)
    }

    /// Locks the window now, for somebody standing up to leave.
    @objc func lockApp(_ sender: Any?) {
        AppLock.shared.lockNow()
    }

    @objc func revealDataFolder(_ sender: Any?) {
        _ = try? Paths.prepareDataDirectories()
        NSWorkspace.shared.activateFileViewerSelecting([Paths.dataDirectory])
    }

    @objc func revealServerLog(_ sender: Any?) {
        guard FileManager.default.fileExists(atPath: Paths.serverLog.path) else {
            NSWorkspace.shared.activateFileViewerSelecting([Paths.logDirectory])
            return
        }
        NSWorkspace.shared.activateFileViewerSelecting([Paths.serverLog])
    }

    /// Everything that talks to the page is meaningless until there is a page.
    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        switch menuItem.action {
        case #selector(runWebCommand(_:)), #selector(reloadInterface(_:)),
             #selector(resetZoom(_:)), #selector(zoomIn(_:)), #selector(zoomOut(_:)):
            return current?.controller != nil
        case #selector(newWindow(_:)):
            return windows.count < Self.windowLimit
        case #selector(lockApp(_:)):
            // Greyed out rather than absent on a Mac that cannot authenticate,
            // because locking a window that nothing can unlock is a trap.
            return current?.controller != nil && AppLock.shared.canAuthenticate
        default:
            return true
        }
    }
}

/**
 What a script is allowed to ask the app to do.

 The interface is the side holding the session, so anything that needs the
 library is a question put to the page in front rather than answered here.
 */
extension AppDelegate: AutomationHost {
    var isUnlocked: Bool { AppLock.shared.state == .open }

    func goInNewWindow(_ route: String) {
        NSApp.activate(ignoringOtherApps: true)
        open(route: route)?.show()
        rememberRoutes()
    }

    func runCommand(_ name: String) {
        NSApp.activate(ignoringOtherApps: true)
        guard let studex = current ?? open(route: "home") else { return }
        studex.show()
        studex.controller?.send(command: name)
    }
}

private extension Double {
    /// A missing UserDefaults key reads as 0, which is not a usable zoom.
    var nonZero: CGFloat? { self > 0 ? CGFloat(self) : nil }
}
