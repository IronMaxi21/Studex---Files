/**
 * Sync on a timer.
 *
 * What is worth testing here is the decision-making, not the transfer: which
 * accounts the loop picks up, when it decides each one is due, and what it
 * does with one that keeps failing. The transfer itself is covered by the
 * sync and pull tests, which drive it through a fake remote.
 */
import './setup.js';
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { api, closeApp, registerUser } from './helpers.js';
import { getDb } from '../src/lib/db.js';
import {
  AUTO_SYNC_CHOICES,
  DEFAULT_AUTO_SYNC_MINUTES,
  autoSyncCandidates,
  autoSyncDue,
  autoSyncSummary,
  backoffDelay,
  clearAutoSyncBackoff,
  isAutoSyncChoice,
  nextAutoSyncAt,
  noteAutoSyncFailure,
  resetAutoSyncState,
} from '../src/domain/autosync.js';

const MINUTE = 60_000;
const NOW = 1_800_000_000_000;

/** An account with a Supabase project behind it, which is what the loop looks for. */
async function linkedUser() {
  const client = await registerUser();
  getDb()
    .prepare('UPDATE users SET supabase_user_id = ? WHERE id = ?')
    .run(randomUUID(), client.userId);
  return client;
}

function setInterval_(userId: string, minutes: number): void {
  getDb()
    .prepare('UPDATE user_settings SET auto_sync_minutes = ? WHERE user_id = ?')
    .run(minutes, userId);
}

/** Pretends a sync finished at the given moment. */
function recordFinish(userId: string, at: number): void {
  getDb()
    .prepare(
      `INSERT INTO sync_runs (user_id, started_at, finished_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET finished_at = excluded.finished_at`,
    )
    .run(userId, at, at);
}

function candidateFor(userId: string) {
  return autoSyncCandidates().find((c) => c.userId === userId) ?? null;
}

after(async () => {
  resetAutoSyncState();
  await closeApp();
});

describe('automatic sync: which accounts the loop picks up', () => {
  beforeEach(() => resetAutoSyncState());

  it('leaves out an account with no project to sync with', async () => {
    const local = await registerUser();
    assert.equal(candidateFor(local.userId), null, 'a local-only account has nowhere to sync to');
  });

  it('includes a linked account at the default interval without being configured', async () => {
    const user = await linkedUser();
    const candidate = candidateFor(user.userId);
    assert.ok(candidate, 'a linked account is a candidate as soon as it is linked');
    assert.equal(candidate.minutes, DEFAULT_AUTO_SYNC_MINUTES);
  });

  it('leaves out an account that has switched it off', async () => {
    const user = await linkedUser();
    setInterval_(user.userId, 0);
    assert.equal(candidateFor(user.userId), null);
  });

  it('syncs a linked account that has never synced straight away', async () => {
    const user = await linkedUser();
    const candidate = candidateFor(user.userId)!;
    assert.equal(candidate.lastFinishedAt, null);
    assert.ok(autoSyncDue(candidate, NOW), 'a second Mac fills itself in without being asked');
  });

  it('waits the chosen interval after a sync that finished', async () => {
    const user = await linkedUser();
    setInterval_(user.userId, 15);
    recordFinish(user.userId, NOW);

    const candidate = candidateFor(user.userId)!;
    assert.equal(autoSyncDue(candidate, NOW + 14 * MINUTE), false);
    assert.equal(autoSyncDue(candidate, NOW + 15 * MINUTE), true);
  });

  it('honours a shorter interval sooner than a longer one', async () => {
    const brisk = await linkedUser();
    const patient = await linkedUser();
    setInterval_(brisk.userId, 5);
    setInterval_(patient.userId, 360);
    recordFinish(brisk.userId, NOW);
    recordFinish(patient.userId, NOW);

    const at = NOW + 10 * MINUTE;
    assert.equal(autoSyncDue(candidateFor(brisk.userId)!, at), true);
    assert.equal(autoSyncDue(candidateFor(patient.userId)!, at), false);
  });
});

