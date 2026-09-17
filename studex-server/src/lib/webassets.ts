import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { config } from './config.js';

/**
 * Serves the desktop UI from memory.
 *
 * Every asset is read once at boot by walking the directory, and requests are
 * answered by an exact-match lookup on that map. Nothing from the URL is ever
 * joined onto a filesystem path, so directory traversal is not merely blocked
 * but unrepresentable — which is why this exists instead of a static-file
 * plugin. The asset set is a few hundred kilobytes, so holding it resident
 * costs nothing worth measuring.
 */

export interface Asset {
  body: Buffer;
  contentType: string;
  etag: string;
  /** Fingerprinted assets may be cached hard; entry points must not be. */
  immutable: boolean;
  /** Recorded during the boot-time walk; never derived from a request. */
  absPath: string;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  // A module served as anything else is refused by the import machinery, not
  // merely mislabelled — vendored ES modules ship with this extension.
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.icns': 'image/icns',
  '.map': 'application/json; charset=utf-8',
};

/** Guards against a symlink in the web directory pointing outside of it. */
function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function walk(root: string, dir: string, out: Map<string, Asset>): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    const real = fs.realpathSync(abs);
    if (!isInside(root, real)) continue;

    if (entry.isDirectory()) {
      walk(root, abs, out);
      continue;
    }
    if (!entry.isFile() && !fs.statSync(real).isFile()) continue;

    const body = fs.readFileSync(real);
    const ext = path.extname(entry.name).toLowerCase();
    const urlPath = '/' + path.relative(root, abs).split(path.sep).join('/');
    out.set(urlPath, {
      body,
      contentType: CONTENT_TYPES[ext] ?? 'application/octet-stream',
      etag: `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`,
      immutable: ext === '.woff2' || ext === '.woff' || ext === '.ttf',
      absPath: real,
    });
  }
}

export function loadWebAssets(root: string): Map<string, Asset> {
  const assets = new Map<string, Asset>();
  const resolved = path.resolve(root);
  if (!fs.existsSync(resolved)) return assets;
  // Each entry below is compared against this root after being resolved
  // through its own symlinks, so the root has to be resolved the same way —
  // otherwise a web directory reached through one (/tmp and /var on macOS are
  // both symlinks) fails every containment check and serves nothing at all.
  const real = fs.realpathSync(resolved);
  walk(real, real, assets);
  return assets;
}

/**
 * Outside production, re-read the file so edits show up on reload. The path
 * comes from the boot-time walk, not from the request, so this changes when
 * bytes are read — never which file may be read.
 */
function fresh(asset: Asset): Asset {
  if (config.isProd) return asset;
  try {
    const body = fs.readFileSync(asset.absPath);
    if (body.equals(asset.body)) return asset;
    asset.body = body;
    asset.etag = `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;
  } catch {
    // File went away mid-session; keep serving what we already have.
  }
  return asset;
}

function send(reply: FastifyReply, input: Asset, ifNoneMatch: string | undefined): FastifyReply {
  const asset = fresh(input);
  // Outside production the file on disk is the truth and edits must show up on
  // the next reload, so nothing is cached and revalidation never enters into
  // it. In production, fingerprinted assets are immutable and the rest
  // revalidate against the ETag.
  reply
    .header('content-type', asset.contentType)
    .header('x-content-type-options', 'nosniff');

  if (!config.isProd) {
    return reply.header('cache-control', 'no-store').send(asset.body);
  }

  reply
    .header('etag', asset.etag)
    .header(
      'cache-control',
      asset.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    );

  if (ifNoneMatch === asset.etag) return reply.code(304).send();
  return reply.send(asset.body);
}

/**
 * Registers the UI routes. Only called when a web directory is configured, so
 * a headless API deployment keeps its `default-src 'none'` posture and serves
 * no HTML at all.
 */
export async function webRoutes(
  app: FastifyInstance,
  opts: { root: string },
): Promise<void> {
  const assets = loadWebAssets(opts.root);
  const index = assets.get('/index.html');
  if (!index) {
    app.log.warn({ root: opts.root }, 'web directory has no index.html; UI not served');
    return;
  }

  app.log.info({ root: opts.root, files: assets.size }, 'serving desktop UI');

  app.get('/', async (req, reply) => send(reply, index, req.headers['if-none-match']));

  app.get('/*', async (req, reply) => {
    // `req.url` may carry a query string and percent-encoding; decode first so
    // that "/js/app.js" and "/js%2Fapp.js" resolve identically, then look the
    // result up as an exact key. A miss is a 404 — never a filesystem probe.
    const raw = req.url.split('?')[0] ?? '/';
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'Malformed URL' } });
    }

    const asset = assets.get(decoded);
    if (asset) return send(reply, asset, req.headers['if-none-match']);

    // The API must keep answering with JSON. Without this the catch-all would
    // swallow unknown /api paths and hand a browser the HTML shell with a 200,
    // turning a clean 404 into a parse error at the call site.
    if (decoded === '/health' || decoded === '/api' || decoded.startsWith('/api/')) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
    }

    // Unknown UI path: hand back the shell so client-side routing survives a
    // reload on a deep link.
    return send(reply, index, req.headers['if-none-match']);
  });
}
