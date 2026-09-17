import { execFile } from 'node:child_process';
import { z } from 'zod';
import { config } from '../lib/config.js';
import { ApiError, badRequest } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { withRetry } from '../lib/retry.js';

/**
 * Checking whether a newer Studex exists, and describing it.
 *
 * Releases live in one table in the Supabase project the app already signs in
 * against — publishing a version is a row, and every Mac sees it at once.
 * There is no per-machine channel to configure and no JSON file to host: a
 * build that was set up to sign in is a build that can find its own updates.
 *
 * The download and the swap belong to the shell — only AppKit can replace the
 * bundle it is running out of and come back up. What lives here is everything
 * that can be decided before a single byte is fetched: where to look, whether
 * the answer is well formed, and whether it is actually newer than what is
 * running. Getting that wrong is how an updater talks a user into installing
 * a downgrade.
 */

/**
 * One release. Deliberately one rather than a history: the only question the
 * app asks is "is there something newer than me", and a list invites the
 * answer "newer than what?".
 */
export const feedSchema = z.object({
  version: z.string().regex(/^\d+(\.\d+){0,3}(-[0-9A-Za-z.]+)?$/, 'Not a version number'),
  /** The zipped .app. https only — an update is code. */
  url: z.string().url(),
  /** Of the zip, lowercase hex. The shell refuses anything that does not match. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'Not a sha256'),
  notes: z.string().max(8000).optional(),
  publishedAt: z.string().max(64).optional(),
  minimumSystemVersion: z.string().max(32).optional(),
  size: z.number().int().positive().max(4 * 1024 * 1024 * 1024).optional(),
  /** Who is offered it. A beta install sees both; a stable one only stable. */
  channel: z.enum(['stable', 'beta']).optional(),
  /** Installs without waiting for the student to pick a moment. */
  critical: z.boolean().optional(),
  /** Ed25519 over the zip's bytes, base64 — Sparkle's edSignature. */
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/, 'Not an Ed25519 signature').optional(),
  /** The disk image the website hands out, for people installing fresh. */
  dmgUrl: z.string().url().optional(),
  dmgSha256: z.string().regex(/^[0-9a-f]{64}$/, 'Not a sha256').optional(),
  dmgSize: z.number().int().positive().max(4 * 1024 * 1024 * 1024).optional(),
});

export type Channel = 'stable' | 'beta';

export type Feed = z.infer<typeof feedSchema>;

/**
 * A row of public.releases, as it comes back over the wire.
 *
 * The table is world-readable — that is the point of it — so this is read the
 * same way anything else arriving from outside is: checked, and skipped rather
 * than trusted when it does not fit. A malformed row must not be able to stop
 * a good one further down the list from being offered.
 */
const releaseRowSchema = z.object({
  version: z.string(),
  url: z.string(),
  sha256: z.string(),
  notes: z.string().nullish(),
  size: z.union([z.number(), z.string()]).nullish(),
  minimum_system_version: z.string().nullish(),
  published_at: z.string().nullish(),
  channel: z.string().nullish(),
  critical: z.boolean().nullish(),
  signature: z.string().nullish(),
  dmg_url: z.string().nullish(),
  dmg_sha256: z.string().nullish(),
  dmg_size: z.union([z.number(), z.string()]).nullish(),
});

export interface UpdateState {
  /** Null outside the desktop shell, where there is no bundle to update. */
  version: string | null;
  build: string | null;
  /** Whether there is anywhere to look. False when Supabase is not configured. */
  online: boolean;
  canInstall: boolean;
}

export interface CheckResult extends UpdateState {
  latest: Feed | null;
  available: boolean;
  checkedAt: number;
  channel: Channel;
  /** This Mac's macOS version, when it could be read. */
  system: string | null;
  /** Every version between this one and the latest, newest first — the "what's new". */
  missed: Feed[];
  /** Whether anything in `missed` was marked critical. */
  critical: boolean;
  /** The release history this install can see, newest first. */
  releases: Feed[];
  /** A newer release exists but needs a newer macOS than this one. */
  blocked: Feed | null;
}

/**
 * Which of two versions is newer.
 *
 * Numeric parts compare as numbers, so 1.10 beats 1.9 — comparing them as
 * text is the classic way an updater stops offering updates at version 10.
 * A suffixed version (1.2.0-beta.1) is older than the same version without
 * one, which is what makes a beta settle onto the release rather than being
 * offered it for ever.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): [number[], string] => {
    const [core = '', ...rest] = v.split('-');
    return [core.split('.').map((n) => Number.parseInt(n, 10) || 0), rest.join('-')];
  };
  const [an, apre] = split(a);
  const [bn, bpre] = split(b);

  for (let i = 0; i < Math.max(an.length, bn.length); i += 1) {
    const diff = (an[i] ?? 0) - (bn[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  if (apre === bpre) return 0;
  if (!apre) return 1;
  if (!bpre) return -1;
  return apre < bpre ? -1 : 1;
}

/** https, or loopback http — the one transport with nothing in the middle. */
function assertFetchable(raw: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest(`${what} is not a valid URL`);
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && loopback) return url;
  throw badRequest(`${what} must be https`);
}

