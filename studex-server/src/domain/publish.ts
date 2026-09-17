import {
  createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject,
} from 'node:crypto';
import { createReadStream } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { config } from '../lib/config.js';
import { ApiError, conflict, unprocessable } from '../lib/errors.js';
import {
  appcastXml, compareVersions, feedSchema, newestOf, releasesOf, type Feed, type ReleaseSource,
} from './updates.js';

/**
 * Sending an update out — the other half of `updates.ts`.
 *
 * The app has always known how to find a newer version and install it. What
 * has never existed is the act of publishing one: the releases table said, in
 * a comment, that inserting a row was the owner's job in the dashboard, and
 * so cutting a release meant pasting a version number and a checksum into a
 * SQL editor by hand. That is the step where a release goes wrong. A digit
 * dropped from the hash is a download every Mac refuses; a hash taken of the
 * wrong file is worse, because it is a download every Mac accepts.
 *
 * So the checksum is computed here from the very bytes being published, the
 * row is checked against the versions already out there before it is written,
 * and the whole thing is one command. Nothing about the table changes: it is
 * still world-readable, still writable only with an owner-level key, and that
 * key lives in the environment of the machine cutting the release and nowhere
 * near the bundle handed to the people running Studex.
 *
 * Publishing and releasing are two steps. A new row goes in as `pending`,
 * which the feed every Mac reads leaves out; only `approveRelease` — after
 * downloading the file again and checking it against the row — makes it
 * something an install will be offered. `rejectRelease` takes a version back
 * out, including one already approved.
 */

/**
 * Where a release is written. Extends the read seam rather than replacing it,
 * because publishing has to read first — what is already out there is what
 * decides whether this version may go out at all.
 */
export interface ReleasePublisher extends ReleaseSource {
  /** Writes the row as pending. Nothing is offered to anybody yet. */
  insert(release: Feed): Promise<void>;
  /** Moves one version between pending, approved and rejected. */
  setStatus(version: string, status: 'approved' | 'rejected'): Promise<void>;
  /**
   * Puts a file (the zip, the disk image) in the project's `releases` storage
   * bucket and returns the public URL it is downloaded from. Absent where
   * there is no bucket to use.
   */
  upload?(fileName: string, filePath: string, contentType?: string): Promise<string>;
  /** Writes a small generated file — a feed — into the same bucket. */
  put?(fileName: string, body: string, contentType: string): Promise<string>;
}

/** What an upload is served as, by extension. */
export function contentTypeOf(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.dmg') return 'application/x-apple-diskimage';
  if (ext === '.xml') return 'application/xml';
  if (ext === '.json') return 'application/json';
  return 'application/zip';
}

export type ReleaseStatus = 'pending' | 'approved' | 'rejected';

/**
 * A row's status. A row with none predates the approval step, and everything
 * published before it existed was live, so it counts as approved.
 */
export function statusOf(row: unknown): ReleaseStatus {
  const value = (row as { status?: unknown })?.status;
  return value === 'pending' || value === 'rejected' ? value : 'approved';
}

/** The storage bucket releases are uploaded to — see supabase/setup.sql. */
export const RELEASE_BUCKET = 'releases';

/** Where an uploaded zip is downloaded from, before it has been uploaded. */
export function storageUrlFor(fileName: string): string | null {
  const settings = config.supabase;
  if (!settings) return null;
  return new URL(
    `/storage/v1/object/public/${RELEASE_BUCKET}/${encodeURIComponent(fileName)}`,
    settings.url,
  ).toString();
}

const REQUEST_TIMEOUT_MS = 20_000;
/** A release is a hundred megabytes on somebody's home upload speed. */
const UPLOAD_TIMEOUT_MS = 15 * 60_000;

/**
 * The project's releases table, written with the owner-level key.
 *
 * Null when there is no such key, which is every ordinary install: a copy of
 * Studex that merely runs the server has no business being able to decide
 * what code every other copy installs.
 */
