import fs from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import { config } from '../lib/config.js';
import { getDb, tx } from '../lib/db.js';
import { newId } from '../lib/ids.js';
import { badRequest, notFound, quotaExceeded } from '../lib/errors.js';
import { deleteBlob, resolveStoragePath, storeStream } from '../lib/storage.js';
import { countPdfPages } from '../lib/pdfpages.js';
import { log } from '../lib/log.js';
import { colorToken, richText, uuid } from '../lib/validation.js';
import { createFile, requireFile } from './library.js';
import { assertCanCreate } from './plan.js';
import { createCard } from './flashcards.js';
import * as search from './search.js';

const PDF_MAGIC = Buffer.from('%PDF-', 'ascii');

export interface PdfRow {
  file_id: string;
  storage_key: string;
  byte_size: number;
  sha256: string;
  page_count: number | null;
  original_name: string;
  created_at: number;
}

/* ------------------------------ upload/import ----------------------------- */

export async function importPdf(
  userId: string,
  input: {
    stream: Readable;
    originalName: string;
    title: string;
    folderId?: string | null;
    /** See StoreOptions.complete — a truncated upload must not become a file. */
    complete?: () => boolean;
  },
): Promise<{ fileId: string; pdf: PdfRow }> {
  // Checked here as well as inside the transaction, so an account already at
  // its limit is turned away before it spends a minute uploading.
  assertCanCreate(userId, 'pdf');

  // The destination folder is ownership-checked by createFile below.
  const usage = getDb()
    .prepare<[string], { storage_used_bytes: number; storage_quota_bytes: number }>(
      'SELECT storage_used_bytes, storage_quota_bytes FROM users WHERE id = ?',
    )
    .get(userId);
  if (!usage) throw notFound('User not found');

  const remaining = usage.storage_quota_bytes - usage.storage_used_bytes;
  if (remaining <= 0) throw quotaExceeded('Storage quota exceeded');

  // The stream is cut off at whichever limit binds first, so a caller cannot
  // exhaust the disk by ignoring the quota.
  const maxBytes = Math.min(config.maxUploadBytes, remaining);

  const blob = await storeStream(input.stream, {
    maxBytes,
    expectMagic: PDF_MAGIC,
    complete: input.complete,
  });

  // Read the page count off the file itself. Until this existed the number
  // arrived later, from the client, by PATCH — which meant the bound on an
  // annotation's page was set by the same party it constrains. A file that
  // does not state its page tree still yields null here, and such a PDF can
  // still be told its size once, below.
  const pageCount = await pageCountOf(blob.key);

  try {
    return tx(() => {
      const file = createFile(userId, {
        title: input.title,
        kind: 'pdf',
        folderId: input.folderId ?? null,
      });
      const now = Date.now();

      getDb()
        .prepare(
          `INSERT INTO pdf_files (file_id, storage_key, byte_size, sha256, original_name, page_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(file.id, blob.key, blob.byteSize, blob.sha256, input.originalName, pageCount, now);

      // Re-check the quota inside the transaction: two concurrent uploads that
      // each fit on their own must not both be admitted.
      const fresh = getDb()
        .prepare<[string], { storage_used_bytes: number; storage_quota_bytes: number }>(
          'SELECT storage_used_bytes, storage_quota_bytes FROM users WHERE id = ?',
        )
        .get(userId)!;
      if (fresh.storage_used_bytes + blob.byteSize > fresh.storage_quota_bytes) {
        throw quotaExceeded('Storage quota exceeded');
      }

      getDb()
        .prepare('UPDATE users SET storage_used_bytes = storage_used_bytes + ?, updated_at = ? WHERE id = ?')
        .run(blob.byteSize, now, userId);

      return { fileId: file.id, pdf: requirePdf(userId, file.id) };
    });
  } catch (err) {
    // The transaction rolled back, so the orphaned blob must go too.
    await deleteBlob(blob.key);
    throw err;
  }
}

export function requirePdf(userId: string, fileId: string): PdfRow {
  const file = requireFile(userId, fileId);
  if (file.kind !== 'pdf') throw notFound('File is not a PDF');
  const row = getDb()
    .prepare<[string], PdfRow>('SELECT * FROM pdf_files WHERE file_id = ?')
    .get(fileId);
  if (!row) throw notFound('PDF content missing');
  return row;
}

/**
 * The page count of a stored blob, or null if the file does not say.
 *
 * Reading fails loudly nowhere: a PDF whose page tree cannot be found is a
 * PDF whose annotations stay unbounded, exactly as they were before this
 * function existed. Refusing the upload instead would reject valid files over
 * a number that is only ever used as a guard rail.
 */
async function pageCountOf(storageKey: string): Promise<number | null> {
  try {
    return countPdfPages(await fs.readFile(resolveStoragePath(storageKey)));
  } catch (err) {
    log.warn({ err }, 'could not read page count from upload');
    return null;
  }
}

/**
 * Records how many pages a PDF has — but only when the server could not work
 * it out for itself.
 *
 * The client still parses the file to render it, and for a PDF whose page tree
 * this server cannot read, that parse is the only source there is. What it can
 * no longer do is contradict a count taken from the bytes: raising the bound
 * would admit annotations on pages that do not exist, and lowering it would
 * orphan ones already written.
 */
export function setPageCount(userId: string, fileId: string, pageCount: number): PdfRow {
  const pdf = requirePdf(userId, fileId);

  if (pdf.page_count !== null) {
    if (pdf.page_count !== pageCount) {
      throw badRequest(
        `This PDF has ${pdf.page_count} pages; the count is read from the file and cannot be changed`,
      );
    }
    return pdf;
  }

  getDb().prepare('UPDATE pdf_files SET page_count = ? WHERE file_id = ?').run(pageCount, fileId);
  return requirePdf(userId, fileId);
}

/* ------------------------------- annotations ------------------------------ */

const quad = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().min(0),
  height: z.number().finite().min(0),
});

/** Geometry is shaped per annotation kind and validated before storage. */
export const annotationGeometrySchema = z.union([
  z.object({ kind: z.literal('quads'), quads: z.array(quad).min(1).max(500) }),
  z.object({
    kind: z.literal('path'),
    points: z.array(z.tuple([z.number().finite(), z.number().finite()])).min(2).max(10_000),
    stroke: z.number().min(0).max(20).default(1.5),
  }),
  z.object({ kind: z.literal('point'), x: z.number().finite(), y: z.number().finite() }),
  /**
   * Text written onto the page. The anchor is the top-left of the box in the
   * page's own normalized space, and `size` is the type size as a fraction of
   * the page height — so the words stay the same size relative to the page at
   * every zoom, which is what makes them part of the document rather than
   * part of the window.
   */
  z.object({
    kind: z.literal('text'),
    x: z.number().finite(),
    y: z.number().finite(),
    size: z.number().min(0.005).max(0.2).default(0.022),
  }),
]);

export const createAnnotationSchema = z.object({
  page: z.number().int().min(1).max(10_000),
  kind: z.enum(['highlight', 'ink', 'comment', 'text']),
  geometry: annotationGeometrySchema,
  color: colorToken.nullish(),
  quotedText: richText(10_000).nullish(),
  note: richText(10_000).nullish(),
});

export interface AnnotationRow {
  id: string;
  user_id: string;
  file_id: string;
  page: number;
  kind: 'highlight' | 'ink' | 'comment' | 'text';
  geometry: string;
  color: string | null;
  quoted_text: string | null;
  note: string | null;
  card_id: string | null;
  created_at: number;
  updated_at: number;
}

function shapeAnnotation(row: AnnotationRow) {
  return { ...row, geometry: JSON.parse(row.geometry) };
}

/** Rejects a geometry whose shape does not fit the annotation kind. */
const GEOMETRY_FOR = {
  highlight: 'quads',
  ink: 'path',
  comment: 'point',
  text: 'text',
} as const;

function assertGeometryMatchesKind(
  kind: keyof typeof GEOMETRY_FOR,
  geometry: z.infer<typeof annotationGeometrySchema>,
): void {
  const expected = GEOMETRY_FOR[kind];
  if (geometry.kind !== expected) {
    throw badRequest(`A ${kind} annotation requires ${expected} geometry`);
  }
}

export function createAnnotation(
  userId: string,
  fileId: string,
  input: z.infer<typeof createAnnotationSchema>,
): ReturnType<typeof shapeAnnotation> {
  const pdf = requirePdf(userId, fileId);
  assertGeometryMatchesKind(input.kind, input.geometry);
  // A text mark is its words. One with none would be an invisible thing on the
  // page that can still be clicked, which is worse than a refusal.
  if (input.kind === 'text' && !input.note?.trim()) {
    throw badRequest('A text annotation needs some text');
  }

  if (pdf.page_count !== null && input.page > pdf.page_count) {
    throw badRequest(`Page ${input.page} is beyond the end of this document`);
  }

  const now = Date.now();
  const id = newId();

  getDb()
    .prepare(
      `INSERT INTO annotations
         (id, user_id, file_id, page, kind, geometry, color, quoted_text, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      userId,
      fileId,
      input.page,
      input.kind,
      JSON.stringify(input.geometry),
      input.color ?? null,
      input.quotedText ?? null,
      input.note ?? null,
      now,
      now,
    );

  // "Annotations stay with the PDF and appear in search."
  search.indexEntity({
    userId,
    entityType: 'annotation',
    entityId: id,
    fileId,
    title: input.quotedText?.slice(0, 200) ?? `${input.kind} on page ${input.page}`,
    body: [input.quotedText, input.note].filter(Boolean).join('\n'),
  });

  getDb().prepare('UPDATE files SET updated_at = ? WHERE id = ?').run(now, fileId);
  return requireAnnotation(userId, id);
}

export function requireAnnotation(userId: string, annotationId: string) {
  const row = getDb()
    .prepare<[string, string], AnnotationRow>(
      'SELECT * FROM annotations WHERE id = ? AND user_id = ?',
    )
    .get(annotationId, userId);
  if (!row) throw notFound('Annotation not found');
  return shapeAnnotation(row);
}

/** Ensures the annotation both belongs to the caller and lives in this file. */
export function requireAnnotationInFile(userId: string, fileId: string, annotationId: string) {
  const annotation = requireAnnotation(userId, annotationId);
  if (annotation.file_id !== fileId) throw notFound('Annotation not found');
  return annotation;
}

export function listAnnotations(userId: string, fileId: string, opts: { page?: number } = {}) {
  requirePdf(userId, fileId);
  const rows = opts.page
    ? getDb()
        .prepare<[string, string, number], AnnotationRow>(
          'SELECT * FROM annotations WHERE user_id = ? AND file_id = ? AND page = ? ORDER BY page, created_at',
        )
        .all(userId, fileId, opts.page)
    : getDb()
        .prepare<[string, string], AnnotationRow>(
          'SELECT * FROM annotations WHERE user_id = ? AND file_id = ? ORDER BY page, created_at',
        )
        .all(userId, fileId);
  return rows.map(shapeAnnotation);
}

export function updateAnnotation(
  userId: string,
  annotationId: string,
  patch: { note?: string | null; color?: string | null },
) {
  requireAnnotation(userId, annotationId);
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE annotations SET
         note = CASE WHEN ? THEN ? ELSE note END,
         color = CASE WHEN ? THEN ? ELSE color END,
         updated_at = ?
       WHERE id = ? AND user_id = ?`,
    )
    .run(
      patch.note !== undefined ? 1 : 0,
      patch.note ?? null,
      patch.color !== undefined ? 1 : 0,
      patch.color ?? null,
      now,
      annotationId,
      userId,
    );

  const updated = requireAnnotation(userId, annotationId);
  search.indexEntity({
    userId,
    entityType: 'annotation',
    entityId: annotationId,
    fileId: updated.file_id,
    title: updated.quoted_text?.slice(0, 200) ?? `${updated.kind} on page ${updated.page}`,
    body: [updated.quoted_text, updated.note].filter(Boolean).join('\n'),
  });
  return updated;
}

export function deleteAnnotation(userId: string, annotationId: string): void {
  requireAnnotation(userId, annotationId);
  tx(() => {
    search.removeEntity('annotation', annotationId);
    getDb().prepare('DELETE FROM annotations WHERE id = ? AND user_id = ?').run(annotationId, userId);
  });
}

/* -------------------------- cards from highlights ------------------------- */

export const cardsFromHighlightsSchema = z.object({
  deckId: uuid,
  annotationIds: z.array(uuid).min(1).max(200).optional(),
});

/**
 * Turns marked-up passages into flashcards, skipping any that already produced
 * one so the action is safe to repeat.
 *
 * The selection is "carries quoted text", not "is a highlight". Quoted text is
 * the actual precondition — it becomes the front of the card, and an annotation
 * without it is skipped below regardless of kind. Requiring the highlight kind
 * as well excluded the notes the reader screen can actually make: the embedded
 * PDF viewer does not expose its text selection, so the app has no quads to
 * anchor a real highlight to and records a page-anchored comment instead.
 */
export function createCardsFromHighlights(
  userId: string,
  fileId: string,
  input: z.infer<typeof cardsFromHighlightsSchema>,
): { created: number; skipped: number; cardIds: string[] } {
  const file = requireFile(userId, fileId);
  requirePdf(userId, fileId);

  const all = listAnnotations(userId, fileId).filter((a) => Boolean(a.quoted_text?.trim()));
  const selected = input.annotationIds
    ? all.filter((a) => input.annotationIds!.includes(a.id))
    : all;

  return tx(() => {
    const cardIds: string[] = [];
    let skipped = 0;

    for (const annotation of selected) {
      if (annotation.card_id) {
        skipped += 1;
        continue;
      }
      const front = annotation.quoted_text?.trim();
      if (!front) {
        skipped += 1;
        continue;
      }

      const card = createCard(userId, {
        deckId: input.deckId,
        front,
        back: annotation.note?.trim() || '',
        topic: `${file.title} · p${annotation.page}`,
        sourceFileId: fileId,
        sourceAnnotationId: annotation.id,
      });

      getDb()
        .prepare('UPDATE annotations SET card_id = ?, updated_at = ? WHERE id = ? AND user_id = ?')
        .run(card.id, Date.now(), annotation.id, userId);
      cardIds.push(card.id);
    }

    return { created: cardIds.length, skipped, cardIds };
  });
}

/** "Export notes" — the annotation list as portable markdown. */
export function exportAnnotations(userId: string, fileId: string): string {
  const file = requireFile(userId, fileId);
  const annotations = listAnnotations(userId, fileId);

  const lines: string[] = [`# ${file.title}`, ''];
  let currentPage = -1;
  for (const a of annotations) {
    if (a.page !== currentPage) {
      currentPage = a.page;
      lines.push(`## Page ${a.page}`, '');
    }
    if (a.quoted_text) lines.push(`> ${a.quoted_text.replace(/\n/g, '\n> ')}`, '');
    if (a.note) lines.push(a.note, '');
    if (!a.quoted_text && !a.note) lines.push(`_${a.kind}_`, '');
  }
  return lines.join('\n');
}
