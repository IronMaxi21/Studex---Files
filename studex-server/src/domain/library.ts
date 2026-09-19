import { getDb, tx } from '../lib/db.js';
import { newId } from '../lib/ids.js';
import { deleteBlob } from '../lib/storage.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import * as search from './search.js';
import * as tags from './tags.js';
import { assertCanCreate } from './plan.js';
import { waitingNow } from './due.js';
import { reindexFile } from './reindex.js';

export type FileKind = 'canvas' | 'doc' | 'pdf' | 'deck';

export interface FolderRow {
  id: string;
  user_id: string;
  parent_id: string | null;
  subject_id: string | null;
  name: string;
  color: string | null;
  pinned: number;
  position: number;
  created_at: number;
  updated_at: number;
}

export interface FileRow {
  id: string;
  user_id: string;
  folder_id: string | null;
  kind: FileKind;
  title: string;
  color_override: string | null;
  pinned: number;
  trashed_at: number | null;
  created_at: number;
  updated_at: number;
}

/**
 * The single authorisation primitive: a row is only ever returned when it
 * belongs to the calling user. Every read and write path goes through one of
 * these, so a guessed id from another account is indistinguishable from a
 * nonexistent one.
 */
export function requireFolder(userId: string, folderId: string): FolderRow {
  const row = getDb()
    .prepare<[string, string], FolderRow>(
      'SELECT * FROM folders WHERE id = ? AND user_id = ?',
    )
    .get(folderId, userId);
  if (!row) throw notFound('Folder not found');
  return row;
}

export function requireFile(userId: string, fileId: string, opts: { includeTrashed?: boolean } = {}): FileRow {
  const row = getDb()
    .prepare<[string, string], FileRow>('SELECT * FROM files WHERE id = ? AND user_id = ?')
    .get(fileId, userId);
  if (!row) throw notFound('File not found');
  if (row.trashed_at !== null && !opts.includeTrashed) throw notFound('File not found');
  return row;
}

export function requireSubject(userId: string, subjectId: string) {
  const row = getDb()
    .prepare<[string, string], { id: string; name: string; color: string; teacher: string | null }>(
      'SELECT id, name, color, teacher FROM subjects WHERE id = ? AND user_id = ?',
    )
    .get(subjectId, userId);
  if (!row) throw notFound('Subject not found');
  return row;
}

/* ------------------------------- subjects -------------------------------- */

export function listSubjects(userId: string) {
  return getDb()
    .prepare(
      'SELECT id, name, color, teacher, position, created_at FROM subjects WHERE user_id = ? ORDER BY position, name',
    )
    .all(userId);
}

export function createSubject(
  userId: string,
  input: { name: string; color?: string; teacher?: string | null },
) {
  const now = Date.now();
  const id = newId();
  try {
    getDb()
      .prepare(
        `INSERT INTO subjects (id, user_id, name, color, teacher, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM subjects WHERE user_id = ?), ?, ?)`,
      )
      .run(id, userId, input.name, input.color ?? 'accent', input.teacher ?? null, userId, now, now);
  } catch (err) {
    if (String(err).includes('UNIQUE')) throw conflict('A subject with that name already exists');
    throw err;
  }
  return requireSubject(userId, id);
}

export function updateSubject(
  userId: string,
  subjectId: string,
  patch: { name?: string; color?: string; teacher?: string | null },
) {
  const current = requireSubject(userId, subjectId);
  try {
    getDb()
      .prepare('UPDATE subjects SET name = ?, color = ?, teacher = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .run(
        patch.name ?? current.name,
        patch.color ?? current.color,
        patch.teacher !== undefined ? patch.teacher : current.teacher,
        Date.now(),
        subjectId,
        userId,
      );
  } catch (err) {
    if (String(err).includes('UNIQUE')) throw conflict('A subject with that name already exists');
    throw err;
  }
  return requireSubject(userId, subjectId);
}

/* -------------------------------- folders -------------------------------- */

