# Studex — Mac app

A real macOS application: double-click `Studex.app` and it opens a native
window, puts its own menus in the menu bar, and runs the whole of Studex
locally. No terminal, no server to start, no browser tab.

Swift/AppKit shell · WKWebView · the [back end](../studex-server) running as a
supervised child process

## Building it

```bash
./build/build-app.sh
```

That produces `dist/Studex.app`, self-contained at about 143 MB. Open it from
Finder, or:

```bash
open dist/Studex.app
```

The first launch has no accounts, so the sign-in screen offers to create one
instead. That account and everything in it stay on this machine.

Options: `--no-node` leaves the Node runtime out (~116 MB smaller, but the app
then needs Node 20+ installed); `--out <dir>` builds somewhere else.

Prerequisites are the Xcode Command Line Tools — `swiftc`, `iconutil` and
`codesign`, no Xcode project involved — plus Node and a completed
`npm install` in `studex-server`.

## How it is put together

```
Studex.app/Contents/
├─ MacOS/Studex          the Swift shell
└─ Resources/
   ├─ web/               the interface — HTML, CSS, ES modules
   ├─ server/            the compiled back end and its production deps
   ├─ node/bin/node      the runtime, thinned to this architecture
   └─ Studex.icns
```

On launch the shell reserves a free loopback port, starts the back end on it
with `WEB_DIR` pointing at `Resources/web`, waits for `/health` to answer, and
then points a `WKWebView` at it. Because one process serves both the interface
and the API, everything is same-origin: the session cookie works, and there is
no CORS to configure.

Your library lives in `~/Library/Application Support/Studex` — the SQLite
database, the imported files, and the key that signs sessions, all `0700`. The
back end writes to `~/Library/Logs/Studex/server.log`; both are reachable from
the Help menu.

### What the shell does that a web page cannot

- **Window dragging.** WebKit has no equivalent of Chromium's
  `-webkit-app-region: drag`, so the title-bar strip reports a mouse-down over
  the bridge and AppKit takes the drag from there. Double-clicking it does
  whatever the system preference says a title bar should do.
- **Menu commands.** A menu key equivalent is swallowed by AppKit before the
  page sees a keydown, so every shortcut the interface defines for itself is
  re-declared in the menu bar and forwarded back by name.
- **Downloads.** Exporting a PDF's notes goes through `WKDownloadDelegate` to a
  real save panel, and reveals the file in Finder when it finishes.
- **Theme.** The traffic lights are drawn by AppKit, outside the reach of the
  stylesheet, so the page tells the shell when its theme changes and the window
  appearance follows.

`js/native.js` is the whole of the web side of that bridge, and every part of
it is a no-op in a plain browser — which is what makes the development loop
below work.

### Menus

| | |
|---|---|
| ⌘1 / ⌘2 / ⌘3 | New canvas · document · flashcard deck |
| ⌘N | New folder |
| ⌘E · ⌘O | Add exam or assignment · Import PDF |
| ⌘I | Import from RemNote |
| ⌘K | Quick open |
| ⌥⌘1–6 | Home · Library · Calendar · Daily review · Timetable · Statistics |
| ⌘, | Settings |
| ⌘R | Reload · ⌘0 / ⌘+ / ⌘− zoom |

Undo, cut, copy, paste and select-all go down the responder chain to the web
view, which handles them natively.

## Working on the interface

Rebuilding the whole app to change a stylesheet is not the loop you want. Run
the back end from source with `WEB_DIR` pointed at this folder and iterate in a
browser:

```bash
cd studex-server && WEB_DIR=../studex-mac/web npm run dev
```

In development the server re-reads assets from disk on every request and sends
`cache-control: no-store`, so a reload is enough. `./build/check-js.sh` parses
every module without running it; `build-app.sh` runs it and refuses to package
a syntax error.

One caveat: a browser is not the engine the app uses. Chromium will not render
a PDF inside an iframe at all, so the reader screen looks broken there and is
fine in the app. Check anything engine-specific in the real thing.

## Shutting down cleanly

Quitting closes the pipe to the back end, sends `SIGTERM`, and waits for SQLite
to finish before giving up and killing it. A crash or a force quit never gets
that far — so the back end also watches its own stdin, and treats end-of-stream
as a shutdown. Killing the app with `SIGKILL` leaves nothing behind.

If the back end stops on its own, the app says so and offers to restart it,
quit, or open the log.

## Signing

`build-app.sh` signs ad-hoc, which is enough to run on the machine that built
it. Giving the app to anyone else needs a Developer ID signature and
notarisation; nothing in the bundle layout prevents that, but this script does
not do it.

## Demo content

A fresh install is empty. To see the app with the data from the design instead,
point the seed script at the app's database before first launch:

```bash
cd studex-server && DATABASE_PATH=~/Library/Application\ Support/Studex/studex.sqlite npm run migrate && DATABASE_PATH=~/Library/Application\ Support/Studex/studex.sqlite npm run seed
```

That creates the demo account with a published password, so use it to look
around rather than to keep anything.
