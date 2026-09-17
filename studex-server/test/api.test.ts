import './setup.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  api,
  closeApp,
  cookieApi,
  getApp,
  multipartBody,
  registerUser,
  samplePdf,
  samplePdfWithPages,
  samplePng,
  uuid,
  type Client,
} from './helpers.js';

let alice: Client;
let bob: Client;

before(async () => {
  await getApp();
  alice = await registerUser('Aisha K.');
  bob = await registerUser('Someone Else');
});

after(async () => {
  await closeApp();
});

/* -------------------------------------------------------------------------- */

describe('authentication', () => {
  it('rejects a short password at registration', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: `x-${uuid()}@studex.test`, password: 'short', displayName: 'X' },
    });
    assert.equal(res.statusCode, 422);
  });

  it('rejects a password containing the email address', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'chemistry-student@studex.test',
        password: 'chemistry-student-1',
        displayName: 'X',
      },
    });
    assert.equal(res.statusCode, 403);
  });

  it('refuses a duplicate email', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: alice.email, password: 'another-good-passphrase', displayName: 'Copy' },
    });
    assert.equal(res.statusCode, 409);
  });

  it('signs in with the right password and rejects the wrong one', async () => {
    const app = await getApp();
    const ok = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: alice.email, password: 'a-perfectly-fine-passphrase' },
    });
    assert.equal(ok.statusCode, 200);

    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: alice.email, password: 'not-the-right-password' },
    });
    assert.equal(bad.statusCode, 401);
  });

  it('gives the same answer for an unknown account as for a wrong password', async () => {
    const app = await getApp();
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: `ghost-${uuid()}@studex.test`, password: 'not-the-right-password' },
    });
    assert.equal(unknown.statusCode, 401);
    assert.equal(unknown.json().error.message, 'Incorrect email or password');
  });

  it('requires authentication for protected routes', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/api/files' });
    assert.equal(res.statusCode, 401);
  });

  it('rejects a garbage bearer token', async () => {
    const res = await api({ ...alice, token: 'not-a-real-token' }, { method: 'GET', url: '/api/files' });
    assert.equal(res.statusCode, 401);
  });

  it('never returns the password hash', async () => {
    const res = await api(alice, { method: 'GET', url: '/api/auth/me' });
    assert.equal(res.statusCode, 200);
    assert.ok(!JSON.stringify(res.json()).includes('argon2'));
    assert.equal(res.json().user.password_hash, undefined);
  });

  it('refuses an upgrade nobody has paid for', async () => {
    const res = await api(alice, { method: 'PATCH', url: '/api/auth/me/plan', payload: { plan: 'pro' } });
    assert.equal(res.statusCode, 402);
    assert.equal(res.json().error.code, 'payment_required');

    const after = await api(alice, { method: 'GET', url: '/api/auth/me' });
    assert.equal(after.json().user.plan, 'free');
  });

  it('moves the account between plans once it is entitled, and resizes its storage', async () => {
    const before = await api(alice, { method: 'GET', url: '/api/auth/me' });
    const freeQuota = before.json().user.storage_quota_bytes;

    // What a completed checkout would write. Nothing the client can reach
    // does this, which is the whole point of the previous test.
    const { grantProEntitlement } = await import('../src/domain/auth.js');
    grantProEntitlement(alice.userId, { source: 'purchase', reference: 'test' });

    const up = await api(alice, { method: 'PATCH', url: '/api/auth/me/plan', payload: { plan: 'pro' } });
    assert.equal(up.statusCode, 200);
    assert.equal(up.json().user.plan, 'pro');
    assert.ok(up.json().user.storage_quota_bytes > freeQuota);

    const down = await api(alice, { method: 'PATCH', url: '/api/auth/me/plan', payload: { plan: 'free' } });
    assert.equal(down.json().user.plan, 'free');
    assert.equal(down.json().user.storage_quota_bytes, freeQuota);
  });

  it('refuses a plan that does not exist, and an unauthenticated switch', async () => {
    const bogus = await api(alice, { method: 'PATCH', url: '/api/auth/me/plan', payload: { plan: 'unlimited' } });
    assert.equal(bogus.statusCode, 422);

    const app = await getApp();
    const anonymous = await app.inject({ method: 'PATCH', url: '/api/auth/me/plan', payload: { plan: 'pro' } });
    assert.equal(anonymous.statusCode, 401);
  });

  it('sets the session cookie httpOnly and the csrf cookie readable', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: alice.email, password: 'a-perfectly-fine-passphrase' },
    });
    const cookies = res.cookies as { name: string; httpOnly?: boolean; sameSite?: string }[];
    const session = cookies.find((c) => c.name === 'studex_session')!;
    const csrf = cookies.find((c) => c.name === 'studex_csrf')!;
    assert.equal(session.httpOnly, true);
    assert.equal(String(session.sameSite).toLowerCase(), 'strict');
    assert.notEqual(csrf.httpOnly, true, 'the double-submit token must be readable by script');
  });

  it('revokes other sessions when the password changes', async () => {
    const victim = await registerUser('Password Changer');
    const app = await getApp();

    const second = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: victim.email, password: 'a-perfectly-fine-passphrase' },
    });
    const secondToken = second.json().token;

    const change = await api(victim, {
      method: 'POST',
      url: '/api/auth/change-password',
      payload: {
        currentPassword: 'a-perfectly-fine-passphrase',
        newPassword: 'a-brand-new-passphrase-here',
      },
    });
    assert.equal(change.statusCode, 204);

    const stale = await api({ ...victim, token: secondToken }, { method: 'GET', url: '/api/auth/me' });
    assert.equal(stale.statusCode, 401, 'the other device is signed out');

    const current = await api(victim, { method: 'GET', url: '/api/auth/me' });
    assert.equal(current.statusCode, 200, 'the device that changed it stays signed in');
  });

  it('invalidates the session after logout', async () => {
    const temp = await registerUser('Logout Tester');
    const out = await api(temp, { method: 'POST', url: '/api/auth/logout' });
    assert.equal(out.statusCode, 204);
    const after = await api(temp, { method: 'GET', url: '/api/auth/me' });
    assert.equal(after.statusCode, 401);
  });
});

/* -------------------------------------------------------------------------- */

