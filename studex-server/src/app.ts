import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { ZodError } from 'zod';

import { config } from './lib/config.js';
import { ApiError } from './lib/errors.js';
import { enforceOrigin, loadSession } from './lib/http.js';
import { migrate } from './lib/db.js';
import { webRoutes } from './lib/webassets.js';

import { authRoutes } from './routes/auth.js';
import { libraryRoutes } from './routes/library.js';
import { documentRoutes } from './routes/documents.js';
import { canvasRoutes } from './routes/canvas.js';
import { pdfRoutes } from './routes/pdf.js';
import { imageRoutes } from './routes/images.js';
import { flashcardRoutes } from './routes/flashcards.js';
import { calendarRoutes } from './routes/calendar.js';
import { timetableRoutes } from './routes/timetable.js';
import { topicRoutes } from './routes/topics.js';
import { tagRoutes } from './routes/tags.js';
import { statsRoutes } from './routes/stats.js';
import { settingsRoutes } from './routes/settings.js';
import { searchRoutes } from './routes/search.js';
import { shareRoutes } from './routes/shares.js';
import { packRoutes } from './routes/packs.js';
import { syncRoutes } from './routes/sync.js';
import { exportRoutes } from './routes/export.js';
import { updateRoutes } from './routes/updates.js';
import { aiRoutes } from './routes/ai.js';
import { billingRoutes } from './routes/billing.js';

export async function buildApp(): Promise<FastifyInstance> {
  migrate();

  const app = Fastify({
    logger: config.isTest
      ? false
      : {
          level: process.env.LOG_LEVEL ?? 'info',
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.headers["x-csrf-token"]',
              'res.headers["set-cookie"]',
            ],
            remove: true,
          },
        },
    trustProxy: config.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
    // Do not echo attacker-chosen request ids into logs or responses.
    genReqId: () => crypto.randomUUID(),
  });

  const servesUi = config.webDir !== null;

  /**
   * Headless, the API serves JSON and downloads only and can deny everything.
   * With the desktop UI attached the policy has to permit the app's own
   * assets, so it is widened by exactly what the shell needs and no more:
   * scripts stay 'self' with no 'unsafe-inline' and no 'unsafe-eval', which is
   * where XSS would actually bite. Style attributes are permitted because the
   * UI positions canvas objects and sizes progress bars inline; all user-
   * supplied text reaches the DOM through textContent, never innerHTML.
   */
  const cspDirectives: Record<string, string[]> = {
    defaultSrc: ["'none'"],
    frameAncestors: ["'none'"],
    baseUri: ["'none'"],
    formAction: ["'none'"],
  };

  if (servesUi) {
    Object.assign(cspDirectives, {
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      fontSrc: ["'self'"],
      connectSrc: ["'self'"],
      // The PDF reader renders pages itself, on a canvas, with pdf.js. Its
      // parser runs in a worker, and the pages it hands back are blobs.
      objectSrc: ["'self'"],
      frameSrc: ["'self'", 'blob:'],
      workerSrc: ["'self'", 'blob:'],
      childSrc: ["'self'", 'blob:'],
    });
  }

  if (!config.cookieSecure) {
    // Loopback http, which is where the desktop app lives. Telling the browser
    // to upgrade requests to https, and claiming HSTS on a response that was
    // never served over TLS, are both statements about a transport this
    // process does not have.
    cspDirectives.upgradeInsecureRequests = null as unknown as string[];
  }

  await app.register(helmet, {
    contentSecurityPolicy: { directives: cspDirectives },
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: config.cookieSecure ? { maxAge: 31536000, includeSubDomains: true } : false,
  });

  await app.register(cors, {
    // Exact-match allowlist. Never reflect an arbitrary origin while
    // credentials are enabled.
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // non-browser client
      const normalized = origin.replace(/\/$/, '');
      cb(null, config.corsOrigins.includes(normalized));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', config.session.csrfHeaderName],
    maxAge: 600,
  });

  await app.register(cookie, {
    secret: config.sessionSecret,
    parseOptions: { path: '/' },
  });

  await app.register(multipart, {
    limits: {
      fileSize: config.maxUploadBytes,
      files: 1,
      fields: 10,
      fieldSize: 4096,
    },
  });

  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    // Authenticated callers are limited per account, anonymous ones per IP,
    // so one noisy network cannot exhaust another user's budget.
    keyGenerator: (req) => req.user?.id ?? req.ip,
    // The web client is dozens of ES modules, fonts and the PDF worker; a
    // couple of reloads would otherwise spend the whole budget on static
    // files and lock the student out of their own library.
    allowList: (req) => !req.url.startsWith('/api'),
    addHeadersOnExceeding: { 'x-ratelimit-remaining': true },
  });

  app.addHook('onRequest', async (req) => {
    enforceOrigin(req);
    loadSession(req);
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof ApiError) {
      return reply
        .code(err.statusCode)
        .send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return reply.code(422).send({
        error: { code: 'unprocessable', message: 'Validation failed' },
      });
    }
    const status = err.statusCode ?? 500;
    if (status === 429) {
      return reply
        .code(429)
        .send({ error: { code: 'too_many_requests', message: 'Too many requests' } });
    }
    if (status >= 400 && status < 500) {
      // Fastify's own 4xx (bad JSON, payload too large, unsupported media type)
      return reply.code(status).send({
        error: { code: err.code ?? 'bad_request', message: err.message },
      });
    }
    // Anything unexpected is logged in full but reported opaquely.
    req.log.error({ err, reqId: req.id }, 'unhandled error');
    return reply.code(500).send({
      error: { code: 'internal_error', message: 'Something went wrong', requestId: req.id },
    });
  });

  app.get('/health', async () => ({ status: 'ok', time: Date.now() }));

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(libraryRoutes, { prefix: '/api' });
  await app.register(documentRoutes, { prefix: '/api' });
  await app.register(canvasRoutes, { prefix: '/api' });
  await app.register(pdfRoutes, { prefix: '/api' });
  await app.register(imageRoutes, { prefix: '/api' });
  await app.register(flashcardRoutes, { prefix: '/api' });
  await app.register(calendarRoutes, { prefix: '/api' });
  await app.register(timetableRoutes, { prefix: '/api' });
  await app.register(topicRoutes, { prefix: '/api' });
  await app.register(tagRoutes, { prefix: '/api' });
  await app.register(statsRoutes, { prefix: '/api' });
  await app.register(settingsRoutes, { prefix: '/api' });
  await app.register(searchRoutes, { prefix: '/api' });
  await app.register(syncRoutes, { prefix: '/api' });
  await app.register(exportRoutes, { prefix: '/api' });
  await app.register(updateRoutes, { prefix: '/api' });
  await app.register(billingRoutes, { prefix: '/api' });
  await app.register(aiRoutes, { prefix: '/api' });
  await app.register(shareRoutes, { prefix: '/api' });
  await app.register(packRoutes, { prefix: '/api' });

  // Registered last so every API prefix wins over the UI catch-all.
  if (config.webDir) {
    await app.register(webRoutes, { root: config.webDir });
  }

  return app;
}
