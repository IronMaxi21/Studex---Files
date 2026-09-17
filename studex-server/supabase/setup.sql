-- Studex — the parts of the Supabase project that are not the app's to create.
--
-- Run this once, in the SQL editor, as the project owner. It is written to be
-- safe to run again: everything is IF NOT EXISTS or a re-grant.
--
-- Three separate things live here.
--   1. The grants library_items has been missing, which is why sync fails.
--   2. The releases table the Updates screen reads, its approval step, and
--      the storage bucket updates are uploaded to.
--   3. The replication settings that let a running app be told a row moved.

/* ── 1. why sync says "permission denied for table library_items" ────────
 *
 * Row-level security narrows what a role may reach. It does not hand the role
 * any privilege to begin with — that is what GRANT is for, and the two are
 * easy to confuse because the dashboard shows RLS and its policies prominently
 * and shows grants nowhere.
 *
 * library_items has its four per-user policies in place and correct, and
 * `authenticated` holds only REFERENCES, TRIGGER and TRUNCATE on it: no
 * SELECT, no INSERT, no UPDATE, no DELETE. Every sync therefore fails at the
 * first statement with "permission denied for table library_items", while
 * every policy on screen looks right.
 */
grant select, insert, update, delete on table public.library_items to authenticated;

-- Nothing signed out has any business in someone's library. The policies
-- already require auth.uid(), so this is belt and braces rather than a change
-- in what anyone can reach.
revoke all on table public.library_items from anon;

-- Same reasoning: a helper that turns RLS on has no reason to be callable by
-- the public.
revoke execute on function public.rls_auto_enable() from anon, authenticated;


/* ── 2. releases ─────────────────────────────────────────────────────────
 *
 * Where a newer Studex comes from. One row per version; the app asks for the
 * most recent twenty and picks the highest version number itself, so a row
 * entered out of order cannot offer anyone a downgrade.
 *
 * Deliberately world-readable. A Mac that has been signed out for a month
 * should still learn there is a new version, so the check is made with the
 * publishable anon key and no session. Nothing here is private: it is a
 * version number, a public download URL and its checksum.
 *
 * Writing is another matter — this table decides what code every install runs
 * — so inserting a release is the project owner's job through the dashboard or
 * the service role, and no policy below permits anyone else to.
 */
create table if not exists public.releases (
  id                     uuid primary key default gen_random_uuid(),
  version                text not null,
  -- The zipped .app. https, because an update is code.
  url                    text not null check (url like 'https://%'),
  -- sha256 of the zip, lowercase hex. The shell refuses a download whose bytes
  -- do not hash to this, so a wrong value here is a release nobody can install
  -- rather than a release anybody can tamper with.
  sha256                 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  notes                  text,
  size                   bigint,
  minimum_system_version text,
  published_at           timestamptz not null default now(),
  created_at             timestamptz not null default now()
);

create unique index if not exists releases_version_key on public.releases (version);
create index if not exists releases_published_at_idx on public.releases (published_at desc);

alter table public.releases enable row level security;

/* ── 2b. approval ────────────────────────────────────────────────────────
 *
 * A release is published as pending and nobody is offered it until it is
 * approved. `npm run publish:release -- --approve <v>` downloads the file back,
 * checks it against the row, and only then flips the status; `--reject <v>`
 * takes a version out again, including one already approved.
 *
 * Rows that existed before this column did were live, so they are backfilled
 * as approved; only the default for new rows is pending. Running this twice
 * leaves both exactly as they are.
 */
alter table public.releases add column if not exists status text not null default 'approved';
alter table public.releases alter column status set default 'pending';
alter table public.releases add column if not exists approved_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.releases'::regclass and conname = 'releases_status_check'
  ) then
    alter table public.releases
      add constraint releases_status_check check (status in ('pending', 'approved', 'rejected'));
  end if;
end
$$;

create index if not exists releases_status_idx on public.releases (status, published_at desc);

-- The public can see approved releases and nothing else. A pending build is
-- not a secret — its zip sits at a public URL — but it is not an offer.
drop policy if exists "releases are public" on public.releases;
drop policy if exists "approved releases are public" on public.releases;
create policy "approved releases are public" on public.releases
  for select to anon, authenticated using (status = 'approved');

-- Read only, and only ever read. Publishing and approving are done as the owner.
grant select on table public.releases to anon, authenticated;
revoke insert, update, delete on table public.releases from anon, authenticated;
-- Publishing and approving run as the service role. It bypasses RLS but still
-- needs table privileges, which this project does not hand out by default.
grant select, insert, update, delete on table public.releases to service_role;

