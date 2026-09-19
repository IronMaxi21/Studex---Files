import { log } from './log.js';
/**
 * Bridge to the macOS shell.
 *
 * Two things the web layer cannot do for itself on WebKit:
 *
 *  - Dragging the window. WKWebView has no equivalent of Chromium's
 *    `-webkit-app-region: drag`, so the strip the CSS marks as draggable is
 *    inert on its own; the shell has to be asked to take the mouse over.
 *  - Menu commands. A menu-bar key equivalent is consumed by AppKit before the
 *    web view ever sees a keydown, so ⌘N from the menu arrives here instead.
 *
 * Everything below is a no-op in a plain browser, so the same build runs
 * unchanged during development.
 */

const bridge = window.webkit?.messageHandlers?.studex ?? null;

export const isNative = bridge !== null;

function send(name, detail) {
  if (!bridge) return;
  try {
    bridge.postMessage({ name, ...(detail ?? {}) });
  } catch {
    /* The shell went away mid-gesture; there is nothing useful to do. */
  }
}

/* ── window dragging ──────────────────────────────────────────────────── */

/* Mirrors the CSS: a surface marked as a drag region drags, and controls
   sitting inside it do not. There is no title bar to name any more — the app
   fills the window, and the sidebar's header and the top bar are what the
   window is moved by. */
const DRAG = '[data-app-region="drag"]';
const NO_DRAG = '[data-app-region="no-drag"], .no-drag, button, a, input, select, textarea, [contenteditable]';

function dragSurface(target) {
  if (!(target instanceof Element)) return false;
  const strip = target.closest(DRAG);
  if (!strip) return false;
  // A control only cancels the drag when it is itself inside the strip;
  // a strip nested in some larger control would otherwise never drag.
  const control = target.closest(NO_DRAG);
  return !(control && strip.contains(control));
}

/* ── menu commands ────────────────────────────────────────────────────── */

const handlers = new Map();

/**
 * Commands can arrive before the view that handles them has registered — the
 * shell's menu is live from launch. They wait here rather than being dropped,
 * bounded so a held-down key equivalent during startup cannot pile up.
 */
const pending = [];
const PENDING_LIMIT = 8;

function dispatch(name) {
  const fn = handlers.get(name);
  if (!fn) {
    if (pending.length < PENDING_LIMIT) pending.push(name);
    return;
  }
  Promise.resolve()
    .then(fn)
    .catch((err) => log.error('menu command failed', name, err));
}

/** Registers the handlers for menu commands sent by the shell. */
export function onCommand(map) {
  for (const [name, fn] of Object.entries(map)) handlers.set(name, fn);
  for (const name of pending.splice(0)) dispatch(name);
}

/** Called by the shell. Menu key equivalents never reach the page as keydowns. */
window.__studexCommand = dispatch;

/* ── updates ──────────────────────────────────────────────────────────── */

/**
 * Installing a new version is the shell's work: only AppKit can replace the
 * bundle it is running out of and come back up afterwards. It happens in two
 * halves, the way a Mac app that updates itself is expected to: the download
 * is fetched and checked in the background (`prepareUpdate`), and the swap
 * waits until somebody says restart — or until they quit, when the shell puts
 * it in place on its own.
 */
export function prepareUpdate({ url, sha256, version, signature }) {
  send('prepare-update', { url, sha256, version, signature: signature ?? null });
}

/** Replaces the app with the prepared version and reopens on it. */
export function restartToUpdate() {
  send('restart-to-update');
}

/** Asks the shell to repeat `ready` if an update is already waiting. */
export function askUpdateStatus() {
  send('update-status');
}

const updateWatchers = new Set();

/**
 * Hears every progress step: downloading, verifying, unpacking, ready,
 * installing, relaunching, failed.
 *
 * The returned function has to be called when the listener goes away. Without
 * it the handler outlives its view, holding its whole DOM subtree alive and
 * writing progress into nodes that are no longer on screen.
 */
export function watchUpdate(handler) {
  updateWatchers.add(handler);
  return () => { updateWatchers.delete(handler); };
}

window.__studexUpdate = (progress) => {
  for (const handler of [...updateWatchers]) {
    try { handler(progress); } catch (err) { log.error('update progress failed', err); }
  }
};

/* ── smart zoom ───────────────────────────────────────────────────────── */

