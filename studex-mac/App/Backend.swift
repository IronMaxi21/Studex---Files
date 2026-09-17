import Foundation

/// Launches and supervises the Node backend that serves both the API and the
/// interface.
///
/// The backend is bound to loopback on a port chosen at launch, so it is
/// reachable only from this machine and two copies of the app never collide.
final class Backend {
    /// Called on the main thread if the server exits without being asked to.
    var onUnexpectedExit: ((Int32) -> Void)?

    private(set) var baseURL: URL?

    private var process: Process?
    /// Held open for the child's lifetime; closing it is how the server learns
    /// this app is gone even when it never got to send a signal.
    private var parentPipe: Pipe?
    private var outputPipe: Pipe?
    /// Which launch is the live one. Bumped whenever a process is stopped on
    /// purpose, so its termination handler — which runs later, on another
    /// thread — can tell it was not an unexpected exit. A single Bool used to
    /// do this and was cleared by the next port retry before the failed
    /// attempt's handler ran, which put up "The Studex backend stopped" while
    /// a healthy server was still starting.
    private var generation = 0
    private let generationLock = NSLock()

    private let queue = DispatchQueue(label: "studex.backend")
    private let logLock = NSLock()
    /// Last few lines of server output, kept so a startup failure can say what
    /// actually went wrong instead of "it did not start".
    private var recentOutput: [String] = []

    // MARK: - Identity provider

    /// Supabase settings for the server child, if this build has any.
    ///
    /// Read from the app's own environment first so a development run can
    /// point at a different project without rebuilding, then from the file the
    /// build script bakes into Resources. Neither present means the server
    /// falls back to its own credentials, and both halves are required
    /// together — half of them would boot a server that fails every sign-in.
    private static func supabaseEnvironment() -> [String: String] {
        func pair(_ url: String?, _ key: String?) -> [String: String]? {
            guard let url, let key, !url.isEmpty, !key.isEmpty else { return nil }
            return ["SUPABASE_URL": url, "SUPABASE_ANON_KEY": key]
        }

        let environment = ProcessInfo.processInfo.environment
        if let fromEnvironment = pair(environment["SUPABASE_URL"], environment["SUPABASE_ANON_KEY"]) {
            return fromEnvironment
        }

        guard let data = try? Data(contentsOf: Paths.supabaseConfig),
              let parsed = (try? JSONSerialization.jsonObject(with: data)) as? [String: String]
        else { return [:] }
        return pair(parsed["url"], parsed["anonKey"]) ?? [:]
    }

    // MARK: - Starting

    func start(completion: @escaping (Result<URL, Error>) -> Void) {
        queue.async {
            do {
                let url = try self.launch()
                DispatchQueue.main.async { completion(.success(url)) }
            } catch {
                DispatchQueue.main.async { completion(.failure(error)) }
            }
        }
    }

    private func launch() throws -> URL {
        guard FileManager.default.fileExists(atPath: Paths.serverEntry.path) else {
            throw ShellError.serverMissing(Paths.serverEntry)
        }
        guard FileManager.default.fileExists(atPath: Paths.webDirectory.path) else {
            throw ShellError.webMissing(Paths.webDirectory)
        }
        let node = try Self.locateNode()

        try Paths.prepareDataDirectories()
        let secret = try SessionSecret.loadOrCreate()

        // A port is reserved and released rather than handed over directly,
        // which leaves a small window for something else to take it. Losing
        // that race is survivable and rare, so it is simply retried.
        var lastFailure: Error = ShellError.noFreePort
        for _ in 0 ..< 5 {
            guard let port = Self.reserveFreePort() else { throw ShellError.noFreePort }
            do {
                return try run(node: node, port: port, secret: secret)
            } catch {
                lastFailure = error
                stopProcess()
            }
        }
        throw lastFailure
    }

