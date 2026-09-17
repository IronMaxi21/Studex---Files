import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '../lib/db.js';
import { sha256File } from '../lib/crypto.js';
import { resolveStoragePath } from '../lib/storage.js';
import { ApiError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { isTransient, withRetry } from '../lib/retry.js';
import { clientForSession } from '../lib/supabase.js';
import { readSupabaseSession, rememberSupabaseSession } from './auth.js';
import { blocksSchema } from './documents.js';
import { canvasObjectsSchema } from './canvas.js';

/** The private bucket created for this project. Objects are keyed '<uid>/<item id>'. */
export const BUCKET = 'studex';

export type RemoteKind = 'folder' | 'doc' | 'canvas' | 'deck' | 'pdf' | 'image';

/**
 * A row of library_items as it comes back from Supabase.
 *
 * The table is writable by anything holding the account's token — another
 * device, an older build, a hand-written REST call — so what comes back is
 * not automatically what this app wrote. The caps match the ones the HTTP
 * edge applies, because it is the same data and the same database underneath.
 */
export const remoteRowSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  parent_id: z.string().uuid().nullish(),
  kind: z.enum(['folder', 'doc', 'canvas', 'deck', 'pdf']),
  name: z.string().min(1).max(200),
  storage_path: z.string().max(1024).nullish(),
  mime: z.string().max(255).nullish(),
  byte_size: z.number().int().min(0).max(10 * 1024 * 1024 * 1024).nullish(),
  trashed_at: z.string().max(64).nullish(),
  content_hash: z.string().regex(/^[0-9a-f]{64}$/).nullish(),
});

export interface RemoteItem {
  id: string;
  userId: string;
  parentId: string | null;
  kind: RemoteKind;
  name: string;
  storagePath: string | null;
  mime: string | null;
  byteSize: number;
  trashedAt: number | null;
  /**
   * sha256 of what this item is: the body for a file, the name and place for a
   * folder. It is what lets the other direction work — a device compares this
   * against the hash it recorded when the two sides last agreed, and only
   * fetches the bodies that actually differ.
   */
  contentHash: string | null;
}

/**
 * Everything sync needs from Supabase, and nothing else.
 *
 * Narrow on purpose: it is the seam the tests substitute, so ordering,
 * change detection, idempotence, conflict handling and removal are all
 * exercised without a network, and without a test run being able to write to
 * a real project.
 */
export interface RemoteStore {
  upsertItem(item: RemoteItem): Promise<void>;
  deleteItem(id: string): Promise<void>;
  putObject(path: string, body: Buffer, mime: string): Promise<void>;
  deleteObject(path: string): Promise<void>;
  /** Every item this account holds upstream. */
  listItems(userId: string): Promise<RemoteItem[]>;
  getObject(path: string): Promise<Buffer>;
}

export interface SyncResult {
  /** Rows written to library_items. */
  items: number;
  /** Objects actually uploaded — bodies whose bytes had changed. */
  uploaded: number;
  /** Bodies skipped because they were already identical upstream. */
  unchanged: number;
  removed: number;
  finishedAt: number;
}

/**
 * What an item is called and where it sits, hashed.
 *
 * Kept apart from the body hash on purpose. Push spends an upload only when
 * bytes differ, so a rename must not look like an edit; but pull has to be
 * able to see a rename, and a row whose name changed while its content hash
 * stood still is invisible to a comparison that only ever looked at bodies.
 * Two bases, two questions, one answer each.
 */
export function identityHash(name: string, parentRemoteId: string | null): string {
  return sha256File(Buffer.from(JSON.stringify({ name, parent: parentRemoteId })));
}

export interface LocalFolder {
  id: string;
  parent_id: string | null;
  name: string;
}

export interface LocalFile {
  id: string;
  folder_id: string | null;
  kind: 'canvas' | 'doc' | 'pdf' | 'deck';
  title: string;
  trashed_at: number | null;
}

