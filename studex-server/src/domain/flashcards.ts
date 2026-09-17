import { z } from 'zod';
import { getDb, tx } from '../lib/db.js';
import { newId } from '../lib/ids.js';
import { badRequest, notFound } from '../lib/errors.js';
import { requireFile } from './library.js';
import { dueForReview, inLiveDeck } from './due.js';
import { longestStreak, studyStreak, timezoneFor } from './stats.js';
import { DAY_MS, dayKey } from '../lib/time.js';
import * as search from './search.js';
import {
  type MemoryState,
  intervalForRetention,
  nextMemoryState,
} from './fsrs.js';
import { weightsFor } from './tuning.js';

export type Rating = 1 | 2 | 3 | 4; // Again, Hard, Good, Easy
export type CardState = 'new' | 'learning' | 'review' | 'relearning';

export interface CardRow {
  id: string;
  user_id: string;
  deck_id: string;
  front: string;
  back: string;
  topic: string | null;
  /** The deck template's optional extra fields — a pronunciation line, a worked answer. */
  extra1: string | null;
  extra2: string | null;
  source_file_id: string | null;
  source_annotation_id: string | null;
  /** Image occlusion: JSON of the diagram, its masks and which one this card hides. */
  occlusion?: string | null;
  state: CardState;
  ease_factor: number;
  /** FSRS memory state. Null until the card's first review, because FSRS reads
   *  its opening state off the first grade rather than assuming one. */
  stability: number | null;
  difficulty: number | null;
  interval_days: number;
  repetitions: number;
  lapses: number;
  due_at: number;
  last_reviewed_at: number | null;
  suspended: number;
  created_at: number;
  updated_at: number;
}

/* ----------------------------- FSRS scheduler ----------------------------- */

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

/** Short steps a card walks through before it graduates into the review pool.
 *  FSRS schedules days, not minutes; these cover the first sitting, where the
 *  useful question is "again in a minute or in ten", not "in how many days". */
const LEARNING_STEPS_MIN = [1, 10];
const RELEARNING_STEPS_MIN = [10];
const MIN_REVIEW_INTERVAL_DAYS = 1;
const MAX_INTERVAL_DAYS = 365 * 5;

/**
 * The recall probability the schedule aims for. Higher means more reviews for
 * the same material; lower means fewer reviews and more forgetting. 0.9 is the
 * FSRS default and the point most study schedules are built around.
 */
const DESIRED_RETENTION = 0.9;

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/**
 * SM-2's ease factor, derived from FSRS difficulty.
 *
 * Nothing schedules on this any more, but it is part of the sync payload and
 * of what older clients read, so it is kept meaningful rather than frozen:
 * difficulty 1 shows as the old 3.0 ceiling and difficulty 10 as the 1.3
 * floor, which is the inverse of how existing cards were seeded.
 */
function easeFromDifficulty(difficulty: number): number {
  return Number((3.0 - (clamp(difficulty, 1, 10) - 1) * (1.7 / 9)).toFixed(4));
}

export interface ScheduleResult {
  state: CardState;
  ease_factor: number;
  stability: number;
  difficulty: number;
  interval_days: number;
  repetitions: number;
  lapses: number;
  due_at: number;
}

type SchedulableCard = Pick<
  CardRow,
  | 'state'
  | 'ease_factor'
  | 'stability'
  | 'difficulty'
  | 'interval_days'
  | 'repetitions'
  | 'lapses'
  | 'last_reviewed_at'
>;

/** A card carries FSRS state only once it has been reviewed at least once. */
function priorState(card: SchedulableCard): MemoryState | null {
  if (card.stability === null || card.difficulty === null) return null;
  return { stability: card.stability, difficulty: card.difficulty };
}

/**
 * FSRS-5, wrapped in Anki-style learning steps.
 *
 * The two do different jobs and both are wanted. FSRS decides how many days a
 * card has earned; the learning steps decide how a brand new or just-failed
 * card is handled within the first sitting, where day-scale intervals are the
 * wrong unit. Memory state is updated on every grade either way, so nothing
 * that happens during learning is lost when the card graduates.
 *
 * Pure: it takes the card's current scheduling state and a grade, and returns
 * the next state. Keeping it free of I/O — and free of the interval fuzz some
 * schedulers add — is what makes the behaviour testable across a long review
 * history.
 */
