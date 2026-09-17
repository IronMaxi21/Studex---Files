import AppKit

/**
 What the window shows instead of the app when nobody is there.

 Two states, one view. Away for a moment, it is a blank field in the app's own
 colour with the padlock on it and nothing to read — the point is that the exam
 calendar is not on screen, not that anybody is being told off. Once the delay
 has passed it grows a sentence and a button, because now something is being
 asked for and a silent grey rectangle would read as a hang.

 The cover is a real view rather than a blurred screenshot: the web view under
 it is hidden outright, so what a passer-by, a screen recording and Mission
 Control's thumbnail all get is this and not a frosted version of the library.
 */
final class LockView: NSView {
    private let badge = NSImageView()
    private let title = NSTextField(labelWithString: "Studex is locked")
    private let unlock = NSButton(title: "Unlock", target: nil, action: nil)
    private let quit = NSButton(title: "Quit Studex", target: nil, action: nil)
    private let stack = NSStackView()

    /// Pressed by somebody who dismissed the panel and wants it back.
    var onUnlock: (() -> Void)?

    /// `background` is the colour the page is already painted behind, so the
    /// cover appearing is a change of contents and not a change of colour.
    init(background: NSColor, light: Bool) {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = background.cgColor

        badge.image = NSImage(systemSymbolName: "lock.fill", accessibilityDescription: "Locked")
        badge.symbolConfiguration = .init(pointSize: 30, weight: .regular)
        badge.contentTintColor = NSColor(white: light ? 0.42 : 0.66, alpha: 1)

        title.font = .systemFont(ofSize: 13, weight: .medium)
        title.textColor = NSColor(white: light ? 0.28 : 0.80, alpha: 1)
        title.alignment = .center

        unlock.bezelStyle = .rounded
        unlock.keyEquivalent = "\r"
        unlock.target = self
        unlock.action = #selector(unlockPressed)

        // The way out of a Mac that has lost its ability to authenticate — a
        // Watch that has gone flat, a fingerprint that will not read and a
        // panel that keeps being dismissed. Quitting is always available, and
        // the library is untouched on the other side of it.
        quit.bezelStyle = .inline
        quit.isBordered = false
        quit.contentTintColor = NSColor(white: light ? 0.45 : 0.55, alpha: 1)
        quit.target = NSApp
        quit.action = #selector(NSApplication.terminate(_:))

        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 14
        stack.setViews([badge, title, unlock, quit], in: .center)
        stack.setCustomSpacing(20, after: title)
        stack.setCustomSpacing(10, after: unlock)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)

        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    /// Whether anything is being asked for. Everything but the padlock is
    /// hidden while it is not.
    func show(prompt: Bool) {
        title.isHidden = !prompt
        unlock.isHidden = !prompt
        quit.isHidden = !prompt
    }

    @objc private func unlockPressed() { onUnlock?() }

    /// The window has no title bar of its own, so a locked window that could
    /// not be dragged would be a window nailed to the screen.
    override var mouseDownCanMoveWindow: Bool { true }

    /// Takes the keyboard as well as the mouse. Without this the hidden web
    /// view underneath would still be the first responder, and every keystroke
    /// aimed at the cover would be typed into the page behind it.
    override var acceptsFirstResponder: Bool { true }

    /// Opaque to the mouse everywhere, not only where something is drawn.
    override func hitTest(_ point: NSPoint) -> NSView? {
        let hit = super.hitTest(point)
        return hit ?? (frame.contains(point) ? self : nil)
    }
}
