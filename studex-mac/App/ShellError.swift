import Foundation

/// Failures that stop the app before it has a UI to report them in, so each
/// case has to explain itself well enough to be the whole of an alert.
enum ShellError: LocalizedError {
    case nodeMissing
    case serverMissing(URL)
    case webMissing(URL)
    case noFreePort
    case serverExited(code: Int32, log: String)
    case serverNotReady(log: String)
    case secretUnavailable

    var errorDescription: String? {
        switch self {
        case .nodeMissing:
            return "Studex could not find a Node.js runtime."
        case .serverMissing:
            return "Studex is missing its backend."
        case .webMissing:
            return "Studex is missing its interface files."
        case .noFreePort:
            return "Studex could not reserve a local port."
        case .serverExited:
            return "The Studex backend stopped while starting up."
        case .serverNotReady:
            return "The Studex backend did not finish starting."
        case .secretUnavailable:
            return "Studex could not create its session key."
        }
    }

    var recoverySuggestion: String? {
        switch self {
        case .nodeMissing:
            return """
            This build was packaged without a bundled runtime, so it needs Node.js 20 \
            or later installed — from nodejs.org or `brew install node`. If Node is \
            installed somewhere unusual, set NODE_BINARY to its full path.
            """
        case .serverMissing(let url):
            return "Nothing was found at \(url.path). Rebuild the app with build/build-app.sh."
        case .webMissing(let url):
            return "Nothing was found at \(url.path). Rebuild the app with build/build-app.sh."
        case .noFreePort:
            return "No loopback port was available. Restarting your Mac usually clears this."
        case .serverExited(let code, let log):
            return "It exited with status \(code).\n\n\(log)"
        case .serverNotReady(let log):
            return "It was still not answering after 30 seconds.\n\n\(log)"
        case .secretUnavailable:
            return "Check that \(Paths.dataDirectory.path) exists and is writable."
        }
    }
}
