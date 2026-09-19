import { randomBytes } from 'node:crypto';
import path from 'node:path';

function required(name: string, value: string | undefined): string {
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example.`,
    );
  }
  return value.trim();
}

const NODE_ENV = process.env.NODE_ENV ?? 'development';
const isProd = NODE_ENV === 'production';
const isTest = NODE_ENV === 'test';

/**
 * In production the session secret must be supplied. In development/test we
 * generate an ephemeral one so the server boots, at the cost of invalidating
 * sessions on restart — which is the safe direction to fail.
 */
function sessionSecret(): string {
  const fromEnv = process.env.SESSION_SECRET?.trim();
  if (isProd) {
    const secret = required('SESSION_SECRET', fromEnv);
    if (Buffer.from(secret, 'utf8').byteLength < 32) {
      throw new Error('SESSION_SECRET must be at least 32 bytes.');
    }
    return secret;
  }
  return fromEnv && fromEnv.length >= 32 ? fromEnv : randomBytes(32).toString('hex');
}

/**
 * Directory holding the built desktop UI. When set, the server also serves the
 * app shell; when unset it stays a pure JSON API. The Mac app sets this to the
 * `web` folder inside its own bundle.
 */
function webDir(): string | null {
  const raw = process.env.WEB_DIR?.trim();
  return raw ? path.resolve(raw) : null;
}

function corsOrigins(webRoot: string | null, host: string, port: number): string[] {
  const raw = process.env.CORS_ORIGINS?.trim();
  const configured = raw
    ? raw.split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean)
    : isProd
      ? []
      : ['http://localhost:5173'];

  // When the UI is served from this process it is same-origin, so its own
  // origin has to be on the allowlist — that list doubles as the Origin
  // check for CSRF, and the browser sends a real Origin on same-origin POSTs.
  if (!webRoot) return configured;
  const own = [`http://${host}:${port}`, `http://localhost:${port}`];
  return [...new Set([...configured, ...own])];
}

/** Addresses that never leave the machine. */
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * The Secure cookie attribute is a statement about transport, not about
 * environment. The desktop app runs a production build but serves itself over
 * http on loopback, where there is no network to intercept and TLS would buy
 * nothing; marking the session cookie Secure there just means the browser
 * refuses to store it and sign-in silently fails. So it follows isProd by
 * default and may be turned off explicitly — but only on a loopback bind,
 * which is the single case where dropping it costs nothing.
 */
function cookieSecure(host: string): boolean {
  const raw = process.env.COOKIE_SECURE?.trim().toLowerCase();
  if (!raw) return isProd;
  const wanted = raw === 'true' || raw === '1';
  if (!wanted && isProd && !LOOPBACK.has(host)) {
    throw new Error(
      'COOKIE_SECURE=false is only permitted when HOST is a loopback address.',
    );
  }
  return wanted;
}

/** `true`/`false` from the environment, with everything else left to the caller. */
function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`${name} must be true or false`);
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
  return Math.floor(n);
}

/**
 * Supabase as the identity provider. Both values are required together: a
 * half-configured install would boot happily and then fail every sign-in, so
 * it is refused here instead.
 *
 * The anon key is a publishable credential — it is designed to sit in client
 * code, and it grants only what row-level security in the Supabase project
 * allows. It is still kept server-side, because Studex's own session cookie is
 * what authorises requests and the key has no reason to reach the WebView.
 *
 * Unset, the server keeps its own argon2 credentials. That is what every
 * existing install is, and it is the only mode that works with no network.
 */
