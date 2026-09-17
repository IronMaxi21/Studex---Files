import AppKit
import WebKit

/// Hosts the Studex interface and provides the parts of a desktop app that a
/// web view cannot supply for itself: window dragging, save panels for
/// downloads, and a hard boundary around which URLs may load in-app.
/// The web view itself, for the one gesture AppKit will not pass on.
///
/// A two-finger double tap on the trackpad is `smartMagnifyWithEvent:`, and it
/// arrives at the view rather than at the page. WebKit's own answer is to
/// scale the whole document, which is wrong for an application — so
/// `allowsMagnification` is off, and the gesture would otherwise be dropped.
/// The canvas has a real use for it, so the point is handed over in CSS
/// pixels; if nothing on screen wants it, it goes back to being ignored.
final class StudexWebView: WKWebView {
    /// Who answers for the Continuity Camera items in the File menu.
    ///
    /// AppKit finds a services requestor by walking the responder chain from
    /// the first responder, and in this app the first responder is this view —
    /// WKWebView answers the same question for its own text selection, and a
    /// `nil` from it would end the walk before the controller behind it was
    /// ever asked. So the walk starts here, and anything this app has no
    /// opinion about is handed back to WebKit unchanged.
    weak var servicesRequestor: ContinuityCamera?

    override func validRequestor(
        forSendType sendType: NSPasteboard.PasteboardType?,
        returnType: NSPasteboard.PasteboardType?
    ) -> Any? {
        // Sending nothing and being handed a picture back: that shape of
        // request, and only that one, belongs to the camera.
        if sendType == nil || sendType?.rawValue.isEmpty == true,
           let returnType, ContinuityCamera.returnTypes.contains(returnType),
           let servicesRequestor {
            return servicesRequestor
        }
        return super.validRequestor(forSendType: sendType, returnType: returnType)
    }

    override func smartMagnify(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        // AppKit measures from the bottom of the view and the page from the
        // top, and both are divided by the page zoom to land in CSS pixels.
        let scale = max(pageZoom, 0.01)
        let x = point.x / scale
        let y = (bounds.height - point.y) / scale
        evaluateJavaScript("window.__studexSmartZoom && window.__studexSmartZoom(\(x), \(y))")
    }

    /// A three-finger swipe (when the trackpad is set to swipe between pages
    /// with three fingers) moves the focus to the pane on that side. It is
    /// never a Back: the window's history holds both panes, and going back in
    /// it would move the one the student was not looking at too.
    override func swipe(with event: NSEvent) {
        guard event.deltaX != 0 else { return super.swipe(with: event) }
        // AppKit reports a swipe towards the left as a positive deltaX.
        let side = event.deltaX > 0 ? "focus-left-pane" : "focus-right-pane"
        evaluateJavaScript("window.__studexCommand && window.__studexCommand('\(side)')")
    }
}

final class WebViewController: NSViewController {
    private let baseURL: URL

    /// The theme the app last resolved, painted behind the page until the page
    /// itself says otherwise.
    private let theme: String

    private(set) var webView: WKWebView!

    /// Called when the page reports which theme it is showing, so the window
    /// chrome can match it.
    var onThemeChange: ((String) -> Void)?

    /// Called when the page asks for another window, with the route it should
    /// open at — nil for a plain New Window, which starts where the app does.
    var onNewWindow: ((String?) -> Void)?

    /// Called when the page moves to another screen, with the route and what
    /// that screen is called. Routing is by hash and never leaves the
    /// document, so this is the only way out here to know where the page is.
    var onRouteChange: ((String, String) -> Void)?

    private static let bridgeName = "studex"
    private static let onboardedKey = "onboardingComplete"
    private static let pageStorageKey = "pageStorage"
    /// Bounds on what the page may park in the shell's defaults: preferences
    /// are small, and a page that tried to store a document here would be
    /// using the wrong place.
    private static let pageStorageMaxValue = 64 * 1024
    private static let pageStorageMaxTotal = 1024 * 1024

