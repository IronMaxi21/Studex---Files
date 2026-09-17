import { z } from 'zod';
import { getDb, tx } from '../lib/db.js';
import { newId } from '../lib/ids.js';
import { notFound } from '../lib/errors.js';
import { DAY_MS, daysUntil } from '../lib/time.js';
import { text, uuid } from '../lib/validation.js';
import { requireFile, requireSubject } from './library.js';

/**
 * How long a rating buys.
 *
 * Five steps, each roughly twice the last, from "come back tomorrow" to "you
 * know this, see you next month". The shape is the same expanding interval every
 * spacing system uses; what is different is that the student chooses the step
 * directly, so the schedule is one they can predict and therefore one they will
 * keep. The numbers are days.
 */
export const CONFIDENCE_DAYS = [1, 3, 7, 16, 35] as const;

export const CONFIDENCE_LABELS = [
  'No idea',
  'Shaky',
  'Getting there',
  'Solid',
  'Could teach it',
] as const;

/** The date a topic rated this well should next be looked at. */
export function nextDue(confidence: number, from = Date.now()): number | null {
  const days = CONFIDENCE_DAYS[confidence - 1];
  return days === undefined ? null : from + days * DAY_MS;
}

export const createTopicSchema = z.object({
  name: text(160),
  subjectId: uuid.nullish(),
  unit: text(80).nullish(),
  fileId: uuid.nullish(),
  notes: text(2000).nullish(),
  confidence: z.number().int().min(0).max(5).optional(),
});

