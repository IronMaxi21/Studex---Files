/**
 * The AI features, and the allowance that keeps them affordable.
 *
 * Everything here follows one rule: the model is asked to *write*, never to
 * *decide*. It proposes cards, an explanation, a set of study blocks — and
 * every one of those comes back through the same zod schema, the same
 * ownership check and the same domain function that the hand-made version
 * goes through. Nothing the model returns reaches the database without being
 * parsed first, and nothing it returns can name a file the account does not
 * own, because the ids are never taken from the answer.
 */
import { z } from 'zod';
import { AiError, complete, extractJsonArray, extractJsonObject, type AiRole, type CompleteInput, type Completion } from '../lib/ai.js';
import { currentKey, keySource } from '../lib/ai-key.js';
import { config } from '../lib/config.js';
import { getDb, tx } from '../lib/db.js';
import { badRequest, notFound, planLimit } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { epochMs, text, uuid } from '../lib/validation.js';
import * as calendar from './calendar.js';
import * as documents from './documents.js';
import * as flashcards from './flashcards.js';
import * as library from './library.js';
import { groundingFor } from './revision.js';
import * as pdf from './pdf.js';
import * as topics from './topics.js';

/** Whether this install can do any of it at all. */
export function available(): boolean {
  return currentKey() !== null;
}

/**
 * Which model does what.
 *
 * Reader: long specification documents in, structure out. Needs the long
 * context and benefits from thinking first. Writer: anything a student reads —
 * cards, questions, explanations. Checker: short, literal judgements over a
 * list — does this cover the source, are these two the same topic, does this
 * plan hang together.
 */
export const ROLE_OF = {
  spec_import: 'reader',
  spec_check: 'checker',
  cards: 'writer',
  explain: 'writer',
  quiz: 'writer',
  plan: 'checker',
  dedupe: 'checker',
  chat: 'writer',
} as const satisfies Record<string, AiRole>;

export type AiFeature = 'spec_import' | 'cards' | 'explain' | 'quiz' | 'plan' | 'dedupe' | 'chat';

/**
 * What one request takes out of the month. A specification import is many
 * calls over a long document, and counting it the same as one explanation
 * would make the allowance mean nothing.
 */
export const WEIGHT: Record<AiFeature, number> = {
  spec_import: 5,
  cards: 1,
  explain: 1,
  quiz: 1,
  plan: 1,
  dedupe: 1,
  chat: 1,
};

/* ------------------------------- allowance -------------------------------- */

/**
 * The calendar month, in UTC.
 *
 * UTC rather than local time because the server has no idea what the person's
 * local time is, and a month boundary that moves with whoever is asking is a
 * month boundary two devices can disagree about.
 */