/**
 * The trackpad's two-finger double tap.
 *
 * macOS delivers it to the view as `smartMagnifyWithEvent:` and never to the
 * page, so a web view either handles it by scaling the whole document — which
 * this app turns off, because the interface is not a page to be zoomed — or
 * swallows it. The shell forwards the point instead, in CSS pixels, and a
 * screen that has something better to do with it says so here.
 */
let onSmartZoom = null;

/** Registers a handler; the returned function has to be called when the view goes. */
export function onSmartMagnify(handler) {
  onSmartZoom = handler;
  return () => { if (onSmartZoom === handler) onSmartZoom = null; };
}

/** Whether the shell should keep sending them, or handle the gesture itself. */
window.__studexSmartZoom = (x, y) => {
  if (!onSmartZoom) return false;
  try { onSmartZoom(x, y); } catch (err) { log.error('smart zoom failed', err); }
  return true;
};

/* ── notifications ────────────────────────────────────────────────────── */

/**
 * Only the shell can post a macOS notification, and only after macOS has
 * agreed. What is worth saying, and when, is decided in notify.js — this is
 * the part that has to cross the bridge.
 */

/**
 * Permission as the shell reports it: 'unsupported', 'not-determined',
 * 'denied' or 'granted'.
 *
 * Replies carry no correlation id, so an answer settles whoever is waiting
 * rather than one particular question. Only one is ever in flight — the app
 * asks on sign-in and again when a toggle is switched on — so settling them
 * all with the same answer is correct.
 */
const accessWaiters = [];

/**
 * A shell too old to know this message will never answer. The wait ends
 * anyway: every caller treats the answer as advice about what will happen,
 * not as the outcome of anything, so a wrong 'unsupported' costs a silent
 * notification and nothing else. Generous enough that a permission prompt
 * left sitting on screen still resolves truthfully.
 */
const ACCESS_TIMEOUT_MS = 120_000;

window.__studexNotifications = (access) => {
  for (const settle of accessWaiters.splice(0)) settle(access);
};

function askAccess(prompt) {
  if (!bridge) return Promise.resolve('unsupported');
  return new Promise((resolve) => {
    let done = false;
    const settle = (access) => { if (!done) { done = true; resolve(access); } };
    accessWaiters.push(settle);
    setTimeout(() => settle('unsupported'), ACCESS_TIMEOUT_MS);
    send('notification-access', { prompt });
  });
}

/** Asks what the state is. Never prompts, so it is safe to call on a timer. */
export function notificationAccess() {
  return askAccess(false);
}

/**
 * Asks macOS for permission, prompting if nobody has been asked yet. Called
 * from a toggle, because that is the moment the user has said what they want
 * and the system alert makes sense.
 */
export function requestNotificationAccess() {
  return askAccess(true);
}

/**
 * Posts one notification. The id replaces rather than stacks: "8 cards due"
 * an hour later should read as one line saying twelve, not two saying
 * different numbers.
 */
export function postNotification({ id, title, body }) {
  send('notify', { id, title, body });
}

/**
 * The count on the Dock icon. Zero takes the badge away rather than drawing a
 * nought, because "nothing due" is the absence of a reminder and not a
 * reminder that there is nothing.
 *
 * This needs no permission of any kind — a badge interrupts nobody — so it is
 * kept apart from the notification machinery above, and works for a student
 * who has said no to banners.
 */
export function setDockBadge(count) {
  send('badge', { count: Math.max(0, Math.round(count) || 0) });
}

/** Onboarding is finished; the shell remembers it across launches. */
export function markOnboarded() {
  send('onboarded');
}

/** The next lesson today, for the menu bar item. Blank clears it. */
export function setNextLesson(title) {
  send('next-lesson', { title: title ? String(title).slice(0, 80) : '' });
}

/**
 * The day's progress, for the menu bar: how many cards have been reviewed and
 * how long the streak is. It rides along with the due count from the same
 * fetch, so nothing is asked of the server for the menu's sake alone.
 */
export function setStudyProgress({ reviewed = 0, streak = 0 } = {}) {
  send('study-progress', { reviewed: Math.max(0, Math.round(reviewed) || 0), streak: Math.max(0, Math.round(streak) || 0) });
}

/**
 * What the focus timer is doing, for the menu bar.
 *
 * It sends the moment the block ends rather than the seconds left, so the
 * clock beside the system clock can count down on its own instead of the page
 * posting a message every second. Sent when the timer changes state, which is
 * the only time any of these fields move.
 */
