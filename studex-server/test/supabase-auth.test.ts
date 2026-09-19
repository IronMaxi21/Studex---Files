import './setup.js';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closeApp, getApp } from './helpers.js';
import { useAuthGateway } from '../src/domain/auth.js';
import type { AuthGateway, SupabaseIdentity, SupabaseSession } from '../src/lib/supabase.js';
import { ApiError, conflict, unauthorized } from '../src/lib/errors.js';
import { translate } from '../src/lib/supabase.js';
import { getDb } from '../src/lib/db.js';

/**
 * A Supabase project, reduced to what Studex asks of one. Substituting this
 * for the real gateway is the whole reason the seam exists: linking,
 * confirmation and error handling are all reachable without a network, and a
 * test run can never become live traffic against someone's project.
 */
function fakeProvider(options: { requiresConfirmation?: boolean } = {}) {
  const accounts = new Map<string, { id: string; email: string; password: string; displayName: string | null }>();

  const gateway: AuthGateway = {
    async signUp({ email, password, displayName }) {
      if (accounts.has(email)) throw conflict('That email address is already registered');
      const account = { id: randomUUID(), email, password, displayName };
      accounts.set(email, account);
      if (options.requiresConfirmation) return { identity: null, confirmed: false, session: null };
      return { identity: identityOf(account), confirmed: true, session: sessionFor(account.id) };
    },
    async signIn({ email, password }) {
      const account = accounts.get(email);
      if (!account || account.password !== password) {
        throw unauthorized('Incorrect email or password');
      }
      return { identity: identityOf(account), session: sessionFor(account.id) };
    },
    async changePassword({ email, currentPassword, newPassword }) {
      const account = accounts.get(email);
      if (!account || account.password !== currentPassword) {
        throw unauthorized('Current password is incorrect');
      }
      account.password = newPassword;
      return sessionFor(account.id);
    },
  };

  /** Tokens shaped like Supabase's, carrying the account id so they can be told apart. */
  function sessionFor(id: string): SupabaseSession {
    return {
      accessToken: `access-${id}`,
      refreshToken: `refresh-${id}`,
      expiresAt: Date.now() + 60 * 60 * 1000,
    };
  }

  function identityOf(account: { id: string; email: string; displayName: string | null }): SupabaseIdentity {
    return { id: account.id, email: account.email, displayName: account.displayName };
  }

  /** Renames an account the way changing the address in Supabase would. */
  function rename(from: string, to: string): void {
    const account = accounts.get(from)!;
    accounts.delete(from);
    account.email = to;
    accounts.set(to, account);
  }

  return { gateway, accounts, rename };
}

function userCount(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  return row.n;
}

function post(url: string, payload: Record<string, string>) {
  return getApp().then((app) => app.inject({ method: 'POST', url, payload }));
}

after(async () => {
  useAuthGateway(null);
  await closeApp();
});