function supabaseSettings(): {
  url: string;
  anonKey: string;
  serviceKey: string | null;
  emailRedirectUrl: string;
} | null {
  const rawUrl = process.env.SUPABASE_URL?.trim();
  const anonKey = process.env.SUPABASE_ANON_KEY?.trim();
  if (!rawUrl && !anonKey) return null;
  if (!rawUrl || !anonKey) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must both be set, or neither.');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`SUPABASE_URL is not a valid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('SUPABASE_URL must be https — passwords are sent to it.');
  }
  // supabase-js appends its own /auth/v1 and /rest/v1 paths. Copying the REST
  // endpoint out of the dashboard is an easy mistake and yields requests to
  // /rest/v1/auth/v1/token, so it is caught here rather than at first sign-in.
  if (parsed.pathname.replace(/\/+$/, '') !== '') {
    throw new Error(
      `SUPABASE_URL must be the project origin with no path — use ${parsed.origin}, not ${rawUrl}`,
    );
  }
  return {
    url: parsed.origin,
    anonKey,
    serviceKey: serviceRoleKey(anonKey),
    emailRedirectUrl: emailRedirectUrl(),
  };
}

/**
 * Where the link in a Supabase email lands.
 *
 * Supabase's own default drops the person on a bare JSON response or on
 * localhost, neither of which means anything to someone who opened the mail on
 * their phone. It goes instead to a page Studex owns, which says the address is
 * confirmed and offers to open the app that is already installed.
 *
 * The same URL has to be on the project's redirect allow-list, or Supabase
 * quietly substitutes the Site URL and the link lands nowhere useful.
 */
