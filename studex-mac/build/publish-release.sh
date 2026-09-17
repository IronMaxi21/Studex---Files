#!/usr/bin/env bash
#
# Sends an update out.
#
# One row in the project's releases table is how every Mac learns there is a
# newer Studex. Shipping is two steps: this archives the app, hashes it,
# uploads it to the project's `releases` storage bucket and writes the row as
# pending; approving it is what makes every running copy download it.
#
#   ./build/publish-release.sh --build --notarize
#   ./build/publish-release.sh --dry-run
#   ./build/publish-release.sh --list
#   ./build/publish-release.sh --approve 1.1.0
#   ./build/publish-release.sh --reject 1.1.0
#   ./build/publish-release.sh --gen-keys        (once, before the first signed build)
#   ./build/publish-release.sh --sync-feeds      (rewrite the feeds and the website)
#
#   --url-base   host the zip yourself instead of in Supabase Storage.
#   --url        the full download URL, if it is not <url-base>/<filename>.
#   --github r   host the zip and DMG on GitHub Releases in repo r (owner/name,
#                or STUDEX_GITHUB_REPO). Needs the gh CLI, logged in. The repo
#                must be public so every Mac can download without an account.
#                Use it on Supabase's free plan, which caps uploads at 50 MB.
#   --build      build the app first, instead of using dist/Studex.app.
#   --notarize   passed through to the build, with --sign if set.
#   --notes-file release notes shown in the Updates screen.
#   --dry-run    archive and hash, print the row, write nothing.
#   --list       show every release and whether it is pending, approved or rejected.
#   --approve v  download v back, check it, and offer it to every Mac.
#   --reject v   never offer v, or stop offering it.
#   --channel c  stable (default) or beta; a beta is offered only to Macs that opted in.
#   --critical   install without waiting for the student to pick a moment.
#   --min-macos  the oldest macOS this version runs on.
#   --no-dmg     do not build or upload the disk image.
#   --unsigned   publish an ad-hoc signed build (no Developer ID). It installs
#                through the updater, but a downloaded DMG is blocked by
#                Gatekeeper until the user picks Open Anyway in System Settings.
#   --site dir   the website to refresh on approve (default: ../studex-site beside
#                the project, when it exists). Its downloads/ gets the new DMG,
#                manifest.json, releases.json and the appcasts.
#
# Every release ships two ways from one command: the zip the updater installs
# (signed with ~/.studex-release/ed25519.key when it exists) and the DMG the
# website hands to new installs. Approving is what moves both: the app feed,
# the appcasts in the bucket, and the website's download card and changelog.
#
# The archive is made with ditto, because that is what the updater in the app
# unpacks it with, and the only archiver that preserves the symlinks and
# extended attributes a signed bundle is made of.
#
# Publishing needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in
# studex-server/.env or in the environment. The service role key can rewrite
# the update feed every install trusts: it belongs on this machine and nowhere
# near the bundle being shipped.

set -euo pipefail

BUILD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAC_DIR="$(dirname "$BUILD_DIR")"
ROOT_DIR="$(dirname "$MAC_DIR")"
SERVER_DIR="$ROOT_DIR/studex-server"

OUT_DIR="$MAC_DIR/dist"
URL_BASE=""
FULL_URL=""
NOTES_FILE=""
DO_BUILD=0
NOTARIZE=0
DRY_RUN=0
MANAGE=()
CHANNEL="stable"
CRITICAL=0
MIN_MACOS=""
WITH_DMG=1
UNSIGNED=0
GITHUB_REPO="${STUDEX_GITHUB_REPO:-}"
SITE_DIR=""
for candidate in "$ROOT_DIR/../studex-site" "$ROOT_DIR/studex-site"; do
  if [ -z "$SITE_DIR" ] && [ -f "$candidate/make-manifest.py" ]; then
    SITE_DIR="$(cd "$candidate" && pwd)"
  fi
done

while [ $# -gt 0 ]; do
  case "$1" in
    --url-base) URL_BASE="${2%/}"; shift 2 ;;
    --url) FULL_URL="$2"; shift 2 ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    --notes-file) NOTES_FILE="$2"; shift 2 ;;
    --build) DO_BUILD=1; shift ;;
    --notarize|--notarise) NOTARIZE=1; DO_BUILD=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --list) MANAGE=(--list); shift ;;
    --approve|--reject) MANAGE=("$1" "${2:?$1 needs a version}"); shift 2 ;;
    --gen-keys) MANAGE=(--gen-keys); shift ;;
    --sync-feeds) MANAGE=(--sync-feeds); shift ;;
    --channel) CHANNEL="$2"; shift 2 ;;
    --critical) CRITICAL=1; shift ;;
    --min-macos) MIN_MACOS="$2"; shift 2 ;;
    --no-dmg) WITH_DMG=0; shift ;;
    --unsigned) UNSIGNED=1; shift ;;
    --github) GITHUB_REPO="$2"; shift 2 ;;
    --site) SITE_DIR="$(cd "$2" && pwd)"; shift 2 ;;
    -h|--help) awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

