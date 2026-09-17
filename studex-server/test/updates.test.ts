// First, and before anything that reads config: the update code asks the
// environment what version it is, and config.ts reads that at module scope.
import './setup.js';
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import {
  appcastXml,
  check,
  compareVersions,
  feedSchema,
  newestOf,
  stateFor,
  type ReleaseSource,
} from '../src/domain/updates.js';
import { api, closeApp, registerUser, type Client } from './helpers.js';

/** A releases table that answers whatever the current test put in it. */
function table(rows: unknown[]): ReleaseSource {
  return { recent: async () => rows };
}

const row = (version: string, extra: Record<string, unknown> = {}) => ({
  version,
  url: 'https://example.com/Studex.zip',
  sha256: 'b'.repeat(64),
  notes: null,
  size: null,
  minimum_system_version: null,
  published_at: '2026-01-01T00:00:00Z',
  ...extra,
});

describe('which version is newer', () => {
  test('compares numbers as numbers, not as text', () => {
    // The classic: an updater that stops working at version 10, because "1.10"
    // sorts before "1.9" when they are strings.
    assert.ok(compareVersions('1.10.0', '1.9.0') > 0);
    assert.ok(compareVersions('2.0.0', '1.99.99') > 0);
    assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  });

  test('treats a missing part as a zero', () => {
    assert.equal(compareVersions('1.2', '1.2.0'), 0);
    assert.ok(compareVersions('1.2.1', '1.2') > 0);
  });

  test('puts a pre-release before the release it leads to', () => {
    assert.ok(compareVersions('1.3.0-beta.1', '1.3.0') < 0);
    assert.ok(compareVersions('1.3.0', '1.3.0-beta.1') > 0);
    assert.ok(compareVersions('1.3.0-beta.2', '1.3.0-beta.1') > 0);
  });
});

describe('the shape of a release', () => {
  test('refuses one with no checksum, or a checksum that is not one', () => {
    assert.equal(feedSchema.safeParse({ version: '1.1.0', url: 'https://e.com/a.zip' }).success, false);
    assert.equal(
      feedSchema.safeParse({ version: '1.1.0', url: 'https://e.com/a.zip', sha256: 'nope' }).success,
      false,
    );
  });

  test('accepts a well-formed release', () => {
    const parsed = feedSchema.safeParse({
      version: '1.1.0', url: 'https://e.com/a.zip', sha256: 'a'.repeat(64), notes: 'Fixed the thing',
    });
    assert.equal(parsed.success, true);
  });
});

describe('picking the newest row out of the table', () => {
  test('takes the highest version, not the row that came back first', () => {
    // published_at is a timestamp somebody typed. A release entered out of
    // order must not be able to offer every Mac a downgrade.
    const { latest } = newestOf([row('1.2.0'), row('1.10.0'), row('1.9.0')]);
    assert.equal(latest?.version, '1.10.0');
  });

  test('steps over a malformed row rather than letting it hide a good one', () => {
    const { latest, skipped } = newestOf([
      { version: '9.9.9' },                       // no url, no checksum
      row('2.0.0', { sha256: 'not a checksum' }), // a checksum that is not one
      { nonsense: true },
      row('1.5.0'),
    ]);
    assert.equal(latest?.version, '1.5.0');
    assert.equal(skipped, 3);
  });

  test('reads a size that came back as a string, and ignores one that is nonsense', () => {
    // PostgREST returns bigint as a string, which is the shape a size column
    // actually arrives in.
    assert.equal(newestOf([row('2.0.0', { size: '14680064' })]).latest?.size, 14_680_064);
    assert.equal(newestOf([row('2.0.0', { size: 'lots' })]).latest?.size, undefined);
    assert.equal(newestOf([row('2.0.0', { size: -5 })]).latest?.size, undefined);
  });

  test('answers with nothing when the table is empty', () => {
    assert.equal(newestOf([]).latest, null);
  });
});

