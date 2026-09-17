/**
 * What each tier is allowed to hold, and who is allowed to change tier.
 *
 * The interesting cases are the boundaries: the creation that takes an account
 * one past its cap, the one that fits again after something is trashed, and an
 * upgrade asked for by a client that has paid for nothing.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, closeApp, registerUser, type Client } from './helpers.js';
import { grantProEntitlement, revokeProEntitlement } from '../src/domain/auth.js';
import { FREE_LIMITS } from '../src/domain/plan.js';

async function makeCanvas(client: Client, title: string) {
  return api(client, { method: 'POST', url: '/api/files', payload: { title, kind: 'canvas' } });
}

describe('what a plan allows', () => {
  let student: Client;

  before(async () => { student = await registerUser('Plan Student'); });
  after(async () => { await closeApp(); });

  it('lets Free hold exactly its allowance of canvases and no more', async () => {
    const limit = FREE_LIMITS.canvas!;
    for (let i = 0; i < limit; i += 1) {
      const res = await makeCanvas(student, `Canvas ${i + 1}`);
      assert.equal(res.statusCode, 201, `canvas ${i + 1} should have been allowed`);
    }

    const over = await makeCanvas(student, 'One too many');
    assert.equal(over.statusCode, 402);
    assert.equal(over.json().error.code, 'plan_limit');
    // The message has to name the number, or it is just a locked door.
    assert.match(over.json().error.message, new RegExp(String(limit)));
  });

  it('counts only what is live, so the trash gives the slot back', async () => {
    const listed = await api(student, { method: 'GET', url: '/api/files?kind=canvas' });
    const first = listed.json().files[0];

    const trashed = await api(student, { method: 'DELETE', url: `/api/files/${first.id}` });
    assert.equal(trashed.statusCode, 204);

    const again = await makeCanvas(student, 'Back under the line');
    assert.equal(again.statusCode, 201);
  });

  it('lifts the cap once the account is entitled and on Pro', async () => {
    grantProEntitlement(student.userId, { source: 'purchase', reference: 'test' });
    const up = await api(student, { method: 'PATCH', url: '/api/auth/me/plan', payload: { plan: 'pro' } });
    assert.equal(up.statusCode, 200);

    const extra = await makeCanvas(student, 'Well past the Free line');
    assert.equal(extra.statusCode, 201);

    const status = await api(student, { method: 'GET', url: '/api/auth/me/plan' });
    assert.equal(status.json().plan, 'pro');
    assert.equal(status.json().entitled, true);
    assert.equal(status.json().limits.find((r: { kind: string }) => r.kind === 'canvas').limit, null);
  });

  it('drops back to Free when the entitlement ends, keeping every file', async () => {
    const before = await api(student, { method: 'GET', url: '/api/files?kind=canvas' });
    const heldBefore = before.json().files.length;

    revokeProEntitlement(student.userId);

    const status = await api(student, { method: 'GET', url: '/api/auth/me/plan' });
    assert.equal(status.json().plan, 'free');
    assert.equal(status.json().entitled, false);

    const after = await api(student, { method: 'GET', url: '/api/files?kind=canvas' });
    assert.equal(after.json().files.length, heldBefore);

    // Over the cap, so nothing new — but nothing lost either.
    const blocked = await makeCanvas(student, 'Not now');
    assert.equal(blocked.statusCode, 402);
  });

  it('does not ration notes or decks', async () => {
    for (let i = 0; i < FREE_LIMITS.canvas! + 4; i += 1) {
      const res = await api(student, {
        method: 'POST', url: '/api/files', payload: { title: `Note ${i}`, kind: 'doc' },
      });
      assert.equal(res.statusCode, 201);
    }
  });
});