export function supabasePublisher(): ReleasePublisher | null {
  const settings = config.supabase;
  if (!settings?.serviceKey) return null;
  const key = settings.serviceKey;
  const projectUrl = settings.url;

  const endpoint = new URL('/rest/v1/releases', settings.url);
  const listUrl = new URL(endpoint);
  listUrl.searchParams.set('select', '*');
  listUrl.searchParams.set('order', 'published_at.desc');
  listUrl.searchParams.set('limit', '50');

  const headers = {
    apikey: key,
    authorization: `Bearer ${key}`,
    accept: 'application/json',
  };

  async function send(url: URL, init: RequestInit, what: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      const reason = err instanceof Error && err.name === 'AbortError'
        ? 'did not answer in time'
        : 'could not be reached';
      throw new ApiError(502, 'release_publish_failed', `The releases table ${reason} while ${what}.`);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async recent() {
      const res = await send(listUrl, { headers }, 'reading what is already published');
      if (!res.ok) {
        throw new ApiError(
          502,
          'release_publish_failed',
          `Reading the releases table answered ${res.status}. ${await detail(res)}`,
        );
      }
      const body: unknown = await res.json();
      return Array.isArray(body) ? body : [];
    },

    async insert(release) {
      const res = await send(
        endpoint,
        {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json', prefer: 'return=minimal' },
          body: JSON.stringify({
            version: release.version,
            url: release.url,
            sha256: release.sha256,
            notes: release.notes ?? null,
            size: release.size ?? null,
            minimum_system_version: release.minimumSystemVersion ?? null,
            ...(release.publishedAt ? { published_at: release.publishedAt } : {}),
            // Only the newer columns that carry something, so a table that
            // predates them still takes a plain release.
            ...(release.channel && release.channel !== 'stable' ? { channel: release.channel } : {}),
            ...(release.critical ? { critical: true } : {}),
            ...(release.signature ? { signature: release.signature } : {}),
            ...(release.dmgUrl ? { dmg_url: release.dmgUrl } : {}),
            ...(release.dmgSha256 ? { dmg_sha256: release.dmgSha256 } : {}),
            ...(release.dmgSize ? { dmg_size: release.dmgSize } : {}),
            status: 'pending',
          }),
        },
        'writing the release',
      );
      if (res.ok) return;
      // 409 is the unique index on version. It means somebody — or an earlier
      // run of this command — already published this version, and saying so
      // is more useful than a status code.
      if (res.status === 409) {
        throw conflict(`Version ${release.version} is already published.`);
      }
      if (res.status === 401 || res.status === 403) throw refusedWrite();
      const why = await detail(res);
      if (/channel|critical|signature|dmg_/.test(why) && res.status === 400) throw missingColumns();
      if (/status/.test(why) && res.status === 400) throw missingApproval();
      throw new ApiError(502, 'release_publish_failed', `Publishing answered ${res.status}. ${why}`);
    },

    async setStatus(version, status) {
      const url = new URL(endpoint);
      url.searchParams.set('version', `eq.${version}`);
      const res = await send(
        url,
        {
          method: 'PATCH',
          headers: { ...headers, 'content-type': 'application/json', prefer: 'return=representation' },
          body: JSON.stringify({
            status,
            approved_at: status === 'approved' ? new Date().toISOString() : null,
          }),
        },
        `marking ${version} ${status}`,
      );
      if (res.status === 401 || res.status === 403) throw refusedWrite();
      if (!res.ok) {
        const why = await detail(res);
        if (/status|approved_at/.test(why) && res.status === 400) throw missingApproval();
        throw new ApiError(502, 'release_publish_failed', `Updating ${version} answered ${res.status}. ${why}`);
      }
      const body: unknown = await res.json().catch(() => []);
      if (!Array.isArray(body) || body.length === 0) {
        throw new ApiError(404, 'release_not_found', `There is no release ${version} to mark ${status}.`);
      }
    },

    async upload(fileName, filePath, contentType = contentTypeOf(fileName)) {
      const bytes = await fsp.readFile(filePath);
      return store(fileName, new Blob([bytes], { type: contentType }), contentType, UPLOAD_TIMEOUT_MS);
    },

    async put(fileName, body, contentType) {
      return store(fileName, new Blob([body], { type: contentType }), contentType, REQUEST_TIMEOUT_MS);
    },
  };

  async function store(fileName: string, body: Blob, contentType: string, timeoutMs: number): Promise<string> {
    {
      const url = new URL(
        `/storage/v1/object/${RELEASE_BUCKET}/${encodeURIComponent(fileName)}`,
        projectUrl,
      );
      const res = await send(
        url,
        {
          method: 'POST',
          headers: {
            apikey: key,
            authorization: `Bearer ${key}`,
            'content-type': contentType,
            // A second run after an upload that went through but a row that did
            // not is a retry, not a conflict. The app checks the bytes against
            // the row's checksum whatever is sitting at the URL.
            'x-upsert': 'true',
            'cache-control': 'no-cache',
          },
          body,
        },
        `uploading ${fileName}`,
        timeoutMs,
      );
      if (!res.ok) {
        const why = await detail(res);
        if (res.status === 413 || /maximum allowed size|too large/i.test(why)) {
          throw new ApiError(
            413,
            'release_too_large',
            `The zip is larger than this project allows for one upload. Raise the file size limit in `
              + `Storage settings, or host the zip elsewhere and pass --url. ${why}`,
          );
        }
        if (/bucket not found/i.test(why)) {
          throw new ApiError(
            502,
            'release_bucket_missing',
            `There is no "${RELEASE_BUCKET}" storage bucket yet. Run supabase/setup.sql in the project first.`,
          );
        }
        if (/mime type/i.test(why)) {
          throw new ApiError(
            502,
            'release_bucket_outdated',
            `The "${RELEASE_BUCKET}" bucket does not accept ${contentType} yet. Run section 2 of `
              + `supabase/setup.sql again to widen it. ${why}`,
          );
        }
        throw new ApiError(502, 'release_upload_failed', `Uploading ${fileName} answered ${res.status}. ${why}`);
      }
      return storageUrlFor(fileName)!;
    }
  }
}

