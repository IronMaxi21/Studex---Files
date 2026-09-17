import { z } from 'zod';
import { getDb, tx } from '../lib/db.js';
import { badRequest } from '../lib/errors.js';
import { dayKey } from '../lib/time.js';
import { epochMs, text, uuid } from '../lib/validation.js';
import { createEvent, requireEvent, type EventRow } from './calendar.js';
import { examReadiness, timezoneFor } from './stats.js';

/**
 * The revision plan an exam writes for itself.
 *
 * Grounded in this student rather than in a generic timetable: the topics they
 * rate themselves weakest on in the matrix and the decks whose cards they keep
 * lapsing on get the most sessions, and come back more than once, spaced
 * apart. The whole thing is arithmetic over data the app already has, so it
 * needs no AI, costs nothing and gives the same plan twice — until the student
 * asks for a reshuffle, which changes the order and the days but not what is
 * weakest.
 */

export const planOptionsSchema = z.object({
  minutesPerSession: z.number().int().min(15).max(240).default(45),
  sessionsPerWeek: z.number().int().min(1).max(14).default(4),
  /** Local hour sessions are aimed at. */
  startHour: z.number().int().min(6).max(22).default(18),
  /** Any number; a different one lays the same material out differently. */
  shuffle: z.number().int().min(0).max(1_000_000).default(0),
});

const plannedSchema = z.object({
  title: text(200),
  focus: z.string().trim().max(400).nullish(),
  startsAt: epochMs,
  endsAt: epochMs,
  topicIds: z.array(uuid).max(12).default([]),
  deckId: uuid.nullish(),
});

export const acceptPlanSchema = z.object({
  sessions: z.array(plannedSchema).min(1).max(60),
});

interface Unit {
  key: string;
  kind: 'topic' | 'deck';
  title: string;
  weight: number;
  reason: string;
  topicIds: string[];
  deckId: string | null;
}

/* ------------------------------ time helpers ------------------------------ */

/** Minutes east of UTC for a zone at an instant. */
function zoneOffsetMinutes(at: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(at)).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  return Math.round((asUtc - at) / 60_000);
}

/** The instant a local wall-clock time happens on a local day. */
export function zonedInstant(key: string, hour: number, minute: number, timeZone: string): number {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  const first = guess - zoneOffsetMinutes(guess, timeZone) * 60_000;
  // Once more, in case the guess and the answer sit either side of a clock change.
  return guess - zoneOffsetMinutes(first, timeZone) * 60_000;
}

