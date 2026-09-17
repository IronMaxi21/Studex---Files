import AppKit
import LocalAuthentication

/// What the window is showing: the app, a blank cover, or the cover with an
/// unlock prompt on it.
enum LockState {
    /// Nothing in the way.
    case open
    /// Hidden because nobody is here, but no authentication owed yet. Walking
    /// away for a moment and coming straight back costs nothing.
    case covered
    /// Hidden, and Touch ID or the login password is required to get back in.
    case locked
}

/**
 Locking Studex when you walk away from it.

 A student's Studex holds everything they are being examined on, their timetable
 and — once billing is live — a payment relationship, and it runs on a laptop
 that spends its day open on a library desk. macOS locks the whole machine after
 a while, but the interesting gap is the smaller one: the ten minutes at the
 coffee counter, with the lid up and the screen showing the exam calendar.

 Two things happen when the app stops being looked at. The window is covered
 straight away — that is free, needs no permission, and is the part that matters
 to somebody walking past. Whether coming back also costs a Touch ID is the
 delay, which is the setting; below it, the cover simply lifts.

 The preference lives in UserDefaults rather than with the account's settings
 because it has to be readable before there is a session to read settings from,
 and because it is a property of this Mac: the same account on a desktop at home
 and a laptop on a train does not want the same answer.

 Nothing here is a substitute for FileVault. The database on disk is exactly as
 readable as it was; this stops a person at the keyboard, not a person with the
 disk, and the copy in Settings says so.
 */
final class AppLock {
    static let shared = AppLock()

    private static let minutesKey = "LockAfterMinutes"
    private static let shareKey = "LockBeforeSharing"

    /// The offered delays, in minutes; 0 is off. Kept short at the bottom
    /// because a one-minute lock is the one people who want this actually want,
    /// and stopping at an hour because past that the Mac's own lock has it.
    static let delayChoices = [0, 1, 5, 15, 60]

    private(set) var state: LockState = .open

    /// Told whenever the cover goes up or comes down, so the window can follow.
    var onChange: ((LockState) -> Void)?

    /// When the app was last left. Nil while it is being used.
    private var awaySince: Date?

    /// True while macOS is showing its own authentication panel. Studex resigns
    /// active underneath it, and without this that would read as walking away
    /// and start the whole sequence again on top of itself.
    private var authenticating = false

    private init() {}

    // MARK: - The preference

    /// Minutes away before authentication is required; 0 is off.
    var delayMinutes: Int {
        get { UserDefaults.standard.integer(forKey: Self.minutesKey) }
        set {
            UserDefaults.standard.set(newValue, forKey: Self.minutesKey)
            // Turning it off while a cover is up has to take the cover with it,
            // or the switch would appear not to have worked.
            if newValue == 0, state == .covered { set(.open) }
        }
    }

    /// Whether making a share link asks first.
    ///
    /// This is the other half of what the lock is for, and the only per-share
    /// use of local authentication that is honest. A share link cannot be made
    /// to ask its *holder* for a fingerprint — it opens in a browser on somebody
    /// else's machine, where nothing this app writes runs — and the server keeps
    /// only a hash of it, so it cannot be re-shown here behind a prompt either.
    /// What can be guarded is the moment the link is made: the one action in
    /// Studex that takes private coursework and makes it reachable by anyone
    /// holding a URL, and the one thing somebody at an unlocked Mac could do in
    /// ten seconds.
    var requiresAuthToShare: Bool {
        get { UserDefaults.standard.bool(forKey: Self.shareKey) }
        set { UserDefaults.standard.set(newValue, forKey: Self.shareKey) }
    }

    // MARK: - What the Mac can do

    /// Whether this Mac can authenticate its owner at all — a fingerprint, a
    /// paired Watch, or the login password.
    ///
    /// If it cannot, none of this may be switched on: an app that locks itself
    /// with no way back in is not a security feature, it is a lost library.
    var canAuthenticate: Bool {
        LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
    }

    /// What to call it on screen, so the setting says "Touch ID" on a Mac that
    /// has one and does not promise it on a Mac that does not.
    var biometry: String {
        let context = LAContext()
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil) else {
            return "password"
        }
        switch context.biometryType {
        case .touchID: return "touch-id"
        case .opticID: return "optic-id"
        default: return "password"
        }
    }

    // MARK: - Watching

    /// Starts listening. Called once, at launch.
    func start() {
        let center = NotificationCenter.default
        center.addObserver(
            self, selector: #selector(left), name: NSApplication.didResignActiveNotification, object: nil
        )
        center.addObserver(
            self, selector: #selector(returned), name: NSApplication.didBecomeActiveNotification, object: nil
        )

        // A Mac left with Studex in front and the lid closed never resigns
        // active, so the app would sit there unlocked with the screen off. The
        // workspace notifications are the only account of that.
        let workspace = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.willSleepNotification, NSWorkspace.screensDidSleepNotification] {
            workspace.addObserver(self, selector: #selector(left), name: name, object: nil)
        }
        workspace.addObserver(
            self, selector: #selector(returned), name: NSWorkspace.screensDidWakeNotification, object: nil
        )
    }

    @objc private func left() {
        guard !authenticating, delayMinutes > 0, canAuthenticate else { return }
        // Kept from the first time it happened: the screen going to sleep and
        // then the app resigning active is one absence, not two, and the second
        // must not restart the clock.
        if awaySince == nil { awaySince = Date() }
        if state == .open { set(.covered) }
    }

    @objc private func returned() {
        guard !authenticating else { return }

        if state == .locked {
            // Back at a locked app: ask, rather than making them find the
            // button that would ask.
            promptUnlock()
            return
        }

        let away = awaySince.map { Date().timeIntervalSince($0) } ?? 0
        awaySince = nil

        guard state == .covered else { return }
        if delayMinutes > 0, canAuthenticate, away >= Double(delayMinutes) * 60 {
            set(.locked)
            promptUnlock()
        } else {
            set(.open)
        }
    }

    // MARK: - Locking

    /// Locks now, without asking anything.
    ///
    /// No prompt: this is pressed by somebody standing up to leave, and a Touch
    /// ID panel appearing at that moment would be asking them to prove they are
    /// still there. The prompt comes when they get back.
    func lockNow() {
        guard canAuthenticate else { return }
        awaySince = nil
        set(.locked)
    }

    /// Asks macOS to identify the owner, and lifts the lock if it does.
    func promptUnlock() {
        guard state == .locked else { return }
        authenticate(reason: "unlock Studex") { [weak self] ok in
            guard ok, let self else { return }
            self.awaySince = nil
            self.set(.open)
        }
    }

    /**
     One authentication, for whatever asked for it.

     A fresh `LAContext` every time on purpose: a context remembers that it has
     already succeeded, and reusing one would mean the second thing to ask was
     waved through on the strength of the first.

     `deviceOwnerAuthentication` rather than the biometrics-only policy, so a Mac
     with no Touch ID, or a finger that will not read, falls through to the login
     password instead of to a dead end.
     */
    func authenticate(reason: String, completion: @escaping (Bool) -> Void) {
        let context = LAContext()
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) else {
            completion(false)
            return
        }
        authenticating = true
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { [weak self] ok, _ in
            DispatchQueue.main.async {
                self?.authenticating = false
                completion(ok)
            }
        }
    }

    private func set(_ next: LockState) {
        guard next != state else { return }
        state = next
        onChange?(next)
    }
}