export function setFocusState({ phase = 'idle', status = '', endsAt = 0, goal = '', remaining = 0 } = {}) {
  send('focus-state', {
    phase,
    status,
    // Zero while paused, when there is no end time to count towards; the
    // frozen `remaining` is what the menu shows then.
    endsAt: Math.round(endsAt) || 0,
    remaining: Math.max(0, Math.round(remaining) || 0),
    goal: goal ? String(goal).slice(0, 60) : '',
  });
}

/* ── windows ──────────────────────────────────────────────────────────── */

/**
 * Which screen this window is showing, told to the shell.
 *
 * Two things are waiting for it. The window's title bar is empty — the app
 * fills the window and draws its own headings — but the title is still what
 * the Window menu lists, what ⌘` cycles past and what a screenshot is named,
 * so it has to be something better than "Studex" eight times. And the route
 * is the whole of a window's state, because the page is addressed by hash:
 * remembering a string per window is enough to bring every window back the
 * next morning exactly where it was left.
 */
export function reportRoute(route, title) {
  send('route', { route, title });
}

/**
 * Asks for a second window, optionally already showing something.
 *
 * The shell opens it rather than the page, because a window is an AppKit
 * object and because the new one needs its own web view with its own copy of
 * the app in it — `window.open` from here would be a browser window with no
 * menu bar, no title bar treatment and no bridge.
 */
export function openWindow(route) {
  send('new-window', route ? { route } : {});
}

const navigateHandlers = [];

/** Where the shell sends a route: Handoff, a Spotlight hit, a `studex://` link. */
export function onNavigate(handler) {
  navigateHandlers.push(handler);
}

window.__studexNavigate = (route) => {
  for (const handler of navigateHandlers) {
    try {
      handler(String(route ?? 'home'));
    } catch (error) {
      log('navigate handler failed', error);
    }
  }
};

/* ── Spotlight ────────────────────────────────────────────────────────── */

/**
 * Hands the shell everything of this account's that should be findable from
 * Spotlight, as the whole set rather than as changes.
 *
 * Replacing the lot is what makes deletion work without either side keeping a
 * list of what it has already said. The page is the only side that can read
 * the library — it holds the session — and the shell is the only side that can
 * talk to CoreSpotlight, so the feed only ever runs in this direction.
 *
 * Nothing is sent unless the student has turned indexing on: a Spotlight index
 * is a copy of their notes sitting outside the app, readable by anyone at the
 * keyboard, and that is a decision to make rather than a default to discover.
 */
export function indexForSpotlight(items) {
  send('spotlight', { items });
}

/** Takes this account's notes back out of the index. */
export function clearSpotlight() {
  send('spotlight', { items: [] });
}

/* ── the app lock ─────────────────────────────────────────────────────── */

/**
 * Touch ID, and how long the app waits before asking for it.
 *
 * All of the deciding is in the shell: it is the side that hears the app being
 * left, holds the preference somewhere readable before there is a session, and
 * is the only side LocalAuthentication will talk to. What crosses the bridge is
 * the settings screen asking what the state is, saying what it should be, and
 * asking for one authentication in front of something worth guarding.
 */
const lockWaiters = [];

/** A shell too old to know these messages never answers; this ends the wait. */
const LOCK_TIMEOUT_MS = 5_000;

/** What a machine with no shell to ask reports: a feature that is not there. */
const NO_LOCK = { supported: false, biometry: 'password', minutes: 0, share: false };

window.__studexLock = (state) => {
  for (const settle of lockWaiters.splice(0)) settle(state);
};

function askLock(message, detail) {
  if (!bridge) return Promise.resolve(NO_LOCK);
  return new Promise((resolve) => {
    let done = false;
    const settle = (state) => { if (!done) { done = true; resolve(state ?? NO_LOCK); } };
    lockWaiters.push(settle);
    setTimeout(() => settle(NO_LOCK), LOCK_TIMEOUT_MS);
    send(message, detail);
  });
}

/** What the lock is set to, and what this Mac is able to do about it. */
export function lockSettings() {
  return askLock('lock-state');
}

/**
 * Changes one or both of them, and answers with what the shell then holds —
 * which is not always what was asked for, since a Mac that cannot authenticate
 * refuses to be locked.
 */
export function setLockSettings(patch) {
  return askLock('set-lock', patch);
}

/** Covers the window now. */
export function lockNow() {
  send('lock-now');
}

const authWaiters = [];