step() { printf '\033[1m▸ %s\033[0m\n' "$1"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# The website follows the feed: the stable DMG on its download card, the
# manifest that describes it, and the changelog and appcasts beside them.
refresh_site() {
  local approved="${1:-}"
  [ -n "$SITE_DIR" ] || { echo "  No website folder found; pass --site to refresh one."; return 0; }
  local downloads="$SITE_DIR/downloads"
  mkdir -p "$downloads"
  # A pre-release (1.2.0-beta.1) never replaces the download everyone gets.
  if [ -n "$approved" ] && [[ "$approved" != *-* ]] && [ -f "$OUT_DIR/Studex-$approved.dmg" ]; then
    step "Putting Studex $approved on the website"
    cp "$OUT_DIR/Studex-$approved.dmg" "$downloads/Studex-mac.dmg"
  fi
  ( cd "$SITE_DIR" && python3 make-manifest.py ) || die "could not rewrite the website manifest."
  if [ -f "$SITE_DIR/build-single.py" ]; then
    ( cd "$SITE_DIR" && python3 build-single.py ) >/dev/null || echo "  ! build-single.py failed; the folder site is still up to date."
  fi
  echo "  Website refreshed in $SITE_DIR — deploy it the way you usually do."
}

# Approving, rejecting and the keys touch the table and this machine, not the app.
if [ "${#MANAGE[@]}" -gt 0 ]; then
  SYNC_ARGS=()
  case "${MANAGE[0]}" in
    --approve|--reject|--sync-feeds) [ -n "$SITE_DIR" ] && SYNC_ARGS=(--site "$SITE_DIR/downloads") ;;
  esac
  ( cd "$SERVER_DIR" && npm run --silent publish:release -- "${MANAGE[@]}" ${SYNC_ARGS[@]+"${SYNC_ARGS[@]}"} )
  case "${MANAGE[0]}" in
    --approve) refresh_site "${MANAGE[1]}" ;;
    --reject|--sync-feeds) refresh_site ;;
  esac
  exit 0
fi

case "$CHANNEL" in stable|beta) ;; *) die "--channel is stable or beta." ;; esac

# Publishing runs from the server folder, so a relative notes path is fixed here.
if [ -n "$NOTES_FILE" ]; then
  [ -f "$NOTES_FILE" ] || die "No notes file at $NOTES_FILE."
  NOTES_FILE="$(cd "$(dirname "$NOTES_FILE")" && pwd)/$(basename "$NOTES_FILE")"
fi

for tool in ditto shasum node npm plutil codesign; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required but not on PATH."
done

# One source of truth for what this release is called, the same file the build
# stamps into the bundle.
VERSION="$(tr -d ' \t\n\r' < "$ROOT_DIR/VERSION" 2>/dev/null || true)"
[ -n "$VERSION" ] || die "$ROOT_DIR/VERSION is missing or empty."

APP="$OUT_DIR/Studex.app"
ZIP="$OUT_DIR/Studex-$VERSION.zip"
DMG="$OUT_DIR/Studex-mac.dmg"
VERSIONED_DMG="$OUT_DIR/Studex-$VERSION.dmg"

# ── the app ─────────────────────────────────────────────────────────────
if [ "$DO_BUILD" -eq 1 ]; then
  step "Building Studex $VERSION"
  BUILD_ARGS=(--out "$OUT_DIR")
  [ "$NOTARIZE" -eq 1 ] && BUILD_ARGS+=(--notarize)
  [ "$WITH_DMG" -eq 1 ] && BUILD_ARGS+=(--dmg)
  "$BUILD_DIR/build-app.sh" "${BUILD_ARGS[@]}"
fi

[ -d "$APP" ] || die "There is no app at $APP. Pass --build, or --out where one is."

# The bundle carries its own version, and the Updates screen compares that
# against what the feed offers. Publishing a row that says 1.1.0 while the zip
# holds 1.0.9 gives every Mac an update it installs and is then offered again
# for ever, so the two are checked against each other before anything is sent.
BUNDLE_VERSION="$(plutil -extract CFBundleShortVersionString raw -o - "$APP/Contents/Info.plist" 2>/dev/null || true)"
[ -n "$BUNDLE_VERSION" ] || die "Could not read a version out of $APP."
[ "$BUNDLE_VERSION" = "$VERSION" ] \
  || die "VERSION says $VERSION but the built app says $BUNDLE_VERSION. Rebuild with --build."

# An update travels to machines that are not yours, and Gatekeeper on each of
# them decides whether it opens. An ad-hoc signature passes codesign and fails
# there, which is a release that installs and then will not launch.
if codesign -dv "$APP" 2>&1 | grep -q 'Signature=adhoc'; then
  if [ "$UNSIGNED" -eq 1 ]; then
    printf '  \033[33mAd-hoc signed (--unsigned) — first launch from the DMG needs Open Anyway.\033[0m\n'
  elif [ "$DRY_RUN" -eq 1 ]; then
    printf '  \033[33mAd-hoc signed — this could not be published for real.\033[0m\n'
  else
    die "This build is ad-hoc signed. Another Mac will refuse to open it. Set STUDEX_SIGN_IDENTITY and pass --notarize, or pass --unsigned."
  fi
