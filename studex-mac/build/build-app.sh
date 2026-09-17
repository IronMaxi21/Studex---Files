#!/usr/bin/env bash
#
# Assembles Studex.app.
#
# No Xcode project is involved: the shell is a handful of Swift files compiled
# with swiftc, and everything else is copying the right things into the right
# places inside the bundle. Run it from anywhere.
#
#   ./build/build-app.sh                 → dist/Studex.app, with Node bundled
#   ./build/build-app.sh --no-node       → smaller bundle; requires Node installed
#   ./build/build-app.sh --out ~/Desktop → build somewhere else
#   ./build/build-app.sh --sign "Developer ID Application: … (TEAMID)"
#   ./build/build-app.sh --notarize      → also submit to Apple and staple
#   ./build/build-app.sh --dmg           → also make dist/Studex-mac.dmg
#
# Signing and notarising are driven by the environment, so a release can be cut
# without typing a certificate name into a shell:
#
#   STUDEX_SIGN_IDENTITY   the Developer ID Application certificate to use.
#                          Left unset, a single matching certificate in the
#                          keychain is found automatically; with none, the
#                          build is signed ad-hoc and says so.
#   STUDEX_NOTARY_PROFILE  a notarytool keychain profile, made once with
#                          `xcrun notarytool store-credentials`. This is the
#                          way that keeps an app-specific password out of the
#                          environment and out of CI logs.
#   STUDEX_NOTARY_APPLE_ID, STUDEX_NOTARY_TEAM_ID, STUDEX_NOTARY_PASSWORD
#                          the three-part alternative, for a machine with no
#                          keychain to store a profile in.

set -euo pipefail

BUILD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAC_DIR="$(dirname "$BUILD_DIR")"
ROOT_DIR="$(dirname "$MAC_DIR")"
SERVER_DIR="$ROOT_DIR/studex-server"

OUT_DIR="$MAC_DIR/dist"
BUNDLE_NODE=1
SIGN_IDENTITY="${STUDEX_SIGN_IDENTITY:-}"
NOTARIZE=0
MAKE_DMG=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dmg) MAKE_DMG=1; shift ;;
    --no-node) BUNDLE_NODE=0; shift ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    --sign) SIGN_IDENTITY="$2"; shift 2 ;;
    --notarize|--notarise) NOTARIZE=1; shift ;;
    -h|--help) sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

APP="$OUT_DIR/Studex.app"
CONTENTS="$APP/Contents"
RESOURCES="$CONTENTS/Resources"
ARCH="$(uname -m)"
DEPLOYMENT_TARGET="13.0"

# One source of truth for what this build calls itself. The Updates screen
# compares it against whatever the feed offers, so a build that lies about its
# version is a build that either never updates or updates for ever.
VERSION="$(tr -d ' \t\n\r' < "$ROOT_DIR/VERSION" 2>/dev/null || true)"
[ -n "$VERSION" ] || VERSION="0.0.0"
BUILD_STAMP="$(date +%Y%m%d%H%M)"