export function scheduleCard(
  card: SchedulableCard,
  rating: Rating,
  now: number,
  desiredRetention: number = DESIRED_RETENTION,
  weights?: readonly number[],
): ScheduleResult {
  // The gap since the last review is the signal FSRS learns from: answering a
  // card correctly after a month means far more than answering it after a day.
  const elapsedDays =
    card.last_reviewed_at === null ? 0 : Math.max(0, (now - card.last_reviewed_at) / DAY);

  const memory = nextMemoryState(priorState(card), rating, elapsedDays, weights);
  const earned = clamp(
    intervalForRetention(memory.stability, desiredRetention),
    MIN_REVIEW_INTERVAL_DAYS,
    MAX_INTERVAL_DAYS,
  );

  const base = {
    ease_factor: easeFromDifficulty(memory.difficulty),
    stability: memory.stability,
    difficulty: memory.difficulty,
    lapses: card.lapses,
  };

  const inRelearning = card.state === 'relearning';
  const inLearning = card.state === 'new' || card.state === 'learning';

  if (inLearning || inRelearning) {
    const steps = inRelearning ? RELEARNING_STEPS_MIN : LEARNING_STEPS_MIN;
    // Position within the step list is derived from how many times the card
    // has been graded since it entered this phase.
    const currentStep = clamp(card.repetitions, 0, steps.length - 1);
    const phase: CardState = inRelearning ? 'relearning' : 'learning';

    // Again sends the card back to the first step; Hard repeats the current
    // one. Neither graduates, so the interval FSRS computed is held until it
    // does.
    if (rating === 1 || rating === 2) {
      return {
        ...base,
        state: phase,
        interval_days: earned,
        repetitions: rating === 1 ? 0 : card.repetitions,
        due_at: now + steps[rating === 1 ? 0 : currentStep]! * MINUTE,
      };
    }

    // Easy graduates immediately. Good graduates only once the steps are done.
    const nextStep = card.repetitions + 1;
    if (rating === 3 && nextStep < steps.length) {
      return {
        ...base,
        state: phase,
        interval_days: earned,
        repetitions: nextStep,
        due_at: now + steps[nextStep]! * MINUTE,
      };
    }

    return {
      ...base,
      state: 'review',
      interval_days: earned,
      repetitions: card.repetitions + 1,
      due_at: now + earned * DAY,
    };
  }

  // Review state. A failure drops the card into relearning, where the steps
  // take over the timing again — but its stability is not reset, only reduced,
  // so a card that was strong before a lapse comes back faster than a new one.
  if (rating === 1) {
    return {
      ...base,
      state: 'relearning',
      interval_days: earned,
      repetitions: 0,
      lapses: card.lapses + 1,
      due_at: now + RELEARNING_STEPS_MIN[0]! * MINUTE,
    };
  }

  return {
    ...base,
    state: 'review',
    interval_days: earned,
    repetitions: card.repetitions + 1,
    due_at: now + earned * DAY,
  };
}

/* --------------------------------- decks ---------------------------------- */

export function requireDeck(userId: string, deckId: string) {
  const file = requireFile(userId, deckId);
  if (file.kind !== 'deck') throw notFound('File is not a deck');
  return file;
}

/**
 * How a deck's cards are set. Every field falls back rather than failing, so a
 * template written by a newer client still reads here as the nearest thing
 * this build understands.
 */
export const deckTemplateSchema = z.object({
  align: z.enum(['left', 'center']).catch('left'),
  size: z.enum(['small', 'medium', 'large']).catch('medium'),
  backFirst: z.boolean().catch(false),
  fields: z
    .array(z.object({
      label: z.string().trim().min(1).max(40),
      kind: z.enum(['line', 'worked']).catch('line'),
    }))
    .max(2)
    .catch([]),
});

export type DeckTemplate = z.infer<typeof deckTemplateSchema>;