describe('automatic sync: backing off a broken account', () => {
  beforeEach(() => resetAutoSyncState());

  it('grows the wait with each consecutive failure and then stops growing', () => {
    assert.equal(backoffDelay(0), 0, 'a working account waits for nothing');
    assert.ok(backoffDelay(2) > backoffDelay(1));
    assert.ok(backoffDelay(3) > backoffDelay(2));
    assert.equal(backoffDelay(50), backoffDelay(20), 'the wait is capped');
    assert.ok(backoffDelay(50) <= 60 * MINUTE, 'and capped at something under an hour');
  });

  it('holds a failing account off past its interval', async () => {
    const user = await linkedUser();
    setInterval_(user.userId, 5);
    recordFinish(user.userId, NOW);

    noteAutoSyncFailure(user.userId, NOW);
    noteAutoSyncFailure(user.userId, NOW);
    noteAutoSyncFailure(user.userId, NOW);

    const candidate = candidateFor(user.userId)!;
    assert.equal(
      autoSyncDue(candidate, NOW + 5 * MINUTE),
      false,
      'the interval alone would have said yes',
    );
    assert.ok(nextAutoSyncAt(candidate)! > NOW + 5 * MINUTE);
  });

  it('lets a backed-off account through once the wait has passed', async () => {
    const user = await linkedUser();
    setInterval_(user.userId, 5);
    recordFinish(user.userId, NOW);
    noteAutoSyncFailure(user.userId, NOW);

    const candidate = candidateFor(user.userId)!;
    assert.equal(autoSyncDue(candidate, nextAutoSyncAt(candidate)!), true);
  });

  it('forgets the backoff as soon as something works', async () => {
    const user = await linkedUser();
    setInterval_(user.userId, 5);
    recordFinish(user.userId, NOW);
    for (let i = 0; i < 6; i += 1) noteAutoSyncFailure(user.userId, NOW);
    assert.equal(autoSyncDue(candidateFor(user.userId)!, NOW + 30 * MINUTE), false);

    clearAutoSyncBackoff(user.userId);
    assert.equal(
      autoSyncDue(candidateFor(user.userId)!, NOW + 5 * MINUTE),
      true,
      'one success proves whatever was broken is not broken any more',
    );
  });

  it('never schedules an account that is switched off, however it failed', async () => {
    const user = await linkedUser();
    noteAutoSyncFailure(user.userId, NOW);
    setInterval_(user.userId, 0);
    assert.equal(autoSyncSummary(user.userId).nextRunAt, null);
  });
});

describe('automatic sync: choosing the interval', () => {
  beforeEach(() => resetAutoSyncState());

  it('accepts every interval it offers', () => {
    for (const minutes of AUTO_SYNC_CHOICES) assert.equal(isAutoSyncChoice(minutes), true);
  });

  it('stores a chosen interval and reports it back', async () => {
    const user = await linkedUser();
    const res = await api(user, {
      method: 'PATCH',
      url: '/api/settings',
      payload: { autoSyncMinutes: 60 },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().settings.auto_sync_minutes, 60);
    assert.equal(autoSyncSummary(user.userId).minutes, 60);
  });

  it('refuses an interval it does not offer', async () => {
    const user = await linkedUser();
    const res = await api(user, {
      method: 'PATCH',
      url: '/api/settings',
      payload: { autoSyncMinutes: 1 },
    });
    assert.equal(res.statusCode, 422, 'a client cannot ask for a sync every minute');
  });

  it('reports the schedule alongside the last run', async () => {
    const user = await linkedUser();
    await api(user, { method: 'PATCH', url: '/api/settings', payload: { autoSyncMinutes: 15 } });

    const res = await api(user, { method: 'GET', url: '/api/sync/status' });
    assert.equal(res.statusCode, 200);
    const auto = res.json().auto;
    assert.equal(auto.minutes, 15);
    assert.equal(typeof auto.nextRunAt, 'number', 'a linked account has a next run');
  });

  it('keeps the preference for an account with nowhere to sync, and schedules nothing', async () => {
    const local = await registerUser();
    await api(local, { method: 'PATCH', url: '/api/settings', payload: { autoSyncMinutes: 60 } });

    const auto = (await api(local, { method: 'GET', url: '/api/sync/status' })).json().auto;
    assert.equal(auto.minutes, 60, 'the choice is remembered against the day it is linked');
    assert.equal(auto.nextRunAt, null, 'but nothing is scheduled');
  });
});
