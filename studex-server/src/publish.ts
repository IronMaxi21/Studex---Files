/**
 * Sends an update out.
 *
 * One row in public.releases is how every Mac learns there is a newer Studex.
 * Shipping a version is two commands: publish it, which uploads the zip to the
 * project's storage and writes the row as pending, and approve it, which
 * downloads the file back, checks it against the row, and only then lets
 * every running copy see it.
 *
 *   npm run publish:release -- --version 1.1.0 \
 *                      --zip ../studex-mac/dist/Studex-1.1.0.zip \
 *                      --notes-file ../studex-mac/dist/notes-1.1.0.md
 *   npm run publish:release -- --list
 *   npm run publish:release -- --approve 1.1.0
 *   npm run publish:release -- --reject 1.1.0     (also pulls an approved one)
 *
 * --zip is hashed and uploaded to the `releases` bucket. To host it somewhere
 * else instead, pass --url where it already is; if you have the hash but not
 * the file, pass --sha256 (and --size) with --url.
 *
 * --dmg uploads the disk image beside the zip, so the website and a fresh
 * install get the same version the updater offers. With --url the image is not
 * uploaded either; --dmg-url says where it already is. --channel beta keeps a
 * release to Macs that opted into betas; --critical installs it without
 * waiting for the student.
 *
 * The zip is signed with the Ed25519 key in ~/.studex-release (make one once
 * with --gen-keys; the build bakes the public half into the app). After every
 * approve or reject the feeds — appcast.xml, appcast-beta.xml, releases.json,
 * latest-mac.json — are regenerated into the bucket, and into --site <dir>
 * when given. --sync-feeds does only that.
 *
 * --dry-run prints the row and writes nothing, which is the sensible first
 * run every time.
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment. The
 * service role key is a real credential: it belongs on the machine cutting
 * the release and nowhere near the bundle being shipped.
 */
import os from 'node:os';
import path from 'node:path';

import { config } from './lib/config.js';
import { ApiError } from './lib/errors.js';
import {
  approveRelease, digestOf, generateSigningKeys, keyPaths, loadPrivateKey, publishRelease, rejectRelease,
  signFile, statusOf, storageUrlFor, supabasePublisher, syncFeeds,
  type ReleasePublisher,
} from './domain/publish.js';
import { newestOf } from './domain/updates.js';

const USAGE = `Usage:
  npm run publish:release -- --version <v> --zip <file> [--url <https://…>]
                     [--notes <text> | --notes-file <path>] [--min-macos <version>]
                     [--dmg <file> [--dmg-url <https://…>]] [--channel stable|beta] [--critical] [--no-sign] [--dry-run]
  npm run publish:release -- --version <v> --url <https://…> --sha256 <hex> [--size <bytes>] …
  npm run publish:release -- --list
  npm run publish:release -- --approve <v>
  npm run publish:release -- --reject <v>
  npm run publish:release -- --sync-feeds [--site <dir>]
  npm run publish:release -- --gen-keys          (once; keys go in ~/.studex-release)

  --approve, --reject and --sync-feeds take --site <dir> to write the feeds
  into the website's downloads folder as well.`;

/** `--flag value`, with `--flag` on its own meaning true. */
function parseArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith('--')) {
      fail(`Unexpected argument "${token}".`);
    }
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args.set(name, 'true');
    } else {
      args.set(name, next);
      i += 1;
    }
  }
  return args;
}

function fail(message: string): never {
  console.error(message);
  console.error(USAGE);
  process.exit(2);
}

const args = parseArgs(process.argv.slice(2));
if (args.has('help') || args.size === 0) {
  console.log(USAGE);
  process.exit(0);
}

/** The owner-level publisher, or a clear exit saying why there is none. */
function publisherOrExit(): ReleasePublisher {
  const publisher = supabasePublisher();
  if (publisher) return publisher;
  console.error(
    config.supabase
      ? 'SUPABASE_SERVICE_ROLE_KEY is not set, so there is nothing here permitted to change releases.'
      : 'SUPABASE_URL and SUPABASE_ANON_KEY are not set, so there is no project to publish to.',
  );
  process.exit(1);
}

const keyDir = process.env.STUDEX_RELEASE_DIR ?? path.join(os.homedir(), '.studex-release');

