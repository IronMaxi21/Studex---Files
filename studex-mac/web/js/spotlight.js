/**
 * The library, findable from Spotlight.
 *
 * The argument for this is the one moment the app cannot help with: the
 * student is in another app, remembers there were notes on enzymes somewhere,
 * and the fastest route to them should be ⌘Space rather than finding Studex,
 * waiting for it, and searching again inside it. macOS will do that, but only
 * for text it has been given.
 *
 * Which is the reason this is off until it is switched on. Handing titles and
 * a few lines of body to CoreSpotlight puts a copy of somebody's notes in an
 * index that belongs to the machine and not to the app: it survives signing
 * out, it is readable by anyone at that keyboard, and no password of ours
 * stands in front of it. On a personal laptop that is a fair trade for finding
 * things faster; on the library Mac it is not, which is why the setting is per
 * device and why signing out empties it again.
 *
 * The feed is the whole set every time rather than a list of changes. That is
 * what makes deleting work: neither side has to remember what it has already
 * said, and a file removed on another device disappears from Spotlight here
 * the next time the app looks.
 */
import { api } from './api.js';
import { state } from './store.js';
import { isNative, indexForSpotlight, clearSpotlight } from './native.js';
import { log } from './log.js';

/** Slow: an index nobody is looking at does not need to be minutes fresh. */
const REFRESH_MS = 15 * 60_000;

/** Long enough for the screen the student is waiting for to have settled. */
const FIRST_PASS_MS = 8_000;

let timer = null;

/** Whether anything of this account's is currently in the system index. */
let indexed = false;

/** True while a pass is in flight, so a burst of edits makes one request. */
let running = false;

const wanted = () => isNative && state.user && state.device?.spotlight === true;

async function pass() {
  if (running || !state.ready) return;
  running = true;
  try {
    const { items } = await api.searchCorpus();
    indexForSpotlight(items ?? []);
    indexed = true;
  } catch (err) {
    // A failed pass leaves whatever is already indexed in place: stale results
    // that still open the right file are better than none.
    log.warn('spotlight feed failed', err);
  } finally {
    running = false;
  }
}

/**
 * Brings the index into line with the setting, whichever way it has moved.
 *
 * Called after sign-in and whenever device settings change, so turning the
 * switch off takes effect immediately rather than at the next sign-out.
 */
export function syncSpotlight() {
  if (!isNative) return;

  if (!wanted()) {
    clearInterval(timer);
    timer = null;
    if (indexed) { clearSpotlight(); indexed = false; }
    return;
  }

  if (!timer) {
    timer = setInterval(() => { void pass(); }, REFRESH_MS);
    setTimeout(() => { void pass(); }, FIRST_PASS_MS);
  }
}

/**
 * Empties the index and stops feeding it.
 *
 * Signing out has to do this. An index left behind is the previous account's
 * note titles offered to the next person to press ⌘Space on this Mac, which is
 * a worse leak than the Dock badge because the text comes with it.
 */
export function stopSpotlight() {
  clearInterval(timer);
  timer = null;
  if (indexed || isNative) { clearSpotlight(); indexed = false; }
}
