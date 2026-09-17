/**
 * Notifications: what is worth saying, and when.
 *
 * The three switches in Settings had nowhere to go — the account stored them
 * and nothing ever read them. This is what reads them.
 *
 * The deciding happens here rather than in the shell or on the server because
 * this is the side holding the session, and therefore the only side that knows
 * how many cards are due or when the next exam is. The shell only delivers,
 * and the server has no push channel to a Mac sitting behind a router. The
 * app closes when its last window does, so "while the app is open" is the
 * honest limit of what any of this can promise, and the copy in Settings says
 * so.
 */
import { api } from './api.js';
import { state } from './store.js';
import { isNative, notificationAccess, postNotification } from './native.js';
import { log } from './log.js';

const MINUTE = 60_000;

/** Often enough to catch a day turning over or an exam crossing a threshold. */
const CHECK_MS = 5 * MINUTE;

/** How long a "cards are due" nudge stands before another may be sent. */
const DUE_QUIET_MS = 4 * 60 * MINUTE;

/**
 * The countdowns worth interrupting somebody for. A week out is planning, the
 * day before is packing, the morning of is a reminder. Anything more than this
 * is nagging about a date they already know.
 */
const EXAM_DAYS = [7, 3, 1, 0];

/** Not before this hour, local time. A summary at 04:00 helps nobody. */
const SUMMARY_HOUR = 7;

/* ── what has already been said ───────────────────────────────────────── */

/**
 * Kept per account and on this device: what has been sent is a property of
 * the Mac that sent it, and syncing it would only mean one machine's morning
 * summary silencing another's.
 */
let memory = {};
let memoryKey = null;

function useMemory(userId) {
  const key = `studex.notify.${userId}`;
  if (key === memoryKey) return;
  memoryKey = key;
  try {
    memory = JSON.parse(localStorage.getItem(key) ?? '{}');
  } catch {
    memory = {};
  }
}

function remember(key, value) {
  memory[key] = value;
  try {
    localStorage.setItem(memoryKey, JSON.stringify(memory));
  } catch {
    /* Storage is full or disabled; the worst case is saying something twice. */
  }
}

/** Local, not UTC: "today" has to mean the user's day, not Greenwich's. */
function today(now = new Date()) {
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}

/**
 * Whether the user is looking at Studex right now. Nothing is worth a banner
 * over the window that already shows it — the sidebar's due count is on
 * screen, and covering it with a notification saying the same number is noise.
 */
function watching() {
  return document.visibilityState === 'visible' && document.hasFocus();
}

/* ── the three kinds ──────────────────────────────────────────────────── */

function dueCards(review, now) {
  const waiting = review?.remaining ?? 0;
  if (waiting <= 0 || watching()) return false;
  if (now - (memory.due_at ?? 0) < DUE_QUIET_MS) return false;

  remember('due_at', now);
  postNotification({
    id: 'studex.due',
    title: waiting === 1 ? '1 card is due' : `${waiting} cards are due`,
    body: review.streak_days > 1
      ? `Keep your ${review.streak_days}-day streak going.`
      : 'A few minutes now keeps the queue from piling up.',
  });
  return true;
}

function examReminders(events, now) {
  for (const event of events ?? []) {
    // Past the threshold list is either too far off to mention or, at a
    // negative countdown, already behind them.
    const days = event.days_until;
    const mark = EXAM_DAYS.find((d) => days <= d);
    if (mark === undefined || days < 0) continue;

    const key = `event.${event.id}.${mark}`;
    if (memory[key]) continue;
    remember(key, now);

    const kind = event.kind === 'exam' ? 'Exam' : 'Deadline';
    const away = days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
    postNotification({
      id: `studex.event.${event.id}`,
      title: `${kind} ${away}`,
      body: event.location ? `${event.title} — ${event.location}` : event.title,
    });
  }
}

function dailySummary(review, events, week, now) {
  const day = today(new Date(now));
  if (memory.summary_day === day) return false;
  if (new Date(now).getHours() < SUMMARY_HOUR) return false;

  remember('summary_day', day);

  const waiting = review?.remaining ?? 0;
  const cards = waiting === 0
    ? 'Nothing due today.'
    : waiting === 1 ? '1 card to review today.' : `${waiting} cards to review today.`;
  const next = (events ?? [])[0];
  const soon = next
    ? next.days_until <= 0
      ? ` ${next.title} is today.`
      : next.days_until === 1 ? ` ${next.title} is tomorrow.` : ` ${next.title} in ${next.days_until} days.`
    : '';

  const goal = week?.goal_minutes
    ? week.met
      ? ' Weekly goal met.'
      : ` ${Math.round((week.minutes / 60) * 10) / 10}h of ${Math.round((week.goal_minutes / 60) * 10) / 10}h this week.`
    : '';

  postNotification({ id: 'studex.summary', title: 'Today in Studex', body: cards + soon + goal });
  return true;
}

/* ── the loop ─────────────────────────────────────────────────────────── */

async function pass() {
  if (!state.user || !state.ready) return;

  const prefs = state.settings?.notifications ?? {};
  const wanted = Boolean(prefs.due_cards || prefs.exam_reminders || prefs.daily_summary);
  if (!wanted || !isNative) return;
  if ((await notificationAccess()) !== 'granted') return;

  useMemory(state.user.id);
  const now = Date.now();

  // Both remaining kinds read from the same two endpoints, so they are
  // fetched once and only when something actually wants them.
  const needsReview = prefs.due_cards || prefs.daily_summary;
  const needsEvents = prefs.exam_reminders || prefs.daily_summary;

  const [review, events, week] = await Promise.all([
    needsReview ? api.studyToday().then((r) => r.today) : null,
    needsEvents ? api.upcoming(10).then((r) => r.events) : null,
    prefs.daily_summary ? api.home().then((r) => r.week ?? r.home?.week ?? null).catch(() => null) : null,
  ]);

  // The summary already carries the day's count, so a nudge about the same
  // cards in the same minute would just be the summary again, shorter.
  const summarised = prefs.daily_summary ? dailySummary(review, events, week, now) : false;
  if (prefs.due_cards && !summarised) dueCards(review, now);
  if (prefs.exam_reminders) examReminders(events, now);
}

let timer = null;

/**
 * Starts the loop, once, after sign-in. The first pass is deferred rather than
 * immediate so it does not compete with the screen the user is waiting for.
 */
export function startNotifications() {
  if (timer || !isNative) return;
  const tick = () => { pass().catch((err) => log.warn('notification check failed', err)); };
  timer = setInterval(tick, CHECK_MS);
  setTimeout(tick, 20_000);
}