function stringArg(name: string): string | undefined {
  const value = args.get(name);
  return value && value !== 'true' ? value : undefined;
}

async function feeds(publisher: ReleasePublisher): Promise<void> {
  const siteDir = stringArg('site');
  const wrote = await syncFeeds(publisher, { siteDir, link: stringArg('link') });
  console.log(wrote.length
    ? `Feeds refreshed:\n${wrote.map((w) => `  ${w}`).join('\n')}`
    : 'Nowhere to write the feeds: no bucket access and no --site.');
}

function versionArg(name: string): string {
  const value = args.get(name);
  if (!value || value === 'true') fail(`--${name} needs a version.`);
  return value;
}

async function manage(): Promise<boolean> {
  if (args.has('gen-keys')) {
    const { publicKey, created } = await generateSigningKeys(keyDir);
    const paths = keyPaths(keyDir);
    // The public half only. The private key stays in its file, mode 600.
    console.log(created ? 'Created a signing key pair.' : 'A signing key already exists; kept it.');
    console.log(`  private  ${paths.privateKey}  (keep it secret, back it up — losing it strands every install)`);
    console.log(`  public   ${publicKey}`);
    console.log('Rebuild the app so the public key is baked into it.');
    return true;
  }
  if (args.has('sync-feeds')) {
    await feeds(publisherOrExit());
    return true;
  }
  if (args.has('list')) {
    const rows = await publisherOrExit().recent();
    if (rows.length === 0) console.log('No releases yet.');
    for (const row of rows) {
      const { latest } = newestOf([row]);
      const label = latest ? latest.version : String((row as { version?: unknown }).version);
      const tags = [
        latest?.channel === 'beta' ? 'beta' : '',
        latest?.critical ? 'critical' : '',
        latest?.signature ? 'signed' : 'unsigned',
        latest?.dmgUrl ? 'dmg' : '',
      ].filter(Boolean).join(', ');
      console.log(`  ${statusOf(row).padEnd(9)} ${label.padEnd(14)} ${(latest?.publishedAt ?? '').padEnd(26)} ${tags}`);
    }
    return true;
  }
  if (args.has('approve')) {
    const v = versionArg('approve');
    console.log(`Downloading ${v} to check it against its row…`);
    const publisher = publisherOrExit();
    const { replaces } = await approveRelease(v, publisher);
    console.log(replaces
      ? `Approved ${v}. Every copy on ${replaces.version} or earlier will offer it at its next check.`
      : `Approved ${v}. Every running copy will offer it at its next check.`);
    await feeds(publisher);
    return true;
  }
  if (args.has('reject')) {
    const v = versionArg('reject');
    const publisher = publisherOrExit();
    const { was } = await rejectRelease(v, publisher);
    console.log(was === 'approved'
      ? `Rejected ${v}. It is no longer offered; copies that already installed it keep it.`
      : `Rejected ${v}. It will never be offered.`);
    if (was === 'approved') await feeds(publisher);
    return true;
  }
  return false;
}

const managing = ['list', 'approve', 'reject', 'gen-keys', 'sync-feeds'].some((f) => args.has(f));

const version = args.get('version');
const zipPath = args.get('zip');
const givenHash = args.get('sha256');
const givenUrl = args.get('url');
if (!managing) {
  if (!version || version === 'true') fail('--version is required.');
  if (!zipPath && !givenHash) fail('Pass --zip <file> so the checksum is computed, or --sha256 <hex>.');
  if (zipPath && givenHash) fail('Pass --zip or --sha256, not both — they would have to agree.');
  if (!zipPath && (!givenUrl || givenUrl === 'true')) fail('With --sha256 there is nothing to upload, so --url is required.');
}

/** Uploading is the default whenever there is a file and no URL elsewhere. */
const uploading = !givenUrl || givenUrl === 'true';
const fileName = `Studex-${version}.zip`;
const placeholder = (name: string) => `https://<project>.supabase.co/storage/v1/object/public/releases/${name}`;
const url = uploading ? storageUrlFor(fileName) ?? placeholder(fileName) : givenUrl;

