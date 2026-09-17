import './setup.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scheduleCard, type CardState } from '../src/domain/flashcards.js';
import {
  initialDifficulty,
  initialStability,
  intervalForRetention,
  nextDifficulty,
  nextForgetStability,
  nextMemoryState,
  nextRecallStability,
  retrievability,
} from '../src/domain/fsrs.js';

const NOW = 1_700_000_000_000;
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

const card = (over: Partial<Parameters<typeof scheduleCard>[0]> = {}) => ({
  state: 'new' as CardState,
  ease_factor: 2.5,
  stability: null as number | null,
  difficulty: null as number | null,
  interval_days: 0,
  repetitions: 0,
  lapses: 0,
  last_reviewed_at: null as number | null,
  ...over,
});

/** A card that has been in the review pool for a while, last seen `ago` days back. */
const reviewing = (stability: number, difficulty: number, ago: number) =>
  card({
    state: 'review',
    stability,
    difficulty,
    interval_days: stability,
    repetitions: 5,
    last_reviewed_at: NOW - ago * DAY,
  });

describe('FSRS memory model', () => {
  it('puts recall at 90% exactly one stability after the review', () => {
    assert.equal(Number(retrievability(10, 10).toFixed(6)), 0.9);
    assert.equal(Number(retrievability(200, 200).toFixed(6)), 0.9);
  });

  it('decays recall as the gap grows and holds it at 1 on the day', () => {
    assert.equal(retrievability(0, 10), 1);
    assert.ok(retrievability(5, 10) > retrievability(20, 10));
    assert.ok(retrievability(400, 10) > 0, 'the power curve keeps a long tail');
  });

  it('asks for the stability itself at the default 90% retention', () => {
    assert.equal(Number(intervalForRetention(37, 0.9).toFixed(6)), 37);
  });

  it('shortens the interval when more retention is demanded', () => {
    assert.ok(intervalForRetention(30, 0.97) < intervalForRetention(30, 0.9));
    assert.ok(intervalForRetention(30, 0.8) > intervalForRetention(30, 0.9));
  });

  it('opens a card harder on Again than on Easy', () => {
    assert.ok(initialStability(1) < initialStability(3));
    assert.ok(initialStability(3) < initialStability(4));
    assert.ok(initialDifficulty(1) > initialDifficulty(4));
  });

  it('moves difficulty toward easy on Easy and toward hard on Again', () => {
    assert.ok(nextDifficulty(5, 4) < 5);
    assert.ok(nextDifficulty(5, 1) > 5);
    assert.ok(nextDifficulty(5, 3) > 4 && nextDifficulty(5, 3) < 6, 'Good barely moves it');
  });

  it('keeps difficulty inside 1..10 however it is graded', () => {
    let hard = 5;
    for (let i = 0; i < 40; i++) hard = nextDifficulty(hard, 1);
    assert.ok(hard <= 10 && hard >= 1);

    let easy = 5;
    for (let i = 0; i < 40; i++) easy = nextDifficulty(easy, 4);
    assert.ok(easy >= 1 && easy <= 10);
  });

  it('gains less stability from a review taken early than one taken on time', () => {
    const state = { stability: 30, difficulty: 5 };
    const early = nextRecallStability(state, retrievability(3, 30), 3);
    const onTime = nextRecallStability(state, retrievability(30, 30), 3);
    assert.ok(early < onTime, 'cramming a well-remembered card teaches little');
  });

  it('gains less stability on a hard card than an easy one', () => {
    const r = retrievability(10, 10);
    const easyCard = nextRecallStability({ stability: 10, difficulty: 2 }, r, 3);
    const hardCard = nextRecallStability({ stability: 10, difficulty: 9 }, r, 3);
    assert.ok(hardCard < easyCard);
  });

  it('ranks Hard below Good below Easy for the same review', () => {
    const state = { stability: 10, difficulty: 5 };
    const r = retrievability(10, 10);
    assert.ok(nextRecallStability(state, r, 2) < nextRecallStability(state, r, 3));
    assert.ok(nextRecallStability(state, r, 3) < nextRecallStability(state, r, 4));
  });

  it('never lets a lapse raise stability, but keeps some of what was built', () => {
    const strong = { stability: 100, difficulty: 5 };
    const after = nextForgetStability(strong, retrievability(100, 100));
    assert.ok(after < strong.stability, 'failing a card can never extend it');
    assert.ok(after > 0);

    const weak = { stability: 2, difficulty: 5 };
    assert.ok(
      nextForgetStability(strong, retrievability(100, 100)) >
        nextForgetStability(weak, retrievability(2, 2)),
      'a card that was strong recovers faster than one that was not',
    );
  });

  it('treats a same-day repeat as a small step, not a full review', () => {
    const prior = { stability: 10, difficulty: 5 };
    const sameDay = nextMemoryState(prior, 3, 0.2);
    const nextDay = nextMemoryState(prior, 3, 10);
    assert.ok(sameDay.stability < nextDay.stability, 'drilling a card does not inflate it');
  });

  it('is deterministic — no fuzz, no clock', () => {
    const a = nextMemoryState({ stability: 12, difficulty: 6 }, 3, 12);
    const b = nextMemoryState({ stability: 12, difficulty: 6 }, 3, 12);
    assert.deepEqual(a, b);
  });
});

