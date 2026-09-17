/**
 * Image occlusion: cards drawn over a diagram.
 *
 * A student boxes the parts of a labelled cell, a map or a circuit, names each
 * box, and every named box becomes a card that hides that region and asks what
 * is under it. The cards are ordinary cards — they queue, review and schedule
 * like any other — with the diagram and its masks kept alongside, so the review
 * face can draw the picture instead of the text.
 *
 * The set is keyed by image and mask: making cards from the same diagram again
 * updates the cards whose boxes survived (their review history intact), adds
 * the new ones and removes those whose boxes were deleted.
 */
import { z } from 'zod';
import { getDb, tx } from '../lib/db.js';
import { badRequest } from '../lib/errors.js';
import { requireFile } from './library.js';
import { requireImage } from './images.js';
import * as search from './search.js';
import { createCard, requireCard, requireDeck, type CardRow } from './flashcards.js';

const fraction = z.number().min(0).max(1);

export const maskSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  x: fraction,
  y: fraction,
  width: z.number().min(0.002).max(1),
  height: z.number().min(0.002).max(1),
  label: z.string().trim().max(200).nullish(),
});

export const occlusionInputSchema = z.object({
  imageId: z.string().uuid(),
  masks: z.array(maskSchema).min(1).max(60),
  /** 'one' hides only the region asked about; 'all' hides every region. */
  mode: z.enum(['one', 'all']).default('one'),
  prompt: z.string().trim().max(200).nullish(),
  topic: z.string().trim().max(120).nullish(),
  sourceFileId: z.string().uuid().nullish(),
  sourcePage: z.number().int().min(1).max(100_000).nullish(),
}).refine((v) => new Set(v.masks.map((m) => m.id)).size === v.masks.length, {
  message: 'Each region needs its own id',
});

export type OcclusionInput = z.infer<typeof occlusionInputSchema>;

const DEFAULT_PROMPT = 'What is hidden here?';

export function createOcclusionCards(userId: string, deckId: string, raw: OcclusionInput) {
  const input = occlusionInputSchema.parse(raw);
  requireDeck(userId, deckId);
  requireImage(userId, input.imageId);
  if (input.sourceFileId) requireFile(userId, input.sourceFileId);

  const masks = input.masks.map((m) => ({ ...m, label: m.label || null }));
  const labelled = masks.filter((m) => m.label);
  if (!labelled.length) throw badRequest('Name at least one region to make a card from it');

  const front = input.prompt || DEFAULT_PROMPT;
  const topic = input.topic || null;

  return tx(() => {
    const existing = getDb()
      .prepare<[string, string], { id: string; target: string | null }>(
        `SELECT id, json_extract(occlusion, '$.target') AS target FROM cards
          WHERE user_id = ? AND occlusion IS NOT NULL AND json_extract(occlusion, '$.imageId') = ?`,
      )
      .all(userId, input.imageId);
    const byTarget = new Map(existing.map((row) => [row.target, row.id]));
    const keep = new Set(labelled.map((m) => m.id));

    let created = 0;
    let updated = 0;
    let removed = 0;
    const now = Date.now();
    const cards: CardRow[] = [];

    for (const mask of labelled) {
      const occlusion = JSON.stringify({
        imageId: input.imageId,
        masks,
        target: mask.id,
        mode: input.mode,
        sourcePage: input.sourcePage ?? null,
      });
      const back = mask.label!;
      const cardId = byTarget.get(mask.id);
      if (cardId) {
        getDb()
          .prepare('UPDATE cards SET front = ?, back = ?, topic = ?, occlusion = ?, updated_at = ? WHERE id = ? AND user_id = ?')
          .run(front, back, topic, occlusion, now, cardId, userId);
        const card = requireCard(userId, cardId);
        search.indexEntity({
          userId, entityType: 'card', entityId: cardId, fileId: card.deck_id,
          title: front.slice(0, 200), body: [front, back, topic].filter(Boolean).join('\n'),
        });
        cards.push(card);
        updated += 1;
      } else {
        const card = createCard(userId, {
          deckId, front, back, topic, sourceFileId: input.sourceFileId ?? null,
        });
        getDb().prepare('UPDATE cards SET occlusion = ? WHERE id = ?').run(occlusion, card.id);
        cards.push(requireCard(userId, card.id));
        created += 1;
      }
    }

    for (const row of existing) {
      if (row.target && keep.has(row.target)) continue;
      search.removeEntity('card', row.id);
      getDb().prepare('DELETE FROM cards WHERE id = ? AND user_id = ?').run(row.id, userId);
      removed += 1;
    }

    getDb().prepare('UPDATE files SET updated_at = ? WHERE id = ?').run(now, deckId);
    return { cards: cards.map((c) => ({ ...c, suspended: c.suspended === 1 })), created, updated, removed };
  });
}
