import './setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isTransient, withRetry } from '../src/lib/retry.js';
import { ApiError } from '../src/lib/errors.js';

/** Records what the backoff asked to wait for, and waits for none of it. */
function recorder() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => { waits.push(ms); } };
}

describe('what is worth trying again', () => {
  it('counts the failures that mean "not now"', () => {
    assert.equal(isTransient(new ApiError(503, 'x', 'unavailable')), true);
    assert.equal(isTransient(new ApiError(429, 'x', 'slow down')), true);
    assert.equal(isTransient(new ApiError(408, 'x', 'timeout')), true);
    assert.equal(isTransient({ name: 'AbortError' }), true);
    assert.equal(isTransient(new Error('fetch failed')), true);
    assert.equal(isTransient(new Error('ECONNRESET while reading')), true);
  });

  it('does not count the failures that will say the same thing next time', () => {
    assert.equal(isTransient(new ApiError(400, 'x', 'malformed')), false);
    assert.equal(isTransient(new ApiError(403, 'x', 'permission denied')), false);
    assert.equal(isTransient(new ApiError(404, 'x', 'no such feed')), false);
    assert.equal(isTransient(new ApiError(422, 'x', 'unprocessable')), false);
    assert.equal(isTransient(new Error('row violates row-level security policy')), false);
  });
});

describe('trying again', () => {
  it('returns the first success without waiting at all', async () => {
    const { waits, sleep } = recorder();
    let calls = 0;
    const result = await withRetry(async () => { calls += 1; return 'fine'; }, { sleep });
    assert.equal(result, 'fine');
    assert.equal(calls, 1);
    assert.deepEqual(waits, []);
  });

  it('rides out a wobble and returns the eventual success', async () => {
    const { waits, sleep } = recorder();
    let calls = 0;
    const result = await withRetry(async () => {
      calls += 1;
      if (calls < 3) throw new ApiError(503, 'x', 'unavailable');
      return 'landed';
    }, { sleep, attempts: 3, baseMs: 100 });
    assert.equal(result, 'landed');
    assert.equal(calls, 3);
    assert.equal(waits.length, 2, 'one wait between each pair of attempts');
  });

  it('gives up after the last attempt and throws what actually failed', async () => {
    const { sleep } = recorder();
    let calls = 0;
    await assert.rejects(
      withRetry(async () => { calls += 1; throw new ApiError(503, 'x', 'still unavailable'); },
        { sleep, attempts: 4, baseMs: 10 }),
      /still unavailable/,
    );
    assert.equal(calls, 4, 'attempts counts the first try, not extra tries after it');
  });

  it('does not retry something that will fail identically', async () => {
    const { waits, sleep } = recorder();
    let calls = 0;
    await assert.rejects(
      withRetry(async () => { calls += 1; throw new ApiError(403, 'x', 'permission denied'); },
        { sleep, attempts: 5 }),
      /permission denied/,
    );
    assert.equal(calls, 1, 'a refusal is answered once');
    assert.deepEqual(waits, []);
  });

  it('grows the window it draws each wait from, and caps it', async () => {
    const { waits, sleep } = recorder();
    await assert.rejects(withRetry(async () => { throw new ApiError(503, 'x', 'no'); },
      { sleep, attempts: 6, baseMs: 100, maxMs: 400 }));

    // Full jitter: each wait is somewhere in [0, ceiling], and the ceiling
    // doubles until it hits the cap. Asserting the ceiling rather than the
    // value is the only stable thing to assert about a jittered backoff.
    const ceilings = [100, 200, 400, 400, 400];
    assert.equal(waits.length, ceilings.length);
    waits.forEach((wait, i) => {
      assert.ok(wait >= 0, `wait ${i} is not negative`);
      assert.ok(wait <= ceilings[i]!, `wait ${i} (${wait}ms) is within its ${ceilings[i]}ms window`);
    });
  });

  it('spreads its waits out rather than firing them all together', async () => {
    // Without jitter every client that failed during one outage comes back at
    // the same instant. Over many runs the waits must not all be identical.
    const seen = new Set<number>();
    for (let run = 0; run < 40; run += 1) {
      const { waits, sleep } = recorder();
      await assert.rejects(withRetry(async () => { throw new ApiError(503, 'x', 'no'); },
        { sleep, attempts: 2, baseMs: 1_000 }));
      seen.add(waits[0]!);
    }
    assert.ok(seen.size > 5, `40 runs produced ${seen.size} distinct waits`);
  });
});
