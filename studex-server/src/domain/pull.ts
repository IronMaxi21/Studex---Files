/**
 * Bringing a library down from Supabase.
 *
 * Push answers "is my work backed up". Pull answers "does my other Mac have
 * it", which is a harder question, because by the time it is asked both sides
 * may have moved. Every decision here comes from comparing three things: what
 * is upstream now, what is here now, and what the two agreed on last time —
 * the hash recorded in sync_state. With a base to compare against, "changed"
 * is a fact rather than a guess, and the only genuinely ambiguous case is when
 * both sides changed. That one is never resolved by throwing work away.
 */
import { z } from 'zod';
import { getDb, tx } from '../lib/db.js';
import { sha256File } from '../lib/crypto.js';
import { deleteBlob, storeBuffer } from '../lib/storage.js';
import { ApiError, quotaExceeded } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { createFile, createFolder, trashFile, updateFile, updateFolder } from './library.js';
import { blocksSchema, documentStyleSchema, saveDocument } from './documents.js';
import { canvasObjectsSchema, saveCanvas, viewportSchema } from './canvas.js';
import { deckTemplateSchema } from './flashcards.js';
import {
  bodyFor,
  dropState,
  exclusively,
  identityHash,
  pushLibrary,
  readState,
  recordPull,
  recordState,
  recordSyncFailure,
  remoteStoreFor,
  requireLink,
  type LocalFile,
  type RemoteItem,
  type RemoteStore,
  type StateRow,
  type SyncResult,
} from './sync.js';

export interface PullResult {
  /** Items this device did not have, now created. */
  created: number;
  /** Items taken from upstream over a local copy that had not been touched. */
  updated: number;
  /** Both sides had changed. The upstream copy was kept alongside the local one. */
  conflicted: number;
  /** Removed from the project on another device, so moved to this one's trash. */
  trashed: number;
  /** Already in agreement. */
  unchanged: number;
  finishedAt: number;
}

/** The shape a document, canvas or deck body has to have to be applied here. */
const docBody = z.object({
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

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new ApiError(502, 'sync_failed', 'A file upstream is not readable as Studex content.');
  }
}

/* ── local reads ──────────────────────────────────────────────────────── */

interface LocalFolderRow {
  id: string;
  parent_id: string | null;
  name: string;
}

function localFolder(userId: string, folderId: string): LocalFolderRow | undefined {
  return getDb()
    .prepare<[string, string], LocalFolderRow>(
      'SELECT id, parent_id, name FROM folders WHERE id = ? AND user_id = ?',
    )
    .get(folderId, userId);
}

function localFolders(userId: string): LocalFolderRow[] {
  return getDb()
    .prepare<[string], LocalFolderRow>('SELECT id, parent_id, name FROM folders WHERE user_id = ?')
    .all(userId);
}

function localFile(userId: string, fileId: string): LocalFile | undefined {
  return getDb()
    .prepare<[string, string], LocalFile>(
      'SELECT id, folder_id, kind, title, trashed_at FROM files WHERE id = ? AND user_id = ?',
    )
    .get(fileId, userId);
}

function localFiles(userId: string): LocalFile[] {
  return getDb()
    .prepare<[string], LocalFile>(
      'SELECT id, folder_id, kind, title, trashed_at FROM files WHERE user_id = ?',
    )
    .all(userId);
}

/** The hash this device would push for a file right now. Null when it has no body. */
async function currentHash(file: LocalFile): Promise<string | null> {
  const content = await bodyFor(file);
  return content ? sha256File(content.body) : null;
}

/* ── storage accounting ───────────────────────────────────────────────── */

/**
 * Charges bytes against the account before they are written.
 *
 * Plan caps are lifted for a restore, but disk is disk: an account with no
 * room left cannot be given more of its own library than it can hold, and
 * saying so is better than filling the volume.
 */