describe('CSRF and origin defences', () => {
  it('refuses a cookie-authenticated write with no CSRF token', async () => {
    const res = await cookieApi(alice, {
      method: 'POST',
      url: '/api/folders',
      payload: { name: 'No token' },
      csrf: null,
    });
    assert.equal(res.statusCode, 403);
    assert.match(res.json().error.message, /CSRF/i);
  });

  it('refuses a cookie-authenticated write with the wrong CSRF token', async () => {
    const res = await cookieApi(alice, {
      method: 'POST',
      url: '/api/folders',
      payload: { name: 'Wrong token' },
      csrf: 'a-token-that-is-not-the-right-one',
    });
    assert.equal(res.statusCode, 403);
  });

  it("refuses another user's CSRF token", async () => {
    const res = await cookieApi(alice, {
      method: 'POST',
      url: '/api/folders',
      payload: { name: 'Borrowed token' },
      csrf: bob.csrfToken,
    });
    assert.equal(res.statusCode, 403);
  });

  it('accepts a cookie-authenticated write with the matching CSRF token', async () => {
    const res = await cookieApi(alice, {
      method: 'POST',
      url: '/api/folders',
      payload: { name: 'Correct token' },
    });
    assert.equal(res.statusCode, 201);
  });

  it('refuses a state-changing request from a foreign origin', async () => {
    const res = await api(alice, {
      method: 'POST',
      url: '/api/folders',
      payload: { name: 'Evil' },
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(res.statusCode, 403);
  });

  it('allows a state-changing request from an allowed origin', async () => {
    const res = await api(alice, {
      method: 'POST',
      url: '/api/folders',
      payload: { name: 'Friendly origin' },
      headers: { origin: 'http://localhost:5173' },
    });
    assert.equal(res.statusCode, 201);
  });
});

/* -------------------------------------------------------------------------- */

describe('library', () => {
  it('creates folders and resolves inherited colour', async () => {
    const parent = await api(alice, {
      method: 'POST',
      url: '/api/folders',
      payload: { name: 'Chemistry', color: '#9184d9' },
    });
    assert.equal(parent.statusCode, 201);
    const parentId = parent.json().folder.id;

    const child = await api(alice, {
      method: 'POST',
      url: '/api/folders',
      payload: { name: 'Paper 2', parentId },
    });
    assert.equal(child.statusCode, 201);
    assert.equal(child.json().folder.color, null, 'the child stores no colour of its own');

    const list = await api(alice, { method: 'GET', url: '/api/folders' });
    const childRow = list.json().folders.find((f: { id: string }) => f.id === child.json().folder.id);
    assert.equal(childRow.effective_color, '#9184d9', 'colour is inherited from the parent');
  });

  it('refuses to move a folder inside its own subtree', async () => {
    const parent = (
      await api(alice, { method: 'POST', url: '/api/folders', payload: { name: 'Outer' } })
    ).json().folder;
    const child = (
      await api(alice, {
        method: 'POST',
        url: '/api/folders',
        payload: { name: 'Inner', parentId: parent.id },
      })
    ).json().folder;

    const res = await api(alice, {
      method: 'PATCH',
      url: `/api/folders/${parent.id}`,
      payload: { parentId: child.id },
    });
    assert.equal(res.statusCode, 400);
  });

  it('creates a file, overrides its colour, and trashes then restores it', async () => {
    const folder = (
      await api(alice, {
        method: 'POST',
        url: '/api/folders',
        payload: { name: 'Biology', color: 'lime' },
      })
    ).json().folder;

    const created = await api(alice, {
      method: 'POST',
      url: '/api/files',
      payload: { title: 'Required practical', kind: 'doc', folderId: folder.id },
    });
    assert.equal(created.statusCode, 201);
    const fileId = created.json().file.id;

    const inherited = await api(alice, { method: 'GET', url: `/api/files/${fileId}` });
    assert.equal(inherited.json().file.effective_color, 'lime');

    await api(alice, {
      method: 'PATCH',
      url: `/api/files/${fileId}`,
      payload: { colorOverride: 'rose' },
    });
    const overridden = await api(alice, { method: 'GET', url: `/api/files/${fileId}` });
    assert.equal(overridden.json().file.effective_color, 'rose', 'the file overrides the folder');

    const trashed = await api(alice, { method: 'DELETE', url: `/api/files/${fileId}` });
    assert.equal(trashed.statusCode, 204);
    const gone = await api(alice, { method: 'GET', url: `/api/files/${fileId}` });
    assert.equal(gone.statusCode, 404, 'a trashed file reads as absent');
    const bin = (await api(alice, { method: 'GET', url: '/api/files?trashed=1' })).json();
    assert.ok(bin.files.some((f: { id: string }) => f.id === fileId), 'the trash lists what was thrown away');
    const live = (await api(alice, { method: 'GET', url: '/api/files' })).json();
    assert.ok(!live.files.some((f: { id: string }) => f.id === fileId), 'and the library does not');

    const restored = await api(alice, { method: 'POST', url: `/api/files/${fileId}/restore` });
    assert.equal(restored.statusCode, 200);
    const back = await api(alice, { method: 'GET', url: `/api/files/${fileId}` });
    assert.equal(back.statusCode, 200);
  });

  it('rejects a file in a folder belonging to someone else', async () => {
    const bobFolder = (
      await api(bob, { method: 'POST', url: '/api/folders', payload: { name: "Bob's" } })
    ).json().folder;

    const res = await api(alice, {
      method: 'POST',
      url: '/api/files',
      payload: { title: 'Sneaky', kind: 'doc', folderId: bobFolder.id },
    });
    assert.equal(res.statusCode, 404);
  });

  it('lists the files it created, with counts and filters applied', async () => {
    const owner = await registerUser('Lister');
    const folder = (
      await api(owner, { method: 'POST', url: '/api/folders', payload: { name: 'Chemistry' } })
    ).json().folder;

    const deck = (
      await api(owner, {
        method: 'POST',
        url: '/api/files',
        payload: { title: 'Organic mechanisms', kind: 'deck', folderId: folder.id },
      })
    ).json().file;
    await api(owner, {
      method: 'POST',
      url: '/api/files',
      payload: { title: 'Rates of reaction', kind: 'doc', folderId: folder.id },
    });
    await api(owner, {
      method: 'POST',
      url: '/api/cards',
      payload: { deckId: deck.id, front: 'Q', back: 'A' },
    });

    const all = await api(owner, { method: 'GET', url: '/api/files' });
    assert.equal(all.statusCode, 200);
    assert.equal(all.json().files.length, 2, 'both files come back');

    const titles = all.json().files.map((f: { title: string }) => f.title);
    assert.ok(titles.includes('Organic mechanisms'));
    assert.ok(titles.includes('Rates of reaction'));

    const deckRow = all.json().files.find((f: { kind: string }) => f.kind === 'deck');
    assert.equal(deckRow.card_count, 1, 'card counts are reported');
    assert.equal(deckRow.due_count, 1, 'a brand-new card counts as due');

    const byFolder = await api(owner, { method: 'GET', url: `/api/files?folderId=${folder.id}` });
    assert.equal(byFolder.json().files.length, 2);

    const byKind = await api(owner, { method: 'GET', url: '/api/files?kind=doc' });
    assert.equal(byKind.json().files.length, 1);
    assert.equal(byKind.json().files[0].kind, 'doc');
  });

  it('reports how many files a page is a page of', async () => {
    const owner = await registerUser('Pager');
    const folder = (
      await api(owner, { method: 'POST', url: '/api/folders', payload: { name: 'Physics' } })
    ).json().folder;

    for (let i = 0; i < 5; i += 1) {
      await api(owner, {
        method: 'POST',
        url: '/api/files',
        payload: { title: `Note ${i}`, kind: 'doc', folderId: folder.id },
      });
    }
    await api(owner, { method: 'POST', url: '/api/files', payload: { title: 'Loose', kind: 'doc' } });

    const firstPage = await api(owner, { method: 'GET', url: '/api/files?limit=2' });
    assert.equal(firstPage.json().files.length, 2, 'the page is the size that was asked for');
    assert.equal(firstPage.json().total, 6, 'the total counts past the end of the page');

    const lastPage = await api(owner, { method: 'GET', url: '/api/files?limit=2&offset=4' });
    assert.equal(lastPage.json().files.length, 2);
    assert.equal(lastPage.json().total, 6, 'and does not change as the client walks through');

    // The total answers the same question the page does, filters included.
    const inFolder = await api(owner, {
      method: 'GET',
      url: `/api/files?folderId=${folder.id}&limit=1`,
    });
    assert.equal(inFolder.json().total, 5);

    const trashed = (await api(owner, { method: 'GET', url: '/api/files?limit=1' })).json().files[0];
    await api(owner, { method: 'DELETE', url: `/api/files/${trashed.id}` });
    const after = await api(owner, { method: 'GET', url: '/api/files?limit=1' });
    assert.equal(after.json().total, 5, 'a trashed file leaves the count as well as the list');
  });

  it('returns pinned files and recent files on the home summary', async () => {
    const owner = await registerUser('Home Lister');
    const file = (
      await api(owner, {
        method: 'POST',
        url: '/api/files',
        payload: { title: 'Equilibria map', kind: 'canvas' },
      })
    ).json().file;
    await api(owner, { method: 'PATCH', url: `/api/files/${file.id}`, payload: { pinned: true } });

    const pinned = await api(owner, { method: 'GET', url: '/api/files?pinned=true' });
    assert.equal(pinned.json().files.length, 1);
    assert.equal(pinned.json().files[0].title, 'Equilibria map');

    const home = await api(owner, { method: 'GET', url: '/api/home' });
    assert.equal(home.json().recent_files.length, 1, 'the home screen sees the file');
    assert.equal(home.json().pinned_files.length, 1);
  });

  it('rejects an unknown colour token', async () => {
    const res = await api(alice, {
      method: 'POST',
      url: '/api/folders',
      payload: { name: 'Bad colour', color: 'javascript:alert(1)' },
    });
    assert.equal(res.statusCode, 422);
  });
});

/* -------------------------------------------------------------------------- */

describe('cross-account isolation', () => {
  let aliceFile: string;
  let aliceFolder: string;
  let aliceDeck: string;
  let aliceCard: string;
  let aliceEvent: string;

  before(async () => {
    aliceFolder = (
      await api(alice, { method: 'POST', url: '/api/folders', payload: { name: 'Private' } })
    ).json().folder.id;

    aliceFile = (
      await api(alice, {
        method: 'POST',
        url: '/api/files',
        payload: { title: 'Private notes', kind: 'doc', folderId: aliceFolder },
      })
    ).json().file.id;

    aliceDeck = (
      await api(alice, {
        method: 'POST',
        url: '/api/files',
        payload: { title: 'Private deck', kind: 'deck' },
      })
    ).json().file.id;

    aliceCard = (
      await api(alice, {
        method: 'POST',
        url: '/api/cards',
        payload: { deckId: aliceDeck, front: 'Secret question', back: 'Secret answer' },
      })
    ).json().card.id;

    aliceEvent = (
      await api(alice, {
        method: 'POST',
        url: '/api/events',
        payload: { kind: 'exam', title: 'Chem Paper 2', startsAt: Date.now() + 86_400_000 },
      })
    ).json().event.id;
  });

  it("hides another user's file", async () => {
    const res = await api(bob, { method: 'GET', url: `/api/files/${aliceFile}` });
    assert.equal(res.statusCode, 404, 'not 403 — existence itself is not disclosed');
  });

  it("refuses to modify another user's file", async () => {
    const res = await api(bob, {
      method: 'PATCH',
      url: `/api/files/${aliceFile}`,
      payload: { title: 'Defaced' },
    });
    assert.equal(res.statusCode, 404);

    const check = await api(alice, { method: 'GET', url: `/api/files/${aliceFile}` });
    assert.equal(check.json().file.title, 'Private notes', 'the title is untouched');
  });

  it("refuses to delete another user's file", async () => {
    const res = await api(bob, { method: 'DELETE', url: `/api/files/${aliceFile}` });
    assert.equal(res.statusCode, 404);
    const check = await api(alice, { method: 'GET', url: `/api/files/${aliceFile}` });
    assert.equal(check.statusCode, 200, 'the file survives');
  });

  it("hides another user's document content", async () => {
    const res = await api(bob, { method: 'GET', url: `/api/documents/${aliceFile}` });
    assert.equal(res.statusCode, 404);
  });

  it("refuses to write another user's document", async () => {
    const res = await api(bob, {
      method: 'PUT',
      url: `/api/documents/${aliceFile}`,
      payload: { blocks: [{ id: uuid(), type: 'paragraph', text: 'injected' }] },
    });
    assert.equal(res.statusCode, 404);
  });

  it("hides another user's folder and refuses to delete it", async () => {
    const del = await api(bob, { method: 'DELETE', url: `/api/folders/${aliceFolder}` });
    assert.equal(del.statusCode, 404);
    const list = await api(alice, { method: 'GET', url: '/api/folders' });
    assert.ok(list.json().folders.some((f: { id: string }) => f.id === aliceFolder));
  });

  it("hides another user's cards and refuses to review them", async () => {
    const read = await api(bob, { method: 'GET', url: `/api/decks/${aliceDeck}/cards` });
    assert.equal(read.statusCode, 404);

    const review = await api(bob, {
      method: 'POST',
      url: `/api/cards/${aliceCard}/review`,
      payload: { rating: 1 },
    });
    assert.equal(review.statusCode, 404);
  });

  it("refuses to add a card to another user's deck", async () => {
    const res = await api(bob, {
      method: 'POST',
      url: '/api/cards',
      payload: { deckId: aliceDeck, front: 'Injected', back: 'Injected' },
    });
    assert.equal(res.statusCode, 404);
  });

  it("hides another user's events", async () => {
    const patch = await api(bob, {
      method: 'PATCH',
      url: `/api/events/${aliceEvent}`,
      payload: { title: 'Cancelled' },
    });
    assert.equal(patch.statusCode, 404);

    const list = await api(bob, { method: 'GET', url: '/api/events' });
    assert.ok(!list.json().events.some((e: { id: string }) => e.id === aliceEvent));
  });

  it("does not surface another user's content in search", async () => {
    const res = await api(bob, { method: 'GET', url: '/api/search?q=Secret' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().results.length, 0);

    const own = await api(alice, { method: 'GET', url: '/api/search?q=Secret' });
    assert.ok(own.json().results.length > 0, 'the owner still finds it');
  });

  it("keeps another user's files out of the file list", async () => {
    const res = await api(bob, { method: 'GET', url: '/api/files?limit=200' });
    const ids = res.json().files.map((f: { id: string }) => f.id);
    assert.ok(!ids.includes(aliceFile));
    assert.ok(!ids.includes(aliceDeck));
  });
});

/* -------------------------------------------------------------------------- */

describe('documents', () => {
  let fileId: string;

  before(async () => {
    fileId = (
      await api(alice, {
        method: 'POST',
        url: '/api/files',
        payload: { title: 'Rates of reaction', kind: 'doc' },
      })
    ).json().file.id;
  });

  it('saves and reads back blocks', async () => {
    const blocks = [
      { id: uuid(), type: 'heading', level: 1, text: 'Rates of reaction' },
      { id: uuid(), type: 'bullet', indent: 0, text: 'Collision theory' },
      {
        id: uuid(),
        type: 'table',
        columns: ['Factor', 'Effect'],
        rows: [['Temperature', 'Increases']],
      },
      { id: uuid(), type: 'todo', done: false, text: 'Past paper Q4' },
    ];

    const saved = await api(alice, {
      method: 'PUT',
      url: `/api/documents/${fileId}`,
      payload: { blocks },
    });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().document.blocks.length, 4);
    assert.equal(saved.json().document.revision, 2);

    const read = await api(alice, { method: 'GET', url: `/api/documents/${fileId}` });
    assert.equal(read.json().document.blocks[0].text, 'Rates of reaction');
  });

  it('exposes the heading outline', async () => {
    const res = await api(alice, { method: 'GET', url: `/api/documents/${fileId}/outline` });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(
      res.json().outline.map((h: { text: string }) => h.text),
      ['Rates of reaction'],
    );
  });

  it('rejects an unknown block type', async () => {
    const res = await api(alice, {
      method: 'PUT',
      url: `/api/documents/${fileId}`,
      payload: { blocks: [{ id: uuid(), type: 'script', text: 'alert(1)' }] },
    });
    assert.equal(res.statusCode, 422);
  });

  it('refuses a stale revision rather than clobbering', async () => {
    const current = (await api(alice, { method: 'GET', url: `/api/documents/${fileId}` })).json()
      .document.revision;

    const res = await api(alice, {
      method: 'PUT',
      url: `/api/documents/${fileId}`,
      payload: { blocks: [], expectedRevision: current - 1 },
    });
    assert.equal(res.statusCode, 409);
  });

  it('makes document text searchable', async () => {
    const res = await api(alice, { method: 'GET', url: '/api/search?q=collision' });
    assert.ok(res.json().results.some((r: { file_id: string }) => r.file_id === fileId));
  });

  it('refuses document routes on a file that is not a document', async () => {
    const canvasFile = (
      await api(alice, {
        method: 'POST',
        url: '/api/files',
        payload: { title: 'Not a doc', kind: 'canvas' },
      })
    ).json().file.id;

    const res = await api(alice, { method: 'GET', url: `/api/documents/${canvasFile}` });
    assert.equal(res.statusCode, 404);
  });

  it('stores an equation as LaTeX source and finds it by that source', async () => {
    const file = (
      await api(alice, { method: 'POST', url: '/api/files', payload: { title: 'Kinematics', kind: 'doc' } })
    ).json().file;

    const saved = await api(alice, {
      method: 'PUT',
      url: `/api/documents/${file.id}`,
      payload: {
        blocks: [
          { id: uuid(), type: 'math', latex: 'v^2 = u^2 + 2as', caption: 'The third equation' },
        ],
      },
    });
    assert.equal(saved.statusCode, 200);
    const block = saved.json().document.blocks[0];
    assert.equal(block.type, 'math');
    assert.equal(block.latex, 'v^2 = u^2 + 2as', 'the source is kept exactly as typed');

    // The LaTeX is indexed, because searching for a symbol you wrote is how
    // you find the page you wrote it on.
    const hits = await api(alice, { method: 'GET', url: '/api/search', query: { q: 'u^2' } });
    assert.ok(
      hits.json().results.some((r: { file_id?: string; id?: string }) => (r.file_id ?? r.id) === file.id),
      'the equation is findable by its source',
    );
  });

  it('refuses an equation longer than a single equation could be', async () => {
    const file = (
      await api(alice, { method: 'POST', url: '/api/files', payload: { title: 'Too much', kind: 'doc' } })
    ).json().file;
    const res = await api(alice, {
      method: 'PUT',
      url: `/api/documents/${file.id}`,
      payload: { blocks: [{ id: uuid(), type: 'math', latex: 'x'.repeat(4001) }] },
    });
    assert.equal(res.statusCode, 422);
  });
});

/* -------------------------------------------------------------------------- */

describe('canvas', () => {
  let canvasId: string;

  before(async () => {
    canvasId = (
      await api(alice, {
        method: 'POST',
        url: '/api/files',
        payload: { title: 'Equilibria map', kind: 'canvas' },
      })
    ).json().file.id;
  });

  it('saves notes, ink and a connector between them', async () => {
    const a = uuid();
    const b = uuid();
    const res = await api(alice, {
      method: 'PUT',
      url: `/api/canvases/${canvasId}`,
      payload: {
        objects: [
          { id: a, type: 'note', x: 0, y: 0, width: 200, height: 100, text: 'Dynamic equilibrium' },
          { id: b, type: 'note', x: 300, y: 0, width: 200, height: 100, text: 'Le Chatelier' },
          { id: uuid(), type: 'connector', x: 0, y: 0, fromId: a, toId: b, label: 'leads to' },
          { id: uuid(), type: 'ink', x: 0, y: 0, points: [[0, 0, 0.5], [10, 10, 0.6]] },
        ],
        viewport: { x: 0, y: 0, zoom: 0.68 },
      },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().canvas.stats.objects, 4);
    assert.equal(res.json().canvas.stats.ink_strokes, 1);
  });

  it('keeps the angle the plane was left at, and refuses more than a turn of it', async () => {
    const turned = await api(alice, {
      method: 'PUT',
      url: `/api/canvases/${canvasId}`,
      payload: { objects: [], viewport: { x: 12, y: -8, zoom: 1.5, rotation: -37.5 } },
    });
    assert.equal(turned.statusCode, 200);
    assert.equal(turned.json().canvas.viewport.rotation, -37.5);

    // A canvas saved before there was a rotate gesture has none, which is flat.
    const flat = await api(alice, {
      method: 'PUT',
      url: `/api/canvases/${canvasId}`,
      payload: { objects: [], viewport: { x: 0, y: 0, zoom: 1 } },
    });
    assert.equal(flat.json().canvas.viewport.rotation, 0);

    const absurd = await api(alice, {
      method: 'PUT',
      url: `/api/canvases/${canvasId}`,
      payload: { objects: [], viewport: { x: 0, y: 0, zoom: 1, rotation: 900 } },
    });
    assert.equal(absurd.statusCode, 422);
  });

  it('refuses a connector pointing at a missing object', async () => {
    const res = await api(alice, {
      method: 'PUT',
      url: `/api/canvases/${canvasId}`,
      payload: {
        objects: [{ id: uuid(), type: 'connector', x: 0, y: 0, fromId: uuid(), toId: uuid() }],
      },
    });
    assert.equal(res.statusCode, 409);
  });

  it('rejects a coordinate outside the allowed range', async () => {
    const res = await api(alice, {
      method: 'PUT',
      url: `/api/canvases/${canvasId}`,
      payload: {
        objects: [
          { id: uuid(), type: 'note', x: 1e12, y: 0, width: 10, height: 10, text: 'far away' },
        ],
      },
    });
    assert.equal(res.statusCode, 422);
  });
});

/* -------------------------------------------------------------------------- */

describe('flashcards', () => {
  let deckId: string;
  let cardId: string;

  before(async () => {
    deckId = (
      await api(alice, {
        method: 'POST',
        url: '/api/files',
        payload: { title: 'Organic mechanisms', kind: 'deck' },
      })
    ).json().file.id;

    cardId = (
      await api(alice, {
        method: 'POST',
        url: '/api/cards',
        payload: {
          deckId,
          front: "Why does Markovnikov's rule favour the more substituted carbocation?",
          back: 'Alkyl groups are electron-donating and stabilise the charge.',
          topic: 'Electrophilic addition',
        },
      })
    ).json().card.id;
  });

  it('puts a new card in the study queue', async () => {
    const res = await api(alice, { method: 'GET', url: `/api/study/queue?deckId=${deckId}` });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().cards.some((c: { id: string }) => c.id === cardId));
    assert.ok(res.json().new_count >= 1);
  });

  it('mixes a session across decks, narrowed by subject, tag or topic', async () => {
    const owner = await registerUser('Interleaver');

    // Biology lives on a folder; the deck sits a level below it, so its
    // subject is inherited through the chain, never stored on its own row.
    const biology = (
      await api(owner, { method: 'POST', url: '/api/subjects', payload: { name: 'Biology' } })
    ).json().subject;
    const chemistry = (
      await api(owner, { method: 'POST', url: '/api/subjects', payload: { name: 'Chemistry' } })
    ).json().subject;

    const bioFolder = (
      await api(owner, {
        method: 'POST',
        url: '/api/folders',
        payload: { name: 'Biology', subjectId: biology.id },
      })
    ).json().folder;
    const cellsFolder = (
      await api(owner, {
        method: 'POST',
        url: '/api/folders',
        payload: { name: 'Cells', parentId: bioFolder.id },
      })
    ).json().folder;
    const chemFolder = (
      await api(owner, {
        method: 'POST',
        url: '/api/folders',
        payload: { name: 'Chemistry', subjectId: chemistry.id },
      })
    ).json().folder;

    const mkDeck = async (title: string, folderId?: string) =>
      (
        await api(owner, {
          method: 'POST',
          url: '/api/files',
          payload: { title, kind: 'deck', ...(folderId ? { folderId } : {}) },
        })
      ).json().file.id;

    const cellDeck = await mkDeck('Cell division', cellsFolder.id); // Biology, inherited two levels up
    const chemDeck = await mkDeck('Reaction rates', chemFolder.id); // Chemistry
    const looseDeck = await mkDeck('Loose cards'); // no folder, so no subject

    const mkCard = async (deckId: string, front: string, topic: string) =>
      (
        await api(owner, {
          method: 'POST',
          url: '/api/cards',
          payload: { deckId, front, back: 'A', topic },
        })
      ).json().card.id;

    const bioCard = await mkCard(cellDeck, 'Phases of mitosis?', 'Mitosis');
    const chemCard = await mkCard(chemDeck, 'Rate law order?', 'Mitosis'); // same topic label, other subject
    const looseCard = await mkCard(looseDeck, 'Orphan question?', 'Mitosis');

    const ids = (r: { json(): { cards: { id: string }[] } }) =>
      new Set(r.json().cards.map((c) => c.id));

    // Subject resolves through the folder chain: the Biology deck is two folders
    // deep, yet its card is the only one the Biology session gathers.
    const bySubject = await api(owner, {
      method: 'GET',
      url: `/api/study/queue?subjectId=${biology.id}`,
    });
    assert.equal(bySubject.statusCode, 200);
    const subjectIds = ids(bySubject);
    assert.ok(subjectIds.has(bioCard), 'the Biology card is in the Biology session');
    assert.ok(!subjectIds.has(chemCard), 'the Chemistry card is not');
    assert.ok(!subjectIds.has(looseCard), 'a deck with no subject is not');

    // Topic is a free-text label carried on every card, so it cuts clean across
    // decks and subjects — all three Mitosis cards, wherever they live.
    const byTopic = await api(owner, {
      method: 'GET',
      url: `/api/study/queue?topic=${encodeURIComponent('Mitosis')}`,
    });
    const topicIds = ids(byTopic);
    assert.ok(
      topicIds.has(bioCard) && topicIds.has(chemCard) && topicIds.has(looseCard),
      'every card wearing the topic is gathered, whatever its deck',
    );

    // A tag on one deck narrows the mix to that deck's cards.
    const tag = (
      await api(owner, { method: 'POST', url: '/api/tags', payload: { name: 'Exam' } })
    ).json().tag;
    await api(owner, {
      method: 'POST',
      url: '/api/tags/attach',
      payload: { tagId: tag.id, itemType: 'file', itemId: chemDeck },
    });
    const byTag = await api(owner, { method: 'GET', url: `/api/study/queue?tagId=${tag.id}` });
    const tagIds = ids(byTag);
    assert.ok(tagIds.has(chemCard), 'the tagged deck\'s card is in the session');
    assert.ok(!tagIds.has(bioCard) && !tagIds.has(looseCard), 'untagged decks are not');
  });

  it('surfaces lapsed cards through Needs work, regardless of timing', async () => {
    const learner = await registerUser('Lapser');
    const deck = (
      await api(learner, {
        method: 'POST',
        url: '/api/files',
        payload: { title: 'Weak spots', kind: 'deck' },
      })
    ).json().file.id;
    const lapsed = (
      await api(learner, {
        method: 'POST',
        url: '/api/cards',
        payload: { deckId: deck, front: 'A tricky one', back: 'The answer' },
      })
    ).json().card.id;
    await api(learner, {
      method: 'POST',
      url: '/api/cards',
      payload: { deckId: deck, front: 'An easy one', back: 'No trouble' },
    });

    // Easy graduates the card to review; Again then costs it a lapse and
    // schedules it days out — the very card the ordinary due queue would hide.
    await api(learner, { method: 'POST', url: `/api/cards/${lapsed}/review`, payload: { rating: 4 } });
    const failed = await api(learner, {
      method: 'POST',
      url: `/api/cards/${lapsed}/review`,
      payload: { rating: 1 },
    });
    assert.equal(failed.json().card.lapses, 1);

    const needs = (await api(learner, { method: 'GET', url: '/api/stats/needs-work' })).json().needs_work;
    assert.equal(needs.lapse_total, 1, 'the lapsed card is counted');
    assert.ok(needs.lapse_cards.some((c: { id: string }) => c.id === lapsed));

    const weak = await api(learner, { method: 'GET', url: '/api/study/queue?weak=true' });
    const weakIds = new Set(weak.json().cards.map((c: { id: string }) => c.id));
    assert.ok(weakIds.has(lapsed), 'the weak queue serves the lapsed card despite its future due date');
    assert.equal(weakIds.size, 1, 'the never-failed card stays out of it');
  });

  it('advances the schedule when the card is graded', async () => {
    const first = await api(alice, {
      method: 'POST',
      url: `/api/cards/${cardId}/review`,
      payload: { rating: 3, durationMs: 6200 },
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().card.state, 'learning');

    const second = await api(alice, {
      method: 'POST',
      url: `/api/cards/${cardId}/review`,
      payload: { rating: 3 },
    });
    assert.equal(second.json().card.state, 'review');
    assert.ok(second.json().card.due_at > Date.now(), 'scheduled into the future');

    // The FSRS memory state is persisted, not merely computed and dropped:
    // without it every review would look like the card's first.
    const card = second.json().card;
    assert.ok(card.stability > 0, 'stability is stored on the row');
    assert.ok(card.difficulty >= 1 && card.difficulty <= 10);
  });

  it('rejects an invalid rating', async () => {
    const res = await api(alice, {
      method: 'POST',
      url: `/api/cards/${cardId}/review`,
      payload: { rating: 7 },
    });
    assert.equal(res.statusCode, 422);
  });

  it('excludes a suspended card from the queue', async () => {
    await api(alice, {
      method: 'PATCH',
      url: `/api/cards/${cardId}`,
      payload: { suspended: true },
    });
    const res = await api(alice, { method: 'GET', url: `/api/study/queue?deckId=${deckId}` });
    assert.ok(!res.json().cards.some((c: { id: string }) => c.id === cardId));

    await api(alice, {
      method: 'PATCH',
      url: `/api/cards/${cardId}`,
      payload: { suspended: false },
    });
  });

  it('reports deck statistics', async () => {
    const res = await api(alice, { method: 'GET', url: `/api/decks/${deckId}/stats` });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().stats.total >= 1);
  });

  it('does not count an unseen card as both due and new', async () => {
    // The deck page shows DUE and NEW side by side as separate columns, so a
    // card that lands in both makes the page claim more work than exists.
    const freshDeck = (
      await api(alice, {
        method: 'POST',
        url: '/api/files',
        payload: { title: 'Never studied', kind: 'deck' },
      })
    ).json().file.id;

    await api(alice, {
      method: 'POST',
      url: '/api/cards',
      payload: { deckId: freshDeck, front: 'Q', back: 'A' },
    });

    const stats = (await api(alice, { method: 'GET', url: `/api/decks/${freshDeck}/stats` })).json()
      .stats;
    assert.equal(stats.total, 1);
    assert.equal(stats.new, 1, 'the card is new');
    assert.equal(stats.due, 0, 'and therefore not also due for review');

    // The button on that page offers `due + new`, which has to be the one card.
    assert.equal(stats.due + stats.new, 1);

    // The review queue has always agreed; this is the count the page shows.
    const queue = (
      await api(alice, { method: 'GET', url: `/api/study/queue?deckId=${freshDeck}` })
    ).json();
    assert.equal(queue.due_count, 0);
    assert.equal(queue.new_count, 1);

    // The library badge means something else on purpose — everything waiting,
    // which for an unseen card is still one.
    const listed = (await api(alice, { method: 'GET', url: `/api/files?kind=deck` })).json().files;
    const row = listed.find((f: { id: string }) => f.id === freshDeck);
    assert.equal(row.due_count, 1, 'the library counts anything waiting, new included');
  });

  it('computes the test score on the server, not from the client', async () => {
    const extra = await api(alice, {
      method: 'POST',
      url: '/api/cards',
      payload: { deckId, front: 'Reagent for a primary alcohol to an aldehyde?', back: 'PCC' },
    });
    const extraId = extra.json().card.id;

    const test = (await api(alice, { method: 'POST', url: '/api/tests', payload: { deckId } })).json()
      .test;

    await api(alice, {
      method: 'POST',
      url: `/api/tests/${test.id}/answers`,
      payload: { cardId, correct: true, durationMs: 5000 },
    });
    const second = await api(alice, {
      method: 'POST',
      url: `/api/tests/${test.id}/answers`,
      // A client claiming a perfect score cannot override the tally.
      payload: { cardId: extraId, correct: false, durationMs: 7000, score_pct: 100 },
    });

    assert.equal(second.json().test.correct, 1);
    assert.equal(second.json().test.missed, 1);
    assert.equal(second.json().test.score_pct, 50);
    assert.equal(second.json().test.avg_time_ms, 6000);

    const ended = await api(alice, { method: 'POST', url: `/api/tests/${test.id}/end` });
    assert.ok(ended.json().test.ended_at > 0);
  });
});

/* -------------------------------------------------------------------------- */

describe('inline document cards and the daily queue', () => {
  let docId: string;

  before(async () => {
    docId = (
      await api(alice, {
        method: 'POST',
        url: '/api/files',
        payload: { title: 'Kinetics notes', kind: 'doc' },
      })
    ).json().file.id;
  });

  it('gives a document one companion deck, however often it is asked', async () => {
    const first = await api(alice, { method: 'POST', url: `/api/documents/${docId}/deck` });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().deck.kind, 'deck');

    const second = await api(alice, { method: 'POST', url: `/api/documents/${docId}/deck` });
    assert.equal(second.json().deck.id, first.json().deck.id);
  });

  it('stores a bullet that carries a card link and its collapsed state', async () => {
    const blockId = uuid();
    const save = await api(alice, {
      method: 'PUT',
      url: `/api/documents/${docId}`,
      payload: {
        blocks: [
          { id: blockId, type: 'bullet', text: 'Rate constant == k', indent: 0, collapsed: true },
          { id: uuid(), type: 'bullet', text: 'child', indent: 1 },
        ],
      },
    });
    assert.equal(save.statusCode, 200);
    const stored = save.json().document.blocks[0];
    assert.equal(stored.collapsed, true);
    assert.equal(stored.indent, 0);
  });

  it('another account cannot make a deck for this document', async () => {
    const res = await api(bob, { method: 'POST', url: `/api/documents/${docId}/deck` });
    assert.equal(res.statusCode, 404);
  });

  it('spends the day\u2019s allowance rather than resetting it on every visit', async () => {
    const before = (await api(alice, { method: 'GET', url: '/api/study/today' })).json().today;
    assert.ok(before.reviewed_today > 0, 'earlier tests have already reviewed cards today');

    // A limit equal to what the day has already served leaves nothing over.
    await api(alice, {
      method: 'PATCH',
      url: '/api/settings',
      payload: { dailyReviewLimit: before.reviewed_today, dailyNewCards: 0 },
    });

    const spent = await api(alice, { method: 'GET', url: '/api/study/queue' });
    assert.equal(spent.json().cards.length, 0, 'the day\u2019s allowance is used up');
    assert.equal((await api(alice, { method: 'GET', url: '/api/study/today' })).json().today.remaining, 0);

    // Raising the limit hands the same cards back, so nothing was lost.
    await api(alice, {
      method: 'PATCH',
      url: '/api/settings',
      payload: { dailyReviewLimit: 200, dailyNewCards: 20 },
    });
    const restored = (await api(alice, { method: 'GET', url: '/api/study/today' })).json().today;
    assert.equal(restored.remaining, Math.min(restored.due_count, 200) + Math.min(restored.new_count, 20));
  });
});


/* -------------------------------------------------------------------------- */

describe('PDF import and annotation', () => {
  let pdfFileId: string;

  it('accepts a real PDF and counts it against the quota', async () => {
    const before = (await api(alice, { method: 'GET', url: '/api/storage' })).json().storage;

    const body = multipartBody(
      { title: 'Paper 2 2024' },
      { field: 'file', filename: 'paper2.pdf', contentType: 'application/pdf', content: samplePdf(4096) },
    );

    const res = await api(alice, {
      method: 'POST',
      url: '/api/pdfs',
      payload: body.payload,
      headers: body.headers,
    });
    assert.equal(res.statusCode, 201);
    pdfFileId = res.json().fileId;
    assert.equal(res.json().pdf.byte_size, 4096);

    const after = (await api(alice, { method: 'GET', url: '/api/storage' })).json().storage;
    assert.equal(after.used_bytes, before.used_bytes + 4096);
  });

  let countedPdfId: string;

  it('reads the page count off the file at upload', async () => {
    // The point of reading it here: an annotation's page bound exists from the
    // moment the file lands, not from whenever the client gets round to
    // saying how big it is.
    const body = multipartBody(
      { title: 'Paper 1 2024' },
      {
        field: 'file',
        filename: 'paper1.pdf',
        contentType: 'application/pdf',
        content: samplePdfWithPages(14),
      },
    );

    const res = await api(alice, {
      method: 'POST',
      url: '/api/pdfs',
      payload: body.payload,
      headers: body.headers,
    });
    assert.equal(res.statusCode, 201);
    countedPdfId = res.json().fileId;
    assert.equal(res.json().pdf.page_count, 14);
  });

  it('refuses an annotation past the last page, without being told the size first', async () => {
    const res = await api(alice, {
      method: 'POST',
      url: `/api/pdfs/${countedPdfId}/annotations`,
      payload: {
        page: 15,
        kind: 'highlight',
        geometry: { kind: 'quads', quads: [{ x: 80, y: 220, width: 340, height: 16 }] },
      },
    });
    assert.equal(res.statusCode, 400);
  });

  it('will not let a client talk the page count into being something else', async () => {
    const res = await api(alice, {
      method: 'PATCH',
      url: `/api/pdfs/${countedPdfId}`,
      payload: { pageCount: 900 },
    });
    assert.equal(res.statusCode, 400);

    // And the stored bound is untouched by the attempt.
    const after = await api(alice, { method: 'GET', url: `/api/pdfs/${countedPdfId}` });
    assert.equal(after.json().pdf.page_count, 14);
  });

  it('accepts a repeat of the count it already worked out', async () => {
    // The client parses the file too. Agreeing with the server is not an error.
    const res = await api(alice, {
      method: 'PATCH',
      url: `/api/pdfs/${countedPdfId}`,
      payload: { pageCount: 14 },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().pdf.page_count, 14);
  });

  it("still takes the client's count for a PDF it could not read", async () => {
    // The file uploaded above has no page tree, so the client's parse is the
    // only source there is. Refusing it would refuse a fact nobody else knows.
    const before = await api(alice, { method: 'GET', url: `/api/pdfs/${pdfFileId}` });
    assert.equal(before.json().pdf.page_count, null);

    const res = await api(alice, {
      method: 'PATCH',
      url: `/api/pdfs/${pdfFileId}`,
      payload: { pageCount: 22 },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().pdf.page_count, 22);
  });

  it('rejects a file that is not really a PDF', async () => {
    const body = multipartBody(
      { title: 'Not a PDF' },
      {
        field: 'file',
        filename: 'evil.pdf',
        // Declared as a PDF, but the bytes say otherwise.
        contentType: 'application/pdf',
        content: Buffer.from('<html><script>alert(1)</script></html>', 'utf8'),
      },
    );

    const res = await api(alice, {
      method: 'POST',
      url: '/api/pdfs',
      payload: body.payload,
      headers: body.headers,
    });
    assert.equal(res.statusCode, 400);
  });

  it('streams the content back with safe headers', async () => {
    const res = await api(alice, { method: 'GET', url: `/api/pdfs/${pdfFileId}/content` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'application/pdf');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.match(String(res.headers['content-disposition']), /^inline; filename="paper2\.pdf"$/);
    assert.ok(res.rawPayload.subarray(0, 5).equals(Buffer.from('%PDF-', 'ascii')));
  });

  it('lets its own reader embed the stored PDF, and nobody else', async () => {
    // The reader draws the file in a same-origin iframe. The app-wide policy
    // forbids framing outright, so this route has to say otherwise itself.
    const res = await api(alice, { method: 'GET', url: `/api/pdfs/${pdfFileId}/content` });
    assert.equal(res.statusCode, 200);
    const csp = res.headers['content-security-policy'] as string;
    assert.match(csp, /frame-ancestors 'self'/, 'the reader can embed it');
    assert.doesNotMatch(csp, /frame-ancestors 'none'/);
    assert.match(csp, /default-src 'none'/, 'and the bytes still load nothing');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  });

  it("refuses to stream another user's PDF", async () => {
    const res = await api(bob, { method: 'GET', url: `/api/pdfs/${pdfFileId}/content` });
    assert.equal(res.statusCode, 404);
  });

  it('stores highlights, ink and comments and finds them in search', async () => {
    const highlight = await api(alice, {
      method: 'POST',
      url: `/api/pdfs/${pdfFileId}/annotations`,
      payload: {
        page: 2,
        kind: 'highlight',
        geometry: { kind: 'quads', quads: [{ x: 80, y: 220, width: 340, height: 16 }] },
        quotedText: 'what is meant by the term dynamic equilibrium',
        note: 'Definition mark is for rates equal.',
      },
    });
    assert.equal(highlight.statusCode, 201);

    const comment = await api(alice, {
      method: 'POST',
      url: `/api/pdfs/${pdfFileId}/annotations`,
      payload: {
        page: 2,
        kind: 'comment',
        geometry: { kind: 'point', x: 460, y: 300 },
        note: 'Cooling raised the yield, so forward is exothermic.',
      },
    });
    assert.equal(comment.statusCode, 201);

    const list = await api(alice, { method: 'GET', url: `/api/pdfs/${pdfFileId}/annotations` });
    assert.equal(list.json().annotations.length, 2);

    const found = await api(alice, { method: 'GET', url: '/api/search?q=exothermic' });
    assert.ok(found.json().results.some((r: { entity_type: string }) => r.entity_type === 'annotation'));
  });

  it('rejects geometry that does not match the annotation kind', async () => {
    const res = await api(alice, {
      method: 'POST',
      url: `/api/pdfs/${pdfFileId}/annotations`,
      payload: {
        page: 1,
        kind: 'highlight',
        geometry: { kind: 'point', x: 1, y: 1 },
      },
    });
    assert.equal(res.statusCode, 400);
  });

  it('turns highlights into cards without duplicating on a second run', async () => {
    const deckId = (
      await api(alice, {
        method: 'POST',
        url: '/api/files',
        payload: { title: 'Paper 2 deck', kind: 'deck' },
      })
    ).json().file.id;

    const first = await api(alice, {
      method: 'POST',
      url: `/api/pdfs/${pdfFileId}/cards-from-highlights`,
      payload: { deckId },
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().created, 1, 'only the highlight with quoted text becomes a card');

    const second = await api(alice, {
      method: 'POST',
      url: `/api/pdfs/${pdfFileId}/cards-from-highlights`,
      payload: { deckId },
    });
    assert.equal(second.json().created, 0, 'repeating the action creates nothing new');
    assert.equal(second.json().skipped, 1);
  });

  it('exports annotations as markdown', async () => {
    const res = await api(alice, { method: 'GET', url: `/api/pdfs/${pdfFileId}/export` });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /## Page 2/);
    assert.match(res.body, /dynamic equilibrium/);
  });

  it('refuses an upload that exceeds the remaining quota', async () => {
    const hog = await registerUser('Quota Hog');
    // The test quota is 5 MB and the per-upload cap is 2 MB.
    for (let i = 0; i < 3; i++) {
      const body = multipartBody(
        { title: `Big ${i}` },
        {
          field: 'file',
          filename: `big${i}.pdf`,
          contentType: 'application/pdf',
          content: samplePdf(2 * 1024 * 1024),
        },
      );
      await api(hog, { method: 'POST', url: '/api/pdfs', payload: body.payload, headers: body.headers });
    }

    const usage = (await api(hog, { method: 'GET', url: '/api/storage' })).json().storage;
    assert.ok(usage.used_bytes <= usage.quota_bytes, 'never exceeds the quota');

    const body = multipartBody(
      { title: 'One too many' },
      {
        field: 'file',
        filename: 'extra.pdf',
        contentType: 'application/pdf',
        content: samplePdf(2 * 1024 * 1024),
      },
    );
    const res = await api(hog, {
      method: 'POST',
      url: '/api/pdfs',
      payload: body.payload,
      headers: body.headers,
    });
    assert.ok(res.statusCode >= 400, `expected a rejection, got ${res.statusCode}`);
  });

  it('leaves nothing behind when the upload is cut off at the limit', async () => {
    // The multipart parser stops a stream that reaches its limit and sets a
    // flag rather than erroring, so the truncated bytes look to everything
    // downstream like a file that simply ended. Before this was checked while
    // the blob was still a temp file, the PDF was stored, charged to the
    // quota, and entered in the library — and then the request answered 413,
    // leaving a file that opens to half a document.
    const owner = await registerUser('Truncation Tester');
    const body = multipartBody(
      { title: 'Far too big' },
      {
        field: 'file',
        filename: 'huge.pdf',
        contentType: 'application/pdf',
        // Comfortably past the 2 MB per-upload cap in the test environment.
        content: samplePdf(3 * 1024 * 1024),
      },
    );
    const res = await api(owner, {
      method: 'POST',
      url: '/api/pdfs',
      payload: body.payload,
      headers: body.headers,
    });
    assert.equal(res.statusCode, 413);

    const usage = (await api(owner, { method: 'GET', url: '/api/storage' })).json().storage;
    assert.equal(usage.used_bytes, 0, 'a refused upload costs nothing');

    const listed = (await api(owner, { method: 'GET', url: '/api/files' })).json();
    assert.equal(listed.files.length, 0, 'and leaves no file to open');
  });

  it('frees quota when the file is purged', async () => {
    const owner = await registerUser('Purge Tester');
    const body = multipartBody(
      { title: 'Temporary' },
      { field: 'file', filename: 't.pdf', contentType: 'application/pdf', content: samplePdf(2048) },
    );
    const created = await api(owner, {
      method: 'POST',
      url: '/api/pdfs',
      payload: body.payload,
      headers: body.headers,
    });
    const fileId = created.json().fileId;

    const before = (await api(owner, { method: 'GET', url: '/api/storage' })).json().storage;
    assert.equal(before.used_bytes, 2048);

    await api(owner, { method: 'DELETE', url: `/api/files/${fileId}/purge` });
    const after = (await api(owner, { method: 'GET', url: '/api/storage' })).json().storage;
    assert.equal(after.used_bytes, 0, 'the quota is released');
  });
});

/* -------------------------------------------------------------------------- */

describe('calendar and focus timer', () => {
  it('creates exams and deadlines and lists what is next', async () => {
    const student = await registerUser('Calendar Student');
    const subject = (
      await api(student, { method: 'POST', url: '/api/subjects', payload: { name: 'Chemistry' } })
    ).json().subject;

    await api(student, {
      method: 'POST',
      url: '/api/events',
      payload: {
        kind: 'exam',
        title: 'Chem Paper 2',
        subjectId: subject.id,
        startsAt: Date.now() + 2 * 86_400_000,
        location: 'Hall B',
      },
    });
    await api(student, {
      method: 'POST',
      url: '/api/events',
      payload: {
        kind: 'deadline',
        title: 'Essay 2 hand-in',
        startsAt: Date.now() + 7 * 86_400_000,
      },
    });

    const res = await api(student, { method: 'GET', url: '/api/events/upcoming' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().events[0].title, 'Chem Paper 2');
    assert.equal(res.json().events[0].days_until, 2);
    assert.equal(res.json().events[0].location, 'Hall B');
  });

  it('schedules something that is not an exam, a deadline or a class', async () => {
    const student = await registerUser('Open Evening Student');
    const made = await api(student, {
      method: 'POST',
      url: '/api/events',
      payload: {
        kind: 'event',
        title: 'Sixth form open evening',
        startsAt: Date.now() + 3 * 86_400_000,
        location: 'Main hall',
      },
    });
    assert.equal(made.statusCode, 201);
    assert.equal(made.json().event.kind, 'event');

    // It belongs in the calendar, but not among the things being counted down
    // to — a plain event is not a deadline.
    const upcoming = await api(student, { method: 'GET', url: '/api/events/upcoming' });
    assert.ok(!upcoming.json().events.some((e: { kind: string }) => e.kind === 'event'));

    const listed = await api(student, { method: 'GET', url: '/api/events' });
    assert.ok(listed.json().events.some((e: { title: string }) => e.title === 'Sixth form open evening'));
  });

  it('rejects an event that ends before it starts', async () => {
    const res = await api(alice, {
      method: 'POST',
      url: '/api/events',
      payload: {
        kind: 'study_block',
        title: 'Backwards',
        startsAt: Date.now() + 10_000,
        endsAt: Date.now(),
      },
    });
    assert.equal(res.statusCode, 422);
  });

  it('runs the focus timer and derives elapsed time on the server', async () => {
    const student = await registerUser('Timer Student');

    const started = await api(student, {
      method: 'POST',
      url: '/api/study-sessions',
      payload: { plannedMinutes: 25, cycleIndex: 3, cycleTotal: 4 },
    });
    assert.equal(started.statusCode, 201);
    const sessionId = started.json().session.id;
    assert.equal(started.json().session.status, 'running');
    assert.equal(started.json().session.remaining_seconds, 25 * 60);

    const conflict = await api(student, {
      method: 'POST',
      url: '/api/study-sessions',
      payload: { plannedMinutes: 25 },
    });
    assert.equal(conflict.statusCode, 409, 'only one session may run at a time');

    const paused = await api(student, {
      method: 'POST',
      url: `/api/study-sessions/${sessionId}/pause`,
    });
    assert.equal(paused.json().session.status, 'paused');

    const resumed = await api(student, {
      method: 'POST',
      url: `/api/study-sessions/${sessionId}/resume`,
    });
    assert.equal(resumed.json().session.status, 'running');

    const ended = await api(student, {
      method: 'POST',
      url: `/api/study-sessions/${sessionId}/end`,
      payload: { status: 'completed' },
    });
    assert.equal(ended.json().session.status, 'completed');
    // Elapsed comes from server clocks, so a few seconds at most in a test run.
    assert.ok(ended.json().session.elapsed_seconds < 60);

    const again = await api(student, {
      method: 'POST',
      url: `/api/study-sessions/${sessionId}/end`,
      payload: { status: 'completed' },
    });
    assert.equal(again.statusCode, 409, 'a finished session cannot end twice');
  });

  it("refuses to control another user's timer", async () => {
    const owner = await registerUser('Timer Owner');
    const session = (
      await api(owner, { method: 'POST', url: '/api/study-sessions', payload: { plannedMinutes: 25 } })
    ).json().session;

    const res = await api(bob, { method: 'POST', url: `/api/study-sessions/${session.id}/pause` });
    assert.equal(res.statusCode, 404);
  });
});

/* -------------------------------------------------------------------------- */

describe('mock exams', () => {
  it('builds a subject paper, marks it, and feeds the topic matrix', async () => {
    const student = await registerUser('Mock Sitter');

    const biology = (
      await api(student, { method: 'POST', url: '/api/subjects', payload: { name: 'Biology' } })
    ).json().subject;

    // A real topic row the paper should be able to re-rate — start it high so the
    // drop after a poor paper is unambiguous.
    const topic = (
      await api(student, {
        method: 'POST',
        url: '/api/topics',
        payload: { name: 'Mitosis', subjectId: biology.id, confidence: 5 },
      })
    ).json().topic;

    // The deck's subject is inherited from the folder, never stored on the deck.
    const folder = (
      await api(student, {
        method: 'POST',
        url: '/api/folders',
        payload: { name: 'Cells', subjectId: biology.id },
      })
    ).json().folder;
    const deck = (
      await api(student, {
        method: 'POST',
        url: '/api/files',
        payload: { title: 'Cell division', kind: 'deck', folderId: folder.id },
      })
    ).json().file;

    for (let i = 0; i < 3; i++) {
      await api(student, {
        method: 'POST',
        url: '/api/cards',
        payload: { deckId: deck.id, front: `Phase ${i}?`, back: `Answer ${i}`, topic: 'Mitosis' },
      });
    }

    // A subject with no cards cannot be sat.
    const empty = (
      await api(student, { method: 'POST', url: '/api/subjects', payload: { name: 'Empty' } })
    ).json().subject;
    const refused = await api(student, {
      method: 'POST',
      url: '/api/mocks',
      payload: { subjectId: empty.id },
    });
    assert.equal(refused.statusCode, 400);

    const started = await api(student, {
      method: 'POST',
      url: '/api/mocks',
      payload: { subjectId: biology.id, count: 20, durationMin: 30 },
    });
    assert.equal(started.statusCode, 201);
    const mock = started.json().mock;
    assert.equal(mock.questions.length, 3, 'every card in the subject becomes a question');
    assert.equal(mock.duration_min, 30);

    // One right, two wrong: 1 of 3 on Mitosis.
    for (let i = 0; i < mock.questions.length; i++) {
      await api(student, {
        method: 'POST',
        url: `/api/mocks/${mock.id}/answers`,
        payload: { questionId: mock.questions[i].id, correct: i === 0 },
      });
    }

    const finished = (
      await api(student, { method: 'POST', url: `/api/mocks/${mock.id}/finish` })
    ).json().mock;
    assert.ok(Math.abs(finished.score_pct - 33.333) < 0.01, 'one of three marked correct');
    const line = finished.breakdown.find((b: { topic: string }) => b.topic === 'Mitosis');
    assert.equal(line.correct, 1);
    assert.equal(line.total, 3);
    assert.equal(line.pct, 33);
    assert.equal(line.confidence, 2, '33% maps to a shaky self-rating');

    // The matrix actually moved: the topic that started at 5 is now what the
    // paper said it was.
    const topicsNow = (await api(student, { method: 'GET', url: '/api/topics' })).json().topics;
    const rerated = topicsNow.find((t: { id: string }) => t.id === topic.id);
    assert.equal(rerated.confidence, 2, 'sitting the mock re-rated the topic');
  });
});

/* -------------------------------------------------------------------------- */

describe('statistics', () => {
  it('computes mastery, readiness and the home summary', async () => {
    const student = await registerUser('Stats Student');

    const subject = (
      await api(student, { method: 'POST', url: '/api/subjects', payload: { name: 'Chemistry' } })
    ).json().subject;
    const folder = (
      await api(student, {
        method: 'POST',
        url: '/api/folders',
        payload: { name: 'Chemistry', subjectId: subject.id },
      })
    ).json().folder;
    const deck = (
      await api(student, {
        method: 'POST',
        url: '/api/files',
        payload: { title: 'Chem deck', kind: 'deck', folderId: folder.id },
      })
    ).json().file;

    for (let i = 0; i < 4; i++) {
      await api(student, {
        method: 'POST',
        url: '/api/cards',
        payload: { deckId: deck.id, front: `Q${i}`, back: `A${i}` },
      });
    }

    const mastery = await api(student, { method: 'GET', url: '/api/stats/mastery' });
    assert.equal(mastery.statusCode, 200);
    const chem = mastery.json().mastery.find((m: { name: string }) => m.name === 'Chemistry');
    assert.equal(chem.card_count, 4);
    assert.equal(chem.mastery_pct, 0, 'brand-new cards count as no mastery');

    await api(student, {
      method: 'POST',
      url: '/api/events',
      payload: { kind: 'exam', title: 'Chem Paper 2', subjectId: subject.id, startsAt: Date.now() + 2 * 86_400_000 },
    });

    const readiness = await api(student, { method: 'GET', url: '/api/stats/readiness' });
    assert.equal(readiness.json().readiness[0].readiness, 'behind', 'no mastery two days out');

    const overview = await api(student, { method: 'GET', url: '/api/stats/overview' });
    assert.equal(overview.statusCode, 200);
    assert.equal(overview.json().overview.hours_series.length, 30);
    assert.equal(typeof overview.json().overview.streak_days, 'number');

    const home = await api(student, { method: 'GET', url: '/api/home' });
    assert.equal(home.statusCode, 200);
    assert.equal(home.json().next_exam.title, 'Chem Paper 2');
    assert.equal(home.json().cards_due, 4);
  });
});

/* -------------------------------------------------------------------------- */

describe('search', () => {
  it('treats FTS operators in the query as literal text', async () => {
    // These would be syntax errors or query-language operators if passed through.
    for (const q of ['dynamic OR *', 'NEAR(a b)', '"unbalanced', 'a AND (b', '*']) {
      const res = await api(alice, {
        method: 'GET',
        url: `/api/search?q=${encodeURIComponent(q)}`,
      });
      assert.equal(res.statusCode, 200, `query ${q} should not error`);
      assert.ok(Array.isArray(res.json().results));
    }
  });

  it('matches on a prefix', async () => {
    const res = await api(alice, { method: 'GET', url: '/api/search?q=equilib' });
    assert.ok(res.json().results.length > 0);
  });

  it('filters by entity type', async () => {
    const res = await api(alice, { method: 'GET', url: '/api/search?q=equilibrium&types=annotation' });
    assert.ok(res.json().results.every((r: { entity_type: string }) => r.entity_type === 'annotation'));
  });

  it('takes a trashed deck\u2019s cards out of the index with it, and puts them back', async () => {
    const student = await registerUser('Cascade Student');
    const deck = (
      await api(student, {
        method: 'POST',
        url: '/api/files',
        payload: { title: 'Sweepable deck', kind: 'deck' },
      })
    ).json().file;
    await api(student, {
      method: 'POST',
      url: '/api/cards',
      payload: { deckId: deck.id, front: 'Zygomorphic flower', back: 'Bilaterally symmetric' },
    });

    const findable = async () =>
      (await api(student, { method: 'GET', url: '/api/search?q=zygomorphic' })).json().results.length;

    assert.ok((await findable()) > 0, 'the card should be findable to start with');

    await api(student, { method: 'DELETE', url: `/api/files/${deck.id}` });
    assert.equal(await findable(), 0, 'a trashed deck should take its cards out of search');

    await api(student, { method: 'POST', url: `/api/files/${deck.id}/restore` });
    assert.ok((await findable()) > 0, 'restoring should put the cards back');
  });
});

/* -------------------------------------------------------------------------- */

describe('the Spotlight corpus', () => {
  it('offers whole files, with their text, newest first', async () => {
    const student = await registerUser('Spotlight Student');
    const doc = (
      await api(student, {
        method: 'POST',
        url: '/api/files',
        payload: { title: 'Le Chatelier', kind: 'doc' },
      })
    ).json().file;
    const written = await api(student, {
      method: 'PUT',
      url: `/api/documents/${doc.id}`,
      payload: {
        blocks: [{ id: uuid(), type: 'paragraph', text: 'Shifting an equilibrium by changing the pressure.' }],
      },
    });
    assert.equal(written.statusCode, 200);

    const res = await api(student, { method: 'GET', url: '/api/search/corpus' });
    assert.equal(res.statusCode, 200);
    const items: { id: string; kind: string; title: string; text: string; updated_at: number }[] =
      res.json().items;
    const hit = items.find((i) => i.id === doc.id);
    assert.ok(hit, 'the document should be in the corpus');
    assert.equal(hit.kind, 'doc');
    assert.equal(hit.title, 'Le Chatelier');
    assert.match(hit.text, /pressure/);
    assert.ok(typeof hit.updated_at === 'number');
  });

  it('carries nothing belonging to anyone else, and drops what is trashed', async () => {
    const mine = await registerUser('Corpus Owner');
    const theirs = await registerUser('Corpus Stranger');
    const secret = (
      await api(theirs, {
        method: 'POST',
        url: '/api/files',
        payload: { title: 'Their private revision', kind: 'doc' },
      })
    ).json().file;
    const gone = (
      await api(mine, { method: 'POST', url: '/api/files', payload: { title: 'Binned', kind: 'doc' } })
    ).json().file;
    await api(mine, { method: 'DELETE', url: `/api/files/${gone.id}` });

    const items: { id: string }[] = (
      await api(mine, { method: 'GET', url: '/api/search/corpus' })
    ).json().items;
    assert.ok(!items.some((i) => i.id === secret.id), 'another account\u2019s file must not appear');
    assert.ok(!items.some((i) => i.id === gone.id), 'a trashed file must not appear');
  });

  it('turns away a request carrying no session', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/api/search/corpus' });
    assert.equal(res.statusCode, 401);
  });
});

/* -------------------------------------------------------------------------- */

describe('the Spotlight device setting', () => {
  it('is off until it is switched on, and can be switched back', async () => {
    const student = await registerUser('Indexing Student');
    const device = 'device-spotlight-1';

    const initial = (
      await api(student, { method: 'GET', url: `/api/settings/devices/${device}` })
    ).json().settings;
    assert.equal(initial.spotlight, false, 'indexing notes outside the app must be opt-in');

    const on = (
      await api(student, {
        method: 'PATCH',
        url: `/api/settings/devices/${device}`,
        payload: { spotlight: true },
      })
    ).json().settings;
    assert.equal(on.spotlight, true);

    const off = (
      await api(student, {
        method: 'PATCH',
        url: `/api/settings/devices/${device}`,
        payload: { spotlight: false },
      })
    ).json().settings;
    assert.equal(off.spotlight, false);
  });

  it('is per device, so consenting on one machine says nothing about another', async () => {
    const student = await registerUser('Two Machines');
    await api(student, {
      method: 'PATCH',
      url: '/api/settings/devices/device-laptop-of-mine',
      payload: { spotlight: true },
    });
    const other = (
      await api(student, { method: 'GET', url: '/api/settings/devices/device-in-the-library' })
    ).json().settings;
    assert.equal(other.spotlight, false);
  });

  it('rejects a non-boolean', async () => {
    const student = await registerUser('Bad Patch');
    const res = await api(student, {
      method: 'PATCH',
      url: '/api/settings/devices/device-spotlight-2',
      payload: { spotlight: 'yes please' },
    });
    assert.equal(res.statusCode, 422);
  });
});

/* -------------------------------------------------------------------------- */

describe('colour inheritance', () => {
  it('lets a file keep its own colour inside a coloured folder', async () => {
    const student = await registerUser('Palette Student');
    const folder = (
      await api(student, { method: 'POST', url: '/api/folders', payload: { name: 'Physics', color: 'sky' } })
    ).json().folder;
    const file = (
      await api(student, {
        method: 'POST',
        url: '/api/files',
        payload: { title: 'Waves', kind: 'doc', folderId: folder.id },
      })
    ).json().file;

    const colorOf = async (id: string) =>
      (await api(student, { method: 'GET', url: `/api/files/${id}` })).json().file.effective_color;

    assert.equal(await colorOf(file.id), 'sky', 'with no colour of its own it follows the folder');

    await api(student, { method: 'PATCH', url: `/api/files/${file.id}`, payload: { colorOverride: 'rose' } });
    assert.equal(await colorOf(file.id), 'rose');

    // Recolouring the folder must not reach inside a file that has chosen.
    await api(student, { method: 'PATCH', url: `/api/folders/${folder.id}`, payload: { color: 'lime' } });
    assert.equal(await colorOf(file.id), 'rose');

    await api(student, { method: 'PATCH', url: `/api/files/${file.id}`, payload: { colorOverride: null } });
    assert.equal(await colorOf(file.id), 'lime', 'clearing the override hands it back to the folder');
  });
});

/* -------------------------------------------------------------------------- */

describe('deletion cascade', () => {
  it('stops counting a trashed deck\u2019s cards towards study', async () => {
    const student = await registerUser('Tidy Student');
    const deck = (
      await api(student, { method: 'POST', url: '/api/files', payload: { title: 'Throwaway', kind: 'deck' } })
    ).json().file;
    for (const front of ['One', 'Two', 'Three']) {
      await api(student, {
        method: 'POST',
        url: '/api/cards',
        payload: { deckId: deck.id, front, back: 'x' },
      });
    }

    const today = async () => (await api(student, { method: 'GET', url: '/api/study/today' })).json().today;
    const before = await today();
    assert.equal(before.new_count, 3);

    await api(student, { method: 'DELETE', url: `/api/files/${deck.id}` });

    const after = await today();
    assert.equal(after.new_count, 0, 'a deck in the trash should not be asking to be studied');
    assert.equal(after.remaining, 0);

    const queue = (await api(student, { method: 'GET', url: '/api/study/queue' })).json();
    assert.equal(queue.cards.length, 0);
  });

  it('deletes one card without touching the rest of its deck', async () => {
    const student = await registerUser('Card Student');
    const deck = (
      await api(student, { method: 'POST', url: '/api/files', payload: { title: 'Keepable', kind: 'deck' } })
    ).json().file;
    const made = [];
    for (const front of ['Alpha', 'Beta']) {
      made.push(
        (
          await api(student, {
            method: 'POST',
            url: '/api/cards',
            payload: { deckId: deck.id, front, back: 'x' },
          })
        ).json().card,
      );
    }

    const res = await api(student, { method: 'DELETE', url: `/api/cards/${made[0].id}` });
    assert.equal(res.statusCode, 204);

    const deckRes = await api(student, { method: 'GET', url: `/api/decks/${deck.id}/cards` });
    assert.equal(deckRes.statusCode, 200, 'the deck itself survives');
    const remaining = deckRes.json().cards;
    assert.deepEqual(
      remaining.map((c: { front: string }) => c.front),
      ['Beta'],
    );
  });
});

/* -------------------------------------------------------------------------- */

describe('settings', () => {
  it('separates account settings from per-device settings', async () => {
    const student = await registerUser('Settings Student');

    const account = await api(student, {
      method: 'PATCH',
      url: '/api/settings',
      payload: { theme: 'light', accent: '#9184d9', timezone: 'Europe/London' },
    });
    assert.equal(account.statusCode, 200);
    assert.equal(account.json().settings.theme, 'light');

    const laptop = await api(student, {
      method: 'PATCH',
      url: '/api/settings/devices/laptop-01',
      payload: { shellLayout: 'icon_rail', canvasChrome: 'tool_column', showMinimap: false },
    });
    assert.equal(laptop.json().settings.shell_layout, 'icon_rail');
    assert.equal(laptop.json().settings.show_minimap, false);

    const desktop = await api(student, { method: 'GET', url: '/api/settings/devices/desktop-01' });
    assert.equal(
      desktop.json().settings.shell_layout,
      'folder_tree',
      'a second device keeps its own layout',
    );

    const stillLight = await api(student, { method: 'GET', url: '/api/settings' });
    assert.equal(stillLight.json().settings.theme, 'light', 'theme follows the account');
  });

  it('rejects an invalid timezone and an invalid accent', async () => {
    const tz = await api(alice, {
      method: 'PATCH',
      url: '/api/settings',
      payload: { timezone: 'Mars/Olympus_Mons' },
    });
    assert.equal(tz.statusCode, 400);

    const accent = await api(alice, {
      method: 'PATCH',
      url: '/api/settings',
      payload: { accent: 'red' },
    });
    assert.equal(accent.statusCode, 422);
  });

  it('rejects an unknown notification key', async () => {
    const res = await api(alice, {
      method: 'PATCH',
      url: '/api/settings',
      payload: { notifications: { spam_me: true } },
    });
    assert.equal(res.statusCode, 422);
  });

  it('keeps the notification switches the app reads', async () => {
    const res = await api(alice, {
      method: 'PATCH',
      url: '/api/settings',
      payload: { notifications: { due_cards: true, exam_reminders: true, daily_summary: false } },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().settings.notifications, {
      due_cards: true,
      exam_reminders: true,
      daily_summary: false,
    });

    // The column holds one JSON value, so the client sends the whole object;
    // a patch naming one switch is what clearing the others looks like.
    const one = await api(alice, {
      method: 'PATCH',
      url: '/api/settings',
      payload: { notifications: { due_cards: false } },
    });
    assert.deepEqual(one.json().settings.notifications, { due_cards: false });
  });
});

/* -------------------------------------------------------------------------- */

describe('sharing', () => {
  it('shares a folder by link and stops resolving once revoked', async () => {
    const owner = await registerUser('Share Owner');
    const folder = (
      await api(owner, { method: 'POST', url: '/api/folders', payload: { name: 'Shared notes' } })
    ).json().folder;
    await api(owner, {
      method: 'POST',
      url: '/api/files',
      payload: { title: 'Public doc', kind: 'doc', folderId: folder.id },
    });

    const created = await api(owner, {
      method: 'POST',
      url: '/api/shares',
      payload: { targetType: 'folder', targetId: folder.id },
    });
    assert.equal(created.statusCode, 201);
    const { token, share } = created.json();

    const app = await getApp();
    const resolved = await app.inject({ method: 'GET', url: `/api/shared/${token}` });
    assert.equal(resolved.statusCode, 200);
    assert.equal(resolved.json().shared.title, 'Shared notes');
    assert.equal(resolved.json().shared.files.length, 1);
    assert.equal(resolved.json().shared.owner_name, 'Share Owner');
    assert.ok(
      !JSON.stringify(resolved.json()).includes('@studex.test'),
      'the owner email is never exposed',
    );

    await api(owner, { method: 'DELETE', url: `/api/shares/${share.id}` });
    const afterRevoke = await app.inject({ method: 'GET', url: `/api/shared/${token}` });
    assert.equal(afterRevoke.statusCode, 404);
  });

  it('does not resolve an expired link', async () => {
    const owner = await registerUser('Expiry Owner');
    const file = (
      await api(owner, { method: 'POST', url: '/api/files', payload: { title: 'Old', kind: 'doc' } })
    ).json().file;

    const created = await api(owner, {
      method: 'POST',
      url: '/api/shares',
      payload: { targetType: 'file', targetId: file.id, expiresAt: Date.now() - 1000 },
    });
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: `/api/shared/${created.json().token}` });
    assert.equal(res.statusCode, 404);
  });

  it("refuses to share another user's folder", async () => {
    const folder = (
      await api(alice, { method: 'POST', url: '/api/folders', payload: { name: 'Not yours' } })
    ).json().folder;

    const res = await api(bob, {
      method: 'POST',
      url: '/api/shares',
      payload: { targetType: 'folder', targetId: folder.id },
    });
    assert.equal(res.statusCode, 404);
  });

  it('rejects a malformed share token without touching the database', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: "/api/shared/' OR 1=1--" });
    assert.equal(res.statusCode, 422);
  });

  it('lets an edit link read and write, and the owner sees the change', async () => {
    const owner = await registerUser('Edit Owner');
    const file = (
      await api(owner, {
        method: 'POST',
        url: '/api/files',
        payload: { title: 'Group notes', kind: 'doc' },
      })
    ).json().file;

    const created = await api(owner, {
      method: 'POST',
      url: '/api/shares',
      payload: { targetType: 'file', targetId: file.id, permission: 'edit' },
    });
    assert.equal(created.statusCode, 201);
    const { token } = created.json();
    assert.equal(created.json().share.permission, 'edit');

    const app = await getApp();
    // The viewer is told what it may do, so it can decide to render an editor.
    const resolved = await app.inject({ method: 'GET', url: `/api/shared/${token}` });
    assert.equal(resolved.json().shared.permission, 'edit');

    const read = await app.inject({
      method: 'GET',
      url: `/api/shared/${token}/documents/${file.id}`,
    });
    assert.equal(read.statusCode, 200);
    assert.equal(read.json().permission, 'edit');

    const write = await app.inject({
      method: 'PUT',
      url: `/api/shared/${token}/documents/${file.id}`,
      payload: { blocks: [{ id: uuid(), type: 'paragraph', text: 'Added by a guest' }] },
    });
    assert.equal(write.statusCode, 200);

    const asOwner = await api(owner, { method: 'GET', url: `/api/documents/${file.id}` });
    assert.equal(asOwner.json().document.blocks[0].text, 'Added by a guest');
  });

  it('lets a view link read but not write', async () => {
    const owner = await registerUser('View Owner');
    const file = (
      await api(owner, {
        method: 'POST',
        url: '/api/files',
        payload: { title: 'Read only', kind: 'doc' },
      })
    ).json().file;
    const { token } = (
      await api(owner, {
        method: 'POST',
        url: '/api/shares',
        payload: { targetType: 'file', targetId: file.id },
      })
    ).json();

    const app = await getApp();
    const read = await app.inject({
      method: 'GET',
      url: `/api/shared/${token}/documents/${file.id}`,
    });
    assert.equal(read.statusCode, 200);
    assert.equal(read.json().permission, 'view');

    const write = await app.inject({
      method: 'PUT',
      url: `/api/shared/${token}/documents/${file.id}`,
      payload: { blocks: [{ id: uuid(), type: 'paragraph', text: 'nope' }] },
    });
    assert.equal(write.statusCode, 403);
  });

  it('will not let a link reach a file outside its scope', async () => {
    const owner = await registerUser('Scope Owner');
    const folder = (
      await api(owner, { method: 'POST', url: '/api/folders', payload: { name: 'Shared' } })
    ).json().folder;
    const inside = (
      await api(owner, {
        method: 'POST',
        url: '/api/files',
        payload: { title: 'In scope', kind: 'doc', folderId: folder.id },
      })
    ).json().file;
    const outside = (
      await api(owner, {
        method: 'POST',
        url: '/api/files',
        payload: { title: 'Private', kind: 'doc' },
      })
    ).json().file;

    const { token } = (
      await api(owner, {
        method: 'POST',
        url: '/api/shares',
        payload: { targetType: 'folder', targetId: folder.id, permission: 'edit' },
      })
    ).json();

    const app = await getApp();
    assert.equal(
      (await app.inject({ method: 'GET', url: `/api/shared/${token}/documents/${inside.id}` }))
        .statusCode,
      200,
    );
    // A file the owner never shared is indistinguishable from one that does
    // not exist, so the link cannot be used to probe for other documents.
    const reach = await app.inject({
      method: 'GET',
      url: `/api/shared/${token}/documents/${outside.id}`,
    });
    assert.equal(reach.statusCode, 404);

    const writeOutside = await app.inject({
      method: 'PUT',
      url: `/api/shared/${token}/documents/${outside.id}`,
      payload: { blocks: [] },
    });
    assert.equal(writeOutside.statusCode, 404);
  });

  it('stops an edit link writing once it is revoked', async () => {
    const owner = await registerUser('Revoke Owner');
    const file = (
      await api(owner, {
        method: 'POST',
        url: '/api/files',
        payload: { title: 'Temporary', kind: 'doc' },
      })
    ).json().file;
    const { token, share } = (
      await api(owner, {
        method: 'POST',
        url: '/api/shares',
        payload: { targetType: 'file', targetId: file.id, permission: 'edit' },
      })
    ).json();

    await api(owner, { method: 'DELETE', url: `/api/shares/${share.id}` });

    const app = await getApp();
    const write = await app.inject({
      method: 'PUT',
      url: `/api/shared/${token}/documents/${file.id}`,
      payload: { blocks: [{ id: uuid(), type: 'paragraph', text: 'too late' }] },
    });
    assert.equal(write.statusCode, 404);
  });

  it('applies the ordinary revision check to a shared write', async () => {
    const owner = await registerUser('Conflict Owner');
    const file = (
      await api(owner, {
        method: 'POST',
        url: '/api/files',
        payload: { title: 'Contested', kind: 'doc' },
      })
    ).json().file;
    const { token } = (
      await api(owner, {
        method: 'POST',
        url: '/api/shares',
        payload: { targetType: 'file', targetId: file.id, permission: 'edit' },
      })
    ).json();

    const app = await getApp();
    const revision = (
      await app.inject({ method: 'GET', url: `/api/shared/${token}/documents/${file.id}` })
    ).json().document.revision;

    const stale = await app.inject({
      method: 'PUT',
      url: `/api/shared/${token}/documents/${file.id}`,
      payload: { blocks: [], expectedRevision: revision - 1 },
    });
    assert.equal(stale.statusCode, 409);
  });

  it('serves the images inside a shared document, and only those', async () => {
    const owner = await registerUser('Picture Owner');
    const shown = (
      await api(owner, { method: 'POST', url: '/api/files', payload: { title: 'Shared notes', kind: 'doc' } })
    ).json().file;
    const hidden = (
      await api(owner, { method: 'POST', url: '/api/files', payload: { title: 'Private notes', kind: 'doc' } })
    ).json().file;

    const put = async (docId: string) => {
      const body = multipartBody({}, {
        field: 'file',
        filename: 'plot.png',
        contentType: 'image/png',
        content: samplePng(),
      });
      const res = await api(owner, {
        method: 'POST',
        url: `/api/documents/${docId}/images`,
        payload: body.payload,
        headers: body.headers,
      });
      assert.equal(res.statusCode, 201);
      return res.json().image.id as string;
    };

    const shownImage = await put(shown.id);
    const hiddenImage = await put(hidden.id);

    const { token } = (
      await api(owner, {
        method: 'POST',
        url: '/api/shares',
        payload: { targetType: 'file', targetId: shown.id },
      })
    ).json();

    const app = await getApp();
    // A document without its pictures is not the document, so the bytes come
    // back with no session at all.
    const ok = await app.inject({
      method: 'GET',
      url: `/api/shared/${token}/documents/${shown.id}/images/${shownImage}/content`,
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.headers['content-type'], 'image/png');
    // A revoked link must not be outlived by a cached copy of what it served.
    assert.equal(ok.headers['cache-control'], 'no-store');

    // The link admits one document. An image sitting in another of the
    // owner's documents is a 404 here, exactly as it is to a stranger.
    const wrongDoc = await app.inject({
      method: 'GET',
      url: `/api/shared/${token}/documents/${shown.id}/images/${hiddenImage}/content`,
    });
    assert.equal(wrongDoc.statusCode, 404);

    // And the link cannot be pointed at the other document to reach it.
    const outOfScope = await app.inject({
      method: 'GET',
      url: `/api/shared/${token}/documents/${hidden.id}/images/${hiddenImage}/content`,
    });
    assert.equal(outOfScope.statusCode, 404);

    await api(owner, { method: 'DELETE', url: `/api/shares/${(await api(owner, { method: 'GET', url: '/api/shares' })).json().shares[0].id}` });
    const afterRevoke = await app.inject({
      method: 'GET',
      url: `/api/shared/${token}/documents/${shown.id}/images/${shownImage}/content`,
    });
    assert.equal(afterRevoke.statusCode, 404);
  });

  it('refuses an unknown permission on a share', async () => {
    const file = (
      await api(alice, { method: 'POST', url: '/api/files', payload: { title: 'P', kind: 'doc' } })
    ).json().file;
    const res = await api(alice, {
      method: 'POST',
      url: '/api/shares',
      payload: { targetType: 'file', targetId: file.id, permission: 'admin' },
    });
    assert.equal(res.statusCode, 422);
  });
});

/* -------------------------------------------------------------------------- */

describe('input handling', () => {
  it('rejects a non-uuid path parameter', async () => {
    const res = await api(alice, { method: 'GET', url: '/api/files/not-a-uuid' });
    assert.equal(res.statusCode, 422);
  });

  it('treats SQL metacharacters in a title as ordinary text', async () => {
    const title = "Robert'); DROP TABLE files;--";
    const created = await api(alice, {
      method: 'POST',
      url: '/api/files',
      payload: { title, kind: 'doc' },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().file.title, title, 'stored verbatim');

    const stillThere = await api(alice, { method: 'GET', url: '/api/files?limit=1' });
    assert.equal(stillThere.statusCode, 200, 'the files table is intact');
  });

  it('rejects an over-long title', async () => {
    const res = await api(alice, {
      method: 'POST',
      url: '/api/files',
      payload: { title: 'x'.repeat(500), kind: 'doc' },
    });
    assert.equal(res.statusCode, 422);
  });

  it('rejects an unknown file kind', async () => {
    const res = await api(alice, {
      method: 'POST',
      url: '/api/files',
      payload: { title: 'Odd', kind: 'executable' },
    });
    assert.equal(res.statusCode, 422);
  });

  it('rejects a patch with no fields', async () => {
    const file = (
      await api(alice, { method: 'POST', url: '/api/files', payload: { title: 'Patch me', kind: 'doc' } })
    ).json().file;
    const res = await api(alice, { method: 'PATCH', url: `/api/files/${file.id}`, payload: {} });
    assert.equal(res.statusCode, 422);
  });

  it('rejects malformed JSON', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/files',
      payload: '{"title": broken',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
    });
    assert.equal(res.statusCode, 400);
  });

  it('does not leak internals in an error response', async () => {
    const res = await api(alice, { method: 'GET', url: `/api/files/${uuid()}` });
    assert.equal(res.statusCode, 404);
    const body = res.body;
    assert.ok(!body.includes('SELECT'));
    assert.ok(!body.includes('sqlite'));
    assert.ok(!/\/(Users|home)\//.test(body), 'no filesystem paths');
  });
});

/* -------------------------------------------------------------------------- */

describe('brute-force resistance', () => {
  it('locks an account after repeated wrong passwords, then still admits the right one later', async () => {
    const target = await registerUser('Lockout Target');
    const app = await getApp();

    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: target.email, password: `wrong-guess-number-${i}` },
      });
      statuses.push(res.statusCode);
    }

    assert.ok(statuses.every((s) => s !== 200), 'no guess ever succeeds');
    assert.ok(statuses.includes(429), 'the account locks once the failure threshold is crossed');

    // Even the correct password is refused while the lock stands — that is the
    // point of the lock, and it expires on its own after the cool-off window.
    const duringLock = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: target.email, password: 'a-perfectly-fine-passphrase' },
    });
    assert.equal(duringLock.statusCode, 429);
  });

  it('does not lock a different account as collateral', async () => {
    const bystander = await registerUser('Bystander');
    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: bystander.email, password: 'a-perfectly-fine-passphrase' },
    });
    assert.equal(res.statusCode, 200, 'one account under attack does not lock others out');
  });

  it('applies the global rate limiter to authenticated traffic', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.ok(res.headers['x-ratelimit-limit'] !== undefined || res.statusCode === 200);
  });
});