    /// The script that restores the page's saved `studex.` keys and mirrors
    /// later writes to them back to the shell.
    private static func pageStorageScript() -> String {
        let saved = UserDefaults.standard.dictionary(forKey: pageStorageKey) as? [String: String] ?? [:]
        let data = (try? JSONSerialization.data(withJSONObject: saved)) ?? Data("{}".utf8)
        let json = String(data: data, encoding: .utf8) ?? "{}"
        return """
        (function () {
          var saved = \(json);
          var store;
          try { store = window.localStorage; } catch (e) { return; }
          var proto = Object.getPrototypeOf(store);
          var set = proto.setItem, remove = proto.removeItem;
          try { for (var k in saved) set.call(store, k, saved[k]); } catch (e) {}
          function tell(key, value) {
            try { window.webkit.messageHandlers.\(bridgeName).postMessage({ name: 'storage', key: key, value: value }); } catch (e) {}
          }
          proto.setItem = function (key, value) {
            set.call(this, key, value);
            key = String(key);
            if (this === store && key.indexOf('studex.') === 0) tell(key, String(value));
          };
          proto.removeItem = function (key) {
            remove.call(this, key);
            key = String(key);
            if (this === store && key.indexOf('studex.') === 0) tell(key, null);
          };
        })();
        """
    }

    /// Keeps (or, for a nil value, forgets) one page preference.
    private static func storePageValue(key: String?, value: String?) {
        guard let key, key.hasPrefix("studex."), key.utf8.count <= 200 else { return }
        var saved = UserDefaults.standard.dictionary(forKey: pageStorageKey) as? [String: String] ?? [:]
        if let value {
            if value.utf8.count > pageStorageMaxValue {
                // Too big to keep: drop any older copy rather than restore a stale one.
                saved.removeValue(forKey: key)
                UserDefaults.standard.set(saved, forKey: pageStorageKey)
                return
            }
            saved[key] = value
            let total = saved.reduce(0) { $0 + $1.key.utf8.count + $1.value.utf8.count }
            if total > pageStorageMaxTotal { return }
        } else {
            saved.removeValue(forKey: key)
        }
        UserDefaults.standard.set(saved, forKey: pageStorageKey)
    }

    /// The receiving end of Continuity Camera. Held here because it has to
    /// outlive every individual capture, and because the web view has only a
    /// weak reference to it.
    private let camera = ContinuityCamera()

    /// Update progress is broadcast by the shared center; each window relays
    /// it to its own page.
    private var updateObserver: NSObjectProtocol?

