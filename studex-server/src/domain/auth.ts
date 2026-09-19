import { config } from '../lib/config.js';
import { getDb, tx } from '../lib/db.js';
import { generateToken, hashToken, openSecret, sealSecret } from '../lib/crypto.js';
import { newId } from '../lib/ids.js';
import { burnPasswordCycle, hashPassword, verifyPassword } from '../lib/password.js';
import { conflict, forbidden, notFound, paymentRequired, tooManyRequests, unauthorized } from '../lib/errors.js';
import { isWeakPassword, normalizeEmail } from '../lib/validation.js';
import {
  supabaseGateway,
  type AuthGateway,
  type SupabaseIdentity,
  type SupabaseSession,
} from '../lib/supabase.js';

export interface User {
  id: string;
  email: string;
  display_name: string;
  plan: 'free' | 'pro';
  plan_renews_at: number | null;
  storage_used_bytes: number;
  storage_quota_bytes: number;
  created_at: number;
}

interface UserRow extends User {
  email_normalized: string;
  password_hash: string;
  supabase_user_id: string | null;
  failed_login_count: number;
  locked_until: number | null;
  updated_at: number;
}

export interface SessionRow {
  id: string;
  user_id: string;
  csrf_token_hash: string;
  idle_expires_at: number;
  absolute_expires_at: number;
  revoked_at: number | null;
  last_used_at: number;
}

export interface IssuedSession {
  sessionId: string;
  token: string;
  csrfToken: string;
  expiresAt: number;
  /**
   * How many other devices this sign-in signed out. Non-zero is worth telling
   * the person about: it is either their own older Mac, or someone they lent
   * the account to.
   */
  signedOutElsewhere: number;
}

const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ACCOUNT_FAILURES = 8;
const MAX_IP_FAILURES = 30;
const ACCOUNT_LOCK_MS = 15 * 60 * 1000;
/** Do not rewrite the session row on every request; slide at most this often. */
const SLIDE_WRITE_INTERVAL_MS = 60 * 1000;

/**
 * A user whose credentials live in Supabase has no local password, and this is
 * what stands in for one. It is not a hash of anything: argon2 cannot produce
 * an empty digest, so it can never be matched, and the login path refuses it
 * explicitly before verification is even attempted.
 */
const NO_LOCAL_PASSWORD = '';

let provider: 'local' | 'supabase' = config.authProvider;
let gateway: AuthGateway = supabaseGateway;

/** Which credential store this instance is checking against. */
export function authProvider(): 'local' | 'supabase' {
  return provider;
}

/**
 * Substitutes the identity provider. Passing a gateway switches this instance
 * to the Supabase flow using it; passing null restores whatever the
 * environment configured. Tests use it to exercise linking, confirmation and
 * error handling without a network.
 */
export function useAuthGateway(next: AuthGateway | null): void {
  gateway = next ?? supabaseGateway;
  provider = next ? 'supabase' : config.authProvider;
}

const PUBLIC_USER_COLUMNS = `
  id, email, display_name, plan, plan_renews_at,
  storage_used_bytes, storage_quota_bytes, created_at
`;

function recordAttempt(scope: 'account' | 'ip', key: string, succeeded: boolean): void {
  getDb()
    .prepare(
      'INSERT INTO auth_attempts (scope, key, succeeded, created_at) VALUES (?, ?, ?, ?)',
    )
    .run(scope, key, succeeded ? 1 : 0, Date.now());
}

function recentFailures(scope: 'account' | 'ip', key: string): number {
  const row = getDb()
    .prepare<[string, string, number], { n: number }>(
      `SELECT COUNT(*) AS n FROM auth_attempts
       WHERE scope = ? AND key = ? AND succeeded = 0 AND created_at > ?`,
    )
    .get(scope, key, Date.now() - ATTEMPT_WINDOW_MS);
  return row?.n ?? 0;
}

/** Removes attempt rows that have aged out of every window. */
export function pruneAuthAttempts(): number {
  const info = getDb()
    .prepare('DELETE FROM auth_attempts WHERE created_at < ?')
    .run(Date.now() - ATTEMPT_WINDOW_MS * 4);
  return info.changes;
}

/**
 * Whether this instance has been set up at all. A fresh desktop install has an
 * empty database, and the sign-in form would be a dead end there; this lets the
 * UI offer account creation instead. It discloses nothing about who those users
 * are, and no more than attempting to register would already reveal.
 */