function refusedWrite(): ApiError {
  return new ApiError(
    502,
    'release_publish_refused',
    'The project refused the write. SUPABASE_SERVICE_ROLE_KEY must be the service role key, '
      + 'not the anon key — the anon key may only read this table, by design.',
  );
}

function missingApproval(): ApiError {
  return new ApiError(
    502,
    'release_table_outdated',
    'The releases table has no approval columns yet. Run section 2 of supabase/setup.sql '
      + 'in the project, then try again.',
  );
}

function missingColumns(): ApiError {
  return new ApiError(
    502,
    'release_table_outdated',
    'The releases table has no channel, signature or disk image columns yet. Run section 2 of '
      + 'supabase/setup.sql in the project, then try again.',
  );
}

/** Whatever the project said went wrong, when it said anything. */
async function detail(res: Response): Promise<string> {
  try {
    const text = (await res.text()).trim();
    return text ? text.slice(0, 400) : '';
  } catch {
    return '';
  }
}

/**
 * The hash and the size of the thing actually being shipped.
 *
 * Streamed, because a release is a hundred megabytes and reading it into
 * memory to hash it is a needless way to fail on a small machine. Both values
 * come from the same pass over the same file, so they cannot disagree with
 * each other — which is the failure a hand-copied checksum invites.
 */
export async function digestOf(filePath: string): Promise<{ sha256: string; size: number }> {
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat?.isFile()) throw unprocessable(`There is no file at ${filePath}.`);
  if (stat.size === 0) throw unprocessable(`${filePath} is empty.`);

  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return { sha256: hash.digest('hex'), size: stat.size };
}