export interface StateRow {
  scope: 'folder' | 'file';
  local_id: string;
  remote_id: string;
  /** sha256 of the body last agreed on. Always null for a folder, which has none. */
  content_hash: string | null;
  /** sha256 of the name and place last agreed on. */
  identity_hash: string | null;
}

/**
 * Parents before children.
 *
 * library_items.parent_id is a real foreign key with a trigger behind it, so a
 * child sent before its folder is rejected outright. Sorting here rather than
 * retrying on failure means one pass always suffices.
 */
export function parentsFirst(folders: LocalFolder[]): LocalFolder[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const ordered: LocalFolder[] = [];
  const placed = new Set<string>();

  const place = (folder: LocalFolder, guard: Set<string>): void => {
    if (placed.has(folder.id) || guard.has(folder.id)) return;
    guard.add(folder.id);
    const parent = folder.parent_id ? byId.get(folder.parent_id) : undefined;
    if (parent) place(parent, guard);
    if (!placed.has(folder.id)) {
      placed.add(folder.id);
      ordered.push(folder);
    }
  };

  for (const folder of folders) place(folder, new Set());
  return ordered;
}

/**
 * Content as the other end will hold it.
 *
 * A body is sent through the same schema that validates it on the way down,
 * because that is the shape it will have once it lands: zod fills in fields
 * that have defaults and writes the keys in the schema's order, so a row saved
 * by an older build — or by a client that happened to send its keys in a
 * different order — would hash one way here and another way after a pull. The
 * two Macs would then each think the other had edited the note and trade it
 * back and forth. Hashing the canonical form instead means a pulled file is
 * byte-identical to the one that was pushed.
 *
 * A row that no longer validates is sent exactly as it is stored rather than
 * dropped: the backup is still worth having, and refusing to sync content the
 * app itself wrote is the worse failure.
 */
function canonical<T>(schema: z.ZodType<T>, value: unknown): unknown {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : value;
}

/**
 * The bytes that represent a file upstream.
 *
 * Documents, canvases and decks are rows locally, so they are serialised —
 * a deck carries its cards with their scheduling state, because a backup that
 * forgets when a card is next due has thrown away the useful half. PDFs and
 * images are already bytes and travel as they are.
 *
 * The revision counter is deliberately not in here. It is this device's own
 * optimistic-concurrency number, not content: applying a pulled document bumps
 * it, so a body that carried it would hash differently the moment it landed,
 * and the two Macs would push the same note back and forth for ever, each
 * round convincing the other that something had changed.
 */
export async function bodyFor(file: LocalFile): Promise<{ body: Buffer; mime: string } | null> {
  const db = getDb();

  if (file.kind === 'doc') {
    const row = db
      .prepare<[string], { blocks: string; style: string }>(
        'SELECT blocks, style FROM documents WHERE file_id = ?',
      )
      .get(file.id);
    if (!row) return null;
    return {
      body: Buffer.from(
        JSON.stringify({
          kind: 'doc',
          style: row.style,
          blocks: canonical(blocksSchema, JSON.parse(row.blocks)),
        }),
      ),
      mime: 'application/json',
    };
  }

  if (file.kind === 'canvas') {
    const row = db
      .prepare<[string], { objects: string; viewport: string }>(
        'SELECT objects, viewport FROM canvases WHERE file_id = ?',
      )
      .get(file.id);
    if (!row) return null;
    return {
      body: Buffer.from(
        JSON.stringify({
          kind: 'canvas',
          viewport: JSON.parse(row.viewport),
          objects: canonical(canvasObjectsSchema, JSON.parse(row.objects)),
        }),
      ),
      mime: 'application/json',
    };
  }

  if (file.kind === 'deck') {
    const deck = db
      .prepare<[string], { description: string | null; template: string | null }>(
        'SELECT description, template FROM decks WHERE file_id = ?',
      )
      .get(file.id);
    if (!deck) return null;
    const cards = db
      .prepare<[string], Record<string, unknown>>(
        // stability and difficulty are the card's real schedule under FSRS;
        // ease_factor rides along only so an older client still reads
        // something sensible out of a deck this one wrote.
        `SELECT id, front, back, topic, extra1, extra2, state, ease_factor, stability, difficulty,
                interval_days, repetitions,
                lapses, due_at, last_reviewed_at, suspended, created_at, updated_at
           FROM cards WHERE deck_id = ? ORDER BY created_at`,
      )
      .all(file.id)
      // Template fields are left out while empty, so a deck that has never had
      // a template serialises to the same bytes it did before templates
      // existed, and is not pushed again merely for being read by a newer build.
      .map((card) => {
        if (card.extra1 === null) delete card.extra1;
        if (card.extra2 === null) delete card.extra2;
        return card;
      });
    const payload: Record<string, unknown> = { kind: 'deck', description: deck.description };
    if (deck.template) payload.template = JSON.parse(deck.template);
    payload.cards = cards;
    return {
      body: Buffer.from(JSON.stringify(payload)),
      mime: 'application/json',
    };
  }

  const pdf = db
    .prepare<[string], { storage_key: string }>('SELECT storage_key FROM pdf_files WHERE file_id = ?')
    .get(file.id);
  if (!pdf) return null;
  return { body: await fs.readFile(resolveStoragePath(pdf.storage_key)), mime: 'application/pdf' };
}

