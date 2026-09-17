import './setup.js';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { closeApp, registerUser } from './helpers.js';
import { createFile, restoreFile, trashFile } from '../src/domain/library.js';
import { countLive } from '../src/domain/plan.js';
import { exclusively, remoteRowSchema } from '../src/domain/sync.js';
import { compareVersions, feedSchema } from '../src/domain/updates.js';

after(async () => {
  await closeApp();
});

/* ── the trash is not a way round the cap ─────────────────────────────── */

describe('a plan limit that the trash could be used to walk around', () => {
  it('refuses to restore a file that would put the account over its cap', async () => {
    const { userId } = await registerUser();
    // Free keeps three canvases. Fill up, then empty the shelf into the bin
    // and fill it again — every one of these is allowed on its own.
    const first = [0, 1, 2].map((n) => createFile(userId, { title: `Canvas ${n}`, kind: 'canvas' }));
    for (const canvas of first) trashFile(userId, canvas.id);
    for (const n of [3, 4, 5]) createFile(userId, { title: `Canvas ${n}`, kind: 'canvas' });

    assert.equal(countLive(userId, 'canvas'), 3, 'at the cap, with three more in the bin');

    // Restoring is where it would come apart: nothing on this path ever asked
    // the plan, so the account would end up holding six.
    assert.throws(
      () => restoreFile(userId, first[0]!.id),
      (err: { statusCode?: number; message?: string }) => {
        assert.equal(err.statusCode, 402);
        assert.match(err.message ?? '', /no room to restore/);
        return true;
      },
    );
    assert.equal(countLive(userId, 'canvas'), 3, 'and nothing came back');
  });

  it('lets the restore through once there is room for it', async () => {
    const { userId } = await registerUser();
    const canvas = createFile(userId, { title: 'Only one', kind: 'canvas' });
    trashFile(userId, canvas.id);
    const back = restoreFile(userId, canvas.id);
    assert.equal(back.trashed_at, null);
    assert.equal(countLive(userId, 'canvas'), 1);
  });

  it('does not stand in the way of kinds that have no cap', async () => {
    const { userId } = await registerUser();
    const docs = [0, 1, 2, 3, 4, 5].map((n) => createFile(userId, { title: `Note ${n}`, kind: 'doc' }));
    for (const doc of docs) trashFile(userId, doc.id);
    for (const doc of docs) restoreFile(userId, doc.id);
    assert.equal(countLive(userId, 'doc'), 6);
  });
});

/* ── two syncs at once ────────────────────────────────────────────────── */

describe('two syncs running at once', () => {
  it('refuses the second rather than letting both replay the same refresh token', async () => {
    const { userId } = await registerUser();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    let ran = 0;

    const first = exclusively(userId, async () => { ran += 1; await held; return 'first'; });
    // Long enough for the first to be inside the gate and awaiting.
    await new Promise((resolve) => setTimeout(resolve, 10));

    await assert.rejects(
      exclusively(userId, async () => { ran += 1; return 'second'; }),
      (err: { statusCode?: number; code?: string }) => {
        assert.equal(err.statusCode, 409);
        assert.equal(err.code, 'sync_in_progress');
        return true;
      },
    );

    release();
    assert.equal(await first, 'first');
    assert.equal(ran, 1, 'the second never started');
  });

  it('lets the next one through once the first has finished', async () => {
    const { userId } = await registerUser();
    assert.equal(await exclusively(userId, async () => 'one'), 'one');
    assert.equal(await exclusively(userId, async () => 'two'), 'two');
  });

  it('releases the gate when a sync fails, so a failure is not a lockout', async () => {
    const { userId } = await registerUser();
    await assert.rejects(exclusively(userId, async () => { throw new Error('upstream fell over'); }));
    assert.equal(await exclusively(userId, async () => 'recovered'), 'recovered');
  });

  it('holds one account at a time, not one machine at a time', async () => {
    const a = await registerUser();
    const b = await registerUser();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });

    const first = exclusively(a.userId, async () => { await held; return 'a'; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(await exclusively(b.userId, async () => 'b'), 'b');
    release();
    assert.equal(await first, 'a');
  });
});

/* ── input nobody would type on purpose ───────────────────────────────── */

