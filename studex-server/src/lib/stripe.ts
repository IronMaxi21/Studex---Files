/**
 * Just enough Stripe to sell one thing.
 *
 * The official SDK is a large dependency for three endpoints and one signature
 * check, and it brings its own HTTP stack into a process that already has
 * `fetch`. What is actually needed is form encoding, a bearer header, and an
 * HMAC — all of which are in the standard library and none of which are the
 * interesting part of a payment integration.
 *
 * Nothing here knows about Studex. It talks to Stripe; `domain/billing.ts`
 * decides what any of it means.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { badRequest } from './errors.js';

const API = 'https://api.stripe.com/v1';

/** Stripe's own errors, kept distinct from the ones we show a client. */
export class StripeError extends Error {
  readonly status: number;
  readonly stripeCode: string | null;

  constructor(status: number, message: string, code: string | null) {
    super(message);
    this.name = 'StripeError';
    this.status = status;
    this.stripeCode = code;
  }
}

type FormValue = string | number | boolean | null | undefined | FormShape | FormValue[];
interface FormShape { [key: string]: FormValue }

/**
 * Stripe takes forms, not JSON, and expresses nesting in the key:
 * `line_items[0][price]=price_123`. Undefined and null are dropped rather than
 * sent as the strings "undefined" and "null", which Stripe would accept and
 * then act on.
 */
export function encodeForm(shape: FormShape): string {
  const parts: string[] = [];

  const walk = (prefix: string, value: FormValue): void => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(`${prefix}[${i}]`, item));
      return;
    }
    if (typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) walk(`${prefix}[${key}]`, inner);
      return;
    }
    parts.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
  };

  for (const [key, value] of Object.entries(shape)) walk(key, value);
  return parts.join('&');
}

/**
 * One call to Stripe.
 *
 * `idempotencyKey` is what stops a double-clicked button, or a retried
 * request, from creating two of whatever this makes. Stripe holds the key for
 * 24 hours and replays the original response.
 */
export async function stripeRequest<T>(
  secretKey: string,
  path: string,
  opts: { method?: 'GET' | 'POST'; body?: FormShape; idempotencyKey?: string } = {},
): Promise<T> {
  const method = opts.method ?? 'POST';
  const headers: Record<string, string> = {
    authorization: `Bearer ${secretKey}`,
    'stripe-version': '2024-06-20',
  };
  if (opts.body) headers['content-type'] = 'application/x-www-form-urlencoded';
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;

  // Payments are worth a bounded wait, but not an unbounded one: the request
  // that is hanging is one a person is watching a spinner for.
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: opts.body ? encodeForm(opts.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new StripeError(res.status, `Stripe returned a response that was not JSON (${res.status})`, null);
  }

  if (!res.ok) {
    const err = (parsed as { error?: { message?: string; code?: string; type?: string } }).error;
    throw new StripeError(
      res.status,
      err?.message ?? `Stripe refused the request (${res.status})`,
      err?.code ?? err?.type ?? null,
    );
  }
  return parsed as T;
}

/** Five minutes, which is Stripe's own recommendation. */
const TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Proves a webhook really came from Stripe.
 *
 * This is the whole of the webhook's authentication: the endpoint is public,
 * and a request that forged it would be a request that grants itself Pro. So
 * the check runs on the raw bytes — re-serialising the JSON first would change
 * them, and the signature is over what was sent, not over what it parsed to.
 *
 * The timestamp is part of the signed material, which is what makes replaying
 * a genuine old event fail rather than succeed.
 */
export function verifyWebhook(
  payload: Buffer,
  header: string | undefined,
  secret: string,
  now = Date.now(),
): unknown {
  if (!header) throw badRequest('Missing Stripe signature');

  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') timestamp = value;
    // v1 only. v0 is Stripe's test-mode scheme and does not sign the payload.
    else if (key === 'v1') signatures.push(value);
  }
  if (!timestamp || signatures.length === 0) throw badRequest('Malformed Stripe signature');

  const sentAt = Number(timestamp) * 1000;
  if (!Number.isFinite(sentAt) || Math.abs(now - sentAt) > TOLERANCE_MS) {
    throw badRequest('Stripe signature is outside the permitted time window');
  }

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(payload)
    .digest();

  // Stripe sends several v1 signatures while a secret is being rotated, and
  // any one of them matching is a valid event.
  const matched = signatures.some((sig) => {
    let given: Buffer;
    try {
      given = Buffer.from(sig, 'hex');
    } catch {
      return false;
    }
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!matched) throw badRequest('Stripe signature did not verify');

  try {
    return JSON.parse(payload.toString('utf8'));
  } catch {
    throw badRequest('Stripe sent a body that was not JSON');
  }
}
