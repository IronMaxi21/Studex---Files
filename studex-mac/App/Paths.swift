import Foundation

/// Where the app's parts live, both inside the bundle and on disk.
///
/// Resolving all of this in one place means the two ways the shell can run —
/// from a built `Studex.app`, or straight out of the source tree during
/// development — differ only here.
enum Paths {
    /// Set by the dev launcher so the shell can find `web/` and `server/`
    /// without being packaged first.
    private static let devRoot = ProcessInfo.processInfo.environment["STUDEX_DEV_ROOT"]
        .flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0) }

    private static var resources: URL {
        devRoot ?? Bundle.main.resourceURL ?? Bundle.main.bundleURL
    }

    /// Whether this build is one of ours rather than one someone downloaded.
    ///
    /// True when the shell is running out of the source tree, and true when
    /// the bundle is not stamped `release` — which build-app.sh only stamps
    /// when it is building the thing that leaves this machine. The default
    /// runs that way round deliberately: a bundle with no stamp at all is a
    /// hand-assembled one, and treating it as a developer build keeps the
    /// developer screens reachable without a flag. There is no environment
    /// variable that flips it back on in a release build, because then it
    /// would not be hidden — it would be a suggestion.
    static var isDeveloperBuild: Bool {
        if devRoot != nil { return true }
        let channel = Bundle.main.infoDictionary?["StudexChannel"] as? String
        return channel?.lowercased() != "release"
    }

    /// `dev` or `release`, as the backend and the web UI know it.
    static var channel: String { isDeveloperBuild ? "dev" : "release" }

    static var webDirectory: URL { resources.appendingPathComponent("web", isDirectory: true) }

    static var serverDirectory: URL { resources.appendingPathComponent("server", isDirectory: true) }

    static var serverEntry: URL { serverDirectory.appendingPathComponent("dist/server.js") }

    /// Supabase settings baked in at build time, when the build had any.
    /// Absent means the server authenticates with its own credentials, which
    /// is also the only mode that works with no network.
    static var supabaseConfig: URL { resources.appendingPathComponent("supabase.json") }

    /// The release build's AI key, masked. Absent in a developer build.
    static var builtinAiKey: URL { resources.appendingPathComponent("ai-key.json") }

    /// The bundled Node runtime, when the build included one.
    static var bundledNode: URL { resources.appendingPathComponent("node/bin/node") }

    /// User data: the database, uploaded files and the session secret. Kept
    /// out of the bundle so that replacing the app never touches a library.
    static var dataDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("Studex", isDirectory: true)
    }

    static var logDirectory: URL {
        URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Logs/Studex", isDirectory: true)
    }

    static var serverLog: URL { logDirectory.appendingPathComponent("server.log") }

    /// Creates the user-data directories, readable only by this account: the
    /// database holds every note and the blob store every imported file.
    @discardableResult
    static func prepareDataDirectories() throws -> URL {
        let fm = FileManager.default
        for dir in [dataDirectory, dataDirectory.appendingPathComponent("blobs", isDirectory: true), logDirectory] {
            if !fm.fileExists(atPath: dir.path) {
                try fm.createDirectory(at: dir, withIntermediateDirectories: true,
                                       attributes: [.posixPermissions: 0o700])
            }
        }
        return dataDirectory
    }
}