export function stateFor(): UpdateState {
  return {
    version: config.appVersion,
    build: config.appBuild,
    online: Boolean(config.supabase),
    // Nothing to replace when the app is not running out of a bundle, which
    // is every browser and every development run.
    canInstall: Boolean(config.appVersion),
  };
}

/**
 * Where releases are read from.
 *
 * Narrow on purpose: it is the seam the tests substitute, so ordering,
 * malformed rows, downgrades and an unreachable project are all exercised
 * without a network and without a test run reading a real project.
 */
export interface ReleaseSource {
  /** Recent releases, newest first. Order is a hint, not a promise. */
  recent(): Promise<unknown[]>;
}

/** Enough of a table to be a release table; more than this is somebody's mistake. */
const MAX_ROWS = 20;
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * The project's own releases table, over PostgREST.
 *
 * Read with the publishable anon key and nothing else: the table is public by
 * design, so a check does not need — and must not require — a signed-in
 * session. A Mac that has been signed out for a month still learns there is a
 * new version.
 */
export function supabaseReleases(): ReleaseSource | null {
  const settings = config.supabase;
  if (!settings) return null;

  const url = new URL('/rest/v1/releases', settings.url);
  // Everything, rather than a column list: a project whose table predates the
  // channel and signature columns still answers, and simply has none.
  url.searchParams.set('select', '*');
  // Only approved releases. The table's policy already hides the rest from
  // the anon key; asking for them by name as well means a project whose
  // policy was never updated still does not offer a pending build.
  url.searchParams.set('status', 'eq.approved');
  url.searchParams.set('order', 'published_at.desc');
  url.searchParams.set('limit', String(MAX_ROWS));

  return {
    async recent() {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: {
            apikey: settings.anonKey,
            authorization: `Bearer ${settings.anonKey}`,
            accept: 'application/json',
          },
        });
        if (!res.ok) {
          // A refusal is settled; anything else may be weather.
          const settled = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
          throw new ApiError(
            502,
            settled ? 'update_source_refused' : 'update_source_failed',
            res.status === 404
              ? 'This project has no releases table yet.'
              : `The release list answered ${res.status}.`,
          );
        }
        const body: unknown = await res.json();
        return Array.isArray(body) ? body : [];
      } catch (err) {
        if (err instanceof ApiError) throw err;
        const reason = err instanceof Error && err.name === 'AbortError'
          ? 'did not answer in time'
          : 'could not be reached';
        throw new ApiError(502, 'update_source_failed', `The release list ${reason}.`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** One row, turned into a release — or null, if it is not one. */
function toFeed(row: unknown): Feed | null {
  const parsed = releaseRowSchema.safeParse(row);
  if (!parsed.success) return null;
  const r = parsed.data;
  const size = positive(r.size);
  const release = feedSchema.safeParse({
    version: r.version,
    url: r.url,
    sha256: r.sha256,
    notes: r.notes ?? undefined,
    publishedAt: r.published_at ?? undefined,
    minimumSystemVersion: r.minimum_system_version ?? undefined,
    size,
    channel: r.channel === 'beta' ? 'beta' : 'stable',
    critical: r.critical ?? undefined,
    signature: r.signature ?? undefined,
    dmgUrl: r.dmg_url ?? undefined,
    dmgSha256: r.dmg_sha256 ?? undefined,
    dmgSize: positive(r.dmg_size),
  });
  return release.success ? release.data : null;
}

function positive(value: number | string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** Every well-formed row, newest version first. */
export function releasesOf(rows: unknown[]): Feed[] {
  return rows
    .slice(0, MAX_ROWS)
    .map(toFeed)
    .filter((r): r is Feed => r !== null)
    .sort((a, b) => compareVersions(b.version, a.version));
}

/** Whether an install on `channel` is offered this release. */
export function visibleOn(release: Feed, channel: Channel): boolean {
  return channel === 'beta' || (release.channel ?? 'stable') === 'stable';
}

/** Whether `system` is new enough for the release. Unknown counts as yes. */
export function runsOn(release: Feed, system: string | null): boolean {
  if (!release.minimumSystemVersion || !system) return true;
  return compareVersions(system, release.minimumSystemVersion) >= 0;
}

let systemVersion: Promise<string | null> | null = null;

/** macOS's product version, read once. Null anywhere else. */
export function currentSystem(): Promise<string | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  systemVersion ??= new Promise((resolve) => {
    execFile('/usr/bin/sw_vers', ['-productVersion'], { timeout: 3_000 }, (err, out) => {
      const v = String(out ?? '').trim();
      resolve(!err && /^\d+(\.\d+)*$/.test(v) ? v : null);
    });
  });
  return systemVersion;
}

const xml = (text: string): string => text
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/**
 * The releases as a Sparkle appcast — the same shape as the reference
 * appcast.xml, so anything that reads one (Sparkle itself, a feed reader, the
 * website) can read Studex's. Notes go in as plain text inside CDATA.
 */
export function appcastXml(
  releases: Feed[],
  options: { title?: string; link?: string; description?: string } = {},
): string {
  const title = options.title ?? 'Studex';
  const items = releases.map((r) => {
    const date = r.publishedAt ? new Date(r.publishedAt) : null;
    const attrs = [
      `url="${xml(r.url)}"`,
      `sparkle:version="${xml(r.version)}"`,
      `sparkle:shortVersionString="${xml(r.version)}"`,
      r.size ? `length="${r.size}"` : '',
      'type="application/octet-stream"',
      r.signature ? `sparkle:edSignature="${r.signature}"` : '',
      `studex:sha256="${r.sha256}"`,
    ].filter(Boolean).join(' ');
    const notes = (r.notes ?? '').replace(/]]>/g, ']]]]><![CDATA[>');
    return [
      '    <item>',
      `      <title>Version ${xml(r.version)}</title>`,
      date && !Number.isNaN(date.getTime()) ? `      <pubDate>${date.toUTCString()}</pubDate>` : '',
      `      <sparkle:version>${xml(r.version)}</sparkle:version>`,
      `      <sparkle:shortVersionString>${xml(r.version)}</sparkle:shortVersionString>`,
      r.minimumSystemVersion
        ? `      <sparkle:minimumSystemVersion>${xml(r.minimumSystemVersion)}</sparkle:minimumSystemVersion>`
        : '',
      r.channel === 'beta' ? '      <sparkle:channel>beta</sparkle:channel>' : '',
      r.critical ? '      <sparkle:criticalUpdate></sparkle:criticalUpdate>' : '',
      notes ? `      <description><![CDATA[${notes}]]></description>` : '',
      `      <enclosure ${attrs}/>`,
      '    </item>',
    ].filter(Boolean).join('\n');
  });
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"'
      + ' xmlns:studex="https://studex.app/xml/updates" xmlns:dc="http://purl.org/dc/elements/1.1/">',
    '  <channel>',
    `    <title>${xml(title)}</title>`,
    options.link ? `    <link>${xml(options.link)}</link>` : '',
    `    <description>${xml(options.description ?? `Updates for ${title}.`)}</description>`,
    '    <language>en</language>',
    ...items,
    '  </channel>',
    '</rss>',
    '',
  ].filter((line) => line !== '').join('\n');
}