    private func run(node: URL, port: UInt16, secret: String) throws -> URL {
        let base = URL(string: "http://127.0.0.1:\(port)")!

        let task = Process()
        task.executableURL = node
        task.arguments = [Paths.serverEntry.path]
        task.currentDirectoryURL = Paths.serverDirectory

        var env: [String: String] = [
            "NODE_ENV": "production",
            "HOST": "127.0.0.1",
            "PORT": String(port),
            "WEB_DIR": Paths.webDirectory.path,
            "DATABASE_PATH": Paths.dataDirectory.appendingPathComponent("studex.sqlite").path,
            "STORAGE_DIR": Paths.dataDirectory.appendingPathComponent("blobs").path,
            "SESSION_SECRET": secret,
            // Loopback http: there is no transport to secure, and a Secure
            // cookie would simply never be stored. See config.ts.
            "COOKIE_SECURE": "false",
            // Lets the server notice if this app dies without signalling.
            "PARENT_PIPE": "1",
            "LOG_LEVEL": ProcessInfo.processInfo.environment["STUDEX_LOG_LEVEL"] ?? "info",
            // What this build calls itself, so the Updates screen has
            // something to compare a release against. The server cannot work
            // this out for itself — it has no bundle. Where the releases are
            // is not passed down any more: they are a table in the Supabase
            // project, which the server is already told about below.
            "STUDEX_VERSION": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0",
            "STUDEX_BUILD": Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "",
            "HOME": NSHomeDirectory(),
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        ]
        // Which is why anything the server genuinely needs is handed over
        // deliberately, this included.
        for (key, value) in Self.supabaseEnvironment() { env[key] = value }
        // A release build carries its own AI key, so AI works out of the box.
        if FileManager.default.fileExists(atPath: Paths.builtinAiKey.path) {
            env["GEMINI_BUILTIN_KEY_FILE"] = Paths.builtinAiKey.path
        }
        // The child inherits nothing else: the app's own environment may carry
        // anything, and none of it is the server's business.
        env["TMPDIR"] = ProcessInfo.processInfo.environment["TMPDIR"]
        task.environment = env.compactMapValues { $0 }

        let parent = Pipe()
        let output = Pipe()
        task.standardInput = parent
        task.standardOutput = output
        task.standardError = output
        parentPipe = parent
        outputPipe = output

        startLogging(output)

        let attempt = currentGeneration()
        task.terminationHandler = { [weak self] proc in
            guard let self, self.currentGeneration() == attempt else { return }
            let code = proc.terminationStatus
            DispatchQueue.main.async { self.onUnexpectedExit?(code) }
        }

        try task.run()
        process = task

        try waitUntilReady(base: base, task: task)
        baseURL = base
        return base
    }

    /// Polls `/health` until the server answers. The server does its schema
    /// migration during boot, so "the port is open" is not the same as "it is
    /// ready" — only a real response counts.
    private func waitUntilReady(base: URL, task: Process) throws {
        let deadline = Date().addingTimeInterval(30)
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: base.appendingPathComponent("health"))
        request.timeoutInterval = 2

