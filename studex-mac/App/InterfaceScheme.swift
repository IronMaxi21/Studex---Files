import AppKit
import Foundation
import UniformTypeIdentifiers
import WebKit

/// The interface, served from the bundle instead of from a server.
///
/// Studex ships its UI as ordinary files and runs a local backend for its
/// data. Loading the UI over `http://127.0.0.1:<port>` from that backend tied
/// the two together and, more importantly, made the app a *website* as far as
/// macOS is concerned: Screen Time applied its web limits to the view, WebKit
/// moved the page's storage every time the port changed, and the files sitting
/// in the bundle were only ever reached through a socket.
///
/// This handler takes http out of WebKit entirely. Pages, scripts, styles and
/// fonts are read from `Paths.webDirectory` — the downloaded files, opened
/// directly. Only `/api` and `/health` leave the process, and they leave it
/// here, in Swift, over a URLSession the page cannot see and cannot be
/// redirected away from. The page's origin is now a constant, so its local
/// storage survives a restart, and there is no website for a content rule to
/// match.
final class InterfaceScheme: NSObject {
    /// Private to this app. Not registered with the system, not resolvable by
    /// anything else, and not a scheme WebKit already has opinions about.
    static let scheme = "studex-app"
    static let pageHost = "studex"

    /// The one address the interface is ever loaded from.
    static let page = URL(string: "\(scheme)://\(pageHost)/")!

    /// Posted with the backend's address, or nil, whenever it moves.
    static let addressChanged = Notification.Name("StudexBackendAddressChanged")

    static let shared = InterfaceScheme()

    /// The session cookie the backend sets. Cookies ignore the port, so the
    /// session outlives a restart onto a different one.
    private static let csrfCookie = "studex_csrf"

    /// How long a request may wait for a backend that is restarting. Past
    /// this it fails like a dropped connection, which is what the offline bar
    /// in the page is built to show.
    private static let restartGrace: TimeInterval = 8

    // Everything below is touched on the main thread only. WebKit starts and
    // stops scheme tasks there, and the URLSession delegate hops back to it.
    private var backend: URL?
    private var waiting: [Exchange] = []
    private var live: [ObjectIdentifier: Exchange] = [:]
    private var byDataTask: [Int: Exchange] = [:]

