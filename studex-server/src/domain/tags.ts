/**
 * Tags: the second axis of the library.
 *
 * A file lives in exactly one folder, so the tree can only ever answer one
 * question about it. A tag answers the others. "Photosynthesis" is a folder of
 * notes, a PDF of a past paper filed under Papers, a deck under Revision and a
 * whiteboard under Scratch; nothing in the tree can gather those, and building
 * a folder that could would mean moving four things out of where they belong.
 *
 * Two kinds of row end up here and they are deliberately not separated in the
 * reading. A tag typed into a document as `##photosynthesis` and a tag put on a
 * folder from its menu are the same tag on the same page — the first is derived
 * and rewritten on every save, the second is a fact the student asserted, and
 * the difference only matters when deciding which rows to replace.
 */
import { z } from 'zod';
import { getDb, tx } from '../lib/db.js';
import { newId } from '../lib/ids.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { text } from '../lib/validation.js';
import { requireFile, requireFolder } from './library.js';

export type ItemType = 'folder' | 'file';

export interface TagRow {
  id: string;
  user_id: string;
  name: string;
  key: string;
  color: string | null;
  created_at: number;
}

/** A tag as a screen wants it: with how much is on it. */
export interface TagSummary {
  id: string;
  name: string;
  key: string;
  color: string | null;
  folders: number;
  files: number;
  count: number;
}

/**
 * What a tag name may be.
 *
 * No whitespace, because a tag is also written inline as `##name` and a tag
 * with a space in it would end at the space anyway — accepting one here would
 * mean a tag that can be created but never typed. Everything else a keyboard
 * produces is allowed: the student's own words are the point.
 */
export const tagName = text(60).refine((s) => !/\s/.test(s), {
  message: 'A tag cannot contain spaces — use a hyphen or an underscore.',
});

export const createTagSchema = z.object({
  name: tagName,
  color: text(24).nullish(),
});

export const updateTagSchema = z
  .object({
    name: tagName.optional(),
    color: text(24).nullish(),
  })
  .refine((v) => v.name !== undefined || v.color !== undefined, {
    message: 'Nothing to change',
  });

export const attachSchema = z.object({
  /** Either an existing tag, or a name to find or make one by. */
  tagId: z.string().uuid().optional(),
  name: tagName.optional(),
  itemType: z.enum(['folder', 'file']),
  itemId: z.string().uuid(),
});

/* ── reading ──────────────────────────────────────────────────────────── */

/**
 * Every tag in the account with its two counts.
 *
 * Trashed files are left out of the count but the row is kept: a tag whose last
 * page is in the bin should read as empty rather than vanish, because restoring
 * the page has to bring the tag back with it and a tag that disappeared has
 * nowhere to come back to.
 */
export function listTags(userId: string): TagSummary[] {
  return getDb()
    .prepare<[string], TagSummary>(
      `SELECT t.id, t.name, t.key, t.color,
              (SELECT COUNT(*) FROM tag_items i
                 JOIN folders fo ON fo.id = i.item_id
                WHERE i.tag_id = t.id AND i.item_type = 'folder') AS folders,
              (SELECT COUNT(*) FROM tag_items i
                 JOIN files fi ON fi.id = i.item_id
                WHERE i.tag_id = t.id AND i.item_type = 'file' AND fi.trashed_at IS NULL) AS files
         FROM tags t
        WHERE t.user_id = ?
        ORDER BY t.key`,
    )
    .all(userId)
    .map((row) => ({ ...row, count: row.folders + row.files }));
}

/**
 * Which tags are on which things, for the whole account in one read. The
 * sidebar and the library draw a dot per tag and filter by tag without asking
 * the server once per row.
 */
export function tagLinks(userId: string): { tag_id: string; item_type: ItemType; item_id: string }[] {
  return getDb()
    .prepare<[string], { tag_id: string; item_type: ItemType; item_id: string }>(
      `SELECT i.tag_id, i.item_type, i.item_id
         FROM tag_items i JOIN tags t ON t.id = i.tag_id
        WHERE t.user_id = ?`,
    )
    .all(userId);
}

export function requireTag(userId: string, tagId: string): TagRow {
  const row = getDb()
    .prepare<[string, string], TagRow>('SELECT * FROM tags WHERE id = ? AND user_id = ?')
    .get(tagId, userId);
  if (!row) throw notFound('Tag');
  return row;
}

export function tagByName(userId: string, name: string): TagRow | null {
  return (
    getDb()
      .prepare<[string, string], TagRow>('SELECT * FROM tags WHERE user_id = ? AND key = ?')
      .get(userId, name.trim().toLowerCase()) ?? null
  );
}