function readTemplate(raw: string | null | undefined): DeckTemplate | null {
  if (!raw) return null;
  try {
    const parsed = deckTemplateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function deckTemplate(userId: string, deckId: string): DeckTemplate | null {
  requireDeck(userId, deckId);
  const row = getDb()
    .prepare<[string], { template: string | null }>('SELECT template FROM decks WHERE file_id = ?')
    .get(deckId);
  return readTemplate(row?.template);
}

/** Stores a deck's template; null returns the deck to the default look. */
export function setDeckTemplate(userId: string, deckId: string, template: DeckTemplate | null): DeckTemplate | null {
  requireDeck(userId, deckId);
  const clean = template ? deckTemplateSchema.parse(template) : null;
  const now = Date.now();
  tx(() => {
    getDb().prepare('UPDATE decks SET template = ?, updated_at = ? WHERE file_id = ?')
      .run(clean ? JSON.stringify(clean) : null, now, deckId);
    getDb().prepare('UPDATE files SET updated_at = ? WHERE id = ?').run(now, deckId);
  });
  return clean;
}

export function deckStats(userId: string, deckId: string) {
  requireDeck(userId, deckId);
  const now = Date.now();
  const row = getDb()
    .prepare<[number, string, string], {
      total: number;
      due: number;
      new_count: number;
      known: number;
      shaky: number;
    }>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN ${dueForReview()} THEN 1 ELSE 0 END) AS due,
              SUM(CASE WHEN state = 'new' THEN 1 ELSE 0 END) AS new_count,
              SUM(CASE WHEN state = 'review' AND interval_days >= 7 THEN 1 ELSE 0 END) AS known,
              SUM(CASE WHEN state IN ('learning','relearning') OR (state = 'review' AND interval_days < 7) THEN 1 ELSE 0 END) AS shaky
       FROM cards WHERE user_id = ? AND deck_id = ?`,
    )
    .get(now, userId, deckId)!;

  return {
    deck_id: deckId,
    total: row.total ?? 0,
    due: row.due ?? 0,
    new: row.new_count ?? 0,
    known: row.known ?? 0,
    shaky: row.shaky ?? 0,
  };
}

/* --------------------------------- cards ---------------------------------- */

export function requireCard(userId: string, cardId: string): CardRow {
  const row = getDb()
    .prepare<[string, string], CardRow>('SELECT * FROM cards WHERE id = ? AND user_id = ?')
    .get(cardId, userId);
  if (!row) throw notFound('Card not found');
  return row;
}

export function createCard(
  userId: string,
  input: {
    deckId: string;
    front: string;
    back: string;
    topic?: string | null;
    extra1?: string | null;
    extra2?: string | null;
    sourceFileId?: string | null;
    sourceAnnotationId?: string | null;
  },
): CardRow {
  requireDeck(userId, input.deckId);
  if (input.sourceFileId) requireFile(userId, input.sourceFileId);

  const now = Date.now();
  const id = newId();

  return tx(() => {
    getDb()
      .prepare(
        `INSERT INTO cards
           (id, user_id, deck_id, front, back, topic, extra1, extra2, source_file_id, source_annotation_id,
            state, ease_factor, interval_days, repetitions, lapses, due_at, suspended, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', 2.5, 0, 0, 0, ?, 0, ?, ?)`,
      )
      .run(
        id,
        userId,
        input.deckId,
        input.front,
        input.back,
        input.topic ?? null,
        input.extra1 || null,
        input.extra2 || null,
        input.sourceFileId ?? null,
        input.sourceAnnotationId ?? null,
        now, // a new card is due immediately
        now,
        now,
      );

    search.indexEntity({
      userId,
      entityType: 'card',
      entityId: id,
      fileId: input.deckId,
      title: input.front.slice(0, 200),
      body: cardSearchBody(input),
    });

    getDb().prepare('UPDATE files SET updated_at = ? WHERE id = ?').run(now, input.deckId);
    return requireCard(userId, id);
  });
}

/** What search reads of a card: every field a student might remember it by. */
function cardSearchBody(card: { front: string; back: string; topic?: string | null; extra1?: string | null; extra2?: string | null }): string {
  return [card.front, card.back, card.topic, card.extra1, card.extra2].filter(Boolean).join('\n');
}

