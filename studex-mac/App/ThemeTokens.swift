// Generated from web/css/tokens.css by build/tokens-to-swift.mjs. Do not edit.
//
// The window is painted before the stylesheet has been read — behind the title
// bar, behind the page on launch, and in the gap during a resize — so AppKit
// needs its own copy of the two chrome colours. This is that copy, made from
// the stylesheet at build time so it cannot drift away from it.
import AppKit

extension Theme {
    /// `--chrome-bg`, #EEEDE8.
    static let lightChrome = NSColor(srgbRed: 0.9336, green: 0.9299, blue: 0.9111, alpha: 1)

    /// `--chrome-bg`, #161715.
    static let darkChrome = NSColor(srgbRed: 0.0856, green: 0.0889, blue: 0.0824, alpha: 1)
}
