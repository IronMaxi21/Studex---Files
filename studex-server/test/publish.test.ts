// First, before anything reads config: publishing asks the environment which
// project it is writing to, and config.ts reads that at module scope.
import './setup.js';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import {
  approveRelease, digestOf, feedFilesFor, generateSigningKeys, keyPaths, loadPrivateKey, publishRelease,
  rejectRelease, signFile, statusOf, supabasePublisher, syncFeeds, verifySignature, type ReleasePublisher,
} from '../src/domain/publish.js';
import { ApiError } from '../src/lib/errors.js';
import type { Feed } from '../src/domain/updates.js';

/**
 * A releases table that remembers what was written to it, so a test can say
 * both what came back and what went in. Nothing here touches a network.
 */
function table(existing: unknown[] = []): ReleasePublisher & { written: Feed[]; marked: [string, string][] } {
  const written: Feed[] = [];
  const marked: [string, string][] = [];
  return {
    written,
    marked,
    recent: async () => existing,
    insert: async (release) => { written.push(release); },
    setStatus: async (version, status) => { marked.push([version, status]); },
  };
}

const row = (version: string, extra: Record<string, unknown> = {}) => ({
  version,
  url: `https://example.com/Studex-${version}.zip`,
  sha256: 'b'.repeat(64),
  notes: null,
  size: null,
  minimum_system_version: null,
  published_at: '2026-01-01T00:00:00Z',
  ...extra,
});

const release = (extra: Record<string, unknown> = {}) => ({
  version: '1.1.0',
  url: 'https://example.com/Studex-1.1.0.zip',
  sha256: 'a'.repeat(64),
  ...extra,
});

async function refusal(fn: () => Promise<unknown>): Promise<ApiError> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof ApiError, `expected an ApiError, got ${String(err)}`);
    return err;
  }
  assert.fail('expected a refusal');
}

describe('publishing a release', () => {
  test('writes the row when the version is newer than what is out', async () => {
    const releases = table([row('1.0.0')]);
    const { release: published, previous } = await publishRelease(release(), releases);

    assert.equal(published.version, '1.1.0');
    assert.equal(previous?.version, '1.0.0');
    assert.deepEqual(releases.written.map((r) => r.version), ['1.1.0']);
  });

  test('the first release in an empty project has no predecessor', async () => {
    const releases = table([]);
    const { previous } = await publishRelease(release(), releases);
    assert.equal(previous, null);
    assert.equal(releases.written.length, 1);
  });

  test('carries the optional fields through', async () => {
    const releases = table([]);
    await publishRelease(
      release({ notes: 'Undo on the canvas.', size: 90_000_000, minimumSystemVersion: '13.0' }),
      releases,
    );
    assert.equal(releases.written[0]?.notes, 'Undo on the canvas.');
    assert.equal(releases.written[0]?.size, 90_000_000);
    assert.equal(releases.written[0]?.minimumSystemVersion, '13.0');
  });

  test('refuses a version that is not newer, and does not write it', async () => {
    // The row would sit in the table for ever without being offered to
    // anybody, which reads as a broken updater rather than as a mistake.
    const releases = table([row('2.0.0')]);
    const err = await refusal(() => publishRelease(release({ version: '1.9.0' }), releases));
    assert.match(err.message, /not newer than 2\.0\.0/);
    assert.equal(releases.written.length, 0);
  });

  test('refuses the same version twice', async () => {
    const releases = table([row('1.1.0')]);
    const err = await refusal(() => publishRelease(release(), releases));
    assert.equal(err.statusCode, 409);
    assert.match(err.message, /already published/);
    assert.equal(releases.written.length, 0);
  });

  test('compares versions as numbers, so 1.10 goes out after 1.9', async () => {
    const releases = table([row('1.9.0')]);
    await publishRelease(release({ version: '1.10.0' }), releases);
    assert.equal(releases.written[0]?.version, '1.10.0');
  });

  test('a beta does not count as newer than the release it precedes', async () => {
    const releases = table([row('1.1.0')]);
    const err = await refusal(() => publishRelease(release({ version: '1.1.0-beta.2' }), releases));
    assert.match(err.message, /not newer/);
  });

  test('refuses a download that is not https', async () => {
    // `check` will follow a loopback http URL, which is a reasonable thing for
    // a developer to point at. Writing one where every Mac reads is not.
    const releases = table([]);
    for (const url of ['http://example.com/Studex.zip', 'http://127.0.0.1:8080/Studex.zip']) {
      const err = await refusal(() => publishRelease(release({ url }), releases));
      assert.match(err.message, /must be https/);
    }
    assert.equal(releases.written.length, 0);
  });

  test('refuses a malformed checksum rather than shipping an uninstallable release', async () => {
    // The shell refuses a download whose bytes do not hash to this, so a bad
    // value here is a release nobody can install.
    const releases = table([]);
    const err = await refusal(() => publishRelease(release({ sha256: 'nope' }), releases));
    assert.equal(err.statusCode, 422);
    assert.match(err.message, /sha256/);
  });

  test('refuses a version number that is not one', async () => {
    const releases = table([]);
    const err = await refusal(() => publishRelease(release({ version: 'latest' }), releases));
    assert.match(err.message, /version/);
  });

  test('a malformed row already in the table does not stop a good release', async () => {
    // Rows are read the same way anything from outside is read: skipped, not
    // trusted. One bad row must not be able to block every future release.
    const releases = table([{ version: null }, row('1.0.0')]);
    const { previous } = await publishRelease(release(), releases);
    assert.equal(previous?.version, '1.0.0');
    assert.equal(releases.written.length, 1);
  });

  test('a table that cannot be read is not published to', async () => {
    const failing: ReleasePublisher = {
      recent: async () => { throw new ApiError(502, 'release_publish_failed', 'no'); },
      insert: async () => { assert.fail('must not write without knowing what is out there'); },
      setStatus: async () => { assert.fail('must not write without knowing what is out there'); },
    };
    await refusal(() => publishRelease(release(), failing));
  });
});