export function updateCard(
  userId: string,
  cardId: string,
  patch: {
    front?: string;
    back?: string;
    topic?: string | null;
    extra1?: string | null;
    extra2?: string | null;
    suspended?: boolean;
    deckId?: string;
  },
): CardRow {
  const card = requireCard(userId, cardId);
  if (patch.deckId) requireDeck(userId, patch.deckId);

  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE cards SET
         front = COALESCE(?, front),
         back = COALESCE(?, back),
         topic = CASE WHEN ? THEN ? ELSE topic END,
         extra1 = CASE WHEN ? THEN ? ELSE extra1 END,
         extra2 = CASE WHEN ? THEN ? ELSE extra2 END,
         suspended = COALESCE(?, suspended),
         deck_id = COALESCE(?, deck_id),
         updated_at = ?
       WHERE id = ? AND user_id = ?`,
    )
    .run(
      patch.front ?? null,
      patch.back ?? null,
      patch.topic !== undefined ? 1 : 0,
      patch.topic ?? null,
      patch.extra1 !== undefined ? 1 : 0,
      patch.extra1 || null,
      patch.extra2 !== undefined ? 1 : 0,
      patch.extra2 || null,
      patch.suspended === undefined ? null : patch.suspended ? 1 : 0,
      patch.deckId ?? null,
      now,
      cardId,
      userId,
    );

  const updated = requireCard(userId, cardId);
  search.indexEntity({
    userId,
    entityType: 'card',
    entityId: cardId,
    fileId: updated.deck_id,
    title: updated.front.slice(0, 200),
    body: cardSearchBody(updated),
  });
  void card;
  return updated;
}

export function deleteCard(userId: string, cardId: string): void {
  requireCard(userId, cardId);
  tx(() => {
    search.removeEntity('card', cardId);
    getDb().prepare('DELETE FROM cards WHERE id = ? AND user_id = ?').run(cardId, userId);
  });
}

export function listCards(userId: string, deckId: string, limit: number, offset: number) {
  requireDeck(userId, deckId);
  return getDb()
    .prepare<[string, string, number, number], CardRow>(
      `SELECT * FROM cards WHERE user_id = ? AND deck_id = ?
       ORDER BY created_at ASC LIMIT ? OFFSET ?`,
    )
    .all(userId, deckId, limit, offset)
    .map((c) => ({ ...c, suspended: c.suspended === 1 }));
}

/* ------------------------------ review queue ------------------------------ */

/**
 * Builds the study queue: everything already due, then new cards up to the
 * account's daily limit. Cards from other users can never appear because the
 * query is scoped by user_id and any deck filter is ownership-checked first.
 */
/**
 * What has already been answered today, in the student's own timezone.
 *
 * `introduced` counts cards that were new when they were answered — that is
 * what the new-card limit is a limit on, and it is why a card answered "Again"
 * three times still only spends one of the day's new-card allowance.
 */
function dailyCounts(userId: string, now: number): { reviews: number; introduced: number } {
  const tz = timezoneFor(userId);
  const today = dayKey(now, tz);
  const rows = getDb()
    .prepare<[string, number], { at: number; interval_before: number; card_id: string }>(
      `SELECT reviewed_at AS at, interval_before, card_id FROM review_logs
        WHERE user_id = ? AND reviewed_at >= ? AND mode = 'review'`,
    )
    .all(userId, now - 2 * DAY_MS);

  let reviews = 0;
  const introduced = new Set<string>();
  for (const row of rows) {
    if (dayKey(row.at, tz) !== today) continue;
    reviews += 1;
    if (row.interval_before === 0) introduced.add(row.card_id);
  }
  return { reviews, introduced: introduced.size };
}

/**
 * The state of today's review: what is still waiting once the daily limits and
 * the day's own progress are taken into account, and how much has been done.
 */
export function todayReview(userId: string, now = Date.now()): {
  due_count: number;
  new_count: number;
  remaining: number;
  reviewed_today: number;
  streak_days: number;
  best_streak_days: number;
  daily_new_cards: number;
  daily_review_limit: number;
} {
  const settings = dailySettings(userId);
  const counts = getDb()
    .prepare<[number, string], { due: number; new_count: number }>(
      `SELECT
         SUM(CASE WHEN ${dueForReview()} THEN 1 ELSE 0 END) AS due,
         SUM(CASE WHEN suspended = 0 AND state = 'new' THEN 1 ELSE 0 END) AS new_count
       FROM cards WHERE user_id = ? AND ${inLiveDeck()}`,
    )
    .get(now, userId)!;

  const due = counts.due ?? 0;
  const fresh = counts.new_count ?? 0;
  const done = dailyCounts(userId, now);
  const allowance = dailyAllowance(settings, done);

  return {
    due_count: due,
    new_count: fresh,
    remaining: Math.min(due, allowance.reviews) + Math.min(fresh, allowance.introduced),
    reviewed_today: done.reviews,
    streak_days: studyStreak(userId, now),
    best_streak_days: longestStreak(userId, now),
    daily_new_cards: settings.daily_new_cards,
    daily_review_limit: settings.daily_review_limit,
  };
}

function dailySettings(userId: string): { daily_new_cards: number; daily_review_limit: number } {
  return (
    getDb()
      .prepare<[string], { daily_new_cards: number; daily_review_limit: number }>(
        'SELECT daily_new_cards, daily_review_limit FROM user_settings WHERE user_id = ?',
      )
      .get(userId) ?? { daily_new_cards: 20, daily_review_limit: 200 }
  );
}

/**
 * The account's chosen retention target, falling back to the FSRS default when
 * the row or column is somehow absent. Kept in the same 0.70..0.99 range the
 * setting enforces, so a bad stored value can never push the interval maths out
 * of bounds.
 */
function retentionTarget(userId: string): number {
  const row = getDb()
    .prepare<[string], { retention_target: number | null }>(
      'SELECT retention_target FROM user_settings WHERE user_id = ?',
    )
    .get(userId);
  const value = row?.retention_target;
  return typeof value === 'number' ? clamp(value, 0.7, 0.99) : DESIRED_RETENTION;
}

/** What is left of today's allowance after what has already been answered. */
function dailyAllowance(
  settings: { daily_new_cards: number; daily_review_limit: number },
  done: { reviews: number; introduced: number },
): { reviews: number; introduced: number } {
  return {
    reviews: Math.max(0, settings.daily_review_limit - done.reviews),
    introduced: Math.max(0, settings.daily_new_cards - done.introduced),
  };
}

/**
 * The extra WHERE fragment and its parameters that narrow a mixed session to a
 * subject, a tag or a topic. Each axis is a set of deck ids — a deck is a file,
 * so a subject is the files under it, a tag is the files it is attached to, and
 * a topic is the one file it is written up in — and the queue is scoped with
 * `deck_id IN (…)` rather than a join, so the fragment drops into the counting
 * query unchanged. Axes given together intersect, which is what a student who
 * picks both a subject and a tag means by it.
 */
function queueScope(
  userId: string,
  opts: { subjectId?: string; tagId?: string; topic?: string },
): { clause: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.subjectId) {
    // A file has no subject_id of its own — its subject is inherited from the
    // nearest ancestor folder that names one (see resolveFolderColor in
    // library.ts). Walk each deck's folder chain upward until a subject
    // appears, then keep the decks whose inherited subject is the one asked
    // for. Files sitting outside any folder inherit nothing, so drop out.
    clauses.push(
      `deck_id IN (
         WITH RECURSIVE subj_chain(file_id, subject_id, parent_id) AS (
           SELECT f.id, fo.subject_id, fo.parent_id
             FROM files f JOIN folders fo ON fo.id = f.folder_id
            WHERE f.user_id = ?
           UNION ALL
           SELECT c.file_id, up.subject_id, up.parent_id
             FROM subj_chain c JOIN folders up ON up.id = c.parent_id
            WHERE c.subject_id IS NULL
         )
         SELECT file_id FROM subj_chain WHERE subject_id = ?
       )`,
    );
    params.push(userId, opts.subjectId);
  }
  if (opts.tagId) {
    clauses.push(
      "deck_id IN (SELECT item_id FROM tag_items WHERE user_id = ? AND item_type = 'file' AND tag_id = ?)",
    );
    params.push(userId, opts.tagId);
  }
  if (opts.topic) {
    // `topic` is free text carried on each card (the deck view groups by it),
    // distinct from the topics table of write-up docs. A mixed topic session
    // gathers every card wearing that label, whatever deck it lives in.
    clauses.push('topic = ?');
    params.push(opts.topic);
  }
  return { clause: clauses.map((c) => ` AND ${c}`).join(''), params };
}

export function reviewQueue(
  userId: string,
  opts: {
    deckId?: string;
    limit?: number;
    subjectId?: string;
    tagId?: string;
    topic?: string;
    weak?: boolean;
  } = {},
): { cards: CardRow[]; due_count: number; new_count: number } {
  if (opts.deckId) requireDeck(userId, opts.deckId);
  const now = Date.now();
  const limit = clamp(opts.limit ?? 50, 1, 200);

  // A daily limit that ignored what the day had already served would not be a
  // daily limit — it would reset on every visit to the screen.
  const allowance = dailyAllowance(dailySettings(userId), dailyCounts(userId, now));

  const deckFilter = opts.deckId ? 'AND deck_id = ?' : '';
  const baseParams = opts.deckId ? [userId, opts.deckId] : [userId];

  // Subject / tag / topic narrow the mixed session; deck id, when given, has
  // already pinned it to one deck, so the scope only earns its keep otherwise.
  const scope = queueScope(userId, opts);
  const scoped = deckFilter + scope.clause;

  // The "Needs work" session: the cards this student has lapsed on most,
  // surfaced now whatever their schedule says. Remediation is the point, so it
  // ignores due timing and the daily allowance — the student asked for exactly
  // these — and simply serves the hardest first. New cards have no lapses yet,
  // so they never crowd in.
  if (opts.weak) {
    const weakCards = getDb()
      .prepare<unknown[], CardRow>(
        `SELECT * FROM cards
         WHERE user_id = ? ${scoped} AND ${inLiveDeck()} AND suspended = 0 AND lapses > 0
         ORDER BY lapses DESC, due_at ASC LIMIT ?`,
      )
      .all(...baseParams, ...scope.params, limit);
    const weakCount = getDb()
      .prepare<unknown[], { n: number }>(
        `SELECT COUNT(*) AS n FROM cards
         WHERE user_id = ? ${scoped} AND ${inLiveDeck()} AND suspended = 0 AND lapses > 0`,
      )
      .get(...baseParams, ...scope.params)!;
    return { cards: weakCards, due_count: weakCount.n ?? 0, new_count: 0 };
  }

  const dueCards = getDb()
    .prepare<unknown[], CardRow>(
      `SELECT * FROM cards
       WHERE user_id = ? ${scoped} AND ${inLiveDeck()} AND ${dueForReview()}
       ORDER BY due_at ASC LIMIT ?`,
    )
    .all(...baseParams, ...scope.params, now, Math.min(limit, allowance.reviews));

  const remaining = Math.max(0, limit - dueCards.length);
  const newCards = remaining
    ? getDb()
        .prepare<unknown[], CardRow>(
          `SELECT * FROM cards
           WHERE user_id = ? ${scoped} AND ${inLiveDeck()} AND suspended = 0 AND state = 'new'
           ORDER BY created_at ASC LIMIT ?`,
        )
        .all(...baseParams, ...scope.params, Math.min(remaining, allowance.introduced))
    : [];

  const counts = getDb()
    .prepare<unknown[], { due: number; new_count: number }>(
      `SELECT
         SUM(CASE WHEN ${dueForReview()} THEN 1 ELSE 0 END) AS due,
         SUM(CASE WHEN suspended = 0 AND state = 'new' THEN 1 ELSE 0 END) AS new_count
       FROM cards WHERE user_id = ? ${scoped} AND ${inLiveDeck()}`,
    )
    .get(now, ...baseParams, ...scope.params)!;

  return {
    cards: [...dueCards, ...newCards],
    due_count: counts.due ?? 0,
    new_count: counts.new_count ?? 0,
  };
}

export function reviewCard(
  userId: string,
  cardId: string,
  input: { rating: Rating; durationMs?: number; mode?: 'review' | 'test' },
): { card: CardRow; scheduled: ScheduleResult } {
  const card = requireCard(userId, cardId);
  if (card.suspended === 1) throw badRequest('Card is suspended');

  const now = Date.now();
  const scheduled = scheduleCard(card, input.rating, now, retentionTarget(userId), weightsFor(userId));

  return tx(() => {
    getDb()
      .prepare(
        `UPDATE cards SET
           state = ?, ease_factor = ?, stability = ?, difficulty = ?,
           interval_days = ?, repetitions = ?,
           lapses = ?, due_at = ?, last_reviewed_at = ?, updated_at = ?
         WHERE id = ? AND user_id = ?`,
      )
      .run(
        scheduled.state,
        scheduled.ease_factor,
        scheduled.stability,
        scheduled.difficulty,
        scheduled.interval_days,
        scheduled.repetitions,
        scheduled.lapses,
        scheduled.due_at,
        now,
        now,
        cardId,
        userId,
      );

    getDb()
      .prepare(
        `INSERT INTO review_logs
           (id, user_id, card_id, rating, mode, duration_ms, interval_before, interval_after, reviewed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId(),
        userId,
        cardId,
        input.rating,
        input.mode ?? 'review',
        Math.min(input.durationMs ?? 0, 60 * 60 * 1000),
        card.interval_days,
        scheduled.interval_days,
        now,
      );

    return { card: requireCard(userId, cardId), scheduled };
  });
}