function period(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

const OWN_KEY_MONTHLY_REQUESTS = 1_000;

function monthlyLimit(userId: string): number {
  const row = getDb()
    .prepare<[string], { plan: 'free' | 'pro' }>('SELECT plan FROM users WHERE id = ?')
    .get(userId);
  if (!row) throw notFound('User not found');
  // A key pasted into this install's own Settings is the owner's own account,
  // spending their own credit on their own Mac: the allowance is there to stop
  // a loop, not to ration them.
  const base = keySource() === 'settings'
    ? Math.max(config.aiMonthlyRequests, OWN_KEY_MONTHLY_REQUESTS)
    : config.aiMonthlyRequests;
  return row.plan === 'pro' ? base * config.proQuotaMultiplier : base;
}

export function usageFor(userId: string, now = Date.now()) {
  const limit = monthlyLimit(userId);
  const row = getDb()
    .prepare<[string, string], { requests: number }>(
      'SELECT requests FROM ai_usage WHERE user_id = ? AND period = ?',
    )
    .get(userId, period(now));
  const used = row?.requests ?? 0;
  return { period: period(now), used, limit, remaining: Math.max(0, limit - used) };
}

/**
 * Takes one request out of the month's allowance, before the request is made.
 *
 * Claimed up front rather than billed afterwards, because a call that fails
 * halfway still cost the money, and because counting after the fact leaves a
 * window in which two requests both see the last slot free. The row is written
 * in the same statement that reads it, so the check and the spend cannot be
 * separated by anything.
 */
function claimRequest(userId: string, now: number, weight: number): void {
  const limit = monthlyLimit(userId);
  // A fresh row is inserted without the WHERE below ever running, so a request
  // heavier than the whole allowance has to be refused before it.
  const claimed = weight <= limit && tx(() => {
    const result = getDb()
      .prepare(
        `INSERT INTO ai_usage (user_id, period, requests, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, period) DO UPDATE SET
           requests   = requests + excluded.requests,
           updated_at = excluded.updated_at
         WHERE requests + excluded.requests <= ?`,
      )
      .run(userId, period(now), weight, now, limit);
    return result.changes > 0;
  });

  if (!claimed) {
    throw planLimit(
      `You have used all ${limit} AI requests for this month. `
        + 'The allowance resets on the first, and Pro carries five times as many.',
      { kind: 'ai', limit, plan: 'monthly' },
    );
  }
}

/** What the call actually cost, recorded against the request already claimed. */
function recordTokens(userId: string, now: number, inputTokens: number, outputTokens: number): void {
  getDb()
    .prepare(
      `UPDATE ai_usage
          SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, updated_at = ?
        WHERE user_id = ? AND period = ?`,
    )
    .run(inputTokens, outputTokens, now, userId, period(now));
}

/**
 * A claimed request that turned out to be unusable is given back.
 *
 * Only for failures that cost nothing — the model was unreachable, or the
 * install has no key. A refusal that the model was paid for stays spent.
 */
function refundRequest(userId: string, now: number, weight: number): void {
  getDb()
    .prepare(
      `UPDATE ai_usage SET requests = MAX(0, requests - ?), updated_at = ?
        WHERE user_id = ? AND period = ?`,
    )
    .run(weight, now, userId, period(now));
}

/** A model call made on someone's behalf, logged as it happens. */
export interface Ask {
  (input: Omit<CompleteInput, 'onAttempt'>): Promise<Completion>;
  /**
   * The same, parsed. An answer that does not parse is asked for once more,
   * with the reason, before it counts as a failure: models that mostly follow
   * a format do occasionally close a bracket too early, and a second try is
   * far cheaper than making someone press the button again.
   */
  parsed<T>(input: Omit<CompleteInput, 'onAttempt'>, parse: (text: string) => T): Promise<T>;
}

/**
 * Claims the allowance, runs the feature, and logs every model call it made.
 *
 * The request is given back only when no model answered at all — unreachable,
 * or busy on both the first choice and the backup. Once a model has answered,
 * the call was made and counts, whatever was done with the answer.
 */
export async function spend<T>(userId: string, feature: AiFeature, run: (ask: Ask) => Promise<T>): Promise<T> {
  if (!available()) throw badRequest('This install of Studex has no AI configured.');
  const now = Date.now();
  const weight = WEIGHT[feature];
  claimRequest(userId, now, weight);

  let answered = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const log = getDb().prepare(
    `INSERT INTO ai_calls
       (id, user_id, feature, role, model, ok, status, error, input_tokens, output_tokens, cost, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const ask = (async (input) => {
    const result = await complete({
      ...input,
      onAttempt: (a) => {
        if (a.ok) answered += 1;
        inputTokens += a.inputTokens;
        outputTokens += a.outputTokens;
        log.run(newId(), userId, feature, input.role, a.model, a.ok ? 1 : 0, a.status, a.error,
          a.inputTokens, a.outputTokens, a.cost, a.durationMs, Date.now());
      },
    });
    return result;
  }) as Ask;

  ask.parsed = async (input, parse) => {
    const first = await ask(input);
    try {
      return parse(first.text);
    } catch (err) {
      if (!(err instanceof AiError)) throw err;
      const second = await ask({
        ...input,
        prompt: `${input.prompt}\n\nYour previous answer could not be used (${err.message}). `
          + 'Reply again with only the JSON described, and nothing before or after it.',
      });
      return parse(second.text);
    }
  };

  try {
    const value = await run(ask);
    recordTokens(userId, now, inputTokens, outputTokens);
    return value;
  } catch (err) {
    const unanswered = err instanceof AiError
      && answered === 0
      && (err.status === null || err.status === 429 || err.status >= 500);
    if (unanswered) refundRequest(userId, now, weight);
    else recordTokens(userId, now, inputTokens, outputTokens);
    throw err;
  }
}

/** The last few model calls, for the Settings screen. */
export function recentCalls(userId: string, limit = 30) {
  return getDb()
    .prepare<[string, number], {
      id: string; feature: string; role: string; model: string; ok: number; status: number | null;
      error: string | null; input_tokens: number; output_tokens: number; cost: number;
      duration_ms: number; created_at: number;
    }>(
      `SELECT id, feature, role, model, ok, status, error, input_tokens, output_tokens, cost, duration_ms, created_at
         FROM ai_calls WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(userId, limit)
    .map((row) => ({ ...row, ok: row.ok === 1 }));
}

/* ------------------------------ source text ------------------------------- */

const MAX_SOURCE_CHARS = 24_000;

export const sourceSchema = z.discriminatedUnion('from', [
  z.object({ from: z.literal('text'), text: text(MAX_SOURCE_CHARS) }),
  z.object({ from: z.literal('document'), fileId: uuid }),
  z.object({
    from: z.literal('pdf'),
    fileId: uuid,
    fromPage: z.number().int().min(1).max(10_000).optional(),
    toPage: z.number().int().min(1).max(10_000).optional(),
  }),
]);

export type Source = z.infer<typeof sourceSchema>;

/**
 * Reads the material, and refuses politely when there is none.
 *
 * The PDF case is the marked-up passages within a page range, not the file:
 * Studex stores the text of what was highlighted, not the text of the whole
 * document, and inventing an extraction pass here would produce cards about
 * page furniture. "The chapter I annotated" is both what exists and what the
 * person meant.
 */
function readSource(userId: string, source: Source): { label: string; body: string } {
  if (source.from === 'text') {
    return { label: 'the selected passage', body: source.text.trim() };
  }

  if (source.from === 'document') {
    const doc = documents.getDocument(userId, source.fileId);
    const body = documents.blocksToText(doc.blocks).trim();
    if (!body) throw badRequest('That note is empty, so there is nothing to make cards from.');
    return { label: 'the note', body: body.slice(0, MAX_SOURCE_CHARS) };
  }

  const file = library.requireFile(userId, source.fileId);
  pdf.requirePdf(userId, source.fileId);
  const from = source.fromPage ?? 1;
  const to = source.toPage ?? Number.MAX_SAFE_INTEGER;
  if (to < from) throw badRequest('The last page comes before the first.');

  const passages = pdf
    .listAnnotations(userId, source.fileId)
    .filter((a) => a.page >= from && a.page <= to)
    .map((a) => [a.quoted_text?.trim(), a.note?.trim()].filter(Boolean).join('\n— '))
    .filter((s) => s.length > 0);

  if (passages.length === 0) {
    throw badRequest(
      'There is nothing marked up in those pages yet. Highlight the parts worth learning first.',
    );
  }
  return {
    label: `“${file.title}”`,
    body: passages.join('\n\n').slice(0, MAX_SOURCE_CHARS),
  };
}

/* ------------------------------ generate cards ---------------------------- */

export const generateCardsSchema = z.object({
  deckId: uuid,
  source: sourceSchema,
  count: z.number().int().min(1).max(30).default(10),
  /** Written straight into the deck, or handed back for a look first. */
  commit: z.boolean().default(true),
});

const CARDS_SYSTEM = `You write flashcards for a student revising from their own notes.

Rules:
- One fact per card. A card that tests two things teaches neither.
- The front is a question or a prompt, never a bare term. "What does X do?" not "X".
- The back is the shortest complete answer: a sentence, sometimes a short list.
- Use only what is in the material. Do not add facts, examples or figures that are not there.
- Keep the source's own vocabulary. If it says "mitochondrion", so do you.
- Skip anything that is administrative rather than examinable: page numbers, dates of lectures, "see chapter 4".
- If the material is too thin for the number asked for, return fewer. Never pad.

Reply with a JSON array and nothing else. Each element:
{"front": string, "back": string, "topic": string}
"topic" is two or three words naming the sub-area, for grouping.`;

const generatedCardSchema = z.object({
  front: z.string().trim().min(1).max(500),
  back: z.string().trim().min(1).max(2_000),
  topic: z.string().trim().max(80).optional(),
});

export async function generateCards(
  userId: string,
  input: z.infer<typeof generateCardsSchema>,
): Promise<{ created: number; cardIds: string[]; cards: Array<z.infer<typeof generatedCardSchema>> }> {
  // Both checks before a token is spent: a deck that does not exist, or a
  // source that cannot be read, should cost nothing.
  flashcards.requireDeck(userId, input.deckId);
  const source = readSource(userId, input.source);

  return spend(userId, 'cards', async (ask) => {
    const answer = await ask.parsed({
      role: ROLE_OF.cards,
      system: CARDS_SYSTEM,
      // Zero, because two runs over the same chapter producing different cards
      // is not creativity, it is a deck that cannot be regenerated.
      temperature: 0,
      maxTokens: 4_000,
      prompt: `Write at most ${input.count} flashcards from ${source.label}.\n\n---\n${source.body}\n---`,
    }, extractJsonArray);

    // Anything malformed is dropped rather than failing the batch: nine good
    // cards and one the model garbled is nine cards, not an error.
    const cards = answer
      .map((raw) => generatedCardSchema.safeParse(raw))
      .filter((r): r is { success: true; data: z.infer<typeof generatedCardSchema> } => r.success)
      .map((r) => r.data)
      .slice(0, input.count);

    if (cards.length === 0) throw new AiError('No usable cards came back from that material.', null, false);

    const cardIds: string[] = [];
    if (input.commit) {
      const sourceFileId = input.source.from === 'text' ? null : input.source.fileId;
      tx(() => {
        for (const card of cards) {
          cardIds.push(
            flashcards.createCard(userId, {
              deckId: input.deckId,
              front: card.front,
              back: card.back,
              topic: card.topic || null,
              sourceFileId,
            }).id,
          );
        }
      });
    }

    return { created: cardIds.length, cardIds, cards };
  });
}

/* -------------------------------- explain --------------------------------- */

export const explainSchema = z
  .object({
    text: text(6_000).optional(),
    fileId: uuid.optional(),
    annotationId: uuid.optional(),
    question: text(300).optional(),
  })
  .refine((v) => Boolean(v.text) || Boolean(v.fileId && v.annotationId), {
    message: 'Give either some text or an annotation to explain',
  });

const EXPLAIN_SYSTEM = `You explain a passage to a student who is reading it right now and did not follow it.

Rules:
- Answer in two or three short paragraphs. No headings, no bullet lists, no preamble.
- Start with the idea itself, not with "This passage discusses…".
- Define the jargon the passage uses, in the passage's own terms.
- Where the passage assumes something it never states, say what it is assuming.
- If the passage is too short or too garbled to explain, say so plainly in one sentence.
- Do not invent context that is not in the passage. You are looking at a fragment and you know it.`;

export async function explain(
  userId: string,
  input: z.infer<typeof explainSchema>,
): Promise<{ answer: string; passage: string }> {
  let passage = input.text?.trim() ?? '';
  let around = '';

  if (input.fileId && input.annotationId) {
    const file = library.requireFile(userId, input.fileId);
    pdf.requirePdf(userId, input.fileId);
    pdf.requireAnnotationInFile(userId, input.fileId, input.annotationId);
    const annotation = pdf.requireAnnotation(userId, input.annotationId);
    passage = annotation.quoted_text?.trim() || passage;
    if (annotation.note?.trim()) around = `\n\nThe reader's own note on it: ${annotation.note.trim()}`;
    around += `\n\nIt is on page ${annotation.page} of “${file.title}”.`;
  }

  if (!passage) {
    throw badRequest('There is no text on that highlight to explain.');
  }

  return spend(userId, 'explain', async (ask) => {
    const answer = await ask({
      role: ROLE_OF.explain,
      system: EXPLAIN_SYSTEM,
      maxTokens: 900,
      temperature: 0.4,
      prompt: input.question
        ? `${input.question}\n\nThe passage:\n---\n${passage}\n---${around}`
        : `Explain this passage.\n\n---\n${passage}\n---${around}`,
    });
    return { answer: answer.text, passage };
  });
}

/* ----------------------------- revision plan ------------------------------ */

const DAY_MS = 24 * 60 * 60 * 1000;

export const revisionPlanSchema = z
  .object({
    /** A pasted syllabus, or a reading list, or the contents page of a textbook. */
    syllabus: text(12_000).optional(),
    /** An exam already in the calendar. Its title and date are read from it. */
    examEventId: uuid.optional(),
    examTitle: text(200).optional(),
    examAt: epochMs.optional(),
    minutesPerSession: z.number().int().min(15).max(240).default(45),
    sessionsPerWeek: z.number().int().min(1).max(21).default(5),
    /** The hour of the day sessions start, local to whoever is asking. */
    startHour: z.number().int().min(0).max(23).default(18),
    /** Minutes to add to a UTC time to get the asker's local time. */
    utcOffsetMinutes: z.number().int().min(-840).max(840).default(0),
    commit: z.boolean().default(false),
  })
  .refine((v) => Boolean(v.examEventId) || Boolean(v.examTitle && v.examAt), {
    message: 'Name the exam and when it is, or point at one in the calendar',
  });

const PLAN_SYSTEM = `You turn a syllabus into an ordered revision schedule.

Rules:
- Break the material into topics of roughly one session each. Split a large topic; merge two tiny ones.
- Order them so that anything depended on is revised before the thing that depends on it.
- The last two sessions before the exam are review of what came earliest, not new material.
- Titles are what the student will read in their calendar: "Enzyme kinetics", not "Session 4: revision of enzyme kinetics".
- The "focus" is one sentence saying what to actually do — recall, past paper, worked problems, re-read and summarise.
- Never produce more sessions than you are asked for. Fewer is fine if the material is thin.

Reply with a JSON array and nothing else. Each element:
{"title": string, "focus": string}
The array is in the order the sessions should happen.`;

const plannedSessionSchema = z.object({
  title: z.string().trim().min(1).max(120),
  focus: z.string().trim().max(400).optional(),
});

/**
 * Lays sessions out on real days.
 *
 * The model is asked for an ordered list of topics and nothing else — not
 * dates. Dates are arithmetic, and a model doing arithmetic over a calendar
 * produces a plan with two sessions on the 31st of September. The spacing is
 * done here, where the exam date and the week are known exactly.
 */
function scheduleSessions(
  count: number,
  opts: { from: number; examAt: number; sessionsPerWeek: number; startHour: number; utcOffsetMinutes: number },
): number[] {
  const offset = opts.utcOffsetMinutes * 60 * 1000;
  // The last full day before the exam is the last one worth scheduling on.
  const lastDay = Math.floor((opts.examAt - offset) / DAY_MS) - 1;
  const firstDay = Math.floor((opts.from - offset) / DAY_MS);
  const daysAvailable = Math.max(1, lastDay - firstDay + 1);

  // Spread evenly across the days there are, but never denser than asked for.
  const minGap = 7 / opts.sessionsPerWeek;
  const gap = Math.max(minGap, count > 1 ? (daysAvailable - 1) / (count - 1) : 0);

  const starts: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const day = Math.min(lastDay, firstDay + Math.round(i * gap));
    starts.push(day * DAY_MS + opts.startHour * 60 * 60 * 1000 + offset);
  }
  return starts;
}

/** The student's own weak spots for an exam, as lines a model can weigh. */
function groundingNotes(userId: string, exam: calendar.EventRow): string {
  const g = groundingFor(userId, exam);
  const lines: string[] = [];
  const rated = g.topics.filter((t) => t.confidence > 0).slice(0, 15);
  if (rated.length) lines.push(`Self-rated confidence (1 weakest, 5 strongest): ${rated.map((t) => `${t.name} ${t.confidence}/5`).join('; ')}.`);
  const unrated = g.topics.filter((t) => t.confidence === 0).slice(0, 10);
  if (unrated.length) lines.push(`Not yet rated: ${unrated.map((t) => t.name).join('; ')}.`);
  const lapsed = g.decks.filter((d) => d.lapses > 0).slice(0, 6);
  if (lapsed.length) lines.push(`Flashcard decks forgotten most: ${lapsed.map((d) => `${d.title} (${d.lapses} lapses)`).join('; ')}.`);
  if (g.readiness) lines.push(`Mastery for this subject: ${g.readiness.mastery_pct}%.`);
  return lines.join('\n').slice(0, 3_000);
}

export async function revisionPlan(
  userId: string,
  input: z.infer<typeof revisionPlanSchema>,
): Promise<{
  exam: { title: string; at: number };
  sessions: Array<{ title: string; focus: string | null; startsAt: number; endsAt: number }>;
  created: number;
}> {
  let examTitle = input.examTitle ?? '';
  let examAt = input.examAt ?? 0;

  let studentNotes = '';
  if (input.examEventId) {
    const event = calendar.requireEvent(userId, input.examEventId);
    examTitle = event.title;
    examAt = event.starts_at;
    studentNotes = groundingNotes(userId, event);
  }

  const now = Date.now();
  if (examAt <= now) throw badRequest('That exam has already happened.');

  const days = Math.max(1, Math.floor((examAt - now) / DAY_MS));
  const capacity = Math.max(1, Math.min(60, Math.round((days / 7) * input.sessionsPerWeek)));

  const material = input.syllabus?.trim()
    || `The student gave no syllabus. Produce a revision schedule for “${examTitle}” from the title alone, `
      + 'covering the topics such a course would normally contain, and say so in the focus of the first session.';

  return spend(userId, 'plan', async (ask) => {
    const answer = await ask.parsed({
      role: ROLE_OF.plan,
      system: PLAN_SYSTEM,
      temperature: 0,
      maxTokens: 3_000,
      prompt:
        `The exam is “${examTitle}”, in ${days} day${days === 1 ? '' : 's'}. `
        + `There is room for ${capacity} session${capacity === 1 ? '' : 's'} of `
        + `${input.minutesPerSession} minutes.\n\nThe material:\n---\n${material}\n---`
        + (studentNotes ? `\n\nWhere this student actually stands (give the weakest more sessions, and revisit them):\n${studentNotes}` : ''),
    }, extractJsonArray);

    const planned = answer
      .map((raw) => plannedSessionSchema.safeParse(raw))
      .filter((r): r is { success: true; data: z.infer<typeof plannedSessionSchema> } => r.success)
      .map((r) => r.data)
      .slice(0, capacity);

    if (planned.length === 0) throw new AiError('No usable plan came back from that syllabus.', null, false);

    const starts = scheduleSessions(planned.length, {
      from: now,
      examAt,
      sessionsPerWeek: input.sessionsPerWeek,
      startHour: input.startHour,
      utcOffsetMinutes: input.utcOffsetMinutes,
    });

    const sessions = planned.map((session, i) => ({
      title: session.title,
      focus: session.focus || null,
      startsAt: starts[i]!,
      endsAt: starts[i]! + input.minutesPerSession * 60 * 1000,
    }));

    // Nothing is written unless asked. A plan is a suggestion until someone
    // has looked at it, and twenty study blocks appearing in a calendar
    // unbidden is a worse outcome than one extra click.
    let created = 0;
    if (input.commit) {
      tx(() => {
        for (const session of sessions) {
          calendar.createEvent(userId, {
            kind: 'study_block',
            title: session.title,
            location: session.focus?.slice(0, 120) ?? null,
            startsAt: session.startsAt,
            endsAt: session.endsAt,
            allDay: false,
            status: 'drafting',
          });
          created += 1;
        }
      });
    }

    return { exam: { title: examTitle, at: examAt }, sessions, created };
  });
}

/* ------------------------- specification import --------------------------- */

/** One page of text, as the app pulled it out of a PDF or a Word file. */
export const specUnpackSchema = z.object({
  subjectId: uuid.nullish(),
  fileName: text(200),
  pages: z
    .array(z.object({
      page: z.number().int().min(1).max(10_000),
      text: z.string().max(40_000),
    }))
    .min(1)
    .max(1_500),
});

/** More than any real specification, and less than a textbook. */
const MAX_SPEC_CHARS = 900_000;
/** A chunk the Reader takes in one go: about a unit of a typical specification. */
const CHUNK_CHARS = 14_000;
const MAX_CHUNKS = 30;
const READER_CONCURRENCY = 3;

const UNIT_HEADING = /^\s*(unit|topic|module|paper|section|component|theme|area of study)\s+[0-9ivx]+\b/im;

interface SpecChunk {
  fromPage: number;
  toPage: number;
  body: string;
}

/**
 * Cuts the document into pieces the Reader can take whole.
 *
 * Always at a page boundary, so every page the Reader is shown is shown
 * complete, and preferably just before a page that starts a new unit, so a unit
 * is rarely split across two readings. A page is marked with its number, which
 * is how a topic knows where it came from without the model counting.
 */
export function chunkSpec(pages: Array<{ page: number; text: string }>): SpecChunk[] {
  const usable = pages
    .map((p) => ({ page: p.page, text: p.text.replace(/[ \t]+\n/g, '\n').trim() }))
    .filter((p) => p.text.length > 0)
    .sort((a, b) => a.page - b.page);

  const total = usable.reduce((n, p) => n + p.text.length, 0);
  const target = Math.max(CHUNK_CHARS, Math.ceil(total / MAX_CHUNKS));

  const chunks: SpecChunk[] = [];
  let current: SpecChunk | null = null;
  for (const p of usable) {
    const marked = `[[page ${p.page}]]\n${p.text}`;
    const startsUnit = UNIT_HEADING.test(p.text.slice(0, 200));
    const full = current && current.body.length + marked.length > target;
    const wellStarted = current && startsUnit && current.body.length > target / 2;
    if (!current || full || wellStarted) {
      if (current) chunks.push(current);
      current = { fromPage: p.page, toPage: p.page, body: marked };
    } else {
      current.body += `\n\n${marked}`;
      current.toPage = p.page;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

const READER_SYSTEM = `You read an exam-board specification (a syllabus) and list what a student must learn from it.

Rules:
- A topic is one examinable piece of content, the size of one revision session or smaller. "3.1.2 Enzyme action" is a topic. "Biology" is not, and neither is "Assessment objectives".
- Use the specification's own reference numbers and its own wording. Do not rename, summarise or merge topics that the document lists separately.
- Group topics under the unit, paper or section heading they appear under, using that heading's own wording.
- Skip everything that is not content to learn: introductions, assessment rules, command words, grade descriptors, contents pages, page furniture, contact details, appendices of formulae unless listed as content.
- Each page begins with a marker like [[page 12]]. Give the page number of the page the topic appears on.
- If a topic has no reference number, use null.
- If this part of the document contains no topics, reply with an empty list of units.

Reply with JSON only, in exactly this shape:
{"units":[{"unit":"Unit 1: Biological molecules","topics":[{"ref":"1.1","name":"Monomers and polymers","page":7}]}]}`;

const readerAnswerSchema = z.object({
  units: z.array(z.object({
    unit: z.string().trim().max(200).nullish(),
    topics: z.array(z.object({
      ref: z.union([z.string(), z.number()]).nullish(),
      name: z.string(),
      page: z.union([z.number(), z.string()]).nullish(),
    }).passthrough()).max(400),
  }).passthrough()).max(80),
});

export interface ProposedTopic {
  ref: string | null;
  name: string;
  page: number | null;
  flags: Array<{ issue: 'duplicate' | 'not_a_topic' | 'unclear'; note: string }>;
}

export interface ProposedUnit {
  unit: string;
  topics: ProposedTopic[];
}

function cleanRef(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const ref = String(raw).trim().replace(/[.:)]+$/, '');
  return ref && ref.length <= 40 ? ref : null;
}

const normal = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Numbered references the document plainly contains, found without a model.
 *
 * A line that starts "3.1.2  Enzyme action" is a topic whether or not the
 * Reader noticed it. Comparing this list with what came back is what turns
 * "the model seemed thorough" into "these eleven lines were not picked up".
 */
export function referencesIn(chunks: SpecChunk[]): Map<string, { name: string; page: number }> {
  const found = new Map<string, { name: string; page: number }>();
  const line = /^\s*(\d{1,2}(?:\.\d{1,3}){1,3})\.?\s+([A-Z][^\n]{2,119})$/gm;
  for (const chunk of chunks) {
    for (const part of chunk.body.split(/\[\[page (\d+)\]\]\n/).reduce<Array<[number, string]>>((acc, piece, i, all) => {
      if (i % 2 === 1) acc.push([Number(piece), all[i + 1] ?? '']);
      return acc;
    }, [])) {
      const [page, body] = part;
      for (const m of body.matchAll(line)) {
        const ref = m[1]!;
        const name = m[2]!.trim();
        // A heading full of dots is a contents page entry, not the content.
        if (/\.{4,}|\s\d+$/.test(name)) continue;
        if (!found.has(ref)) found.set(ref, { name: name.slice(0, 160), page });
      }
    }
  }
  return found;
}

const CHECKER_SPEC_SYSTEM = `You check a list of topics that were extracted from an exam specification.

Flag only real problems:
- "duplicate": the same content as another item in the list. Say which one in the note.
- "not_a_topic": not examinable content (an assessment rule, a heading with nothing under it, page furniture).
- "unclear": the name is garbled or cut off, so a student could not tell what to revise.

Most items are fine. Do not flag an item just because it is short or broad.

Reply with JSON only: {"flags":[{"index":4,"issue":"duplicate","note":"same as 3"}]}
An empty list is a good answer: {"flags":[]}`;

const checkerFlagSchema = z.object({
  index: z.coerce.number().int().min(0),
  issue: z.enum(['duplicate', 'not_a_topic', 'unclear']),
  note: z.string().trim().max(200).default(''),
});

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Reads a specification into a proposed list of topics. Nothing is saved: the
 * app shows the list, the student edits it, and the import goes through the
 * same `importTopics` a pasted list does.
 */
export async function unpackSpec(userId: string, input: z.infer<typeof specUnpackSchema>) {
  if (input.subjectId) library.requireSubject(userId, input.subjectId);

  const total = input.pages.reduce((n, p) => n + p.text.length, 0);
  if (total > MAX_SPEC_CHARS) {
    throw badRequest('That document is longer than any specification. Import the part with the content in it.');
  }
  const chunks = chunkSpec(input.pages);
  if (chunks.length === 0 || total < 200) {
    throw badRequest('There is no text in that file to read. A scanned PDF has pictures of words, not words.');
  }

  return spend(userId, 'spec_import', async (ask) => {
    let lastError: unknown = null;
    const readings = await mapLimit(chunks, READER_CONCURRENCY, async (chunk) => {
      try {
        const answer = await ask.parsed({
          role: ROLE_OF.spec_import,
          system: READER_SYSTEM,
          temperature: 0,
          maxTokens: 12_000,
          json: true,
          prompt: `From “${input.fileName}”, pages ${chunk.fromPage}–${chunk.toPage}:\n\n${chunk.body}`,
        }, (t) => {
          const parsed = readerAnswerSchema.safeParse(extractJsonObject(t));
          if (!parsed.success) throw new AiError('The answer was not in the shape asked for.', null, true);
          return parsed.data;
        });
        return { chunk, answer, error: null as string | null };
      } catch (err) {
        if (!(err instanceof AiError)) throw err;
        lastError = err;
        return { chunk, answer: null, error: err.message };
      }
    });

    const read = readings.filter((r) => r.answer);
    if (read.length === 0) throw lastError ?? new AiError('The specification could not be read.', null, true);

    // Units are merged by name across readings, because a unit that straddles
    // two chunks comes back twice. Topics within a unit by reference, or by
    // name where there is none.
    const units: ProposedUnit[] = [];
    const unitByName = new Map<string, ProposedUnit>();
    const seen = new Set<string>();
    for (const { chunk, answer } of read) {
      for (const u of answer!.units) {
        const title = (u.unit?.trim() || 'Other topics').slice(0, 80);
        let unit = unitByName.get(normal(title));
        if (!unit) {
          unit = { unit: title, topics: [] };
          unitByName.set(normal(title), unit);
          units.push(unit);
        }
        for (const t of u.topics) {
          const name = t.name.trim().replace(/\s+/g, ' ').slice(0, 160);
          if (!name) continue;
          const ref = cleanRef(t.ref);
          const key = `${normal(title)}|${ref ?? normal(name)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const pageNum = Number(t.page);
          const page = Number.isInteger(pageNum) && pageNum >= chunk.fromPage && pageNum <= chunk.toPage ? pageNum : null;
          unit.topics.push({ ref, name, page, flags: [] });
        }
      }
    }
    const kept = units.filter((u) => u.topics.length > 0);

    const extractedRefs = kept.flatMap((u) => u.topics.map((t) => t.ref).filter((r): r is string => Boolean(r)));
    const missing = [...referencesIn(chunks)]
      .filter(([ref]) => !extractedRefs.some((got) => got === ref || got.startsWith(`${ref}.`)))
      .slice(0, 100)
      .map(([ref, v]) => ({ ref, name: v.name, page: v.page }));

    // The check is worth having and not worth failing over: a list the Reader
    // produced is still a list the student can edit.
    const flat = kept.flatMap((u) => u.topics.map((t) => ({ unit: u.unit, topic: t })));
    let checked = flat.length > 0;
    for (let start = 0; start < flat.length && checked; start += 150) {
      const batch = flat.slice(start, start + 150);
      try {
        const flags = await ask.parsed({
          role: ROLE_OF.spec_check,
          system: CHECKER_SPEC_SYSTEM,
          temperature: 0,
          maxTokens: 2_000,
          json: true,
          prompt: batch.map((item, i) => `${i}. [${item.unit}] ${item.topic.ref ?? ''} ${item.topic.name}`.replace(/\s+/g, ' ')).join('\n'),
        }, (t) => {
          const raw = extractJsonObject(t).flags;
          if (!Array.isArray(raw)) throw new AiError('The model did not answer with a list.', null, true);
          return raw;
        });
        for (const raw of flags) {
          const flag = checkerFlagSchema.safeParse(raw);
          if (!flag.success) continue;
          const item = batch[flag.data.index];
          if (item && !item.topic.flags.some((f) => f.issue === flag.data.issue)) {
            item.topic.flags.push({ issue: flag.data.issue, note: flag.data.note });
          }
        }
      } catch (err) {
        if (!(err instanceof AiError)) throw err;
        checked = false;
      }
    }

    return {
      fileName: input.fileName,
      units: kept,
      topicCount: flat.length,
      missing,
      unread: readings
        .filter((r) => !r.answer)
        .map((r) => ({ fromPage: r.chunk.fromPage, toPage: r.chunk.toPage, reason: r.error })),
      checked,
      chunks: chunks.length,
    };
  });
}

/* ---------------------------------- quiz ---------------------------------- */

export const quizSchema = z
  .object({
    source: sourceSchema.optional(),
    topicId: uuid.optional(),
    count: z.number().int().min(1).max(20).default(5),
    mode: z.enum(['choice', 'truefalse', 'short', 'exam']).default('choice'),
  })
  .refine((v) => Boolean(v.source) !== Boolean(v.topicId), { message: 'Quiz either some material or a topic' });

const QUIZ_MODE_SYSTEM = {
  truefalse: `You write true-or-false statements for a student testing themselves.

Rules:
- Each statement tests one thing that matters, not a trivial detail.
- About half are false. A false statement is a plausible misconception, not a joke or a trick of wording.
- The explanation is one or two sentences saying why it is true or false.
- When material is given, use only that material. When only a topic is named, keep to what a standard course on it covers.

Reply with JSON only:
{"questions":[{"question":"statement…","answer":true,"explanation":"…"}]}`,
  short: `You write short-answer questions for a student testing themselves.

Rules:
- Each question can be answered in a word, a phrase or one sentence.
- "answer" is a model answer a teacher would accept, as short as it can be.
- The explanation is one sentence of context.
- When material is given, use only that material. When only a topic is named, keep to what a standard course on it covers.

Reply with JSON only:
{"questions":[{"question":"…","answer":"…","explanation":"…"}]}`,
  exam: `You write exam-style written questions for a student testing themselves.

Rules:
- Questions are like a real exam paper: describe, explain, compare, evaluate. Say the marks in brackets, from 2 to 6.
- "answer" is a concise mark scheme: the points that earn the marks, separated by semicolons.
- The explanation is one sentence on what examiners look for.
- When material is given, use only that material. When only a topic is named, keep to what a standard course on it covers.

Reply with JSON only:
{"questions":[{"question":"… (4 marks)","answer":"point; point; point; point","explanation":"…"}]}`,
} as const;

const writtenQuestionSchema = z.object({
  question: z.string().trim().min(1).max(800),
  answer: z.union([z.string(), z.boolean()]).transform((v) => (typeof v === 'boolean' ? (v ? 'true' : 'false') : v.trim())),
  explanation: z.string().trim().max(800).default(''),
});

export const markSchema = z.object({
  answers: z.array(z.object({
    question: z.string().trim().min(1).max(800),
    expected: z.string().trim().max(1_200),
    given: z.string().max(2_000),
  })).min(1).max(20),
});

const MARK_SYSTEM = `You mark a student's written answers against a model answer or mark scheme.

Rules:
- Be fair, not pedantic: accept correct meaning in different words and minor spelling slips.
- "score" is a number from 0 to 1: the share of the marks the answer earns.
- "correct" is true when the score is at least 0.6.
- "feedback" is one short sentence: what earned marks, or what was missing.

Reply with JSON only:
{"results":[{"score":1,"correct":true,"feedback":"…"}]}
One result per answer, in the order given.`;

const markResultSchema = z.object({
  score: z.coerce.number().min(0).max(1).catch(0),
  correct: z.coerce.boolean(),
  feedback: z.string().trim().max(600).default(''),
});

export async function markAnswers(userId: string, input: z.infer<typeof markSchema>) {
  return spend(userId, 'quiz', async (ask) => {
    const listed = input.answers.map((a, i) => `${i + 1}. Question: ${a.question}\nModel answer: ${a.expected}\nStudent answer: ${a.given.trim() || '(left blank)'}`).join('\n\n');
    const raw = await ask.parsed({
      role: 'checker',
      system: MARK_SYSTEM,
      temperature: 0,
      maxTokens: 2_000,
      json: true,
      prompt: listed,
    }, (t) => extractJsonArray(t));
    const results = input.answers.map((a, i) => {
      if (!a.given.trim()) return { score: 0, correct: false, feedback: 'Left blank.' };
      const parsed = markResultSchema.safeParse(raw[i]);
      return parsed.success ? parsed.data : { score: 0, correct: false, feedback: 'Could not be marked.' };
    });
    return { results };
  });
}

const QUIZ_SYSTEM = `You write multiple-choice questions for a student testing themselves.

Rules:
- Each question tests one thing that matters, not a trivial detail.
- Exactly one option is correct. The wrong options are plausible mistakes a student would actually make, not jokes.
- Four options unless the question only has two sensible answers.
- Options are short and of similar length, so the right one does not stand out.
- No "all of the above" or "none of the above".
- The explanation is one or two sentences saying why the right answer is right.
- When material is given, use only that material. When only a topic is named, keep to what a standard course on it covers.

Reply with JSON only:
{"questions":[{"question":"…","options":["…","…","…","…"],"answer":0,"explanation":"…"}]}
"answer" is the index of the correct option.`;

const quizQuestionSchema = z
  .object({
    question: z.string().trim().min(1).max(600),
    options: z.array(z.coerce.string().trim().min(1).max(300)).min(2).max(5),
    answer: z.coerce.number().int().min(0),
    explanation: z.string().trim().max(800).default(''),
  })
  .refine((q) => q.answer < q.options.length)
  .refine((q) => new Set(q.options.map(normal)).size === q.options.length);

function topicMaterial(userId: string, topicId: string): { label: string; body: string } {
  const topic = topics.requireTopic(userId, topicId);
  const subject = topic.subject_id ? library.requireSubject(userId, topic.subject_id).name : null;
  const lines = [
    `Topic: ${topic.spec_ref ? `${topic.spec_ref} ` : ''}${topic.name}`,
    subject ? `Subject: ${subject}` : '',
    topic.unit ? `Unit: ${topic.unit}` : '',
    topic.notes ? `The student's notes on it:\n${topic.notes}` : '',
  ].filter(Boolean);

  if (topic.file_id) {
    try {
      const file = library.requireFile(userId, topic.file_id);
      const linked = file.kind === 'doc'
        ? readSource(userId, { from: 'document', fileId: file.id })
        : file.kind === 'pdf'
          ? readSource(userId, { from: 'pdf', fileId: file.id })
          : null;
      if (linked) lines.push(`Material from ${linked.label}:\n${linked.body.slice(0, 16_000)}`);
    } catch { /* a linked file with nothing in it still leaves the topic to quiz on */ }
  }
  return { label: `the topic “${topic.name}”`, body: lines.join('\n\n') };
}

export async function quiz(userId: string, input: z.infer<typeof quizSchema>) {
  const material = input.topicId ? topicMaterial(userId, input.topicId) : readSource(userId, input.source!);

  if (input.mode !== 'choice') {
    const mode = input.mode;
    return spend(userId, 'quiz', async (ask) => {
      const answer = await ask.parsed({
        role: ROLE_OF.quiz,
        system: QUIZ_MODE_SYSTEM[mode],
        temperature: 0.3,
        maxTokens: 3_500,
        json: true,
        prompt: `Write ${input.count} ${mode === 'truefalse' ? 'statements' : 'questions'} on ${material.label}.\n\n---\n${material.body}\n---`,
      }, (t) => extractJsonArray(t));
      const questions = answer
        .map((raw) => writtenQuestionSchema.safeParse(raw))
        .filter((r) => r.success)
        .map((r) => r.data!)
        .filter((q) => mode !== 'truefalse' || /^(true|false)$/i.test(q.answer))
        .slice(0, input.count)
        .map((q) => mode === 'truefalse'
          ? { question: q.question, options: ['True', 'False'], answer: /^true$/i.test(q.answer) ? 0 : 1, explanation: q.explanation }
          : { question: q.question, options: [], answer: -1, model_answer: q.answer, explanation: q.explanation });
      if (questions.length === 0) throw new AiError('No usable questions came back from that material.', null, false);
      return { label: material.label, mode, questions };
    });
  }

  return spend(userId, 'quiz', async (ask) => {
    const answer = await ask.parsed({
      role: ROLE_OF.quiz,
      system: QUIZ_SYSTEM,
      temperature: 0.3,
      maxTokens: 3_500,
      json: true,
      prompt: `Write ${input.count} questions on ${material.label}.\n\n---\n${material.body}\n---`,
    }, (t) => extractJsonArray(t));

    const questions = answer
      .map((raw) => quizQuestionSchema.safeParse(raw))
      .filter((r) => r.success)
      .map((r) => r.data!)
      .slice(0, input.count)
      .map((q) => {
        // Models put the right answer first far more often than a quarter of
        // the time, and a student learns that faster than the content.
        const order = q.options.map((_, i) => i).sort(() => Math.random() - 0.5);
        return {
          question: q.question,
          options: order.map((i) => q.options[i]!),
          answer: order.indexOf(q.answer),
          explanation: q.explanation,
        };
      });

    if (questions.length === 0) throw new AiError('No usable questions came back from that material.', null, false);
    return { label: material.label, mode: 'choice' as const, questions };
  });
}

/* ------------------------------ duplicates -------------------------------- */

export const dedupeSchema = z.object({ subjectId: uuid.nullish() });

const MAX_DEDUPE_TOPICS = 300;

const DEDUPE_SYSTEM = `You find topics in a student's revision list that are the same thing written twice.

Rules:
- Group items only when revising one would fully cover the other: the same content with different wording, a typo, or one copied in twice.
- Do not group a broad topic with a narrower one inside it, or two topics that are merely related.
- In each group, "keep" is the item with the clearest name; "merge" lists the others.
- Most lists have few duplicates or none. An empty list is a good answer.

Reply with JSON only:
{"groups":[{"keep":3,"merge":[7],"reason":"both are enzyme inhibition"}]}`;

export async function findDuplicateTopics(userId: string, input: z.infer<typeof dedupeSchema>) {
  const list = topics
    .listTopics(userId, { subjectId: input.subjectId ?? undefined, limit: 500 })
    .sort((a, b) => a.position - b.position || a.created_at - b.created_at);
  if (list.length < 2) return { groups: [], truncated: false, considered: list.length };
  const considered = list.slice(0, MAX_DEDUPE_TOPICS);

  return spend(userId, 'dedupe', async (ask) => {
    const raw = await ask.parsed({
      role: ROLE_OF.dedupe,
      system: DEDUPE_SYSTEM,
      temperature: 0,
      maxTokens: 2_500,
      json: true,
      prompt: considered
        .map((t, i) => `${i}. ${t.spec_ref ? `${t.spec_ref} ` : ''}${t.name}${t.unit ? ` (${t.unit})` : ''}`)
        .join('\n'),
    }, (t) => {
      const groups = extractJsonObject(t).groups;
      if (!Array.isArray(groups)) throw new AiError('The model did not answer with a list.', null, true);
      return groups;
    });

    const groupSchema = z.object({
      keep: z.coerce.number().int().min(0),
      merge: z.array(z.coerce.number().int().min(0)).min(1).max(50),
      reason: z.string().trim().max(200).default(''),
    });

    // Indices in, ids out, and every index used at most once: a topic cannot
    // be kept in one group and merged away in another.
    const used = new Set<number>();
    const groups = [];
    for (const item of raw) {
      const g = groupSchema.safeParse(item);
      if (!g.success) continue;
      const members = [g.data.keep, ...g.data.merge.filter((i) => i !== g.data.keep)];
      if (members.length < 2 || members.some((i) => i >= considered.length || used.has(i))) continue;
      if (new Set(members).size !== members.length) continue;
      const rows = members.map((i) => considered[i]!);
      // Topics in different subjects are never the same topic, whatever they are called.
      if (new Set(rows.map((r) => r.subject_id)).size > 1) continue;
      members.forEach((i) => used.add(i));
      groups.push({
        keep: { id: rows[0]!.id, name: rows[0]!.name, ref: rows[0]!.spec_ref, unit: rows[0]!.unit },
        merge: rows.slice(1).map((r) => ({ id: r.id, name: r.name, ref: r.spec_ref, unit: r.unit })),
        reason: g.data.reason,
      });
    }
    return { groups, truncated: list.length > considered.length, considered: considered.length };
  });
}

/* ---------------------------------- chat ---------------------------------- */

const MAX_TURN_CHARS = 8_000;
/** How much of the conversation is sent back each time, newest kept. */
const MAX_HISTORY_CHARS = 24_000;
const MAX_CONTEXT_CHARS = 20_000;

export const chatSchema = z.object({
  /** The saved conversation this turn belongs to. Absent on a new chat. */
  chatId: uuid.nullish(),
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().trim().min(1).max(MAX_TURN_CHARS) }))
    .min(1)
    .max(60)
    .refine((m) => m[m.length - 1]!.role === 'user', { message: 'The last message must be the question' }),
  /** What is on screen. Ids only — the text is read here, from what the account owns. */
  context: z
    .object({
      route: z.string().max(40).optional(),
      fileId: uuid.optional(),
      topicId: uuid.optional(),
      /** Text the person had selected when they asked. */
      selection: z.string().max(6_000).optional(),
    })
    .nullish(),
});

const CHAT_SYSTEM = `You are the study tutor inside Studex, a revision app for students. Your job is to make the student think, not to think for them. You teach the way a good Socratic tutor does: short, structured, and always handing the next step back to the student.

How you work:
1. Find out where they are. If the question is broad or it is unclear what they already know, ask one short diagnostic question before explaining.
2. Explain concisely. When an explanation is needed, give the core idea in 2–4 sentences, then one concrete example. No padding, no preamble.
3. Hint progressively. When they are stuck on a problem, give the smallest useful hint first (Hint 1), and only give a bigger one if they are still stuck. Give the full worked answer only when they ask for it or have genuinely attempted it.
4. Check understanding. End most answers with one practice question they can answer in a sentence or two, labelled "**Your turn:**". When they answer, say exactly what was right, correct what was wrong, and move up one level of difficulty.
5. Extract flashcards. When a key fact or definition comes up, or when asked, offer cards in this exact form, one per line, so they can be copied straight into a Studex document:
   Question :: Answer
   Keep each card to one atomic fact.

Format:
- Plain Markdown: short paragraphs, "-" bullet lists, **bold** for key terms, \`code\` for code. Use "### " headings only for answers with several parts. No tables, no HTML.
- Keep answers short — usually under 200 words.

Honesty:
- When the student's own material is given below, ground your answer in it and say plainly when something is not in it.
- If you are not sure a fact is right, say so rather than guessing. Never invent quotations, page numbers or sources.
- If asked to do graded work for them, coach them through doing it themselves instead.`;

/** What the person is looking at, as text the model can use. Missing or empty material is not an error here. */
function chatContext(userId: string, context: z.infer<typeof chatSchema>['context']): { label: string | null; body: string } {
  if (!context) return { label: null, body: '' };
  const parts: string[] = [];
  let label: string | null = null;

  if (context.topicId) {
    try {
      const material = topicMaterial(userId, context.topicId);
      label = material.label;
      parts.push(material.body);
    } catch { /* gone, or not theirs: answer without it */ }
  } else if (context.fileId) {
    try {
      const file = library.requireFile(userId, context.fileId);
      label = `“${file.title}”`;
      if (file.kind === 'doc') {
        parts.push(`The note “${file.title}”:\n${readSource(userId, { from: 'document', fileId: file.id }).body}`);
      } else if (file.kind === 'pdf') {
        try {
          parts.push(`Passages the student marked in the PDF “${file.title}”:\n${readSource(userId, { from: 'pdf', fileId: file.id }).body}`);
        } catch {
          parts.push(`The student is reading the PDF “${file.title}”, but has not marked any passages in it.`);
        }
      } else if (file.kind === 'deck') {
        const cards = flashcards.listCards(userId, file.id, 200, 0);
        parts.push(`The flashcard deck “${file.title}” (${cards.length} cards shown):\n`
          + cards.map((c) => `Q: ${c.front}\nA: ${c.back}`).join('\n\n'));
      } else {
        parts.push(`The student has the ${file.kind} “${file.title}” open.`);
      }
    } catch { /* an empty note, a deleted file: answer without it */ }
  } else if (context.route === 'topics') {
    const list = topics.listTopics(userId, { limit: 300 });
    if (list.length) {
      label = 'your topics';
      parts.push('The student\'s revision topics, with confidence out of 5 (0 = not rated):\n'
        + list.map((t) => `- ${t.spec_ref ? `${t.spec_ref} ` : ''}${t.name}${t.unit ? ` [${t.unit}]` : ''}: ${t.confidence ?? 0}`).join('\n'));
    }
  }

  if (context.selection?.trim()) {
    parts.push(`The text the student had selected:\n---\n${context.selection.trim()}\n---`);
    label ??= 'the selection';
  }
  return { label, body: parts.join('\n\n').slice(0, MAX_CONTEXT_CHARS) };
}

export async function chat(userId: string, input: z.infer<typeof chatSchema>) {
  const { label, body } = chatContext(userId, input.context);
  const question = input.messages[input.messages.length - 1]!.content;
  if (input.chatId) requireChat(userId, input.chatId);

  // Newest turns first until the budget is spent, then back into order. A
  // long conversation loses its beginning, not its thread.
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  let used = 0;
  for (const turn of input.messages.slice(0, -1).reverse()) {
    used += turn.content.length;
    if (used > MAX_HISTORY_CHARS) break;
    history.unshift(turn);
  }
  // A conversation starts with the person, so a leading answer left by the cut goes.
  while (history[0]?.role === 'assistant') history.shift();

  return spend(userId, 'chat', async (ask) => {
    const answer = await ask({
      role: ROLE_OF.chat,
      system: body ? `${CHAT_SYSTEM}\n\nThe student's material:\n${body}` : CHAT_SYSTEM,
      history,
      prompt: question,
      maxTokens: 1_500,
      temperature: 0.5,
    });
    const turns = [
      ...input.messages.map(({ role, content }) => ({ role, content })),
      { role: 'assistant' as const, content: answer.text, ...(label ? { context: label } : {}) },
    ];
    const chatId = saveChat(userId, input.chatId ?? null, turns);
    return { answer: answer.text, model: answer.model, context: label, chatId };
  });
}

/* ------------------------------ chat history ------------------------------ */

const MAX_SAVED_CHATS = 200;

type SavedTurn = { role: 'user' | 'assistant'; content: string; context?: string };

function requireChat(userId: string, chatId: string) {
  const row = getDb()
    .prepare<[string, string], { id: string; title: string; messages: string; created_at: number; updated_at: number }>(
      'SELECT id, title, messages, created_at, updated_at FROM ai_chats WHERE id = ? AND user_id = ?',
    )
    .get(chatId, userId);
  if (!row) throw notFound('That conversation no longer exists.');
  return row;
}

function titleFor(turns: SavedTurn[]): string {
  const first = turns.find((t) => t.role === 'user')?.content ?? 'Untitled';
  const line = first.replace(/\s+/g, ' ').trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line || 'Untitled';
}

/** Writes the whole conversation, creating it on its first answer. Returns its id. */
function saveChat(userId: string, chatId: string | null, turns: SavedTurn[]): string {
  const now = Date.now();
  const db = getDb();
  const json = JSON.stringify(turns);
  if (chatId) {
    // The client sends only the most recent turns, without the labels saying
    // what each answer read. When what it sent picks up where the saved chat
    // ends, the saved turns are kept and only the new question and answer are
    // added; otherwise (an edited or retried chat) what was sent is the chat.
    const saved = JSON.parse(requireChat(userId, chatId).messages) as SavedTurn[];
    const earlier = turns.slice(0, -2);
    const tail = saved.slice(saved.length - earlier.length);
    const continues = earlier.length <= saved.length
      && earlier.every((t, i) => t.role === tail[i]!.role && t.content === tail[i]!.content);
    const merged = continues ? [...saved, ...turns.slice(-2)] : turns;
    db.prepare('UPDATE ai_chats SET messages = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .run(JSON.stringify(merged), now, chatId, userId);
    return chatId;
  }
  const id = newId();
  tx(() => {
    db.prepare('INSERT INTO ai_chats (id, user_id, title, messages, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, userId, titleFor(turns), json, now, now);
    // Oldest go first once there are more than anyone scrolls back through.
    db.prepare(
      `DELETE FROM ai_chats WHERE user_id = ? AND id NOT IN
         (SELECT id FROM ai_chats WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?)`,
    ).run(userId, userId, MAX_SAVED_CHATS);
  });
  return id;
}

export function listChats(userId: string) {
  return getDb()
    .prepare<[string], { id: string; title: string; messages: string; created_at: number; updated_at: number }>(
      'SELECT id, title, messages, created_at, updated_at FROM ai_chats WHERE user_id = ? ORDER BY updated_at DESC',
    )
    .all(userId)
    .map(({ messages, ...row }) => ({ ...row, turns: (JSON.parse(messages) as SavedTurn[]).length }));
}

export function getChat(userId: string, chatId: string) {
  const { messages, ...row } = requireChat(userId, chatId);
  return { ...row, messages: JSON.parse(messages) as SavedTurn[] };
}

export function deleteChat(userId: string, chatId: string): void {
  requireChat(userId, chatId);
  getDb().prepare('DELETE FROM ai_chats WHERE id = ? AND user_id = ?').run(chatId, userId);
}

export function clearChats(userId: string): void {
  getDb().prepare('DELETE FROM ai_chats WHERE user_id = ?').run(userId);
}