/**
 * The newest release the table holds.
 *
 * Chosen by comparing versions rather than by trusting the order the rows came
 * back in: published_at is a timestamp somebody typed, and a release published
 * out of order must not be able to offer a downgrade to every Mac at once.
 */
export function newestOf(rows: unknown[]): { latest: Feed | null; skipped: number } {
  let latest: Feed | null = null;
  let skipped = 0;
  for (const row of rows.slice(0, MAX_ROWS)) {
    const release = toFeed(row);
    if (!release) { skipped += 1; continue; }
    if (!latest || compareVersions(release.version, latest.version) > 0) latest = release;
  }
  return { latest, skipped };
}

export async function check(
  source: ReleaseSource | null = supabaseReleases(),
  options: { channel?: Channel; system?: string | null } = {},
): Promise<CheckResult> {
  const state = stateFor();
  const channel: Channel = options.channel === 'beta' ? 'beta' : 'stable';
  if (!source) {
    throw new ApiError(
      409,
      'no_update_source',
      'This build is not connected to a Supabase project, so there is nowhere to look for updates.',
    );
  }

  // Reading a list is idempotent, so a flaky connection or a project having a
  // moment gets a couple more goes before the student is told updates are
  // broken. A refusal is not retried: it will say the same thing in four
  // seconds.
  let rows: unknown[];
  try {
    rows = await withRetry(() => source.recent(), {
      what: 'release list',
      attempts: 3,
      baseMs: 300,
      maxMs: 2_000,
      retryable: (err) => !(err instanceof ApiError && err.code === 'update_source_refused'),
    });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(502, 'update_source_failed', 'The release list could not be reached.');
  }

  const system = options.system === undefined ? await currentSystem() : options.system;
  const all = releasesOf(rows);
  const skipped = Math.min(rows.length, MAX_ROWS) - all.length;
  if (skipped) log.warn({ skipped }, 'ignored malformed rows in the releases table');

  const releases = all.filter((r) => visibleOn(r, channel));
  const newer = (r: Feed) => Boolean(state.version) && compareVersions(r.version, state.version!) > 0;
  const installable = releases.filter((r) => runsOn(r, system));
  // Sorted newest first, so the head is the one to offer.
  const latest = installable[0] ?? null;
  const top = releases[0] ?? null;
  const blocked = top && top !== latest && newer(top) ? top : null;

  // The download is code and travels further than the row does, so it is held
  // to the transport rule rather than inheriting the table's trust.
  if (latest) assertFetchable(latest.url, 'The download');

  const available = Boolean(latest && newer(latest));
  const missed = available
    ? installable.filter((r) => newer(r) && compareVersions(r.version, latest!.version) <= 0)
    : [];
  return {
    ...state,
    latest,
    available,
    checkedAt: Date.now(),
    channel,
    system,
    missed,
    critical: missed.some((r) => r.critical),
    releases,
    blocked,
  };
}