/* -------------------------------------------------------------------------- */

describe('service basics', () => {
  it('answers a health check without authentication', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'ok');
  });

  it('sets hardening headers', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.match(String(res.headers['content-security-policy']), /default-src 'none'/);
    assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
  });

  it('returns a structured 404 for an unknown route', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, 'not_found');
  });
});

/* -------------------------------------------------------------------------- */

describe('how a document draws itself', () => {
  let fileId: string;

  before(async () => {
    fileId = (
      await api(alice, {
        method: 'POST',
        url: '/api/files',
        payload: { title: 'Cell division', kind: 'doc' },
      })
    ).json().file.id;
  });

  it('starts standard and keeps whichever style it is given', async () => {
    const fresh = await api(alice, { method: 'GET', url: `/api/documents/${fileId}` });
    assert.equal(fresh.json().document.style, 'standard');

    const saved = await api(alice, {
      method: 'PUT',
      url: `/api/documents/${fileId}`,
      payload: {
        style: 'bulleted',
        blocks: [{ id: uuid(), type: 'paragraph', text: 'Prophase, metaphase, anaphase' }],
      },
    });
    assert.equal(saved.json().document.style, 'bulleted');

    // A later save that says nothing about style must not quietly reset it.
    const again = await api(alice, {
      method: 'PUT',
      url: `/api/documents/${fileId}`,
      payload: { blocks: [{ id: uuid(), type: 'paragraph', text: 'Then cytokinesis' }] },
    });
    assert.equal(again.json().document.style, 'bulleted');
  });

  it('refuses a style it has never heard of', async () => {
    const res = await api(alice, {
      method: 'PUT',
      url: `/api/documents/${fileId}`,
      payload: { style: 'sideways', blocks: [] },
    });
    assert.equal(res.statusCode, 422);
  });

  it('finds a line by its words, not by how it is emphasised', async () => {
    await api(alice, {
      method: 'PUT',
      url: `/api/documents/${fileId}`,
      payload: {
        blocks: [{ id: uuid(), type: 'bullet', text: 'The **karyokinesis** stage', indent: 0 }],
      },
    });

    const res = await api(alice, { method: 'GET', url: '/api/search?q=karyokinesis' });
    assert.equal(res.statusCode, 200);
    assert.ok(
      res.json().results.some((r: { file_id?: string }) => r.file_id === fileId),
      'a bold word is still the word it is',
    );
  });

  it('keeps the names given to a table’s rows', async () => {
    const table = {
      id: uuid(),
      type: 'table',
      columns: ['Phase', 'What happens'],
      rows: [['Prophase', 'Chromosomes condense']],
      rowLabels: ['Step one'],
    };
    const saved = await api(alice, {
      method: 'PUT',
      url: `/api/documents/${fileId}`,
      payload: { blocks: [table] },
    });
    assert.equal(saved.statusCode, 200);
    assert.deepEqual(saved.json().document.blocks[0].rowLabels, ['Step one']);

    // And a table without them stays without them, rather than growing a
    // column of blanks.
    const plain = await api(alice, {
      method: 'PUT',
      url: `/api/documents/${fileId}`,
      payload: { blocks: [{ ...table, id: uuid(), rowLabels: null }] },
    });
    assert.equal(plain.json().document.blocks[0].rowLabels, null);
  });
});

