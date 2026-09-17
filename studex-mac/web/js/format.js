/** Date, number and label formatting shared across the screens. */

const DAY = 24 * 60 * 60 * 1000;

export const FILE_ICON = { canvas: 'infinity', doc: 'file-text', pdf: 'file-pdf', deck: 'cards' };
export const FILE_LABEL = { canvas: 'Canvas', doc: 'Doc', pdf: 'PDF', deck: 'Deck' };
/* `lesson` and `revision` are not kinds the server stores: they are the
   repeating timetable and the topic matrix drawn on the same calendar as
   everything else, and they need a glyph like the rest of it. */
export const EVENT_ICON = {
  exam: 'exam', deadline: 'flag', study_block: 'clock-countdown',
  class: 'chalkboard-teacher', personal: 'user', event: 'calendar-dot',
  lesson: 'chalkboard-teacher', revision: 'target',
};

/** "1 card", "3 cards" — counts appear all over the study screens. */
export function plural(count, singular, many = `${singular}s`) {
  return `${count} ${count === 1 ? singular : many}`;
}

export function greeting(now = new Date()) {
  const h = now.getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

/** "2m ago", "1h ago", "3d ago" — the design's Continue-card meta line. */
export function relative(ts, now = Date.now()) {
  const diff = Math.max(0, now - ts);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** "Fri 23 May · 09:00" */
export function eventWhen(ts, allDay = false) {
  const d = new Date(ts);
  const date = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  if (allDay) return date;
  return `${date} · ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}`;
}

/** "23 MAY" — the deadline-row date column. */
export function shortDate(ts) {
  const d = new Date(ts);
  return `${d.getDate().toString().padStart(2, '0')} ${d.toLocaleDateString(undefined, { month: 'short' }).toUpperCase()}`;
}

export function clockTime(ts) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Seconds → "17:42", used by the focus dial. */
export function mmss(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;
}

/** "2h 15m" */
export function duration(minutes) {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m`;
}

export function countdown(days) {
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `${days} days`;
}

export function bytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

export function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function addDays(ts, n) { return ts + n * DAY; }