    init(baseURL: URL, theme: String) {
        self.baseURL = baseURL
        self.theme = theme
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    deinit {
        // The content controller retains its handlers, so leaving this in
        // place would keep the controller alive with it.
        webView?.configuration.userContentController
            .removeScriptMessageHandler(forName: Self.bridgeName)
        if let updateObserver { NotificationCenter.default.removeObserver(updateObserver) }
    }

    override func loadView() {
        let configuration = WKWebViewConfiguration()

        // The default store is persistent and scoped to this bundle
        // identifier, which is what keeps the session cookie across launches.
        configuration.websiteDataStore = .default()
        // Through a weak proxy: the content controller retains its handlers, and
        // it is itself owned by this controller's web view, so handing it
        // `self` made a cycle that deinit — the only place it was broken — could
        // never run. Every closed window leaked its controller, its WebContent
        // process and its update observer.
        configuration.userContentController.add(WeakScriptHandler(self), name: Self.bridgeName)

        // First-launch onboarding is remembered here rather than in the page's
        // storage, which is lost with the port each launch. See onboarding.js.
        let onboarded = UserDefaults.standard.bool(forKey: Self.onboardedKey)
        configuration.userContentController.addUserScript(WKUserScript(
            source: "window.__studexOnboarded = \(onboarded);",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))

        // The page keeps its per-device preferences (density, extra accents,
        // palettes, shortcuts, the device id itself) in localStorage, which is
        // scoped to the origin — and the origin's port changes every launch, so
        // on its own every one of them was forgotten on relaunch. The shell
        // keeps a copy: it is put back before any page script runs, and every
        // write to a `studex.` key is mirrored over the bridge.
        configuration.userContentController.addUserScript(WKUserScript(
            source: Self.pageStorageScript(),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))

        // A second window is the shell's to make, asked for over the bridge
        // and opened by AppKit. A page that could open one for itself would be
        // a page doing something unintended.
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false

        if ProcessInfo.processInfo.environment["STUDEX_DEBUG"] == "1" {
            configuration.preferences.setValue(true, forKey: "developerExtrasEnabled")
        }

        let webView = StudexWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        // This is an app, not a browser: a two-finger swipe should scroll a
        // canvas, never navigate away from it.
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsMagnification = false
        // Painted behind the page so resizing and first paint never flash white.
        webView.underPageBackgroundColor = Theme.chromeColor(for: theme)

        // What the phone hands back arrives on a pasteboard, is turned into a
        // PDF, and is then the page's problem — it is the side holding the
        // session, and it already knows how to put a PDF into the library.
        camera.onCapture = { [weak self] name, pdf in self?.deliver(scan: name, pdf: pdf) }
        webView.servicesRequestor = camera
        // Nothing is offered to a service; a captured page is asked for. The
        // empty send list is what says so.
        NSApp.registerServicesMenuSendTypes([], returnTypes: ContinuityCamera.returnTypes)

        self.webView = webView

        // The web view is no longer the controller's whole view: the lock has
        // to be able to cover it, and a cover has to have somewhere to be.
        // Nothing else is in this container while the app is unlocked.
        let container = NSView()
        webView.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            webView.topAnchor.constraint(equalTo: container.topAnchor),
            webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        view = container
    }

    // MARK: - The lock

    private var lockView: LockView?

    /**
     Puts the cover up or takes it down.

     The web view is hidden rather than merely covered. A hidden view is not in
     the window's snapshot, so what Mission Control, a screen recording and
     ⇧⌘4 all get while the app is locked is the cover — which is the whole
     point, and would not be true of a view that was only underneath something.
     */
    func apply(lock state: LockState) {
        switch state {
        case .open:
            lockView?.removeFromSuperview()
            lockView = nil
            webView.isHidden = false
            view.window?.makeFirstResponder(webView)
        case .covered, .locked:
            let cover = lockView ?? makeLockView()
            cover.show(prompt: state == .locked)
            webView.isHidden = true
            // Taking the keyboard as well: the page is still loaded behind the
            // cover, and a first responder left on it would be typed into.
            view.window?.makeFirstResponder(cover)
        }
    }

    private func makeLockView() -> LockView {
        let light = view.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .aqua
        let cover = LockView(
            background: webView.underPageBackgroundColor,
            light: light
        )
        cover.onUnlock = { AppLock.shared.promptUnlock() }
        cover.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(cover)
        NSLayoutConstraint.activate([
            cover.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            cover.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            cover.topAnchor.constraint(equalTo: view.topAnchor),
            cover.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        lockView = cover
        return cover
    }

    /// Hands a finished scan to the page.
    ///
    /// Unlike every other message to the page this one carries megabytes, so it
    /// is passed as an argument rather than interpolated into a source string:
    /// `callAsyncJavaScript` marshals it as a value, which keeps a base64 blob
    /// out of the JavaScript the engine has to parse.
    private func deliver(scan name: String, pdf: Data) {
        webView.callAsyncJavaScript(
            "window.__studexScanned && window.__studexScanned(name, data);",
            arguments: ["name": name, "data": pdf.base64EncodedString()],
            in: nil,
            in: .page,
            completionHandler: nil
        )
    }

    /**
     Loads the interface, at a route if one is asked for.

     The route is put in the URL rather than navigated to afterwards, because
     the two are visibly different: a window restored onto a document should
     open showing that document, not show Home for as long as it takes a second
     message to cross the bridge and a second screen to render.
     */
    func load(route: String? = nil) {
        if let route { self.route = route }
        webView.load(URLRequest(url: url(for: self.route)))
    }

    func reload() {
        // Reload from the origin rather than the back-forward list, so a
        // half-loaded first attempt cannot be what comes back — and at the
        // route the window is on, so Reload is not also a Go Home.
        webView.load(URLRequest(url: url(for: route)))
    }

    /// Where the page is, as the page last reported it.
    private var route = "home"

    private func url(for route: String) -> URL {
        guard !route.isEmpty, route != "home",
              var parts = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        else { return baseURL }
        parts.fragment = "/" + route
        return parts.url ?? baseURL
    }

    /// Sends the page to a route it is not already on.
    func navigate(to route: String) {
        self.route = route
        // A Spotlight hit or a studex:// link can arrive before there is a
        // page to tell — the app may have been launched by it. Loading the
        // address outright is both the fix and the faster path, because the
        // page then comes up on the right screen instead of on Home first.
        guard webView.url != nil, !webView.isLoading else {
            load(route: route)
            return
        }
        guard let json = try? JSONSerialization.data(withJSONObject: [route]),
              let literal = String(data: json, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.__studexNavigate && window.__studexNavigate(\(literal)[0])")
    }

    /// Runs a menu command inside the page. Menu key equivalents are consumed
    /// by AppKit, so this is the only way they reach the app.
    func send(command: String) {
        guard let json = try? JSONSerialization.data(withJSONObject: [command]),
              let literal = String(data: json, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.__studexCommand && window.__studexCommand(\(literal)[0])")
    }

    func setZoom(_ factor: CGFloat) {
        webView.pageZoom = min(max(factor, 0.5), 2.5)
    }

    var zoom: CGFloat { webView.pageZoom }

    /**
     Prints what the web view is showing.

     `window.print()` is not implemented in WKWebView — calling it from the
     page does nothing, silently — so printing has to be AppKit's work. The
     page has already put itself into a printable shape by the time this runs
     (a deck becomes a sheet of cards, a canvas is fitted to its content), and
     it is waiting to be told when it may go back to being an interface.
     */
    private func printPage() {
        guard let window = view.window else { return }

        // The user's own paper size and orientation, copied rather than shared:
        // the print panel writes the choices back into whatever it is given,
        // and those belong to this print run and not to the whole application.
        let info = (NSPrintInfo.shared.copy() as? NSPrintInfo) ?? NSPrintInfo()
        info.horizontalPagination = .automatic
        info.verticalPagination = .automatic
        info.isHorizontallyCentered = false
        info.isVerticallyCentered = false

        let operation = webView.printOperation(with: info)
        operation.showsPrintPanel = true
        operation.showsProgressPanel = true
        // The printed view has no window to take a size from, so it is given
        // the page it is being printed onto; without this it lays out at zero
        // width and every page comes out blank.
        operation.view?.frame = NSRect(origin: .zero, size: info.paperSize)
        operation.runModal(
            for: window,
            delegate: self,
            didRun: #selector(printOperationDidRun(_:success:contextInfo:)),
            contextInfo: nil
        )
    }

    /// Whether it printed or was cancelled, the page has to be let back out of
    /// its printing shape — a deck left as a cram sheet would be unusable.
    @objc private func printOperationDidRun(
        _ operation: NSPrintOperation,
        success: Bool,
        contextInfo: UnsafeMutableRawPointer?
    ) {
        webView.evaluateJavaScript("window.__studexPrinted && window.__studexPrinted()")
    }

    /// Relays the shared update center's progress to this window's page.
    ///
    /// The page is told what is happening at each step rather than being left
    /// with a spinner: this replaces the application, and a user watching it
    /// happen is owed the detail. A failure leaves everything as it was — the
    /// swap is the last thing that happens and it is atomic.
    private func observeUpdates() {
        guard updateObserver == nil else { return }
        updateObserver = NotificationCenter.default.addObserver(
            forName: UpdateCenter.progressNotification, object: nil, queue: .main
        ) { [weak self] note in
            guard let progress = note.object as? UpdateProgress else { return }
            self?.report(progress)
        }
    }

    private func report(_ progress: UpdateProgress) {
        var payload: [String: Any] = ["stage": progress.stage.rawValue]
        if let fraction = progress.fraction { payload["fraction"] = fraction }
        if let message = progress.message { payload["message"] = message }
        if let version = progress.version { payload["version"] = version }
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.__studexUpdate && window.__studexUpdate(\(json))")
    }

    /// Tells the page what macOS will and will not let it do. The raw values
    /// are fixed slugs, so quoting them is enough to make them a JS literal.
    private func report(access: NotificationAccess) {
        webView.evaluateJavaScript(
            "window.__studexNotifications && window.__studexNotifications(\"\(access.rawValue)\")"
        )
    }

    /// Tells the page what the lock is set to and what this Mac can do about
    /// it. Every value is a fixed slug, a bool or a small integer, so the
    /// literal is built rather than serialised.
    private func reportLock() {
        let lock = AppLock.shared
        let payload: [String: Any] = [
            "supported": lock.canAuthenticate,
            "biometry": lock.biometry,
            "minutes": lock.delayMinutes,
            "share": lock.requiresAuthToShare,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.__studexLock && window.__studexLock(\(json))")
    }

    /// True for URLs belonging to the app itself. Everything else is the open
    /// internet and must not render inside the app's own origin, where it
    /// would share cookies and CSP with the real UI.
    private func isAppURL(_ url: URL) -> Bool {
        if url.scheme == "about" || url.scheme == "blob" { return true }
        guard let scheme = url.scheme, scheme == "http",
              let host = url.host, let port = url.port else { return false }
        return host == baseURL.host && port == baseURL.port
    }
}

// MARK: - Navigation

extension WebViewController: WKNavigationDelegate {
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        preferences: WKWebpagePreferences,
        decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void
    ) {
        // An anchor carrying `download` — the annotations export.
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download, preferences)
            return
        }
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel, preferences)
            return
        }
        if isAppURL(url) {
            decisionHandler(.allow, preferences)
            return
        }
        if ["http", "https", "mailto"].contains(url.scheme ?? "") {
            NSWorkspace.shared.open(url)
        }
        decisionHandler(.cancel, preferences)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        // A PDF renders in the viewer; anything WebKit cannot display is a file
        // the user asked for, so it is saved rather than silently discarded.
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        presentLoadFailure(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        presentLoadFailure(error)
    }

    private func presentLoadFailure(_ error: Error) {
        // A navigation this code cancelled on purpose is not a failure.
        if (error as NSError).code == NSURLErrorCancelled { return }
        guard let window = view.window else { return }

        let alert = NSAlert()
        alert.messageText = "Studex could not load its interface."
        alert.informativeText = error.localizedDescription
        alert.addButton(withTitle: "Try Again")
        alert.addButton(withTitle: "Quit")
        alert.beginSheetModal(for: window) { [weak self] response in
            if response == .alertFirstButtonReturn { self?.reload() } else { NSApp.terminate(nil) }
        }
    }
}

// MARK: - Page-initiated UI

extension WebViewController: WKUIDelegate {
    /// A link that asks for a window of its own.
    ///
    /// Studex has one window and no tabs, so with no handler here WebKit
    /// silently drops the click — which is the worst of the three possible
    /// outcomes, because nothing tells the person it was ignored. What asks
    /// for a new window is a page meant for the real browser, the Stripe
    /// checkout being the one that matters, so it is handed to the browser.
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url {
            if isAppURL(url) {
                // Part of the app itself: it belongs in the window there is.
                webView.load(navigationAction.request)
            } else if ["http", "https", "mailto"].contains(url.scheme ?? "") {
                NSWorkspace.shared.open(url)
            }
        }
        // Never a second WKWebView: it would have no session, no window and
        // no way to be closed.
        return nil
    }

    /// The UI has its own dialogs and never calls these, but a page that did
    /// would otherwise hang waiting for a handler that does not exist.
    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        guard let window = view.window else { completionHandler(); return }
        let alert = NSAlert()
        alert.messageText = "Studex"
        alert.informativeText = message
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        guard let window = view.window else { completionHandler(nil); return }
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }
}