export function hasAnyUser(): boolean {
  const row = getDb().prepare('SELECT 1 AS present FROM users LIMIT 1').get() as
    | { present: number }
    | undefined;
  return row !== undefined;
}

export type Plan = 'free' | 'pro';

/**
 * The one thing a plan actually changes on the server. Everything else the
 * tiers claim is copy, so it is not claimed at all: the Plan screen lists
 * storage and nothing more.
 */
export function planQuotaBytes(plan: Plan): number {
  return plan === 'pro' ? config.storageQuotaBytes * config.proQuotaMultiplier : config.storageQuotaBytes;
}

/**
 * Whether the account has been granted Pro, and the grant has not lapsed.
 *
 * Read from billing_entitlements rather than from `users.plan`, so the tier
 * the app runs as can never be its own justification for running as that tier.
 */
export function hasProEntitlement(userId: string, now = Date.now()): boolean {
  const row = getDb()
    .prepare<[string], { expires_at: number | null }>(
      "SELECT expires_at FROM billing_entitlements WHERE user_id = ? AND plan = 'pro'",
    )
    .get(userId);
  if (!row) return false;
  return row.expires_at === null || row.expires_at > now;
}

/**
 * Records that an account has been paid for.
 *
 * Nothing reachable from the app calls this — a checkout callback would, and
 * until there is one the licence script is the only caller. That is the point:
 * an upgrade has to arrive from outside the client.
 */
export function grantProEntitlement(
  userId: string,
  input: { source: 'purchase' | 'licence'; reference?: string | null; expiresAt?: number | null },
): void {
  getDb()
    .prepare(
      `INSERT INTO billing_entitlements (user_id, plan, source, reference, granted_at, expires_at)
       VALUES (?, 'pro', ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         plan = 'pro', source = excluded.source, reference = excluded.reference,
         granted_at = excluded.granted_at, expires_at = excluded.expires_at`,
    )
    .run(userId, input.source, input.reference ?? null, Date.now(), input.expiresAt ?? null);
}

/** Ends an entitlement. The account keeps its files and drops to Free. */
export function revokeProEntitlement(userId: string): void {
  getDb().prepare('DELETE FROM billing_entitlements WHERE user_id = ?').run(userId);
  const row = getDb()
    .prepare<[string], { plan: Plan }>('SELECT plan FROM users WHERE id = ?')
    .get(userId);
  if (row?.plan === 'pro') setPlan(userId, 'free');
}

/**
 * Moves the account between tiers and resizes its storage to match.
 *
 * A downgrade is allowed while over the new quota — the upload path already
 * refuses to add more, and deleting files is the user's own call. An upgrade
 * is not something a client may ask for: without an entitlement it is refused,
 * because otherwise the paid tier is a button rather than a purchase.
 */
export function setPlan(userId: string, plan: Plan): User {
  if (plan === 'pro' && !hasProEntitlement(userId)) {
    throw paymentRequired('Studex Pro has not been paid for on this account');
  }
  const now = Date.now();
  const info = getDb()
    .prepare(
      `UPDATE users
          SET plan = ?, storage_quota_bytes = ?, plan_renews_at = NULL, updated_at = ?
        WHERE id = ?`,
    )
    .run(plan, planQuotaBytes(plan), now, userId);
  if (info.changes === 0) throw notFound('User not found');
  const user = getUser(userId);
  if (!user) throw notFound('User not found');
  return user;
}

function toPublicUser(row: UserRow | User): User {
  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    plan: row.plan,
    plan_renews_at: row.plan_renews_at,
    storage_used_bytes: row.storage_used_bytes,
    storage_quota_bytes: row.storage_quota_bytes,
    created_at: row.created_at,
  };
}

/**
 * Holds an account to config.session.maxConcurrent live sessions by revoking
 * the least recently used ones once a new session joins. Sessions already
 * expired are left alone — they authorise nothing, and rewriting them would
 * only churn rows. Returns how many devices were signed out.
 */