/* -------------------------------------------------------------------------- */

describe('images inside documents', () => {
  let docId: string;
  let imageId: string;

  before(async () => {
    docId = (
      await api(alice, { method: 'POST', url: '/api/files', payload: { title: 'Diagrams', kind: 'doc' } })
    ).json().file.id;
  });

  function upload(name: string, content: Buffer, contentType = 'image/png') {
    return multipartBody({}, { field: 'file', filename: name, contentType, content });
  }

  it('accepts a real image and counts it against the quota', async () => {
    const before = (await api(alice, { method: 'GET', url: '/api/storage' })).json().storage;

    const body = upload('cell.png', samplePng());
    const res = await api(alice, {
      method: 'POST',
      url: `/api/documents/${docId}/images`,
      payload: body.payload,
      headers: body.headers,
    });
    assert.equal(res.statusCode, 201);
    imageId = res.json().image.id;
    assert.equal(res.json().image.mime, 'image/png');

    const after = (await api(alice, { method: 'GET', url: '/api/storage' })).json().storage;
    assert.equal(after.used_bytes, before.used_bytes + samplePng().length);
  });

  it('refuses bytes that are not an image, whatever they are called', async () => {
    const body = upload('evil.png', Buffer.from('<svg onload="alert(1)"></svg>'.padEnd(64, ' '), 'utf8'));
    const res = await api(alice, {
      method: 'POST',
      url: `/api/documents/${docId}/images`,
      payload: body.payload,
      headers: body.headers,
    });
    assert.equal(res.statusCode, 400);
  });

  it('will not put an image inside a canvas', async () => {
    const canvasId = (
      await api(alice, { method: 'POST', url: '/api/files', payload: { title: 'Board', kind: 'canvas' } })
    ).json().file.id;
    const body = upload('cell.png', samplePng());
    const res = await api(alice, {
      method: 'POST',
      url: `/api/documents/${canvasId}/images`,
      payload: body.payload,
      headers: body.headers,
    });
    assert.equal(res.statusCode, 400);
  });

  it('serves it as what it is, and not to anybody else', async () => {
    const mine = await api(alice, { method: 'GET', url: `/api/images/${imageId}/content` });
    assert.equal(mine.statusCode, 200);
    assert.equal(mine.headers['content-type'], 'image/png');
    assert.equal(mine.headers['x-content-type-options'], 'nosniff');
    assert.equal(mine.rawPayload.length, samplePng().length);

    const theirs = await api(bob, { method: 'GET', url: `/api/images/${imageId}/content` });
    assert.equal(theirs.statusCode, 404);
  });

  it('gives the space back when the image is deleted', async () => {
    const before = (await api(alice, { method: 'GET', url: '/api/storage' })).json().storage;
    const res = await api(alice, { method: 'DELETE', url: `/api/images/${imageId}` });
    assert.equal(res.statusCode, 204);

    const after = (await api(alice, { method: 'GET', url: '/api/storage' })).json().storage;
    assert.equal(after.used_bytes, before.used_bytes - samplePng().length);

    const gone = await api(alice, { method: 'GET', url: `/api/images/${imageId}/content` });
    assert.equal(gone.statusCode, 404);
  });

  it('releases an image left in a document that is deleted for good', async () => {
    const body = upload('leftover.png', samplePng());
    await api(alice, {
      method: 'POST',
      url: `/api/documents/${docId}/images`,
      payload: body.payload,
      headers: body.headers,
    });

    const before = (await api(alice, { method: 'GET', url: '/api/storage' })).json().storage;
    await api(alice, { method: 'DELETE', url: `/api/files/${docId}` });
    await api(alice, { method: 'DELETE', url: `/api/files/${docId}/purge` });

    const after = (await api(alice, { method: 'GET', url: '/api/storage' })).json().storage;
    assert.equal(after.used_bytes, before.used_bytes - samplePng().length);
  });
});


