/**
 * Imported first by every test file so the environment is in place before
 * config.ts is evaluated. ESM evaluates imports in order, so this runs before
 * anything that reads process.env at module scope.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studex-test-'));

process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = path.join(root, 'test.sqlite');
process.env.STORAGE_DIR = path.join(root, 'blobs');
process.env.SESSION_SECRET = 'test-secret-that-is-at-least-32-bytes-long!!';
process.env.CORS_ORIGINS = 'http://localhost:5173';
process.env.STORAGE_QUOTA_BYTES = String(5 * 1024 * 1024);
process.env.MAX_UPLOAD_BYTES = String(2 * 1024 * 1024);
// Fixtures create many accounts from one address; the per-IP credential
// limiter would otherwise reject them. Account lockout is unaffected and is
// covered explicitly in the throttling tests.
process.env.AUTH_RATE_LIMIT_MAX = '1000';

// The update tests need the server to believe it is running inside a bundle;
// outside one there is no version to compare a release against. Where the
// releases come from is not configured — the tests hand `check` their own
// source, and with no Supabase project set the real one is never built.
process.env.STUDEX_VERSION = '1.0.0';
process.env.STUDEX_BUILD = '202601010000';

// The identity-provider tests inject their own gateway. Clearing these makes
// sure a developer whose shell exports a real project cannot turn a test run
// into live traffic against it.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_ANON_KEY;

// Same reasoning for the model: a shell that exports a real key would
// otherwise turn a test run into billable requests. The one file that tests
// the AI sets its own, after this, and replaces `fetch` before using it.
delete process.env.GEMINI_API_KEY;

export const testRoot = root;

process.on('exit', () => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // Best effort — the OS will reclaim the temp directory anyway.
  }
});