/** Images live inside documents rather than in the library, so they ride along as children. */
export function imagesOf(fileId: string) {
  return getDb()
    .prepare<[string], { id: string; storage_key: string; mime: string; byte_size: number; original_name: string }>(
      'SELECT id, storage_key, mime, byte_size, original_name FROM document_images WHERE file_id = ?',
    )
    .all(fileId);
}

export function readState(userId: string): Map<string, StateRow> {
  const rows = getDb()
    .prepare<[string], StateRow>(
      'SELECT scope, local_id, remote_id, content_hash, identity_hash FROM sync_state WHERE user_id = ?',
    )
    .all(userId);
  return new Map(rows.map((r) => [`${r.scope}:${r.local_id}`, r]));
}

export function recordState(
  userId: string,
  scope: 'folder' | 'file',
  localId: string,
  remoteId: string,
  contentHash: string | null,
  identityHashValue: string | null,
): void {
  getDb()
    .prepare(
      `INSERT INTO sync_state (user_id, scope, local_id, remote_id, content_hash, identity_hash, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, scope, local_id) DO UPDATE SET
         remote_id = excluded.remote_id,
         content_hash = excluded.content_hash,
         identity_hash = excluded.identity_hash,
         synced_at = excluded.synced_at`,
    )
    .run(userId, scope, localId, remoteId, contentHash, identityHashValue, Date.now());
}

export function dropState(userId: string, scope: 'folder' | 'file', localId: string): void {
  getDb()
    .prepare('DELETE FROM sync_state WHERE user_id = ? AND scope = ? AND local_id = ?')
    .run(userId, scope, localId);
}

/**
 * Mirrors this account's library into Supabase.
 *
 * Idempotent: a second run with nothing changed uploads nothing, because each
 * body is hashed and compared with what was last sent. Safe to interrupt —
 * state is recorded per item as it goes, so a failed run resumes rather than
 * starting over.
 */