/* ── 2c. channels, signatures and disk images ────────────────────────────
 *
 * A release can be kept to Macs that opted into betas, marked critical so it
 * installs without waiting, carry an Ed25519 signature of its zip (checked by
 * the app against the public key baked in at build time), and name the disk
 * image the website hands to fresh installs. All optional: a row without them
 * is a stable, non-critical release, exactly as before.
 */
alter table public.releases add column if not exists channel text not null default 'stable';
alter table public.releases add column if not exists critical boolean not null default false;
alter table public.releases add column if not exists signature text;
alter table public.releases add column if not exists dmg_url text;
alter table public.releases add column if not exists dmg_sha256 text;
alter table public.releases add column if not exists dmg_size bigint;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.releases'::regclass and conname = 'releases_channel_check'
  ) then
    alter table public.releases
      add constraint releases_channel_check check (channel in ('stable', 'beta'));
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.releases'::regclass and conname = 'releases_dmg_check'
  ) then
    alter table public.releases
      add constraint releases_dmg_check check (
        (dmg_url is null or dmg_url like 'https://%')
        and (dmg_sha256 is null or dmg_sha256 ~ '^[0-9a-f]{64}$')
      );
  end if;
end $$;

-- Where publish uploads the zip, the disk image and the generated feeds
-- (appcast.xml, appcast-beta.xml, releases.json, latest-mac.json). Public, because an app that is signed out
-- still has to be able to download its update; written only by the service
-- role, which bypasses storage policies, so no insert policy is created for
-- anyone else. 500 MB is a ceiling for the bucket — the project's global
-- upload limit (Storage settings) must be at least the size of the zip.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('releases', 'releases', true, 524288000,
        array['application/zip', 'application/x-apple-diskimage', 'application/xml', 'application/json'])
on conflict (id) do update
  set public = true, file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;


/* ── publishing a version ────────────────────────────────────────────────
 *
 * Not by hand, if it can be helped. studex-mac/build/publish-release.sh cuts
 * the zip, hashes the bytes it just wrote, uploads it to the bucket above and
 * inserts the row as pending:
 *
 *   ./build/publish-release.sh --build --notarize
 *   ./build/publish-release.sh --approve 1.1.0
 *
 * which run `npm run publish:release`, using SUPABASE_SERVICE_ROLE_KEY. That
 * path refuses a version that is not newer than the one already out and a
 * download URL that is not https, and it cannot mistype a checksum, which is
 * the way a release usually goes wrong.
 *
 * The rows it writes, should they ever have to be written by hand:
 *
 * insert into public.releases (version, url, sha256, notes, size, status)
 * values (
 *   '1.1.0',
 *   'https://<project>.supabase.co/storage/v1/object/public/releases/Studex-1.1.0.zip',
 *   '<shasum -a 256 Studex-1.1.0.zip>',
 *   'What changed.',
 *   <bytes>,
 *   'pending'
 * );
 * update public.releases set status = 'approved', approved_at = now() where version = '1.1.0';
 */


/* ── 3. so that a change on one Mac reaches the other one now ────────────
 *
 * Studex has always synced on a timer, and the shortest interval anyone would
 * sensibly pick is five minutes. That is fine for a Mac that was asleep and is
 * hopeless for two that are both open: an edit made on the desk sits there
 * until the other machine's turn comes round.
 *
 * The fix is for the project to say something changed. Realtime does that by
 * reading the write-ahead log, and it only reads tables that have been added
 * to its publication — which is why this is here and not in the app: adding a
 * table to a publication is an owner's statement about the database, not
 * something a client should be able to do to it.
 *
 * REPLICA IDENTITY FULL is the less obvious half. Without it a DELETE carries
 * only the primary key, and the row's user_id — the thing every subscription
 * filters on — is not in it. The result is a delete that reaches nobody, so
 * the file that vanished upstream stays in the library until the next timed
 * sync. The cost is that updates and deletes write the old row to the log as
 * well as the new one; for a library of file records that is negligible.
 *
 * Both statements are safe to run again.
 */

alter table public.library_items replica identity full;

do $$
begin
  if not exists (
    select 1
      from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'library_items'
  ) then
    alter publication supabase_realtime add table public.library_items;
  end if;
end
$$;

/* Realtime authorises a subscriber with the access token the socket presents,
 * and evaluates the same row-level security policies as any other read. The
 * SELECT policy granted in section 1 is therefore what decides which rows a
 * student is told about: their own, and nobody else's. Nothing further needs
 * granting here. */