function enforceSessionLimit(userId: string, keepSessionId: string, now: number): number {
  const limit = config.session.maxConcurrent;
  if (limit <= 0) return 0;

  const others = getDb()
    .prepare<[string, string, number, number], { id: string }>(
      `SELECT id FROM sessions
        WHERE user_id = ? AND id != ? AND revoked_at IS NULL
          AND idle_expires_at > ? AND absolute_expires_at > ?
        ORDER BY last_used_at DESC`,
    )
    .all(userId, keepSessionId, now, now);

  // The new session occupies one of the slots, so only limit - 1 others stay.
  const doomed = others.slice(Math.max(0, limit - 1));
  if (doomed.length === 0) return 0;

  const revoke = getDb().prepare(
    `UPDATE sessions SET revoked_at = ?, revoked_reason = 'signed_in_elsewhere'
      WHERE id = ? AND revoked_at IS NULL`,
  );
  for (const row of doomed) revoke.run(now, row.id);
  return doomed.length;
}

export function issueSession(userId: string, ip: string | null, ua: string | null): IssuedSession {
  const token = generateToken();
  const csrfToken = generateToken();
  const now = Date.now();
  const id = newId();
  const idleExpires = now + config.session.idleTtlMs;
  const absoluteExpires = now + config.session.absoluteTtlMs;

  // One transaction, so there is no instant where the account holds two live
  // sessions: whoever reads the table sees either the old device or the new.
  const signedOutElsewhere = tx(() => {
    getDb()
      .prepare(
        `INSERT INTO sessions
           (id, user_id, token_hash, csrf_token_hash, created_at, last_used_at,
            idle_expires_at, absolute_expires_at, ip, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        userId,
        hashToken(token),
        hashToken(csrfToken),
        now,
        now,
        idleExpires,
        absoluteExpires,
        ip,
        ua?.slice(0, 500) ?? null,
      );
    return enforceSessionLimit(userId, id, now);
  });

  return {
    sessionId: id,
    token,
    csrfToken,
    expiresAt: Math.min(idleExpires, absoluteExpires),
    signedOutElsewhere,
  };
}

async function registerLocal(input: {
  email: string;
  password: string;
  displayName: string;
  ip: string | null;
  userAgent: string | null;
}): Promise<{ user: User; session: IssuedSession }> {
  const normalized = normalizeEmail(input.email);

  const weak = isWeakPassword(input.password, normalized);
  if (weak) throw forbidden(weak);

  const passwordHash = await hashPassword(input.password);
  const now = Date.now();
  const userId = newId();

  const created = tx(() => {
    const existing = getDb()
      .prepare<[string], { id: string }>('SELECT id FROM users WHERE email_normalized = ?')
      .get(normalized);
    if (existing) return null;

    getDb()
      .prepare(
        `INSERT INTO users
           (id, email, email_normalized, password_hash, display_name, plan,
            storage_used_bytes, storage_quota_bytes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'free', 0, ?, ?, ?)`,
      )
      .run(
        userId,
        input.email.trim(),
        normalized,
        passwordHash,
        input.displayName,
        config.storageQuotaBytes,
        now,
        now,
      );

    getDb()
      .prepare('INSERT INTO user_settings (user_id, updated_at) VALUES (?, ?)')
      .run(userId, now);

    return getDb()
      .prepare<[string], User>(`SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = ?`)
      .get(userId)!;
  });

  // A duplicate address must not be distinguishable from a fresh signup by
  // anything the caller can observe other than this deliberate message.
  if (!created) throw conflict('That email address is already registered');

  const session = issueSession(created.id, input.ip, input.userAgent);
  return { user: toPublicUser(created), session };
}

/**
 * Finds, adopts or creates the local account behind a Supabase identity.
 *
 * Everything a user owns hangs off users.id, so a Supabase identity has to
 * resolve to exactly one local row. The supabase_user_id column is the durable
 * link; email is only ever used to adopt a row that predates it.
 */
function linkIdentity(identity: SupabaseIdentity): User {
  const normalized = normalizeEmail(identity.email);
  const now = Date.now();

  return tx(() => {
    const linked = getDb()
      .prepare<[string], UserRow>('SELECT * FROM users WHERE supabase_user_id = ?')
      .get(identity.id);

    if (linked) {
      // The provider owns the address and the display name; a change made
      // there should not leave this database showing the old one.
      const name = identity.displayName ?? linked.display_name;
      if (linked.email_normalized !== normalized || linked.display_name !== name) {
        getDb()
          .prepare(
            `UPDATE users SET email = ?, email_normalized = ?, display_name = ?, updated_at = ?
              WHERE id = ?`,
          )
          .run(identity.email, normalized, name, now, linked.id);
      }
      return getDb()
        .prepare<[string], User>(`SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = ?`)
        .get(linked.id)!;
    }

    const byEmail = getDb()
      .prepare<[string], UserRow>('SELECT * FROM users WHERE email_normalized = ?')
      .get(normalized);

    if (byEmail) {
      // Adoption hands one Supabase identity every file, deck and note already
      // sitting under that address. On the desktop app that is the whole point
      // — it is the user's own library, and the alternative is signing in to an
      // empty one. On a database holding more than one account it would be a
      // way to walk into someone else's, so it is allowed only where there is
      // no-one else to walk into.
      const others = getDb()
        .prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM users WHERE id != ?')
        .get(byEmail.id)!;

      // A row already naming a different identity is one of two things: a
      // stale link, because the Supabase account was deleted and remade and
      // that issues a fresh id, or somebody else's account. Nothing reachable
      // with the anon key can tell those apart — a deleted identity and an
      // unknown one look identical from here. So the same question decides it
      // as for a first adoption: is there anyone else here to take this from?
      //
      // Refusing a stale link instead stranded the account permanently: its
      // local password was cleared when it was first linked, so a row pointing
      // at a deleted identity could never be signed into again by any means.
      if (others.n > 0) {
        throw conflict(
          'That email address already belongs to an account on this server. ' +
            'Sign in with its existing password, or use a different address.',
        );
      }

      getDb()
        .prepare(
          `UPDATE users
              SET supabase_user_id = ?, email = ?, display_name = ?,
                  password_hash = ?, failed_login_count = 0, locked_until = NULL,
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(
          identity.id,
          identity.email,
          identity.displayName ?? byEmail.display_name,
          // The old local password stops being a way in: Supabase is the only
          // thing that can authenticate this account from here on.
          NO_LOCAL_PASSWORD,
          now,
          byEmail.id,
        );

      return getDb()
        .prepare<[string], User>(`SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = ?`)
        .get(byEmail.id)!;
    }

    const userId = newId();
    getDb()
      .prepare(
        `INSERT INTO users
           (id, email, email_normalized, password_hash, display_name, plan,
            storage_used_bytes, storage_quota_bytes, created_at, updated_at,
            supabase_user_id)
         VALUES (?, ?, ?, ?, ?, 'free', 0, ?, ?, ?, ?)`,
      )
      .run(
        userId,
        identity.email,
        normalized,
        NO_LOCAL_PASSWORD,
        identity.displayName ?? identity.email.split('@')[0]!.slice(0, 80),
        config.storageQuotaBytes,
        now,
        now,
        identity.id,
      );

    getDb()
      .prepare('INSERT INTO user_settings (user_id, updated_at) VALUES (?, ?)')
      .run(userId, now);

    return getDb()
      .prepare<[string], User>(`SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = ?`)
      .get(userId)!;
  });
}

