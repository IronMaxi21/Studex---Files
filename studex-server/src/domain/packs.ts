import { z } from 'zod';
import { getDb, tx } from '../lib/db.js';
import { badRequest } from '../lib/errors.js';
import { createFile, requireFile, requireFolder, requireSubject } from './library.js';
import { createCard, deckTemplateSchema, setDeckTemplate } from './flashcards.js';
import { importTopics } from './topics.js';

/**
 * Study packs: a deck, or a subject's topic list, as something a classmate can
 * copy into their own library.
 *
 * A pack is the content and nothing about the person who made it: questions,
 * answers and the deck's template, or topic names with where they sit on the
 * specification. No ids, no review history, no confidence ratings, no email —
 * a copied deck starts its own schedule and a copied checklist starts unrated,
 * because what the maker knows is not what the classmate knows.
 *
 * It travels two ways. The desktop app is its own server on loopback, so a
 * share link reaches only that machine; the pack file (`.studexpack`, plain
 * JSON) is what goes over AirDrop, a class chat or email. Where the server is
 * reachable, a view link to a deck serves the same pack.
 */

export const PACK_VERSION = 1;
const MAX_CARDS = 5_000;
const MAX_TOPICS = 500;

const field = (max: number) => z.string().trim().max(max);

const deckPackSchema = z.object({
  format: z.literal('studex-pack'),
  version: z.number().int().min(1),
  type: z.literal('deck'),
  title: field(200).min(1),
  description: field(2_000).nullish(),
  template: deckTemplateSchema.nullish().catch(null),
  cards: z
    .array(z.object({
      front: field(4_000).min(1),
      back: field(4_000).min(1),
      topic: field(120).nullish(),
      extra1: field(4_000).nullish(),
      extra2: field(4_000).nullish(),
    }))
    .min(1)
    .max(MAX_CARDS),
});

const topicPackSchema = z.object({
  format: z.literal('studex-pack'),
  version: z.number().int().min(1),
  type: z.literal('topics'),
  title: field(200).min(1),
  topics: z
    .array(z.object({
      name: field(160).min(1),
      unit: field(80).nullish(),
      ref: field(40).nullish(),
      page: z.number().int().min(1).max(10_000).nullish(),
    }))
    .min(1)
    .max(MAX_TOPICS),
});

export const packSchema = z.discriminatedUnion('type', [deckPackSchema, topicPackSchema]);
export type Pack = z.infer<typeof packSchema>;

export function deckPack(userId: string, deckId: string): z.infer<typeof deckPackSchema> {
  const file = requireFile(userId, deckId);
  if (file.kind !== 'deck') throw badRequest('Only a deck can be packed as cards');
  const deck = getDb()
    .prepare<[string], { description: string | null; template: string | null }>(
      'SELECT description, template FROM decks WHERE file_id = ?',
    )
    .get(deckId);
  const cards = getDb()
    .prepare<[string, string], { front: string; back: string; topic: string | null; extra1: string | null; extra2: string | null }>(
      `SELECT front, back, topic, extra1, extra2 FROM cards
       WHERE deck_id = ? AND user_id = ? AND occlusion IS NULL ORDER BY created_at, rowid LIMIT ${MAX_CARDS}`,
    )
    .all(deckId, userId);
  let template = null;
  try {
    template = deck?.template ? deckTemplateSchema.parse(JSON.parse(deck.template)) : null;
  } catch { /* an unreadable template travels as the default look */ }
  return {
    format: 'studex-pack',
    version: PACK_VERSION,
    type: 'deck',
    title: file.title,
    description: deck?.description ?? null,
    template,
    cards,
  };
}

export function topicPack(userId: string, subjectId: string): z.infer<typeof topicPackSchema> {
  const subject = requireSubject(userId, subjectId);
  const topics = getDb()
    .prepare<[string, string], { name: string; unit: string | null; ref: string | null; page: number | null }>(
      `SELECT name, unit, spec_ref AS ref, spec_page AS page FROM topics
       WHERE user_id = ? AND subject_id = ? ORDER BY position, created_at LIMIT ${MAX_TOPICS}`,
    )
    .all(userId, subjectId);
  if (!topics.length) throw badRequest('This subject has no topics to share yet');
  return { format: 'studex-pack', version: PACK_VERSION, type: 'topics', title: subject.name, topics };
}

/**
 * Copies a pack into an account. A deck arrives as a new deck (never merged
 * into one that exists, so nothing the student already has is touched); a
 * topic list lands on the chosen subject, skipping names it already holds.
 */
export function importPack(
  userId: string,
  raw: unknown,
  into: { folderId?: string | null; subjectId?: string | null } = {},
): { type: 'deck'; deckId: string; cards: number } | { type: 'topics'; created: number; skipped: number } {
  const parsed = packSchema.safeParse(raw);
  if (!parsed.success) throw badRequest('This is not a Studex pack, or it was made by a newer version');
  const pack = parsed.data;
  if (pack.version > PACK_VERSION) throw badRequest('This pack was made by a newer version of Studex');

  if (pack.type === 'deck') {
    if (into.folderId) requireFolder(userId, into.folderId);
    return tx(() => {
      const file = createFile(userId, { title: pack.title, kind: 'deck', folderId: into.folderId ?? null });
      if (pack.description) {
        getDb().prepare('UPDATE decks SET description = ? WHERE file_id = ?').run(pack.description, file.id);
      }
      if (pack.template) setDeckTemplate(userId, file.id, pack.template);
      for (const card of pack.cards) {
        createCard(userId, {
          deckId: file.id,
          front: card.front,
          back: card.back,
          topic: card.topic || null,
          extra1: card.extra1 || null,
          extra2: card.extra2 || null,
        });
      }
      return { type: 'deck' as const, deckId: file.id, cards: pack.cards.length };
    });
  }

  if (into.subjectId) requireSubject(userId, into.subjectId);
  // Topics keep the unit they were filed under; importTopics takes one unit a
  // call, so the list is imported a unit at a time, in its own order.
  const byUnit = new Map<string, typeof pack.topics>();
  for (const topic of pack.topics) {
    const key = topic.unit ?? '';
    if (!byUnit.has(key)) byUnit.set(key, []);
    byUnit.get(key)!.push(topic);
  }
  return tx(() => {
    let created = 0;
    let skipped = 0;
    for (const [unit, topics] of byUnit) {
      const res = importTopics(userId, {
        subjectId: into.subjectId ?? null,
        unit: unit || null,
        names: topics.map((t) => ({ name: t.name, ref: t.ref ?? null, page: t.page ?? null })),
      });
      created += res.created.length;
      skipped += res.skipped;
    }
    return { type: 'topics' as const, created, skipped };
  });
}

/** A filename for a pack download: the title, made safe, with the pack extension. */
export function packFilename(title: string): string {
  const base = title.replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'pack';
  return `${base}.studexpack`;
}
