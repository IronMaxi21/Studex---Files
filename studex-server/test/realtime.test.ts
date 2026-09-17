/**
 * Sync that arrives rather than sync that is fetched.
 *
 * The websocket is not what is worth testing — Supabase's client is not this
 * project's to verify, and a test that opened a real socket would be testing
 * a network. What is worth testing is everything the supervisor decides with
 * the notifications once they arrive: which accounts get watched at all, when
 * a burst of rows counts as one edit, how often that may cause a sync, what
 * happens to a project that keeps hanging up, and when the socket's hour-long
 * credential is replaced.
 *
 * Both of the outside pieces are handed in: a fake watcher through the seam in
 * `lib/realtime.ts`, and a token source as an argument, exactly as the sync
 * tests hand `pushLibrary` a fake store.
 */
import './realtime-env.js';
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closeApp, registerUser } from './helpers.js';
import { getDb } from '../src/lib/db.js';
import {
  resetLibraryWatcher,
  setLibraryWatcher,
  type LibraryWatcher,
  type WatchRequest,
} from '../src/lib/realtime.js';
import {
  MIN_GAP_MS,
  SETTLE_MS,
  TOKEN_MARGIN_MS,
  dueForSync,
  noteRealtimeChange,
  realtimeCandidates,
  realtimeSummary,
  reconcileWatchers,
  resetRealtimeState,
  retryDelay,
  runRealtimeTick,
  type TokenSource,
} from '../src/domain/realtime.js';

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60_000;

interface Socket {
  request: WatchRequest;
  tokens: string[];
  closed: boolean;
}

/** A watcher that records what it was asked for and hands back the levers. */
function fakeWatcher(): { watcher: LibraryWatcher; sockets: Socket[]; fail: (why: string | null) => void } {
  const sockets: Socket[] = [];
  let failure: string | null = null;
  return {
    sockets,
    fail: (why) => {
      failure = why;
    },
    watcher: {
      async watch(request) {
        if (failure) throw new Error(failure);
        const socket: Socket = { request, tokens: [request.accessToken], closed: false };
        sockets.push(socket);
        return {
          setToken: (token) => socket.tokens.push(token),
          close: async () => {
            socket.closed = true;
          },
        };
      },
    },
  };
}

/** A token source that never touches a network, and can be made to give up. */
function fakeTokens(expiresAt = NOW + HOUR): TokenSource & { calls: number; give: boolean } {
  const source = (async (userId: string) => {
    source.calls += 1;
    return source.give ? { accessToken: `token-for-${userId}-${source.calls}`, expiresAt } : null;
  }) as TokenSource & { calls: number; give: boolean };
  source.calls = 0;
  source.give = true;
  return source;
}

/** An account with a Supabase project behind it, which is what the loop looks for. */
async function linkedUser() {
  const client = await registerUser();
  const supabaseUserId = randomUUID();
  getDb()
    .prepare('UPDATE users SET supabase_user_id = ? WHERE id = ?')
    .run(supabaseUserId, client.userId);
  return { ...client, supabaseUserId };
}

/**
 * The socket belonging to one account.
 *
 * Every test file shares one database, so a reconcile opens a subscription for
 * every account any earlier test linked. Picking by identity rather than by
 * position is what keeps these assertions about the account under test.
 */
function socketFor(sockets: Socket[], supabaseUserId: string): Socket {
  const found = sockets.filter((s) => s.request.supabaseUserId === supabaseUserId).at(-1);
  assert.ok(found, 'no subscription was opened for this account');
  return found;
}

/** Registration writes the settings row, so this only ever updates one. */
function setAutoSyncMinutes(userId: string, minutes: number): void {
  getDb()
    .prepare('UPDATE user_settings SET auto_sync_minutes = ? WHERE user_id = ?')
    .run(minutes, userId);
}

