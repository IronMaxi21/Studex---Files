import { getDb } from '../lib/db.js';
import { config } from '../lib/config.js';
import { clientForSession } from '../lib/supabase.js';
import { libraryWatcher, type WatchHandle } from '../lib/realtime.js';
import { readSupabaseSession, rememberSupabaseSession } from './auth.js';
import { runTwoWay } from './pull.js';

/**
 * Sync that arrives rather than sync that is fetched.
 *
 * `autosync.ts` covers the complaint that two Macs drift apart overnight. It
 * cannot cover the one where a change made on one of them should show up on
 * the other while both are open, because the shortest interval anyone would
 * sanely offer is five minutes. A subscription to the library table closes
 * that gap: Supabase says a row moved, and this pulls.
 *
 * Nothing here talks to a websocket. `lib/realtime.ts` does that, behind a seam
 * the tests replace, and everything below is the part with opinions — when a
 * burst of rows counts as one change, how often an account may be synced
 * because of them, and what to do about a project that keeps hanging up.
 */

/** A burst of rows is one edit. Waiting this long turns it into one sync. */
export const SETTLE_MS = 2_000;

/**
 * The floor between two event-driven syncs.
 *
 * Somebody dragging thirty files into a folder upstream produces thirty
 * notifications, and each sync walks the whole library. The settle window
 * already collapses a burst; this is what stops a slow trickle of edits —
 * someone typing on another device — from meaning a continuous sync.
 */
export const MIN_GAP_MS = 15_000;

/** How often the loop looks at its subscriptions and its dirty accounts. */
export const TICK_MS = 2_000;

/** How often it reconsiders *which* accounts should have a subscription. */
export const RECONCILE_MS = 30_000;

/**
 * A socket authorises with an access token that lasts an hour, and a socket
 * whose token has expired does not fail — it simply stops delivering rows that
 * row-level security will no longer let through. Re-authorising this far ahead
 * of expiry means that never happens quietly.
 */
export const TOKEN_MARGIN_MS = 5 * 60_000;

/** Same shape and same reasoning as the interval's backoff, different scale:
 * a dropped socket is usually a network that came back a second later, so the
 * first retry is quick where a failed sync's is minutes. */
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

export function retryDelay(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS);
}

interface Live {
  supabaseUserId: string;
  handle: WatchHandle | null;
  /** When the subscription went live, or null while it is not. */
  connectedAt: number | null;
  /** Epoch ms at which the token the socket holds stops being accepted. */
  tokenExpiresAt: number;
  lastEventAt: number | null;
  /** When the first change of the current burst arrived, or null if settled. */
  dirtySince: number | null;
  lastSyncAt: number;
  failures: number;
  /** Nothing is attempted for this account before this moment. */
  quietUntil: number;
  /** A subscription attempt in flight; a second tick must not start another. */
  opening: boolean;
}

const live = new Map<string, Live>();
let nextReconcileAt = 0;

/** Test seam, and the honest way to stop one process's state leaking into the next. */
export function resetRealtimeState(): void {
  for (const entry of live.values()) void entry.handle?.close();
  live.clear();
  nextReconcileAt = 0;
}

export function realtimeEnabled(): boolean {
  return config.syncRealtime;
}

export interface RealtimeCandidate {
  userId: string;
  supabaseUserId: string;
}

/**
 * Accounts worth watching: linked to a project, and with automatic sync left
 * on.
 *
 * Deliberately the same switch the interval uses. Somebody who has set
 * automatic sync to "off" has said what they want, and honouring that for the
 * timer while a websocket carried on syncing anyway would make the setting a
 * lie.
 */
export function realtimeCandidates(): RealtimeCandidate[] {
  if (!realtimeEnabled()) return [];
  return getDb()
    .prepare<[number], { user_id: string; supabase_user_id: string }>(
      `SELECT u.id AS user_id, u.supabase_user_id
         FROM users u
         LEFT JOIN user_settings s ON s.user_id = u.id
        WHERE u.supabase_user_id IS NOT NULL
          AND COALESCE(s.auto_sync_minutes, ?) > 0`,
    )
    .all(15)
    .map((row) => ({ userId: row.user_id, supabaseUserId: row.supabase_user_id }));
}

