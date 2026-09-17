import AppKit
import CryptoKit

/// Replacing Studex with a newer copy of itself.
///
/// The server decides *whether* there is an update; this decides whether the
/// thing that arrives is one. Four questions stand between a download and the
/// disk, and every one of them is a way an updater can be turned into a
/// delivery mechanism for something else:
///
///  1. did it come over a transport nobody could rewrite,
///  2. are the bytes the ones the feed said they would be,
///  3. is it Studex, and
///  4. is its signature intact.
///
/// And, when the build carries a release public key, a fifth that comes before
/// all but the first: was the zip signed by whoever holds the matching private
/// key. The checksum only proves the bytes match the row; this proves who
/// wrote the row — Sparkle's EdDSA check, with the same key format.
///
/// Only then is the bundle swapped, in one atomic move with the old copy kept
/// until the new one is in place — because the failure that matters here is
/// not "the update did not install", it is "the app is now gone".
enum UpdateError: LocalizedError {
    case insecureURL
    case downloadFailed(String)
    case hashMismatch(expected: String, actual: String)
    case unpackFailed(String)
    case notAnApp
    case wrongApp(String)
    case notNewer(String, String)
    case signatureFailed(String)
    case unsignedRelease
    case releaseSignatureInvalid
    case installFailed(String)

    var errorDescription: String? {
        switch self {
        case .insecureURL:
            return "An update may only be downloaded over https."
        case let .downloadFailed(why):
            return "The download did not finish: \(why)"
        case let .hashMismatch(expected, actual):
            return "The download does not match what the update feed described "
                + "(expected \(expected.prefix(12))…, got \(actual.prefix(12))…). It was not installed."
        case let .unpackFailed(why):
            return "The download could not be unpacked: \(why)"
        case .notAnApp:
            return "The download does not contain an application."
        case let .wrongApp(id):
            return "The download is not Studex (it identifies itself as \(id))."
        case let .notNewer(offered, running):
            return "The download is version \(offered), which is not newer than the \(running) already installed."
        case let .signatureFailed(why):
            return "The download's signature did not verify: \(why)"
        case .unsignedRelease:
            return "The update is not signed, and this copy of Studex only installs signed updates."
        case .releaseSignatureInvalid:
            return "The update's release signature does not match this copy of Studex. It was not installed."
        case let .installFailed(why):
            return "The update could not be put in place: \(why)"
        }
    }
}

/// What the page is told while this runs.
struct UpdateProgress {
    enum Stage: String {
        case downloading, verifying, unpacking, ready, installing, relaunching, failed
    }
    var stage: Stage
    /// 0…1 while downloading; nil when the step has no measurable length.
    var fraction: Double?
    var message: String?
    /// Set on `ready`: the version waiting to be put in place.
    var version: String?
}

/// A newer Studex, downloaded and checked, sitting beside the running one and
/// waiting for a moment when replacing the app will not interrupt anybody.
struct PreparedUpdate {
    let version: String
    let app: URL
    let staging: URL
}

final class Updater: NSObject {
    /// The bundle to replace. Its own, except under test.
    private let bundleURL: URL
    private let expectedBundleID: String
    private let runningVersion: String
    /// The Ed25519 key updates must be signed with, base64 — nil in a build
    /// that was made without one, which then relies on the checksum alone.
    private let releaseKey: String?
    private let onProgress: (UpdateProgress) -> Void

    private var session: URLSession!
    private var task: URLSessionDownloadTask?
    private var pending: ((Result<URL, Error>) -> Void)?

    /// The last step reported. Download progress is delivered on a background
    /// queue and hops to the main one, so the final tick of it can arrive
    /// after the checking has already started — which showed the user the
    /// progress running backwards.
    private var stage: UpdateProgress.Stage = .downloading

    init(
        bundleURL: URL = Bundle.main.bundleURL,
        bundleID: String = Bundle.main.bundleIdentifier ?? "com.studex.desktop",
        runningVersion: String = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0",
        releaseKey: String? = Bundle.main.infoDictionary?["StudexUpdatePublicKey"] as? String,
        onProgress: @escaping (UpdateProgress) -> Void
    ) {
        self.bundleURL = bundleURL
        self.expectedBundleID = bundleID
        self.runningVersion = runningVersion
        self.releaseKey = releaseKey.flatMap { $0.isEmpty ? nil : $0 }
        self.onProgress = onProgress
        super.init()
        session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
    }