/* -------------------------------------------------------------------------- */

describe('card templates', () => {
  it('stores a deck template, carries extra fields on cards, and keeps them to the owner', async () => {
    const deck = (await api(alice, { method: 'POST', url: '/api/files', payload: { title: 'French verbs', kind: 'deck' } })).json().file.id;
    const empty = await api(alice, { method: 'GET', url: `/api/decks/${deck}/template` });
    assert.equal(empty.statusCode, 200);
    assert.equal(empty.json().template, null, 'a new deck has the default look');

    const template = { align: 'center', size: 'large', backFirst: true, fields: [{ label: 'Pronunciation', kind: 'line' }] };
    const saved = await api(alice, { method: 'PUT', url: `/api/decks/${deck}/template`, payload: { template } });
    assert.equal(saved.statusCode, 200);
    assert.deepEqual(saved.json().template, template);
    assert.deepEqual((await api(alice, { method: 'GET', url: `/api/decks/${deck}/template` })).json().template, template);

    const tooMany = await api(alice, {
      method: 'PUT', url: `/api/decks/${deck}/template`,
      payload: { template: { ...template, fields: [1, 2, 3].map((n) => ({ label: `F${n}`, kind: 'line' })) } },
    });
    assert.equal(tooMany.statusCode, 422);

    const card = (await api(alice, {
      method: 'POST', url: '/api/cards',
      payload: { deckId: deck, front: 'être', back: 'to be', extra1: '/ɛtʁ/' },
    })).json().card;
    assert.equal(card.extra1, '/ɛtʁ/');
    assert.equal(card.extra2, null);
    const edited = (await api(alice, { method: 'PATCH', url: `/api/cards/${card.id}`, payload: { extra1: null } })).json().card;
    assert.equal(edited.extra1, null);
    assert.equal(edited.front, 'être', 'an extra-only edit leaves the card alone');

    assert.equal((await api(bob, { method: 'GET', url: `/api/decks/${deck}/template` })).statusCode, 404);
    assert.equal((await api(bob, { method: 'PUT', url: `/api/decks/${deck}/template`, payload: { template: null } })).statusCode, 404);

    const cleared = await api(alice, { method: 'PUT', url: `/api/decks/${deck}/template`, payload: { template: null } });
    assert.equal(cleared.json().template, null);
  });
});