describe('checking for updates', () => {
  test('offers a newer version', async () => {
    const result = await check(table([row('1.1.0', { notes: 'Faster' })]));
    assert.equal(result.available, true);
    assert.equal(result.latest?.version, '1.1.0');
    assert.equal(result.latest?.notes, 'Faster');
  });

  test('does not offer the version already running, nor an older one', async () => {
    assert.equal((await check(table([row('1.0.0')]))).available, false);
    assert.equal((await check(table([row('0.9.0')]))).available, false);
  });

  test('refuses a download that is not https, however good the row looked', async () => {
    await assert.rejects(
      check(table([row('9.9.9', { url: 'http://example.com/Studex.zip' })])),
      /must be https/,
    );
  });

  test('says there is nowhere to look when no project is configured', async () => {
    await assert.rejects(check(null), (err: { statusCode?: number; code?: string }) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, 'no_update_source');
      return true;
    });
  });

  test('reports a project that will not answer rather than failing obscurely', async () => {
    let tries = 0;
    const broken: ReleaseSource = {
      recent: async () => { tries += 1; throw new Error('connection reset'); },
    };
    await assert.rejects(check(broken));
    // Reading a list is idempotent, so it is worth another go or two.
    assert.ok(tries > 1, `tried ${tries} times`);
  });

  test('says what is running', () => {
    const state = stateFor();
    assert.equal(state.version, '1.0.0');
    assert.equal(state.canInstall, true);
    // No Supabase project in a test run, so there is nowhere to look.
    assert.equal(state.online, false);
  });
});

describe('channels, history and system requirements', () => {
  test('keeps a beta from a stable install, and offers it to a beta one', async () => {
    const rows = [row('1.2.0-beta.1', { channel: 'beta' }), row('1.1.0')];
    const stable = await check(table(rows), { system: '14.0' });
    assert.equal(stable.latest?.version, '1.1.0');
    assert.equal(stable.releases.length, 1);
    const beta = await check(table(rows), { channel: 'beta', system: '14.0' });
    assert.equal(beta.latest?.version, '1.2.0-beta.1');
    assert.equal(beta.channel, 'beta');
  });

  test('lists every version skipped since this one, and flags a critical one', async () => {
    const result = await check(table([
      row('1.3.0'), row('1.2.0', { critical: true }), row('1.1.0'), row('0.9.0'),
    ]), { system: null });
    assert.deepEqual(result.missed.map((r) => r.version), ['1.3.0', '1.2.0', '1.1.0']);
    assert.equal(result.critical, true);
    assert.equal(result.releases.length, 4);
  });

  test('does not offer a release this macOS cannot run, and says why', async () => {
    const result = await check(table([
      row('2.0.0', { minimum_system_version: '15.0' }), row('1.1.0'),
    ]), { system: '13.6' });
    assert.equal(result.latest?.version, '1.1.0');
    assert.equal(result.blocked?.version, '2.0.0');
  });

  test('carries the signature and the disk image through', async () => {
    const signature = `${'A'.repeat(86)}==`;
    const { latest } = await check(table([row('1.1.0', {
      signature, dmg_url: 'https://example.com/Studex.dmg', dmg_sha256: 'c'.repeat(64), dmg_size: '1024',
    })]), { system: null });
    assert.equal(latest?.signature, signature);
    assert.equal(latest?.dmgSize, 1024);
  });

  test('renders a Sparkle appcast, escaping what needs it', () => {
    const { latest } = newestOf([row('1.1.0', { notes: 'Fixes <b> & ]]> things', critical: true })]);
    assert.ok(latest);
    const out = appcastXml([latest], { link: 'https://studex.app' });
    assert.match(out, /xmlns:sparkle=/);
    assert.match(out, /<sparkle:version>1\.1\.0<\/sparkle:version>/);
    assert.match(out, /<sparkle:criticalUpdate>/);
    assert.match(out, /url="https:\/\/example\.com\/Studex\.zip"/);
    assert.ok(!out.includes('things]]>]]>'), 'a CDATA terminator in the notes is split');
  });
});

describe('the updates endpoints', () => {
  let client: Client;
  after(async () => { await closeApp(); });

  test('reports what is running to a signed-in user', async () => {
    client = await registerUser('Updater');
    const res = await api(client, { method: 'GET', url: '/api/updates' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().update.version, '1.0.0');
    assert.equal(res.json().update.canInstall, true);
    assert.equal(res.json().update.online, false);
  });

  test('has nothing to check when the build is not connected to a project', async () => {
    const res = await api(client, { method: 'POST', url: '/api/updates/check' });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, 'no_update_source');
  });

  test('turns away a request carrying no session', async () => {
    const res = await api({ ...client, token: 'not-a-session' }, { method: 'GET', url: '/api/updates' });
    assert.equal(res.statusCode, 401);
  });
});