export async function pushLibrary(
  userId: string,
  supabaseUserId: string,
  store: RemoteStore,
): Promise<SyncResult> {
  const db = getDb();
  const startedAt = Date.now();
  db.prepare(
    `INSERT INTO sync_runs (user_id, started_at, pushed, removed, error)
     VALUES (?, ?, 0, 0, NULL)
     ON CONFLICT(user_id) DO UPDATE SET started_at = excluded.started_at, finished_at = NULL, error = NULL`,
  ).run(userId, startedAt);

  const state = readState(userId);
  const seen = new Set<string>();
  let items = 0;
  let uploaded = 0;
  let unchanged = 0;

  // Ids resolved during *this* run as well as ones carried over from previous
  // ones. Reading only the stored state would mean a folder created moments
  // ago got one id when it was written and a different one when the file
  // inside it looked up its parent — which upstream is a foreign key
  // violation, not a cosmetic mismatch.
  const resolved = new Map<string, string>();
  for (const [key, row] of state) resolved.set(key, row.remote_id);

  const remoteIdFor = (scope: 'folder' | 'file', localId: string): string => {
    const key = `${scope}:${localId}`;
    let id = resolved.get(key);
    if (!id) {
      id = randomUUID();
      resolved.set(key, id);
    }
    return id;
  };

  const folders = db
    .prepare<[string], LocalFolder>('SELECT id, parent_id, name FROM folders WHERE user_id = ?')
    .all(userId);

  for (const folder of parentsFirst(folders)) {
    const remoteId = remoteIdFor('folder', folder.id);
    const parentId = folder.parent_id ? remoteIdFor('folder', folder.parent_id) : null;
    const identity = identityHash(folder.name, parentId);
    seen.add(`folder:${folder.id}`);
    await store.upsertItem({
      id: remoteId,
      userId: supabaseUserId,
      parentId,
      kind: 'folder',
      name: folder.name,
      storagePath: null,
      mime: null,
      byteSize: 0,
      trashedAt: null,
      contentHash: null,
    });
    recordState(userId, 'folder', folder.id, remoteId, null, identity);
    items += 1;
  }

  /*
   * The trash does not travel.
   *
   * It is this Mac's undo pile, not part of the library — a second device
   * faithfully reproducing somebody's bin is nobody's idea of a restore. A
   * file that has been trashed since the last push therefore stops being seen
   * here, which sends it down the removal path below and takes it out of the
   * project. Restoring it locally puts it back on the next push.
   */
  const files = db
    .prepare<[string], LocalFile>(
      'SELECT id, folder_id, kind, title, trashed_at FROM files WHERE user_id = ? AND trashed_at IS NULL',
    )
    .all(userId);

  for (const file of files) {
    const content = await bodyFor(file);
    if (!content) continue; // a row whose content table is missing; nothing to send

    const remoteId = remoteIdFor('file', file.id);
    const path = `${supabaseUserId}/${remoteId}`;
    const hash = sha256File(content.body);
    seen.add(`file:${file.id}`);

    // The upload is the expensive half, so it only happens when the bytes
    // actually differ from what was last sent. The row is written either way:
    // a rename changes no content but still has to travel.
    if (state.get(`file:${file.id}`)?.content_hash !== hash) {
      await store.putObject(path, content.body, content.mime);
      uploaded += 1;
    } else {
      unchanged += 1;
    }

    const parentRemoteId = file.folder_id ? remoteIdFor('folder', file.folder_id) : null;
    await store.upsertItem({
      id: remoteId,
      userId: supabaseUserId,
      parentId: parentRemoteId,
      kind: file.kind,
      name: file.title,
      storagePath: path,
      mime: content.mime,
      byteSize: content.body.byteLength,
      trashedAt: null,
      contentHash: hash,
    });
    recordState(userId, 'file', file.id, remoteId, hash, identityHash(file.title, parentRemoteId));
    items += 1;

    if (file.kind !== 'doc') continue;
    for (const image of imagesOf(file.id)) {
      const imageRemoteId = remoteIdFor('file', image.id);
      const imagePath = `${supabaseUserId}/${imageRemoteId}`;
      seen.add(`file:${image.id}`);
      const bytes = await fs.readFile(resolveStoragePath(image.storage_key));
      const imageHash = sha256File(bytes);

      if (state.get(`file:${image.id}`)?.content_hash !== imageHash) {
        await store.putObject(imagePath, bytes, image.mime);
        uploaded += 1;
      } else {
        unchanged += 1;
      }

      await store.upsertItem({
        id: imageRemoteId,
        userId: supabaseUserId,
        // An image belongs to the document that holds it, not to a folder.
        parentId: remoteId,
        kind: 'image',
        name: image.original_name,
        storagePath: imagePath,
        mime: image.mime,
        byteSize: image.byte_size,
        trashedAt: null,
        contentHash: imageHash,
      });
      recordState(
        userId, 'file', image.id, imageRemoteId, imageHash,
        identityHash(image.original_name, remoteId),
      );
      items += 1;
    }
  }

  // Anything this account synced before and no longer has locally. Deleting the
  // row first means a failure here leaves an orphaned object rather than a row
  // pointing at nothing, which is the cheaper of the two to reconcile later.
  let removed = 0;
  for (const [key, row] of state) {
    if (seen.has(key)) continue;
    await store.deleteItem(row.remote_id);
    // Folders carry a hash now too, so what decides whether there is an object
    // to remove is what the row *is*, not whether it happens to have one.
    if (row.scope === 'file') {
      await store.deleteObject(`${supabaseUserId}/${row.remote_id}`);
    }
    dropState(userId, row.scope, row.local_id);
    removed += 1;
  }

  const finishedAt = Date.now();
  db.prepare('UPDATE sync_runs SET finished_at = ?, pushed = ?, removed = ? WHERE user_id = ?')
    .run(finishedAt, items, removed, userId);

  return { items, uploaded, unchanged, removed, finishedAt };
}