/**
 * Stores the Supabase session for an account, sealed.
 *
 * Refresh tokens rotate on every use, so this is called after each refresh as
 * well as at sign-in; storing a superseded one means the next call fails.
 */
export function rememberSupabaseSession(userId: string, session: SupabaseSession | null): void {
  if (!session) return;
  getDb()
    .prepare(
      `INSERT INTO supabase_tokens (user_id, access_token, refresh_token, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         access_token = excluded.access_token,
         refresh_token = excluded.refresh_token,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`,
    )
    .run(
      userId,
      sealSecret(session.accessToken),
      sealSecret(session.refreshToken),
      session.expiresAt,
      Date.now(),
    );
}

export function readSupabaseSession(userId: string): SupabaseSession | null {
  const row = getDb()
    .prepare<[string], { access_token: string; refresh_token: string; expires_at: number }>(
      'SELECT access_token, refresh_token, expires_at FROM supabase_tokens WHERE user_id = ?',
    )
    .get(userId);
  if (!row) return null;

  const accessToken = openSecret(row.access_token);
  const refreshToken = openSecret(row.refresh_token);
  if (!accessToken || !refreshToken) {
    // Sealed under a secret this process no longer has, or tampered with.
    // Either way it is not a credential any more; drop it rather than keep
    // handing an unusable token to callers.
    forgetSupabaseSession(userId);
    return null;
  }
  return { accessToken, refreshToken, expiresAt: row.expires_at };
}

export function forgetSupabaseSession(userId: string): void {
  getDb().prepare('DELETE FROM supabase_tokens WHERE user_id = ?').run(userId);
}

export type RegisterResult =
  | { status: 'signed-in'; user: User; session: IssuedSession }
  /** Supabase accepted the account but is waiting on a confirmation email. */
  | { status: 'confirm-email' };

