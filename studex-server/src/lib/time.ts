export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Formats an instant as a YYYY-MM-DD key in the given IANA zone.
 * Streaks and daily buckets are computed in the student's own timezone, so a
 * session at 23:30 counts for the day it felt like, not the UTC day.
 */
export function dayKey(epochMs: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(epochMs));
  } catch {
    // An unknown zone must not break statistics; fall back to UTC.
    return new Date(epochMs).toISOString().slice(0, 10);
  }
}

/** The sequence of day keys ending today, most recent last. */
export function recentDayKeys(days: number, timeZone: string, now = Date.now()): string[] {
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) keys.push(dayKey(now - i * DAY_MS, timeZone));
  return keys;
}

/** Whole days from now until an instant, rounded up; negative once past. */
export function daysUntil(target: number, now = Date.now()): number {
  return Math.ceil((target - now) / DAY_MS);
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