    /// Progress the page can trust: always on the main queue, and only ever
    /// moving forwards.
    ///
    /// The main queue is not politeness. Download progress arrives on
    /// URLSession's own queue and the steps after it run on whichever queue
    /// the completion landed on, so `stage` was being read and written from
    /// two threads at once — a data race, which in Swift is undefined
    /// behaviour rather than merely a wrong number. Funnelling every report
    /// through one queue makes the ordering rule below true as well as
    /// intended.
    private func report(_ progress: UpdateProgress) {
        let deliver = {
            if progress.stage == .downloading && self.stage != .downloading { return }
            self.stage = progress.stage
            self.onProgress(progress)
        }
        if Thread.isMainThread { deliver() } else { DispatchQueue.main.async(execute: deliver) }
    }

    /// Downloads and checks a newer version without touching the running one.
    ///
    /// This is the half of an update that takes time, so it is the half done
    /// in the background: by the time anybody is asked to restart, the only
    /// thing left is a move on disk. Calls back on the main queue.
    func prepare(from raw: String, sha256: String, signature: String? = nil, version: String,
                 completion: @escaping (Result<PreparedUpdate, Error>) -> Void) {
        let finish = { (result: Result<PreparedUpdate, Error>) in
            switch result {
            case let .failure(error):
                self.report(UpdateProgress(stage: .failed, fraction: nil, message: error.localizedDescription))
            case let .success(prepared):
                self.report(UpdateProgress(stage: .ready, fraction: nil, message: nil, version: prepared.version))
            }
            DispatchQueue.main.async { completion(result) }
        }

        guard let url = URL(string: raw), Self.isSecure(url) else {
            finish(.failure(UpdateError.insecureURL))
            return
        }
        guard Self.isNewer(version, than: runningVersion) else {
            finish(.failure(UpdateError.notNewer(version, runningVersion)))
            return
        }

        report(UpdateProgress(stage: .downloading, fraction: 0, message: nil))
        download(url) { result in
            switch result {
            case let .failure(error):
                finish(.failure(error))
            case let .success(downloaded):
                do {
                    finish(.success(try self.stage(downloaded, sha256: sha256, signature: signature)))
                } catch {
                    try? FileManager.default.removeItem(at: downloaded)
                    finish(.failure(error))
                }
            }
        }
    }

    /// Replaces the running app with one `prepare` left ready.
    ///
    /// The signature is checked a second time: the staged copy has been
    /// sitting in a directory for as long as the user took to say yes.
    func apply(_ prepared: PreparedUpdate) throws {
        defer { try? FileManager.default.removeItem(at: prepared.staging) }
        guard FileManager.default.fileExists(atPath: prepared.app.path) else {
            throw UpdateError.installFailed("the downloaded copy is no longer there")
        }
        try Self.verifySignature(of: prepared.app)

        report(UpdateProgress(stage: .installing, fraction: nil, message: nil))
        do {
            // The old copy survives under a backup name until the new one is
            // in place; the system removes it only once the swap succeeded.
            _ = try FileManager.default.replaceItemAt(
                bundleURL, withItemAt: prepared.app,
                backupItemName: "Studex (previous).app",
                options: [.usingNewMetadataOnly])
        } catch {
            throw UpdateError.installFailed(error.localizedDescription)
        }
    }