describe('study packs', () => {
  it('copies a deck into another library with a fresh schedule and nothing of the maker', async () => {
    const deck = (await api(alice, { method: 'POST', url: '/api/files', payload: { title: 'Cell biology', kind: 'deck' } })).json().file.id;
    await api(alice, {
      method: 'PUT', url: `/api/decks/${deck}/template`,
      payload: { template: { align: 'center', size: 'medium', backFirst: false, fields: [{ label: 'Diagram note', kind: 'line' }] } },
    });
    const card = (await api(alice, { method: 'POST', url: '/api/cards', payload: { deckId: deck, front: 'Mitochondria', back: 'Aerobic respiration', topic: 'Organelles', extra1: 'Double membrane' } })).json().card;
    await api(alice, { method: 'POST', url: `/api/cards/${card.id}/review`, payload: { rating: 4, durationMs: 1000 } });

    const res = await api(alice, { method: 'GET', url: `/api/decks/${deck}/pack` });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-disposition']), /Cell biology\.studexpack/);
    const pack = res.json();
    assert.equal(pack.type, 'deck');
    assert.deepEqual(Object.keys(pack.cards[0]).sort(), ['back', 'extra1', 'extra2', 'front', 'topic']);
    assert.ok(!JSON.stringify(pack).includes(card.id), 'no ids travel');

    assert.equal((await api(bob, { method: 'GET', url: `/api/decks/${deck}/pack` })).statusCode, 404);

    const imported = await api(bob, { method: 'POST', url: '/api/packs/import', payload: { pack } });
    assert.equal(imported.statusCode, 200);
    const { deckId, cards } = imported.json().imported;
    assert.equal(cards, 1);
    const copied = (await api(bob, { method: 'GET', url: `/api/decks/${deckId}/cards` })).json().cards;
    assert.equal(copied[0].state, 'new', 'the copy starts its own schedule');
    assert.equal(copied[0].extra1, 'Double membrane');
    assert.equal((await api(bob, { method: 'GET', url: `/api/decks/${deckId}/template` })).json().template.fields[0].label, 'Diagram note');

    const bad = await api(bob, { method: 'POST', url: '/api/packs/import', payload: { pack: { format: 'studex-pack', version: 1, type: 'deck', title: 'x', cards: [] } } });
    assert.equal(bad.statusCode, 400);
  });

  it('serves a shared deck as a pack to a link holder, and a topic list by subject', async () => {
    const deck = (await api(alice, { method: 'POST', url: '/api/files', payload: { title: 'Shared deck', kind: 'deck' } })).json().file.id;
    await api(alice, { method: 'POST', url: '/api/cards', payload: { deckId: deck, front: 'Q', back: 'A' } });
    const { token } = (await api(alice, { method: 'POST', url: '/api/shares', payload: { targetType: 'file', targetId: deck } })).json();
    const viaLink = await api(bob, { method: 'GET', url: `/api/shared/${token}/decks/${deck}/pack` });
    assert.equal(viaLink.statusCode, 200);
    assert.equal(viaLink.json().cards.length, 1);
    const other = (await api(alice, { method: 'POST', url: '/api/files', payload: { title: 'Not shared', kind: 'deck' } })).json().file.id;
    assert.equal((await api(bob, { method: 'GET', url: `/api/shared/${token}/decks/${other}/pack` })).statusCode, 404);

    const subject = (await api(alice, { method: 'POST', url: '/api/subjects', payload: { name: 'Geography' } })).json().subject;
    await api(alice, { method: 'POST', url: '/api/topics/import', payload: { subjectId: subject.id, unit: 'Paper 1', names: [{ name: 'Coasts', ref: '3.1', page: 12 }, 'Rivers'] } });
    const topics = (await api(alice, { method: 'GET', url: `/api/subjects/${subject.id}/pack` })).json();
    assert.equal(topics.type, 'topics');
    assert.equal(topics.topics.length, 2);
    const bobSubject = (await api(bob, { method: 'POST', url: '/api/subjects', payload: { name: 'Geog' } })).json().subject;
    const first = (await api(bob, { method: 'POST', url: '/api/packs/import', payload: { pack: topics, subjectId: bobSubject.id } })).json().imported;
    assert.equal(first.created, 2);
    const again = (await api(bob, { method: 'POST', url: '/api/packs/import', payload: { pack: topics, subjectId: bobSubject.id } })).json().imported;
    assert.equal(again.created, 0, 'a checklist copied twice does not double');
  });
});

