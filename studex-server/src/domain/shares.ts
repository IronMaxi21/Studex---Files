import { getDb } from '../lib/db.js';
import { generateToken, hashToken } from '../lib/crypto.js';
import { newId } from '../lib/ids.js';
import { forbidden, notFound } from '../lib/errors.js';
import { requireFile, requireFolder } from './library.js';

export type SharePermission = 'view' | 'edit';

export interface ShareRow {
  id: string;
  user_id: string;
  target_type: 'file' | 'folder';
  target_id: string;
  permission: SharePermission;
  expires_at: number | null;
  revoked_at: number | null;
  created_at: number;
}

/**
 * Creates a share link. Only the hash of the token is stored, so the plaintext
 * is returned exactly once — a database leak cannot reconstruct a working link.
 *
 * The scope defaults to view. An edit link hands write access to whoever holds
 * the URL, with no account and no way to tell two holders apart, so it is
 * always something the owner asked for explicitly rather than something they
 * got by leaving a field out.
 */
export function createShare(
  userId: string,
  input: {
    targetType: 'file' | 'folder';
    targetId: string;
    permission?: SharePermission;
    expiresAt?: number | null;
  },
): { share: ShareRow; token: string } {
  if (input.targetType === 'file') requireFile(userId, input.targetId);
  else requireFolder(userId, input.targetId);

  const token = generateToken();
  const id = newId();
  const now = Date.now();

  getDb()
    .prepare(
      `INSERT INTO shares (id, user_id, target_type, target_id, token_hash, permission, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      userId,
      input.targetType,
      input.targetId,
      hashToken(token),
      input.permission ?? 'view',
      input.expiresAt ?? null,
      now,
    );

  return { share: requireShare(userId, id), token };
}

export function requireShare(userId: string, shareId: string): ShareRow {
  const row = getDb()
    .prepare<[string, string], ShareRow>(
      `SELECT id, user_id, target_type, target_id, permission, expires_at, revoked_at, created_at
       FROM shares WHERE id = ? AND user_id = ?`,
    )
    .get(shareId, userId);
  if (!row) throw notFound('Share not found');
  return row;
}

export function listShares(userId: string): ShareRow[] {
  return getDb()
    .prepare<[string], ShareRow>(
      `SELECT id, user_id, target_type, target_id, permission, expires_at, revoked_at, created_at
       FROM shares WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
    )
    .all(userId);
}

export function revokeShare(userId: string, shareId: string): void {
  requireShare(userId, shareId);
  getDb()
    .prepare('UPDATE shares SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
    .run(Date.now(), shareId, userId);
}

export interface ResolvedShare {
  target_type: 'file' | 'folder';
  title: string;
  owner_name: string;
  /** What the holder of this link may do. The viewer reads it to decide
   *  whether to render an editor or a page. */
  permission: SharePermission;
  files: { id: string; title: string; kind: string; updated_at: number }[];
}

/**
 * Resolves a share token for an anonymous viewer. Returns titles and structure
 * only — never the owner's email, folder tree outside the shared target, or
 * any id that would let a viewer reach unshared content.
 */
export function resolveShareToken(token: string, now = Date.now()): ResolvedShare | null {
  const row = getDb()
    .prepare<[string], ShareRow & { display_name: string }>(
      `SELECT s.id, s.user_id, s.target_type, s.target_id, s.permission, s.expires_at,
              s.revoked_at, s.created_at, u.display_name
       FROM shares s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    )
    .get(hashToken(token));

  if (!row) return null;
  if (row.revoked_at !== null) return null;
  if (row.expires_at !== null && row.expires_at <= now) return null;

  if (row.target_type === 'file') {
    const file = getDb()
      .prepare<[string, string], { id: string; title: string; kind: string; updated_at: number }>(
        'SELECT id, title, kind, updated_at FROM files WHERE id = ? AND user_id = ? AND trashed_at IS NULL',
      )
      .get(row.target_id, row.user_id);
    if (!file) return null;
    return {
      target_type: 'file',
      title: file.title,
      owner_name: row.display_name,
      permission: row.permission,
      files: [file],
    };
  }

  const folder = getDb()
    .prepare<[string, string], { name: string }>(
      'SELECT name FROM folders WHERE id = ? AND user_id = ?',
    )
    .get(row.target_id, row.user_id);
  if (!folder) return null;

  const files = getDb()
    .prepare<[string, string], { id: string; title: string; kind: string; updated_at: number }>(
      `SELECT id, title, kind, updated_at FROM files
       WHERE folder_id = ? AND user_id = ? AND trashed_at IS NULL
       ORDER BY updated_at DESC LIMIT 500`,
    )
    .all(row.target_id, row.user_id);

  return {
    target_type: 'folder',
    title: folder.name,
    owner_name: row.display_name,
    permission: row.permission,
    files,
  };
}

export interface ShareAccess {
  shareId: string;
  /** The owner of the shared content. Every downstream call runs as them,
   *  which is what lets shared routes reuse the ordinary domain functions
   *  and inherit all their ownership and validation checks unchanged. */
  ownerId: string;
  permission: SharePermission;
  fileId: string;
  kind: string;
}

/**
 * Resolves a token to a single file the link genuinely reaches, or throws.
 *
 * The fileId comes from the URL, so it is treated as a claim to be checked
 * rather than a fact: a file share reaches exactly its target, and a folder
 * share reaches only the files sitting directly in that folder — the same set
 * resolveShareToken lists. Anything else is a 404, identical to the response
 * for a revoked or invented token, so a holder cannot use error codes to probe
 * for files outside their scope.
 */
export function requireSharedFile(
  token: string,
  fileId: string,
  need: SharePermission = 'view',
  now = Date.now(),
): ShareAccess {
  const row = getDb()
    .prepare<[string], ShareRow>(
      `SELECT id, user_id, target_type, target_id, permission, expires_at, revoked_at, created_at
       FROM shares WHERE token_hash = ?`,
    )
    .get(hashToken(token));

  const gone = notFound('This link is no longer available');
  if (!row) throw gone;
  if (row.revoked_at !== null) throw gone;
  if (row.expires_at !== null && row.expires_at <= now) throw gone;

  const file = getDb()
    .prepare<[string, string], { id: string; kind: string; folder_id: string | null }>(
      'SELECT id, kind, folder_id FROM files WHERE id = ? AND user_id = ? AND trashed_at IS NULL',
    )
    .get(fileId, row.user_id);
  if (!file) throw gone;

  const inScope =
    row.target_type === 'file' ? file.id === row.target_id : file.folder_id === row.target_id;
  if (!inScope) throw gone;

  // Scope is settled before permission, so a view link asking to write learns
  // only that it may not write — never whether some other file exists.
  if (need === 'edit' && row.permission !== 'edit') {
    throw forbidden('This link is read-only');
  }

  return {
    shareId: row.id,
    ownerId: row.user_id,
    permission: row.permission,
    fileId: file.id,
    kind: file.kind,
  };
}
