import Foundation

/// The signing secret the backend uses for session cookies.
///
/// It has to survive relaunches — regenerating it would sign every user out on
/// every start — so it is written once and read back afterwards.
///
/// This is a file rather than a Keychain item, deliberately. The Keychain would
/// only be meaningfully stronger for a properly signed and notarised app: with
/// an ad-hoc signature the item's owner changes on every rebuild, which turns
/// each update into an authorisation prompt, and the fallback path would end up
/// being the one that actually runs. The secret sits in the same directory as
/// the SQLite database it protects sessions for, with the same `0600` mode, so
/// anything that can read it can already read the data itself.
enum SessionSecret {
    private static var url: URL { Paths.dataDirectory.appendingPathComponent("session.key") }

    static func loadOrCreate() throws -> String {
        let fm = FileManager.default

        if let data = fm.contents(atPath: url.path),
           let existing = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
           existing.count >= 64 {
            try tightenPermissions()
            return existing
        }

        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw ShellError.secretUnavailable
        }
        let secret = bytes.map { String(format: "%02x", $0) }.joined()

        // Created with the restrictive mode from the outset: writing first and
        // chmod-ing after would leave a window where it was world-readable.
        guard fm.createFile(
            atPath: url.path,
            contents: Data(secret.utf8),
            attributes: [.posixPermissions: 0o600]
        ) else {
            throw ShellError.secretUnavailable
        }
        return secret
    }

    /// A secret written by an earlier version, or restored from a backup, may
    /// have looser permissions than it should.
    private static func tightenPermissions() throws {
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        if (attrs[.posixPermissions] as? NSNumber)?.intValue != 0o600 {
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        }
    }
}