    /// Everything between "the bytes are here" and "ready to swap in".
    private func stage(_ zip: URL, sha256 expected: String, signature: String?) throws -> PreparedUpdate {
        defer { try? FileManager.default.removeItem(at: zip) }

        report(UpdateProgress(stage: .verifying, fraction: nil, message: nil))
        let actual = try Self.digest(of: zip)
        guard actual == expected.lowercased() else {
            throw UpdateError.hashMismatch(expected: expected, actual: actual)
        }
        if let releaseKey {
            guard let signature, !signature.isEmpty else { throw UpdateError.unsignedRelease }
            guard try Self.isSigned(zip, signature: signature, publicKey: releaseKey) else {
                throw UpdateError.releaseSignatureInvalid
            }
        }

        // Staged beside the app being replaced. The replace at the end is only
        // atomic within one volume, and this is the directory the system hands
        // out for exactly that purpose.
        // Kept until the update is applied or abandoned, so it is only
        // removed here when staging fails.
        let staging = try FileManager.default.url(
            for: .itemReplacementDirectory, in: .userDomainMask,
            appropriateFor: bundleURL, create: true)
        do {
            report(UpdateProgress(stage: .unpacking, fraction: nil, message: nil))
            try Self.unzip(zip, into: staging)

            guard let app = try Self.findApp(in: staging) else { throw UpdateError.notAnApp }
            let info = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist"))
            let identifier = info?["CFBundleIdentifier"] as? String ?? ""
            guard identifier == expectedBundleID else { throw UpdateError.wrongApp(identifier.isEmpty ? "nothing" : identifier) }

            let offered = info?["CFBundleShortVersionString"] as? String ?? "0"
            guard Self.isNewer(offered, than: runningVersion) else {
                throw UpdateError.notNewer(offered, runningVersion)
            }
            try Self.verifySignature(of: app)
            return PreparedUpdate(version: offered, app: app, staging: staging)
        } catch {
            try? FileManager.default.removeItem(at: staging)
            throw error
        }
    }

    /// Quits and comes back as the version just installed.
    func relaunch() {
        report(UpdateProgress(stage: .relaunching, fraction: nil, message: nil))
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/sh")
        // Detached deliberately: this process is about to end, and the thing
        // that reopens the app has to outlive it.
        task.arguments = ["-c", "sleep 1; /usr/bin/open -n \"$0\"", bundleURL.path]
        try? task.run()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { NSApp.terminate(nil) }
    }

    // MARK: - Steps

    private func download(_ url: URL, completion: @escaping (Result<URL, Error>) -> Void) {
        pending = completion
        var request = URLRequest(url: url)
        request.timeoutInterval = 60
        task = session.downloadTask(with: request)
        task?.resume()
    }

    static func isSecure(_ url: URL) -> Bool {
        if url.scheme == "https" { return true }
        // Loopback http has no transport to secure and no one in the middle;
        // it is how this is tested without standing up a certificate.
        let host = url.host ?? ""
        return url.scheme == "http" && (host == "localhost" || host == "127.0.0.1" || host == "::1")
    }

    /// Streamed rather than read whole: the download is a signed application,
    /// not a document, and holding it in memory to hash it would be silly.
    /// Whether `signature` (Ed25519, base64) is `publicKey`'s over the zip.
    static func isSigned(_ file: URL, signature: String, publicKey: String) throws -> Bool {
        guard let keyData = Data(base64Encoded: publicKey),
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: keyData),
              let signatureData = Data(base64Encoded: signature)
        else { return false }
        let bytes = try Data(contentsOf: file, options: .mappedIfSafe)
        return key.isValidSignature(signatureData, for: bytes)
    }

    static func digest(of file: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    /// `ditto` rather than a zip library: it is what made the archive on the
    /// other end, and it is the only unarchiver that keeps a bundle's symlinks
    /// and extended attributes intact — a signature does not survive without.
    static func unzip(_ zip: URL, into directory: URL) throws {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        task.arguments = ["-x", "-k", zip.path, directory.path]
        let errors = Pipe()
        task.standardError = errors
        try task.run()
        let output = errors.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()
        guard task.terminationStatus == 0 else {
            throw UpdateError.unpackFailed(String(data: output, encoding: .utf8)?.trimmed ?? "ditto failed")
        }
    }

    static func findApp(in directory: URL) throws -> URL? {
        let entries = try FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles])
        return entries.first { $0.pathExtension == "app" }
    }

    static func verifySignature(of app: URL) throws {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
        task.arguments = ["--verify", "--deep", "--strict", app.path]
        let errors = Pipe()
        task.standardError = errors
        try task.run()
        let output = errors.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()
        guard task.terminationStatus == 0 else {
            throw UpdateError.signatureFailed(String(data: output, encoding: .utf8)?.trimmed ?? "codesign refused it")
        }
    }

    /// Same rule as the server's, so the two cannot disagree about which way
    /// round two versions go.
    static func isNewer(_ candidate: String, than current: String) -> Bool {
        func parts(_ v: String) -> ([Int], String) {
            let halves = v.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
            let core = halves.first.map(String.init) ?? ""
            let pre = halves.count > 1 ? String(halves[1]) : ""
            return (core.split(separator: ".").map { Int($0) ?? 0 }, pre)
        }
        let (a, apre) = parts(candidate)
        let (b, bpre) = parts(current)
        for i in 0..<max(a.count, b.count) {
            let l = i < a.count ? a[i] : 0
            let r = i < b.count ? b[i] : 0
            if l != r { return l > r }
        }
        if apre == bpre { return false }
        if apre.isEmpty { return true }
        if bpre.isEmpty { return false }
        return apre > bpre
    }
}