// MARK: - Downloads

extension WebViewController: WKDownloadDelegate {
    func download(
        _ download: WKDownload,
        decideDestinationUsing response: URLResponse,
        suggestedFilename: String,
        completionHandler: @escaping (URL?) -> Void
    ) {
        guard let window = view.window else { completionHandler(nil); return }

        let panel = NSSavePanel()
        // Only the last path component is used: a server-supplied filename is
        // untrusted input and must not be able to steer where the file lands.
        panel.nameFieldStringValue = (suggestedFilename as NSString).lastPathComponent
        panel.canCreateDirectories = true
        panel.beginSheetModal(for: window) { result in
            guard result == .OK, let url = panel.url else { completionHandler(nil); return }
            // The panel has already asked about replacing, but WKDownload
            // refuses a destination that exists, so honour the answer here.
            try? FileManager.default.removeItem(at: url)
            completionHandler(url)
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let url = download.progress.fileURL else { return }
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        guard let window = view.window else { return }
        let alert = NSAlert()
        alert.messageText = "The download did not finish."
        alert.informativeText = error.localizedDescription
        alert.beginSheetModal(for: window, completionHandler: { _ in })
    }
}

// MARK: - Bridge

/// Forwards bridge messages without keeping the window's controller alive.
private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?

    init(_ target: WKScriptMessageHandler) { self.target = target }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

extension WebViewController: WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        // Only messages from the app's own origin are acted on; a frame
        // showing a PDF must not be able to drive the window.
        guard message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.host == baseURL.host,
              message.frameInfo.securityOrigin.port == baseURL.port ?? 0,
              let body = message.body as? [String: Any],
              let name = body["name"] as? String
        else { return }