const MAX_FOLDER_DEPTH = 12;

function folderDepth(userId: string, folderId: string | null): number {
  let depth = 0;
  let current = folderId;
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current)) throw badRequest('Folder hierarchy is cyclic');
    seen.add(current);
    const row = requireFolder(userId, current);
    current = row.parent_id;
    depth += 1;
    if (depth > MAX_FOLDER_DEPTH) break;
  }
  return depth;
}

/** True when `candidateId` is `folderId` or lives underneath it. */
function isDescendant(userId: string, folderId: string, candidateId: string): boolean {
  let current: string | null = candidateId;
  const seen = new Set<string>();
  while (current) {
    if (current === folderId) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    const row: FolderRow = requireFolder(userId, current);
    current = row.parent_id;
  }
  return false;
}

export function createFolder(
  userId: string,
  input: { name: string; parentId?: string | null; subjectId?: string | null; color?: string | null },
) {
  if (input.parentId) {
    requireFolder(userId, input.parentId);
    if (folderDepth(userId, input.parentId) >= MAX_FOLDER_DEPTH) {
      throw badRequest(`Folders may not nest more than ${MAX_FOLDER_DEPTH} deep`);
    }
  }
  if (input.subjectId) requireSubject(userId, input.subjectId);

  const now = Date.now();
  const id = newId();
  getDb()
    .prepare(
      `INSERT INTO folders (id, user_id, parent_id, subject_id, name, color, pinned, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0,
               (SELECT COALESCE(MAX(position), 0) + 1 FROM folders WHERE user_id = ? AND parent_id IS ?),
               ?, ?)`,
    )
    .run(
      id,
      userId,
      input.parentId ?? null,
      input.subjectId ?? null,
      input.name,
      input.color ?? null,
      userId,
      input.parentId ?? null,
      now,
      now,
    );

  search.indexEntity({
    userId,
    entityType: 'folder',
    entityId: id,
    fileId: null,
    title: input.name,
    body: '',
  });
  return requireFolder(userId, id);
}