describe('who Studex thinks is asking', () => {
  // This runs first on purpose. Adopting a local account is only allowed when
  // there is no second account to walk into, so the check is meaningful only
  // while this database still holds one.
  it('adopts the local account that already owns the address', async () => {
    useAuthGateway(null);
    const email = `founder-${randomUUID()}@studex.test`;

    const local = await post('/api/auth/register', {
      email,
      password: 'the-original-local-passphrase',
      displayName: 'Founder',
    });
    assert.equal(local.statusCode, 201);
    const localUserId = local.json().user.id;
    assert.equal(userCount(), 1, 'adoption is only offered on a single-account database');

    const provider = fakeProvider();
    useAuthGateway(provider.gateway);
    await post('/api/auth/register', {
      email,
      password: 'a-brand-new-supabase-passphrase',
      displayName: 'Founder',
    });

    const signedIn = await post('/api/auth/login', {
      email,
      password: 'a-brand-new-supabase-passphrase',
    });
    assert.equal(signedIn.statusCode, 200);
    assert.equal(
      signedIn.json().user.id,
      localUserId,
      'the library that already existed under this address is the one they get',
    );
    assert.equal(userCount(), 1, 'adoption links a row rather than adding one');

    // And the password that used to open it no longer does: Supabase is the
    // only thing that can authenticate the account now.
    useAuthGateway(null);
    const oldWay = await post('/api/auth/login', {
      email,
      password: 'the-original-local-passphrase',
    });
    assert.equal(oldWay.statusCode, 401);
  });

  // Runs while the database still holds exactly the one account the previous
  // test adopted, which is the state this recovery depends on.
  it('re-links an identity that was deleted and made again', async () => {
    assert.equal(userCount(), 1, 'this test continues from the adopted account above');
    const existing = getDb()
      .prepare('SELECT id, email, supabase_user_id FROM users')
      .get() as { id: string; email: string; supabase_user_id: string | null };
    assert.ok(existing.supabase_user_id, 'it should already be linked');

    // Deleting the Supabase account and signing up again issues a brand new
    // uuid for the same address. A fresh fake provider models exactly that.
    const remade = fakeProvider();
    useAuthGateway(remade.gateway);
    await post('/api/auth/register', {
      email: existing.email,
      password: 'a-passphrase-after-the-reset',
      displayName: 'Founder',
    });

    const signedIn = await post('/api/auth/login', {
      email: existing.email,
      password: 'a-passphrase-after-the-reset',
    });

    assert.equal(signedIn.statusCode, 200, 'a stale link must not strand the library');
    assert.equal(signedIn.json().user.id, existing.id, 'and it is the same library');
    assert.equal(userCount(), 1);

    const relinked = getDb()
      .prepare('SELECT supabase_user_id FROM users WHERE id = ?')
      .get(existing.id) as { supabase_user_id: string };
    assert.notEqual(relinked.supabase_user_id, existing.supabase_user_id, 'now pointing at the new identity');
  });

  it('tells someone whose password was refused what was actually wrong', () => {
    // Supabase answers a rejected password with 422, the same status it uses
    // for other refusals. Reading the status before the code reported this as
    // a duplicate address, which is both wrong and unactionable.
    const weak = translate(
      { message: 'Password should be at least 6 characters.', status: 422, code: 'weak_password' },
      'sign-up',
    );
    assert.equal(weak.statusCode, 403);
    assert.match(weak.message, /Password should be at least 6 characters/);

    const duplicate = translate(
      { message: 'User already registered', status: 422, code: 'user_already_exists' },
      'sign-up',
    );
    assert.equal(duplicate.statusCode, 409, 'a real duplicate still reads as one');
  });

  it('reports which credential store is in play', async () => {
    useAuthGateway(null);
    const app = await getApp();
    const local = await app.inject({ method: 'GET', url: '/api/auth/status' });
    assert.equal(local.json().provider, 'local');

    useAuthGateway(fakeProvider().gateway);
    const supabase = await app.inject({ method: 'GET', url: '/api/auth/status' });
    assert.equal(supabase.json().provider, 'supabase');
  });

  it('gives a Supabase account a local library to own', async () => {
    const provider = fakeProvider();
    useAuthGateway(provider.gateway);
    const email = `new-${randomUUID()}@studex.test`;

    const created = await post('/api/auth/register', {
      email,
      password: 'correct-horse-battery-staple',
      displayName: 'Nadia Okonjo',
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().user.email, email);
    assert.equal(created.json().user.display_name, 'Nadia Okonjo');

    // The session is Studex's own, not Supabase's: everything downstream still
    // authorises against this database.
    const me = await (await getApp()).inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${created.json().token}` },
    });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().user.id, created.json().user.id);
  });

  it('keeps one local account per Supabase identity across sign-ins', async () => {
    const provider = fakeProvider();
    useAuthGateway(provider.gateway);
    const email = `steady-${randomUUID()}@studex.test`;

    const first = await post('/api/auth/register', {
      email,
      password: 'correct-horse-battery-staple',
      displayName: 'Steady',
    });
    const before = userCount();

    const second = await post('/api/auth/login', { email, password: 'correct-horse-battery-staple' });
    assert.equal(second.json().user.id, first.json().user.id);
    assert.equal(userCount(), before, 'signing in twice must not fork the library');
  });

  it('follows an address change made at the provider', async () => {
    const provider = fakeProvider();
    useAuthGateway(provider.gateway);
    const oldEmail = `before-${randomUUID()}@studex.test`;
    const newEmail = `after-${randomUUID()}@studex.test`;

    const created = await post('/api/auth/register', {
      email: oldEmail,
      password: 'correct-horse-battery-staple',
      displayName: 'Moving House',
    });
    provider.rename(oldEmail, newEmail);

    const signedIn = await post('/api/auth/login', {
      email: newEmail,
      password: 'correct-horse-battery-staple',
    });
    assert.equal(signedIn.statusCode, 200);
    assert.equal(
      signedIn.json().user.id,
      created.json().user.id,
      'the identity is the link, not the address',
    );
    assert.equal(signedIn.json().user.email, newEmail);
  });

  it('waits for a confirmation email before creating anything locally', async () => {
    const provider = fakeProvider({ requiresConfirmation: true });
    useAuthGateway(provider.gateway);
    const before = userCount();

    const created = await post('/api/auth/register', {
      email: `unconfirmed-${randomUUID()}@studex.test`,
      password: 'correct-horse-battery-staple',
      displayName: 'Not Yet',
    });

    assert.equal(created.statusCode, 202);
    assert.equal(created.json().pendingConfirmation, true);
    assert.equal(created.json().token, undefined, 'there is no session to hand out yet');
    assert.equal(userCount(), before, 'an unproven address owns nothing');
  });

  it('answers a wrong password the same way the local provider does', async () => {
    const provider = fakeProvider();
    useAuthGateway(provider.gateway);
    const email = `careful-${randomUUID()}@studex.test`;
    await post('/api/auth/register', {
      email,
      password: 'correct-horse-battery-staple',
      displayName: 'Careful',
    });

    const wrongPassword = await post('/api/auth/login', { email, password: 'not-the-passphrase' });
    const unknownAddress = await post('/api/auth/login', {
      email: `ghost-${randomUUID()}@studex.test`,
      password: 'not-the-passphrase',
    });

    assert.equal(wrongPassword.statusCode, 401);
    assert.equal(unknownAddress.statusCode, 401);
    assert.equal(
      wrongPassword.json().error.message,
      unknownAddress.json().error.message,
      'neither answer may say which half was wrong',
    );
  });

  it('reports a provider it cannot reach as a provider problem', async () => {
    useAuthGateway({
      async signUp() {
        throw new ApiError(502, 'identity_provider_unavailable', 'The sign-in service is unavailable.');
      },
      async signIn() {
        throw new ApiError(502, 'identity_provider_unavailable', 'The sign-in service is unavailable.');
      },
      async changePassword() {
        return null;
      },
    });

    const res = await post('/api/auth/login', {
      email: 'someone@studex.test',
      password: 'correct-horse-battery-staple',
    });
    assert.equal(res.statusCode, 502, 'not a 401 — the credentials were never judged');
  });

  it('changes the password at the provider and signs other devices out', async () => {
    const provider = fakeProvider();
    useAuthGateway(provider.gateway);
    const email = `rotating-${randomUUID()}@studex.test`;

    const first = await post('/api/auth/register', {
      email,
      password: 'correct-horse-battery-staple',
      displayName: 'Rotating',
    });
    // Signing in here already ends the registration session: an account holds
    // one live session. The change is therefore made from the newer device.
    const other = await post('/api/auth/login', { email, password: 'correct-horse-battery-staple' });

    const app = await getApp();
    const changed = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { authorization: `Bearer ${other.json().token}` },
      payload: {
        currentPassword: 'correct-horse-battery-staple',
        newPassword: 'an-entirely-different-passphrase',
      },
    });
    assert.equal(changed.statusCode, 204);
    assert.equal(
      provider.accounts.get(email)!.password,
      'an-entirely-different-passphrase',
      'the credential that actually matters lives at the provider',
    );

    const staleDevice = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${first.json().token}` },
    });
    assert.equal(staleDevice.statusCode, 401);

    const stillHere = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${other.json().token}` },
    });
    assert.equal(stillHere.statusCode, 200, 'the device that made the change keeps its session');
  });

  it('refuses to adopt an address on a database holding other accounts', async () => {
    useAuthGateway(null);
    const email = `crowded-${randomUUID()}@studex.test`;
    await post('/api/auth/register', {
      email,
      password: 'a-local-passphrase-here',
      displayName: 'Crowded',
    });
    assert.ok(userCount() > 1, 'this test needs the database to hold more than one account');

    const provider = fakeProvider();
    useAuthGateway(provider.gateway);
    await post('/api/auth/register', {
      email,
      password: 'a-supabase-passphrase-here',
      displayName: 'Crowded',
    });

    const res = await post('/api/auth/login', { email, password: 'a-supabase-passphrase-here' });
    assert.equal(res.statusCode, 409, 'walking into an existing library must not be automatic');
  });
});