/** An update is code, and it travels to every install. https, with no exception. */
function assertDownloadable(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw unprocessable(`The download URL is not a URL: ${raw}`);
  }
  // `check` will accept a loopback http URL, because a developer pointing the
  // updater at their own machine is a reasonable thing to do. Publishing one
  // to the table every Mac reads is not: it is a download nobody else can
  // fetch, written where everybody looks.
  if (url.protocol !== 'https:') {
    throw unprocessable('The download URL must be https — an update is code, and it travels.');
  }
}

export interface PublishResult {
  release: Feed;
  /** What was newest before this went out, for the line printed afterwards. */
  previous: Feed | null;
}

/**
 * Publishes one release, after establishing that it is one worth publishing.
 *
 * Everything that can be wrong is checked before the write, because a release
 * row is read by every install within the hour and there is no taking it back
 * quietly. The version has to parse, the download has to be https, and it has
 * to be genuinely newer than what is already out there — a version that is
 * not newer would sit in the table for ever without ever being offered, which
 * looks exactly like a broken updater to whoever published it.
 */
export async function publishRelease(
  input: unknown,
  publisher: ReleasePublisher,
  options: {
    /**
     * Uploads the zip once everything else has been checked, so a refused
     * release never costs a hundred-megabyte upload. Must return `input.url`.
     */
    upload?: () => Promise<string>;
  } = {},
): Promise<PublishResult> {
  const parsed = feedSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'release'}: ${i.message}`);
    throw unprocessable(`That is not a publishable release. ${issues.join('; ')}`);
  }
  const release = parsed.data;
  assertDownloadable(release.url);

  const rows = await publisher.recent();
  // A rejected version is not out there, so it does not stand in the way of
  // the one replacing it. A pending one does: two releases waiting side by
  // side, the lower one could be approved after the higher.
  const { latest: previous } = newestOf(rows.filter((r) => statusOf(r) !== 'rejected'));

  // Reading the table for the exact version as well as the newest one: the
  // unique index would catch a repeat anyway, but it would catch it after the
  // upload, and "already published" is worth saying before that.
  const already = rows.some(
    (row) => (row as { version?: unknown })?.version === release.version,
  );
  if (already) throw conflict(`Version ${release.version} is already published.`);

  if (previous && compareVersions(release.version, previous.version) <= 0) {
    throw conflict(
      `Version ${release.version} is not newer than ${previous.version}, which is already out. `
        + 'No install would ever be offered it.',
    );
  }

  if (options.upload) {
    const uploaded = await options.upload();
    if (uploaded !== release.url) {
      throw new ApiError(502, 'release_upload_failed', `The upload landed at ${uploaded}, not ${release.url}.`);
    }
  }

  await publisher.insert(release);
  return { release, previous };
}

/** A row by its version, with its status, or a refusal naming what exists. */
async function find(version: string, publisher: ReleasePublisher) {
  const rows = await publisher.recent();
  const row = rows.find((r) => (r as { version?: unknown })?.version === version);
  if (!row) {
    throw new ApiError(404, 'release_not_found', `There is no release ${version} in the table.`);
  }
  const { latest: release } = newestOf([row]);
  if (!release) throw unprocessable(`The row for ${version} is malformed and cannot be released.`);
  return { rows, release, status: statusOf(row) };
}

/**
 * Fetches a release's download and checks it is the file the row describes.
 *
 * The same test every Mac will apply, run once here first: approving a row
 * whose URL 404s, or whose bytes were replaced after publishing, is how a
 * release reaches everyone and installs on no one.
 */
export async function verifyDownload(release: Feed): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(release.url, { signal: controller.signal, headers: { 'cache-control': 'no-cache' } });
    if (!res.ok || !res.body) {
      throw unprocessable(`The download for ${release.version} answered ${res.status}, so it cannot be approved.`);
    }
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      size += chunk.byteLength;
    }
    const actual = hash.digest('hex');
    if (actual !== release.sha256) {
      throw unprocessable(
        `The file at ${release.url} does not match the published checksum `
          + `(expected ${release.sha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…). It was not approved.`,
      );
    }
    if (release.size && size !== release.size) {
      throw unprocessable(`The download is ${size} bytes, not the ${release.size} published. It was not approved.`);
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw unprocessable(`The download for ${release.version} could not be fetched to check it.`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Releases a pending version to every install.
 *
 * Refuses anything that would not be offered once approved — a version not
 * newer than the newest approved one would be approved and never seen — and
 * checks the download before the status changes, not after.
 */
export async function approveRelease(
  version: string,
  publisher: ReleasePublisher,
  verify: (release: Feed) => Promise<void> = verifyDownload,
): Promise<{ release: Feed; replaces: Feed | null }> {
  const { rows, release, status } = await find(version, publisher);
  if (status === 'approved') throw conflict(`Version ${version} is already approved.`);
  if (status === 'rejected') {
    throw conflict(`Version ${version} was rejected. Publish the fix as a new version instead.`);
  }

  const { latest: live } = newestOf(rows.filter((r) => statusOf(r) === 'approved'));
  if (live && compareVersions(version, live.version) <= 0) {
    throw conflict(
      `Version ${version} is not newer than ${live.version}, which is already approved. `
        + 'No install would ever be offered it.',
    );
  }

  await verify(release);
  await publisher.setStatus(version, 'approved');
  return { release, replaces: live };
}

/**
 * Takes a version out of the feed. Works on an approved one too: that is how
 * a bad release is pulled, and the Macs still on the previous version are
 * then offered that one — or nothing — instead.
 */
export async function rejectRelease(
  version: string,
  publisher: ReleasePublisher,
): Promise<{ release: Feed; was: ReleaseStatus }> {
  const { release, status } = await find(version, publisher);
  if (status === 'rejected') throw conflict(`Version ${version} is already rejected.`);
  await publisher.setStatus(version, 'rejected');
  return { release, was: status };
}

/**
 * Signing — the check a checksum cannot give.
 *
 * The sha256 in the row proves the download is the file the row describes;
 * it says nothing about who wrote the row. An Ed25519 signature made on the
 * release machine, checked in the app against a public key baked in at build
 * time, does: somebody who can write to the table but does not hold the
 * private key cannot get an install to accept their zip. The same scheme, and
 * the same encoding, as Sparkle's `sparkle:edSignature` / `SUPublicEDKey`.
 */

/** Where the release machine keeps its keys. Never inside the project. */
export function keyPaths(dir: string): { privateKey: string; publicKey: string } {
  return { privateKey: path.join(dir, 'ed25519.key'), publicKey: path.join(dir, 'ed25519.pub') };
}

/**
 * Makes a key pair, refusing to replace one: a new private key orphans every
 * install that trusts the old public one.
 */
export async function generateSigningKeys(dir: string): Promise<{ publicKey: string; created: boolean }> {
  const paths = keyPaths(dir);
  const existing = await fsp.readFile(paths.publicKey, 'utf8').catch(() => null);
  const hasPrivate = await fsp.stat(paths.privateKey).then(() => true, () => false);
  if (existing && hasPrivate) return { publicKey: existing.trim(), created: false };
  if (hasPrivate) {
    const publicKey = rawPublicKey(createPublicKey(await loadPrivateKey(paths.privateKey)));
    await fsp.writeFile(paths.publicKey, `${publicKey}\n`, { mode: 0o644 });
    return { publicKey, created: false };
  }

  const pair = generateKeyPairSync('ed25519');
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  await fsp.writeFile(paths.privateKey, pem, { mode: 0o600, flag: 'wx' });
  const publicKey = rawPublicKey(pair.publicKey);
  await fsp.writeFile(paths.publicKey, `${publicKey}\n`, { mode: 0o644 });
  return { publicKey, created: true };
}

/** The 32 raw bytes, base64 — what CryptoKit and Sparkle take. */
export function rawPublicKey(key: KeyObject): string {
  const jwk = key.export({ format: 'jwk' }) as { x?: string };
  if (!jwk.x) throw unprocessable('That is not an Ed25519 key.');
  return Buffer.from(jwk.x, 'base64url').toString('base64');
}

export async function loadPrivateKey(file: string): Promise<KeyObject> {
  const pem = await fsp.readFile(file, 'utf8').catch(() => null);
  if (!pem) {
    throw unprocessable(`There is no signing key at ${file}. Create one with --gen-keys.`);
  }
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw unprocessable(`${file} is not an Ed25519 key.`);
  return key;
}

/** Signs a file's bytes. Ed25519 signs the whole message, so it is read whole. */
export async function signFile(filePath: string, key: KeyObject): Promise<string> {
  const bytes = await fsp.readFile(filePath);
  return sign(null, bytes, key).toString('base64');
}

export function verifySignature(bytes: Uint8Array, signature: string, publicKey: string): boolean {
  const key = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKey, 'base64').toString('base64url') },
    format: 'jwk',
  });
  return verify(null, bytes, key, Buffer.from(signature, 'base64'));
}

/**
 * The feeds everything else reads, generated from the table.
 *
 * Written after every approve and reject so they never describe a release the
 * table no longer offers: the appcasts (one per channel), a JSON history the
 * website's changelog renders, and the download record for the Mac card.
 */
export interface FeedFiles {
  'appcast.xml': string;
  'appcast-beta.xml': string;
  'releases.json': string;
  'latest-mac.json': string;
}

export function feedFilesFor(rows: unknown[], options: { link?: string } = {}): FeedFiles {
  const approved = releasesOf(rows.filter((r) => statusOf(r) === 'approved'));
  const stable = approved.filter((r) => (r.channel ?? 'stable') === 'stable');
  const latest = stable[0] ?? null;
  const history = approved.map((r) => ({
    version: r.version,
    channel: r.channel ?? 'stable',
    critical: Boolean(r.critical),
    publishedAt: r.publishedAt ?? null,
    minimumSystemVersion: r.minimumSystemVersion ?? null,
    notes: r.notes ?? '',
    url: r.url,
    size: r.size ?? null,
    sha256: r.sha256,
    dmgUrl: r.dmgUrl ?? null,
    dmgSha256: r.dmgSha256 ?? null,
    dmgSize: r.dmgSize ?? null,
  }));
  const common = { link: options.link, title: 'Studex' };
  return {
    'appcast.xml': appcastXml(stable, common),
    'appcast-beta.xml': appcastXml(approved, { ...common, title: 'Studex Beta' }),
    'releases.json': `${JSON.stringify({ generatedAt: new Date().toISOString(), releases: history }, null, 2)}\n`,
    'latest-mac.json': `${JSON.stringify(latest ? {
      platform: 'mac',
      version: latest.version,
      url: latest.dmgUrl ?? null,
      sha256: latest.dmgSha256 ?? null,
      size: latest.dmgSize ?? null,
      update: { url: latest.url, sha256: latest.sha256, signature: latest.signature ?? null },
      publishedAt: latest.publishedAt ?? null,
    } : null, null, 2)}\n`,
  };
}

/**
 * Regenerates the feeds and puts them wherever they are served from: the
 * bucket, when the publisher can write there, and a local folder (the
 * website's downloads/) when one is given. Returns what was written where.
 */
export async function syncFeeds(
  publisher: ReleasePublisher,
  options: { siteDir?: string; link?: string } = {},
): Promise<string[]> {
  const files = feedFilesFor(await publisher.recent(), { link: options.link });
  const wrote: string[] = [];
  for (const [name, body] of Object.entries(files)) {
    if (publisher.put) wrote.push(await publisher.put(name, body, contentTypeOf(name)));
    if (options.siteDir) {
      await fsp.mkdir(options.siteDir, { recursive: true });
      const target = path.join(options.siteDir, name);
      await fsp.writeFile(target, body);
      wrote.push(target);
    }
  }
  return wrote;
}
