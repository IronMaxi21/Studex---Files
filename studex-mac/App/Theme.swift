import AppKit

/// The few colours the shell has to know about, because AppKit draws them
/// rather than the stylesheet.
///
/// The window has a background before any CSS has been parsed — behind the
/// title bar, behind the page on launch, and in the gap while a resize catches
/// up — so a mismatch shows as a flash and a seam. The values themselves are
/// no longer written here: ThemeTokens.swift is generated from tokens.css by
/// build/tokens-to-swift.mjs, because the pair written out by hand had already
/// drifted a shade away from the stylesheet they were copied from.
enum Theme {
    static func chromeColor(for theme: String) -> NSColor {
        theme == "light" ? lightChrome : darkChrome
    }

    static func appearance(for theme: String) -> NSAppearance? {
        NSAppearance(named: theme == "light" ? .aqua : .darkAqua)
    }
}
