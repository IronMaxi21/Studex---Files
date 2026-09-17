import { getDb } from '../lib/db.js';
import { waitingNow, inLiveDeck } from './due.js';
import { DAY_MS, dayKey, daysUntil, recentDayKeys } from '../lib/time.js';

export function timezoneFor(userId: string): string {
  const row = getDb()
    .prepare<[string], { timezone: string }>('SELECT timezone FROM user_settings WHERE user_id = ?')
    .get(userId);
  return row?.timezone ?? 'UTC';
}

/* -------------------------------- streaks --------------------------------- */

/**
 * A day counts toward the streak if the student either reviewed a card or
 * logged study time. The streak is allowed to include today or, if today has
 * no activity yet, to end yesterday — otherwise an 18-day streak would read as
 * zero every morning.
 */
/** How far back a streak is looked for. Longer than any streak worth naming. */
const STREAK_WINDOW_DAYS = 400;

/** The local days this account did something on, as a set of day keys. */
function activeDays(userId: string, now: number, tz: string): Set<string> {
  const since = now - STREAK_WINDOW_DAYS * DAY_MS;
  const active = new Set<string>();
  for (const row of getDb()
    .prepare<[string, number], { at: number }>(
      'SELECT reviewed_at AS at FROM review_logs WHERE user_id = ? AND reviewed_at >= ?',
    )
    .all(userId, since)) {
    active.add(dayKey(row.at, tz));
  }
  for (const row of getDb()
    .prepare<[string, number], { at: number }>(
      `SELECT started_at AS at FROM study_sessions
       WHERE user_id = ? AND started_at >= ? AND elapsed_seconds > 0`,
    )
    .all(userId, since)) {
    active.add(dayKey(row.at, tz));
  }
  return active;
}

