import './stripe-env.js';
import './setup.js';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import { api, closeApp, getApp, registerUser, type Client } from './helpers.js';
import { encodeForm, verifyWebhook } from '../src/lib/stripe.js';

let buyer: Client;

/** Every Stripe call this file provokes, in order. */
interface Call { url: string; method: string; body: string; headers: Record<string, string> }
let calls: Call[] = [];
let reply: (call: Call) => { status?: number; json: unknown } = () => ({ json: {} });

const realFetch = globalThis.fetch;

before(async () => {
  await getApp();
  buyer = await registerUser('Buyer');

  // Nothing in these tests may reach the network. Anything aimed at Stripe is
  // answered here; anything else is a bug in the test rather than a request to
  // be quietly allowed out.
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith('https://api.stripe.com/')) {
      throw new Error(`unexpected outbound request to ${url}`);
    }
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>)
        .map(([k, v]) => [k.toLowerCase(), v]),
    );
    const call: Call = { url, method: init?.method ?? 'GET', body: String(init?.body ?? ''), headers };
    calls.push(call);
    const answer = reply(call);
    return new Response(JSON.stringify(answer.json), {
      status: answer.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  await closeApp();
});

afterEach(() => {
  calls = [];
});

/** A body signed the way Stripe signs one. */
function signed(event: unknown, opts: { secret?: string; at?: number } = {}) {
  const payload = JSON.stringify(event);
  const t = Math.floor((opts.at ?? Date.now()) / 1000);
  const v1 = createHmac('sha256', opts.secret ?? 'whsec_test_signing_secret')
    .update(`${t}.${payload}`)
    .digest('hex');
  return { payload, header: `t=${t},v1=${v1}` };
}

async function postWebhook(event: unknown, opts: { secret?: string; at?: number } = {}) {
  const app = await getApp();
  const { payload, header } = signed(event, opts);
  return app.inject({
    method: 'POST',
    url: '/api/billing/webhook',
    headers: { 'content-type': 'application/json', 'stripe-signature': header },
    payload,
  });
}

function subscriptionEvent(id: string, type: string, fields: Record<string, unknown>) {
  return {
    id,
    type,
    data: {
      object: {
        id: 'sub_1',
        object: 'subscription',
        customer: 'cus_1',
        metadata: { user_id: buyer.userId },
        ...fields,
      },
    },
  };
}

