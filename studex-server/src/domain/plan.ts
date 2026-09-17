/**
 * What each tier is allowed to hold.
 *
 * Storage was the only difference the server actually enforced, which made
 * every other line on the Plan screen a claim rather than a rule. These are
 * rules: they are checked where the thing is created, inside the same
 * transaction that creates it, so two requests racing at the limit cannot both
 * be admitted.
 *
 * Notes and decks are deliberately unlimited on both tiers. A revision app
 * that rations the writing of notes is not a revision app.
 */
import { getDb } from '../lib/db.js';
import { notFound, planLimit } from '../lib/errors.js';

export type FileKind = 'canvas' | 'doc' | 'pdf' | 'deck';

/** null means no cap. */
export const FREE_LIMITS: Record<FileKind, number | null> = {
  canvas: 3,
  pdf: 5,
  doc: null,
  deck: null,
};

export const PRO_LIMITS: Record<FileKind, number | null> = {
  canvas: null,
  pdf: null,
  doc: null,
  deck: null,
};

export function limitsFor(plan: 'free' | 'pro'): Record<FileKind, number | null> {
  return plan === 'pro' ? PRO_LIMITS : FREE_LIMITS;
}

const NOUN: Record<FileKind, [string, string]> = {
  canvas: ['canvas', 'canvases'],
  pdf: ['PDF', 'PDFs'],
  doc: ['note', 'notes'],
  deck: ['deck', 'decks'],
};

/** Live files only: something in the trash is recoverable, not held. */
export function countLive(userId: string, kind: FileKind): number {
  const row = getDb()
    .prepare<[string, string], { n: number }>(
      'SELECT COUNT(*) AS n FROM files WHERE user_id = ? AND kind = ? AND trashed_at IS NULL',
    )
    .get(userId, kind);
  return row?.n ?? 0;
}

function planOf(userId: string): 'free' | 'pro' {
  const row = getDb()
    .prepare<[string], { plan: 'free' | 'pro' }>('SELECT plan FROM users WHERE id = ?')
    .get(userId);
  if (!row) throw notFound('User not found');
  return row.plan;
}

/**
 * Refuses the creation that would take the account past its tier's cap.
 *
 * The message names the number rather than saying "upgrade", because the
 * useful fact is how many they are allowed and how many they have — emptying
 * the trash or deleting one is as valid an answer as paying.
 */
export function assertCanCreate(userId: string, kind: FileKind, opts: { verb?: string } = {}): void {
  const plan = planOf(userId);
  const limit = limitsFor(plan)[kind];
  if (limit === null) return;

  const held = countLive(userId, kind);
  if (held < limit) return;

  const [one, many] = NOUN[kind];
  const article = one === 'PDF' ? 'a PDF' : `a ${one}`;
  throw planLimit(
    `Studex Free keeps up to ${limit} ${many}. You have ${held}, so there is no room to `
      + `${opts.verb ?? 'add'} another. `
      + `Delete ${article} you no longer need, or upgrade to Pro for as many as you like.`,
    { kind, limit, held, plan },
  );
}

/** What the Plan screen shows: the caps, and how close the account is to them. */
export function planUsage(userId: string) {
  const plan = planOf(userId);
  const limits = limitsFor(plan);
  const kinds: FileKind[] = ['canvas', 'pdf', 'doc', 'deck'];
  return {
    plan,
    items: kinds.map((kind) => ({ kind, used: countLive(userId, kind), limit: limits[kind] })),
  };
}
