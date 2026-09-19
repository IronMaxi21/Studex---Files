import Foundation

/// Launches and supervises the Node backend that serves both the API and the
/// interface.
///
/// The backend is bound to loopback on a port chosen at launch, so it is
/// reachable only from this machine and two copies of the app never collide.
///
/// It is also an implementation detail, and this class exists to keep it one.
/// Studex is an app, not something you administer: nobody who opens it has
/// agreed to keep a server running, so a backend that stops is this class's
/// problem to solve rather than news to break to the person using it. It
/// restarts it, backing off if that keeps happening, and watches the health
/// endpoint so a process that is alive but wedged is treated the same as one
/// that died. Only after several attempts inside a short window — the shape of
/// a real fault rather than a hiccup — does anyone get told.
final class Backend {
    /// Where the supervisor is up to. Delivered on the main thread.
    enum Status {
        /// Coming up: a first launch, or a restart after a stumble.
        case starting
        /// Serving, at this address.
        case ready(URL)
        /// Out of attempts. The app asks the person what to do.
        case unavailable(Error)
    }

    /// Called on the main thread whenever the answer to "is there a backend?"
    /// changes.
    var onStatus: ((Status) -> Void)?

    private(set) var baseURL: URL?

    /// How many launches in a row have failed. Reset by a server that stays up
    /// long enough to count as having worked.
    private var attempts = 0

    /// Set while the app has asked for no backend at all, so that a process
    /// dying because it was told to is not mistaken for one that fell over.
    private var stopped = true

    /// When the current server started answering, used to tell a one-off
    /// stumble apart from a crash loop.
    private var readySince: Date?

    private var watchdog: DispatchSourceTimer?
    private var missedChecks = 0

    /// A server that has been up this long was working; whatever just happened
    /// to it is a fresh incident and starts its own count.
    private static let stableRun: TimeInterval = 90

    /// Attempts inside one incident before the person is asked. Five covers
    /// everything transient — a port taken, a slow disk, a crash on a single
    /// bad row — and stops short of restarting for ever in the background.
    private static let giveUpAfter = 5

    /// Waits between attempts: quick, then quickly out of the way.
    private static func backoff(_ attempt: Int) -> TimeInterval {
        min(0.5 * pow(2, Double(max(0, attempt - 1))), 10)
    }

    private var process: Process?
    /// Held open for the child's lifetime; closing it is how the server learns
    /// this app is gone even when it never got to send a signal.
    private var parentPipe: Pipe?
    private var outputPipe: Pipe?
    private var logHandle: FileHandle?
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

    /// Starts the backend and keeps it running. Safe to call again after the
    /// supervisor has given up: that is what the "Try Again" button does.
    func start() {
        queue.async {
            self.stopped = false
            self.attempts = 0
            self.cycle()
        }
    }

    /// One supervision cycle: try to have a server, and deal with it if that
    /// does not work out. Runs on `queue`.
    private func cycle() {
        guard !stopped else { return }
        report(.starting)
        do {
            let url = try launch()
            attempts = 0
            readySince = Date()
            baseURL = url
            startWatchdog(base: url)
            report(.ready(url))
        } catch {
            lost(to: error)
        }
    }

    /// There is no working server. Decides between trying again and saying so.
    /// Runs on `queue`.
    private func lost(to error: Error) {
        guard !stopped else { return }
        stopWatchdog()
        // Whatever is left of the last attempt goes now: a half-dead process
        // still holds the database file and the pipes it was writing to.
        stopProcess()
        baseURL = nil

        // A server that had been up and serving for a while is not part of
        // whatever went wrong earlier in the session, so this incident counts
        // from one rather than inheriting a count from an hour ago.
        if let readySince, Date().timeIntervalSince(readySince) > Self.stableRun { attempts = 0 }
        readySince = nil

        attempts += 1
        guard attempts < Self.giveUpAfter else {
            report(.unavailable(error))
            return
        }

        report(.starting)
        queue.asyncAfter(deadline: .now() + Self.backoff(attempts)) { [weak self] in
            self?.cycle()
        }
    }