export function recordSyncFailure(userId: string, message: string): void {
  getDb()
    .prepare('UPDATE sync_runs SET finished_at = ?, error = ? WHERE user_id = ?')
    .run(Date.now(), message.slice(0, 500), userId);
}

export function lastRun(userId: string) {
  return (
    getDb()
      .prepare<[string], {
        started_at: number;
        finished_at: number | null;
        pushed: number;
        removed: number;
        pulled: number;
        conflicts: number;
        error: string | null;
      }>(
        `SELECT started_at, finished_at, pushed, removed, pulled, conflicts, error
           FROM sync_runs WHERE user_id = ?`,
      )
      .get(userId) ?? null
  );
}

/** What a pull established, kept beside what the last push did. */
export function recordPull(
  userId: string,
  result: { created: number; updated: number; conflicted: number; trashed: number },
): void {
  const brought = result.created + result.updated + result.trashed;
  getDb()
    .prepare(
      `INSERT INTO sync_runs (user_id, started_at, finished_at, pushed, removed, pulled, conflicts, error)
       VALUES (?, ?, ?, 0, 0, ?, ?, NULL)
       ON CONFLICT(user_id) DO UPDATE SET
         finished_at = excluded.finished_at,
         pulled = excluded.pulled,
         conflicts = excluded.conflicts,
         error = NULL`,
    )
    .run(userId, Date.now(), Date.now(), brought, result.conflicted);
}

/** The Supabase identity this account is linked to, or a 409 explaining why not. */
export function requireLink(userId: string): string {
  const row = getDb()
    .prepare<[string], { supabase_user_id: string | null }>(
      'SELECT supabase_user_id FROM users WHERE id = ?',
    )
    .get(userId);
  if (!row?.supabase_user_id) {
    throw new ApiError(
      409,
      'not_linked',
      'This account signs in locally, so there is no Supabase project to sync with.',
    );
  }
  return row.supabase_user_id;
}

/**
 * A store backed by the real project, acting as the user rather than
 * anonymously — which is what every policy on library_items and on the bucket
 * requires. Refreshed tokens are written back, because they rotate.
 */