function chargeStorage(userId: string, delta: number): void {
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

async function applyBody(userId: string, file: LocalFile, body: Buffer): Promise<void> {
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

/* ── images ───────────────────────────────────────────────────────────── */

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

async function applyImage(
  userId: string,
  imageId: string,
  documentFileId: string,
  item: RemoteItem,
  body: Buffer,
): Promise<void> {
  if (!IMAGE_MIMES.has(item.mime ?? '')) {
    throw new ApiError(502, 'sync_failed', `"${item.name}" is not an image this build can store.`);
  }
  const existing = getDb()
    .prepare<[string, string], { storage_key: string; byte_size: number }>(
      'SELECT storage_key, byte_size FROM document_images WHERE id = ? AND user_id = ?',
    )
    .get(imageId, userId);

  const blob = await storeBuffer(body);
  try {
    tx(() => {
      chargeStorage(userId, blob.byteSize - (existing?.byte_size ?? 0));
      getDb().prepare('DELETE FROM document_images WHERE id = ? AND user_id = ?').run(imageId, userId);
      getDb()
        .prepare(
          `INSERT INTO document_images (id, user_id, file_id, storage_key, mime, byte_size, sha256, original_name, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(imageId, userId, documentFileId, blob.key, item.mime, blob.byteSize, blob.sha256, item.name, Date.now());
    });
  } catch (err) {
    await deleteBlob(blob.key);
    throw err;
  }
  if (existing) await deleteBlob(existing.storage_key);
}

/* ── ordering ─────────────────────────────────────────────────────────── */

/** Same reason as on the way up: a child cannot be placed before its parent. */
function remoteParentsFirst(items: RemoteItem[]): RemoteItem[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const ordered: RemoteItem[] = [];
  const placed = new Set<string>();

  const place = (item: RemoteItem, guard: Set<string>): void => {
    if (placed.has(item.id) || guard.has(item.id)) return;
    guard.add(item.id);
    const parent = item.parentId ? byId.get(item.parentId) : undefined;
    if (parent) place(parent, guard);
    if (!placed.has(item.id)) {
      placed.add(item.id);
      ordered.push(item);
    }
  };

  for (const item of items) place(item, new Set());
  return ordered;
}

/* ── the pull ─────────────────────────────────────────────────────────── */

const FILE_KINDS = new Set(['doc', 'canvas', 'deck', 'pdf']);

/**
 * Brings this account's Supabase library down onto this device.
 *
 * Safe to run repeatedly: a second pull with nothing changed upstream does
 * nothing at all, because every decision is made by comparing hashes rather
 * than by timestamps or by trust.
 */
export async function pullLibrary(
  userId: string,
  supabaseUserId: string,
  store: RemoteStore,
): Promise<PullResult> {
  /*
   * A trashed row upstream is read as no row at all.
   *
   * Push stopped sending the trash, so nothing current can arrive marked that
   * way — but rows written by an older build can, and the whole point is that
   * a second Mac does not rebuild somebody's bin. Filtering here rather than
   * at each decision means every later step, including the one that trashes
   * what has vanished upstream, treats the two cases identically.
   */
  const remote = (await store.listItems(supabaseUserId)).filter((i) => !i.trashedAt);
  const state = readState(userId);

  const byRemote = new Map<string, StateRow>();
  const localIdFor = new Map<string, string>();
  /** The other direction, for working out what a local item's identity hashes to. */
  const remoteIdForLocal = new Map<string, string>();
  for (const row of state.values()) {
    byRemote.set(row.remote_id, row);
    localIdFor.set(row.remote_id, row.local_id);
    remoteIdForLocal.set(`${row.scope}:${row.local_id}`, row.remote_id);
  }
  const parentRemoteOf = (folderId: string | null): string | null =>
    (folderId ? remoteIdForLocal.get(`folder:${folderId}`) ?? null : null);

  const result = { created: 0, updated: 0, conflicted: 0, trashed: 0, unchanged: 0 };

  /*
   * Adoption indexes, for items upstream that this device has no mapping for.
   *
   * Without them, a second Mac that already holds the same library — because
   * both were set up from the same account — would answer its first pull by
   * making a second copy of everything. Matching on where a thing sits, what
   * it is called and what it contains is what turns that into a handshake.
   */
  const mappedFolders = new Set<string>();
  const mappedFiles = new Set<string>();
  for (const row of state.values()) {
    if (row.scope === 'folder') mappedFolders.add(row.local_id);
    else mappedFiles.add(row.local_id);
  }

  const folderCandidates = new Map<string, string>();
  for (const folder of localFolders(userId)) {
    if (mappedFolders.has(folder.id)) continue;
    folderCandidates.set(JSON.stringify([folder.parent_id, folder.name]), folder.id);
  }

  const fileCandidates = new Map<string, LocalFile>();
  for (const file of localFiles(userId)) {
    // Binning something must not make it a match for a live file upstream.
    if (mappedFiles.has(file.id) || file.trashed_at) continue;
    fileCandidates.set(JSON.stringify([file.folder_id, file.kind, file.title]), file);
  }

  /* ── folders ───────────────────────────────────────────────────────── */

  for (const item of remoteParentsFirst(remote.filter((i) => i.kind === 'folder'))) {
    const parentLocalId = item.parentId ? localIdFor.get(item.parentId) ?? null : null;
    const mapped = byRemote.get(item.id);
    const local = mapped ? localFolder(userId, mapped.local_id) : undefined;

    const remoteIdentity = identityHash(item.name, item.parentId);

    if (mapped && local) {
      const localIdentity = identityHash(local.name, parentRemoteOf(local.parent_id));
      let base = mapped.identity_hash;

      if (remoteIdentity === base) {
        result.unchanged += 1;
      } else if (localIdentity === base) {
        // Renamed or moved elsewhere, untouched here: follow it.
        updateFolder(userId, local.id, { name: item.name, parentId: parentLocalId });
        base = remoteIdentity;
        result.updated += 1;
      } else {
        // Both sides renamed it. A folder is a name and a place; there is
        // nothing to keep two of, so this device's answer stands and the next
        // push carries it up.
        base = localIdentity;
        result.conflicted += 1;
      }
      recordState(userId, 'folder', local.id, item.id, null, base);
      localIdFor.set(item.id, local.id);
      remoteIdForLocal.set(`folder:${local.id}`, item.id);
      continue;
    }

    const key = JSON.stringify([parentLocalId, item.name]);
    const adopted = folderCandidates.get(key);
    if (adopted) {
      folderCandidates.delete(key);
      recordState(userId, 'folder', adopted, item.id, null, remoteIdentity);
      localIdFor.set(item.id, adopted);
      remoteIdForLocal.set(`folder:${adopted}`, item.id);
      result.unchanged += 1;
      continue;
    }

    const made = createFolder(userId, { name: item.name, parentId: parentLocalId });
    recordState(userId, 'folder', made.id, item.id, null, remoteIdentity);
    localIdFor.set(item.id, made.id);
    remoteIdForLocal.set(`folder:${made.id}`, item.id);
    result.created += 1;
  }

  /* ── files ─────────────────────────────────────────────────────────── */

  for (const item of remote.filter((i) => FILE_KINDS.has(i.kind))) {
    const folderId = item.parentId ? localIdFor.get(item.parentId) ?? null : null;
    const kind = item.kind as LocalFile['kind'];
    const mapped = byRemote.get(item.id);
    const existing = mapped ? localFile(userId, mapped.local_id) : undefined;

    if (mapped && existing) {
      if (existing.trashed_at) {
        // In this Mac's bin, so the next push takes it out of the project.
        // Writing an incoming edit into it would only bin that too.
        localIdFor.set(item.id, existing.id);
        remoteIdForLocal.set(`file:${existing.id}`, item.id);
        result.unchanged += 1;
        continue;
      }
      const localContent = await currentHash(existing);
      const contentUnchanged = localContent === mapped.content_hash;
      localIdFor.set(item.id, existing.id);
      remoteIdForLocal.set(`file:${existing.id}`, item.id);

      let changed = false;
      let clashed = false;

      /*
       * What it is called, decided on its own.
       *
       * A rename spends no bytes, so push deliberately leaves the content hash
       * alone when one happens — which means naming needs a base of its own or
       * a rename made elsewhere is invisible from this side.
       */
      const remoteIdentity = identityHash(item.name, item.parentId);
      const localIdentity = identityHash(existing.title, parentRemoteOf(existing.folder_id));
      let identityBase = mapped.identity_hash;

      if (remoteIdentity !== identityBase) {
        if (localIdentity === identityBase) {
          updateFile(userId, existing.id, { title: item.name, folderId });
          identityBase = remoteIdentity;
          changed = true;
        } else {
          // Renamed in both places. This device's name stands; the next push
          // carries it up rather than a copy being made over a label.
          identityBase = localIdentity;
          clashed = true;
        }
      }

      // And what it contains, decided separately.
      let contentBase = mapped.content_hash;
      if (item.contentHash !== contentBase) {
        if (contentUnchanged) {
          await applyBody(userId, existing, await store.getObject(item.storagePath!));
          contentBase = item.contentHash;
          changed = true;
        } else {
          // Both moved. Neither version is discarded: this device keeps what it
          // has, and the other device's copy arrives beside it under its own
          // name. The base becomes the local hash, so the next push makes the
          // two agree on this item and the copy travels up as a new one.
          await materialise(userId, conflictName(item.name), kind, folderId, item, store);
          contentBase = localContent;
          clashed = true;
        }
      }

      recordState(userId, 'file', existing.id, item.id, contentBase, identityBase);

      if (clashed) result.conflicted += 1;
      else if (changed) result.updated += 1;
      else result.unchanged += 1;
      continue;
    }

    const key = JSON.stringify([folderId, kind, item.name]);
    const candidate = fileCandidates.get(key);
    if (candidate) {
      fileCandidates.delete(key);
      const localHash = await currentHash(candidate);
      const identity = identityHash(item.name, item.parentId);
      localIdFor.set(item.id, candidate.id);
      remoteIdForLocal.set(`file:${candidate.id}`, item.id);

      if (localHash === item.contentHash) {
        // The same file, already here. A handshake, not a download.
        recordState(userId, 'file', candidate.id, item.id, item.contentHash, identity);
        result.unchanged += 1;
        continue;
      }

      // Same name and place, different contents, and no record of the two ever
      // having agreed — the both-changed case with no base at all.
      await materialise(userId, conflictName(item.name), kind, folderId, item, store);
      recordState(userId, 'file', candidate.id, item.id, localHash ?? item.contentHash, identity);
      result.conflicted += 1;
      continue;
    }

    const made = await materialise(userId, item.name, kind, folderId, item, store);
    recordState(userId, 'file', made, item.id, item.contentHash, identityHash(item.name, item.parentId));
    localIdFor.set(item.id, made);
    remoteIdForLocal.set(`file:${made}`, item.id);
    result.created += 1;
  }

  /* ── images ────────────────────────────────────────────────────────── */

  for (const item of remote.filter((i) => i.kind === 'image')) {
    const documentFileId = item.parentId ? localIdFor.get(item.parentId) : null;
    // An image whose document did not come down has nowhere to live.
    if (!documentFileId) continue;

    const mapped = byRemote.get(item.id);
    const existing = mapped
      ? getDb()
          .prepare<[string, string], { id: string }>(
            'SELECT id FROM document_images WHERE id = ? AND user_id = ?',
          )
          .get(mapped.local_id, userId)
      : undefined;

    if (existing && mapped && item.contentHash === mapped.content_hash) {
      result.unchanged += 1;
      continue;
    }

    const imageId = existing?.id ?? mapped?.local_id ?? newId();
    await applyImage(userId, imageId, documentFileId, item, await store.getObject(item.storagePath!));
    recordState(userId, 'file', imageId, item.id, item.contentHash, identityHash(item.name, item.parentId));
    if (existing) result.updated += 1;
    else result.created += 1;
  }

  /* ── what is no longer upstream ────────────────────────────────────── */

  const present = new Set(remote.map((i) => i.id));
  for (const row of state.values()) {
    if (present.has(row.remote_id)) continue;

    if (row.scope === 'folder') {
      // A folder deleted elsewhere takes its contents with it upstream, and
      // those arrive here as their own missing rows. Dropping only the mapping
      // leaves the folder in place rather than deleting a subtree on the
      // strength of one absent row.
      dropState(userId, row.scope, row.local_id);
      continue;
    }

    const file = localFile(userId, row.local_id);
    if (!file) {
      dropState(userId, row.scope, row.local_id);
      continue;
    }

    // Purged on another device. Trashed rather than purged here: the trash is
    // recoverable, and a delete arriving over a network is exactly the kind of
    // instruction worth being able to take back.
    const localHash = await currentHash(file);
    if (localHash === row.content_hash && !file.trashed_at) {
      trashFile(userId, file.id);
      result.trashed += 1;
    }
    // Either way the mapping goes: if this device has moved on, the file stays
    // and travels back up on the next push as something new.
    dropState(userId, row.scope, row.local_id);
  }

  return { ...result, finishedAt: Date.now() };
}

/** Creates a local file and fills it with the upstream body. Returns its id. */
async function materialise(
  userId: string,
  title: string,
  kind: LocalFile['kind'],
  folderId: string | null,
  item: RemoteItem,
  store: RemoteStore,
): Promise<string> {
  const made = createFile(userId, { title, kind, folderId }, { enforcePlanLimits: false });
  const body = await store.getObject(item.storagePath!);
  await applyBody(userId, { id: made.id, folder_id: folderId, kind, title, trashed_at: null }, body);
  return made.id;
}

function conflictName(name: string): string {
  const suffix = ' (from another device)';
  return name.length + suffix.length > 200
    ? name.slice(0, 200 - suffix.length) + suffix
    : name + suffix;
}

/* ── running one ──────────────────────────────────────────────────────── */

/** One pull for this account, from the linked project onto this device. */
export async function runPull(userId: string): Promise<PullResult> {
  return exclusively(userId, async () => {
    const supabaseUserId = requireLink(userId);
    const store = await remoteStoreFor(userId);
    try {
      const result = await pullLibrary(userId, supabaseUserId, store);
      recordPull(userId, result);
      return result;
    } catch (err) {
      recordSyncFailure(userId, err instanceof Error ? err.message : 'Pull failed');
      throw err;
    }
  });
}

/**
 * Both directions, in the only order that settles.
 *
 * Down first: a conflict is resolved by keeping this device's version and
 * putting the other one beside it, and the push that follows is what carries
 * both of those decisions upstream. Pushing first would send this device's
 * version up, then pull it straight back down as though it were news.
 */
export async function runTwoWay(userId: string): Promise<{ pulled: PullResult; pushed: SyncResult }> {
  return exclusively(userId, async () => {
    const supabaseUserId = requireLink(userId);
    const store = await remoteStoreFor(userId);
    try {
      const pulled = await pullLibrary(userId, supabaseUserId, store);
      const pushed = await pushLibrary(userId, supabaseUserId, store);
      recordPull(userId, pulled);
      return { pulled, pushed };
    } catch (err) {
      recordSyncFailure(userId, err instanceof Error ? err.message : 'Sync failed');
      throw err;
    }
  });
}
