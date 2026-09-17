import './setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadWebAssets } from '../src/lib/webassets.js';

describe('web assets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studex-web-'));
  fs.mkdirSync(path.join(root, 'vendor'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html>');
  fs.writeFileSync(path.join(root, 'app.js'), 'export const a = 1;');
  fs.writeFileSync(path.join(root, 'vendor', 'lib.mjs'), 'export const b = 2;');
  fs.writeFileSync(path.join(root, 'sheet.css'), 'body{}');

  const assets = loadWebAssets(root);

  it('serves an ES module as JavaScript', () => {
    // A .mjs served as anything else is refused by the import machinery
    // outright, so this is the difference between a vendored module working
    // and the screen that uses it failing to load at all.
    assert.match(assets.get('/vendor/lib.mjs')!.contentType, /^text\/javascript/);
    assert.match(assets.get('/app.js')!.contentType, /^text\/javascript/);
  });

  it('still types everything else correctly', () => {
    assert.match(assets.get('/index.html')!.contentType, /^text\/html/);
    assert.match(assets.get('/sheet.css')!.contentType, /^text\/css/);
  });

  it('walks into subdirectories and keeps their url path', () => {
    assert.ok(assets.has('/vendor/lib.mjs'));
  });
});
