/**
 * The number on the Dock icon.
 *
 * Spaced repetition only works if you come back, and the whole of "come back"
 * on this platform is one small red oval on an icon the student already has in
 * front of them. Everything else the app knows about the day's work is behind
 * a window they have to open first, which is precisely the moment the habit
 * fails.
 *
 * It is deliberately not tied to the notification settings. A badge is not an
 * interruption — nothing appears, nothing makes a sound, and macOS asks
 * permission for the ones that do — so switching off banners should not also
 * switch off the quiet count. Somebody who wants neither can turn the badge
 * off for Studex in System Settings, which is where every other app's is.
 *
 * The count comes from whoever has just asked the server for it: the review
 * screen and the deck list both fetch it to draw with, and a study session
 * refreshes it on the way out. The timer underneath is only a floor, for the
 * app left open across midnight with nobody looking at it.
 */
import { api } from './api.js';
import { state } from './store.js';
import { isNative, setDockBadge, setNextLesson } from './native.js';
import { log } from './log.js';

/** Slow on purpose: the number changes when the day turns over, or when the
    student does something the app already hears about directly. */
const REFRESH_MS = 5 * 60_000;

let timer = null;

/** What the Dock is showing, so an unchanged count is not sent again. */
let shown = null;

/** Publishes a count the app has just learned, from wherever it learned it. */
export function reportDue(count) {
  const due = Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0;
  if (due === shown) return;
  shown = due;
  setDockBadge(due);
}

/** Asks the server outright. */
export async function refreshDue() {
  if (!state.user || !state.ready) return;
  const { today } = await api.studyToday();
  reportDue(today?.remaining ?? 0);
  if (isNative) await refreshNextLesson().catch((err) => log.warn('next lesson failed', err));
}

/** The first lesson still to start today, as "Maths · 10:05 · Room 4". */
async function refreshNextLesson() {
  const now = Date.now();
  const end = new Date(); end.setHours(23, 59, 59, 999);
  const { lessons } = await api.lessonsBetween(now, end.getTime());
  const next = (lessons ?? [])
    .filter((l) => new Date(l.starts_at).getTime() >= now)
    .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at))[0];
  if (!next) { setNextLesson(''); return; }
  const time = new Date(next.starts_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  setNextLesson([next.subject, time, next.room].filter(Boolean).join(' · '));
}

/**
 * Starts the floor timer, once, after sign-in. The first pass is deferred so
 * it does not compete with the screen the student is waiting for — and it is
 * usually beaten to it by a view that fetched the same number to draw with.
 */
export function startBadge() {
  if (timer || !isNative) return;
  const tick = () => { refreshDue().catch((err) => log.warn('due count failed', err)); };
  timer = setInterval(tick, REFRESH_MS);
  setTimeout(tick, 4_000);
}

/**
 * Takes the badge away and stops asking. Signing out has to clear it: a count
 * left on the Dock is one account's homework advertised to the next person to
 * use the Mac.
 */
export function stopBadge() {
  clearInterval(timer);
  timer = null;
  shown = 0;
  setDockBadge(0);
  setNextLesson('');
}
