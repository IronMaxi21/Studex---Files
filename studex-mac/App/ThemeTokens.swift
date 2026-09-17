// Generated from web/css/tokens.css by build/tokens-to-swift.mjs. Do not edit.
//
// The window is painted before the stylesheet has been read — behind the title
// bar, behind the page on launch, and in the gap during a resize — so AppKit
// needs its own copy of the two chrome colours. This is that copy, made from
// the stylesheet at build time so it cannot drift away from it.
import AppKit

extension Theme {
    /// `--chrome-bg`, #EDEEF2.
    static let lightChrome = NSColor(srgbRed: 0.9299, green: 0.9336, blue: 0.9487, alpha: 1)

    /// `--chrome-bg`, #121420.
    static let darkChrome = NSColor(srgbRed: 0.0725, green: 0.0791, blue: 0.1252, alpha: 1)
}
