/**
 * The server the browser tests drive.
 *
 * It is the real one — the same `src/server.ts` the desktop app launches —
 * pointed at a throwaway database and told to serve the web layer from
 * `studex-mac/web`. That last part is what makes these tests worth writing:
 * the interface and the API are one origin here exactly as they are inside the
 * app, so nothing about cookies, CORS or asset paths is special-cased for the
 * test and true nowhere else.
 *
 * The database is deleted on every start. A browser test that depends on what
 * the previous run left behind passes for reasons nobody can reconstruct.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const data = path.join(root, '.e2e');

fs.rmSync(data, { recursive: true, force: true });
fs.mkdirSync(data, { recursive: true });

process.env.NODE_ENV = 'test';
process.env.HOST = '127.0.0.1';
process.env.PORT = process.env.PORT ?? '8123';
process.env.DATABASE_PATH = path.join(data, 'studex.sqlite');
process.env.STORAGE_DIR = path.join(data, 'blobs');
process.env.WEB_DIR = path.resolve(root, '../studex-mac/web');

// Migrations run when the app is built, so importing the server is the whole
// of the setup; everything after this point is the app the user would get.
await import('../src/server.js');