describe('realtime sync', () => {
  beforeEach(() => {
    resetRealtimeState();
    resetLibraryWatcher();
  });

  after(async () => {
    resetRealtimeState();
    resetLibraryWatcher();
    await closeApp();
  });

  it('watches linked accounts and leaves local ones alone', async () => {
    const local = await registerUser();
    const linked = await linkedUser();

    const watched = realtimeCandidates().map((c) => c.userId);
    assert.ok(watched.includes(linked.userId));
    assert.ok(!watched.includes(local.userId));
  });

  it('respects the switch that turns automatic sync off', async () => {
    const client = await linkedUser();
    setAutoSyncMinutes(client.userId, 0);

    // Deliberately the same setting the timer uses: honouring "off" for the
    // interval while a socket carried on syncing would make it a lie.
    assert.ok(!realtimeCandidates().some((c) => c.userId === client.userId));
  });

  it('opens one subscription per account and reports it', async () => {
    const client = await linkedUser();
    const { watcher, sockets } = fakeWatcher();
    setLibraryWatcher(watcher);

    await reconcileWatchers(NOW, undefined, fakeTokens());
    assert.equal(socketFor(sockets, client.supabaseUserId).closed, false);
    assert.equal(realtimeSummary(client.userId).connected, true);

    // A second pass must not open a second socket for the same account.
    const before = sockets.length;
    await reconcileWatchers(NOW + 1_000, undefined, fakeTokens());
    assert.equal(sockets.length, before);
  });

  it('turns a burst of rows into one sync, once the burst has stopped', async () => {
    const client = await linkedUser();
    setLibraryWatcher(fakeWatcher().watcher);
    await reconcileWatchers(NOW, undefined, fakeTokens());

    noteRealtimeChange(client.userId, NOW);
    noteRealtimeChange(client.userId, NOW + 500);
    noteRealtimeChange(client.userId, NOW + 900);

    // Still arriving: syncing now would sync a half-written folder.
    assert.ok(!dueForSync(NOW + 1_000).includes(client.userId));
    assert.ok(dueForSync(NOW + SETTLE_MS + 1).includes(client.userId));
  });

  it('will not sync the same account twice in quick succession', async () => {
    const client = await linkedUser();
    setLibraryWatcher(fakeWatcher().watcher);
    await reconcileWatchers(NOW, undefined, fakeTokens());

    noteRealtimeChange(client.userId, NOW);
    const log = { warn: () => {} };
    // The sync itself has no project to reach in a test; what matters is that
    // the account was picked up and marked as attempted.
    await runRealtimeTick(NOW + SETTLE_MS + 1, log, fakeTokens());
    assert.ok(!dueForSync(NOW + SETTLE_MS + 2).includes(client.userId));

    // A change during the run is not swallowed by it — but it still waits for
    // the floor between two syncs.
    noteRealtimeChange(client.userId, NOW + SETTLE_MS + 2);
    assert.ok(!dueForSync(NOW + SETTLE_MS + 5_000).includes(client.userId));
    assert.ok(dueForSync(NOW + SETTLE_MS + MIN_GAP_MS + 1).includes(client.userId));
  });

  it('re-authorises a socket before its token lapses, and not before', async () => {
    const client = await linkedUser();
    const { watcher, sockets } = fakeWatcher();
    setLibraryWatcher(watcher);
    const tokens = fakeTokens(NOW + HOUR);

    await reconcileWatchers(NOW, undefined, tokens);
    const socket = socketFor(sockets, client.supabaseUserId);
    assert.equal(socket.tokens.length, 1);

    await reconcileWatchers(NOW + 10 * 60_000, undefined, tokens);
    assert.equal(socket.tokens.length, 1, 'nothing to do while the token is young');

    // Row-level security is evaluated against the token the socket presented,
    // so an expired one does not error — it silently stops delivering rows.
    await reconcileWatchers(NOW + HOUR - TOKEN_MARGIN_MS + 1, undefined, tokens);
    assert.equal(socket.tokens.length, 2);
    assert.notEqual(socket.tokens[1], socket.tokens[0]);
  });

  it('backs off a project that keeps refusing the subscription', async () => {
    const client = await linkedUser();
    const { watcher, fail } = fakeWatcher();
    setLibraryWatcher(watcher);
    fail('upstream said no');
    const log = { warn: () => {} };

    await reconcileWatchers(NOW, log, fakeTokens());
    assert.equal(realtimeSummary(client.userId).connected, false);

    // Immediately afterwards it must not try again; after the delay it may.
    await reconcileWatchers(NOW + 1, log, fakeTokens());
    fail(null);
    await reconcileWatchers(NOW + 100, log, fakeTokens());
    assert.equal(realtimeSummary(client.userId).connected, false, 'still inside the quiet period');

    await reconcileWatchers(NOW + retryDelay(2) + 1, log, fakeTokens());
    assert.equal(realtimeSummary(client.userId).connected, true);
  });

  it('grows the retry delay and then stops growing it', () => {
    assert.equal(retryDelay(0), 0);
    assert.ok(retryDelay(1) < retryDelay(2));
    assert.ok(retryDelay(2) < retryDelay(3));
    assert.equal(retryDelay(40), retryDelay(50));
  });

  it('does not watch an account whose Supabase session has gone', async () => {
    const client = await linkedUser();
    const { watcher, sockets } = fakeWatcher();
    setLibraryWatcher(watcher);
    const tokens = fakeTokens();
    tokens.give = false;

    const before = sockets.length;
    await reconcileWatchers(NOW, { warn: () => {} }, tokens);
    assert.equal(sockets.length, before, 'nothing to authorise with');
    assert.equal(tokens.calls > 0, true);
    assert.equal(realtimeSummary(client.userId).connected, false);
  });

  it('closes the socket when an account stops qualifying', async () => {
    const client = await linkedUser();
    const { watcher, sockets } = fakeWatcher();
    setLibraryWatcher(watcher);
    await reconcileWatchers(NOW, undefined, fakeTokens());
    const socket = socketFor(sockets, client.supabaseUserId);
    assert.equal(realtimeSummary(client.userId).connected, true);

    setAutoSyncMinutes(client.userId, 0);
    await reconcileWatchers(NOW + 1_000, undefined, fakeTokens());
    assert.equal(socket.closed, true);
    assert.equal(realtimeSummary(client.userId).connected, false);
  });

  it('reports itself on the sync status the app reads', async () => {
    const client = await linkedUser();
    const summary = realtimeSummary(client.userId);
    assert.equal(summary.enabled, true);
    assert.equal(summary.connected, false);
    assert.equal(summary.lastEventAt, null);
  });
});
