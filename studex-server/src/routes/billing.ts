import type { FastifyInstance } from 'fastify';
import { config } from '../lib/config.js';
import { badRequest, notFound } from '../lib/errors.js';
import { requireAuth } from '../lib/http.js';
import { stripeRequest } from '../lib/stripe.js';
import { verifyWebhook } from '../lib/stripe.js';
import * as billing from '../domain/billing.js';
import * as auth from '../domain/auth.js';

/**
 * What Pro costs, taken from Stripe rather than written down here.
 *
 * A price in two places is a price that will disagree with itself the first
 * time it changes, and the copy that would be wrong is the one shown to the
 * person deciding whether to pay. It is fetched once and kept, because a price
 * changes about as often as the app is restarted.
 */
interface PriceView {
  amount: number | null;
  currency: string;
  interval: string | null;
}
let cachedPrice: PriceView | null = null;

async function priceView(): Promise<PriceView | null> {
  const stripe = billing.settings();
  if (!stripe) return null;
  if (cachedPrice) return cachedPrice;

  try {
    const price = await stripeRequest<{
      unit_amount: number | null;
      currency: string;
      recurring: { interval: string } | null;
    }>(stripe.secretKey, `/prices/${encodeURIComponent(stripe.priceId)}`, { method: 'GET' });
    cachedPrice = {
      amount: price.unit_amount,
      currency: price.currency,
      interval: price.recurring?.interval ?? null,
    };
    return cachedPrice;
  } catch {
    // The Plan screen still works without it; it just cannot name the amount,
    // and saying nothing is better than guessing at one.
    return null;
  }
}

/**
 * The one place a checkout may be returned to.
 *
 * Stripe sends the browser wherever these say, so they are built here from the
 * server's own address rather than taken from the request. A `successUrl` a
 * caller could choose is an open redirect with a payment attached to it.
 */
function ownOrigin(): string {
  const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  const scheme = config.cookieSecure ? 'https' : 'http';
  return `${scheme}://${host}:${config.port}`;
}

function returnPage(title: string, message: string): string {
  const escape = (s: string) => s.replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} — Studex</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         background: Canvas; color: CanvasText; }
  main { max-width: 30rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.35rem; margin: 0 0 .6rem; }
  p { margin: 0; opacity: .75; }
</style></head>
<body><main><h1>${escape(title)}</h1><p>${escape(message)}</p></main></body></html>`;
}

export async function billingRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The webhook is signed, not parsed.
   *
   * Fastify would hand this route a decoded object, and the signature covers
   * the bytes that were sent — so the raw buffer has to survive as far as the
   * verification. The parser is registered inside this plugin, where Fastify's
   * encapsulation keeps it off every other JSON route in the app.
   */
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  /** What the Plan screen needs to know before it offers anything. */
  app.get('/billing/config', async (req) => {
    requireAuth(req);
    const stripe = billing.settings();
    return {
      available: stripe !== null,
      price: stripe ? await priceView() : null,
    };
  });

  /**
   * Starts a purchase. Grants nothing: the answer is a URL, and the entitlement
   * arrives later on the webhook below.
   */
  app.post('/billing/checkout', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } },
    async (req) => {
      const { user } = requireAuth(req);
      if (!billing.settings()) throw notFound('This install of Studex has no checkout.');
      if (auth.hasProEntitlement(user.id)) {
        throw badRequest('This account is already paid for.');
      }

      const origin = ownOrigin();
      return billing.createCheckout({
        userId: user.id,
        successUrl: `${origin}/api/billing/return?state=paid`,
        cancelUrl: `${origin}/api/billing/return?state=cancelled`,
      });
    });

  /** Where a subscription is changed or cancelled. */
  app.post('/billing/portal', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } },
    async (req) => {
      const { user } = requireAuth(req);
      if (!billing.settings()) throw notFound('This install of Studex has no checkout.');
      return billing.createPortalSession({
        userId: user.id,
        returnUrl: `${ownOrigin()}/api/billing/return?state=managed`,
      });
    });

  /**
   * Where Stripe sends the browser back to.
   *
   * Checkout happens in the real browser, not in the app's WebView, so this is
   * a page rather than a redirect — and it deliberately does not claim the
   * purchase has landed. At the moment it renders, the webhook may not have
   * arrived; the app is watching for the entitlement itself and will say so
   * when it does.
   */
  app.get('/billing/return', async (req, reply) => {
    const state = (req.query as { state?: string } | undefined)?.state;
    const page = state === 'paid'
      ? returnPage('Thank you', 'Your payment went through. You can close this tab — Studex is switching your account to Pro.')
      : state === 'managed'
        ? returnPage('All set', 'Your subscription has been updated. You can close this tab.')
        : returnPage('Nothing was charged', 'The purchase was cancelled. You can close this tab and carry on.');
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(page);
  });

  /**
   * Stripe's account of what happened.
   *
   * This is the only thing in the product that can grant a paid tier from
   * outside the licence script, so the signature check is the whole of its
   * authentication and it runs before anything is read out of the body.
   */
  app.post('/billing/webhook', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const stripe = billing.settings();
      if (!stripe) throw notFound('This install of Studex has no checkout.');

      const raw = req.body;
      if (!Buffer.isBuffer(raw)) throw badRequest('Expected a raw Stripe event body');

      const event = verifyWebhook(raw, req.headers['stripe-signature'] as string | undefined, stripe.webhookSecret);
      const parsed = event as { id?: unknown; type?: unknown; data?: unknown };
      if (typeof parsed.id !== 'string' || typeof parsed.type !== 'string') {
        throw badRequest('Stripe event is missing an id or a type');
      }

      billing.applyEvent(
        event as { id: string; type: string; data: { object: Record<string, unknown> } },
        (msg) => req.log.info({ stripeEvent: parsed.id }, msg),
      );

      // 200 as soon as it has been acted on. Anything else and Stripe retries
      // for three days, and the retries would be of work already done.
      return reply.code(200).send({ received: true });
    });
}