export async function register(input: {
  email: string;
  password: string;
  displayName: string;
  ip: string | null;
  userAgent: string | null;
}): Promise<RegisterResult> {
  if (provider === 'local') {
    const { user, session } = await registerLocal(input);
    return { status: 'signed-in', user, session };
  }

  const weak = isWeakPassword(input.password, normalizeEmail(input.email));
  if (weak) throw forbidden(weak);

  const outcome = await gateway.signUp({
    email: normalizeEmail(input.email),
    password: input.password,
    displayName: input.displayName,
  });

  if (!outcome.identity) return { status: 'confirm-email' };

  const user = linkIdentity(outcome.identity);
  rememberSupabaseSession(user.id, outcome.session);
  return {
    status: 'signed-in',
    user,
    session: issueSession(user.id, input.ip, input.userAgent),
  };
}

async function loginLocal(input: {
  email: string;
  password: string;
  ip: string | null;
  userAgent: string | null;
}): Promise<{ user: User; session: IssuedSession }> {
  const normalized = normalizeEmail(input.email);
  const ipKey = input.ip ?? 'unknown';

  if (recentFailures('ip', ipKey) >= MAX_IP_FAILURES) {
    throw tooManyRequests('Too many failed sign-in attempts. Try again later.');
  }

  const row = getDb()
    .prepare<[string], UserRow>('SELECT * FROM users WHERE email_normalized = ?')
    .get(normalized);

  const now = Date.now();

  if (!row) {
    // Spend the same work as a real verification so timing does not reveal
    // whether the address exists.
    await burnPasswordCycle(input.password);
    recordAttempt('ip', ipKey, false);
    throw unauthorized('Incorrect email or password');
  }

  // A Supabase-backed account has no local password to check. Refusing it here
  // rather than letting argon2 fail on an empty digest keeps the reason out of
  // the response and out of the timing: it costs the same and says the same.
  if (row.password_hash === NO_LOCAL_PASSWORD) {
    await burnPasswordCycle(input.password);
    recordAttempt('ip', ipKey, false);
    throw unauthorized('Incorrect email or password');
  }

  if (row.locked_until && row.locked_until > now) {
    recordAttempt('ip', ipKey, false);
    throw tooManyRequests('Account temporarily locked after repeated failed attempts');
  }

  const ok = await verifyPassword(row.password_hash, input.password);

  if (!ok) {
    recordAttempt('ip', ipKey, false);
    recordAttempt('account', row.id, false);
    const failures = recentFailures('account', row.id);
    if (failures >= MAX_ACCOUNT_FAILURES) {
      getDb()
        .prepare('UPDATE users SET locked_until = ?, failed_login_count = ?, updated_at = ? WHERE id = ?')
        .run(now + ACCOUNT_LOCK_MS, failures, now, row.id);
    }
    throw unauthorized('Incorrect email or password');
  }

  getDb()
    .prepare('UPDATE users SET failed_login_count = 0, locked_until = NULL, updated_at = ? WHERE id = ?')
    .run(now, row.id);
  recordAttempt('ip', ipKey, true);
  recordAttempt('account', row.id, true);

  const session = issueSession(row.id, input.ip, input.userAgent);
  return { user: toPublicUser(row), session };
}

export async function login(input: {
  email: string;
  password: string;
  ip: string | null;
  userAgent: string | null;
}): Promise<{ user: User; session: IssuedSession }> {
  if (provider === 'local') return loginLocal(input);

  // Supabase runs its own rate limiting, but this endpoint is reachable
  // without it, so the local per-ip window still guards the door. Per-account
  // lockout does not apply: a failed sign-in yields no account to lock.
  const ipKey = input.ip ?? 'unknown';
  if (recentFailures('ip', ipKey) >= MAX_IP_FAILURES) {
    throw tooManyRequests('Too many failed sign-in attempts. Try again later.');
  }

  let outcome;
  try {
    outcome = await gateway.signIn({
      email: normalizeEmail(input.email),
      password: input.password,
    });
  } catch (err) {
    recordAttempt('ip', ipKey, false);
    throw err;
  }

  recordAttempt('ip', ipKey, true);
  const user = linkIdentity(outcome.identity);
  recordAttempt('account', user.id, true);
  rememberSupabaseSession(user.id, outcome.session);
  return { user, session: issueSession(user.id, input.ip, input.userAgent) };
}