extension Updater: URLSessionDownloadDelegate {
    func urlSession(
        _ session: URLSession, downloadTask: URLSessionDownloadTask,
        didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64
    ) {
        guard totalBytesExpectedToWrite > 0 else { return }
        let fraction = Double(totalBytesWritten) / Double(totalBytesExpectedToWrite)
        report(UpdateProgress(stage: .downloading, fraction: fraction, message: nil))
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        // The system deletes this the moment the delegate returns, so it is
        // moved somewhere of our own before anything else happens.
        let kept = FileManager.default.temporaryDirectory
            .appendingPathComponent("studex-update-\(UUID().uuidString).zip")
        let done = pending
        pending = nil
        do {
            try FileManager.default.moveItem(at: location, to: kept)
        } catch {
            done?(.failure(UpdateError.downloadFailed(error.localizedDescription)))
            return
        }
        if let response = downloadTask.response as? HTTPURLResponse, response.statusCode != 200 {
            try? FileManager.default.removeItem(at: kept)
            done?(.failure(UpdateError.downloadFailed("the server answered \(response.statusCode)")))
            return
        }
        done?(.success(kept))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error else { return }
        let done = pending
        pending = nil
        done?(.failure(UpdateError.downloadFailed(error.localizedDescription)))
    }
}

/// The one update in progress, shared by every window.
///
/// Each window runs its own copy of the page and each copy checks for updates,
/// so the download has to live above them: two windows finding the same
/// version must not fetch it twice, and a restart asked for in one has to
/// install what the other downloaded.
final class UpdateCenter {
    static let shared = UpdateCenter()
    static let progressNotification = Notification.Name("StudexUpdateProgress")

    private var updater: Updater?
    private(set) var prepared: PreparedUpdate?
    private var preparing: String?

    /// Downloads and stages `version` unless it already is, or already has been.
    func prepare(url: String, sha256: String, signature: String? = nil, version: String) {
        if let prepared {
            if prepared.version == version || !Updater.isNewer(version, than: prepared.version) {
                broadcast(UpdateProgress(stage: .ready, version: prepared.version))
                return
            }
        }
        guard preparing == nil else { return }
        preparing = version
        let updater = Updater(onProgress: { [weak self] in self?.broadcast($0) })
        self.updater = updater
        updater.prepare(from: url, sha256: sha256, signature: signature, version: version) { [weak self] result in
            guard let self else { return }
            self.preparing = nil
            if case let .success(next) = result {
                if let old = self.prepared { try? FileManager.default.removeItem(at: old.staging) }
                self.prepared = next
            } else {
                self.updater = nil
            }
        }
    }

    /// Tells the page what is already waiting, when a window loads after the
    /// download finished.
    func announce() {
        if let prepared { broadcast(UpdateProgress(stage: .ready, version: prepared.version)) }
    }

    /// Puts the staged version in place and reopens on it.
    func restart() {
        guard let prepared, let updater else { return }
        do {
            try updater.apply(prepared)
            self.prepared = nil
            updater.relaunch()
        } catch {
            self.prepared = nil
            self.updater = nil
            broadcast(UpdateProgress(stage: .failed, message: error.localizedDescription))
        }
    }

    /// Called as the app quits: an update somebody chose to leave for later
    /// is installed now, so the next launch is already the new version —
    /// the way a Mac app that updates itself is expected to behave.
    func installOnQuit() {
        guard let prepared, let updater else { return }
        self.prepared = nil
        try? updater.apply(prepared)
    }

    private func broadcast(_ progress: UpdateProgress) {
        NotificationCenter.default.post(name: Self.progressNotification, object: progress)
    }
}

private extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
