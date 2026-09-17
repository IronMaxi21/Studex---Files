import { z } from 'zod';
import { getDb, tx } from '../lib/db.js';
import { newId } from '../lib/ids.js';
import { notFound } from '../lib/errors.js';
import { DAY_MS } from '../lib/time.js';
import { colorToken, epochMs, text } from '../lib/validation.js';
import { requireSubject } from './library.js';
import { getAccountSettings } from './settings.js';

/** 'HH:MM', the way a printed timetable writes a time. */
const clock = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'Times are written HH:MM');

export const weekLabel = z.enum(['A', 'B']);

/**
 * A school day, when nobody has said otherwise.
 *
 * Six teaching periods either side of a lunch hour is the commonest English
 * secondary shape, and every school that does something else can rewrite the
 * rows. It matters only that the grid is not empty the first time it is opened:
 * an empty grid asks the student to invent the structure before they can write
 * down a single lesson, and they already know what their day looks like.
 */
export const DEFAULT_PERIODS = [
  { idx: 0, label: 'Registration', starts_at: '08:40', ends_at: '09:00' },
  { idx: 1, label: 'Period 1', starts_at: '09:00', ends_at: '10:00' },
  { idx: 2, label: 'Period 2', starts_at: '10:00', ends_at: '11:00' },
  { idx: 3, label: 'Break', starts_at: '11:00', ends_at: '11:20' },
  { idx: 4, label: 'Period 3', starts_at: '11:20', ends_at: '12:20' },
  { idx: 5, label: 'Period 4', starts_at: '12:20', ends_at: '13:20' },
  { idx: 6, label: 'Lunch', starts_at: '13:20', ends_at: '14:10' },
  { idx: 7, label: 'Period 5', starts_at: '14:10', ends_at: '15:10' },
  { idx: 8, label: 'Period 6', starts_at: '15:10', ends_at: '16:10' },
] as const;

export interface PeriodRow {
  user_id: string;
  idx: number;
  label: string;
  starts_at: string;
  ends_at: string;
}

export interface LessonRow {
  id: string;
  user_id: string;
  week: 'A' | 'B';
  day: number;
  period: number;
  subject: string;
  subject_id: string | null;
  room: string | null;
  teacher: string | null;
  color: string | null;
  created_at: number;
  updated_at: number;
}

export const periodsSchema = z.object({
  periods: z
    .array(
      z.object({
        label: text(40),
        startsAt: clock,
        endsAt: clock,
      }),
    )
    .min(1)
    .max(20),
});

export const lessonSchema = z.object({
  week: weekLabel,
  day: z.number().int().min(0).max(6),
  period: z.number().int().min(0).max(19),
  subject: text(80),
  subjectId: z.string().uuid().nullish(),
  room: text(40).nullish(),
  teacher: text(60).nullish(),
  color: colorToken.nullish(),
});

export const anchorSchema = z.object({ weekAStart: epochMs.nullable() });