    private func report(_ status: Status) {
        DispatchQueue.main.async { self.onStatus?(status) }
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
            // Which kind of build is asking. The server hides the screens that
            // are ours rather than a user's when this says `release`; a server
            // someone runs themselves is told nothing and stays open.
            "STUDEX_CHANNEL": Paths.channel,
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
            // Onto the supervisor's queue rather than the main thread: nobody
            // is being told about this yet, it is being fixed.
            self.queue.async { self.lost(to: ShellError.serverExited(code: code, log: self.tail())) }
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
        stopped = true
        stopWatchdog()
        stopProcess()
        baseURL = nil
    }

    // MARK: - Watchdog

    /// How often a running server is asked whether it is still there.
    private static let healthInterval: TimeInterval = 15

    /// Misses in a row before the server is considered gone. A single missed
    /// check means very little — a long migration, a big import, a Mac waking
    /// up — so three of them, three quarters of a minute apart, is the point at
    /// which "busy" stops being a plausible explanation.
    private static let missesAllowed = 3

    /**
     Watches a running server for the failure the termination handler cannot
     see: the process is alive, so nothing exits and nothing is reported, but
     its event loop is stuck and no request is ever answered again. From the
     window it is indistinguishable from a crash — the app simply stops working
     — and before this it was the case that actually made people quit and
     reopen Studex.
     */
    private func startWatchdog(base: URL) {
        stopWatchdog()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + Self.healthInterval, repeating: Self.healthInterval)
        timer.setEventHandler { [weak self] in self?.checkHealth(base: base) }
        watchdog = timer
        timer.resume()
    }

    private func stopWatchdog() {
        watchdog?.cancel()
        watchdog = nil
        missedChecks = 0
    }

    private func checkHealth(base: URL) {
        guard !stopped, let task = process else { return }
        guard task.isRunning else { return }  // the termination handler has this

        if healthy(base: base) {
            missedChecks = 0
            return
        }
        missedChecks += 1
        guard missedChecks >= Self.missesAllowed else { return }

        // Stopped rather than left alone: a wedged process still holds the
        // database and the port, and the replacement needs both.
        stopWatchdog()
        stopProcess()
        lost(to: ShellError.serverStalled(log: tail()))
    }

    /// One /health request, answered synchronously because this is already on
    /// the supervisor's own queue and there is nothing else for it to do.
    private func healthy(base: URL) -> Bool {
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: base.appendingPathComponent("health"))
        request.timeoutInterval = 5

        let done = DispatchSemaphore(value: 0)
        let lock = NSLock()
        var ok = false
        session.dataTask(with: request) { _, response, _ in
            lock.lock(); ok = (response as? HTTPURLResponse)?.statusCode == 200; lock.unlock()
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 8)
        lock.lock(); defer { lock.unlock() }
        return ok
    }

    private func currentGeneration() -> Int {
        generationLock.lock(); defer { generationLock.unlock() }
        return generation
    }

    /// Lets go of everything the current attempt owns. Written to be safe with
    /// no process at all, because a restart calls it on the way past whether
    /// the last server exited by itself or is still standing.
    private func stopProcess() {
        generationLock.lock(); generation += 1; generationLock.unlock()
        let task = process
        process = nil

        // Closing the pipe first means that even a server that ignores the
        // signal still sees end-of-stream and shuts itself down.
        try? parentPipe?.fileHandleForWriting.close()
        parentPipe = nil

        if let task, task.isRunning {
            task.terminate()
            // SQLite needs a moment to finish and unlock; killing straight
            // away risks leaving a hot journal behind.
            let deadline = Date().addingTimeInterval(5)
            while task.isRunning, Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
            if task.isRunning { kill(task.processIdentifier, SIGKILL) }
        }

        outputPipe?.fileHandleForReading.readabilityHandler = nil
        outputPipe = nil
        // Restarting is routine now, and a file handle per restart is a leak
        // that used to be impossible because there was only ever one launch.
        try? logHandle?.close()
        logHandle = nil
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
        logHandle = log

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
