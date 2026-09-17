import { log } from './log.js';

/**
 * Trying again, for the failures where trying again is the right answer.
 *
 * The hard part of a retry is not the loop, it is knowing what may be retried.
 * A request that creates something is not safe to repeat blindly: the first
 * attempt may have succeeded and only its reply been lost, and the second
 * would then make a second copy. So nothing here decides for itself — the
 * caller says whether the work is idempotent, and only idempotent work is
 * repeated.
 *
 * The wait grows and carries jitter. Without jitter, everything that failed
 * during one outage comes back at the same instant when it ends, which is how
 * a recovering server is knocked over a second time by its own clients.
 */
export interface RetryOptions {
  /** How many times to run the work in total, first attempt included. */
  attempts?: number;
  /** The first wait, doubling from there. */
  baseMs?: number;
  /** A ceiling, so a long backoff never becomes an apparent hang. */
  maxMs?: number;
  /** Names the operation in the log line when an attempt fails. */
  what?: string;
  /** Whether this particular failure is worth another try. */
  retryable?: (error: unknown) => boolean;
  /** Injectable so tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Transport failures and the server-side statuses that mean "not now".
 * A 400 or a 403 will say exactly the same thing next time, and retrying it
 * only delays telling the user something true.
 */
export function isTransient(error: unknown): boolean {
  const status = (error as { statusCode?: number; status?: number })?.statusCode
    ?? (error as { status?: number })?.status;
  if (typeof status === 'number') {
    return status === 408 || status === 429 || (status >= 500 && status <= 599);
  }
  const name = (error as { name?: string })?.name ?? '';
  const message = String((error as { message?: string })?.message ?? '').toLowerCase();
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  return /network|fetch failed|socket|econnreset|econnrefused|etimedout|enotfound|eai_again|dns/.test(message);
}

export async function withRetry<T>(work: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseMs = options.baseMs ?? 250;
  const maxMs = options.maxMs ?? 4_000;
  const retryable = options.retryable ?? isTransient;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !retryable(error)) throw error;

      // Exponential, capped, then jittered across the whole window rather than
      // a small wobble around the target — full jitter is what actually
      // spreads a thundering herd out.
      const ceiling = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const wait = Math.round(Math.random() * ceiling);
      log.debug(
        { what: options.what ?? 'request', attempt, of: attempts, waitMs: wait, error },
        'retrying after a transient failure',
      );
      await sleep(wait);
    }
  }
  throw lastError;
}
