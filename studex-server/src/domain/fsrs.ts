/**
 * FSRS — the Free Spaced Repetition Scheduler, version 5.
 *
 * SM-2 tracks one number per card, an "ease" multiplier that the interval is
 * repeatedly multiplied by. That conflates two different things: how hard the
 * card is, and how well it is currently remembered. FSRS separates them into a
 * two-variable memory model, which is why it can space reviews to hit a chosen
 * retention rather than merely growing the interval by a fixed ratio.
 *
 *   Stability (S)  — days until recall probability falls to 90%.
 *   Difficulty (D) — 1..10, how much harder this card is than average.
 *
 * Everything here is pure arithmetic over those two numbers. No I/O, no clock,
 * no randomness: the same card and grade always produce the same result, which
 * is what makes a long simulated review history testable.
 */

/**
 * Default FSRS-5 weights, fitted by the FSRS project against a large public
 * review dataset. They are the published defaults for a user whose own history
 * has not been used to optimise a personal set, which is every user here —
 * per-user optimisation needs far more review logs than a single student
 * generates, and a badly fitted personal set schedules worse than the default.
 */
export const DEFAULT_WEIGHTS: readonly number[] = [
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925,
  1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621,
];

/**
 * The forgetting curve is a power function, not an exponential one: real
 * forgetting has a long tail, and an exponential curve underestimates how much
 * survives after a long gap. DECAY sets that tail's shape and FACTOR is fixed
 * by it, so that a card reviewed exactly at its stability sits at 90% recall.
 */
const DECAY = -0.5;
const FACTOR = Math.pow(0.9, 1 / DECAY) - 1;

/** Stability below a few minutes is meaningless; above a century is noise. */
const MIN_STABILITY = 0.01;
const MAX_STABILITY = 36500;

export type FsrsRating = 1 | 2 | 3 | 4;

export interface MemoryState {
  stability: number;
  difficulty: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

const clampStability = (s: number) =>
  Number.isFinite(s) ? clamp(s, MIN_STABILITY, MAX_STABILITY) : MIN_STABILITY;

/**
 * Probability of recalling a card `elapsedDays` after its last review.
 *
 * A card reviewed early is still well remembered, and FSRS uses that: the less
 * you had forgotten, the less a successful review teaches you, so the smaller
 * the stability gain. This is the term that makes cramming stop working.
 */
export function retrievability(elapsedDays: number, stability: number): number {
  const t = Math.max(0, elapsedDays);
  const s = clampStability(stability);
  return Math.pow(1 + (FACTOR * t) / s, DECAY);
}

/**
 * Days to wait so that recall probability lands on `desiredRetention`.
 *
 * At the default 0.9 this returns the stability itself, which is what makes
 * stability directly readable as "the current interval this card has earned".
 */
export function intervalForRetention(stability: number, desiredRetention = 0.9): number {
  const s = clampStability(stability);
  const r = clamp(desiredRetention, 0.7, 0.99);
  return (s / FACTOR) * (Math.pow(r, 1 / DECAY) - 1);
}

/** Opening stability, read straight off the first grade the card is given. */
export function initialStability(rating: FsrsRating, w = DEFAULT_WEIGHTS): number {
  return clampStability(w[rating - 1]!);
}

/** Opening difficulty. Again starts a card near 10, Easy near the low end. */
export function initialDifficulty(rating: FsrsRating, w = DEFAULT_WEIGHTS): number {
  return clamp(w[4]! - Math.exp(w[5]! * (rating - 1)) + 1, 1, 10);
}

/**
 * Difficulty after a grade.
 *
 * Two things happen. The grade pushes difficulty up or down, damped by how far
 * it already is from the ends of the scale so it cannot run away. Then it is
 * pulled slightly back toward the difficulty of an easy first review — mean
 * reversion, which stops a run of bad days from marking a card permanently
 * impossible.
 */
export function nextDifficulty(
  difficulty: number,
  rating: FsrsRating,
  w = DEFAULT_WEIGHTS,
): number {
  const delta = -w[6]! * (rating - 3);
  const damped = difficulty + delta * ((10 - difficulty) / 9);
  return clamp(w[7]! * initialDifficulty(4, w) + (1 - w[7]!) * damped, 1, 10);
}

/**
 * Stability after a successful review.
 *
 * The gain shrinks as stability grows (a card you already know for a year
 * gains less), shrinks as difficulty grows, and grows the more you had
 * forgotten. Hard trims the gain, Easy widens it.
 */
export function nextRecallStability(
  state: MemoryState,
  r: number,
  rating: FsrsRating,
  w = DEFAULT_WEIGHTS,
): number {
  const hardPenalty = rating === 2 ? w[15]! : 1;
  const easyBonus = rating === 4 ? w[16]! : 1;
  const gain =
    Math.exp(w[8]!) *
    (11 - state.difficulty) *
    Math.pow(clampStability(state.stability), -w[9]!) *
    (Math.exp((1 - r) * w[10]!) - 1) *
    hardPenalty *
    easyBonus;
  return clampStability(state.stability * (1 + gain));
}

/**
 * Stability after a lapse.
 *
 * Forgetting does not reset a card to zero — some of what was built survives,
 * and how much depends on how strong it was. The result is capped below the
 * card's current stability, because failing a card must never be a way to make
 * it wait longer.
 */
export function nextForgetStability(
  state: MemoryState,
  r: number,
  w = DEFAULT_WEIGHTS,
): number {
  const s = clampStability(state.stability);
  const long =
    w[11]! *
    Math.pow(state.difficulty, -w[12]!) *
    (Math.pow(s + 1, w[13]!) - 1) *
    Math.exp((1 - r) * w[14]!);
  return clampStability(Math.min(long, s / Math.exp(w[17]! * w[18]!)));
}

/**
 * Stability after a review taken on the same day the card was last seen.
 *
 * Same-day repeats carry almost no new information about long-term memory, so
 * they move stability by a small fixed step instead of running the full recall
 * equation, which would otherwise reward drilling a card ten times in a row.
 */
export function nextShortTermStability(
  stability: number,
  rating: FsrsRating,
  w = DEFAULT_WEIGHTS,
): number {
  return clampStability(clampStability(stability) * Math.exp(w[17]! * (rating - 3 + w[18]!)));
}

/**
 * Advances a card's memory state by one grade.
 *
 * `prior` is null for a card that has never been reviewed, and `elapsedDays` is
 * the real gap since the last review — the gap is what FSRS learns from, so
 * reviewing a card late is treated differently from reviewing it on time.
 */
export function nextMemoryState(
  prior: MemoryState | null,
  rating: FsrsRating,
  elapsedDays: number,
  w = DEFAULT_WEIGHTS,
): MemoryState {
  if (!prior) {
    return {
      stability: initialStability(rating, w),
      difficulty: initialDifficulty(rating, w),
    };
  }

  const difficulty = nextDifficulty(prior.difficulty, rating, w);

  // Under a day the review says little about durable memory, so it gets the
  // short-term step whatever the grade.
  if (elapsedDays < 1) {
    return { stability: nextShortTermStability(prior.stability, rating, w), difficulty };
  }

  const r = retrievability(elapsedDays, prior.stability);
  const stability =
    rating === 1 ? nextForgetStability(prior, r, w) : nextRecallStability(prior, r, rating, w);
  return { stability, difficulty };
}
