import './setup.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

/**
 * The built-in key file, damaged in the ways a release could ship it.
 *
 * ai-key.ts caches what it read for the life of the process, so each case
 * loads its own copy of the module (a distinct query string is a distinct
 * module to the loader). The key is not a credential: it only has to look
 * like one.
 */
const FAKE = 'AIzaSy-test-not-a-real-key-000000';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studex-aikey-'));
let n = 0;

function mask(key: string, padLength = key.length) {
  const bytes = Buffer.from(key, 'utf8');
  const pad = crypto.randomBytes(padLength);
  const data = bytes.map((b, i) => b ^ (pad[i] ?? 0));
  return { pad: pad.toString('base64'), data: Buffer.from(data).toString('base64') };
}

async function builtinFrom(contents: string) {
  const file = path.join(dir, `key-${++n}.json`);
  fs.writeFileSync(file, contents);
  process.env.GEMINI_BUILTIN_KEY_FILE = file;
  const mod = (await import(`../src/lib/ai-key.js?case=${n}`)) as typeof import('../src/lib/ai-key.js');
  return { key: mod.currentKey(), source: mod.keySource() };
}

describe('built-in AI key', () => {
  it('unmasks a well-formed file', async () => {
    assert.deepEqual(await builtinFrom(JSON.stringify(mask(FAKE))), { key: FAKE, source: 'builtin' });
  });

  it('refuses an empty pad instead of using the masked bytes as the key', async () => {
    const { data } = mask(FAKE);
    assert.deepEqual(await builtinFrom(JSON.stringify({ pad: '', data })), { key: null, source: null });
  });

  it('refuses a pad shorter than the key', async () => {
    assert.deepEqual(await builtinFrom(JSON.stringify(mask(FAKE, 4))), { key: null, source: null });
  });

  it('refuses a pad that unmasks to something that is not a key', async () => {
    const { data } = mask(FAKE);
    const wrong = crypto.randomBytes(FAKE.length).toString('base64');
    assert.deepEqual(await builtinFrom(JSON.stringify({ pad: wrong, data })), { key: null, source: null });
  });

  it('refuses a file with the wrong shape', async () => {
    assert.deepEqual(await builtinFrom('{"pad": 7}'), { key: null, source: null });
    assert.deepEqual(await builtinFrom('not json'), { key: null, source: null });
  });
});