async function planOf(client: Client): Promise<{ plan: string; entitled: boolean }> {
  const res = await api(client, { method: 'GET', url: '/api/auth/me/plan' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  return { plan: body.plan, entitled: body.entitled };
}

/* -------------------------------------------------------------------------- */

describe('form encoding', () => {
  it('expresses nesting the way Stripe reads it', () => {
    const encoded = encodeForm({
      mode: 'subscription',
      line_items: [{ price: 'price_1', quantity: 1 }],
      metadata: { user_id: 'u-1' },
    });
    assert.equal(
      decodeURIComponent(encoded),
      'mode=subscription&line_items[0][price]=price_1&line_items[0][quantity]=1&metadata[user_id]=u-1',
    );
  });

  it('drops absent values rather than sending them as words', () => {
    // `customer=undefined` is a string Stripe would accept and then fail on.
    const encoded = encodeForm({ customer: undefined, customer_email: null, price: 'price_1' });
    assert.equal(encoded, 'price=price_1');
  });
});

describe('checkout', () => {
  it('tells the app that this install sells something, and what it costs', async () => {
    reply = () => ({ json: { unit_amount: 400, currency: 'gbp', recurring: { interval: 'month' } } });
    const res = await api(buyer, { method: 'GET', url: '/api/billing/config' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      available: true,
      price: { amount: 400, currency: 'gbp', interval: 'month' },
    });
    assert.match(calls[0]!.url, /\/v1\/prices\/price_test_pro_monthly$/);
  });

  it('opens a payment page stamped with the account, and grants nothing', async () => {
    reply = () => ({ json: { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' } });
    const res = await api(buyer, { method: 'POST', url: '/api/billing/checkout' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().url, 'https://checkout.stripe.com/c/pay/cs_1');

    const sent = decodeURIComponent(calls.at(-1)!.body);
    assert.match(sent, /mode=subscription/);
    assert.match(sent, /line_items\[0\]\[price\]=price_test_pro_monthly/);
    assert.match(sent, new RegExp(`client_reference_id=${buyer.userId}`));
    // Stamped onto the subscription too, because the events that grant Pro are
    // subscription events and carry no session.
    assert.match(sent, new RegExp(`subscription_data\\[metadata\\]\\[user_id\\]=${buyer.userId}`));
    // The redirect targets are the server's own, never the caller's.
    assert.match(sent, /success_url=http:\/\/127\.0\.0\.1:\d+\/api\/billing\/return\?state=paid/);

    // Asking to pay is not paying.
    assert.deepEqual(await planOf(buyer), { plan: 'free', entitled: false });
  });

  it('refuses to sell a second subscription to an account that already has one', async () => {
    reply = () => ({ json: {} });
    const other = await registerUser('Already Paid');
    await postWebhook(
      {
        id: 'evt_paid_other',
        type: 'customer.subscription.created',
        data: {
          object: {
            id: 'sub_other', customer: 'cus_other', status: 'active',
            current_period_end: Math.floor(Date.now() / 1000) + 86_400,
            metadata: { user_id: other.userId },
          },
        },
      },
    );
    const res = await api(other, { method: 'POST', url: '/api/billing/checkout' });
    assert.equal(res.statusCode, 400);
    // And no call was made to Stripe to create a page nobody needed.
    assert.equal(calls.length, 0);
  });

  it('will not open the billing portal for an account that never bought anything', async () => {
    const stranger = await registerUser('No Purchase');
    const res = await api(stranger, { method: 'POST', url: '/api/billing/portal' });
    assert.equal(res.statusCode, 404);
  });

  it('needs a session, like everything else', async () => {
    const app = await getApp();
    for (const url of ['/api/billing/config', '/api/billing/checkout']) {
      const res = await app.inject({ method: url.endsWith('config') ? 'GET' : 'POST', url });
      assert.equal(res.statusCode, 401, url);
    }
  });
});

describe('the webhook', () => {
  it('refuses an event that is not signed', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/billing/webhook',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(subscriptionEvent('evt_unsigned', 'customer.subscription.created', { status: 'active' })),
    });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(await planOf(buyer), { plan: 'free', entitled: false });
  });

  it('refuses an event signed with the wrong secret', async () => {
    const res = await postWebhook(
      subscriptionEvent('evt_forged', 'customer.subscription.created', { status: 'active' }),
      { secret: 'whsec_someone_elses_secret' },
    );
    assert.equal(res.statusCode, 400);
    assert.deepEqual(await planOf(buyer), { plan: 'free', entitled: false });
  });

  it('refuses a genuine event replayed hours later', async () => {
    const res = await postWebhook(
      subscriptionEvent('evt_stale', 'customer.subscription.created', { status: 'active' }),
      { at: Date.now() - 6 * 60 * 60 * 1000 },
    );
    assert.equal(res.statusCode, 400);
    assert.deepEqual(await planOf(buyer), { plan: 'free', entitled: false });
  });

  it('refuses a body that was altered after it was signed', async () => {
    const app = await getApp();
    const honest = subscriptionEvent('evt_tampered', 'customer.subscription.created', { status: 'active' });
    const { header } = signed(honest);
    const tampered = JSON.stringify(honest).replace('"status":"active"', '"status":"active" ');
    const res = await app.inject({
      method: 'POST',
      url: '/api/billing/webhook',
      headers: { 'content-type': 'application/json', 'stripe-signature': header },
      payload: tampered,
    });
    assert.equal(res.statusCode, 400);
  });

  it('grants Pro on an active subscription, and switches the account to it', async () => {
    const res = await postWebhook(subscriptionEvent('evt_active', 'customer.subscription.created', {
      status: 'active',
      current_period_end: Math.floor(Date.now() / 1000) + 30 * 86_400,
    }));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(await planOf(buyer), { plan: 'pro', entitled: true });
  });

  it('ignores the same event arriving twice', async () => {
    // Stripe retries until it is acknowledged, and may retry one it already was.
    const event = subscriptionEvent('evt_active', 'customer.subscription.created', {
      status: 'canceled',
    });
    const res = await postWebhook(event);
    assert.equal(res.statusCode, 200);
    // The replay carried a cancellation; because the id was already handled,
    // it changed nothing.
    assert.deepEqual(await planOf(buyer), { plan: 'pro', entitled: true });
  });

  it('takes Pro away when the subscription ends', async () => {
    const res = await postWebhook(subscriptionEvent('evt_gone', 'customer.subscription.deleted', {
      status: 'canceled',
    }));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(await planOf(buyer), { plan: 'free', entitled: false });
  });

  it('finds the account by customer when the event carries no metadata', async () => {
    // The link was made by the earlier events; a later one from the dashboard
    // has no user_id on it and must still land on the right account.
    const res = await postWebhook({
      id: 'evt_by_customer',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_1', customer: 'cus_1', status: 'active',
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86_400,
        },
      },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(await planOf(buyer), { plan: 'pro', entitled: true });
  });

  it('acknowledges event types it has nothing to do with', async () => {
    const res = await postWebhook({
      id: 'evt_unrelated',
      type: 'invoice.upcoming',
      data: { object: { id: 'in_1' } },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(await planOf(buyer), { plan: 'pro', entitled: true });
  });

  it('never lets a client grant itself the tier the webhook grants', async () => {
    const freeloader = await registerUser('Freeloader');
    const res = await api(freeloader, {
      method: 'PATCH', url: '/api/auth/me/plan', payload: { plan: 'pro' },
    });
    assert.equal(res.statusCode, 402);
  });
});

describe('signature verification, directly', () => {
  const secret = 'whsec_test_signing_secret';

  it('accepts any one of several signatures, so a secret can be rotated', () => {
    const payload = Buffer.from('{"id":"evt_x"}');
    const t = Math.floor(Date.now() / 1000);
    const good = createHmac('sha256', secret).update(`${t}.`).update(payload).digest('hex');
    const header = `t=${t},v1=${'0'.repeat(64)},v1=${good}`;
    assert.deepEqual(verifyWebhook(payload, header, secret), { id: 'evt_x' });
  });

  it('rejects a header with no signature in it at all', () => {
    const payload = Buffer.from('{}');
    assert.throws(() => verifyWebhook(payload, `t=${Math.floor(Date.now() / 1000)}`, secret));
    assert.throws(() => verifyWebhook(payload, undefined, secret));
  });
});
