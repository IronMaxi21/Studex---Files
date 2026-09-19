import './release-setup.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { api, closeApp, getApp, registerUser, type Client } from './helpers.js';

let alice: Client;

before(async () => {
  await getApp();
  alice = await registerUser('Downloaded The App');
});

after(async () => {
  await closeApp();
});

const deviceId = 'release-test-device';

/* -------------------------------------------------------------------------- */

describe('the build people download', () => {
  it('says what it is and what it does not offer', async () => {
    const res = await api(alice, { method: 'GET', url: '/api/capabilities' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().capabilities, {
      channel: 'release',
      developer: false,
      layoutChoice: false,
      betaChannel: false,
    });
  });

  it('wants an account before it will say', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/api/capabilities' });
    assert.equal(res.statusCode, 401);
  });

  it('keeps the one window layout, whatever it is asked for', async () => {
    const patched = await api(alice, {
      method: 'PATCH',
      url: `/api/settings/devices/${deviceId}`,
      payload: { shellLayout: 'workspace_tabs', canvasChrome: 'tool_column', docWidth: 'wide' },
    });
    assert.equal(patched.statusCode, 200);
    // Refused in the domain, not hidden in a screen: the request was well
    // formed and was simply not acted on.
    assert.equal(patched.json().settings.shell_layout, 'folder_tree');
    assert.equal(patched.json().settings.canvas_chrome, 'floating_dock');
    // Everything that is reading rather than rearranging still goes through.
    assert.equal(patched.json().settings.doc_width, 'wide');

    const read = await api(alice, { method: 'GET', url: `/api/settings/devices/${deviceId}` });
    assert.equal(read.json().settings.shell_layout, 'folder_tree');
    assert.equal(read.json().settings.canvas_chrome, 'floating_dock');
  });

  it('hides the model roster and the call log behind the same answer', async () => {
    const res = await api(alice, { method: 'GET', url: '/api/ai/status' });
    assert.equal(res.statusCode, 200);
    const status = res.json();
    assert.equal(status.developer, false);
    assert.equal(status.models, null, 'a release build does not name the models');
    assert.equal(status.roles, null);
    assert.equal(status.keyEditable, false, 'and brings its own key');
    // The allowance is the person's business whichever build they are on.
    assert.ok(status.weights);
  });

  it('will not have its own key set over HTTP', async () => {
    const res = await api(alice, {
      method: 'PUT',
      url: '/api/ai/key',
      payload: { key: 'AIza0000000000000000000000000000000000', verify: false },
    });
    assert.equal(res.statusCode, 403);
  });

  /*
   * Asking for beta cannot be checked end to end here: with no project to
   * look in, both channels stop at the same 409 before any release is read.
   * What the routes do with the answer is a direct read of `betaChannel`,
   * which the first test above pins to false.
   */
  it('takes the same road for beta as for stable, having no unfinished releases to offer', async () => {
    const beta = await api(alice, { method: 'POST', url: '/api/updates/check', payload: { channel: 'beta' } });
    const stable = await api(alice, { method: 'POST', url: '/api/updates/check', payload: { channel: 'stable' } });
    assert.equal(beta.statusCode, stable.statusCode);
    assert.equal(beta.json().error.code, stable.json().error.code);
  });
});