describe('FSRS scheduler', () => {
  it('walks a new card through the learning steps on Good', () => {
    const first = scheduleCard(card(), 3, NOW);
    assert.equal(first.state, 'learning');
    assert.equal(first.due_at, NOW + 10 * MINUTE, 'advances to the second step');

    const second = scheduleCard(card({ state: 'learning', repetitions: 1 }), 3, NOW);
    assert.equal(second.state, 'review', 'graduates once the steps run out');
    assert.equal(second.due_at, NOW + second.interval_days * DAY);
  });

  it('sends a learning card back to the first step on Again', () => {
    const result = scheduleCard(card({ state: 'learning', repetitions: 1 }), 1, NOW);
    assert.equal(result.state, 'learning');
    assert.equal(result.repetitions, 0);
    assert.equal(result.due_at, NOW + 1 * MINUTE);
  });

  it('graduates straight out of learning on Easy, further than Good does', () => {
    const easy = scheduleCard(card(), 4, NOW);
    assert.equal(easy.state, 'review');
    const good = scheduleCard(card({ state: 'learning', repetitions: 1 }), 3, NOW);
    assert.ok(easy.interval_days > good.interval_days);
  });

  it('records memory state from the very first grade', () => {
    const first = scheduleCard(card(), 3, NOW);
    assert.equal(first.stability, initialStability(3));
    assert.equal(first.difficulty, initialDifficulty(3));
  });

  it('sets the interval from stability rather than from a multiplier', () => {
    const result = scheduleCard(reviewing(20, 5, 20), 3, NOW);
    assert.equal(
      Number(result.interval_days.toFixed(4)),
      Number(intervalForRetention(result.stability, 0.9).toFixed(4)),
    );
    assert.equal(result.due_at, NOW + result.interval_days * DAY);
  });

  it('grows the interval least on Hard and most on Easy', () => {
    const hard = scheduleCard(reviewing(20, 5, 20), 2, NOW);
    const good = scheduleCard(reviewing(20, 5, 20), 3, NOW);
    const easy = scheduleCard(reviewing(20, 5, 20), 4, NOW);
    assert.ok(hard.interval_days < good.interval_days);
    assert.ok(good.interval_days < easy.interval_days);
  });

  it('rewards a card answered after a long gap more than one answered early', () => {
    const early = scheduleCard(reviewing(20, 5, 2), 3, NOW);
    const late = scheduleCard(reviewing(20, 5, 40), 3, NOW);
    assert.ok(late.interval_days > early.interval_days);
  });

  it('lapses a review card into relearning without resetting what it had', () => {
    const result = scheduleCard(reviewing(30, 5, 30), 1, NOW);
    assert.equal(result.state, 'relearning');
    assert.equal(result.lapses, 1);
    assert.equal(result.due_at, NOW + 10 * MINUTE, 'due again in the relearning step');
    assert.ok(result.stability < 30, 'a lapse costs stability');
    assert.ok(result.stability > 0, 'but does not wipe it');
    assert.ok(result.difficulty > 5, 'and marks the card harder');
  });

  it('returns a relearning card to review on Good', () => {
    const result = scheduleCard(
      card({
        state: 'relearning',
        stability: 4,
        difficulty: 6,
        interval_days: 4,
        repetitions: 0,
        last_reviewed_at: NOW - DAY,
      }),
      3,
      NOW,
    );
    assert.equal(result.state, 'review');
    assert.ok(result.interval_days >= 1);
  });

  it('keeps the derived ease factor inside the range older clients expect', () => {
    let state = reviewing(5, 5, 5);
    for (let i = 0; i < 20; i++) {
      const next = scheduleCard(state, 1, NOW);
      state = { ...state, ...next, last_reviewed_at: NOW - DAY };
    }
    assert.ok(state.ease_factor >= 1.3, 'never falls below the floor');

    let easy = reviewing(5, 5, 5);
    for (let i = 0; i < 20; i++) {
      const next = scheduleCard(easy, 4, NOW);
      easy = { ...easy, ...next, last_reviewed_at: NOW - next.interval_days * DAY };
    }
    assert.ok(easy.ease_factor <= 3.0, 'never rises above the ceiling');
  });

  it('caps the interval so a card cannot be scheduled beyond five years', () => {
    const result = scheduleCard(reviewing(30000, 1, 30000), 4, NOW);
    assert.ok(result.interval_days <= 365 * 5);
  });

  it('never schedules a graduated card sooner than tomorrow', () => {
    const result = scheduleCard(reviewing(0.05, 10, 0.1), 2, NOW);
    assert.ok(result.interval_days >= 1);
  });

  it('brings a review card back sooner when a higher retention is demanded', () => {
    const c = reviewing(40, 5, 40);
    const at90 = scheduleCard(c, 3, NOW, 0.9);
    const at95 = scheduleCard(c, 3, NOW, 0.95);
    assert.ok(at95.interval_days < at90.interval_days, 'a higher target shortens the interval');
    // The memory state it lands on does not depend on the target — only the
    // interval the state is spaced to does.
    assert.equal(at95.stability, at90.stability);
    assert.equal(at95.difficulty, at90.difficulty);
  });

  it('produces a monotonically growing schedule over a run of Good grades', () => {
    let state = card();
    let clock = NOW;
    const intervals: number[] = [];
    for (let i = 0; i < 8; i++) {
      const next = scheduleCard(state, 3, clock);
      state = { ...state, ...next, last_reviewed_at: clock };
      // Each review is taken when it falls due, which is how the schedule is
      // meant to be walked — reviewing early deliberately grows it more slowly.
      clock = next.due_at;
      if (next.state === 'review') intervals.push(next.interval_days);
    }
    for (let i = 1; i < intervals.length; i++) {
      assert.ok(intervals[i]! > intervals[i - 1]!, 'each review interval exceeds the last');
    }
  });
});