    /// One request in flight: the WebKit side, the URLSession side, and enough
    /// state to guarantee nothing is delivered to a task that has been stopped.
    private final class Exchange {
        let task: WKURLSchemeTask
        var dataTask: URLSessionDataTask?
        var giveUp: DispatchWorkItem?
        var closed = false
        init(_ task: WKURLSchemeTask) { self.task = task }
    }

    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.default
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.urlCache = nil
        config.httpCookieStorage = .shared
        config.httpCookieAcceptPolicy = .always
        config.httpShouldSetCookies = true
        config.timeoutIntervalForRequest = 180
        config.timeoutIntervalForResource = 3600
        config.waitsForConnectivity = false
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1 // keeps response/data/completion in order
        queue.name = "studex.interface-scheme"
        return URLSession(configuration: config, delegate: self, delegateQueue: queue)
    }()

    /// A second session for whole-file transfers — downloads the page asks for
    /// by link, which WebKit cannot perform itself on a custom scheme.
    private lazy var transfers: URLSession = {
        let config = URLSessionConfiguration.default
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.urlCache = nil
        config.httpCookieStorage = .shared
        config.timeoutIntervalForRequest = 180
        config.timeoutIntervalForResource = 3600
        return URLSession(configuration: config)
    }()

    // MARK: - The backend's address

    /// Where the backend is now, or nil while the supervisor is restarting it.
    var address: URL? {
        dispatchPrecondition(condition: .onQueue(.main))
        return backend
    }

    func setAddress(_ url: URL?) {
        if Thread.isMainThread {
            apply(url)
        } else {
            DispatchQueue.main.async { [weak self] in self?.apply(url) }
        }
    }

    private func apply(_ url: URL?) {
        backend = url
        if url != nil {
            let held = waiting
            waiting = []
            for exchange in held {
                exchange.giveUp?.cancel()
                exchange.giveUp = nil
                begin(exchange)
            }
        }
        NotificationCenter.default.post(name: Self.addressChanged, object: url)
    }

    // MARK: - Routing

    /// True for the paths that belong to the backend rather than the bundle.
    private static func isBackendPath(_ path: String) -> Bool {
        path == "/health" || path == "/api" || path.hasPrefix("/api/")
    }

    // MARK: - Files

    private func serveFile(_ exchange: Exchange, url: URL) {
        let root = Paths.webDirectory.standardizedFileURL
        var relative = url.path
        if relative.hasPrefix("/") { relative.removeFirst() }
        relative = relative.removingPercentEncoding ?? relative
        if relative.isEmpty { relative = "index.html" }

        var file = root.appendingPathComponent(relative).standardizedFileURL
        // A path that climbs out of the bundle is a bug or an attack. Either
        // way it does not get to name a file.
        if !file.path.hasPrefix(root.path + "/") { file = root.appendingPathComponent("index.html") }

        var directory: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: file.path, isDirectory: &directory)
        if !exists || directory.boolValue {
            // The interface routes on the fragment, so any address that could
            // be a page is the page. A missing asset stays missing: handing
            // back HTML with a script's content type only hides the mistake.
            guard file.pathExtension.isEmpty || file.pathExtension == "html" else {
                respond(exchange, status: 404, headers: ["Content-Type": "text/plain; charset=utf-8"], body: Data("Not found".utf8))
                return
            }
            file = root.appendingPathComponent("index.html")
        }

        guard let data = try? Data(contentsOf: file, options: .mappedIfSafe) else {
            fail(exchange, URLError(.cannotOpenFile))
            return
        }

        var headers = [
            "Content-Type": Self.contentType(for: file),
            "Content-Length": String(data.count),
            "Accept-Ranges": "bytes",
            // The bundle is the only copy and it changes when the app updates.
            // Nothing is gained by caching it in front of a memory-mapped read.
            "Cache-Control": "no-store",
        ]
        if file.pathExtension == "html" { headers["Content-Security-Policy"] = Self.pagePolicy }

        // Media elements and PDF readers ask for byte ranges, and treat a
        // whole-file answer to a ranged request as a broken server.
        if let range = exchange.task.request.value(forHTTPHeaderField: "Range"),
           let slice = Self.resolveRange(range, count: data.count) {
            headers["Content-Range"] = "bytes \(slice.lowerBound)-\(slice.upperBound)/\(data.count)"
            headers["Content-Length"] = String(slice.count)
            respond(exchange, status: 206, headers: headers, body: data.subdata(in: slice.lowerBound ..< slice.upperBound + 1))
            return
        }
        respond(exchange, status: 200, headers: headers, body: data)
    }

    /// `bytes=start-end`, the only form anything here sends.
    private static func resolveRange(_ header: String, count: Int) -> ClosedRange<Int>? {
        guard count > 0 else { return nil }
        let spec = header.trimmingCharacters(in: .whitespaces)
        guard spec.hasPrefix("bytes=") else { return nil }
        let parts = spec.dropFirst("bytes=".count).split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 2 else { return nil }
        let first = Int(parts[0])
        let last = Int(parts[1])
        switch (first, last) {
        case let (start?, end?):
            guard start <= end, start < count else { return nil }
            return start ... min(end, count - 1)
        case let (start?, nil):
            guard start < count else { return nil }
            return start ... (count - 1)
        case let (nil, suffix?):
            guard suffix > 0 else { return nil }
            return max(0, count - suffix) ... (count - 1)
        default:
            return nil
        }
    }

    private static func contentType(for file: URL) -> String {
        let ext = file.pathExtension.lowercased()
        // Spelled out for the handful the interface actually ships, because a
        // wrong type here is a blank window rather than a warning.
        switch ext {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json", "map": return "application/json; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "woff2": return "font/woff2"
        case "woff": return "font/woff"
        case "ttf": return "font/ttf"
        case "otf": return "font/otf"
        case "wasm": return "application/wasm"
        case "txt": return "text/plain; charset=utf-8"
        default:
            if let type = UTType(filenameExtension: ext)?.preferredMIMEType { return type }
            return "application/octet-stream"
        }
    }

    /// The same policy the server sends with the interface, restated for the
    /// origin the page now has. `'self'` here means this bundle and nothing
    /// else: no remote script can be reached from the page at all.
    private static let pagePolicy = [
        "default-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self'",
        "connect-src 'self'",
        "media-src 'self' blob:",
        "object-src 'self'",
        // The sites an embed block is allowed to point at, and nothing else.
        // See EMBED_HOSTS in web/js/views/document.js — the two lists are the
        // same list, one checked before the frame is made and one enforced
        // whatever the page asks for.
        "frame-src 'self' blob: https://www.youtube-nocookie.com https://www.youtube.com "
            + "https://player.vimeo.com https://www.desmos.com https://www.geogebra.org "
            + "https://docs.google.com https://drive.google.com",
        "worker-src 'self' blob:",
        "child-src 'self' blob:",
    ].joined(separator: "; ")

    // MARK: - The backend

    /// Rewrites a request the page made against its own origin into one aimed
    /// at the backend, carrying the credentials the page no longer holds.
    ///
    /// Under a custom scheme the page has no cookie jar of its own, which is
    /// a gain rather than a loss: the session cookie now lives in Swift, out
    /// of reach of anything running in the page, and the CSRF token that used
    /// to be read from `document.cookie` is attached here instead.
    private func backendRequest(for url: URL, like original: URLRequest?) -> URLRequest? {
        guard let backend, var components = URLComponents(url: backend, resolvingAgainstBaseURL: false) else { return nil }
        components.path = url.path
        components.query = url.query
        guard let target = components.url else { return nil }

        var request = URLRequest(url: target)
        request.httpMethod = original?.httpMethod ?? "GET"
        // A request carries its body either whole or as a stream, never both:
        // Foundation clears one when the other is set, so assigning a nil
        // stream over a body would throw the body away.
        if let body = original?.httpBody {
            request.httpBody = body
        } else if let stream = original?.httpBodyStream {
            request.httpBodyStream = stream
        }
        request.httpShouldHandleCookies = true
        // Names this a first-party request to the backend, so the session
        // cookie's SameSite=Strict does not exclude it.
        request.mainDocumentURL = backend

        for (name, value) in original?.allHTTPHeaderFields ?? [:] {
            let lower = name.lowercased()
            // Host, Origin and Referer describe the page's origin, which the
            // backend has never heard of. Cookie and Content-Length are set
            // from what is actually being sent.
            if ["host", "origin", "referer", "cookie", "content-length", "connection", "accept-encoding"].contains(lower) { continue }
            request.setValue(value, forHTTPHeaderField: name)
        }
        // A streamed body has no length of its own to measure, so the one the
        // page stated is passed on rather than letting the send go chunked.
        if request.httpBody == nil, request.httpBodyStream != nil,
           let length = original?.value(forHTTPHeaderField: "Content-Length") {
            request.setValue(length, forHTTPHeaderField: "Content-Length")
        }
        request.setValue(backend.absoluteString, forHTTPHeaderField: "Origin")
        // Loopback. Compression costs CPU on both ends and would leave the
        // page without a usable Content-Length.
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        if let token = HTTPCookieStorage.shared.cookies(for: backend)?.first(where: { $0.name == Self.csrfCookie })?.value {
            request.setValue(token, forHTTPHeaderField: "x-csrf-token")
        }
        return request
    }

    private func begin(_ exchange: Exchange) {
        guard !exchange.closed, let url = exchange.task.request.url else { return }
        guard let request = backendRequest(for: url, like: exchange.task.request) else {
            fail(exchange, URLError(.cannotConnectToHost))
            return
        }
        let task = session.dataTask(with: request)
        exchange.dataTask = task
        byDataTask[task.taskIdentifier] = exchange
        task.resume()
    }

    // MARK: - Answering WebKit

    private func respond(_ exchange: Exchange, status: Int, headers: [String: String], body: Data) {
        guard !exchange.closed, let url = exchange.task.request.url else { return }
        guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) else {
            fail(exchange, URLError(.badServerResponse))
            return
        }
        exchange.task.didReceive(response)
        if !body.isEmpty { exchange.task.didReceive(body) }
        finish(exchange)
    }

    private func finish(_ exchange: Exchange) {
        guard !exchange.closed else { return }
        exchange.closed = true
        live[ObjectIdentifier(exchange.task)] = nil
        if let id = exchange.dataTask?.taskIdentifier { byDataTask[id] = nil }
        exchange.task.didFinish()
    }

    private func fail(_ exchange: Exchange, _ error: Error) {
        guard !exchange.closed else { return }
        exchange.closed = true
        live[ObjectIdentifier(exchange.task)] = nil
        if let id = exchange.dataTask?.taskIdentifier { byDataTask[id] = nil }
        exchange.task.didFailWithError(error)
    }

    // MARK: - Downloads

    /// Fetches one backend URL to a file on disk, with the session attached.
    ///
    /// WebKit will not run its own download machinery on a custom scheme, so
    /// export links are intercepted and completed here. The reply carries the
    /// name the backend suggested, when it suggested one.
    func download(path: String, completion: @escaping (Result<(URL, String?), Error>) -> Void) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let url = URL(string: "\(Self.scheme)://\(Self.pageHost)\(path)"),
              let request = backendRequest(for: url, like: nil) else {
            completion(.failure(URLError(.cannotConnectToHost)))
            return
        }
        transfers.downloadTask(with: request) { location, response, error in
            let outcome: Result<(URL, String?), Error>
            defer { DispatchQueue.main.async { completion(outcome) } }
            if let error {
                outcome = .failure(error)
                return
            }
            guard let location, let http = response as? HTTPURLResponse else {
                outcome = .failure(URLError(.badServerResponse))
                return
            }
            guard (200 ..< 300).contains(http.statusCode) else {
                outcome = .failure(URLError(.badServerResponse))
                return
            }
            // The temporary file is removed the moment this closure returns,
            // so it is moved somewhere the save panel can take its time over.
            let staged = FileManager.default.temporaryDirectory
                .appendingPathComponent("studex-download-\(UUID().uuidString)")
            do {
                try FileManager.default.moveItem(at: location, to: staged)
            } catch {
                outcome = .failure(error)
                return
            }
            outcome = .success((staged, Self.suggestedName(from: http)))
        }.resume()
    }

    private static func suggestedName(from response: HTTPURLResponse) -> String? {
        if let name = response.suggestedFilename, !name.isEmpty, name != "Unknown" { return name }
        guard let disposition = response.value(forHTTPHeaderField: "Content-Disposition") else { return nil }
        guard let range = disposition.range(of: "filename=") else { return nil }
        let raw = disposition[range.upperBound...]
            .prefix { $0 != ";" }
            .trimmingCharacters(in: .whitespaces)
            .trimmingCharacters(in: CharacterSet(charactersIn: "\""))
        return raw.isEmpty ? nil : raw
    }
}

