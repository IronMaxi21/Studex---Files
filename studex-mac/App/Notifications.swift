import AppKit
import UserNotifications

/// Notification permission as the interface needs to understand it.
///
/// `notDetermined` is the only state worth prompting from, and the page needs
/// to know the difference between "the user said no" and "this build cannot
/// post notifications at all" — the first is a setting they can change in
/// System Settings, the second is not.
enum NotificationAccess: String {
    case unsupported
    case notDetermined = "not-determined"
    case denied
    case granted
}

/// Delivers the notifications the interface asks for.
///
/// The decision of *what* to notify about lives in the web layer, because that
/// is the side holding the session and therefore the only side that knows how
/// many cards are due or when the next exam is. This class is the delivery
/// mechanism and nothing more: it asks for permission once, posts what it is
/// given, and reports honestly when it cannot.
final class Notifications: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifications()

    /// UNUserNotificationCenter traps rather than returns nil when the process
    /// is not a bundled, signed app — which a debug build run straight out of
    /// swiftc is. Everything here goes through this check first.
    private let isSupported = Bundle.main.bundleIdentifier != nil

    private var center: UNUserNotificationCenter? {
        isSupported ? UNUserNotificationCenter.current() : nil
    }

    /// Called once the interface exists, so a notification tapped while the
    /// app is running brings the window forward rather than doing nothing.
    func prepare() {
        center?.delegate = self
    }

    func access(_ completion: @escaping (NotificationAccess) -> Void) {
        guard let center else { return completion(.unsupported) }
        center.getNotificationSettings { settings in
            let access: NotificationAccess
            switch settings.authorizationStatus {
            case .notDetermined: access = .notDetermined
            case .denied: access = .denied
            default: access = .granted
            }
            DispatchQueue.main.async { completion(access) }
        }
    }

    /// Asks, but only if nobody has been asked yet: macOS answers a second
    /// request with the first answer, so re-prompting a user who declined
    /// would silently do nothing and look like a bug.
    func requestAccess(_ completion: @escaping (NotificationAccess) -> Void) {
        guard let center else { return completion(.unsupported) }
        access { current in
            guard current == .notDetermined else { return completion(current) }
            center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
                DispatchQueue.main.async { completion(granted ? .granted : .denied) }
            }
        }
    }

    /// Posts one notification, replacing any earlier one with the same id.
    ///
    /// Replacing rather than stacking is the point of the id: "8 cards due"
    /// followed an hour later by "12 cards due" should be one line in
    /// Notification Centre saying the current number, not two saying different
    /// things.
    func post(id: String, title: String, body: String) {
        guard let center else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default

        center.removePendingNotificationRequests(withIdentifiers: [id])
        center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
    }

    // MARK: - UNUserNotificationCenterDelegate

    /// Shown even when Studex is frontmost. The interface only asks for a
    /// notification when it has decided one is warranted, and a banner it
    /// silently swallowed would be worse than one the user did not need.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        NSApp.activate(ignoringOtherApps: true)
        NSApp.windows.first?.makeKeyAndOrderFront(nil)
        completionHandler()
    }
}