        switch name {
        case "drag":
            view.window?.beginDragFromCurrentEvent()
        case "onboarded":
            UserDefaults.standard.set(true, forKey: Self.onboardedKey)
        case "storage":
            Self.storePageValue(key: body["key"] as? String, value: body["value"] as? String)
        case "titlebar-double-click":
            view.window?.performTitlebarDoubleClickAction()
        case "theme":
            onThemeChange?(body["theme"] as? String ?? "dark")
        case "route":
            let route = body["route"] as? String ?? "home"
            self.route = route
            onRouteChange?(route, body["title"] as? String ?? "")
        case "new-window":
            onNewWindow?(body["route"] as? String)
        case "spotlight":
            // The page holds the session, so it is the side that can read the
            // library; only the shell can hand it to macOS. What arrives is
            // the whole of what should be findable, which is why it replaces
            // the index rather than adding to it — a note deleted in the app
            // has to stop being a Spotlight result.
            Spotlight.replaceAll(with: body["items"] as? [[String: Any]] ?? [])
        case "prepare-update":
            guard let url = body["url"] as? String,
                  let sha256 = body["sha256"] as? String,
                  let version = body["version"] as? String
            else { break }
            observeUpdates()
            UpdateCenter.shared.prepare(
                url: url, sha256: sha256, signature: body["signature"] as? String, version: version)
        case "update-status":
            observeUpdates()
            UpdateCenter.shared.announce()
        case "restart-to-update":
            observeUpdates()
            UpdateCenter.shared.restart()
        case "notification-access":
            // Two questions share a case because they differ only in whether a
            // prompt is allowed: the interface asks on load without prompting,
            // and asks again with `prompt` when somebody switches a toggle on.
            let ask = body["prompt"] as? Bool ?? false
            let reply: (NotificationAccess) -> Void = { [weak self] access in
                self?.report(access: access)
            }
            if ask { Notifications.shared.requestAccess(reply) } else { Notifications.shared.access(reply) }
        case "badge":
            // The Dock tile is the application's, not this window's, so this
            // reaches past the controller on purpose. A count of nothing is an
            // absent badge rather than a badge reading zero.
            let due = (body["count"] as? NSNumber)?.intValue ?? 0
            NSApp.dockTile.badgeLabel = due > 0 ? String(due) : nil
            // The same number answers "how many cards are due" when a script
            // asks, without a script having to hold a session of its own.
            Automation.shared.cardsDue = due
            StatusBar.shared.update(due: due)
        case "next-lesson":
            // Beside the due count in the menu bar; nil when the day is done.
            StatusBar.shared.update(lesson: body["title"] as? String)
        case "lock-state":
            reportLock()
        case "set-lock":
            if let minutes = (body["minutes"] as? NSNumber)?.intValue {
                AppLock.shared.delayMinutes = AppLock.delayChoices.contains(minutes) ? minutes : 0
            }
            if let share = body["share"] as? Bool { AppLock.shared.requiresAuthToShare = share }
            reportLock()
        case "lock-now":
            AppLock.shared.lockNow()
        case "authenticate":
            // The reason is shown inside the system panel, above the app's own
            // name, so it is a phrase completing "Studex is trying to …" and
            // never anything the page composed out of a filename.
            let reason = body["reason"] as? String ?? "continue"
            AppLock.shared.authenticate(reason: reason) { [weak self] ok in
                self?.webView.evaluateJavaScript(
                    "window.__studexAuthenticated && window.__studexAuthenticated(\(ok))"
                )
            }
        case "print":
            printPage()
        case "notify":
            guard let id = body["id"] as? String,
                  let title = body["title"] as? String,
                  let text = body["body"] as? String
            else { break }
            Notifications.shared.post(id: id, title: title, body: text)
        default:
            break
        }
    }
}
