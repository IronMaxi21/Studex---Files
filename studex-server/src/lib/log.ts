import { config } from './config.js';

/**
 * What the server says about itself, and how much of it.
 *
 * Fastify logs requests through pino; this is for everything else — the domain
 * code, which until now either said nothing or reached for console.log. Three
 * things matter and none of them are satisfied by console:
 *
 *  - a release build must not be verbose. Debug lines describing a student's
 *    library are noise at best, and at worst they are their notes sitting in a
 *    file somewhere.
 *  - a log line is data, so it is structured. Grepping prose written by hand
 *    is how a log stops being read at all.
 *  - it goes to stderr, because stdout is the pipe the desktop shell holds
 *    open to know whether this process is still alive.
 */
export type Level = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

function configured(): Level {
  const raw = process.env.LOG_LEVEL?.trim().toLowerCase();
  if (raw && raw in ORDER) return raw as Level;
  // Tests say nothing unless something is wrong with them; a release build
  // keeps its voice down; development is expected to be chatty.
  if (config.isTest) return 'warn';
  return config.isProd ? 'info' : 'debug';
}

const threshold = ORDER[configured()];

/** Redacted rather than dropped: knowing a field was there is often the point. */
const SECRET = /^(password|token|access_token|refresh_token|secret|authorization|cookie|sha256)$/i;

function safe(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value !== 'object') return value;
  if (depth > 3) return '[deep]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => safe(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET.test(key) ? '[redacted]' : safe(inner, depth + 1);
  }
  return out;
}

function emit(level: Level, fields: Record<string, unknown> | string, message?: string): void {
  if (ORDER[level] < threshold) return;
  const body = typeof fields === 'string' ? { msg: fields } : { ...(safe(fields) as object), msg: message };
  process.stderr.write(`${JSON.stringify({ level, time: Date.now(), ...body })}\n`);
}

export const log = {
  debug: (fields: Record<string, unknown> | string, message?: string) => emit('debug', fields, message),
  info: (fields: Record<string, unknown> | string, message?: string) => emit('info', fields, message),
  warn: (fields: Record<string, unknown> | string, message?: string) => emit('warn', fields, message),
  error: (fields: Record<string, unknown> | string, message?: string) => emit('error', fields, message),
  /** The level in force, for a test that wants to assert on it. */
  level: configured(),
};
