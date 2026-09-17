import AppKit

extension NSWindow {
    /// Starts a window drag from whatever mouse event is currently in flight.
    ///
    /// The web view reports a mouse-down on the title bar strip and AppKit
    /// takes over from there, because WebKit has no equivalent of Chromium's
    /// `-webkit-app-region: drag`. `performDrag(with:)` is the right tool when
    /// the originating event is still current; when it is not — the message
    /// arrives over IPC, and the event queue may have moved on — the drag is
    /// tracked by hand instead, which is slightly more work for exactly the
    /// same result.
    func beginDragFromCurrentEvent() {
        if let event = NSApp.currentEvent,
           event.type == .leftMouseDown || event.type == .leftMouseDragged {
            performDrag(with: event)
            return
        }
        trackDragManually()
    }

    private func trackDragManually() {
        let startMouse = NSEvent.mouseLocation
        let startOrigin = frame.origin

        trackEvents(
            matching: [.leftMouseDragged, .leftMouseUp],
            timeout: NSEvent.foreverDuration,
            mode: .eventTracking
        ) { event, stop in
            guard let event, event.type != .leftMouseUp else {
                stop.pointee = true
                return
            }
            let now = NSEvent.mouseLocation
            self.setFrameOrigin(NSPoint(
                x: startOrigin.x + (now.x - startMouse.x),
                y: startOrigin.y + (now.y - startMouse.y)
            ))
        }
    }

    /// Applies whatever the user has chosen double-clicking a title bar should
    /// do. It is a system preference, so it is read rather than assumed.
    func performTitlebarDoubleClickAction() {
        let action = UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? "Maximize"
        switch action {
        case "Minimize":
            performMiniaturize(nil)
        case "None":
            break
        default:
            performZoom(nil)
        }
    }
}