export function updateFolder(
  userId: string,
  folderId: string,
  patch: {
    name?: string;
    color?: string | null;
    pinned?: boolean;
    parentId?: string | null;
    subjectId?: string | null;
  },
) {
  const folder = requireFolder(userId, folderId);

  if (patch.parentId !== undefined && patch.parentId !== folder.parent_id) {
    if (patch.parentId !== null) {
      requireFolder(userId, patch.parentId);
      // Reparenting a folder into its own subtree would orphan the branch.
      if (isDescendant(userId, folderId, patch.parentId)) {
        throw badRequest('A folder cannot be moved inside itself');
      }
    }
  }
  if (patch.subjectId) requireSubject(userId, patch.subjectId);

  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE folders SET
         name = COALESCE(?, name),
         color = CASE WHEN ? THEN ? ELSE color END,
         pinned = COALESCE(?, pinned),
         parent_id = CASE WHEN ? THEN ? ELSE parent_id END,
         subject_id = CASE WHEN ? THEN ? ELSE subject_id END,
         updated_at = ?
       WHERE id = ? AND user_id = ?`,
    )
    .run(
      patch.name ?? null,
      patch.color !== undefined ? 1 : 0,
      patch.color ?? null,
      patch.pinned === undefined ? null : patch.pinned ? 1 : 0,
      patch.parentId !== undefined ? 1 : 0,
      patch.parentId ?? null,
      patch.subjectId !== undefined ? 1 : 0,
      patch.subjectId ?? null,
      now,
      folderId,
      userId,
    );

  const updated = requireFolder(userId, folderId);
  search.indexEntity({
    userId,
    entityType: 'folder',
    entityId: folderId,
    fileId: null,
    title: updated.name,
    body: '',
  });
  return updated;
}

/** Deletes a folder and everything inside it (SQLite cascades handle the tree). */
export function deleteFolder(userId: string, folderId: string): void {
  requireFolder(userId, folderId);
  const orphaned = tx(() => {
    const descendantIds = collectSubtreeFolderIds(userId, folderId);
    const fileIds = descendantIds.length
      ? getDb()
          .prepare<string[], { id: string }>(
            `SELECT id FROM files WHERE user_id = ? AND folder_id IN (${descendantIds.map(() => '?').join(',')})`,
          )
          .all(userId, ...descendantIds)
          .map((r) => r.id)
      : [];

    for (const id of descendantIds) search.removeEntity('folder', id);
    for (const id of fileIds) search.removeForFile(id);
    // `tag_items.item_id` points at one of two tables and so cannot be a
    // foreign key; these are the rows the database cannot clear for itself.
    tags.forgetItems(userId, 'folder', descendantIds);
    tags.forgetItems(userId, 'file', fileIds);
    const keys = releaseStorageForFiles(userId, fileIds);
    getDb().prepare('DELETE FROM folders WHERE id = ? AND user_id = ?').run(folderId, userId);
    return keys;
  });
  void unlinkBlobs(orphaned);
}

function collectSubtreeFolderIds(userId: string, rootId: string): string[] {
  const out: string[] = [];
  const queue = [rootId];
  while (queue.length) {
    const current = queue.shift()!;
    out.push(current);
    if (out.length > 10_000) break;
    const children = getDb()
      .prepare<[string, string], { id: string }>(
        'SELECT id FROM folders WHERE user_id = ? AND parent_id = ?',
      )
      .all(userId, current);
    queue.push(...children.map((c) => c.id));
  }
  return out;
}

export function listFolders(userId: string) {
  const rows = getDb()
    .prepare<[string], FolderRow & { file_count: number }>(
      `SELECT f.*,
              (SELECT COUNT(*) FROM files x WHERE x.folder_id = f.id AND x.trashed_at IS NULL) AS file_count
       FROM folders f WHERE f.user_id = ? ORDER BY f.position, f.name`,
    )
    .all(userId);

  const byId = new Map(rows.map((r) => [r.id, r]));
  return rows.map((r) => ({
    ...r,
    pinned: r.pinned === 1,
    effective_color: resolveFolderColor(r, byId),
  }));
}

/**
 * "Colour is inherited from the folder unless a file overrides it."
 * Walks up the tree to the nearest ancestor that sets a colour.
 */
function resolveFolderColor(folder: FolderRow, byId: Map<string, FolderRow>): string {
  let current: FolderRow | undefined = folder;
  const seen = new Set<string>();
  while (current) {
    if (current.color) return current.color;
    if (seen.has(current.id)) break;
    seen.add(current.id);
    current = current.parent_id ? byId.get(current.parent_id) : undefined;
  }
  return 'accent';
}

export function effectiveFileColor(userId: string, file: FileRow): string {
  if (file.color_override) return file.color_override;
  if (!file.folder_id) return 'accent';
  const folders = new Map(
    getDb()
      .prepare<[string], FolderRow>('SELECT * FROM folders WHERE user_id = ?')
      .all(userId)
      .map((f) => [f.id, f]),
  );
  const folder = folders.get(file.folder_id);
  return folder ? resolveFolderColor(folder, folders) : 'accent';
}

/* --------------------------------- files --------------------------------- */

export function createFile(
  userId: string,
  input: {
    title: string;
    kind: FileKind;
    folderId?: string | null;
    colorOverride?: string | null;
    /** The file this one was generated from, e.g. the doc a deck came from. */
    sourceFileId?: string | null;
    /** Canvases only: the paper it starts on. */
    background?: string | null;
    /**
     * Documents only: how the page draws itself. Spelled out here rather than
     * imported from ./documents.js, which imports createFile from this module.
     */
    style?: 'standard' | 'bulleted' | null;
  },
  opts: {
    /**
     * Off for a restore. Pull is not the student making a fourth canvas — it
     * is their own library arriving on a second Mac, and a tier limit that
     * refused it would leave the two devices permanently unable to agree.
     * Storage quota still applies, because that is about disk, not about tier.
     */
    enforcePlanLimits?: boolean;
  } = {},
): FileRow {
  if (input.folderId) requireFolder(userId, input.folderId);
  if (input.sourceFileId) requireFile(userId, input.sourceFileId);

  const now = Date.now();
  const id = newId();

  return tx(() => {
    // Inside the transaction: two uploads racing at the last free slot must
    // not both find room.
    if (opts.enforcePlanLimits !== false) assertCanCreate(userId, input.kind);

    getDb()
      .prepare(
        `INSERT INTO files (id, user_id, folder_id, kind, title, color_override, pinned, source_file_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(id, userId, input.folderId ?? null, input.kind, input.title, input.colorOverride ?? null, input.sourceFileId ?? null, now, now);

    // Each kind carries a companion row holding its content.
    if (input.kind === 'doc') {
      getDb()
        .prepare('INSERT INTO documents (file_id, blocks, style, updated_at) VALUES (?, ?, ?, ?)')
        .run(id, '[]', input.style === 'bulleted' ? 'bulleted' : 'standard', now);
    } else if (input.kind === 'canvas') {
      getDb()
        .prepare(
          'INSERT INTO canvases (file_id, objects, viewport, background, updated_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(id, '[]', JSON.stringify({ x: 0, y: 0, zoom: 1 }), input.background ?? 'dots', now);
    } else if (input.kind === 'deck') {
      getDb().prepare('INSERT INTO decks (file_id, updated_at) VALUES (?, ?)').run(id, now);
    }

    search.indexEntity({
      userId,
      entityType: 'file',
      entityId: id,
      fileId: id,
      title: input.title,
      body: '',
    });

    return requireFile(userId, id);
  });
}