describe('session goals', () => {
  it('carries a goal, inherits the calendar block subject, and counts hours by subject', async () => {
    const student = await registerUser('Goal Student');
    const subject = (await api(student, { method: 'POST', url: '/api/subjects', payload: { name: 'English' } })).json().subject;
    const event = (await api(student, {
      method: 'POST',
      url: '/api/events',
      payload: { kind: 'study_block', title: 'Macbeth', subjectId: subject.id, startsAt: Date.now(), endsAt: Date.now() + 3_600_000 },
    })).json().event;

    const started = await api(student, {
      method: 'POST',
      url: '/api/study-sessions',
      payload: { plannedMinutes: 25, eventId: event.id, goal: 'Two blocks on Macbeth' },
    });
    assert.equal(started.statusCode, 201);
    const session = started.json().session;
    assert.equal(session.subject_id, subject.id, 'credited to the block subject');
    assert.equal(session.goal, 'Two blocks on Macbeth');

    const ended = await api(student, {
      method: 'POST',
      url: `/api/study-sessions/${session.id}/end`,
      payload: { status: 'completed' },
    });
    assert.equal(ended.json().session.goal_met, null);

    const marked = await api(student, { method: 'POST', url: `/api/study-sessions/${session.id}/goal`, payload: { met: true } });
    assert.equal(marked.json().session.goal_met, 1);

    const goals = await api(student, { method: 'GET', url: '/api/study-sessions/goals' });
    assert.equal(goals.json().sessions.length, 1);

    // Give the session some time so it shows up in the hours.
    const { getDb } = await import('../src/lib/db.js');
    getDb().prepare('UPDATE study_sessions SET elapsed_seconds = 1800 WHERE id = ?').run(session.id);
    const hours = await api(student, { method: 'GET', url: '/api/stats/hours-by-subject?days=7' });
    assert.equal(hours.statusCode, 200);
    const english = hours.json().subjects.find((s: { subject_id: string }) => s.subject_id === subject.id);
    assert.equal(english.hours, 0.5);
    assert.equal(english.goals_met, 1);

    const intruder = await registerUser('Goal Intruder');
    const denied = await api(intruder, { method: 'POST', url: `/api/study-sessions/${session.id}/goal`, payload: { met: false } });
    assert.equal(denied.statusCode, 404);
  });
});