describe('publishing with an upload', () => {
  test('uploads only after the checks pass, then writes the row', async () => {
    const releases = table([row('1.0.0')]);
    const order: string[] = [];
    releases.insert = async (r) => { order.push('insert'); releases.written.push(r); };
    await publishRelease(release(), releases, {
      upload: async () => { order.push('upload'); return 'https://example.com/Studex-1.1.0.zip'; },
    });
    assert.deepEqual(order, ['upload', 'insert']);
  });

  test('a refused release is never uploaded', async () => {
    const releases = table([row('2.0.0')]);
    await refusal(() => publishRelease(release(), releases, {
      upload: async () => assert.fail('a release that cannot go out must not be uploaded'),
    }));
  });

  test('a rejected version does not block the one replacing it', async () => {
    const releases = table([row('1.0.0'), row('1.2.0', { status: 'rejected' })]);
    const { previous } = await publishRelease(release(), releases);
    assert.equal(previous?.version, '1.0.0');
  });

  test('a pending version does block a lower one', async () => {
    const releases = table([row('1.2.0', { status: 'pending' })]);
    const err = await refusal(() => publishRelease(release(), releases));
    assert.match(err.message, /not newer than 1\.2\.0/);
  });
});

describe('approving a release', () => {
  const verified: string[] = [];
  const verify = async (r: Feed) => { verified.push(r.version); };

  test('a row without a status predates approval and counts as approved', () => {
    assert.equal(statusOf(row('1.0.0')), 'approved');
    assert.equal(statusOf(row('1.0.0', { status: 'pending' })), 'pending');
  });

  test('checks the download, then marks the pending row approved', async () => {
    const releases = table([row('1.0.0'), row('1.1.0', { status: 'pending' })]);
    const { replaces } = await approveRelease('1.1.0', releases, verify);
    assert.equal(replaces?.version, '1.0.0');
    assert.ok(verified.includes('1.1.0'));
    assert.deepEqual(releases.marked, [['1.1.0', 'approved']]);
  });

  test('a download that fails its check is not approved', async () => {
    const releases = table([row('1.1.0', { status: 'pending' })]);
    await refusal(() => approveRelease('1.1.0', releases, async () => {
      throw new ApiError(422, 'unprocessable', 'does not match');
    }));
    assert.equal(releases.marked.length, 0);
  });

  test('refuses a version that is not there, or not pending', async () => {
    const releases = table([row('1.0.0'), row('1.1.0', { status: 'rejected' })]);
    assert.equal((await refusal(() => approveRelease('9.9.9', releases, verify))).statusCode, 404);
    assert.match((await refusal(() => approveRelease('1.0.0', releases, verify))).message, /already approved/);
    assert.match((await refusal(() => approveRelease('1.1.0', releases, verify))).message, /was rejected/);
    assert.equal(releases.marked.length, 0);
  });

  test('refuses a pending version lower than the approved one', async () => {
    const releases = table([row('2.0.0'), row('1.5.0', { status: 'pending' })]);
    const err = await refusal(() => approveRelease('1.5.0', releases, verify));
    assert.match(err.message, /not newer than 2\.0\.0/);
  });

  test('rejecting pulls a version, approved or not', async () => {
    const releases = table([row('1.0.0'), row('1.1.0', { status: 'pending' })]);
    assert.equal((await rejectRelease('1.0.0', releases)).was, 'approved');
    assert.equal((await rejectRelease('1.1.0', releases)).was, 'pending');
    assert.deepEqual(releases.marked, [['1.0.0', 'rejected'], ['1.1.0', 'rejected']]);
  });
});