/**
 * Resolves a bearer session token to its user, sliding the idle window.
 * Returns null for anything expired, revoked or unknown — callers turn that
 * into a 401 without distinguishing the cases.
 */
export function authenticate(token: string): { user: User; session: SessionRow } | null {
  const now = Date.now();
  const session = getDb()
    .prepare<[string], SessionRow>(
      `SELECT id, user_id, csrf_token_hash, idle_expires_at, absolute_expires_at,
              revoked_at, last_used_at
       FROM sessions WHERE token_hash = ?`,
    )
    .get(hashToken(token));

  if (!session) return null;
  if (session.revoked_at !== null) return null;
  if (session.idle_expires_at <= now) return null;
  if (session.absolute_expires_at <= now) return null;

  const user = getDb()
    .prepare<[string], User>(`SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = ?`)
    .get(session.user_id);
  if (!user) return null;

  if (now - session.last_used_at > SLIDE_WRITE_INTERVAL_MS) {
    const slid = Math.min(now + config.session.idleTtlMs, session.absolute_expires_at);
    getDb()
      .prepare('UPDATE sessions SET last_used_at = ?, idle_expires_at = ? WHERE id = ?')
      .run(now, slid, session.id);
    session.last_used_at = now;
    session.idle_expires_at = slid;
  }

  return { user, session };
}

/**
 * Why a token stopped working, for the one case worth naming: the account
 * signed in somewhere else. Everything else — expiry, logout, an unknown
 * token — stays indistinguishable, which is what keeps a 401 uninformative
 * to anyone guessing tokens.
 */
export function revocationReason(token: string): string | null {
  const row = getDb()
    .prepare<[string], { revoked_reason: string | null }>(
      'SELECT revoked_reason FROM sessions WHERE token_hash = ? AND revoked_at IS NOT NULL',
    )
    .get(hashToken(token));
  return row?.revoked_reason ?? null;
}

export function revokeSession(sessionId: string): void {
  getDb()
    .prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(Date.now(), sessionId);
}

/** Used on password change: every other device is signed out. */
export function revokeAllSessions(userId: string, exceptSessionId?: string): number {
  const info = exceptSessionId
    ? getDb()
        .prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL')
        .run(Date.now(), userId, exceptSessionId)
    : getDb()
        .prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
        .run(Date.now(), userId);
  return info.changes;
}

export function listSessions(userId: string, currentSessionId: string) {
  return getDb()
    .prepare<[string, number], {
      id: string;
      created_at: number;
      last_used_at: number;
      ip: string | null;
      user_agent: string | null;
    }>(
      `SELECT id, created_at, last_used_at, ip, user_agent
       FROM sessions
       WHERE user_id = ? AND revoked_at IS NULL AND idle_expires_at > ?
       ORDER BY last_used_at DESC`,
    )
    .all(userId, Date.now())
    .map((s) => ({ ...s, current: s.id === currentSessionId }));
}

export async function changePassword(input: {
  userId: string;
  currentPassword: string;
  newPassword: string;
  keepSessionId: string;
}): Promise<void> {
  const row = getDb()
    .prepare<[string], UserRow>('SELECT * FROM users WHERE id = ?')
    .get(input.userId);
  if (!row) throw unauthorized();

  const weakness = isWeakPassword(input.newPassword, row.email_normalized);
  if (weakness) throw forbidden(weakness);

  if (row.supabase_user_id !== null) {
    // The credential lives in Supabase; changing it here would change nothing.
    // The gateway proves the current password by signing in with it, which is
    // the same evidence verifyPassword gives on the local path.
    const rotated = await gateway.changePassword({
      email: row.email,
      currentPassword: input.currentPassword,
      newPassword: input.newPassword,
    });
    rememberSupabaseSession(input.userId, rotated);
    revokeAllSessions(input.userId, input.keepSessionId);
    return;
  }

  const ok = await verifyPassword(row.password_hash, input.currentPassword);
  if (!ok) throw unauthorized('Current password is incorrect');

  const hash = await hashPassword(input.newPassword);
  getDb()
    .prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .run(hash, Date.now(), input.userId);

  // Anything that had the old credential loses access immediately.
  revokeAllSessions(input.userId, input.keepSessionId);
}

export function getUser(userId: string): User | null {
  return (
    getDb()
      .prepare<[string], User>(`SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = ?`)
      .get(userId) ?? null
  );
}
