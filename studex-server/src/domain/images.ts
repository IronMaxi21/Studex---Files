/**
 * Images placed inside documents.
 *
 * An image is not a file in the library. It has no page of its own, is never
 * opened alone, and putting one in the sidebar next to a student's notes would
 * be noise — so it belongs to the document that holds it, and goes when that
 * document goes. What it does share with a PDF is the disk it sits on, so it
 * is admitted, counted and released the same way.
 */
import type { Readable } from 'node:stream';
import { config } from '../lib/config.js';
import { getDb, tx } from '../lib/db.js';
import { newId } from '../lib/ids.js';
import { badRequest, notFound, quotaExceeded } from '../lib/errors.js';
import { deleteBlob, storeStream, type HeadCheck } from '../lib/storage.js';
import { requireFile } from './library.js';

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface ImageRow {
  id: string;
  user_id: string;
  file_id: string;
  storage_key: string;
  mime: ImageMime;
  byte_size: number;
  sha256: string;
  original_name: string;
  created_at: number;
}

/**
 * What the bytes are, read from the bytes.
 *
 * The four formats every browser renders. A file that is not one of them is
 * refused rather than stored under a type it does not have — the served
 * Content-Type comes from here, and it has to be true.
 */
function sniff(head: Buffer): ImageMime | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 6 && head.subarray(0, 6).toString('ascii').match(/^GIF8[79]a$/)) return 'image/gif';
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString('ascii') === 'RIFF' &&
    head.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/** An image bigger than this is a scan, and belongs in the PDF reader. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export async function addImage(
  userId: string,
  input: {
    fileId: string;
    stream: Readable;
    originalName: string;
    /** See StoreOptions.complete — a truncated upload must not become a row. */
    complete?: () => boolean;
  },
): Promise<ImageRow> {
  const file = requireFile(userId, input.fileId);
  // A deck holds the diagrams its occlusion cards are drawn over.
  if (file.kind !== 'doc' && file.kind !== 'deck') throw badRequest('Images can only be added to documents and decks');

  const usage = getDb()
    .prepare<[string], { storage_used_bytes: number; storage_quota_bytes: number }>(
      'SELECT storage_used_bytes, storage_quota_bytes FROM users WHERE id = ?',
    )
    .get(userId);
  if (!usage) throw notFound('User not found');

  const remaining = usage.storage_quota_bytes - usage.storage_used_bytes;
  if (remaining <= 0) throw quotaExceeded('Storage quota exceeded');

  // The sniff runs inside the stream, so a file that is not an image is
  // rejected while it is arriving rather than after it has been written.
  const detected: { mime: ImageMime | null } = { mime: null };
  const format: HeadCheck = {
    bytes: 12,
    message: 'That file is not a PNG, JPEG, GIF or WebP image',
    test: (head) => {
      detected.mime = sniff(head);
      return detected.mime !== null;
    },
  };

  const maxBytes = Math.min(config.maxUploadBytes, MAX_IMAGE_BYTES, remaining);
  const blob = await storeStream(input.stream, {
    maxBytes,
    expectFormat: format,
    complete: input.complete,
  });
  const mime = detected.mime;
  if (!mime) {
    await deleteBlob(blob.key);
    throw badRequest('That file is not a PNG, JPEG, GIF or WebP image');
  }

  try {
    return tx(() => {
      const now = Date.now();
      const id = newId();
      getDb()
        .prepare(
          `INSERT INTO document_images (id, user_id, file_id, storage_key, mime, byte_size, sha256, original_name, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, userId, input.fileId, blob.key, mime, blob.byteSize, blob.sha256, input.originalName, now);

      // Re-checked inside the transaction: two uploads that each fit on their
      // own must not both be admitted.
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

      return requireImage(userId, id);
    });
  } catch (err) {
    await deleteBlob(blob.key);
    throw err;
  }
}

export function requireImage(userId: string, imageId: string): ImageRow {
  const row = getDb()
    .prepare<[string, string], ImageRow>('SELECT * FROM document_images WHERE id = ? AND user_id = ?')
    .get(imageId, userId);
  if (!row) throw notFound('Image not found');
  return row;
}

/**
 * Removes one image and gives back its space.
 *
 * Called when the block holding it is deleted. The blob is unlinked after the
 * row is gone, so a failure leaves an unreferenced file on disk rather than a
 * row pointing at nothing.
 */
export async function removeImage(userId: string, imageId: string): Promise<void> {
  const row = requireImage(userId, imageId);
  tx(() => {
    getDb().prepare('DELETE FROM document_images WHERE id = ? AND user_id = ?').run(imageId, userId);
    getDb()
      .prepare(
        'UPDATE users SET storage_used_bytes = MAX(0, storage_used_bytes - ?), updated_at = ? WHERE id = ?',
      )
      .run(row.byte_size, Date.now(), userId);
  });
  await deleteBlob(row.storage_key);
}