function emailRedirectUrl(): string {
  const raw = process.env.SUPABASE_EMAIL_REDIRECT_URL?.trim();
  if (!raw) return 'https://ironmaxi21.github.io/Studex-releases/confirmed/';
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`SUPABASE_EMAIL_REDIRECT_URL is not a valid URL: ${raw}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('SUPABASE_EMAIL_REDIRECT_URL must be https — it is sent to strangers by email.');
  }
  return parsed.toString();
}

/**
 * The owner-level key, on the machine that cuts releases and nowhere else.
 *
 * It is only ever used to write one row into public.releases — that table is
 * what decides which code every install runs, so writing to it is deliberately
 * not something the anon key can do. Unset is the ordinary case, and the
 * ordinary case is right: a server that merely runs Studex has no business
 * being able to publish an update to every other copy of it.
 *
 * It must never be put in the app bundle. The bundle is handed to the people
 * running Studex, and this key can rewrite the update feed they trust.
 */
function serviceRoleKey(anonKey: string): string | null {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!key) return null;
  // The two keys sit next to each other in the dashboard and look alike. The
  // anon key here would publish nothing and report a permission error from
  // somewhere much further in, so it is caught at boot.
  if (key === anonKey) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is the anon key. The anon key may only read releases, by design.',
    );
  }
  return key;
}

/**
 * Stripe, when this install sells anything.
 *
 * All four values are required together, and that is not tidiness. A secret
 * key with no webhook secret builds a checkout that takes money and then has
 * no way to hear that it was paid — the customer is charged and stays on Free.
 * Refusing to boot is a better outcome than shipping that, so a partial
 * configuration is an error rather than a degraded mode.
 *
 * Unset entirely, Studex simply has no checkout, and the Plan screen says so
 * instead of offering a button that cannot work.
 */
function stripeSettings(): {
  secretKey: string;
  priceId: string;
  webhookSecret: string;
  portalReturnUrl: string | null;
} | null {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  const priceId = process.env.STRIPE_PRICE_ID?.trim();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();

  if (!secretKey && !priceId && !webhookSecret) return null;
  if (!secretKey || !priceId || !webhookSecret) {
    throw new Error(
      'STRIPE_SECRET_KEY, STRIPE_PRICE_ID and STRIPE_WEBHOOK_SECRET must all be set, or none. '
        + 'A checkout without a webhook secret charges people and never hears that they paid.',
    );
  }
  // A publishable key here would be a configuration mistake that only shows up
  // as a failed API call much later, so it is caught at boot.
  if (secretKey.startsWith('pk_')) {
    throw new Error('STRIPE_SECRET_KEY is a publishable key. The secret key starts sk_ or rk_.');
  }
  if (!priceId.startsWith('price_')) {
    throw new Error(`STRIPE_PRICE_ID must be a price id (price_…), not ${priceId.slice(0, 8)}…`);
  }
  if (!webhookSecret.startsWith('whsec_')) {
    throw new Error('STRIPE_WEBHOOK_SECRET must be the signing secret shown for the endpoint (whsec_…).');
  }

  return {
    secretKey,
    priceId,
    webhookSecret,
    portalReturnUrl: process.env.STRIPE_PORTAL_RETURN_URL?.trim() || null,
  };
}

/** The three jobs the AI features are split into. See `domain/ai.ts`. */
export type AiRole = 'reader' | 'writer' | 'checker';

/**
 * Where the writing gets done, and by which model.
 *
 * Three roles rather than one model, because the jobs are different shapes:
 * reading a whole specification wants a long context and some thought,
 * writing cards and questions wants clean prose that follows a format, and
 * checking a list against its source wants something quick and literal. Each
 * role names a first choice and a backup; the free variants are rate-limited,
 * and a busy model should cost a second attempt rather than a failed request.
 *
 * The key is not here. It can be set in the environment, but on the desktop
 * app it is pasted into Settings and kept in a file beside the database — see
 * `ai-key.ts` — so it is read when a request is made, not once at boot.
 */
function aiSettings(): {
  baseUrl: string;
  models: Record<AiRole, { primary: string; backup: string | null }>;
} {
  const baseUrl = process.env.AI_BASE_URL?.trim() || 'https://generativelanguage.googleapis.com';
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
      throw new Error('AI_BASE_URL must be https, or a loopback address for a local proxy.');
    }
  } catch (err) {
    throw new Error(`AI_BASE_URL is not a valid URL: ${(err as Error).message}`);
  }

  const model = (name: string, fallback: string) => process.env[name]?.trim() || fallback;
  // Google AI Studio's models. Flash reads and writes; Flash-Lite checks,
  // quickly and literally. Pro is no longer offered to new keys (it answers
  // 404), so nothing defaults to it.
  const reader = model('AI_MODEL_READER', 'gemini-flash-latest');
  const writer = model('AI_MODEL_WRITER', 'gemini-flash-latest');
  const checker = model('AI_MODEL_CHECKER', 'gemini-flash-lite-latest');

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    models: {
      // The `-latest` aliases follow Google's current Flash models, so a
      // retired model name still has somewhere to fall back to.
      reader: { primary: reader, backup: 'gemini-3-flash-preview' },
      writer: { primary: writer, backup: 'gemini-flash-lite-latest' },
      checker: { primary: checker, backup: 'gemini-3-flash-preview' },
    },
  };
}

const SUPABASE = supabaseSettings();
const STRIPE = stripeSettings();
const AI = aiSettings();

const PORT = int('PORT', 8080);
const HOST = process.env.HOST?.trim() || '127.0.0.1';
const WEB_DIR = webDir();

export const config = {
  env: NODE_ENV,
  isProd,
  isTest,
  port: PORT,
  host: HOST,
  webDir: WEB_DIR,
  sessionSecret: sessionSecret(),
  cookieSecure: cookieSecure(HOST),
  databasePath: path.resolve(process.env.DATABASE_PATH?.trim() || './data/studex.sqlite'),
  storageDir: path.resolve(process.env.STORAGE_DIR?.trim() || './data/blobs'),
  corsOrigins: corsOrigins(WEB_DIR, HOST, PORT),
  /** 20 GB per user, as shown in the Library screen. */
  storageQuotaBytes: int('STORAGE_QUOTA_BYTES', 20 * 1024 * 1024 * 1024),
  /**
   * What Pro is worth. The free allowance above is the base, and Pro
   * multiplies it — so raising STORAGE_QUOTA_BYTES on a self-hosted install
   * lifts both tiers rather than collapsing the difference between them.
   */
  proQuotaMultiplier: int('PRO_QUOTA_MULTIPLIER', 5),
  maxUploadBytes: int('MAX_UPLOAD_BYTES', 100 * 1024 * 1024),

  /**
   * AI requests allowed per account per calendar month, before the Pro
   * multiplier above.
   *
   * A cap rather than a tier, because every call spends money that the person
   * running the install is paying, and because a self-hosted server with an
   * API key and no checkout would otherwise have an AI feature nobody is
   * allowed to use. Free gets a real allowance; Pro gets five times it.
   */
  aiMonthlyRequests: int('AI_MONTHLY_REQUESTS', 30),

  /**
   * AI requests allowed per IP per minute. Far above what a person does by
   * hand and far below what empties a month's allowance in one go: the
   * monthly cap is the real limit, and this only stops a loop.
   */
  aiRateLimitMax: int('AI_RATE_LIMIT_MAX', 10),

  /**
   * What this build calls itself.
   *
   * The shell passes it down from the bundle it is running out of, so the
   * server never has to guess at a version — outside the app there is no
   * bundle to replace, and the Updates screen says so rather than offering a
   * button that cannot work.
   *
   * Where a newer one is found is not configured at all any more: releases are
   * a table in the Supabase project below, so a build that can sign in can
   * find its own updates.
   */
  appVersion: process.env.STUDEX_VERSION?.trim() || null,
  appBuild: process.env.STUDEX_BUILD?.trim() || null,
  /**
   * Which kind of build the shell around this server is: `release` for the app
   * people download, `dev` for anything else.
   *
   * Only the release build stamps it, and the default runs that way round on
   * purpose. A server started by hand, by the tests, or by someone hosting
   * Studex themselves says nothing here and keeps every screen — defaulting to
   * `release` would lock those installs out of the one screen where they can
   * set a key at all.
   */
  channel: process.env.STUDEX_CHANNEL?.trim().toLowerCase() === 'release' ? 'release' : 'dev',
  /** Shorthand: this server is inside the app that ships. */
  isRelease: process.env.STUDEX_CHANNEL?.trim().toLowerCase() === 'release',
  trustProxy: (process.env.TRUST_PROXY ?? 'false').toLowerCase() === 'true',
  /**
   * Requests allowed per IP per 5 minutes on the credential endpoints. The
   * default is deliberately low; test runs raise it so that creating fixtures
   * does not trip the limiter. Account lockout is enforced separately and is
   * not affected by this value.
   */
  authRateLimitMax: int('AUTH_RATE_LIMIT_MAX', 10),

  /**
   * Where credentials are checked. 'supabase' means email and password are
   * verified by the Supabase project below and a local session cookie is
   * issued on success; 'local' means the argon2 hashes in this database.
   */
  authProvider: (SUPABASE ? 'supabase' : 'local') as 'supabase' | 'local',
  supabase: SUPABASE,

  /**
   * Whether the server keeps a subscription open to each linked account's
   * library and syncs when the project says a row moved, instead of only on
   * the timer. Defaults to on wherever there is a project to subscribe to,
   * because the alternative — two open Macs disagreeing for five minutes — is
   * the thing the interval could never fix.
   *
   * Turning it off leaves automatic sync working exactly as it did.
   */
  syncRealtime: bool('SYNC_REALTIME', SUPABASE !== null),
  ai: AI,

  /**
   * Payment, when this install has any. Null is the ordinary case: a
   * self-hosted Studex has nobody to pay, and grants Pro with the licence
   * script instead.
   */
  stripe: STRIPE,

  session: {
    /** Sliding window: a session must be used at least this often. */
    idleTtlMs: 14 * 24 * 60 * 60 * 1000,
    /** Hard cap regardless of activity. */
    absoluteTtlMs: 90 * 24 * 60 * 60 * 1000,
    /**
     * How many devices may hold a live session on one account at once. One:
     * an account is one student's account, so signing in somewhere new signs
     * the previous device out rather than adding a seat to a shared login.
     * Self-hosted installs can raise it; the shipped product does not.
     */
    maxConcurrent: int('MAX_CONCURRENT_SESSIONS', 1),
    cookieName: 'studex_session',
    csrfCookieName: 'studex_csrf',
    csrfHeaderName: 'x-csrf-token',
  },
} as const;