export interface TaggedFolder {
  id: string;
  name: string;
  color: string | null;
  parent_id: string | null;
  file_count: number;
}

export interface TaggedFile {
  id: string;
  title: string;
  kind: string;
  color: string | null;
  folder_id: string | null;
  updated_at: number;
}

/** A tag and everything on it, whichever side of the library it came from. */
export function tagged(
  userId: string,
  key: string,
): { tag: TagRow; folders: TaggedFolder[]; files: TaggedFile[] } | null {
  const tag = tagByName(userId, key);
  if (!tag) return null;
  return { tag, folders: foldersFor(userId, tag.id), files: filesFor(userId, tag.id) };
}

function foldersFor(userId: string, tagId: string): TaggedFolder[] {
  return getDb()
    .prepare<[string, string], TaggedFolder>(
      `SELECT fo.id, fo.name, fo.color, fo.parent_id,
              (SELECT COUNT(*) FROM files x WHERE x.folder_id = fo.id AND x.trashed_at IS NULL) AS file_count
         FROM tag_items i
         JOIN folders fo ON fo.id = i.item_id
        WHERE i.user_id = ? AND i.tag_id = ? AND i.item_type = 'folder'
        ORDER BY fo.name
        LIMIT 500`,
    )
    .all(userId, tagId);
}

function filesFor(userId: string, tagId: string): TaggedFile[] {
  return getDb()
    .prepare<[string, string], TaggedFile>(
      `SELECT fi.id, fi.title, fi.kind, fi.color_override AS color, fi.folder_id, fi.updated_at
         FROM tag_items i
         JOIN files fi ON fi.id = i.item_id
        WHERE i.user_id = ? AND i.tag_id = ? AND i.item_type = 'file' AND fi.trashed_at IS NULL
        ORDER BY fi.updated_at DESC
        LIMIT 500`,
    )
    .all(userId, tagId);
}

/** The tags on one thing, in the order they read best: alphabetical. */
export function tagsFor(userId: string, itemType: ItemType, itemId: string): TagRow[] {
  return getDb()
    .prepare<[string, string, string], TagRow>(
      `SELECT t.* FROM tag_items i JOIN tags t ON t.id = i.tag_id
        WHERE i.user_id = ? AND i.item_type = ? AND i.item_id = ?
        ORDER BY t.key`,
    )
    .all(userId, itemType, itemId);
}

/**
 * Everything that shares a tag with this thing, itself excluded.
 *
 * This is the panel that makes the library feel joined up: standing on a page
 * about the Krebs cycle, the past paper and the deck that carry the same tag
 * are one line away, without either of them having had to be filed here.
 */
export function related(
  userId: string,
  itemType: ItemType,
  itemId: string,
): { folders: TaggedFolder[]; files: TaggedFile[] } {
  const ids = tagsFor(userId, itemType, itemId).map((t) => t.id);
  if (!ids.length) return { folders: [], files: [] };

  const seenFolders = new Map<string, TaggedFolder>();
  const seenFiles = new Map<string, TaggedFile>();
  for (const id of ids) {
    for (const folder of foldersFor(userId, id)) {
      if (!(itemType === 'folder' && folder.id === itemId)) seenFolders.set(folder.id, folder);
    }
    for (const file of filesFor(userId, id)) {
      if (!(itemType === 'file' && file.id === itemId)) seenFiles.set(file.id, file);
    }
  }
  return { folders: [...seenFolders.values()], files: [...seenFiles.values()] };
}

/* ── writing ──────────────────────────────────────────────────────────── */

/**
 * The tag called `name`, made if it is not there yet.
 *
 * Case is remembered from whoever wrote it first and not overwritten after:
 * someone who typed `##Biology` on Monday and `##biology` on Tuesday meant one
 * tag, and having the display name flip between them is worse than either.
 */