// MARK: - WKURLSchemeHandler

extension InterfaceScheme: WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let exchange = Exchange(urlSchemeTask)
        live[ObjectIdentifier(urlSchemeTask)] = exchange

        guard let url = urlSchemeTask.request.url, url.host == Self.pageHost else {
            fail(exchange, URLError(.unsupportedURL))
            return
        }

        guard Self.isBackendPath(url.path) else {
            serveFile(exchange, url: url)
            return
        }

        guard backend != nil else {
            // The supervisor is restarting the backend. A page that reloads
            // into that window should see a slow answer, not a dead one —
            // and if the wait runs out, the failure looks like a dropped
            // connection, which is what the interface already handles.
            waiting.append(exchange)
            let giveUp = DispatchWorkItem { [weak self, weak exchange] in
                guard let self, let exchange else { return }
                self.waiting.removeAll { $0 === exchange }
                self.fail(exchange, URLError(.cannotConnectToHost))
            }
            exchange.giveUp = giveUp
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.restartGrace, execute: giveUp)
            return
        }
        begin(exchange)
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        guard let exchange = live.removeValue(forKey: ObjectIdentifier(urlSchemeTask)) else { return }
        // Nothing may be delivered to a stopped task, so it is closed before
        // the cancellation that will call back.
        exchange.closed = true
        exchange.giveUp?.cancel()
        waiting.removeAll { $0 === exchange }
        if let task = exchange.dataTask {
            byDataTask[task.taskIdentifier] = nil
            task.cancel()
        }
    }
}

