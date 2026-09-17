import { getDb } from '../lib/db.js';
import { runTwoWay } from './pull.js';

/**
 * Sync on a timer, so that two Macs stay in step without anybody pressing a
 * button. The loop lives in the server process rather than in the web layer
 * because the web layer only exists while a window is open, and the thing a
 * student wants is for the Mac they left at home to have caught up by the
 * time they open the other one.
 */

/**
 * The intervals a user may choose, in minutes. A free-form number would let
 * the UI offer a slider that promises precision the loop does not have — it
 * wakes once a minute — and would let a client ask for a sync every minute,
 * which is a lot of Supabase traffic for a library that rarely changes that
 * fast. Zero is off.
 */
export const AUTO_SYNC_CHOICES = [0, 5, 15, 60, 360] as const;
export type AutoSyncMinutes = (typeof AUTO_SYNC_CHOICES)[number];

export function isAutoSyncChoice(value: number): value is AutoSyncMinutes {
  return (AUTO_SYNC_CHOICES as readonly number[]).includes(value);
}

/** Matches the column default in migration 019; see the comment there for why. */
export const DEFAULT_AUTO_SYNC_MINUTES = 15;

/** How often the loop wakes to look for work. */
export const TICK_MS = 60_000;

const MINUTE = 60_000;

/**
 * A failing sync fails for a reason that a minute will not fix — an expired
 * refresh token, a project that has been deleted, a machine that is offline —
 * so retrying at the chosen interval would mean hammering a broken thing all
 * day and filling the log with the same error. Each consecutive failure backs
 * the account off further, up to an hour, and one success clears it.
 */
const BACKOFF_BASE_MS = 2 * MINUTE;
const BACKOFF_MAX_MS = 60 * MINUTE;

export function backoffDelay(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
}

interface Trouble {
  failures: number;
  /** Nothing is attempted for this account before this moment. */
  quietUntil: number;
}

const trouble = new Map<string, Trouble>();

export function noteAutoSyncFailure(userId: string, now = Date.now()): void {
  const failures = (trouble.get(userId)?.failures ?? 0) + 1;
  trouble.set(userId, { failures, quietUntil: now + backoffDelay(failures) });
}

/**
 * Called after any sync that worked, including one the user asked for by
 * hand: pressing "Sync now" and watching it succeed is proof that whatever
 * was broken is not broken any more, and the loop should not stay backed off
 * after that.
 */
export function clearAutoSyncBackoff(userId: string): void {
  trouble.delete(userId);
}

/** Test seam, and the honest way to stop one process's state leaking into the next. */
export function resetAutoSyncState(): void {
  trouble.clear();
}

export interface AutoSyncCandidate {
  userId: string;
  minutes: AutoSyncMinutes;
  lastFinishedAt: number | null;
}

/**
 * Accounts the loop would consider: linked to a project, and not switched
 * off. Whether each one is *due* is decided separately, because the answer
 * depends on the clock and on in-memory backoff that no query can see.
 *
 * The settings row is written at registration, but this joins to it loosely
 * anyway: an account missing one should sync at the default rather than
 * silently never sync at all.
 */
export function autoSyncCandidates(): AutoSyncCandidate[] {
  return getDb()
    .prepare<[number, number], { user_id: string; minutes: number; last_finished_at: number | null }>(
      `SELECT u.id AS user_id,
              COALESCE(s.auto_sync_minutes, ?) AS minutes,
              r.finished_at AS last_finished_at
         FROM users u
         LEFT JOIN user_settings s ON s.user_id = u.id
         LEFT JOIN sync_runs r ON r.user_id = u.id
        WHERE u.supabase_user_id IS NOT NULL
          AND COALESCE(s.auto_sync_minutes, ?) > 0`,
    )
    .all(DEFAULT_AUTO_SYNC_MINUTES, DEFAULT_AUTO_SYNC_MINUTES)
    .map((row) => ({
      userId: row.user_id,
      minutes: (isAutoSyncChoice(row.minutes)
        ? row.minutes
        : DEFAULT_AUTO_SYNC_MINUTES) as AutoSyncMinutes,
      lastFinishedAt: row.last_finished_at,
    }));
}

/**
 * When this account should next be synced automatically, or null if it never
 * should be. An account that has never synced is due immediately, which is
 * what makes a freshly linked second Mac fill itself in without being asked.
 *
 * A failed run still stamps finished_at, so the interval alone would already
 * space out retries; the backoff is what stops a *never*-successful account —
 * one whose sync_runs row was never written — from trying every minute.
 */
export function nextAutoSyncAt(candidate: AutoSyncCandidate): number | null {
  if (candidate.minutes === 0) return null;
  const scheduled =
    candidate.lastFinishedAt === null
      ? 0
      : candidate.lastFinishedAt + candidate.minutes * MINUTE;
  return Math.max(scheduled, trouble.get(candidate.userId)?.quietUntil ?? 0);
}

export function autoSyncDue(candidate: AutoSyncCandidate, now: number): boolean {
  const at = nextAutoSyncAt(candidate);
  return at !== null && at <= now;
}

/** What /sync/status reports, so the UI can say when the next one is coming. */
export function autoSyncSummary(userId: string): {
  minutes: number;
  nextRunAt: number | null;
} {
  const candidate = autoSyncCandidates().find((c) => c.userId === userId);
  if (!candidate) {
    const minutes =
      getDb()
        .prepare<[string], { minutes: number }>(
          'SELECT auto_sync_minutes AS minutes FROM user_settings WHERE user_id = ?',
        )
        .get(userId)?.minutes ?? DEFAULT_AUTO_SYNC_MINUTES;
    // Chosen but unreachable: an account with no project to sync with keeps
    // its preference, and simply has nothing scheduled.
    return { minutes, nextRunAt: null };
  }
  return { minutes: candidate.minutes, nextRunAt: nextAutoSyncAt(candidate) };
}

export interface TickLog {
  warn(obj: unknown, msg: string): void;
}

/**
 * One pass. Runs accounts one after another rather than in parallel: the work
 * is mostly waiting on Supabase, but a library push walks the whole tree and
 * writes to SQLite, and doing several at once on a machine that is also
 * running the app the user is typing into is not a trade worth making.
 *
 * Returns how many accounts were synced, which is what the tests assert on.
 */
export async function runAutoSyncTick(now = Date.now(), log?: TickLog): Promise<number> {
  let ran = 0;
  for (const candidate of autoSyncCandidates()) {
    if (!autoSyncDue(candidate, now)) continue;
    try {
      await runTwoWay(candidate.userId);
      clearAutoSyncBackoff(candidate.userId);
      ran += 1;
    } catch (err) {
      // A sync the user started by hand holds the per-account lock, and this
      // tick losing that race is not a failure worth backing off over.
      const code = (err as { code?: string } | null)?.code;
      if (code === 'sync_in_progress') continue;
      noteAutoSyncFailure(candidate.userId, now);
      log?.warn({ err, userId: candidate.userId }, 'automatic sync failed');
    }
  }
  return ran;
}

/**
 * Starts the loop and hands back the way to stop it. The timer is unref'd for
 * the same reason the housekeeping one is: a pending tick should never be the
 * reason the process stays alive.
 */
export function startAutoSync(log?: TickLog): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return; // A slow pass must not overlap the next one.
    running = true;
    void runAutoSyncTick(Date.now(), log)
      .catch((err) => log?.warn({ err }, 'automatic sync pass failed'))
      .finally(() => {
        running = false;
      });
  }, TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
