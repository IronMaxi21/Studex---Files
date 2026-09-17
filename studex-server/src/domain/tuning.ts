/**
 * "Tune my scheduler": fitting the FSRS weights to one student's own history.
 *
 * The defaults in fsrs.ts were fitted to millions of reviews by other people.
 * Once a student has a few hundred reviews of their own, those reviews say
 * something the defaults cannot — how fast *this* student forgets. The fit
 * replays each card's logged grades through the same memory model the
 * scheduler uses, predicts recall at every review taken a day or more after
 * the last, and moves the weights to make those predictions match what
 * actually happened (log loss).
 *
 * Three guards keep a small history from making the schedule worse:
 *  - the fit is pulled toward the defaults, and the pull weakens only as the
 *    history grows;
 *  - every weight stays inside the range the FSRS optimiser itself allows;
 *  - a fifth of the cards are held back, and the personal set is kept only if
 *    it predicts those unseen cards better than the defaults do.
 *
 * Coordinate search rather than gradients: the replay is cheap, the number of
 * weights is small, and a search that only ever accepts improvements cannot
 * diverge. It runs under a time budget so the request stays short.
 */
import { getDb } from '../lib/db.js';
import { badRequest } from '../lib/errors.js';
import { DAY_MS } from '../lib/time.js';
import { DEFAULT_WEIGHTS, type FsrsRating, type MemoryState, nextMemoryState, retrievability } from './fsrs.js';

/** Reviews taken a day or more after the last, the ones a fit can learn from. */
export const MIN_SCORED_REVIEWS = 400;
const MIN_CARDS = 40;
const MAX_SCORED_REVIEWS = 30_000;
const TIME_BUDGET_MS = 4_000;
/** How many scored reviews it takes for the history to outweigh the defaults. */
const PRIOR_REVIEWS = 1_500;
/** The holdout improvement a personal set must show before it replaces the defaults. */
const MIN_GAIN = 0.002;

/** [low, high] per weight, as the FSRS optimiser clamps them. */
const BOUNDS: readonly [number, number][] = [
  [0.01, 100], [0.01, 100], [0.01, 100], [0.01, 100],
  [1, 10], [0.001, 4], [0.001, 4], [0.001, 0.75],
  [0, 4.5], [0, 0.8], [0.001, 3.5], [0.001, 5],
  [0.001, 0.25], [0.001, 0.9], [0, 4], [0, 1],
  [1, 6], [0, 2], [0, 2],
];

/* The four opening stabilities span four orders of magnitude, so they are searched in log space. */
const LOG_SCALE = new Set([0, 1, 2, 3]);

interface Review { rating: FsrsRating; at: number }
/** One card's reviews in order; `id` only decides which side of the holdout it falls. */
type CardHistory = Review[] & { id?: string };
type History = CardHistory[];

export interface Fit {
  loss: number;
  scored: number;
  /** Share of scored reviews recalled, and the mean recall the weights predicted. */
  recalled: number;
  predicted: number;
}

const toSearch = (i: number, v: number) => (LOG_SCALE.has(i) ? Math.log(v) : v);
const fromSearch = (i: number, v: number) => (LOG_SCALE.has(i) ? Math.exp(v) : v);
const range = (i: number) => toSearch(i, BOUNDS[i]![1]) - toSearch(i, BOUNDS[i]![0]);

export function isValidWeights(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length === DEFAULT_WEIGHTS.length
    && value.every((v, i) => typeof v === 'number' && Number.isFinite(v) && v >= BOUNDS[i]![0] && v <= BOUNDS[i]![1]);
}

/** The weights this account schedules with: its tuned set, or the defaults. */
export function weightsFor(userId: string): readonly number[] {
  const row = getDb()
    .prepare<[string], { fsrs_weights: string | null }>('SELECT fsrs_weights FROM user_settings WHERE user_id = ?')
    .get(userId);
  if (!row?.fsrs_weights) return DEFAULT_WEIGHTS;
  try {
    const parsed: unknown = JSON.parse(row.fsrs_weights);
    return isValidWeights(parsed) ? parsed : DEFAULT_WEIGHTS;
  } catch {
    return DEFAULT_WEIGHTS;
  }
}