step() { printf '\033[1m▸ %s\033[0m\n' "$1"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# ── prerequisites ───────────────────────────────────────────────────────
for tool in swiftc iconutil codesign node npm; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required but not on PATH."
done
[ -d "$SERVER_DIR/node_modules" ] || die "Run 'npm install' in studex-server first."

step "Building Studex $VERSION ($BUILD_STAMP) into $OUT_DIR"
rm -rf "$APP"
mkdir -p "$CONTENTS/MacOS" "$RESOURCES"

# ── the shell ───────────────────────────────────────────────────────────
# The window is painted before the stylesheet is read, so AppKit keeps its own
# copy of the chrome colours. It is made here rather than maintained by hand,
# and checked in so that a plain `swiftc App/*.swift` still builds: a palette
# that has to be edited in two places is a palette that ends up saying two
# different things, which is exactly what it had started doing.
step "Generating the shell palette from tokens.css"
node "$BUILD_DIR/tokens-to-swift.mjs" "$MAC_DIR/web/css/tokens.css" > "$MAC_DIR/App/ThemeTokens.swift"

step "Compiling the app shell ($ARCH)"
swiftc \
  -parse-as-library \
  -target "$ARCH-apple-macos$DEPLOYMENT_TARGET" \
  -O -whole-module-optimization \
  -o "$CONTENTS/MacOS/Studex" \
  "$MAC_DIR/App"/*.swift

# ── icon ────────────────────────────────────────────────────────────────
# Cached: rendering it needs a compile of its own, and it changes rarely.
ICNS="$BUILD_DIR/Studex.icns"
if [ ! -f "$ICNS" ] || [ "$BUILD_DIR/make-icon.swift" -nt "$ICNS" ]; then
  step "Rendering the icon"
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
  swiftc -O -o "$WORK/make-icon" "$BUILD_DIR/make-icon.swift"
  "$WORK/make-icon" "$WORK/Studex.iconset"
  iconutil -c icns -o "$ICNS" "$WORK/Studex.iconset"
fi
cp "$ICNS" "$RESOURCES/Studex.icns"

# ── scripting ───────────────────────────────────────────────────────────
# What `tell application "Studex"` can say, which is also what the Shortcuts
# Run AppleScript action can say. App/Automation.swift explains why this is
# scripting and not App Intents.
cp "$BUILD_DIR/Studex.sdef" "$RESOURCES/Studex.sdef"

# ── the interface ───────────────────────────────────────────────────────
step "Copying the interface"
"$BUILD_DIR/check-js.sh" >/dev/null || die "The interface has a syntax error."
mkdir -p "$RESOURCES/web"
# Explicit list rather than a bare copy: .DS_Store and editor droppings have no
# business being served by the app's own web root.
for part in index.html css js vendor; do
  cp -R "$MAC_DIR/web/$part" "$RESOURCES/web/"
done
find "$RESOURCES/web" -name '.DS_Store' -delete

# ── identity provider ───────────────────────────────────────────────────
# Supabase settings, when this build has any: taken from the environment, and
# otherwise from the server's .env. Both halves are required together, because
# half of them produces an app that launches and then refuses every sign-in.
#
# The anon key is a publishable credential — it is designed to ship inside
# clients, and grants only what row-level security in the project allows — so
# baking it into the bundle is what it is for. With neither set, the app keeps
# its own credentials, which is also the only mode that works offline.
env_value() {
  [ -f "$SERVER_DIR/.env" ] || return 0
  sed -n "s/^[[:space:]]*$1=//p" "$SERVER_DIR/.env" | tail -n1 \
    | tr -d '\r' | sed -e 's/^["'"'"']//' -e 's/["'"'"']$//'
}

SB_URL="${SUPABASE_URL:-$(env_value SUPABASE_URL)}"
SB_KEY="${SUPABASE_ANON_KEY:-$(env_value SUPABASE_ANON_KEY)}"
rm -f "$RESOURCES/supabase.json"
if [ -n "$SB_URL" ] && [ -n "$SB_KEY" ]; then
  step "Baking in Supabase settings"
  # Written by node rather than by hand so the values are escaped properly.
  node -e 'process.stdout.write(JSON.stringify({ url: process.argv[1], anonKey: process.argv[2] }))' \
    "$SB_URL" "$SB_KEY" > "$RESOURCES/supabase.json"
elif [ -n "$SB_URL$SB_KEY" ]; then
  die "SUPABASE_URL and SUPABASE_ANON_KEY must be set together, or neither."
fi

# ── the release AI key ──────────────────────────────────────────────────
# A release carries a Gemini key so AI works with nothing to set up. It comes
# from STUDEX_GEMINI_KEY or a private file on the release machine — never from
# the source tree — and is written masked (XOR with a random pad), which only
# keeps it out of a naive scan of the bundle: it is not a secret once shipped.
GEMINI_KEY_FILE="${STUDEX_GEMINI_KEY_FILE:-$HOME/.studex-release/gemini.key}"
rm -f "$RESOURCES/ai-key.json"
if [ -n "${STUDEX_GEMINI_KEY:-}" ] || [ -f "$GEMINI_KEY_FILE" ]; then
  step "Baking in the release AI key"
  STUDEX_GEMINI_KEY_FILE="$GEMINI_KEY_FILE" node -e '
    const fs = require("fs"), crypto = require("crypto");
    const key = (process.env.STUDEX_GEMINI_KEY || fs.readFileSync(process.env.STUDEX_GEMINI_KEY_FILE, "utf8")).trim();
    if (!key) process.exit(1);
    const bytes = Buffer.from(key, "utf8");
    const pad = crypto.randomBytes(bytes.length);
    const data = bytes.map((b, i) => b ^ pad[i]);
    process.stdout.write(JSON.stringify({ pad: pad.toString("base64"), data: Buffer.from(data).toString("base64") }));
  ' > "$RESOURCES/ai-key.json" || die "could not write the release AI key."
fi

# ── the backend ─────────────────────────────────────────────────────────
step "Compiling the backend"
"$SERVER_DIR/node_modules/.bin/tsc" -p "$SERVER_DIR/tsconfig.build.json" \
  || die "The backend did not compile."

step "Installing production dependencies"
STAGE="$RESOURCES/server"
mkdir -p "$STAGE"
cp -R "$SERVER_DIR/dist" "$STAGE/dist"
cp -R "$SERVER_DIR/migrations" "$STAGE/migrations"
cp "$SERVER_DIR/package.json" "$SERVER_DIR/package-lock.json" "$STAGE/"

# A fresh install from the lockfile, so the bundle carries production
# dependencies only and better-sqlite3 is built for this machine — the
# development tree's node_modules holds the toolchain as well, and copying it
# would put ~86 MB of compilers inside the app.
( cd "$STAGE" && npm ci --omit=dev --ignore-scripts=false --no-audit --no-fund --prefer-offline >/dev/null ) \
  || die "npm ci failed in $STAGE"
rm -f "$STAGE/package-lock.json"

node -e '
  const path = process.argv[1];
  require(path);
' "$STAGE/node_modules/better-sqlite3/build/Release/better_sqlite3.node" 2>/dev/null \
  || echo "  note: better-sqlite3 could not be loaded by this Node; it will be rebuilt on first run if needed."

# better-sqlite3 compiles from source, and npm leaves the whole build tree
# behind: object files, a static SQLite archive and the amalgamation it was
# built from. Only the finished addon and its JavaScript are needed to run,
# and the rest is 25 MB of the bundle.
BSQ="$STAGE/node_modules/better-sqlite3"
if [ -f "$BSQ/build/Release/better_sqlite3.node" ]; then
  step "Pruning build intermediates"
  ADDON="$(mktemp -d)/better_sqlite3.node"
  cp "$BSQ/build/Release/better_sqlite3.node" "$ADDON"
  rm -rf "$BSQ/build" "$BSQ/deps" "$BSQ/src" "$BSQ/binding.gyp"
  mkdir -p "$BSQ/build/Release"
  cp "$ADDON" "$BSQ/build/Release/better_sqlite3.node"
fi

# ── the runtime ─────────────────────────────────────────────────────────
if [ "$BUNDLE_NODE" -eq 1 ]; then
  NODE_BIN="$(command -v node)"
  step "Bundling Node ($("$NODE_BIN" -v))"
  mkdir -p "$RESOURCES/node/bin"
  cp "$NODE_BIN" "$RESOURCES/node/bin/node"
  chmod 755 "$RESOURCES/node/bin/node"
  # Node ships as a universal binary. The native modules beside it were built
  # for one architecture only, so carrying the other slice adds ~115 MB that
  # could never run anyway.
  if lipo -info "$RESOURCES/node/bin/node" 2>/dev/null | grep -q 'Architectures in the fat file'; then
    lipo -thin "$ARCH" "$RESOURCES/node/bin/node" -output "$RESOURCES/node/bin/node.thin"
    mv "$RESOURCES/node/bin/node.thin" "$RESOURCES/node/bin/node"
    chmod 755 "$RESOURCES/node/bin/node"
  fi
else
  step "Skipping Node (the app will look for an installed one)"
fi

# ── metadata ────────────────────────────────────────────────────────────
step "Writing Info.plist"
cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Studex</string>
  <key>CFBundleDisplayName</key><string>Studex</string>
  <key>CFBundleIdentifier</key><string>com.studex.desktop</string>
  <key>CFBundleExecutable</key><string>Studex</string>
  <key>CFBundleIconFile</key><string>Studex</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$BUILD_STAMP</string>
  <key>LSMinimumSystemVersion</key><string>$DEPLOYMENT_TARGET</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>NSHighResolutionCapable</key><true/>
  <!-- Handoff, and the app's own restoration: a window is remembered as the
       route it was showing, so the same screen can be picked up on another
       Mac signed in to the same account. -->
  <key>NSUserActivityTypes</key>
  <array>
    <string>com.studex.desktop.route</string>
  </array>
  <!-- studex://review, studex://doc/<id> — how a Shortcut that would rather
       not write a script opens a screen, and what a Spotlight result and a
       link in a note both resolve to. -->
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>com.studex.desktop.route</string>
      <key>CFBundleTypeRole</key><string>Viewer</string>
      <key>CFBundleURLSchemes</key>
      <array><string>studex</string></array>
    </dict>
  </array>
  <key>NSAppleScriptEnabled</key><true/>
  <key>OSAScriptingDefinition</key><string>Studex.sdef</string>
  <!-- The database has to be closed on the way out, so this process must not
       be killed without its termination handler running. -->
  <key>NSSupportsSuddenTermination</key><false/>
  <key>NSSupportsAutomaticTermination</key><false/>
  <key>NSHumanReadableCopyright</key><string>Studex</string>
</dict>
</plist>
PLIST

# The public half of the release signing key (see `publish:release --gen-keys`).
# With it baked in, the app installs only zips signed by the matching private
# key, which never leaves the release machine. Without it, the sha256 in the
# release row is the only check — fine for a development build.
UPDATE_PUBLIC_KEY_FILE="${STUDEX_UPDATE_PUBLIC_KEY_FILE:-$HOME/.studex-release/ed25519.pub}"
if [ -f "$UPDATE_PUBLIC_KEY_FILE" ]; then
  UPDATE_PUBLIC_KEY="$(tr -d '[:space:]' < "$UPDATE_PUBLIC_KEY_FILE")"
  [[ "$UPDATE_PUBLIC_KEY" =~ ^[A-Za-z0-9+/]{43}=$ ]] || die "$UPDATE_PUBLIC_KEY_FILE is not an Ed25519 public key."
  plutil -insert StudexUpdatePublicKey -string "$UPDATE_PUBLIC_KEY" "$CONTENTS/Info.plist" \
    || die "could not write the update signing key."
  step "Updates must be signed by key ${UPDATE_PUBLIC_KEY:0:8}…"
fi

echo -n 'APPL????' > "$CONTENTS/PkgInfo"

# ── signature ───────────────────────────────────────────────────────────
# With a Developer ID certificate, this produces something another Mac will
# open. Without one, it is signed ad-hoc, which is enough to run here and
# nowhere else — and the build says which of the two it made rather than
# leaving it to be discovered by whoever downloads it.
ENTITLEMENTS="$BUILD_DIR/Studex.entitlements"
[ -f "$ENTITLEMENTS" ] || die "$ENTITLEMENTS is missing."

# One certificate in the keychain is the ordinary case and needs no argument.
# Several is ambiguous, and guessing at a release signature is not this
# script's business, so it asks rather than picks.
if [ -z "$SIGN_IDENTITY" ]; then
  FOUND="$(security find-identity -v -p codesigning 2>/dev/null \
    | sed -n 's/.*"\(Developer ID Application: .*\)"$/\1/p')"
  COUNT="$(printf '%s' "$FOUND" | grep -c . || true)"
  if [ "$COUNT" -eq 1 ]; then
    SIGN_IDENTITY="$FOUND"
  elif [ "$COUNT" -gt 1 ]; then
    printf '\033[33m  several Developer ID certificates are installed:\033[0m\n' >&2
    printf '%s\n' "$FOUND" | sed 's/^/    /' >&2
    die "Pick one with --sign or STUDEX_SIGN_IDENTITY."
  fi
fi

if [ -n "$SIGN_IDENTITY" ]; then
  step "Signing as $SIGN_IDENTITY"
else
  step "Signing (ad-hoc — this build will only run on this machine)"
  SIGN_IDENTITY="-"
fi

# The hardened runtime goes on in both cases, ad-hoc included. It is what
# notarisation requires, and it is also the thing most likely to break the app
# in ways nothing else reveals; discovering that during a release, on a build
# nobody has run, is the whole problem it is being applied early to avoid.
sign_one() {
  codesign --force --sign "$SIGN_IDENTITY" \
    --options runtime \
    --entitlements "$ENTITLEMENTS" \
    ${TIMESTAMP_FLAG} \
    "$1" >/dev/null 2>&1 || die "codesign failed on $1"
}

# Ad-hoc signatures cannot be timestamped, and asking Apple's timestamp server
# for one on every local build would make the build need the network.
if [ "$SIGN_IDENTITY" = "-" ]; then TIMESTAMP_FLAG="--timestamp=none"; else TIMESTAMP_FLAG="--timestamp"; fi

# Inside out. A bundle's signature covers what is nested in it, so anything
# signed after the outer signature invalidates it — which is exactly what
# --deep gets wrong, and why Apple stopped recommending it.
while IFS= read -r -d '' binary; do
  sign_one "$binary"
done < <(find "$RESOURCES" -type f \( -name '*.node' -o -name '*.dylib' -o -name '*.so' \) -print0)
[ -f "$RESOURCES/node/bin/node" ] && sign_one "$RESOURCES/node/bin/node"
sign_one "$APP"

codesign --verify --strict --deep "$APP" >/dev/null 2>&1 \
  || die "the signature did not verify."

# ── hide the bundle's insides ─────────────────────────────────────────────
# Someone who mounts the disk image and reaches for "Show Package Contents"
# should find nothing to pick through: the bundled server, the Node runtime,
# the web assets and the config all carry the Finder-hidden flag, so an opened
# bundle looks empty. This is a presentation flag, not a lock — dyld,
# LaunchServices and Gatekeeper never consult it, so the app still launches and
# its signature still verifies — and it is honest about its reach: a Terminal,
# or Finder with hidden files shown, can still read anything a read-only image
# carries. It cannot make a file that ships in the bundle truly unreadable.
#
# The flag goes on the immediate children of Contents/ — MacOS, Resources,
# Frameworks, Info.plist, _CodeSignature and the rest — which hides the whole
# tree beneath them at once. It is set after the seal is verified and before
# the seal is verified again, because a BSD flag is metadata the signature does
# not cover; the second check is what proves that.
step "Hiding the bundle's internals"
while IFS= read -r -d '' entry; do
  chflags hidden "$entry" 2>/dev/null || true
done < <(find "$APP/Contents" -mindepth 1 -maxdepth 1 -print0)
codesign --verify --strict --deep "$APP" >/dev/null 2>&1 \
  || die "hiding the bundle internals broke the signature."

# ── notarisation ────────────────────────────────────────────────────────
# Apple's check that the signed app is what it claims to be. It needs the
# network and an Apple account, so it happens only when asked for and only
# when there is a real signature for it to attest to.
if [ "$NOTARIZE" -eq 1 ]; then
  [ "$SIGN_IDENTITY" != "-" ] \
    || die "Notarisation needs a Developer ID signature; an ad-hoc one cannot be notarised."
  command -v xcrun >/dev/null 2>&1 || die "xcrun is required to notarise."

  if [ -n "${STUDEX_NOTARY_PROFILE:-}" ]; then
    NOTARY_AUTH=(--keychain-profile "$STUDEX_NOTARY_PROFILE")
  elif [ -n "${STUDEX_NOTARY_APPLE_ID:-}" ] && [ -n "${STUDEX_NOTARY_TEAM_ID:-}" ] \
    && [ -n "${STUDEX_NOTARY_PASSWORD:-}" ]; then
    NOTARY_AUTH=(--apple-id "$STUDEX_NOTARY_APPLE_ID" --team-id "$STUDEX_NOTARY_TEAM_ID" \
      --password "$STUDEX_NOTARY_PASSWORD")
  else
    die "Notarisation needs STUDEX_NOTARY_PROFILE, or all three of STUDEX_NOTARY_APPLE_ID, STUDEX_NOTARY_TEAM_ID and STUDEX_NOTARY_PASSWORD."
  fi

  step "Notarising (this waits on Apple, and can take a few minutes)"
  ZIP="$(mktemp -d)/Studex.zip"
  # ditto, not zip: it is the only archiver that preserves the symlinks and
  # extended attributes a signed bundle is made of.
  ditto -c -k --keepParent "$APP" "$ZIP" || die "could not archive the app for notarisation."
  xcrun notarytool submit "$ZIP" "${NOTARY_AUTH[@]}" --wait \
    || die "Notarisation was refused. 'xcrun notarytool log <id>' says why."
  rm -f "$ZIP"

  # Stapling writes the ticket into the bundle, so the app opens on a Mac that
  # is offline the first time it is launched.
  step "Stapling the ticket"
  xcrun stapler staple "$APP" || die "could not staple the notarisation ticket."
  xcrun stapler validate "$APP" >/dev/null || die "the stapled ticket did not validate."

  # The last word belongs to the thing that will actually judge the app: not
  # codesign, but the assessment Gatekeeper makes on the machine it lands on.
  spctl --assess --type execute --verbose=2 "$APP" 2>&1 | sed 's/^/  /'
fi

SIZE="$(du -sh "$APP" | cut -f1)"
step "Built $APP ($SIZE)"
if [ "$SIGN_IDENTITY" = "-" ]; then
  printf '  \033[33mAd-hoc signed: another Mac will refuse to open this.\033[0m\n'
  printf '  Set STUDEX_SIGN_IDENTITY and pass --notarize to cut a release build.\n'
elif [ "$NOTARIZE" -eq 0 ]; then
  printf '  \033[33mSigned but not notarised: Gatekeeper will still warn on first launch.\033[0m\n'
  printf '  Pass --notarize to submit it to Apple.\n'
fi
echo "  open \"$APP\""

# ── the disk image ──────────────────────────────────────────────────────
if [ "$MAKE_DMG" -eq 1 ]; then
  step "Making Studex-mac.dmg"
  DMG_STAGE="$(mktemp -d)"
  ditto "$APP" "$DMG_STAGE/Studex.app"
  ln -s /Applications "$DMG_STAGE/Applications"
  DMG="$OUT_DIR/Studex-mac.dmg"
  rm -f "$DMG"
  hdiutil create -volname Studex -srcfolder "$DMG_STAGE" -ov -format UDZO "$DMG" >/dev/null \
    || die "could not create the disk image."
  rm -rf "$DMG_STAGE"
  if [ "$SIGN_IDENTITY" != "-" ]; then codesign --force --sign "$SIGN_IDENTITY" "$DMG" || true; fi
  echo "  $DMG ($(du -sh "$DMG" | cut -f1))"
fi
