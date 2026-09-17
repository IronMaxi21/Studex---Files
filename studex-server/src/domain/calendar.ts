import { z } from 'zod';
import { getDb } from '../lib/db.js';
import { newId } from '../lib/ids.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { daysUntil } from '../lib/time.js';
import { epochMs, text, uuid } from '../lib/validation.js';
import { requireFile, requireSubject } from './library.js';

export const eventKind = z.enum(['exam', 'deadline', 'study_block', 'class', 'event', 'personal']);
export const eventStatus = z.enum(['ready', 'on_track', 'behind', 'drafting', 'done']);

export const createEventSchema = z
  .object({
    kind: eventKind,
    title: text(200),
    subjectId: uuid.nullish(),
    fileId: uuid.nullish(),
    location: text(120).nullish(),
    startsAt: epochMs,
    endsAt: epochMs.nullish(),
    allDay: z.boolean().default(false),
    status: eventStatus.nullish(),
  })
  .refine((v) => v.endsAt == null || v.endsAt >= v.startsAt, {
    message: 'endsAt must not be before startsAt',
    path: ['endsAt'],
  });

export const updateEventSchema = z
  .object({
    // Re-filing rather than retyping: something entered as a class that turns
    // out to be a revision session is the same event with the wrong label on it.
    kind: eventKind.optional(),
    title: text(200).optional(),
    subjectId: uuid.nullable().optional(),
    fileId: uuid.nullable().optional(),
    location: text(120).nullable().optional(),
    startsAt: epochMs.optional(),
    endsAt: epochMs.nullable().optional(),
    allDay: z.boolean().optional(),
    status: eventStatus.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

export interface EventRow {
  id: string;
  user_id: string;
  subject_id: string | null;
  file_id: string | null;
  kind: z.infer<typeof eventKind>;
  title: string;
  location: string | null;
  starts_at: number;
  ends_at: number | null;
  all_day: number;
  status: z.infer<typeof eventStatus> | null;
  source: 'manual' | 'timetable_sync';
  created_at: number;
  updated_at: number;
}

export function requireEvent(userId: string, eventId: string): EventRow {
  const row = getDb()
    .prepare<[string, string], EventRow>('SELECT * FROM events WHERE id = ? AND user_id = ?')
    .get(eventId, userId);
  if (!row) throw notFound('Event not found');
  return row;
}

export function createEvent(userId: string, input: z.infer<typeof createEventSchema>): EventRow {
  if (input.subjectId) requireSubject(userId, input.subjectId);
  if (input.fileId) requireFile(userId, input.fileId);

  const now = Date.now();
  const id = newId();
  getDb()
    .prepare(
      `INSERT INTO events
         (id, user_id, subject_id, file_id, kind, title, location, starts_at, ends_at,
          all_day, status, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)`,
    )
    .run(
      id,
      userId,
      input.subjectId ?? null,
      input.fileId ?? null,
      input.kind,
      input.title,
      input.location ?? null,
      input.startsAt,
      input.endsAt ?? null,
      input.allDay ? 1 : 0,
      input.status ?? null,
      now,
      now,
    );
  return requireEvent(userId, id);
}

export function updateEvent(
  userId: string,
  eventId: string,
  patch: z.infer<typeof updateEventSchema>,
): EventRow {
  const existing = requireEvent(userId, eventId);
  if (patch.subjectId) requireSubject(userId, patch.subjectId);
  if (patch.fileId) requireFile(userId, patch.fileId);

  const startsAt = patch.startsAt ?? existing.starts_at;
  const endsAt = patch.endsAt !== undefined ? patch.endsAt : existing.ends_at;
  if (endsAt != null && endsAt < startsAt) {
    throw badRequest('endsAt must not be before startsAt');
  }

  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE events SET
         kind = COALESCE(?, kind),
         title = COALESCE(?, title),
         subject_id = CASE WHEN ? THEN ? ELSE subject_id END,
         file_id = CASE WHEN ? THEN ? ELSE file_id END,
         location = CASE WHEN ? THEN ? ELSE location END,
         starts_at = COALESCE(?, starts_at),
         ends_at = CASE WHEN ? THEN ? ELSE ends_at END,
         all_day = COALESCE(?, all_day),
         status = CASE WHEN ? THEN ? ELSE status END,
         updated_at = ?
       WHERE id = ? AND user_id = ?`,
    )
    .run(
      patch.kind ?? null,
      patch.title ?? null,
      patch.subjectId !== undefined ? 1 : 0,
      patch.subjectId ?? null,
      patch.fileId !== undefined ? 1 : 0,
      patch.fileId ?? null,
      patch.location !== undefined ? 1 : 0,
      patch.location ?? null,
      patch.startsAt ?? null,
      patch.endsAt !== undefined ? 1 : 0,
      patch.endsAt ?? null,
      patch.allDay === undefined ? null : patch.allDay ? 1 : 0,
      patch.status !== undefined ? 1 : 0,
      patch.status ?? null,
      now,
      eventId,
      userId,
    );
  return requireEvent(userId, eventId);
}

export function deleteEvent(userId: string, eventId: string): void {
  requireEvent(userId, eventId);
  getDb().prepare('DELETE FROM events WHERE id = ? AND user_id = ?').run(eventId, userId);
}

export function listEvents(
  userId: string,
  q: { from?: number; to?: number; kinds?: string[]; subjectIds?: string[]; limit: number },
) {
  const where = ['user_id = ?'];
  const params: unknown[] = [userId];

  if (q.from !== undefined) {
    where.push('COALESCE(ends_at, starts_at) >= ?');
    params.push(q.from);
  }
  if (q.to !== undefined) {
    where.push('starts_at <= ?');
    params.push(q.to);
  }
  if (q.kinds?.length) {
    where.push(`kind IN (${q.kinds.map(() => '?').join(',')})`);
    params.push(...q.kinds);
  }
  if (q.subjectIds?.length) {
    // Ownership of each subject is checked so a filter cannot probe for the
    // existence of another account's subject ids.
    for (const id of q.subjectIds) requireSubject(userId, id);
    where.push(`subject_id IN (${q.subjectIds.map(() => '?').join(',')})`);
    params.push(...q.subjectIds);
  }
  params.push(q.limit);

  return getDb()
    .prepare<unknown[], EventRow>(
      `SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY starts_at ASC LIMIT ?`,
    )
    .all(...params)
    .map((e) => ({ ...e, all_day: e.all_day === 1 }));
}

/** "NEXT UP" — upcoming exams and deadlines with a day countdown. */
export function upcoming(userId: string, limit = 5, now = Date.now()) {
  return getDb()
    .prepare<[string, number, number], EventRow>(
      `SELECT * FROM events
       WHERE user_id = ? AND kind IN ('exam','deadline') AND starts_at >= ?
       ORDER BY starts_at ASC LIMIT ?`,
    )
    .all(userId, now, limit)
    .map((e) => ({ ...e, all_day: e.all_day === 1, days_until: daysUntil(e.starts_at, now) }));
}

/* ------------------------------- focus timer ------------------------------ */

export interface StudySessionRow {
  id: string;
  user_id: string;
  subject_id: string | null;
  file_id: string | null;
  event_id: string | null;
  goal: string | null;
  goal_met: number | null;
  planned_minutes: number;
  elapsed_seconds: number;
  cycle_index: number;
  cycle_total: number;
  status: 'running' | 'paused' | 'completed' | 'abandoned';
  started_at: number;
  resumed_at: number | null;
  ended_at: number | null;
}

export function requireStudySession(userId: string, sessionId: string): StudySessionRow {
  const row = getDb()
    .prepare<[string, string], StudySessionRow>(
      'SELECT * FROM study_sessions WHERE id = ? AND user_id = ?',
    )
    .get(sessionId, userId);
  if (!row) throw notFound('Study session not found');
  return row;
}

/**
 * Elapsed time is derived from server timestamps, never taken from the client:
 * a caller cannot inflate their study hours by reporting a large number.
 */
function currentElapsed(row: StudySessionRow, now = Date.now()): number {
  if (row.status !== 'running' || row.resumed_at === null) return row.elapsed_seconds;
  return row.elapsed_seconds + Math.max(0, Math.floor((now - row.resumed_at) / 1000));
}

export function shapeStudySession(row: StudySessionRow) {
  const elapsed = currentElapsed(row);
  return {
    ...row,
    elapsed_seconds: elapsed,
    remaining_seconds: Math.max(0, row.planned_minutes * 60 - elapsed),
  };
}

export function startStudySession(
  userId: string,
  input: {
    subjectId?: string | null;
    fileId?: string | null;
    eventId?: string | null;
    goal?: string | null;
    plannedMinutes: number;
    cycleIndex?: number;
    cycleTotal?: number;
  },
) {
  if (input.subjectId) requireSubject(userId, input.subjectId);
  if (input.fileId) requireFile(userId, input.fileId);
  const event = input.eventId ? requireEvent(userId, input.eventId) : null;
  // A block started from the calendar is credited to that block's subject
  // unless the student picked one; so is one started on a file in a subject's
  // folder. Hours-by-subject is only honest if sessions land somewhere.
  const subjectId = input.subjectId ?? event?.subject_id ?? (input.fileId ? fileSubject(input.fileId) : null);

  const active = getDb()
    .prepare<[string], { id: string }>(
      `SELECT id FROM study_sessions WHERE user_id = ? AND status IN ('running','paused') LIMIT 1`,
    )
    .get(userId);
  if (active) throw conflict('A study session is already in progress');

  const now = Date.now();
  const id = newId();
  getDb()
    .prepare(
      `INSERT INTO study_sessions
         (id, user_id, subject_id, file_id, event_id, goal, planned_minutes, elapsed_seconds,
          cycle_index, cycle_total, status, started_at, resumed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'running', ?, ?)`,
    )
    .run(
      id,
      userId,
      subjectId ?? null,
      input.fileId ?? null,
      input.eventId ?? null,
      input.goal?.trim() || null,
      input.plannedMinutes,
      input.cycleIndex ?? 1,
      input.cycleTotal ?? 4,
      now,
      now,
    );
  return shapeStudySession(requireStudySession(userId, id));
}

export function pauseStudySession(userId: string, sessionId: string) {
  const row = requireStudySession(userId, sessionId);
  if (row.status !== 'running') throw conflict('Session is not running');
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE study_sessions SET elapsed_seconds = ?, status = 'paused', resumed_at = NULL WHERE id = ?`,
    )
    .run(currentElapsed(row, now), sessionId);
  return shapeStudySession(requireStudySession(userId, sessionId));
}

export function resumeStudySession(userId: string, sessionId: string) {
  const row = requireStudySession(userId, sessionId);
  if (row.status !== 'paused') throw conflict('Session is not paused');
  getDb()
    .prepare(`UPDATE study_sessions SET status = 'running', resumed_at = ? WHERE id = ?`)
    .run(Date.now(), sessionId);
  return shapeStudySession(requireStudySession(userId, sessionId));
}

export function endStudySession(
  userId: string,
  sessionId: string,
  status: 'completed' | 'abandoned',
  goalMet?: boolean | null,
) {
  const row = requireStudySession(userId, sessionId);
  if (row.status === 'completed' || row.status === 'abandoned') {
    throw conflict('Session has already ended');
  }
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE study_sessions SET elapsed_seconds = ?, status = ?, resumed_at = NULL, ended_at = ?,
         goal_met = CASE WHEN ? THEN ? ELSE goal_met END
       WHERE id = ?`,
    )
    .run(currentElapsed(row, now), status, now, goalMet == null ? 0 : 1, goalMet ? 1 : 0, sessionId);
  return shapeStudySession(requireStudySession(userId, sessionId));
}

/** The student's answer to "did you do what you set out to?", given after the timer ends. */
export function markSessionGoal(userId: string, sessionId: string, met: boolean) {
  const row = requireStudySession(userId, sessionId);
  if (!row.goal) throw conflict('This session had no goal');
  getDb().prepare('UPDATE study_sessions SET goal_met = ? WHERE id = ?').run(met ? 1 : 0, sessionId);
  return shapeStudySession(requireStudySession(userId, sessionId));
}

/** Recent sessions that carried a goal, newest first — the record of plans kept. */
export function recentGoals(userId: string, limit = 20) {
  return getDb()
    .prepare<[string, number], StudySessionRow>(
      `SELECT * FROM study_sessions WHERE user_id = ? AND goal IS NOT NULL
         AND status IN ('completed','abandoned')
       ORDER BY started_at DESC LIMIT ?`,
    )
    .all(userId, limit)
    .map(shapeStudySession);
}

function fileSubject(fileId: string): string | null {
  const row = getDb()
    .prepare<[string], { subject_id: string | null }>(
      `SELECT fo.subject_id FROM files f LEFT JOIN folders fo ON fo.id = f.folder_id WHERE f.id = ?`,
    )
    .get(fileId);
  return row?.subject_id ?? null;
}

export function activeStudySession(userId: string) {
  const row = getDb()
    .prepare<[string], StudySessionRow>(
      `SELECT * FROM study_sessions WHERE user_id = ? AND status IN ('running','paused')
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(userId);
  return row ? shapeStudySession(row) : null;
}

/** "TONIGHT'S PLAN" — study blocks scheduled for the rest of today. */
export function todaysPlan(userId: string, from: number, to: number) {
  return getDb()
    .prepare<[string, number, number], EventRow>(
      `SELECT * FROM events
       WHERE user_id = ? AND kind = 'study_block' AND starts_at >= ? AND starts_at <= ?
       ORDER BY starts_at ASC`,
    )
    .all(userId, from, to)
    .map((e) => ({ ...e, all_day: e.all_day === 1 }));
}