export const updateTopicSchema = z
  .object({
    name: text(160).optional(),
    subjectId: uuid.nullable().optional(),
    unit: text(80).nullable().optional(),
    fileId: uuid.nullable().optional(),
    notes: text(2000).nullable().optional(),
    position: z.number().int().min(0).max(100_000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

export const rateTopicSchema = z.object({
  confidence: z.number().int().min(1).max(5),
});

/** Adding a specification in one go, which is how a matrix actually gets filled. */
export const importTopicsSchema = z.object({
  subjectId: uuid.nullish(),
  unit: text(80).nullish(),
  /**
   * A plain name, or a name with where it sits on the specification — which is
   * what a file import proposes, and what a pasted list never has.
   */
  names: z
    .array(z.union([
      text(160),
      z.object({
        name: text(160),
        ref: text(40).nullish(),
        page: z.number().int().min(1).max(10_000).nullish(),
      }),
    ]))
    .min(1)
    .max(500),
});

/** Folding duplicates into one topic. The ids are the client's, and are checked. */
export const mergeTopicsSchema = z.object({
  keepId: uuid,
  mergeIds: z.array(uuid).min(1).max(50),
});

export interface TopicRow {
  id: string;
  user_id: string;
  subject_id: string | null;
  unit: string | null;
  name: string;
  confidence: number;
  last_rated_at: number | null;
  next_due_at: number | null;
  file_id: string | null;
  notes: string | null;
  spec_ref: string | null;
  spec_page: number | null;
  position: number;
  created_at: number;
  updated_at: number;
}

export function requireTopic(userId: string, topicId: string): TopicRow {
  const row = getDb()
    .prepare<[string, string], TopicRow>('SELECT * FROM topics WHERE id = ? AND user_id = ?')
    .get(topicId, userId);
  if (!row) throw notFound('Topic not found');
  return row;
}

function shape(row: TopicRow, now: number) {
  return {
    ...row,
    days_until: row.next_due_at === null ? null : daysUntil(row.next_due_at, now),
    overdue: row.next_due_at !== null && row.next_due_at <= now,
  };
}

export function listTopics(
  userId: string,
  q: { subjectId?: string; due?: boolean; limit: number },
  now = Date.now(),
) {
  const where = ['user_id = ?'];
  const params: unknown[] = [userId];

  if (q.subjectId) {
    requireSubject(userId, q.subjectId);
    where.push('subject_id = ?');
    params.push(q.subjectId);
  }
  if (q.due) {
    // Unrated topics are due: a topic nobody has judged yet is exactly the kind
    // that needs looking at, and leaving it out of the due list is how it stays
    // unjudged until the exam.
    where.push('(next_due_at IS NULL OR next_due_at <= ?)');
    params.push(now);
  }
  params.push(q.limit);

  return getDb()
    .prepare<unknown[], TopicRow>(
      `SELECT * FROM topics WHERE ${where.join(' AND ')}
       ORDER BY next_due_at IS NULL DESC, next_due_at ASC, position ASC, created_at ASC
       LIMIT ?`,
    )
    .all(...params)
    .map((row) => shape(row, now));
}

export function createTopic(
  userId: string,
  input: z.infer<typeof createTopicSchema>,
  spec: { ref?: string | null; page?: number | null } = {},
): TopicRow {
  if (input.subjectId) requireSubject(userId, input.subjectId);
  if (input.fileId) requireFile(userId, input.fileId);

  const now = Date.now();
  const id = newId();
  const confidence = input.confidence ?? 0;
  const next = confidence === 0 ? null : nextDue(confidence, now);
  getDb()
    .prepare(
      `INSERT INTO topics
         (id, user_id, subject_id, unit, name, confidence, last_rated_at, next_due_at,
          file_id, notes, spec_ref, spec_page, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         (SELECT COALESCE(MAX(position) + 1, 0) FROM topics WHERE user_id = ?), ?, ?)`,
    )
    .run(
      id,
      userId,
      input.subjectId ?? null,
      input.unit ?? null,
      input.name,
      confidence,
      confidence === 0 ? null : now,
      next,
      input.fileId ?? null,
      input.notes ?? null,
      spec.ref ?? null,
      spec.page ?? null,
      userId,
      now,
      now,
    );
  return requireTopic(userId, id);
}

/**
 * A whole specification pasted in at once.
 *
 * Nobody builds a topic matrix a row at a time; they paste the contents page of
 * the specification. Names that are already on the matrix under the same subject
 * are skipped rather than duplicated, so pasting an updated list is a way of
 * adding what is new without losing the ratings already given.
 */
export function importTopics(userId: string, input: z.infer<typeof importTopicsSchema>) {
  if (input.subjectId) requireSubject(userId, input.subjectId);

  const existing = new Set(
    getDb()
      .prepare<[string], { name: string }>('SELECT name FROM topics WHERE user_id = ?')
      .all(userId)
      .map((r) => r.name.trim().toLowerCase()),
  );

  const wanted: Array<{ name: string; ref: string | null; page: number | null }> = [];
  for (const raw of input.names) {
    const item = typeof raw === 'string' ? { name: raw } : raw;
    const name = item.name.trim();
    const key = name.toLowerCase();
    if (!name || existing.has(key)) continue;
    existing.add(key);
    wanted.push({
      name,
      ref: typeof raw === 'string' ? null : raw.ref ?? null,
      page: typeof raw === 'string' ? null : raw.page ?? null,
    });
  }

  const created = tx(() =>
    wanted.map((item) =>
      createTopic(
        userId,
        { name: item.name, subjectId: input.subjectId, unit: input.unit },
        { ref: item.ref, page: item.page },
      ),
    ),
  );
  return { created, skipped: input.names.length - created.length };
}

export function updateTopic(
  userId: string,
  topicId: string,
  patch: z.infer<typeof updateTopicSchema>,
): TopicRow {
  requireTopic(userId, topicId);
  if (patch.subjectId) requireSubject(userId, patch.subjectId);
  if (patch.fileId) requireFile(userId, patch.fileId);

  getDb()
    .prepare(
      `UPDATE topics SET
         name = COALESCE(?, name),
         subject_id = CASE WHEN ? THEN ? ELSE subject_id END,
         unit = CASE WHEN ? THEN ? ELSE unit END,
         file_id = CASE WHEN ? THEN ? ELSE file_id END,
         notes = CASE WHEN ? THEN ? ELSE notes END,
         position = COALESCE(?, position),
         updated_at = ?
       WHERE id = ? AND user_id = ?`,
    )
    .run(
      patch.name ?? null,
      patch.subjectId !== undefined ? 1 : 0,
      patch.subjectId ?? null,
      patch.unit !== undefined ? 1 : 0,
      patch.unit ?? null,
      patch.fileId !== undefined ? 1 : 0,
      patch.fileId ?? null,
      patch.notes !== undefined ? 1 : 0,
      patch.notes ?? null,
      patch.position ?? null,
      Date.now(),
      topicId,
      userId,
    );
  return requireTopic(userId, topicId);
}

/**
 * Saying how well a topic is known, which is the only input the matrix takes.
 *
 * The date is computed here and nowhere else. A client cannot send one: the
 * whole point of the matrix is that the next date is not a field somebody fills
 * in optimistically, and letting it be posted would give that back.
 */
export function rateTopic(userId: string, topicId: string, confidence: number, now = Date.now()) {
  requireTopic(userId, topicId);
  const due = nextDue(confidence, now);
  tx(() => {
    getDb()
      .prepare(
        `UPDATE topics SET confidence = ?, last_rated_at = ?, next_due_at = ?, updated_at = ?
         WHERE id = ? AND user_id = ?`,
      )
      .run(confidence, now, due, now, topicId, userId);
    getDb()
      .prepare(
        'INSERT INTO topic_ratings (id, user_id, topic_id, confidence, rated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(newId(), userId, topicId, confidence, now);
  });
  return shape(requireTopic(userId, topicId), now);
}

export function topicHistory(userId: string, topicId: string, limit = 50) {
  requireTopic(userId, topicId);
  return getDb()
    .prepare<[string, number], { id: string; confidence: number; rated_at: number }>(
      'SELECT id, confidence, rated_at FROM topic_ratings WHERE topic_id = ? ORDER BY rated_at DESC LIMIT ?',
    )
    .all(topicId, limit);
}

/**
 * Several topics that are really one, folded into the one kept.
 *
 * Nothing learnt is thrown away: every rating the others were given moves to
 * the kept topic's history, their notes are appended to its notes, and if the
 * kept topic was never rated it takes the most recent rating any of them had —
 * because "I rated this Solid last week under a slightly different name" is
 * still a rating.
 */
export function mergeTopics(userId: string, input: z.infer<typeof mergeTopicsSchema>) {
  const keep = requireTopic(userId, input.keepId);
  const others = [...new Set(input.mergeIds)]
    .filter((id) => id !== keep.id)
    .map((id) => requireTopic(userId, id));
  if (others.length === 0) return { topic: shape(keep, Date.now()), merged: 0 };

  const now = Date.now();
  tx(() => {
    const db = getDb();
    const notes = [keep.notes, ...others.map((o) => o.notes)]
      .map((n) => n?.trim())
      .filter((n): n is string => Boolean(n));
    const latest = [keep, ...others]
      .filter((t) => t.confidence > 0 && t.last_rated_at !== null)
      .sort((a, b) => (b.last_rated_at ?? 0) - (a.last_rated_at ?? 0))[0];

    for (const other of others) {
      db.prepare('UPDATE topic_ratings SET topic_id = ? WHERE topic_id = ? AND user_id = ?')
        .run(keep.id, other.id, userId);
    }

    db.prepare(
      `UPDATE topics SET
         notes = ?,
         confidence = ?, last_rated_at = ?, next_due_at = ?,
         spec_ref = COALESCE(spec_ref, ?), spec_page = COALESCE(spec_page, ?),
         file_id = COALESCE(file_id, ?),
         updated_at = ?
       WHERE id = ? AND user_id = ?`,
    ).run(
      notes.length ? [...new Set(notes)].join('\n\n').slice(0, 2000) : null,
      keep.confidence > 0 ? keep.confidence : latest?.confidence ?? 0,
      keep.confidence > 0 ? keep.last_rated_at : latest?.last_rated_at ?? null,
      keep.confidence > 0 ? keep.next_due_at : latest?.next_due_at ?? null,
      others.find((o) => o.spec_ref)?.spec_ref ?? null,
      others.find((o) => o.spec_page)?.spec_page ?? null,
      others.find((o) => o.file_id)?.file_id ?? null,
      now,
      keep.id,
      userId,
    );

    for (const other of others) {
      db.prepare('DELETE FROM topics WHERE id = ? AND user_id = ?').run(other.id, userId);
    }
  });

  return { topic: shape(requireTopic(userId, keep.id), now), merged: others.length };
}

export function deleteTopic(userId: string, topicId: string): void {
  requireTopic(userId, topicId);
  getDb().prepare('DELETE FROM topics WHERE id = ? AND user_id = ?').run(topicId, userId);
}

/** The headline the matrix screen and the Home tile both want. */
export function topicSummary(userId: string, now = Date.now()) {
  const row = getDb()
    .prepare<[number, string], {
      total: number;
      unrated: number;
      due: number;
      shaky: number;
      solid: number;
    }>(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN confidence = 0 THEN 1 ELSE 0 END) AS unrated,
         SUM(CASE WHEN next_due_at IS NULL OR next_due_at <= ? THEN 1 ELSE 0 END) AS due,
         SUM(CASE WHEN confidence BETWEEN 1 AND 2 THEN 1 ELSE 0 END) AS shaky,
         SUM(CASE WHEN confidence >= 4 THEN 1 ELSE 0 END) AS solid
       FROM topics WHERE user_id = ?`,
    )
    .get(now, userId);
  return {
    total: row?.total ?? 0,
    unrated: row?.unrated ?? 0,
    due: row?.due ?? 0,
    shaky: row?.shaky ?? 0,
    solid: row?.solid ?? 0,
  };
}