/** Long, because the panel waits for a person: a finger, or a typed password. */
const AUTH_TIMEOUT_MS = 120_000;

window.__studexAuthenticated = (ok) => {
  for (const settle of authWaiters.splice(0)) settle(ok === true);
};

/**
 * One authentication, in front of one action. `reason` completes the sentence
 * macOS puts in its own panel, so it is a phrase and not a sentence.
 *
 * True in a plain browser: there is nothing to authenticate with there, and the
 * preference that would ask cannot be switched on in the first place, so
 * refusing would only break the action for a developer.
 */
export function authenticate(reason) {
  if (!bridge) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const settle = (ok) => { if (!done) { done = true; resolve(ok); } };
    authWaiters.push(settle);
    setTimeout(() => settle(false), AUTH_TIMEOUT_MS);
    send('authenticate', { reason });
  });
}

/* ── continuity camera ────────────────────────────────────────────────── */

/**
 * A page photographed or scanned with the iPhone that is already in the room.
 *
 * The whole of the gesture happens outside the app — it is a File menu the
 * shell did not build, a device list AppKit filled in, and a shutter pressed
 * somewhere else — so there is nothing to ask for from here. The capture
 * simply arrives, already turned into a PDF by the shell, and the only work
 * left is putting it in the library.
 */
let onScanned = null;

/** Registers the handler. There is one, for the life of the app. */
export function onScan(handler) {
  onScanned = handler;
}

/**
 * Called by the shell with a filename and the PDF as base64.
 *
 * base64 rather than bytes because this crosses from Swift into JavaScript,
 * where the only things that survive the trip intact are strings and numbers.
 * It is decoded here so that no caller has to know it was ever encoded.
 */
window.__studexScanned = (name, base64) => {
  if (!onScanned) return;
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    onScanned(new File([bytes], name, { type: 'application/pdf' }));
  } catch (err) {
    log.error('scan failed', err);
  }
};

/* ── printing ────────────────────────────────────────────── */

/**
 * WKWebView does not implement `window.print()` — calling it there does
 * nothing at all, silently. Only AppKit can raise the print panel, so the page
 * asks and the shell runs `printOperation(with:)` over the window.
 *
 * The promise settles when the panel has closed, printed or cancelled, because
 * the page has usually rearranged itself into something printable and needs to
 * know when it may go back to being an interface.
 */
const printWaiters = [];

/**
 * A panel left open on screen is not a fault, so this has to outlast any
 * reasonable amount of dithering over paper sizes. It exists only so that a
 * shell too old to answer cannot stick the page in its printing shape forever.
 */
const PRINT_TIMEOUT_MS = 10 * 60_000;

window.__studexPrinted = () => {
  for (const settle of printWaiters.splice(0)) settle();
};

/** Prints what is on screen. Resolves once the print panel is done with. */
export function printNow() {
  if (!bridge) {
    // A plain browser during development prints for itself.
    return new Promise((resolve) => {
      let done = false;
      const settle = () => {
        if (done) return;
        done = true;
        window.removeEventListener('afterprint', settle);
        resolve();
      };
      window.addEventListener('afterprint', settle);
      setTimeout(settle, PRINT_TIMEOUT_MS);
      window.print();
    });
  }

  return new Promise((resolve) => {
    let done = false;
    const settle = () => { if (!done) { done = true; resolve(); } };
    printWaiters.push(settle);
    setTimeout(settle, PRINT_TIMEOUT_MS);
    send('print');
  });
}

/* ── install ──────────────────────────────────────────────────────────── */

if (isNative) {
  document.documentElement.dataset.native = 'true';

  document.addEventListener(
    'mousedown',
    (event) => {
      if (event.button !== 0 || !dragSurface(event.target)) return;
      // Suppress the text-selection drag the web view would otherwise start.
      event.preventDefault();
      send('drag');
    },
    true,
  );

  // The traffic lights are drawn by AppKit, outside the reach of the page's
  // stylesheet, so the only way they can follow the app's own light/dark
  // setting is for the shell to be told when it changes.
  const reportTheme = () => send('theme', { theme: document.documentElement.dataset.theme ?? 'dark' });
  new MutationObserver(reportTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  reportTheme();

  document.addEventListener(
    'dblclick',
    (event) => {
      if (!dragSurface(event.target)) return;
      // Whether this zooms, minimises or does nothing is a system preference,
      // so the shell resolves it rather than assuming.
      send('titlebar-double-click');
    },
    true,
  );
}
