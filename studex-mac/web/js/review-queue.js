/**
 * Reviews that survive going offline.
 *
 * A card already answered is the one study action that must never be lost to a
 * dropped connection — the student did the retrieval, and the schedule should
 * reflect it. The local server is usually the thing that vanished (a restart, a
 * migration, a crash between relaunches), so a review that fails at the
 * transport is kept on this device and replayed, oldest first, the moment the
 * server answers again. A transport failure means the request never landed, so
 * replaying it once is the right thing rather than a double-count.
 *
 * Order matters: FSRS schedules each review against the card's memory state as
 * the previous one left it, so a backlog must go up in the order it was
 * answered. Once anything is queued, later reviews queue behind it rather than
 * racing ahead live.
 */
import { api, isReachable, onReachabilityChange } from './api.js';
import { log } from './log.js';

const KEY = 'studex.review-queue';

const listeners = new Set();
let queue = load();
let flushing = false;

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]') ?? []; }
  catch { return []; }
}
function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(queue)); } catch { /* this device only */ }
  emit();
}
function emit() {
  for (const fn of listeners) { try { fn(queue.length); } catch { /* a listener's problem */ } }
}

/** How many answered reviews are waiting to reach the server. */
export function pendingReviews() { return queue.length; }
/** Notified with the pending count whenever it changes. Returns an unsubscribe. */
export function onPendingChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function makeItem(cardId, { rating, durationMs, mode }) {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    cardId, rating, durationMs, mode, at: Date.now(),
  };
}

/**
 * Submit a review, offline-safe.
 *
 * Returns the server's scheduling result when the call went through, or `null`
 * when the review was kept on this device for later. Throws only on a real
 * rejection (a deleted card, a validation error) — never on being offline, so a
 * study loop can advance to the next card either way.
 */
export async function submitReview(cardId, { rating, durationMs, mode } = {}) {
  const item = makeItem(cardId, { rating, durationMs, mode });
  // Already offline, or a backlog is waiting: queue behind it to keep order.
  if (!isReachable() || queue.length) {
    queue.push(item);
    persist();
    void flush();
    return null;
  }
  try {
    return await api.review(cardId, rating, durationMs, mode);
  } catch (err) {
    if (err?.status === 0) { queue.push(item); persist(); return null; }
    throw err;
  }
}

/** Replay queued reviews oldest-first, stopping at the first transport failure. */
export async function flush() {
  if (flushing || !queue.length || !isReachable()) return;
  flushing = true;
  try {
    while (queue.length) {
      const item = queue[0];
      try {
        await api.review(item.cardId, item.rating, item.durationMs, item.mode);
      } catch (err) {
        // Still offline — leave the backlog intact and try again on reconnect.
        if (err?.status === 0) break;
        // A real rejection can never succeed on a retry (the card was deleted,
        // say), so drop it rather than wedge the queue behind it for ever.
        log.warn?.('review-queue: dropped a review the server refused', err?.code);
      }
      queue.shift();
      persist();
    }
  } finally {
    flushing = false;
  }
}

onReachabilityChange((up) => { if (up) void flush(); });
// A backlog left by a previous session goes up as soon as the app starts.
if (queue.length) void flush();