export function ensureTag(userId: string, name: string, color: string | null = null): TagRow {
  const trimmed = name.trim();
  const key = trimmed.toLowerCase();
  if (!key) throw badRequest('A tag needs a name.');

  const existing = tagByName(userId, key);
  if (existing) return existing;

  const id = newId();
  const now = Date.now();
  getDb()
    .prepare('INSERT INTO tags (id, user_id, name, key, color, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, userId, trimmed, key, color, now);
  return { id, user_id: userId, name: trimmed, key, color, created_at: now };
}

export function createTag(userId: string, input: z.infer<typeof createTagSchema>): TagRow {
  const key = input.name.trim().toLowerCase();
  if (tagByName(userId, key)) throw conflict('There is already a tag with that name.');
  return ensureTag(userId, input.name, input.color ?? null);
}

export function updateTag(userId: string, tagId: string, input: z.infer<typeof updateTagSchema>): TagRow {
  const tag = requireTag(userId, tagId);
  const name = input.name?.trim() ?? tag.name;
  const key = name.toLowerCase();

  const clash = tagByName(userId, key);
  if (clash && clash.id !== tag.id) throw conflict('There is already a tag with that name.');

  const color = input.color === undefined ? tag.color : (input.color ?? null);
  getDb()
    .prepare('UPDATE tags SET name = ?, key = ?, color = ? WHERE id = ? AND user_id = ?')
    .run(name, key, color, tagId, userId);
  return { ...tag, name, key, color };
}

/**
 * Removes a tag and everything that pointed at it.
 *
 * The `tag_items` rows go by cascade. The `##name` still written in a document
 * is left alone: it is the student's text, deleting it would be an edit nobody
 * asked for, and the next save of that page simply makes the tag again — which
 * is the honest outcome, because the tag is still written down.
 */
export function deleteTag(userId: string, tagId: string): void {
  requireTag(userId, tagId);
  getDb().prepare('DELETE FROM tags WHERE id = ? AND user_id = ?').run(tagId, userId);
}

/** Puts a tag on a folder or a file, making the tag if it is named rather than chosen. */
export function attach(
  userId: string,
  input: z.infer<typeof attachSchema>,
): { tag: TagRow; itemType: ItemType; itemId: string } {
  if (!input.tagId && !input.name) throw badRequest('Name a tag or choose one.');
  requireItem(userId, input.itemType, input.itemId);

  return tx(() => {
    const tag = input.tagId ? requireTag(userId, input.tagId) : ensureTag(userId, input.name!);
    getDb()
      .prepare(
        `INSERT INTO tag_items (user_id, tag_id, item_type, item_id, source, added_at)
         VALUES (?, ?, ?, ?, 'manual', ?)
         ON CONFLICT (tag_id, item_type, item_id)
           DO UPDATE SET source = 'manual'`,
      )
      .run(userId, tag.id, input.itemType, input.itemId, Date.now());
    return { tag, itemType: input.itemType, itemId: input.itemId };
  });
}

export function detach(userId: string, tagId: string, itemType: ItemType, itemId: string): void {
  requireTag(userId, tagId);
  getDb()
    .prepare('DELETE FROM tag_items WHERE user_id = ? AND tag_id = ? AND item_type = ? AND item_id = ?')
    .run(userId, tagId, itemType, itemId);
}

function requireItem(userId: string, itemType: ItemType, itemId: string): void {
  if (itemType === 'folder') requireFolder(userId, itemId);
  else requireFile(userId, itemId);
}

/**
 * Replaces the tags this document's own text puts on it.
 *
 * Called from the document save, inside its transaction. Only 'text' rows are
 * touched: a tag someone attached by hand is not the document's to remove, and
 * deleting it because the word is not written in the page would undo a choice
 * on every keystroke that saved.
 */
export function syncTextTags(userId: string, fileId: string, names: Iterable<string>): void {
  const db = getDb();
  db.prepare("DELETE FROM tag_items WHERE item_type = 'file' AND item_id = ? AND source = 'text'").run(fileId);

  const insert = db.prepare(
    `INSERT INTO tag_items (user_id, tag_id, item_type, item_id, source, added_at)
     VALUES (?, ?, 'file', ?, 'text', ?)
     ON CONFLICT (tag_id, item_type, item_id) DO NOTHING`,
  );
  const now = Date.now();
  for (const name of names) {
    const trimmed = String(name).trim();
    if (!trimmed || /\s/.test(trimmed)) continue;
    insert.run(userId, ensureTag(userId, trimmed).id, fileId, now);
  }
}

/**
 * Forgets the tag rows for things that no longer exist.
 *
 * `tag_items.item_id` cannot be a foreign key — it points at one of two tables —
 * so this is called wherever a folder or a file is really deleted. It is the
 * one piece of bookkeeping the database cannot do on its own.
 */
export function forgetItems(userId: string, itemType: ItemType, itemIds: string[]): void {
  if (!itemIds.length) return;
  const placeholders = itemIds.map(() => '?').join(',');
  getDb()
    .prepare(
      `DELETE FROM tag_items WHERE user_id = ? AND item_type = ? AND item_id IN (${placeholders})`,
    )
    .run(userId, itemType, ...itemIds);
}