/* ── what a change means ──────────────────────────────────────────────── */

/** A row this account owns moved upstream. */
export function noteRealtimeChange(userId: string, now = Date.now()): void {
  const entry = live.get(userId);
  if (!entry) return;
  entry.lastEventAt = now;
  if (entry.dirtySince === null) entry.dirtySince = now;
}

/**
 * The accounts whose changes have settled and whose turn it is.
 *
 * Both conditions matter and they are not the same one: the settle window is
 * about a single edit arriving as several rows, and the gap is about several
 * edits arriving over a minute.
 */
export function dueForSync(now = Date.now()): string[] {
  const due: string[] = [];
  for (const [userId, entry] of live) {
    if (entry.dirtySince === null) continue;
    if (now < entry.dirtySince + SETTLE_MS) continue;
    if (now < entry.lastSyncAt + MIN_GAP_MS) continue;
    due.push(userId);
  }
  return due;
}

/** What /sync/status reports, so the UI can say whether it is listening. */
export function realtimeSummary(userId: string): {
  enabled: boolean;
  connected: boolean;
  lastEventAt: number | null;
} {
  const entry = live.get(userId);
  return {
    enabled: realtimeEnabled(),
    connected: entry?.connectedAt !== null && entry?.connectedAt !== undefined,
    lastEventAt: entry?.lastEventAt ?? null,
  };
}

/* ── keeping the subscriptions where they should be ───────────────────── */

export interface TickLog {
  warn(obj: unknown, msg: string): void;
}

/**
 * Puts an account down for a while: no socket, and nothing attempted until the
 * delay has passed. Called both when opening one fails and when one that was
 * working goes away, because from here those are the same situation.
 */
function drop(entry: Live, now: number): void {
  void entry.handle?.close();
  entry.handle = null;
  entry.connectedAt = null;
  entry.failures += 1;
  entry.quietUntil = now + retryDelay(entry.failures);
  entry.opening = false;
}

export interface RealtimeToken {
  accessToken: string;
  /** Epoch ms. What the socket has to be re-authorised before. */
  expiresAt: number;
}

/**
 * Where a socket's credential comes from.
 *
 * A parameter rather than a hard call for the same reason `pushLibrary` takes
 * its store: it is the one part of this file that needs a Supabase project on
 * the other end, and the decisions worth testing are all on this side of it.
 */
export type TokenSource = (userId: string) => Promise<RealtimeToken | null>;

/**
 * The real one: reads the stored Supabase session, refreshing it if it needs
 * refreshing, and writes back whatever came out.
 *
 * Refresh tokens rotate, so the write-back is not optional: skipping it leaves
 * a superseded token in the database and the next sync — not this socket, the
 * next *sync* — fails with a credential nobody touched.
 */
export const supabaseTokens: TokenSource = async (userId) => {
  const stored = readSupabaseSession(userId);
  if (!stored) return null;
  const opened = await clientForSession(stored);
  if (!opened) return null;
  rememberSupabaseSession(userId, opened.session);
  return { accessToken: opened.session.accessToken, expiresAt: opened.session.expiresAt };
};

/**
 * Brings the set of live subscriptions in line with the set of accounts that
 * should have one, and re-authorises the ones whose token is about to lapse.
 */