describe('an update feed written by someone unhelpful', () => {
  const cases: Array<[string, unknown]> = [
    ['null', null],
    ['a string', 'nope'],
    ['a number', 42],
    ['an array', [{ version: '2.0.0' }]],
    ['nothing at all', {}],
    ['an empty version', { version: '', url: 'https://e.com/a.zip', sha256: 'a'.repeat(64) }],
    ['a version that is words', { version: 'latest', url: 'https://e.com/a.zip', sha256: 'a'.repeat(64) }],
    ['a url that is not one', { version: '2.0.0', url: 'not a url', sha256: 'a'.repeat(64) }],
    ['a checksum in capitals', { version: '2.0.0', url: 'https://e.com/a.zip', sha256: 'A'.repeat(64) }],
    ['a checksum one character short', { version: '2.0.0', url: 'https://e.com/a.zip', sha256: 'a'.repeat(63) }],
    ['notes the length of a book', { version: '2.0.0', url: 'https://e.com/a.zip', sha256: 'a'.repeat(64), notes: 'x'.repeat(9000) }],
    ['a size that is negative', { version: '2.0.0', url: 'https://e.com/a.zip', sha256: 'a'.repeat(64), size: -1 }],
    ['a size that is not a number', { version: '2.0.0', url: 'https://e.com/a.zip', sha256: 'a'.repeat(64), size: '10' }],
  ];

  for (const [name, value] of cases) {
    it(`refuses ${name}`, () => {
      assert.equal(feedSchema.safeParse(value).success, false);
    });
  }

  it('survives a version number nobody should write', () => {
    // Not valid input — but comparison runs on whatever got through, and it
    // has to answer rather than throw.
    for (const version of ['', '.', '...', '1..2', '99999999999999999999.0.0', '-1', 'a.b.c']) {
      assert.equal(typeof compareVersions(version, '1.0.0'), 'number');
      assert.equal(typeof compareVersions('1.0.0', version), 'number');
    }
  });

  it('never reports two versions as both newer than each other', () => {
    const versions = ['0.0.1', '1.0.0', '1.0.1', '1.1.0', '1.10.0', '2.0.0', '1.0.0-beta.1', '10.0.0'];
    for (const a of versions) {
      for (const b of versions) {
        const forwards = Math.sign(compareVersions(a, b));
        const backwards = Math.sign(compareVersions(b, a));
        assert.equal(forwards + backwards, 0, `${a} vs ${b} disagree depending on the order`);
      }
    }
  });
});

/* ── what comes back from the cloud ───────────────────────────────────── */

describe('a library_items row written by something other than this app', () => {
  /**
   * The table is writable by anything holding the account's token — another
   * device, an older build, a curl command. Pull used to cast each row's
   * fields and hand them to createFile, so the rules every HTTP request is
   * held to stopped applying the moment data came back the other way.
   */
  const good = {
    id: '11111111-1111-4111-8111-111111111111',
    user_id: '22222222-2222-4222-8222-222222222222',
    parent_id: null,
    kind: 'doc',
    name: 'Kinetics',
    storage_path: 'uid/item',
    mime: 'application/json',
    byte_size: 12,
    trashed_at: null,
    content_hash: 'a'.repeat(64),
  };

  const rejects = (patch: Record<string, unknown>, why: string) =>
    it(`refuses ${why}`, () => {
      assert.equal(remoteRowSchema.safeParse({ ...good, ...patch }).success, false);
    });

  it('accepts a row this app would have written', () => {
    assert.equal(remoteRowSchema.safeParse(good).success, true);
  });

  rejects({ name: '' }, 'a name of nothing');
  rejects({ name: 'x'.repeat(201) }, 'a name past the length a title may be');
  rejects({ name: 'x'.repeat(5_000_000) }, 'a name of five megabytes');
  rejects({ name: null }, 'a name that is null');
  rejects({ name: 42 }, 'a name that is a number');
  rejects({ name: { nested: true } }, 'a name that is an object');
  rejects({ kind: 'executable' }, 'a kind this app has never had');
  rejects({ id: 'not-a-uuid' }, 'an id that is not one');
  rejects({ byte_size: -1 }, 'a negative size');
  rejects({ byte_size: 'lots' }, 'a size that is a word');
  rejects({ content_hash: 'zz' }, 'a content hash that is not a sha256');
  rejects({ storage_path: 'p'.repeat(2000) }, 'a storage path longer than any path');

  it('lets the optional fields be absent or null, which is how this app writes folders', () => {
    const folder = { ...good, kind: 'folder', storage_path: null, mime: null, byte_size: null, content_hash: null };
    assert.equal(remoteRowSchema.safeParse(folder).success, true);
  });
});