fi

# ── the archive ─────────────────────────────────────────────────────────
step "Archiving $APP"
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP" || die "could not archive the app."

SHA="$(shasum -a 256 "$ZIP" | cut -d' ' -f1)"
SIZE="$(wc -c < "$ZIP" | tr -d ' ')"
printf '  %s\n  %s\n  %s bytes\n' "$(basename "$ZIP")" "$SHA" "$SIZE"

# ── the disk image ──────────────────────────────────────────────────────
# Only one that was made from this app: an image older than the bundle is a
# previous build, and would put the wrong version on the website.
if [ "$WITH_DMG" -eq 1 ]; then
  if [ -f "$DMG" ] && ! [ "$APP" -nt "$DMG" ]; then
    cp "$DMG" "$VERSIONED_DMG"
    printf '  %s\n  %s\n' "$(basename "$VERSIONED_DMG")" "$(shasum -a 256 "$VERSIONED_DMG" | cut -d' ' -f1)"
  else
    die "No disk image newer than $APP. Pass --build (it makes one), or --no-dmg."
  fi
fi

# ── where it will be downloaded from ────────────────────────────────────
# Supabase Storage unless told otherwise; the publish command uploads it.
DMG_URL=""
if [ -n "$GITHUB_REPO" ]; then
  [[ "$GITHUB_REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "--github takes owner/name."
  [ -z "$URL_BASE" ] && [ -z "$FULL_URL" ] || die "--github sets the download URL itself; drop --url and --url-base."
  URL_BASE="https://github.com/$GITHUB_REPO/releases/download/v$VERSION"
  [ "$WITH_DMG" -eq 1 ] && DMG_URL="$URL_BASE/$(basename "$VERSIONED_DMG")"
fi
if [ -z "$FULL_URL" ] && [ -n "$URL_BASE" ]; then
  FULL_URL="$URL_BASE/$(basename "$ZIP")"
fi
if [ -n "$FULL_URL" ]; then
  case "$FULL_URL" in
    https://*) ;;
    *) die "The download URL must be https — an update is code, and it travels." ;;
  esac
fi

# ── the row ─────────────────────────────────────────────────────────────
# Everything above happens whether or not this is a dry run, because the hash
# is the part worth seeing before committing to it.
PUBLISH_ARGS=(--version "$VERSION" --zip "$ZIP")
[ -n "$FULL_URL" ] && PUBLISH_ARGS+=(--url "$FULL_URL")
[ -n "$NOTES_FILE" ] && PUBLISH_ARGS+=(--notes-file "$NOTES_FILE")
[ "$DRY_RUN" -eq 1 ] && PUBLISH_ARGS+=(--dry-run)
[ "$WITH_DMG" -eq 1 ] && PUBLISH_ARGS+=(--dmg "$VERSIONED_DMG")
[ -n "$DMG_URL" ] && PUBLISH_ARGS+=(--dmg-url "$DMG_URL")
[ "$CHANNEL" != "stable" ] && PUBLISH_ARGS+=(--channel "$CHANNEL")
[ "$CRITICAL" -eq 1 ] && PUBLISH_ARGS+=(--critical)
[ -n "$MIN_MACOS" ] && PUBLISH_ARGS+=(--min-macos "$MIN_MACOS")

# The files go up first: the row points at them, and approving downloads the
# zip back from there. A GitHub release is public as soon as it exists, which
# is fine — like the bucket, what gates an update is the row's approval.
if [ -n "$GITHUB_REPO" ] && [ "$DRY_RUN" -eq 0 ]; then
  command -v gh >/dev/null 2>&1 || die "--github needs the GitHub CLI (gh) on PATH."
  gh auth status >/dev/null 2>&1 || die "gh is not logged in. Run: gh auth login"
  step "Uploading to GitHub ($GITHUB_REPO, v$VERSION)"
  if ! gh release view "v$VERSION" --repo "$GITHUB_REPO" >/dev/null 2>&1; then
    GH_NOTES=(--notes "Studex $VERSION")
    [ -n "$NOTES_FILE" ] && GH_NOTES=(--notes-file "$NOTES_FILE")
    gh release create "v$VERSION" --repo "$GITHUB_REPO" --title "Studex $VERSION" "${GH_NOTES[@]}" \
      || die "could not create the GitHub release."
  fi
  GH_FILES=("$ZIP")
  [ "$WITH_DMG" -eq 1 ] && GH_FILES+=("$VERSIONED_DMG")
  gh release upload "v$VERSION" "${GH_FILES[@]}" --repo "$GITHUB_REPO" --clobber \
    || die "could not upload to the GitHub release."
fi

step "Publishing"
( cd "$SERVER_DIR" && npm run --silent publish:release -- "${PUBLISH_ARGS[@]}" )

if [ "$DRY_RUN" -eq 0 ] && [ -n "$FULL_URL" ] && [ -z "$GITHUB_REPO" ]; then
  echo
  echo "  Upload $ZIP to $FULL_URL before approving —"
  echo "  --approve downloads it back and refuses if it is not there."
fi