export async function remoteStoreFor(userId: string): Promise<RemoteStore> {
  /*
   * Deliberately not a 401.
   *
   * The Studex session is perfectly valid — it is the Supabase one that is
   * missing, and answering 401 made the app treat a sync problem as a signed-out
   * user and throw the student back to the login screen mid-sync. Its own code
   * says what actually has to happen instead.
   */
  const needsSignIn = (message: string): never => {
    throw new ApiError(409, 'sync_signin_required', message);
  };

  const stored = readSupabaseSession(userId);
  if (!stored) {
    needsSignIn('Sign out and back in to sync — this device has no Supabase session yet.');
  }
  const opened = await clientForSession(stored!);
  if (!opened) {
    needsSignIn('That Supabase session has expired. Sign out and back in to sync.');
  }
  rememberSupabaseSession(userId, opened!.session);
  const sb = opened!.client;

  /**
   * A failure from upstream, said in a way that can be acted on.
   *
   * "permission denied for table library_items" is the one that matters, and
   * on its own it sends people to look at their policies — which are fine.
   * Row-level security narrows what a role may reach; it does not grant the
   * role anything, and the dashboard shows policies prominently and grants
   * nowhere. So this failure names the actual cause rather than repeating
   * Postgres at the student.
   */
  const fail = (what: string, message: string): never => {
    if (/permission denied for (table|relation|schema)/i.test(message)) {
      throw new ApiError(
        502,
        'sync_not_granted',
        `${what}: your Supabase project has not granted this account access to its own library table. `
        + 'Row-level security is not the same as a grant — run studex-server/supabase/setup.sql '
        + 'in the project\u2019s SQL editor once, and sync will work from then on.',
      );
    }
    throw new ApiError(502, 'sync_failed', `${what}: ${message}`);
  };

  /**
   * One Supabase call, retried while the failure still looks like weather.
   *
   * Every operation below is safe to repeat — the rows are upserted by id and
   * the objects are written to a path derived from that id — so a repeat can
   * only ever land the same result twice. That is what makes retrying honest
   * here and not somewhere else.
   *
   * A refusal is not retried. "Permission denied" and "row violates policy"
   * will say exactly the same thing in four seconds' time, and burning that
   * time only delays telling the student something true.
   */
  const upstream = async <T>(
    what: string,
    call: () => PromiseLike<{ data?: T | null; error: { message: string; status?: number; code?: string } | null }>,
  ): Promise<T | null> => {
    const result = await withRetry(
      async () => {
        const res = await call();
        if (res.error && isTransient({ ...res.error, statusCode: res.error.status })) {
          // Rethrown so the retry loop sees it; supabase-js reports upstream
          // failures in the reply rather than by throwing.
          throw new ApiError(res.error.status ?? 503, 'sync_upstream', res.error.message);
        }
        return res;
      },
      { what, attempts: 3, baseMs: 400, maxMs: 4_000 },
    ).catch((err: unknown) => {
      if (err instanceof ApiError && err.code === 'sync_upstream') {
        return { data: undefined, error: { message: err.message } };
      }
      throw err;
    });

    if (result.error) fail(what, result.error.message);
    return (result.data ?? null) as T | null;
  };

  return {
    async upsertItem(item) {
      await upstream(`could not save "${item.name}"`, () => sb.from('library_items').upsert(
        {
          id: item.id,
          user_id: item.userId,
          parent_id: item.parentId,
          kind: item.kind,
          name: item.name,
          storage_path: item.storagePath,
          mime: item.mime,
          byte_size: item.byteSize,
          trashed_at: item.trashedAt ? new Date(item.trashedAt).toISOString() : null,
        },
        { onConflict: 'id' },
      ));
    },
    async deleteItem(id) {
      await upstream('could not remove an item', () => sb.from('library_items').delete().eq('id', id));
    },
    async putObject(path, body, mime) {
      await upstream('could not upload content', () =>
        sb.storage.from(BUCKET).upload(path, body, { contentType: mime, upsert: true }));
    },
    async deleteObject(path) {
      await upstream('could not remove content', () => sb.storage.from(BUCKET).remove([path]));
    },
    async listItems(uid) {
      // PostgREST caps a response, so the table is read in pages rather than
      // in one request that would quietly stop at somebody's first thousand
      // notes and call that the whole library.
      const PAGE = 500;
      const out: RemoteItem[] = [];
      const skipped: string[] = [];
      for (let from = 0; ; from += PAGE) {
        const data = await upstream<Record<string, unknown>[]>('could not read your library', () =>
          sb
            .from('library_items')
            .select('id, user_id, parent_id, kind, name, storage_path, mime, byte_size, trashed_at, content_hash')
            .eq('user_id', uid)
            .order('id')
            .range(from, from + PAGE - 1));
        const rows = data ?? [];
        for (const row of rows) {
          const parsed = remoteRowSchema.safeParse(row);
          // A row that does not parse is left where it is rather than being
          // dragged into the local database. Everything arriving over HTTP is
          // held to a schema; this is the same data coming back the other way
          // and it had stopped being checked at all — a name of any length or
          // of the wrong type entirely would have been written straight into
          // a file title. Skipping is the conservative half of that: nothing
          // upstream is touched, and the row is reported rather than hidden.
          if (!parsed.success) {
            skipped.push(String((row as { id?: unknown }).id ?? 'unknown'));
            continue;
          }
          const item = parsed.data;
          out.push({
            id: item.id,
            userId: item.user_id,
            parentId: item.parent_id ?? null,
            kind: item.kind,
            name: item.name,
            storagePath: item.storage_path ?? null,
            mime: item.mime ?? null,
            byteSize: item.byte_size ?? 0,
            trashedAt: item.trashed_at ? Date.parse(item.trashed_at) : null,
            contentHash: item.content_hash ?? null,
          });
        }
        if (rows.length < PAGE) {
          if (skipped.length) {
            log.warn({ skipped: skipped.length, ids: skipped.slice(0, 5) }, 'ignored malformed library_items rows');
          }
          return out;
        }
      }
    },
    async getObject(path) {
      // Through the same retry as everything else: a download is a read, so
      // repeating it can only ever produce the same bytes.
      const data = await upstream<Blob>('could not download content', () =>
        sb.storage.from(BUCKET).download(path));
      if (!data) fail('could not download content', 'no content');
      return Buffer.from(await data!.arrayBuffer());
    },
  };
}