const dmgPath = stringArg('dmg');
const dmgName = `Studex-${version}.dmg`;
const dmgUrlGiven = stringArg('dmg-url');
if (!managing && dmgUrlGiven && !dmgUrlGiven.startsWith('https://')) fail('--dmg-url must be https.');
if (!managing && dmgUrlGiven && uploading) fail('--dmg-url goes with --url: without it, the image is uploaded beside the zip.');
const channel = stringArg('channel') ?? 'stable';
if (!managing && channel !== 'stable' && channel !== 'beta') fail('--channel is stable or beta.');

const notesFile = args.get('notes-file');
const dryRun = args.get('dry-run') === 'true';

async function notes(): Promise<string | undefined> {
  if (notesFile && notesFile !== 'true') {
    const { readFile } = await import('node:fs/promises');
    return (await readFile(notesFile, 'utf8')).trim() || undefined;
  }
  const inline = args.get('notes');
  return inline && inline !== 'true' ? inline : undefined;
}

async function main(): Promise<void> {
  if (await manage()) return;
  const measured = zipPath && zipPath !== 'true' ? await digestOf(zipPath) : null;
  const size = measured?.size ?? Number(args.get('size') ?? NaN);

  const dmg = dmgPath ? await digestOf(dmgPath) : null;

  // Signed whenever there is a key and a file; a missing key is said out loud,
  // because an app built with a public key refuses an unsigned zip.
  let signature: string | undefined;
  if (zipPath && zipPath !== 'true' && !args.has('no-sign')) {
    const { privateKey } = keyPaths(keyDir);
    try {
      signature = await signFile(zipPath, await loadPrivateKey(privateKey));
    } catch (err) {
      console.warn(`! Not signed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const release = {
    version,
    url,
    sha256: measured?.sha256 ?? givenHash,
    notes: await notes(),
    minimumSystemVersion: stringArg('min-macos'),
    size: Number.isFinite(size) && size > 0 ? Math.floor(size) : undefined,
    channel,
    critical: args.has('critical') || undefined,
    signature,
    dmgUrl: !dmg ? undefined : uploading ? storageUrlFor(dmgName) ?? placeholder(dmgName) : dmgUrlGiven,
    dmgSha256: dmg?.sha256,
    dmgSize: dmg?.size,
  };

  // Before the project is consulted at all: a dry run is how you check the
  // hash and the URL, and it must work on a machine that has no key to
  // publish with.
  if (dryRun) {
    console.log('Dry run — nothing was written.');
    describe(release);
    return;
  }

  // The hash is printed before the project is consulted, so it is on screen
  // even when there turns out to be no key to publish with.
  describe(release);
  const publisher = publisherOrExit();

  if (uploading) console.log(`Uploading ${fileName}…`);
  const { previous } = await publishRelease(release, publisher, {
    upload: uploading && zipPath && publisher.upload
      ? async () => {
        const landed = await publisher.upload!(fileName, zipPath);
        if (dmgPath) {
          console.log(`Uploading ${dmgName}…`);
          await publisher.upload!(dmgName, dmgPath);
        }
        return landed;
      }
      : undefined,
  });
  console.log(
    previous
      ? `\nPublished ${release.version} as pending. The newest before it is ${previous.version}.`
      : `\nPublished ${release.version} as pending. It is the first release in this project.`,
  );
  console.log('Nobody is offered it yet. Install it on a test Mac from the URL above if you want to');
  console.log(`try it first, then release it with:\n\n  npm run publish:release -- --approve ${release.version}`);
}

function describe(release: Record<string, unknown>): void {
  console.log(`  version  ${release.version}`);
  console.log(`  url      ${release.url}`);
  console.log(`  sha256   ${release.sha256}`);
  if (release.size) console.log(`  size     ${(Number(release.size) / 1e6).toFixed(1)} MB`);
  if (release.minimumSystemVersion) console.log(`  macOS    ${release.minimumSystemVersion}+`);
  console.log(`  channel  ${release.channel ?? 'stable'}${release.critical ? ' (critical)' : ''}`);
  console.log(`  signed   ${release.signature ? 'yes (Ed25519)' : 'no'}`);
  if (release.dmgUrl) console.log(`  dmg      ${release.dmgUrl}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof ApiError || err instanceof Error ? err.message : String(err));
  process.exit(1);
});