function keyAdd(key: string, days: number): string {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** A small deterministic generator, so a reshuffle number always means the same plan. */
function rng(seed: number) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/* --------------------------------- grounding ------------------------------ */

/**
 * What needs revising for an exam, weakest first. Topics come from the matrix
 * (rated low weighs most; never rated is unknown, so it weighs in the middle;
 * rated 5 is left out). Decks come in by how often their cards lapse.
 */
export function groundingFor(userId: string, exam: EventRow) {
  const subjectId = exam.subject_id;
  const topics = getDb()
    .prepare<[string, string | null, string | null], { id: string; name: string; unit: string | null; confidence: number }>(
      `SELECT id, name, unit, confidence FROM topics
        WHERE user_id = ? AND (? IS NULL OR subject_id = ?) AND confidence < 5
        ORDER BY CASE WHEN confidence = 0 THEN 2.5 ELSE confidence END ASC, position ASC
        LIMIT 60`,
    )
    .all(userId, subjectId, subjectId);

  const decks = getDb()
    .prepare<[string, string | null, string | null], { id: string; title: string; lapses: number; lapsed_cards: number; cards: number }>(
      `SELECT f.id, f.title, SUM(c.lapses) AS lapses,
              SUM(CASE WHEN c.lapses > 0 THEN 1 ELSE 0 END) AS lapsed_cards, COUNT(*) AS cards
         FROM cards c
         JOIN files f ON f.id = c.deck_id
         LEFT JOIN folders fo ON fo.id = f.folder_id
        WHERE c.user_id = ? AND c.suspended = 0 AND f.trashed_at IS NULL
          AND (? IS NULL OR fo.subject_id = ?)
        GROUP BY f.id
       HAVING cards > 0
        ORDER BY lapses DESC
        LIMIT 20`,
    )
    .all(userId, subjectId, subjectId);

  const readiness = examReadiness(userId).find((r) => r.event_id === exam.id) ?? null;
  return { subjectId, topics, decks, readiness };
}

function unitsFrom(grounding: ReturnType<typeof groundingFor>): Unit[] {
  const units: Unit[] = [];
  // Topics that share a unit heading and are equally weak revise well together;
  // one session each for the weakest, grouped in twos for the rest.
  const byConfidence = grounding.topics;
  for (let i = 0; i < byConfidence.length; ) {
    const topic = byConfidence[i]!;
    const weak = topic.confidence >= 1 && topic.confidence <= 2;
    const next = byConfidence[i + 1];
    const pair = !weak && next && next.unit === topic.unit && next.confidence === topic.confidence;
    const group = pair ? [topic, next!] : [topic];
    const weight = topic.confidence === 0 ? 3 : 6 - topic.confidence;
    units.push({
      key: `t:${topic.id}`,
      kind: 'topic',
      title: group.map((t) => t.name).join(' & ').slice(0, 200),
      weight,
      reason: topic.confidence === 0
        ? 'Not yet rated in your topic matrix — find out where you stand.'
        : `Rated ${topic.confidence}/5 in your topic matrix.`,
      topicIds: group.map((t) => t.id),
      deckId: null,
    });
    i += group.length;
  }
  for (const deck of grounding.decks) {
    if (!deck.lapses) {
      units.push({
        key: `d:${deck.id}`, kind: 'deck', title: `${deck.title} — cards`, weight: 1,
        reason: `${deck.cards} cards to keep fresh.`, topicIds: [], deckId: deck.id,
      });
      continue;
    }
    units.push({
      key: `d:${deck.id}`,
      kind: 'deck',
      title: `${deck.title} — lapsed cards`,
      weight: Math.min(5, 1 + Math.ceil(deck.lapses / 6)),
      reason: `${deck.lapsed_cards} of ${deck.cards} cards lapsed, ${deck.lapses} times in all.`,
      topicIds: [],
      deckId: deck.id,
    });
  }
  return units.sort((a, b) => b.weight - a.weight);
}

/* --------------------------------- drafting ------------------------------- */

const FINAL_REVIEW = 'Mixed review — weakest first';

export function draftPlan(userId: string, examId: string, options: z.infer<typeof planOptionsSchema>, now = Date.now()) {
  const exam = requireEvent(userId, examId);
  if (exam.kind !== 'exam' && exam.kind !== 'deadline') throw badRequest('Revision plans are made for exams and deadlines.');
  if (exam.starts_at <= now) throw badRequest('That exam has already happened.');

  const tz = timezoneFor(userId);
  const grounding = groundingFor(userId, exam);
  const units = unitsFrom(grounding);
  const random = rng(options.shuffle + 1);

  // The days there are: from tomorrow (today if the hour has not passed) up to
  // the day before the exam.
  const today = dayKey(now, tz);
  const examDay = dayKey(exam.starts_at, tz);
  const firstDay = zonedInstant(today, options.startHour, 0, tz) > now + 30 * 60_000 ? today : keyAdd(today, 1);
  const days: string[] = [];
  for (let key = firstDay; key < examDay && days.length < 180; key = keyAdd(key, 1)) days.push(key);
  if (!days.length) throw badRequest('There is no day left before that exam to plan on.');

  const weeks = days.length / 7;
  const capacity = Math.max(1, Math.min(60, Math.round(weeks * options.sessionsPerWeek), days.length));

  // Which days: spread evenly, and a reshuffle nudges each pick by a day.
  const chosen = new Set<number>();
  const gap = days.length / capacity;
  for (let i = 0; i < capacity; i += 1) {
    let at = Math.min(days.length - 1, Math.floor(i * gap + (options.shuffle ? random() * gap : gap / 2)));
    while (chosen.has(at) && at < days.length - 1) at += 1;
    while (chosen.has(at) && at > 0) at -= 1;
    chosen.add(at);
  }
  const sessionDays = [...chosen].sort((a, b) => a - b).map((i) => days[i]!);

  // What goes on them: the last session (two, if there is room) is mixed review;
  // the rest are dealt from the units by weight, never the same unit twice in a row
  // and repeats pushed as far apart as they will go.
  const reviewSlots = sessionDays.length >= 6 ? 2 : sessionDays.length >= 2 ? 1 : 0;
  const slots = sessionDays.length - reviewSlots;
  const agenda: (Unit | null)[] = [];
  if (units.length) {
    const ordered = options.shuffle
      ? [...units].sort((a, b) => b.weight - a.weight || random() - 0.5)
      : units;
    const totalWeight = ordered.reduce((sum, u) => sum + u.weight, 0);
    const counts = new Map<string, number>();
    // Everyone gets one if there is room; weight decides the rest.
    for (const unit of ordered) counts.set(unit.key, slots >= ordered.length ? 1 : 0);
    let left = slots - [...counts.values()].reduce((a, b) => a + b, 0);
    if (slots < ordered.length) {
      for (const unit of ordered.slice(0, slots)) counts.set(unit.key, 1);
      left = 0;
    }
    while (left > 0) {
      let best = ordered[0]!;
      let bestScore = -Infinity;
      for (const unit of ordered) {
        const score = (unit.weight / totalWeight) * slots - counts.get(unit.key)!;
        if (score > bestScore) { bestScore = score; best = unit; }
      }
      counts.set(best.key, counts.get(best.key)! + 1);
      left -= 1;
    }
    // First passes in weakness order, then second passes, and so on.
    const passes = Math.max(...counts.values());
    for (let pass = 0; pass < passes; pass += 1) {
      for (const unit of ordered) if (counts.get(unit.key)! > pass) agenda.push(unit);
    }
  } else {
    for (let i = 0; i < slots; i += 1) agenda.push(null);
  }
  for (let i = 0; i < reviewSlots; i += 1) agenda.push(null);

  const busy = getDb()
    .prepare<[string, number, number, string], { starts_at: number; ends_at: number | null }>(
      `SELECT starts_at, ends_at FROM events
        WHERE user_id = ? AND starts_at < ? AND COALESCE(ends_at, starts_at + 3600000) > ? AND all_day = 0
          AND (plan_exam_id IS NULL OR plan_exam_id != ?)`,
    )
    .all(userId, exam.starts_at, now, exam.id);
  const length = options.minutesPerSession * 60_000;

  /** The aimed-for hour, or the first free quarter-hour after whatever is in the way that evening. */
  const placeOn = (key: string): number | null => {
    let start = zonedInstant(key, options.startHour, 0, tz);
    const latest = zonedInstant(key, 22, 30, tz) - length;
    for (let guard = 0; guard < 12; guard += 1) {
      const clash = busy.find((e) => e.starts_at < start + length && (e.ends_at ?? e.starts_at + 3_600_000) > start);
      if (!clash) return start <= Math.max(latest, zonedInstant(key, options.startHour, 0, tz)) ? start : null;
      const end = clash.ends_at ?? clash.starts_at + 3_600_000;
      start = Math.ceil(end / 900_000) * 900_000;
    }
    return null;
  };

  const sessions = sessionDays.map((key, i) => {
    let startsAt = placeOn(key);
    // A full evening moves the session a day earlier, if that day is free.
    if (startsAt === null) {
      const earlier = keyAdd(key, -1);
      startsAt = earlier >= firstDay && !sessionDays.includes(earlier) ? placeOn(earlier) : null;
    }
    startsAt ??= zonedInstant(key, options.startHour, 0, tz);
    const unit = agenda[i] ?? null;
    const repeat = unit ? agenda.slice(0, i).filter((u) => u?.key === unit.key).length : 0;
    const topNames = grounding.topics.filter((t) => t.confidence >= 1 && t.confidence <= 2).slice(0, 3).map((t) => t.name);
    return {
      title: unit ? unit.title : `${FINAL_REVIEW} for ${exam.title}`.slice(0, 200),
      focus: unit
        ? `${repeat ? 'Second look — recall first, then check. ' : ''}${unit.reason}${unit.kind === 'topic' ? ' Close the notes and write out what you know, then fill the gaps.' : ' Review the lapsed cards until each one sticks.'}`.slice(0, 400)
        : topNames.length
          ? `Mixed questions across everything, starting with ${topNames.join(', ')}.`
          : 'A timed past paper or mixed questions across the whole course.',
      startsAt,
      endsAt: startsAt + length,
      topicIds: unit?.topicIds ?? [],
      deckId: unit?.deckId ?? null,
      kind: unit ? unit.kind : 'review',
    };
  });

  return {
    exam: { id: exam.id, title: exam.title, starts_at: exam.starts_at, subject_id: exam.subject_id },
    grounding: {
      weak_topics: grounding.topics.filter((t) => t.confidence >= 1 && t.confidence <= 2).length,
      unrated_topics: grounding.topics.filter((t) => t.confidence === 0).length,
      topics: grounding.topics.length,
      lapsed_decks: grounding.decks.filter((d) => d.lapses > 0).length,
      readiness: grounding.readiness?.readiness ?? null,
      mastery_pct: grounding.readiness?.mastery_pct ?? null,
    },
    shuffle: options.shuffle,
    sessions,
  };
}

/* ------------------------------ written plans ----------------------------- */

export function planSessions(userId: string, examId: string) {
  requireEvent(userId, examId);
  return getDb()
    .prepare<[string, string], EventRow & { plan_focus: string | null }>(
      'SELECT * FROM events WHERE user_id = ? AND plan_exam_id = ? ORDER BY starts_at ASC',
    )
    .all(userId, examId)
    .map((row) => ({ ...row, plan_focus: row.plan_focus ? JSON.parse(row.plan_focus) : null }));
}

/**
 * Writes a plan into the calendar. Any sessions an earlier plan for this exam
 * put in the future are replaced; ones already past stay, since they happened.
 */
export function acceptPlan(userId: string, examId: string, input: z.infer<typeof acceptPlanSchema>, now = Date.now()) {
  const exam = requireEvent(userId, examId);
  const db = getDb();
  return tx(() => {
    const removed = db
      .prepare('DELETE FROM events WHERE user_id = ? AND plan_exam_id = ? AND starts_at >= ?')
      .run(userId, examId, now).changes;
    const created = input.sessions.map((session) => {
      if (session.endsAt < session.startsAt) throw badRequest('A session cannot end before it starts');
      if (session.startsAt >= exam.starts_at) throw badRequest('Every session must fall before the exam');
      const event = createEvent(userId, {
        kind: 'study_block',
        title: session.title,
        subjectId: exam.subject_id,
        location: null,
        startsAt: session.startsAt,
        endsAt: session.endsAt,
        allDay: false,
        status: null,
      });
      db.prepare('UPDATE events SET plan_exam_id = ?, plan_focus = ? WHERE id = ?').run(
        examId,
        JSON.stringify({ note: session.focus ?? null, topicIds: session.topicIds, deckId: session.deckId ?? null }),
        event.id,
      );
      return event.id;
    });
    return { created: created.length, replaced: removed };
  });
}

/** Clears the plan's sessions still to come. */
export function clearPlan(userId: string, examId: string, now = Date.now()) {
  requireEvent(userId, examId);
  return getDb()
    .prepare('DELETE FROM events WHERE user_id = ? AND plan_exam_id = ? AND starts_at >= ?')
    .run(userId, examId, now).changes;
}