/**
 * One push for this account, from the local library to the linked project.
 *
 * A failure is recorded before it is rethrown: a sync that dies halfway should
 * be visible in the UI as a failure with a reason, not as a run that silently
 * never finished.
 */
/**
 * One sync at a time, per account.
 *
 * Every run opens the Supabase session by replaying the stored refresh token,
 * and refresh tokens rotate: the reply carries a new one that has to be
 * written back. Two runs overlapping therefore both replay the *same* token,
 * and the loser writes a token the provider has already retired — after which
 * every later sync fails until the user signs out and back in. The overlap
 * also interleaves sync_state writes between the two, so the record of what
 * was last agreed with the server stops matching either run.
 *
 * A queue would be worse than a refusal here: the second press means "sync
 * now", and running the whole thing again immediately afterwards achieves
 * nothing a user asked for.
 */
const inFlight = new Set<string>();

export async function exclusively<T>(userId: string, work: () => Promise<T>): Promise<T> {
  if (inFlight.has(userId)) {
    throw new ApiError(409, 'sync_in_progress', 'A sync is already running.');
  }
  inFlight.add(userId);
  try {
    return await work();
  } finally {
    inFlight.delete(userId);
  }
}

export async function runSync(userId: string): Promise<SyncResult> {
  return exclusively(userId, async () => {
    const supabaseUserId = requireLink(userId);
    const store = await remoteStoreFor(userId);
    try {
      return await pushLibrary(userId, supabaseUserId, store);
    } catch (err) {
      recordSyncFailure(userId, err instanceof Error ? err.message : 'Sync failed');
      throw err;
    }
  });
}

/**
 * How many local rows a push would consider, for a UI that wants to say so.
 *
 * Counts what would actually go, which means the trash is left out of it — a
 * figure that included files the sync then skipped would be a lie in the one
 * place a student checks to see whether anything is missing.
 */
export function pendingCount(userId: string): number {
  const db = getDb();
  const folders = db
    .prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM folders WHERE user_id = ?')
    .get(userId)!.n;
  const files = db
    .prepare<[string], { n: number }>(
      'SELECT COUNT(*) AS n FROM files WHERE user_id = ? AND trashed_at IS NULL',
    )
    .get(userId)!.n;
  const images = db
    .prepare<[string], { n: number }>(
      `SELECT COUNT(*) AS n FROM document_images i
         JOIN files f ON f.id = i.file_id
        WHERE i.user_id = ? AND f.trashed_at IS NULL`,
    )
    .get(userId)!.n;
  return folders + files + images;
}
