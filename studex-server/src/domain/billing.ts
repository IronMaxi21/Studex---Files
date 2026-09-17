/**
 * Selling Studex Pro.
 *
 * The rule this file works under was set in 011 and has not changed: an
 * account moves up because there is a row in `billing_entitlements` saying it
 * may, and nothing a client can call writes one. Checkout does not weaken
 * that — it adds a second thing outside the client that can, alongside the
 * licence script, and that thing is a signed webhook from Stripe.
 *
 * So the shape here is deliberately lopsided. The request the app makes
 * creates a payment page and grants nothing at all; the grant happens later,
 * on a request the app cannot make, carrying a signature it cannot forge.
 */
import { config } from '../lib/config.js';
import { getDb } from '../lib/db.js';
import { badRequest, notFound } from '../lib/errors.js';
import { stripeRequest, StripeError } from '../lib/stripe.js';
import * as auth from './auth.js';

/** A subscription that lapsed at midnight should not lock someone out at 00:01. */
const GRACE_MS = 3 * 24 * 60 * 60 * 1000;

export interface StripeConfig {
  secretKey: string;
  priceId: string;
  webhookSecret: string;
  portalReturnUrl: string | null;
}

/** Null when this install does not sell anything, which is the common case. */
export function settings(): StripeConfig | null {
  return config.stripe;
}

function required(): StripeConfig {
  const stripe = settings();
  if (!stripe) throw notFound('This install of Studex has no checkout.');
  return stripe;
}

// ── the customer ────────────────────────────────────────────────────────

export function customerIdFor(userId: string): string | null {
  const row = getDb()
    .prepare<[string], { customer_id: string }>(
      'SELECT customer_id FROM billing_customers WHERE user_id = ?',
    )
    .get(userId);
  return row?.customer_id ?? null;
}

export function userIdForCustomer(customerId: string): string | null {
  const row = getDb()
    .prepare<[string], { user_id: string }>(
      'SELECT user_id FROM billing_customers WHERE customer_id = ?',
    )
    .get(customerId);
  return row?.user_id ?? null;
}

/**
 * Records which Stripe customer an account is.
 *
 * Unique on both columns, so this is also where a mismatch surfaces: the same
 * customer arriving for a second account means something upstream is wrong,
 * and quietly repointing the row would move a subscription between accounts.
 */
export function linkCustomer(userId: string, customerId: string): void {
  const now = Date.now();
  const owner = userIdForCustomer(customerId);
  if (owner && owner !== userId) {
    throw badRequest(`Stripe customer ${customerId} is already linked to another account`);
  }
  getDb()
    .prepare(
      `INSERT INTO billing_customers (user_id, customer_id, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET customer_id = excluded.customer_id, updated_at = excluded.updated_at`,
    )
    .run(userId, customerId, now, now);
}

// ── checkout ────────────────────────────────────────────────────────────

interface CheckoutSession {
  id: string;
  url: string | null;
}

/**
 * A payment page for this account, and a link to it.
 *
 * The account is stamped onto the session three times over — as the client
 * reference, in the session metadata, and in the metadata copied onto the
 * subscription it creates — because the events that arrive later each carry a
 * different one of those, and an event whose account cannot be worked out is
 * a payment nobody receives.
 */
