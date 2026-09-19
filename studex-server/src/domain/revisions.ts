/**
 * Earlier versions of a file.
 *
 * Studex keeps one file per file: a note edited on two Macs stays one note.
 * That only works if the losing side is kept somewhere, and this is that
 * somewhere — the state a file was in immediately before sync replaced it, or
 * before an older version was restored over it.
 *
 * It is deliberately small. There is no branching history and no diffing: a
 * short list of "what this file was", newest first, each of which can be put
 * back. That covers the case it exists for — "the other Mac won and I want my
 * paragraph back" — without turning the library into a version control system.
 */
import { getDb, tx } from '../lib/db.js';
import { deleteBlob, readBlob, storeBuffer } from '../lib/storage.js';
import { notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { applyBody } from './filebody.js';
import { bodyFor, type LocalFile } from './sync.js';

/**
 * How many versions a file keeps. Enough to cover a run of bad syncs on the
 * same afternoon, few enough that a large PDF edited often does not quietly
 * fill the disk with copies of itself.
 */
const KEEP_PER_FILE = 10;

export interface Revision {
  id: string;
  file_id: string;
  byte_size: number;
  reason: 'sync' | 'restore';
  created_at: number;
}

interface RevisionRow extends Revision {
  storage_key: string;
  sha256: string;
}

function fileRow(userId: string, fileId: string): LocalFile {
  const row = getDb()
    .prepare<[string, string], LocalFile>(
      'SELECT id, folder_id, kind, title, trashed_at FROM files WHERE id = ? AND user_id = ?',
    )
    .get(fileId, userId);
  if (!row) throw notFound('File not found');
  return row;
}

/** Everything kept for a file, newest first. */
export function listRevisions(userId: string, fileId: string): Revision[] {
  fileRow(userId, fileId);
  return getDb()
    .prepare<[string, string], Revision>(
      `SELECT id, file_id, byte_size, reason, created_at
         FROM file_revisions
        WHERE user_id = ? AND file_id = ?
        ORDER BY created_at DESC`,
    )
    .all(userId, fileId);
}

/**
 * Keeps what a file holds right now, before something replaces it.
 *
 * Returns null when there is nothing to keep — a file with no body yet, which
 * is the ordinary case for a note created and never typed into. Pruning older
 * copies happens here rather than on a timer, because this is the only moment
 * the count changes.
 */
export async function snapshotFile(
  userId: string,
  file: LocalFile,
  reason: 'sync' | 'restore',
): Promise<string | null> {
  const content = await bodyFor(file);
  if (!content) return null;

  const blob = await storeBuffer(content.body);
  const id = newId();
  const now = Date.now();

  const stale = tx(() => {
    getDb()
      .prepare(
        `INSERT INTO file_revisions
           (id, user_id, file_id, storage_key, byte_size, sha256, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, userId, file.id, blob.key, blob.byteSize, blob.sha256, reason, now);

    const doomed = getDb()
      .prepare<[string, string, number], { id: string; storage_key: string }>(
        `SELECT id, storage_key FROM file_revisions
          WHERE user_id = ? AND file_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT -1 OFFSET ?`,
      )
      .all(userId, file.id, KEEP_PER_FILE);
    for (const row of doomed) {
      getDb().prepare('DELETE FROM file_revisions WHERE id = ?').run(row.id);
    }
    return doomed;
  });

  // Outside the transaction: a failed unlink must not undo a correct row.
  for (const row of stale) await deleteBlob(row.storage_key);
  return id;
}

/**
 * Puts an earlier version back, keeping the current one in its place — so a
 * restore is itself undoable, and pressing it by mistake costs nothing.
 */
export async function restoreRevision(
  userId: string,
  fileId: string,
  revisionId: string,
): Promise<Revision[]> {
  const file = fileRow(userId, fileId);
  const row = getDb()
    .prepare<[string, string, string], RevisionRow>(
      `SELECT id, file_id, storage_key, byte_size, sha256, reason, created_at
         FROM file_revisions
        WHERE id = ? AND file_id = ? AND user_id = ?`,
    )
    .get(revisionId, fileId, userId);
  if (!row) throw notFound('That version is no longer kept');

  const body = await readBlob(row.storage_key);
  await snapshotFile(userId, file, 'restore');
  await applyBody(userId, file, body);
  return listRevisions(userId, fileId);
}

/** Drops everything kept for a file. Used when the file itself is gone. */
export async function forgetRevisions(userId: string, fileId: string): Promise<void> {
  const rows = getDb()
    .prepare<[string, string], { id: string; storage_key: string }>(
      'SELECT id, storage_key FROM file_revisions WHERE user_id = ? AND file_id = ?',
    )
    .all(userId, fileId);
  getDb().prepare('DELETE FROM file_revisions WHERE user_id = ? AND file_id = ?').run(userId, fileId);
  for (const row of rows) await deleteBlob(row.storage_key);
}