export async function reconcileWatchers(
  now = Date.now(),
  log?: TickLog,
  tokens: TokenSource = supabaseTokens,
): Promise<void> {
  const wanted = new Map(realtimeCandidates().map((c) => [c.userId, c]));

  // Gone: signed out, unlinked, or automatic sync switched off.
  for (const [userId, entry] of live) {
    if (wanted.has(userId)) continue;
    void entry.handle?.close();
    live.delete(userId);
  }

  for (const candidate of wanted.values()) {
    let entry = live.get(candidate.userId);
    if (!entry) {
      entry = {
        supabaseUserId: candidate.supabaseUserId,
        handle: null,
        connectedAt: null,
        tokenExpiresAt: 0,
        lastEventAt: null,
        dirtySince: null,
        lastSyncAt: 0,
        failures: 0,
        quietUntil: 0,
        opening: false,
      };
      live.set(candidate.userId, entry);
    }

    if (entry.opening) continue;

    if (entry.handle) {
      if (now < entry.tokenExpiresAt - TOKEN_MARGIN_MS) continue;
      const token = await tokens(candidate.userId);
      if (!token) {
        // The session is past saving; there is nothing to re-authorise with,
        // and holding a socket open on a dead token would be pretending.
        drop(entry, now);
        log?.warn({ userId: candidate.userId }, 'cannot re-authorise the library subscription');
        continue;
      }
      entry.handle.setToken(token.accessToken);
      entry.tokenExpiresAt = token.expiresAt;
      continue;
    }

    if (now < entry.quietUntil) continue;

    entry.opening = true;
    try {
      const token = await tokens(candidate.userId);
      if (!token) {
        drop(entry, now);
        continue;
      }
      const userId = candidate.userId;
      const handle = await libraryWatcher().watch({
        supabaseUserId: candidate.supabaseUserId,
        accessToken: token.accessToken,
        onChange: () => noteRealtimeChange(userId),
        onDropped: (reason) => {
          const current = live.get(userId);
          if (!current) return;
          drop(current, Date.now());
          log?.warn({ userId, reason }, 'library subscription dropped');
        },
      });
      entry.handle = handle;
      entry.connectedAt = now;
      entry.tokenExpiresAt = token.expiresAt;
      entry.failures = 0;
      entry.quietUntil = 0;
      entry.opening = false;
    } catch (err) {
      drop(entry, now);
      log?.warn({ err, userId: candidate.userId }, 'library subscription failed');
    }
  }
}

/**
 * One pass: reconcile if it is time to, then sync whoever is due.
 *
 * Returns how many accounts were synced, which is what the tests assert on.
 */
export async function runRealtimeTick(
  now = Date.now(),
  log?: TickLog,
  tokens: TokenSource = supabaseTokens,
): Promise<number> {
  if (!realtimeEnabled()) return 0;

  if (now >= nextReconcileAt) {
    nextReconcileAt = now + RECONCILE_MS;
    await reconcileWatchers(now, log, tokens);
  }

  let ran = 0;
  for (const userId of dueForSync(now)) {
    const entry = live.get(userId);
    if (!entry) continue;
    // Cleared before the attempt, not after: a change arriving mid-sync must
    // mark the account dirty again rather than be swallowed by the run that
    // was already reading when it landed.
    entry.dirtySince = null;
    entry.lastSyncAt = now;
    try {
      await runTwoWay(userId);
      ran += 1;
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      // A sync the user started by hand holds the per-account lock. The change
      // is still unsynced, so it stays dirty and the next tick tries again.
      if (code === 'sync_in_progress') {
        entry.dirtySince = now;
        continue;
      }
      log?.warn({ err, userId }, 'sync after a library change failed');
    }
  }
  return ran;
}

/**
 * Starts the loop and hands back the way to stop it. Unref'd for the same
 * reason the others are: a pending tick should never be why the process is
 * still alive.
 */
export function startRealtimeSync(log?: TickLog): () => void {
  if (!realtimeEnabled()) return () => {};

  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void runRealtimeTick(Date.now(), log)
      .catch((err) => log?.warn({ err }, 'realtime sync pass failed'))
      .finally(() => {
        running = false;
      });
  }, TICK_MS);
  timer.unref();

  return () => {
    clearInterval(timer);
    resetRealtimeState();
  };
}