export async function createCheckout(input: {
  userId: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ url: string; sessionId: string }> {
  const stripe = required();
  const user = auth.getUser(input.userId);
  if (!user) throw notFound('User not found');

  const existing = customerIdFor(user.id);

  let session: CheckoutSession;
  try {
    session = await stripeRequest<CheckoutSession>(stripe.secretKey, '/checkout/sessions', {
      body: {
        mode: 'subscription',
        line_items: [{ price: stripe.priceId, quantity: 1 }],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        client_reference_id: user.id,
        metadata: { user_id: user.id },
        subscription_data: { metadata: { user_id: user.id } },
        // A returning customer keeps their card and their history. A new one
        // is identified by the address they already signed in with, so they
        // are not asked for it twice.
        customer: existing ?? undefined,
        customer_email: existing ? undefined : user.email,
        allow_promotion_codes: true,
      },
    });
  } catch (err) {
    if (err instanceof StripeError) {
      // Stripe's message is written for a developer reading a dashboard, not
      // for someone trying to buy something.
      throw badRequest('Studex could not open a payment page just now. Nothing has been charged.');
    }
    throw err;
  }

  if (!session.url) throw badRequest('Stripe did not return a payment page.');
  return { url: session.url, sessionId: session.id };
}

/**
 * The page where a subscription is cancelled or a card is changed.
 *
 * Selling a subscription without offering this is how a subscription becomes
 * something you have to email someone to escape.
 */
export async function createPortalSession(input: {
  userId: string;
  returnUrl: string;
}): Promise<{ url: string }> {
  const stripe = required();
  const customerId = customerIdFor(input.userId);
  if (!customerId) throw notFound('This account has never bought anything.');

  const session = await stripeRequest<{ url: string }>(stripe.secretKey, '/billing_portal/sessions', {
    body: {
      customer: customerId,
      return_url: stripe.portalReturnUrl ?? input.returnUrl,
    },
  });
  return { url: session.url };
}

// ── webhooks ────────────────────────────────────────────────────────────

interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

/**
 * True the first time an event id is seen, false every time after.
 *
 * The insert is the check. Asking first and writing second leaves a window
 * where two retries of the same event both find nothing and both proceed.
 */
function claimEvent(event: StripeEvent): boolean {
  const info = getDb()
    .prepare('INSERT OR IGNORE INTO billing_events (id, type, received_at) VALUES (?, ?, ?)')
    .run(event.id, event.type, Date.now());
  return info.changes === 1;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/**
 * A Stripe object's id, whether it arrived expanded or as a bare string.
 * Stripe sends `"customer": "cus_1"` on some events and the whole object on
 * others, and reading `.id` off a string yields undefined rather than an error.
 */
function idOf(value: unknown): string | null {
  if (typeof value === 'string') return value || null;
  if (value && typeof value === 'object') return str((value as { id?: unknown }).id);
  return null;
}

function userFromMetadata(object: Record<string, unknown>): string | null {
  const metadata = object.metadata;
  if (metadata && typeof metadata === 'object') {
    const id = str((metadata as Record<string, unknown>).user_id);
    if (id) return id;
  }
  return null;
}

/** Which account an event is about, by whichever of the three routes it carries. */
function resolveUser(object: Record<string, unknown>): string | null {
  const fromMetadata = userFromMetadata(object) ?? str(object.client_reference_id);
  if (fromMetadata && auth.getUser(fromMetadata)) return fromMetadata;

  const customerId = idOf(object.customer);
  if (customerId) return userIdForCustomer(customerId);
  return null;
}

/** Stripe statuses that mean the subscription is being paid for. */
const LIVE = new Set(['active', 'trialing']);

function applySubscription(object: Record<string, unknown>, log: (msg: string) => void): void {
  const userId = resolveUser(object);
  if (!userId) {
    // Worth a line in the log and nothing more: a subscription for an account
    // that has since been deleted is not an error, and failing the webhook
    // would make Stripe retry it for three days.
    log(`subscription ${str(object.id) ?? '?'} matches no account; ignored`);
    return;
  }

  const customerId = idOf(object.customer);
  if (customerId) linkCustomer(userId, customerId);

  const status = str(object.status);
  if (!status || !LIVE.has(status)) {
    auth.revokeProEntitlement(userId);
    log(`subscription ${status ?? 'gone'} for ${userId}; entitlement revoked`);
    return;
  }

  const periodEnd = typeof object.current_period_end === 'number' ? object.current_period_end : null;
  auth.grantProEntitlement(userId, {
    source: 'purchase',
    reference: str(object.id),
    // The entitlement outlives the period by the grace window, so a renewal
    // that is a few hours late does not read as a cancellation.
    expiresAt: periodEnd === null ? null : periodEnd * 1000 + GRACE_MS,
  });
  // Paying for Pro and then having to find the switch is not a thing to ask of
  // someone who has just paid for Pro.
  auth.setPlan(userId, 'pro');
  log(`subscription ${status} for ${userId}; entitled to Pro`);
}

/**
 * Acts on a verified event.
 *
 * Only four types matter, and the rest are acknowledged rather than refused —
 * an endpoint that 400s on an event type someone enabled in the dashboard is
 * an endpoint that starts failing for reasons unrelated to Studex.
 */
export function applyEvent(event: StripeEvent, log: (msg: string) => void = () => {}): { applied: boolean } {
  if (!claimEvent(event)) {
    log(`event ${event.id} already handled; ignored`);
    return { applied: false };
  }

  const object = event.data?.object ?? {};

  switch (event.type) {
    case 'checkout.session.completed': {
      // The session's job is to introduce the customer to the account. What
      // they are entitled to arrives with the subscription events below, which
      // are the ones that also say when it stops.
      const userId = resolveUser(object);
      const customerId = idOf(object.customer);
      if (userId && customerId) {
        linkCustomer(userId, customerId);
        log(`checkout completed for ${userId}`);
      } else {
        log(`checkout ${str(object.id) ?? '?'} could not be matched to an account`);
      }
      return { applied: true };
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      applySubscription(object, log);
      return { applied: true };

    default:
      log(`event type ${event.type} needs no action`);
      return { applied: true };
  }
}