export function updateFile(
  userId: string,
  fileId: string,
  patch: { title?: string; folderId?: string | null; colorOverride?: string | null; pinned?: boolean },
): FileRow {
  requireFile(userId, fileId);
  if (patch.folderId) requireFolder(userId, patch.folderId);

  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE files SET
         title = COALESCE(?, title),
         folder_id = CASE WHEN ? THEN ? ELSE folder_id END,
         color_override = CASE WHEN ? THEN ? ELSE color_override END,
         pinned = COALESCE(?, pinned),
         updated_at = ?
       WHERE id = ? AND user_id = ?`,
    )
    .run(
      patch.title ?? null,
      patch.folderId !== undefined ? 1 : 0,
      patch.folderId ?? null,
      patch.colorOverride !== undefined ? 1 : 0,
      patch.colorOverride ?? null,
      patch.pinned === undefined ? null : patch.pinned ? 1 : 0,
      now,
      fileId,
      userId,
    );

  const updated = requireFile(userId, fileId);
  if (patch.title) {
    search.indexEntity({
      userId,
      entityType: 'file',
      entityId: fileId,
      fileId,
      title: updated.title,
      body: '',
    });
  }
  return updated;
}

export function trashFile(userId: string, fileId: string): void {
  requireFile(userId, fileId);
  getDb()
    .prepare('UPDATE files SET trashed_at = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(Date.now(), Date.now(), fileId, userId);
  // Not just the file: its annotations, its cards and its text came from it and
  // go with it, or the search results outlive the thing they point at.
  search.removeForFile(fileId);
}

export function restoreFile(userId: string, fileId: string): FileRow {
  const trashed = requireFile(userId, fileId, { includeTrashed: true });
  // A cap counts what is live, and the trash is not live — so without this,
  // the limit is a formality: fill up, trash the lot, fill up again, then
  // restore, and a Free account is holding twice what it is allowed. Checked
  // against the kind coming back, and phrased as what it is: no room for it.
  assertCanCreate(userId, trashed.kind, { verb: 'restore' });
  getDb()
    .prepare('UPDATE files SET trashed_at = NULL, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(Date.now(), fileId, userId);
  const file = requireFile(userId, fileId);
  // Trashing swept out the file's cards, annotations and text along with it, so
  // restoring has to put them all back — indexing the file alone would return a
  // deck whose cards had become unfindable.
  reindexFile(userId, file);
  return file;
}

/** How long the trash keeps a file before it is gone for good. */
export const TRASH_DAYS = 30;

/**
 * Empties whatever has sat in the trash past its time, for every account.
 * Returns how many files went. Run on a timer by the server.
 */
export function purgeExpiredTrash(now = Date.now()): number {
  const cutoff = now - TRASH_DAYS * 24 * 60 * 60 * 1000;
  const rows = getDb()
    .prepare<[number], { id: string; user_id: string }>(
      'SELECT id, user_id FROM files WHERE trashed_at IS NOT NULL AND trashed_at < ?',
    )
    .all(cutoff);
  for (const row of rows) purgeFile(row.user_id, row.id);
  return rows.length;
}

/** Permanent removal, including the blob and its quota accounting. */
export function purgeFile(userId: string, fileId: string): void {
  requireFile(userId, fileId, { includeTrashed: true });
  const orphaned = tx(() => {
    const keys = releaseStorageForFiles(userId, [fileId]);
    // The kept earlier versions go with the file. Their rows fall to the
    // foreign key, so the blobs have to be named before the file row goes or
    // they stay on disk with nothing pointing at them. They were never charged
    // against the quota, so nothing is credited back for them.
    keys.push(...revisionBlobsForFile(userId, fileId));
    search.removeForFile(fileId);
    tags.forgetItems(userId, 'file', [fileId]);
    getDb().prepare('DELETE FROM files WHERE id = ? AND user_id = ?').run(fileId, userId);
    return keys;
  });
  void unlinkBlobs(orphaned);
}

/** The blobs behind a file's kept earlier versions. */
function revisionBlobsForFile(userId: string, fileId: string): string[] {
  return getDb()
    .prepare<[string, string], { storage_key: string }>(
      'SELECT storage_key FROM file_revisions WHERE user_id = ? AND file_id = ?',
    )
    .all(userId, fileId)
    .map((row) => row.storage_key);
}

/**
 * Gives back the space these files were using, and names the blobs that are
 * now unreferenced.
 *
 * Both the PDFs and the images inside documents live on disk under a storage
 * key; the row that names one is about to be deleted, so the key has to leave
 * the transaction with the caller or the bytes stay on disk forever.
 */
function releaseStorageForFiles(userId: string, fileIds: string[]): string[] {
  if (fileIds.length === 0) return [];
  const placeholders = fileIds.map(() => '?').join(',');

  const blobs = [
    ...getDb()
      .prepare<string[], { storage_key: string; byte_size: number }>(
        `SELECT storage_key, byte_size FROM pdf_files WHERE file_id IN (${placeholders})`,
      )
      .all(...fileIds),
    ...getDb()
      .prepare<string[], { storage_key: string; byte_size: number }>(
        `SELECT storage_key, byte_size FROM document_images WHERE file_id IN (${placeholders})`,
      )
      .all(...fileIds),
  ];

  const freed = blobs.reduce((total, blob) => total + blob.byte_size, 0);
  if (freed > 0) {
    getDb()
      .prepare(
        'UPDATE users SET storage_used_bytes = MAX(0, storage_used_bytes - ?), updated_at = ? WHERE id = ?',
      )
      .run(freed, Date.now(), userId);
  }
  return blobs.map((blob) => blob.storage_key);
}

/**
 * Unlinks blobs whose rows are already gone. Failures are swallowed on
 * purpose: the accounting is committed, and a file left behind on disk is a
 * smaller problem than an exception thrown out of a completed deletion.
 */
async function unlinkBlobs(keys: string[]): Promise<void> {
  for (const key of keys) await deleteBlob(key);
}

export interface ListFilesQuery {
  /** The trash instead of the library: only files that have been thrown away. */
  trashed?: boolean;
  folderId?: string | null;
  kind?: FileKind;
  pinned?: boolean;
  limit: number;
  offset: number;
  sort?: 'recent' | 'title';
}

/**
 * The filter both `listFiles` and `countFiles` read from, so a page and the
 * total it is a page of can never be answering different questions.
 */
function filesWhere(
  userId: string,
  q: Omit<ListFilesQuery, 'limit' | 'offset'>,
): { where: string; params: unknown[] } {
  const where: string[] = ['f.user_id = ?', q.trashed ? 'f.trashed_at IS NOT NULL' : 'f.trashed_at IS NULL'];
  const params: unknown[] = [userId];

  // A trashed file's folder may be gone, so the trash is one flat list.
  if (q.folderId !== undefined && !q.trashed) {
    if (q.folderId === null) {
      where.push('f.folder_id IS NULL');
    } else {
      requireFolder(userId, q.folderId);
      where.push('f.folder_id = ?');
      params.push(q.folderId);
    }
  }
  if (q.kind) {
    where.push('f.kind = ?');
    params.push(q.kind);
  }
  if (q.pinned !== undefined) {
    where.push('f.pinned = ?');
    params.push(q.pinned ? 1 : 0);
  }

  return { where: where.join(' AND '), params };
}

/**
 * How many files the same filter matches, so a client can page through them
 * without first having to read all of them to find out how many there were.
 */
export function countFiles(userId: string, q: Omit<ListFilesQuery, 'limit' | 'offset'>): number {
  const { where, params } = filesWhere(userId, q);
  const row = getDb()
    .prepare<unknown[], { total: number }>(`SELECT COUNT(*) AS total FROM files f WHERE ${where}`)
    .get(...params);
  return row?.total ?? 0;
}

export function listFiles(userId: string, q: ListFilesQuery) {
  const { where, params: filter } = filesWhere(userId, q);
  const order = q.sort === 'title'
    ? 'f.title COLLATE NOCASE ASC'
    : q.trashed ? 'f.trashed_at DESC' : 'f.updated_at DESC';

  // Placeholders bind positionally, and the due_count subquery's `?` comes
  // first in the statement text — so its value leads, ahead of the WHERE
  // clause's own parameters and the page at the end.
  const params: unknown[] = [Date.now(), ...filter, q.limit, q.offset];

  const rows = getDb()
    .prepare<unknown[], FileRow & { card_count: number; due_count: number; annotation_count: number }>(
      `SELECT f.*,
              (SELECT COUNT(*) FROM cards c WHERE c.deck_id = f.id) AS card_count,
              (SELECT COUNT(*) FROM cards c WHERE c.deck_id = f.id AND ${waitingNow('c')}) AS due_count,
              (SELECT COUNT(*) FROM annotations a WHERE a.file_id = f.id) AS annotation_count
       FROM files f
       WHERE ${where}
       ORDER BY ${order}
       LIMIT ? OFFSET ?`,
    )
    .all(...params);

  const folders = new Map(
    getDb()
      .prepare<[string], FolderRow>('SELECT * FROM folders WHERE user_id = ?')
      .all(userId)
      .map((f) => [f.id, f]),
  );

  return rows.map((r) => ({
    ...r,
    pinned: r.pinned === 1,
    effective_color:
      r.color_override ??
      (r.folder_id && folders.has(r.folder_id)
        ? resolveFolderColor(folders.get(r.folder_id)!, folders)
        : 'accent'),
  }));
}

export function storageUsage(userId: string) {
  const row = getDb()
    .prepare<[string], { storage_used_bytes: number; storage_quota_bytes: number }>(
      'SELECT storage_used_bytes, storage_quota_bytes FROM users WHERE id = ?',
    )
    .get(userId);
  if (!row) throw notFound('User not found');
  return {
    used_bytes: row.storage_used_bytes,
    quota_bytes: row.storage_quota_bytes,
    used_fraction: row.storage_quota_bytes > 0 ? row.storage_used_bytes / row.storage_quota_bytes : 0,
  };
}
