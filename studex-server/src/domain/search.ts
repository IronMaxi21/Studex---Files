import { getDb } from '../lib/db.js';

export type EntityType = 'file' | 'annotation' | 'card' | 'folder';

export interface IndexInput {
  userId: string;
  entityType: EntityType;
  entityId: string;
  fileId: string | null;
  title: string;
  body: string;
}

/** Bounds what a single entity can contribute to the index. */
const MAX_BODY_CHARS = 200_000;

/**
 * Entity ids are only unique within their own type — a file and its
 * annotations are different rows in different tables — so the index is keyed
 * by the pair. Without this, indexing a file would overwrite the entry of an
 * entity that happened to share its id.
 */
const docKey = (entityType: EntityType, entityId: string): string => `${entityType}:${entityId}`;

export function indexEntity(input: IndexInput): void {
  const db = getDb();
  const body = input.body.slice(0, MAX_BODY_CHARS);

  const key = docKey(input.entityType, input.entityId);
  const existing = db
    .prepare<[string], { fts_rowid: number }>(
      'SELECT fts_rowid FROM search_docs WHERE entity_id = ?',
    )
    .get(key);

  if (existing) {
    db.prepare('UPDATE search_index SET title = ?, body = ? WHERE rowid = ?').run(
      input.title,
      body,
      existing.fts_rowid,
    );
    return;
  }

  const info = db
    .prepare(
      `INSERT INTO search_index (title, body, user_id, entity_type, entity_id, file_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(input.title, body, input.userId, input.entityType, input.entityId, input.fileId);

  db.prepare(
    `INSERT INTO search_docs (entity_id, user_id, entity_type, fts_rowid, file_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(key, input.userId, input.entityType, info.lastInsertRowid, input.fileId);
}

export function removeEntity(entityType: EntityType, entityId: string): void {
  const db = getDb();
  const key = docKey(entityType, entityId);
  const existing = db
    .prepare<[string], { fts_rowid: number }>(
      'SELECT fts_rowid FROM search_docs WHERE entity_id = ?',
    )
    .get(key);
  if (!existing) return;
  db.prepare('DELETE FROM search_index WHERE rowid = ?').run(existing.fts_rowid);
  db.prepare('DELETE FROM search_docs WHERE entity_id = ?').run(key);
}

/**
 * Takes a file and everything that came out of it out of the index.
 *
 * A file is not the only thing it contributes: a PDF puts its annotations in,
 * a deck puts its cards in, a document puts its text in. Removing the file
 * entity alone left all of those findable — and clicking a result would open a
 * file that is no longer there.
 */
export function removeForFile(fileId: string): void {
  const db = getDb();
  const rows = db
    .prepare<[string], { entity_id: string; fts_rowid: number }>(
      'SELECT entity_id, fts_rowid FROM search_docs WHERE file_id = ?',
    )
    .all(fileId);
  for (const row of rows) {
    db.prepare('DELETE FROM search_index WHERE rowid = ?').run(row.fts_rowid);
    db.prepare('DELETE FROM search_docs WHERE entity_id = ?').run(row.entity_id);
  }
}

/**
 * Turns free text into a safe FTS5 MATCH expression.
 *
 * FTS5 has its own query language (NEAR, OR, column filters, prefix operators).
 * Passing raw user input would let a caller alter query semantics or trigger
 * syntax errors, so every token is emitted as a quoted phrase — with embedded
 * double quotes doubled, which is FTS5's own escape — and given a prefix star.
 */
export function toMatchExpression(raw: string): string | null {
  const tokens = raw
    .normalize('NFC')
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 0)
    .slice(0, 12);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
}

export interface SearchHit {
  entity_type: EntityType;
  entity_id: string;
  file_id: string | null;
  title: string;
  snippet: string;
  rank: number;
}

export function search(
  userId: string,
  query: string,
  opts: { limit?: number; types?: EntityType[] } = {},
): SearchHit[] {
  const match = toMatchExpression(query);
  if (!match) return [];

  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const types = opts.types?.length ? opts.types : null;

  // user_id is compared inside SQL with a bound parameter, so results can
  // never cross accounts regardless of what the query text contains.
  const typeFilter = types ? ` AND entity_type IN (${types.map(() => '?').join(',')})` : '';
  const params: unknown[] = [match, userId, ...(types ?? []), limit];

  return getDb()
    .prepare<unknown[], SearchHit>(
      `SELECT entity_type, entity_id, file_id, title,
              snippet(search_index, 1, '[', ']', '…', 12) AS snippet,
              rank
       FROM search_index
       WHERE search_index MATCH ? AND user_id = ?${typeFilter}
       ORDER BY rank
       LIMIT ?`,
    )
    .all(...params);
}

/* ── the Spotlight corpus ─────────────────────────────────────────────── */

export interface CorpusItem {
  id: string;
  kind: string;
  title: string;
  text: string;
  updated_at: number;
}

/** How much of a file's text is worth handing to a system index. */
const CORPUS_TEXT_CHARS = 4_000;

/** A ceiling on one account's contribution, so the feed stays one message. */
const CORPUS_LIMIT = 2_000;

/**
 * Everything of this account's that should be findable from outside the app.
 *
 * This is the same text the in-app search reads, narrowed to whole files. A
 * Spotlight result has to be something that can be opened, and a card or an
 * annotation opens the file it belongs to — so indexing them separately would
 * put four rows in front of the student that all do the same thing. Their text
 * is still reachable: it is in the file's own indexed body.
 *
 * The body is cut short deliberately. Spotlight matches on it but only ever
 * shows a line of it, and a whole document repeated into the system index is a
 * copy of somebody's notes sitting where the app's own protections do not
 * reach.
 */
export function corpus(userId: string): CorpusItem[] {
  return getDb()
    .prepare<[string, number], CorpusItem>(
      `SELECT f.id            AS id,
              f.kind          AS kind,
              f.title         AS title,
              substr(COALESCE(s.body, ''), 1, ${CORPUS_TEXT_CHARS}) AS text,
              f.updated_at    AS updated_at
       FROM files f
       LEFT JOIN search_docs d
              ON d.entity_id = 'file:' || f.id
       LEFT JOIN search_index s
              ON s.rowid = d.fts_rowid
       WHERE f.user_id = ? AND f.trashed_at IS NULL
       ORDER BY f.updated_at DESC
       LIMIT ?`,
    )
    .all(userId, CORPUS_LIMIT);
}