describe('the checksum of what is being shipped', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studex-publish-'));

  test('is taken from the bytes, in one pass with the size', async () => {
    const bytes = randomBytes(4096);
    const file = path.join(root, 'Studex.zip');
    fs.writeFileSync(file, bytes);

    const { sha256, size } = await digestOf(file);
    assert.equal(sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(size, bytes.byteLength);
  });

  test('refuses a file that is not there', async () => {
    const err = await refusal(() => digestOf(path.join(root, 'absent.zip')));
    assert.match(err.message, /no file/);
  });

  test('refuses an empty file', async () => {
    const file = path.join(root, 'empty.zip');
    fs.writeFileSync(file, '');
    const err = await refusal(() => digestOf(file));
    assert.match(err.message, /empty/);
  });
});

describe('who is allowed to publish', () => {
  test('an install with no owner-level key has no publisher at all', () => {
    // setup.ts deletes the Supabase variables, which is every ordinary
    // install: running Studex must not imply being able to update everyone
    // else's copy of it.
    assert.equal(supabasePublisher(), null);
  });
});

describe('signing a release', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studex-keys-'));

  test('makes a key pair once, private half locked down, and keeps it', async () => {
    const first = await generateSigningKeys(dir);
    assert.equal(first.created, true);
    assert.equal(Buffer.from(first.publicKey, 'base64').length, 32);
    const mode = fs.statSync(keyPaths(dir).privateKey).mode & 0o777;
    assert.equal(mode, 0o600);
    const again = await generateSigningKeys(dir);
    assert.equal(again.created, false);
    assert.equal(again.publicKey, first.publicKey);
  });

  test('a signature checks against the public key, and not against altered bytes', async () => {
    const { publicKey } = await generateSigningKeys(dir);
    const file = path.join(dir, 'Studex.zip');
    const bytes = randomBytes(2048);
    fs.writeFileSync(file, bytes);
    const signature = await signFile(file, await loadPrivateKey(keyPaths(dir).privateKey));
    assert.match(signature, /^[A-Za-z0-9+/]{86}==$/);
    assert.equal(verifySignature(bytes, signature, publicKey), true);
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    assert.equal(verifySignature(bytes, signature, publicKey), false);
  });

  test('a missing key is a clear refusal', async () => {
    const err = await refusal(() => loadPrivateKey(path.join(dir, 'nope.key')));
    assert.match(err.message, /--gen-keys/);
  });
});

describe('the generated feeds', () => {
  const rows = [
    row('1.3.0-beta.1', { status: 'approved', channel: 'beta' }),
    row('1.2.0', { status: 'pending' }),
    row('1.1.0', { status: 'approved', dmg_url: 'https://example.com/Studex-1.1.0.dmg', dmg_sha256: 'c'.repeat(64) }),
    row('1.0.5', { status: 'rejected' }),
  ];

  test('describe only approved releases, split by channel', () => {
    const files = feedFilesFor(rows);
    assert.match(files['appcast.xml'], /1\.1\.0/);
    assert.doesNotMatch(files['appcast.xml'], /beta|1\.2\.0|1\.0\.5/);
    assert.match(files['appcast-beta.xml'], /1\.3\.0-beta\.1/);
    const history = JSON.parse(files['releases.json']).releases;
    assert.deepEqual(history.map((r: { version: string }) => r.version), ['1.3.0-beta.1', '1.1.0']);
    const mac = JSON.parse(files['latest-mac.json']);
    assert.equal(mac.version, '1.1.0');
    assert.equal(mac.url, 'https://example.com/Studex-1.1.0.dmg');
  });

  test('land in the bucket and the website folder', async () => {
    const site = fs.mkdtempSync(path.join(os.tmpdir(), 'studex-site-'));
    const put: string[] = [];
    const publisher = { ...table(rows), put: async (name: string) => { put.push(name); return `https://x/${name}`; } };
    await syncFeeds(publisher, { siteDir: site });
    assert.deepEqual(put.sort(), ['appcast-beta.xml', 'appcast.xml', 'latest-mac.json', 'releases.json']);
    assert.ok(fs.existsSync(path.join(site, 'releases.json')));
  });

  test('publishing carries channel, signature and disk image into the row', async () => {
    const t = table([row('1.0.0')]);
    await publishRelease(release({
      channel: 'beta', critical: true, signature: `${'A'.repeat(86)}==`,
      dmgUrl: 'https://example.com/Studex.dmg', dmgSha256: 'd'.repeat(64), dmgSize: 10,
    }), t);
    assert.equal(t.written[0]?.channel, 'beta');
    assert.equal(t.written[0]?.critical, true);
    assert.equal(t.written[0]?.dmgSize, 10);
  });
});
