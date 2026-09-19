/**
 * Reading a body into the library.
 *
 * A file's body arrives from two places — a pull from upstream, and a restore
 * of an earlier version of the same file — and both have to write it the same
 * way, or the two would disagree about what a document is. That shared half
 * lives here rather than inside either caller.
 */
import { z } from 'zod';
import { getDb, tx } from '../lib/db.js';
import { deleteBlob, storeBuffer } from '../lib/storage.js';
import { ApiError, quotaExceeded } from '../lib/errors.js';
import { blocksSchema, documentStyleSchema, saveDocument } from './documents.js';
import { canvasObjectsSchema, saveCanvas, viewportSchema } from './canvas.js';
import { deckTemplateSchema } from './flashcards.js';
import type { LocalFile } from './sync.js';

/** The shape a document, canvas or deck body has to have to be applied here. */
export const docBody = z.object({
  kind: z.literal('doc'),
  style: documentStyleSchema.optional(),
  blocks: blocksSchema,
});

const canvasBody = z.object({
  kind: z.literal('canvas'),
  viewport: viewportSchema.optional(),
  objects: canvasObjectsSchema,
});

/**
 * Cards keep the ids they were pushed with. Documents reference their inline
 * cards by id, so renumbering on the way down would leave a pulled note
 * pointing at cards that no longer exist under those names.
 */
const cardBody = z.object({
  id: z.string().min(1).max(64),
  front: z.string().max(8_000),
  back: z.string().max(8_000),
  topic: z.string().max(200).nullish(),
  extra1: z.string().max(8_000).nullish(),
  extra2: z.string().max(8_000).nullish(),
  state: z.enum(['new', 'learning', 'review', 'relearning']).catch('new'),
  ease_factor: z.number().min(1).max(5).catch(2.5),
  // Absent from anything an older client wrote. Null is the honest answer
  // there — the card is then treated as never scheduled by FSRS, and its first
  // review establishes its memory state from the grade.
  stability: z.number().min(0).max(36_500).nullish().catch(null),
  difficulty: z.number().min(1).max(10).nullish().catch(null),
  interval_days: z.number().min(0).catch(0),
  repetitions: z.number().int().min(0).catch(0),
  lapses: z.number().int().min(0).catch(0),
  due_at: z.number(),
  last_reviewed_at: z.number().nullish(),
  suspended: z.union([z.number(), z.boolean()]).catch(0),
  created_at: z.number(),
  updated_at: z.number(),
});

const deckBody = z.object({
  kind: z.literal('deck'),
  description: z.string().max(2_000).nullish(),
  // A template this build cannot read is dropped rather than failing the pull.
  template: deckTemplateSchema.nullish().catch(null),
  cards: z.array(cardBody).max(10_000),
});

export function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new ApiError(502, 'sync_failed', 'A file upstream is not readable as Studex content.');
  }
}

/* ── storage accounting ───────────────────────────────────────────────── */

/**
 * Charges bytes against the account before they are written.
 *
 * Plan caps are lifted for a restore, but disk is disk: an account with no
 * room left cannot be given more of its own library than it can hold, and
 * saying so is better than filling the volume.
 */
export function chargeStorage(userId: string, delta: number): void {
  const usage = getDb()
    .prepare<[string], { storage_used_bytes: number; storage_quota_bytes: number }>(
      'SELECT storage_used_bytes, storage_quota_bytes FROM users WHERE id = ?',
    )
    .get(userId)!;
  if (delta > 0 && usage.storage_used_bytes + delta > usage.storage_quota_bytes) {
    throw quotaExceeded('Not enough storage left to bring the rest of your library down.');
  }
  getDb()
    .prepare('UPDATE users SET storage_used_bytes = MAX(0, storage_used_bytes + ?), updated_at = ? WHERE id = ?')
    .run(delta, Date.now(), userId);
}

/* ── applying a body ──────────────────────────────────────────────────── */

async function writePdf(userId: string, fileId: string, body: Buffer, originalName: string): Promise<void> {
  const existing = getDb()
    .prepare<[string], { storage_key: string; byte_size: number }>(
      'SELECT storage_key, byte_size FROM pdf_files WHERE file_id = ?',
    )
    .get(fileId);

  const blob = await storeBuffer(body);
  try {
    tx(() => {
      chargeStorage(userId, blob.byteSize - (existing?.byte_size ?? 0));
      getDb().prepare('DELETE FROM pdf_files WHERE file_id = ?').run(fileId);
      getDb()
        .prepare(
          `INSERT INTO pdf_files (file_id, storage_key, byte_size, sha256, original_name, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(fileId, blob.key, blob.byteSize, blob.sha256, originalName, Date.now());
    });
  } catch (err) {
    await deleteBlob(blob.key);
    throw err;
  }
  if (existing) await deleteBlob(existing.storage_key);
}

export async function applyBody(userId: string, file: LocalFile, body: Buffer): Promise<void> {
  if (file.kind === 'doc') {
    const parsed = docBody.parse(parseJson(body));
    saveDocument(userId, file.id, parsed.blocks, undefined, parsed.style);
    return;
  }
  if (file.kind === 'canvas') {
    const parsed = canvasBody.parse(parseJson(body));
    saveCanvas(userId, file.id, { objects: parsed.objects, viewport: parsed.viewport });
    return;
  }
  if (file.kind === 'deck') {
    const parsed = deckBody.parse(parseJson(body));
    tx(() => {
      const db = getDb();
      db.prepare('UPDATE decks SET description = ?, template = ?, updated_at = ? WHERE file_id = ?')
        .run(parsed.description ?? null, parsed.template ? JSON.stringify(parsed.template) : null, Date.now(), file.id);
      db.prepare('DELETE FROM cards WHERE deck_id = ?').run(file.id);
      for (const card of parsed.cards) {
        // Scoped by user_id: a card id arriving from upstream can only ever
        // replace one of this account's own rows, never somebody else's.
        db.prepare('DELETE FROM cards WHERE id = ? AND user_id = ?').run(card.id, userId);
        db.prepare(
          `INSERT INTO cards (id, user_id, deck_id, front, back, topic, extra1, extra2, state, ease_factor,
                              stability, difficulty,
                              interval_days, repetitions, lapses, due_at, last_reviewed_at,
                              suspended, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          card.id, userId, file.id, card.front, card.back, card.topic ?? null,
          card.extra1 ?? null, card.extra2 ?? null, card.state,
          card.ease_factor, card.stability ?? null, card.difficulty ?? null,
          card.interval_days, card.repetitions, card.lapses, card.due_at,
          card.last_reviewed_at ?? null, Number(card.suspended) ? 1 : 0, card.created_at, card.updated_at,
        );
      }
    });
    return;
  }
  await writePdf(userId, file.id, body, file.title);
}