/* -------------------------------- test mode ------------------------------- */

export function startTest(userId: string, deckId: string | null) {
  if (deckId) requireDeck(userId, deckId);
  const id = newId();
  getDb()
    .prepare(
      'INSERT INTO test_sessions (id, user_id, deck_id, started_at) VALUES (?, ?, ?, ?)',
    )
    .run(id, userId, deckId, Date.now());
  return getTest(userId, id);
}

export function getTest(userId: string, testId: string) {
  const row = getDb()
    .prepare<[string, string], Record<string, unknown>>(
      'SELECT * FROM test_sessions WHERE id = ? AND user_id = ?',
    )
    .get(testId, userId);
  if (!row) throw notFound('Test session not found');
  return row;
}

/**
 * Records one answer. The server decides correctness and recomputes the score
 * from its own counters, so a client cannot post an inflated result.
 */
export function submitTestAnswer(
  userId: string,
  testId: string,
  input: { cardId: string; correct: boolean; durationMs?: number },
) {
  getTest(userId, testId);
  const card = requireCard(userId, input.cardId);

  return tx(() => {
    // Grading a test answer feeds the same scheduler: right is Good, wrong is Again.
    reviewCard(userId, card.id, {
      rating: input.correct ? 3 : 1,
      durationMs: input.durationMs,
      mode: 'test',
    });

    const row = getDb()
      .prepare<[string], { correct: number; missed: number; avg_time_ms: number }>(
        'SELECT correct, missed, avg_time_ms FROM test_sessions WHERE id = ?',
      )
      .get(testId)!;

    const answered = row.correct + row.missed;
    const correct = row.correct + (input.correct ? 1 : 0);
    const missed = row.missed + (input.correct ? 0 : 1);
    const total = correct + missed;
    const duration = Math.min(input.durationMs ?? 0, 60 * 60 * 1000);
    const avg = Math.round((row.avg_time_ms * answered + duration) / Math.max(total, 1));
    const score = total > 0 ? (correct / total) * 100 : 0;

    getDb()
      .prepare(
        'UPDATE test_sessions SET correct = ?, missed = ?, avg_time_ms = ?, score_pct = ? WHERE id = ?',
      )
      .run(correct, missed, avg, score, testId);

    return getTest(userId, testId);
  });
}

export function endTest(userId: string, testId: string) {
  getTest(userId, testId);
  getDb()
    .prepare('UPDATE test_sessions SET ended_at = ? WHERE id = ? AND user_id = ? AND ended_at IS NULL')
    .run(Date.now(), testId, userId);
  return getTest(userId, testId);
}