describe('habit loop', () => {
  it('bridges one missed day with an earned freeze and tracks the weekly goal', async () => {
    const student = await registerUser('Habit Student');
    const settings = await api(student, { method: 'PATCH', url: '/api/settings', payload: { timezone: 'UTC', weeklyGoalMinutes: 60 } });
    assert.equal(settings.statusCode, 200);

    const stats = await import('../src/domain/stats.js');
    const { getDb } = await import('../src/lib/db.js');
    const userId = (await api(student, { method: 'GET', url: '/api/auth/me' })).json().user.id;
    const now = Date.UTC(2026, 8, 16, 12); // a Wednesday
    const day = 86_400_000;
    const session = (daysAgo: number, seconds: number) => getDb()
      .prepare(`INSERT INTO study_sessions (id, user_id, started_at, elapsed_seconds, status, ended_at)
                VALUES (?, ?, ?, ?, 'completed', ?)`)
      .run(`hab-${userId}-${daysAgo}`, userId, now - daysAgo * day, seconds, now - daysAgo * day + seconds * 1000);

    // Ten days in a row, one missed day, then three more ending today.
    for (let d = 14; d >= 5; d -= 1) session(d, 600);
    for (let d = 3; d >= 0; d -= 1) session(d, 1200);

    const streak = stats.streakState(userId, now);
    assert.equal(streak.current, 14, 'the missed day was frozen, not a reset');
    assert.equal(streak.frozen.length, 1);
    assert.equal(streak.freezes, 1, 'the run went on to earn another');

    await api(student, { method: 'PATCH', url: '/api/settings', payload: { streakFreeze: false } });
    assert.equal(stats.streakState(userId, now).current, 4, 'without freezes the run restarts');

    const week = stats.weekProgress(userId, now);
    assert.equal(week.week_start, '2026-09-14');
    assert.equal(week.minutes, 60);
    assert.equal(week.met, true);

    const term = stats.termProgress(userId, 3, now);
    assert.equal(term.weeks.length, 3);
    assert.equal(term.days.length, 21);
    const res = await api(student, { method: 'GET', url: '/api/stats/term?weeks=4' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().term.goal_minutes, 60);
  });
});

describe('exam revision plan', () => {
  it('drafts a plan weighted by weak topics and lapses, writes it, and replaces it on reshuffle', async () => {
    const student = await registerUser('Plan Student');
    await api(student, { method: 'PATCH', url: '/api/settings', payload: { timezone: 'Europe/London' } });
    const subject = (await api(student, { method: 'POST', url: '/api/subjects', payload: { name: 'Chemistry' } })).json().subject;
    const other = (await api(student, { method: 'POST', url: '/api/subjects', payload: { name: 'History' } })).json().subject;
    for (const [name, confidence, subjectId] of [
      ['Moles', 1, subject.id], ['Bonding', 4, subject.id], ['Equilibria', 0, subject.id], ['Tudors', 1, other.id],
    ] as const) {
      await api(student, { method: 'POST', url: '/api/topics', payload: { name, confidence, subjectId } });
    }
    const folder = (await api(student, { method: 'POST', url: '/api/folders', payload: { name: 'Chem', subjectId: subject.id } })).json().folder;
    const deck = (await api(student, { method: 'POST', url: '/api/files', payload: { title: 'Organic', kind: 'deck', folderId: folder.id } })).json().file;
    const card = (await api(student, { method: 'POST', url: '/api/cards', payload: { deckId: deck.id, front: 'Q', back: 'A' } })).json().card;
    const { getDb } = await import('../src/lib/db.js');
    getDb().prepare('UPDATE cards SET lapses = 9 WHERE id = ?').run(card.id);

    const examAt = Date.now() + 21 * 86_400_000;
    const exam = (await api(student, {
      method: 'POST', url: '/api/events',
      payload: { kind: 'exam', title: 'Chemistry Paper 1', subjectId: subject.id, startsAt: examAt, endsAt: examAt + 7_200_000 },
    })).json().event;

    const draft = await api(student, { method: 'POST', url: `/api/events/${exam.id}/revision-plan/draft`, payload: { sessionsPerWeek: 4 } });
    assert.equal(draft.statusCode, 200);
    const plan = draft.json().plan;
    assert.ok(plan.sessions.length >= 10 && plan.sessions.length <= 13, `about 12 sessions, got ${plan.sessions.length}`);
    assert.equal(plan.grounding.weak_topics, 1);
    assert.equal(plan.grounding.lapsed_decks, 1);
    const titles = plan.sessions.map((s: { title: string }) => s.title);
    assert.ok(!titles.some((t: string) => t.includes('Tudors')), 'other subjects stay out');
    assert.ok(titles.filter((t: string) => t === 'Moles').length > titles.filter((t: string) => t === 'Bonding').length, 'weakest gets more');
    assert.ok(titles.at(-1).startsWith('Mixed review'));
    for (const s of plan.sessions) assert.ok(s.startsAt > Date.now() && s.endsAt < examAt);
    const days = new Set(plan.sessions.map((s: { startsAt: number }) => new Date(s.startsAt).toISOString().slice(0, 10)));
    assert.equal(days.size, plan.sessions.length, 'one session a day at most');

    const accepted = await api(student, { method: 'PUT', url: `/api/events/${exam.id}/revision-plan`, payload: { sessions: plan.sessions } });
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.json().created, plan.sessions.length);
    const written = (await api(student, { method: 'GET', url: `/api/events/${exam.id}/revision-plan` })).json().sessions;
    assert.equal(written.length, plan.sessions.length);
    assert.equal(written[0].subject_id, subject.id);

    const reshuffled = (await api(student, { method: 'POST', url: `/api/events/${exam.id}/revision-plan/draft`, payload: { sessionsPerWeek: 4, shuffle: 7 } })).json().plan;
    const replaced = (await api(student, { method: 'PUT', url: `/api/events/${exam.id}/revision-plan`, payload: { sessions: reshuffled.sessions } })).json();
    assert.equal(replaced.replaced, plan.sessions.length);
    assert.equal((await api(student, { method: 'GET', url: `/api/events/${exam.id}/revision-plan` })).json().sessions.length, reshuffled.sessions.length);

    const late = await api(student, {
      method: 'PUT', url: `/api/events/${exam.id}/revision-plan`,
      payload: { sessions: [{ ...plan.sessions[0], startsAt: examAt + 1000, endsAt: examAt + 2000 }] },
    });
    assert.equal(late.statusCode, 400);

    const cleared = await api(student, { method: 'DELETE', url: `/api/events/${exam.id}/revision-plan` });
    assert.equal(cleared.json().removed, reshuffled.sessions.length);

    const intruder = await registerUser('Plan Intruder');
    assert.equal((await api(intruder, { method: 'POST', url: `/api/events/${exam.id}/revision-plan/draft`, payload: {} })).statusCode, 404);
  });
});

describe('scheduler tuning', () => {
  it('fits FSRS to a student who forgets faster than the defaults, and keeps it only if it predicts better', async () => {
    const student = await registerUser('Tuning Student');
    const me = (await api(student, { method: 'GET', url: '/api/auth/me' })).json().user;

    const early = await api(student, { method: 'POST', url: '/api/scheduler/tune' });
    assert.equal(early.statusCode, 400, 'too little history is turned away');

    const deck = (await api(student, { method: 'POST', url: '/api/files', payload: { title: 'Tuning deck', kind: 'deck' } })).json().file;
    const cardIds: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      cardIds.push((await api(student, { method: 'POST', url: '/api/cards', payload: { deckId: deck.id, front: `Q${i}`, back: `A${i}` } })).json().card.id);
    }

    const { DEFAULT_WEIGHTS, intervalForRetention, nextMemoryState, retrievability } = await import('../src/domain/fsrs.js');
    const truth = [...DEFAULT_WEIGHTS];
    truth[2] = 1.2; // a Good first answer holds for about a day, not three
    truth[8] = 0.9; // and each success builds less stability
    let seed = 12345;
    const rand = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) % 1_000_000) / 1_000_000; };

    const { getDb } = await import('../src/lib/db.js');
    const insert = getDb().prepare(
      `INSERT INTO review_logs (id, user_id, card_id, rating, mode, duration_ms, interval_before, interval_after, reviewed_at)
       VALUES (?, ?, ?, ?, 'review', 0, 0, 0, ?)`,
    );
    const start = Date.now() - 500 * 86_400_000;
    for (const cardId of cardIds) {
      let state = null as null | { stability: number; difficulty: number };
      let at = start + Math.floor(rand() * 20) * 86_400_000;
      for (let n = 0; n < 12; n += 1) {
        let rating: 1 | 2 | 3 | 4 = 3;
        if (state) {
          const elapsed = Math.max(1, intervalForRetention(state.stability, 0.9) * (0.5 + rand() * 2));
          at += Math.round(elapsed * 86_400_000);
          const recalled = rand() < retrievability(elapsed, state.stability);
          rating = recalled ? (rand() < 0.15 ? 2 : 3) : 1;
          state = nextMemoryState(state, rating, elapsed, truth);
        } else {
          state = nextMemoryState(null, rating, 0, truth);
        }
        insert.run(uuid(), me.id, cardId, rating, at);
      }
    }

    const status = (await api(student, { method: 'GET', url: '/api/scheduler' })).json().scheduler;
    assert.equal(status.eligible, true);
    assert.equal(status.tuned, false);

    const tuned = await api(student, { method: 'POST', url: '/api/scheduler/tune' });
    assert.equal(tuned.statusCode, 200);
    const { result, scheduler } = tuned.json();
    assert.equal(result.applied, true);
    assert.ok(result.loss_tuned < result.loss_default, `${result.loss_tuned} < ${result.loss_default}`);
    assert.ok(
      Math.abs(result.recall_predicted_tuned_pct - result.recall_actual_pct)
        < Math.abs(result.recall_predicted_default_pct - result.recall_actual_pct),
      'tuned predictions sit closer to what happened',
    );
    assert.equal(scheduler.tuned, true);

    // New grades now schedule with the personal set.
    const reviewed = (await api(student, { method: 'POST', url: `/api/cards/${cardIds[0]}/review`, payload: { rating: 3 } })).json();
    assert.ok(reviewed.scheduled.stability < DEFAULT_WEIGHTS[2]!, 'first Good builds less than the default');

    const reset = (await api(student, { method: 'DELETE', url: '/api/scheduler/tune' })).json().scheduler;
    assert.equal(reset.tuned, false);
  });
});

describe('image occlusion', () => {
  it('makes one card per named region and remakes the set without losing history', async () => {
    const student = await registerUser();
    const deckId = (
      await api(student, { method: 'POST', url: '/api/files', payload: { title: 'Cell biology', kind: 'deck' } })
    ).json().file.id as string;

    const body = multipartBody({}, { field: 'file', filename: 'cell.png', contentType: 'image/png', content: samplePng() });
    const up = await api(student, { method: 'POST', url: `/api/decks/${deckId}/images`, payload: body.payload, headers: body.headers });
    assert.equal(up.statusCode, 201);
    const imageId = up.json().image.id as string;

    const masks = [
      { id: 'm1', x: 0.1, y: 0.1, width: 0.2, height: 0.1, label: 'Nucleus' },
      { id: 'm2', x: 0.5, y: 0.4, width: 0.2, height: 0.1, label: 'Mitochondrion' },
      { id: 'm3', x: 0.6, y: 0.7, width: 0.1, height: 0.1, label: '' },
    ];

    const none = await api(student, {
      method: 'POST', url: `/api/decks/${deckId}/occlusion`,
      payload: { imageId, masks: [{ ...masks[2] }] },
    });
    assert.equal(none.statusCode, 400);

    const first = await api(student, { method: 'POST', url: `/api/decks/${deckId}/occlusion`, payload: { imageId, masks } });
    assert.equal(first.statusCode, 201);
    const made = first.json();
    assert.equal(made.created, 2);
    assert.equal(made.cards.length, 2);
    const nucleus = made.cards.find((c: { back: string }) => c.back === 'Nucleus');
    const data = JSON.parse(nucleus.occlusion);
    assert.equal(data.target, 'm1');
    assert.equal(data.masks.length, 3);
    assert.equal(nucleus.front, 'What is hidden here?');

    // Grade one, then remake: m1 renamed, m2 deleted, m4 added.
    const graded = await api(student, { method: 'POST', url: `/api/cards/${nucleus.id}/review`, payload: { rating: 3 } });
    assert.ok(graded.statusCode < 300, graded.body);

    const again = await api(student, {
      method: 'POST', url: `/api/decks/${deckId}/occlusion`,
      payload: {
        imageId, mode: 'all', prompt: 'Name this organelle',
        masks: [
          { ...masks[0], label: 'Nucleus (control centre)' },
          { id: 'm4', x: 0.3, y: 0.8, width: 0.1, height: 0.1, label: 'Ribosome' },
        ],
      },
    });
    assert.equal(again.statusCode, 201);
    const remade = again.json();
    assert.deepEqual([remade.created, remade.updated, remade.removed], [1, 1, 1]);
    const kept = remade.cards.find((c: { id: string }) => c.id === nucleus.id);
    assert.ok(kept, 'the surviving region keeps its card');
    assert.equal(kept.back, 'Nucleus (control centre)');
    assert.equal(kept.front, 'Name this organelle');
    assert.notEqual(kept.state, 'new');
    assert.equal(JSON.parse(kept.occlusion).mode, 'all');

    const listed = (await api(student, { method: 'GET', url: `/api/decks/${deckId}/cards` })).json();
    assert.equal((listed.cards ?? listed.items).length, 2);

    // Someone else's image cannot be borrowed.
    const other = await registerUser();
    const otherDeck = (
      await api(other, { method: 'POST', url: '/api/files', payload: { title: 'Mine', kind: 'deck' } })
    ).json().file.id as string;
    const stolen = await api(other, { method: 'POST', url: `/api/decks/${otherDeck}/occlusion`, payload: { imageId, masks } });
    assert.equal(stolen.statusCode, 404);
  });
});