/** Each card's scheduled reviews in order, newest cards first up to the cap. */
function loadHistory(userId: string): History {
  const rows = getDb()
    .prepare<[string], { card_id: string; rating: number; reviewed_at: number }>(
      `SELECT card_id, rating, reviewed_at FROM review_logs
        WHERE user_id = ? AND mode = 'review'
        ORDER BY card_id, reviewed_at`,
    )
    .all(userId);
  const byCard = new Map<string, Review[]>();
  for (const r of rows) {
    const list = byCard.get(r.card_id) ?? [];
    list.push({ rating: r.rating as FsrsRating, at: r.reviewed_at });
    byCard.set(r.card_id, list);
  }
  const cards = [...byCard.entries()]
    .filter(([, list]) => list.length > 1)
    .sort((a, b) => b[1][b[1].length - 1]!.at - a[1][a[1].length - 1]!.at);
  const kept: [string, Review[]][] = [];
  let scored = 0;
  for (const entry of cards) {
    if (scored >= MAX_SCORED_REVIEWS) break;
    kept.push(entry);
    scored += scoredIn(entry[1]);
  }
  return kept.map(([id, list]) => Object.assign(list, { id }));
}

function scoredIn(list: Review[]): number {
  let n = 0;
  for (let i = 1; i < list.length; i += 1) if ((list[i]!.at - list[i - 1]!.at) / DAY_MS >= 1) n += 1;
  return n;
}

/** Replays a history under a set of weights and scores its predictions. */
export function evaluate(history: History, w: readonly number[]): Fit {
  let loss = 0;
  let scored = 0;
  let recalled = 0;
  let predicted = 0;
  for (const list of history) {
    let state: MemoryState | null = null;
    let last = 0;
    for (const review of list) {
      const elapsed = state ? (review.at - last) / DAY_MS : 0;
      if (state && elapsed >= 1) {
        const p = Math.min(Math.max(retrievability(elapsed, state.stability), 1e-4), 1 - 1e-4);
        const y = review.rating > 1 ? 1 : 0;
        loss -= y ? Math.log(p) : Math.log(1 - p);
        scored += 1;
        recalled += y;
        predicted += p;
      }
      state = nextMemoryState(state, review.rating, elapsed, w);
      last = review.at;
    }
  }
  return scored
    ? { loss: loss / scored, scored, recalled: recalled / scored, predicted: predicted / scored }
    : { loss: 0, scored: 0, recalled: 0, predicted: 0 };
}