/** Day keys are local YYYY-MM-DD strings; stepping them in UTC keeps them local. */
function keyAdd(key: string, days: number): string {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The Monday that starts the week a day key falls in. */
export function weekStartKey(key: string): string {
  const dow = new Date(`${key}T00:00:00Z`).getUTCDay();
  return keyAdd(key, -((dow + 6) % 7));
}

/** Seven straight active days earn one freeze; no more than this many are banked. */
export const FREEZE_EVERY_DAYS = 7;
export const MAX_FREEZES = 2;

function freezeEnabled(userId: string): boolean {
  const row = getDb()
    .prepare<[string], { streak_freeze: number }>('SELECT streak_freeze FROM user_settings WHERE user_id = ?')
    .get(userId);
  return (row?.streak_freeze ?? 1) === 1;
}

export interface StreakState {
  current: number;
  best: number;
  freezes: number;
  frozen: string[];
}

/**
 * The streak, walked forward through the history.
 *
 * Every seven active days in a row bank a freeze (up to two). A missed day
 * inside a live streak spends one and the streak carries on — the day is not
 * counted, but a month of work is not erased by one bad Tuesday either. With no
 * freeze in the bank the run ends and the bank empties with it. Today is never
 * a miss: a streak may end yesterday while today is still to play for.
 */
export function streakState(userId: string, now = Date.now()): StreakState {
  const tz = timezoneFor(userId);
  const active = activeDays(userId, now, tz);
  const freezeOn = freezeEnabled(userId);
  const today = dayKey(now, tz);

  let run = 0;
  let best = 0;
  let freezes = 0;
  let sinceEarned = 0;
  let runFrozen: string[] = [];
  let key = keyAdd(today, -STREAK_WINDOW_DAYS);
  for (let i = 0; i <= STREAK_WINDOW_DAYS; i += 1, key = keyAdd(key, 1)) {
    if (active.has(key)) {
      run += 1;
      best = Math.max(best, run);
      sinceEarned += 1;
      if (sinceEarned >= FREEZE_EVERY_DAYS) {
        sinceEarned = 0;
        if (freezeOn) freezes = Math.min(MAX_FREEZES, freezes + 1);
      }
    } else if (key === today) {
      // Not yet a miss.
    } else if (run > 0 && freezes > 0) {
      freezes -= 1;
      runFrozen.push(key);
    } else {
      run = 0;
      freezes = 0;
      sinceEarned = 0;
      runFrozen = [];
    }
  }
  return { current: run, best, freezes, frozen: runFrozen };
}

/**
 * The longest run of consecutive active days inside the window, freezes
 * included. The current streak alone has nothing to say on the day it breaks;
 * this is the number that survives, and it is what makes the count worth
 * keeping rather than something to be afraid of losing.
 */
export function longestStreak(userId: string, now = Date.now()): number {
  return streakState(userId, now).best;
}

export function studyStreak(userId: string, now = Date.now()): number {
  return streakState(userId, now).current;
}

/* ------------------------------ habit loop -------------------------------- */

function weeklyGoalMinutes(userId: string): number {
  const row = getDb()
    .prepare<[string], { weekly_goal_minutes: number }>('SELECT weekly_goal_minutes FROM user_settings WHERE user_id = ?')
    .get(userId);
  return row?.weekly_goal_minutes ?? 0;
}

/** Study minutes and reviews per local day since an instant. */
function dailyActivity(userId: string, since: number, tz: string) {
  const days = new Map<string, { seconds: number; reviews: number }>();
  const at = (key: string) => {
    if (!days.has(key)) days.set(key, { seconds: 0, reviews: 0 });
    return days.get(key)!;
  };
  for (const row of getDb()
    .prepare<[string, number], { started_at: number; elapsed_seconds: number }>(
      'SELECT started_at, elapsed_seconds FROM study_sessions WHERE user_id = ? AND started_at >= ?',
    )
    .all(userId, since)) {
    at(dayKey(row.started_at, tz)).seconds += row.elapsed_seconds;
  }
  for (const row of getDb()
    .prepare<[string, number], { reviewed_at: number }>(
      'SELECT reviewed_at FROM review_logs WHERE user_id = ? AND reviewed_at >= ?',
    )
    .all(userId, since)) {
    at(dayKey(row.reviewed_at, tz)).reviews += 1;
  }
  return days;
}

/** This week against the weekly goal. The week starts on Monday, in the student's zone. */
export function weekProgress(userId: string, now = Date.now()) {
  const tz = timezoneFor(userId);
  const start = weekStartKey(dayKey(now, tz));
  const activity = dailyActivity(userId, now - 8 * DAY_MS, tz);
  let seconds = 0;
  let activeCount = 0;
  for (let i = 0; i < 7; i += 1) {
    const day = activity.get(keyAdd(start, i));
    if (!day) continue;
    seconds += day.seconds;
    if (day.seconds > 0 || day.reviews > 0) activeCount += 1;
  }
  const goal = weeklyGoalMinutes(userId);
  const minutes = Math.round(seconds / 60);
  return {
    week_start: start,
    goal_minutes: goal,
    minutes,
    active_days: activeCount,
    pct: goal ? Math.min(100, Math.round((minutes / goal) * 100)) : null,
    met: goal > 0 && minutes >= goal,
  };
}

/**
 * The term at a glance: every day of the last `weeks` weeks (ending with this
 * one), and each week's total against the goal as it stands now. Frozen days
 * in the live streak are marked so the grid shows why the count survived.
 */
export function termProgress(userId: string, weeks: number, now = Date.now()) {
  const tz = timezoneFor(userId);
  const thisWeek = weekStartKey(dayKey(now, tz));
  const first = keyAdd(thisWeek, -(weeks - 1) * 7);
  const activity = dailyActivity(userId, now - (weeks * 7 + 1) * DAY_MS, tz);
  const frozen = new Set(streakState(userId, now).frozen);
  const goal = weeklyGoalMinutes(userId);
  const today = dayKey(now, tz);

  const days: { day: string; minutes: number; reviews: number; frozen: boolean; future: boolean }[] = [];
  const weekRows: { week_start: string; minutes: number; reviews: number; active_days: number; met: boolean }[] = [];
  for (let w = 0; w < weeks; w += 1) {
    const start = keyAdd(first, w * 7);
    const row = { week_start: start, minutes: 0, reviews: 0, active_days: 0, met: false };
    for (let d = 0; d < 7; d += 1) {
      const key = keyAdd(start, d);
      const a = activity.get(key);
      const minutes = Math.round((a?.seconds ?? 0) / 60);
      const reviews = a?.reviews ?? 0;
      days.push({ day: key, minutes, reviews, frozen: frozen.has(key), future: key > today });
      row.minutes += minutes;
      row.reviews += reviews;
      if (minutes > 0 || reviews > 0) row.active_days += 1;
    }
    row.met = goal > 0 && row.minutes >= goal;
    weekRows.push(row);
  }
  const streak = streakState(userId, now);
  return {
    goal_minutes: goal,
    weeks: weekRows,
    days,
    weeks_met: weekRows.filter((r) => r.met).length,
    streak_days: streak.current,
    best_streak_days: streak.best,
    freezes: streak.freezes,
  };
}

/* --------------------------------- hours ---------------------------------- */

/** Study seconds per local day over the requested window. */
export function hoursSeries(userId: string, days: number, now = Date.now()) {
  const tz = timezoneFor(userId);
  const keys = recentDayKeys(days, tz, now);
  const totals = new Map(keys.map((k) => [k, 0]));

  const rows = getDb()
    .prepare<[string, number], { started_at: number; elapsed_seconds: number }>(
      `SELECT started_at, elapsed_seconds FROM study_sessions
       WHERE user_id = ? AND started_at >= ?`,
    )
    .all(userId, now - days * DAY_MS);

  for (const row of rows) {
    const key = dayKey(row.started_at, tz);
    if (totals.has(key)) totals.set(key, totals.get(key)! + row.elapsed_seconds);
  }

  return keys.map((key) => ({
    day: key,
    seconds: totals.get(key) ?? 0,
    hours: Number(((totals.get(key) ?? 0) / 3600).toFixed(2)),
  }));
}

export function hoursInWindow(userId: string, sinceMs: number, now = Date.now()): number {
  const row = getDb()
    .prepare<[string, number], { total: number | null }>(
      `SELECT SUM(elapsed_seconds) AS total FROM study_sessions
       WHERE user_id = ? AND started_at >= ?`,
    )
    .get(userId, now - sinceMs);
  return Number(((row?.total ?? 0) / 3600).toFixed(2));
}

/**
 * Where the hours went: study time in the window per subject. A session with
 * no subject of its own is credited through the calendar block or the file it
 * was started from; what is left over is reported as unassigned rather than
 * dropped, so the bars add up to the total.
 */
export function hoursBySubject(userId: string, days: number, now = Date.now()) {
  const rows = getDb()
    .prepare<[string, number], { subject_id: string | null; seconds: number; goals: number; met: number }>(
      `SELECT COALESCE(ss.subject_id, e.subject_id, fo.subject_id) AS subject_id,
              SUM(ss.elapsed_seconds) AS seconds,
              SUM(CASE WHEN ss.goal IS NOT NULL THEN 1 ELSE 0 END) AS goals,
              SUM(CASE WHEN ss.goal_met = 1 THEN 1 ELSE 0 END) AS met
       FROM study_sessions ss
       LEFT JOIN events e ON e.id = ss.event_id
       LEFT JOIN files f ON f.id = ss.file_id
       LEFT JOIN folders fo ON fo.id = f.folder_id
       WHERE ss.user_id = ? AND ss.started_at >= ?
       GROUP BY 1`,
    )
    .all(userId, now - days * DAY_MS);
  const subjects = new Map(
    getDb()
      .prepare<[string], { id: string; name: string; color: string }>(
        'SELECT id, name, color FROM subjects WHERE user_id = ?',
      )
      .all(userId)
      .map((s) => [s.id, s]),
  );
  return rows
    .filter((r) => r.seconds > 0)
    .map((r) => {
      const subject = r.subject_id ? subjects.get(r.subject_id) : undefined;
      return {
        subject_id: subject ? subject.id : null,
        name: subject?.name ?? 'No subject',
        color: subject?.color ?? 'neutral',
        hours: Number((r.seconds / 3600).toFixed(2)),
        goals: r.goals,
        goals_met: r.met,
      };
    })
    .sort((a, b) => b.hours - a.hours);
}

/* --------------------------------- recall --------------------------------- */

/** Share of reviews graded Good or Easy in the window. */
export function recallRate(userId: string, windowMs: number, now = Date.now()): number {
  const row = getDb()
    .prepare<[string, number], { total: number; good: number }>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN rating >= 3 THEN 1 ELSE 0 END) AS good
       FROM review_logs WHERE user_id = ? AND reviewed_at >= ?`,
    )
    .get(userId, now - windowMs)!;
  if (!row.total) return 0;
  return Math.round((row.good / row.total) * 100);
}

export function dueCount(userId: string, now = Date.now()): number {
  const row = getDb()
    .prepare<[string, number], { n: number }>(
      `SELECT COUNT(*) AS n FROM cards WHERE user_id = ? AND ${inLiveDeck()} AND ${waitingNow()}`,
    )
    .get(userId, now)!;
  return row.n;
}

/* -------------------------------- mastery --------------------------------- */

/**
 * Mastery per subject, from the scheduling state of every card whose deck sits
 * in a folder belonging to that subject. A card counts as fully mastered once
 * its interval reaches MASTERY_INTERVAL_DAYS, and partially before that, so the
 * figure rises smoothly rather than flipping at a threshold.
 */
const MASTERY_INTERVAL_DAYS = 21;

export function masteryBySubject(userId: string) {
  const rows = getDb()
    .prepare<[string], { subject_id: string; name: string; color: string; interval_days: number; state: string }>(
      `SELECT s.id AS subject_id, s.name, s.color, c.interval_days, c.state
       FROM subjects s
       JOIN folders fo ON fo.subject_id = s.id AND fo.user_id = s.user_id
       JOIN files fi ON fi.folder_id = fo.id AND fi.user_id = s.user_id AND fi.trashed_at IS NULL
       JOIN cards c ON c.deck_id = fi.id AND c.user_id = s.user_id
       WHERE s.user_id = ?`,
    )
    .all(userId);

  const bySubject = new Map<string, { name: string; color: string; total: number; sum: number }>();

  // Every subject appears, including those with no cards yet.
  for (const s of getDb()
    .prepare<[string], { id: string; name: string; color: string }>(
      'SELECT id, name, color FROM subjects WHERE user_id = ? ORDER BY position, name',
    )
    .all(userId)) {
    bySubject.set(s.id, { name: s.name, color: s.color, total: 0, sum: 0 });
  }

  for (const row of rows) {
    const entry = bySubject.get(row.subject_id);
    if (!entry) continue;
    const strength =
      row.state === 'new' ? 0 : Math.min(row.interval_days / MASTERY_INTERVAL_DAYS, 1);
    entry.total += 1;
    entry.sum += strength;
  }

  return [...bySubject.entries()].map(([subjectId, e]) => ({
    subject_id: subjectId,
    name: e.name,
    color: e.color,
    card_count: e.total,
    mastery_pct: e.total ? Math.round((e.sum / e.total) * 100) : 0,
  }));
}

/* ----------------------------- exam readiness ----------------------------- */

export type Readiness = 'ready' | 'on_track' | 'behind';

/**
 * Compares mastery against how close the exam is. A subject needs to be
 * further along the closer the paper gets, so the same 70% reads as "on track"
 * a month out and "behind" the week before.
 */
export function readinessFor(masteryPct: number, days: number): Readiness {
  const required = days <= 3 ? 85 : days <= 7 ? 75 : days <= 21 ? 60 : 40;
  if (masteryPct >= required + 10) return 'ready';
  if (masteryPct >= required) return 'on_track';
  return 'behind';
}

export function examReadiness(userId: string, now = Date.now()) {
  const mastery = new Map(masteryBySubject(userId).map((m) => [m.subject_id, m]));

  return getDb()
    .prepare<[string, number], {
      id: string;
      title: string;
      starts_at: number;
      subject_id: string | null;
      status: string | null;
    }>(
      `SELECT id, title, starts_at, subject_id, status FROM events
       WHERE user_id = ? AND kind IN ('exam','deadline') AND starts_at >= ?
       ORDER BY starts_at ASC LIMIT 20`,
    )
    .all(userId, now)
    .map((e) => {
      const days = daysUntil(e.starts_at, now);
      const subjectMastery = e.subject_id ? mastery.get(e.subject_id)?.mastery_pct ?? 0 : 0;
      return {
        event_id: e.id,
        title: e.title,
        starts_at: e.starts_at,
        days_until: days,
        subject_id: e.subject_id,
        mastery_pct: subjectMastery,
        // A status set by hand on the event wins over the computed one.
        readiness: (e.status as Readiness | null) ?? readinessFor(subjectMastery, days),
      };
    });
}

/* -------------------------------- overview -------------------------------- */

/* ------------------------------- needs work ------------------------------- */

/**
 * The one place a student's weak spots are gathered: the topics they rate
 * themselves worst on, the cards they lapse on most, and the subjects running
 * behind their exams. Each already lives somewhere — the topic matrix, the card
 * rows, exam readiness — but scattered across screens, so none of it is ever
 * acted on together. Here they sit side by side, each with what a button needs
 * to start a session on exactly those items.
 */
export function needsWork(userId: string, now = Date.now()) {
  // Weak topics: rated, and rated low. An unrated topic (confidence 0) is
  // unknown, not weak, so it belongs on the matrix's due list, not here.
  const weakTopics = getDb()
    .prepare<[string], {
      id: string;
      name: string;
      unit: string | null;
      subject_id: string | null;
      confidence: number;
    }>(
      `SELECT id, name, unit, subject_id, confidence FROM topics
       WHERE user_id = ? AND confidence BETWEEN 1 AND 2
       ORDER BY confidence ASC, next_due_at IS NULL DESC, next_due_at ASC
       LIMIT 8`,
    )
    .all(userId);

  // The cards this student lapses on most, with the deck they live in so the
  // list reads as more than a row of anonymous fronts.
  const lapseCards = getDb()
    .prepare<[string], {
      id: string;
      deck_id: string;
      deck_title: string;
      front: string;
      lapses: number;
    }>(
      `SELECT c.id, c.deck_id, f.title AS deck_title, c.front, c.lapses
         FROM cards c JOIN files f ON f.id = c.deck_id
        WHERE c.user_id = ? AND c.suspended = 0 AND c.lapses > 0
          AND f.trashed_at IS NULL
        ORDER BY c.lapses DESC, c.due_at ASC
        LIMIT 8`,
    )
    .all(userId);

  const lapseTotal = getDb()
    .prepare<[string], { n: number }>(
      `SELECT COUNT(*) AS n FROM cards c JOIN files f ON f.id = c.deck_id
        WHERE c.user_id = ? AND c.suspended = 0 AND c.lapses > 0 AND f.trashed_at IS NULL`,
    )
    .get(userId)!;

  // Subjects whose mastery has fallen behind where the nearest exam needs it.
  const behind = examReadiness(userId, now).filter((e) => e.readiness === 'behind');

  return {
    weak_topics: weakTopics,
    lapse_cards: lapseCards,
    lapse_total: lapseTotal.n ?? 0,
    behind_subjects: behind,
  };
}

export function overview(userId: string, now = Date.now()) {
  const streak = streakState(userId, now);
  return {
    streak_days: streak.current,
    best_streak_days: streak.best,
    streak_freezes: streak.freezes,
    week: weekProgress(userId, now),
    hours_this_week: hoursInWindow(userId, 7 * DAY_MS, now),
    hours_last_30_days: hoursInWindow(userId, 30 * DAY_MS, now),
    recall_pct: recallRate(userId, 30 * DAY_MS, now),
    cards_due: dueCount(userId, now),
    mastery: masteryBySubject(userId),
    exam_readiness: examReadiness(userId, now),
    hours_series: hoursSeries(userId, 30, now),
  };
}