// MARK: - URLSessionDataDelegate

extension InterfaceScheme: URLSessionDataDelegate {
    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        completionHandler(.allow)
        let id = dataTask.taskIdentifier
        DispatchQueue.main.async { [weak self] in
            guard let self, let exchange = byDataTask[id], !exchange.closed else { return }
            guard let http = response as? HTTPURLResponse, let url = exchange.task.request.url else {
                self.fail(exchange, URLError(.badServerResponse))
                return
            }
            var headers: [String: String] = [:]
            for (name, value) in http.allHeaderFields {
                guard let name = name as? String, let value = value as? String else { continue }
                // Set-Cookie is Swift's business now and means nothing to a
                // page with no cookie jar. The rest describe a connection the
                // page does not have.
                if ["set-cookie", "connection", "keep-alive", "transfer-encoding", "content-encoding"].contains(name.lowercased()) { continue }
                headers[name] = value
            }
            guard let mapped = HTTPURLResponse(url: url, statusCode: http.statusCode, httpVersion: "HTTP/1.1", headerFields: headers) else {
                self.fail(exchange, URLError(.badServerResponse))
                return
            }
            exchange.task.didReceive(mapped)
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        let id = dataTask.taskIdentifier
        DispatchQueue.main.async { [weak self] in
            guard let self, let exchange = byDataTask[id], !exchange.closed, !data.isEmpty else { return }
            exchange.task.didReceive(data)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let id = task.taskIdentifier
        DispatchQueue.main.async { [weak self] in
            guard let self, let exchange = byDataTask[id], !exchange.closed else {
                self?.byDataTask[id] = nil
                return
            }
            if let error {
                self.fail(exchange, error)
            } else {
                self.finish(exchange)
            }
        }
    }
}