/** Holds back roughly a fifth of the cards, the same ones on every run. */
function split(history: History): { train: History; test: History } {
  const train: History = [];
  const test: History = [];
  for (const list of history) {
    // Keyed on the card id, so a card stays on the same side on every run.
    let hash = 0;
    for (const ch of list.id ?? String(list[0]!.at)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    (hash % 5 === 0 ? test : train).push(list);
  }
  return { train, test };
}

/** Fits weights to a history. Pure apart from the clock used for the budget. */
export function fitWeights(history: History, start: readonly number[] = DEFAULT_WEIGHTS): { weights: number[]; rounds: number } {
  const base = evaluate(history, start);
  const strength = PRIOR_REVIEWS / (PRIOR_REVIEWS + base.scored);
  const penalty = (w: readonly number[]) => {
    let sum = 0;
    for (let i = 0; i < w.length; i += 1) {
      const d = (toSearch(i, w[i]!) - toSearch(i, DEFAULT_WEIGHTS[i]!)) / range(i);
      sum += d * d;
    }
    return strength * sum;
  };
  const objective = (w: readonly number[]) => evaluate(history, w).loss + penalty(w);

  const w = [...start];
  let best = objective(w);
  const steps = w.map((_, i) => range(i) * 0.08);
  const deadline = Date.now() + TIME_BUDGET_MS;
  let rounds = 0;

  while (rounds < 14 && Date.now() < deadline) {
    rounds += 1;
    let improved = false;
    for (let i = 0; i < w.length && Date.now() < deadline; i += 1) {
      for (const dir of [1, -1]) {
        const lo = toSearch(i, BOUNDS[i]![0]);
        const hi = toSearch(i, BOUNDS[i]![1]);
        const moved = Math.min(Math.max(toSearch(i, w[i]!) + dir * steps[i]!, lo), hi);
        const candidate = [...w];
        candidate[i] = fromSearch(i, moved);
        const score = objective(candidate);
        if (score < best - 1e-9) {
          best = score;
          w[i] = candidate[i]!;
          improved = true;
          break;
        }
      }
    }
    if (!improved) {
      for (let i = 0; i < steps.length; i += 1) steps[i]! /= 2;
      if (steps.every((s, i) => s < range(i) * 0.002)) break;
    }
  }
  return { weights: w.map((v, i) => Math.min(Math.max(v, BOUNDS[i]![0]), BOUNDS[i]![1])), rounds };
}

const percent = (n: number) => Math.round(n * 1000) / 10;

/** Whether the account has enough history, and whether it is already tuned. */
export function schedulerStatus(userId: string) {
  const history = loadHistory(userId);
  const scored = history.reduce((n, list) => n + scoredIn(list), 0);
  const row = getDb()
    .prepare<[string], { fsrs_weights: string | null; fsrs_tuned_at: number | null; fsrs_tuned_reviews: number | null }>(
      'SELECT fsrs_weights, fsrs_tuned_at, fsrs_tuned_reviews FROM user_settings WHERE user_id = ?',
    )
    .get(userId);
  return {
    tuned: Boolean(row?.fsrs_weights),
    tuned_at: row?.fsrs_tuned_at ?? null,
    tuned_reviews: row?.fsrs_tuned_reviews ?? null,
    scored_reviews: scored,
    cards: history.length,
    needed_reviews: MIN_SCORED_REVIEWS,
    eligible: scored >= MIN_SCORED_REVIEWS && history.length >= MIN_CARDS,
    new_since_tuning: row?.fsrs_tuned_reviews != null ? Math.max(0, scored - row.fsrs_tuned_reviews) : null,
  };
}

/**
 * Fits, checks against held-back cards, and keeps the personal set only when
 * it predicts them better than the defaults. Returns what was found either way.
 */
export function tuneScheduler(userId: string, now = Date.now()) {
  const history = loadHistory(userId);
  const scored = history.reduce((n, list) => n + scoredIn(list), 0);
  if (scored < MIN_SCORED_REVIEWS || history.length < MIN_CARDS) {
    throw badRequest(
      `Tuning needs at least ${MIN_SCORED_REVIEWS} reviews of cards seen on an earlier day, across ${MIN_CARDS} cards — this account has ${scored}.`,
    );
  }

  const { train, test } = split(history);
  const fitted = fitWeights(train).weights;
  const before = evaluate(test, DEFAULT_WEIGHTS);
  const after = evaluate(test, fitted);
  const applied = before.scored > 0 && after.loss < before.loss * (1 - MIN_GAIN);

  // The kept set is refitted on everything, starting from the held-out winner.
  const weights = applied ? fitWeights(history, fitted).weights : null;
  getDb()
    .prepare(
      `UPDATE user_settings SET fsrs_weights = ?, fsrs_tuned_at = ?, fsrs_tuned_reviews = ?, updated_at = ?
        WHERE user_id = ?`,
    )
    .run(weights ? JSON.stringify(weights.map((v) => Math.round(v * 1e5) / 1e5)) : null, applied ? now : null, applied ? scored : null, now, userId);

  return {
    applied,
    reviews: scored,
    cards: history.length,
    holdout_reviews: before.scored,
    loss_default: Math.round(before.loss * 10_000) / 10_000,
    loss_tuned: Math.round(after.loss * 10_000) / 10_000,
    improvement_pct: before.loss ? percent((before.loss - after.loss) / before.loss) : 0,
    recall_actual_pct: percent(before.recalled),
    recall_predicted_default_pct: percent(before.predicted),
    recall_predicted_tuned_pct: percent(after.predicted),
  };
}

/** Back to the published defaults. */
export function resetScheduler(userId: string) {
  getDb()
    .prepare(
      'UPDATE user_settings SET fsrs_weights = NULL, fsrs_tuned_at = NULL, fsrs_tuned_reviews = NULL, updated_at = ? WHERE user_id = ?',
    )
    .run(Date.now(), userId);
}