/** The Monday of the week a moment falls in, in the server's local zone. */
export function mondayOf(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

/**
 * Whether a given week is an A week or a B week.
 *
 * Counted in whole weeks from the anchor Monday and taken modulo two, with the
 * remainder forced positive so that weeks before the anchor alternate correctly
 * — looking back at last term should not put every week in week A.
 */
export function weekOf(anchor: number | null, ts: number): 'A' | 'B' {
  if (anchor === null) return 'A';
  const weeks = Math.round((mondayOf(ts) - mondayOf(anchor)) / (7 * DAY_MS));
  return (((weeks % 2) + 2) % 2) === 0 ? 'A' : 'B';
}

export function getWeekAnchor(userId: string): number | null {
  const settings = getAccountSettings(userId) as { week_a_start?: number | null };
  return settings.week_a_start ?? null;
}

export function setWeekAnchor(userId: string, weekAStart: number | null): number | null {
  getAccountSettings(userId); // ensures the row exists
  getDb()
    .prepare('UPDATE user_settings SET week_a_start = ?, updated_at = ? WHERE user_id = ?')
    .run(weekAStart === null ? null : mondayOf(weekAStart), Date.now(), userId);
  return getWeekAnchor(userId);
}

export function listPeriods(userId: string): PeriodRow[] {
  const rows = getDb()
    .prepare<[string], PeriodRow>('SELECT * FROM timetable_periods WHERE user_id = ? ORDER BY idx')
    .all(userId);
  if (rows.length) return rows;

  const insert = getDb().prepare(
    'INSERT INTO timetable_periods (user_id, idx, label, starts_at, ends_at) VALUES (?, ?, ?, ?, ?)',
  );
  tx(() => {
    for (const p of DEFAULT_PERIODS) insert.run(userId, p.idx, p.label, p.starts_at, p.ends_at);
  });
  return listPeriods(userId);
}

/**
 * Rewriting the day's shape.
 *
 * The rows are replaced wholesale and renumbered from zero, so the index a
 * lesson is filed under keeps meaning "the nth row of the grid". Lessons filed
 * under a row that no longer exists are deleted in the same transaction rather
 * than left pointing at nothing: a period that has been removed from the day is
 * a period whose lessons are not happening.
 */
export function setPeriods(userId: string, input: z.infer<typeof periodsSchema>): PeriodRow[] {
  const db = getDb();
  tx(() => {
    db.prepare('DELETE FROM timetable_periods WHERE user_id = ?').run(userId);
    const insert = db.prepare(
      'INSERT INTO timetable_periods (user_id, idx, label, starts_at, ends_at) VALUES (?, ?, ?, ?, ?)',
    );
    input.periods.forEach((p, idx) => insert.run(userId, idx, p.label, p.startsAt, p.endsAt));
    db.prepare('DELETE FROM lessons WHERE user_id = ? AND period >= ?').run(userId, input.periods.length);
  });
  return listPeriods(userId);
}

export function listLessons(userId: string, week?: 'A' | 'B'): LessonRow[] {
  const where = week ? 'user_id = ? AND week = ?' : 'user_id = ?';
  const params = week ? [userId, week] : [userId];
  return getDb()
    .prepare<unknown[], LessonRow>(
      `SELECT * FROM lessons WHERE ${where} ORDER BY week, day, period`,
    )
    .all(...params);
}

export function requireLesson(userId: string, lessonId: string): LessonRow {
  const row = getDb()
    .prepare<[string, string], LessonRow>('SELECT * FROM lessons WHERE id = ? AND user_id = ?')
    .get(lessonId, userId);
  if (!row) throw notFound('Lesson not found');
  return row;
}

/**
 * Writing in a cell.
 *
 * An upsert rather than a create, because the grid addresses a lesson by where
 * it sits — week, day, period — and typing into a cell that already has a lesson
 * in it means changing that lesson, not adding a second one underneath.
 */
export function putLesson(userId: string, input: z.infer<typeof lessonSchema>): LessonRow {
  if (input.subjectId) requireSubject(userId, input.subjectId);
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO lessons
         (id, user_id, week, day, period, subject, subject_id, room, teacher, color, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, week, day, period) DO UPDATE SET
         subject = excluded.subject,
         subject_id = excluded.subject_id,
         room = excluded.room,
         teacher = excluded.teacher,
         color = excluded.color,
         updated_at = excluded.updated_at`,
    )
    .run(
      newId(),
      userId,
      input.week,
      input.day,
      input.period,
      input.subject,
      input.subjectId ?? null,
      input.room ?? null,
      input.teacher ?? null,
      input.color ?? null,
      now,
      now,
    );
  const row = getDb()
    .prepare<[string, string, number, number], LessonRow>(
      'SELECT * FROM lessons WHERE user_id = ? AND week = ? AND day = ? AND period = ?',
    )
    .get(userId, input.week, input.day, input.period);
  if (!row) throw notFound('Lesson not found');
  return row;
}

export function deleteLesson(userId: string, lessonId: string): void {
  requireLesson(userId, lessonId);
  getDb().prepare('DELETE FROM lessons WHERE id = ? AND user_id = ?').run(lessonId, userId);
}

/** Clears a whole week of the pattern, for starting one over. */
export function clearWeek(userId: string, week: 'A' | 'B'): number {
  return getDb().prepare('DELETE FROM lessons WHERE user_id = ? AND week = ?').run(userId, week).changes;
}

/** Copies one week of the pattern over the other, for a mostly-repeating fortnight. */
export function copyWeek(userId: string, from: 'A' | 'B'): LessonRow[] {
  const to = from === 'A' ? 'B' : 'A';
  const db = getDb();
  const now = Date.now();
  tx(() => {
    db.prepare('DELETE FROM lessons WHERE user_id = ? AND week = ?').run(userId, to);
    for (const lesson of listLessons(userId, from)) {
      db.prepare(
        `INSERT INTO lessons
           (id, user_id, week, day, period, subject, subject_id, room, teacher, color, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        newId(), userId, to, lesson.day, lesson.period, lesson.subject,
        lesson.subject_id, lesson.room, lesson.teacher, lesson.color,
        now, now,
      );
    }
  });
  return listLessons(userId, to);
}

export interface PlacedLesson extends LessonRow {
  starts_at: number;
  ends_at: number;
  label: string;
}

/**
 * The pattern laid over a real range of dates.
 *
 * This is how a repeating timetable reaches a calendar that only understands
 * dates. Nothing is written: each answer is worked out on the way out of the
 * door, so the fortnight is still a fortnight in the database and moving the
 * A/B anchor moves every lesson at once instead of needing a year of rows
 * rewritten. The range is capped at a term's worth of weeks so that a wide
 * `from`/`to` cannot ask the server to enumerate a decade.
 */
export function lessonsBetween(userId: string, from: number, to: number): PlacedLesson[] {
  const anchor = getWeekAnchor(userId);
  const periods = listPeriods(userId);
  const byIdx = new Map(periods.map((p) => [p.idx, p]));
  const lessons = listLessons(userId);
  if (!lessons.length) return [];

  const byWeek = new Map<string, LessonRow[]>();
  for (const lesson of lessons) {
    const key = `${lesson.week}:${lesson.day}`;
    const list = byWeek.get(key);
    if (list) list.push(lesson);
    else byWeek.set(key, [lesson]);
  }

  const out: PlacedLesson[] = [];
  const firstDay = new Date(from);
  firstDay.setHours(0, 0, 0, 0);
  for (let day = firstDay.getTime(), guard = 0; day <= to && guard < 120; guard += 1) {
    const date = new Date(day);
    const dow = (date.getDay() + 6) % 7; // Monday-first, to match the grid
    for (const lesson of byWeek.get(`${weekOf(anchor, day)}:${dow}`) ?? []) {
      const period = byIdx.get(lesson.period);
      if (!period) continue;
      out.push({
        ...lesson,
        label: period.label,
        starts_at: atClock(day, period.starts_at),
        ends_at: atClock(day, period.ends_at),
      });
    }
    date.setDate(date.getDate() + 1);
    day = date.getTime();
  }
  return out.sort((a, b) => a.starts_at - b.starts_at);
}

/** A wall-clock time on a given day, read in the server's local zone. */
function atClock(dayStart: number, hhmm: string): number {
  const [h, m] = hhmm.split(':');
  const d = new Date(dayStart);
  d.setHours(Number(h), Number(m), 0, 0);
  return d.getTime();
}
