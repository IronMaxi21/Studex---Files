import AppKit

/// What the window shows while the backend is coming up.
///
/// The first launch has to migrate a database and the interface cannot be
/// loaded until that is done, so this stands in for it — in the app's own
/// colours, so the wait reads as part of starting rather than as a stall.
final class LaunchView: NSView {
    private let spinner = NSProgressIndicator()
    private let label: NSTextField

    /// `theme` is the one the app last resolved, so the wait is in the colours
    /// the interface is about to appear in rather than in a constant.
    ///
    /// `message` is what the wait is for. A first launch is starting; a window
    /// that was showing a page a second ago is coming back, and saying so is
    /// the difference between a hiccup and an app that appears to have
    /// restarted itself under the person's hands.
    init(theme: String, message: String = "Starting Studex…") {
        label = NSTextField(labelWithString: message)
        super.init(frame: .zero)
        wantsLayer = true
        appearance = Theme.appearance(for: theme)
        layer?.backgroundColor = Theme.chromeColor(for: theme).cgColor

        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.startAnimation(nil)
        spinner.translatesAutoresizingMaskIntoConstraints = false

        label.font = .systemFont(ofSize: 12, weight: .medium)
        label.textColor = NSColor(white: theme == "light" ? 0.38 : 0.62, alpha: 1)
        label.translatesAutoresizingMaskIntoConstraints = false

        addSubview(spinner)
        addSubview(label)

        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: centerYAnchor, constant: -14),
            label.centerXAnchor.constraint(equalTo: centerXAnchor),
            label.topAnchor.constraint(equalTo: spinner.bottomAnchor, constant: 14),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    /// The window has no title bar of its own, so this view has to be
    /// draggable or a failed launch would leave a window that cannot be moved.
    override var mouseDownCanMoveWindow: Bool { true }
}