        while Date() < deadline {
            if !task.isRunning {
                throw ShellError.serverExited(code: task.terminationStatus, log: tail())
            }

            let ready = DispatchSemaphore(value: 0)
            // Read under a lock: when the wait times out the callback can still
            // land afterwards, on URLSession's own queue.
            let okLock = NSLock()
            var ok = false
            session.dataTask(with: request) { _, response, _ in
                okLock.lock(); ok = (response as? HTTPURLResponse)?.statusCode == 200; okLock.unlock()
                ready.signal()
            }.resume()
            _ = ready.wait(timeout: .now() + 3)

            okLock.lock(); let answered = ok; okLock.unlock()
            if answered { return }
            Thread.sleep(forTimeInterval: 0.1)
        }
        throw ShellError.serverNotReady(log: tail())
    }

    // MARK: - Stopping

    func stop() {
        stopProcess()
        baseURL = nil
    }

    private func currentGeneration() -> Int {
        generationLock.lock(); defer { generationLock.unlock() }
        return generation
    }

    private func stopProcess() {
        generationLock.lock(); generation += 1; generationLock.unlock()
        guard let task = process else { return }
        process = nil

        // Closing the pipe first means that even a server that ignores the
        // signal still sees end-of-stream and shuts itself down.
        try? parentPipe?.fileHandleForWriting.close()
        parentPipe = nil

        if task.isRunning {
            task.terminate()
            // SQLite needs a moment to finish and unlock; killing straight
            // away risks leaving a hot journal behind.
            let deadline = Date().addingTimeInterval(5)
            while task.isRunning, Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
            if task.isRunning { kill(task.processIdentifier, SIGKILL) }
        }

        outputPipe?.fileHandleForReading.readabilityHandler = nil
        outputPipe = nil
    }

    // MARK: - Logging

    private static let logSizeLimit: UInt64 = 2 * 1024 * 1024

    private func startLogging(_ pipe: Pipe) {
        let fm = FileManager.default
        let path = Paths.serverLog.path

        // Nobody prunes this file, so each launch starts clean once it has
        // grown past the point of being useful to read.
        let size = (try? fm.attributesOfItem(atPath: path)[.size] as? NSNumber)??.uint64Value ?? 0
        if !fm.fileExists(atPath: path) || size > Self.logSizeLimit {
            fm.createFile(atPath: path, contents: nil, attributes: [.posixPermissions: 0o600])
        }

        let log = try? FileHandle(forWritingTo: Paths.serverLog)
        _ = try? log?.seekToEnd()

        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            try? log?.write(contentsOf: data)
            guard let text = String(data: data, encoding: .utf8) else { return }
            self?.remember(text)
        }
    }

    private func remember(_ text: String) {
        logLock.lock()
        defer { logLock.unlock() }
        for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
            recentOutput.append(String(line))
        }
        if recentOutput.count > 40 { recentOutput.removeFirst(recentOutput.count - 40) }
    }

    private func tail() -> String {
        logLock.lock()
        defer { logLock.unlock() }
        let lines = recentOutput.suffix(12)
        if lines.isEmpty { return "The backend produced no output. Full log: \(Paths.serverLog.path)" }
        return lines.joined(separator: "\n") + "\n\nFull log: \(Paths.serverLog.path)"
    }

    // MARK: - Runtime discovery

    private static func locateNode() throws -> URL {
        var candidates: [URL] = [Paths.bundledNode]
        if let override = ProcessInfo.processInfo.environment["NODE_BINARY"], !override.isEmpty {
            candidates.insert(URL(fileURLWithPath: override), at: 0)
        }
        // A GUI app is launched by launchd, not a login shell, so the user's
        // PATH is not available here; the usual install locations are checked
        // by hand instead.
        candidates += ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node",
                       "/opt/local/bin/node"].map { URL(fileURLWithPath: $0) }
        if let home = ProcessInfo.processInfo.environment["HOME"] {
            candidates.append(URL(fileURLWithPath: home).appendingPathComponent(".volta/bin/node"))
            candidates.append(URL(fileURLWithPath: home).appendingPathComponent(".local/bin/node"))
        }

        for candidate in candidates where FileManager.default.isExecutableFile(atPath: candidate.path) {
            return candidate
        }
        throw ShellError.nodeMissing
    }

    /// Asks the kernel for an unused loopback port by binding to port 0 and
    /// reading back what it chose.
    private static func reserveFreePort() -> UInt16? {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        defer { close(fd) }

        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")

        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0 else { return nil }

        var actual = sockaddr_in()
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let named = withUnsafeMutablePointer(to: &actual) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
        }
        guard named == 0 else { return nil }

        let port = UInt16(bigEndian: actual.sin_port)
        return port == 0 ? nil : port
    }
}
