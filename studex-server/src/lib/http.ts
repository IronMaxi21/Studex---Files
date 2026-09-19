import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { hashToken, safeEqual } from './crypto.js';
import { authenticate, revocationReason, type SessionRow, type User } from '../domain/auth.js';
import { forbidden, sessionReplaced, unauthorized } from './errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
    session?: SessionRow;
    /** True when the caller authenticated with a bearer token rather than a cookie. */
    bearerAuth?: boolean;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function sessionCookieOptions(maxAgeMs: number) {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    // Strict is the strongest CSRF posture and is correct for a first-party
    // client served from the same site as this API.
    sameSite: 'strict' as const,
    path: '/',
    maxAge: Math.floor(maxAgeMs / 1000),
  };
}

/** The CSRF cookie is deliberately readable by script — that is the point of double-submit. */
export function csrfCookieOptions(maxAgeMs: number) {
  return { ...sessionCookieOptions(maxAgeMs), httpOnly: false };
}

export function setSessionCookies(
  reply: FastifyReply,
  session: { token: string; csrfToken: string; expiresAt: number },
): void {
  const maxAge = session.expiresAt - Date.now();
  reply.setCookie(config.session.cookieName, session.token, sessionCookieOptions(maxAge));
  reply.setCookie(config.session.csrfCookieName, session.csrfToken, csrfCookieOptions(maxAge));
}

export function clearSessionCookies(reply: FastifyReply): void {
  const opts = { path: '/' };
  reply.clearCookie(config.session.cookieName, opts);
  reply.clearCookie(config.session.csrfCookieName, opts);
}

function extractToken(req: FastifyRequest): { token: string; viaBearer: boolean } | null {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (token) return { token, viaBearer: true };
  }
  const cookie = req.cookies?.[config.session.cookieName];
  if (cookie) return { token: cookie, viaBearer: false };
  return null;
}

/**
 * Rejects state-changing requests whose Origin is not an allowed one.
 * This runs before authentication so that a forged cross-site request is
 * refused even if it carries a valid cookie.
 */
export function enforceOrigin(req: FastifyRequest): void {
  if (SAFE_METHODS.has(req.method)) return;

  const origin = req.headers.origin;
  if (origin) {
    const normalized = origin.replace(/\/$/, '');
    if (!config.corsOrigins.includes(normalized)) {
      throw forbidden('Cross-origin request refused');
    }
    return;
  }

  // No Origin header: browsers always send one on cross-site state-changing
  // requests, so its absence means a non-browser client, which a malicious
  // page cannot drive. Cookie-authenticated callers still have to present a
  // valid CSRF token below, so this path is not a way around that check.
}

/** Double-submit CSRF check for cookie-authenticated, state-changing requests. */
function enforceCsrf(req: FastifyRequest, session: SessionRow): void {
  if (SAFE_METHODS.has(req.method)) return;
  if (req.bearerAuth) return; // cookies are not attached, so CSRF does not apply

  const header = req.headers[config.session.csrfHeaderName];
  const provided = Array.isArray(header) ? header[0] : header;
  if (!provided) throw forbidden('Missing CSRF token');
  if (!safeEqual(hashToken(provided), session.csrf_token_hash)) {
    throw forbidden('Invalid CSRF token');
  }
}

/** Attaches req.user when a valid session is present; never throws. */
export function loadSession(req: FastifyRequest): void {
  const extracted = extractToken(req);
  if (!extracted) return;
  const result = authenticate(extracted.token);
  if (!result) return;
  req.user = result.user;
  req.session = result.session;
  req.bearerAuth = extracted.viaBearer;
}

/** Route guard: requires an authenticated caller and a valid CSRF token. */
export function requireAuth(req: FastifyRequest): { user: User; session: SessionRow } {
  if (!req.user || !req.session) {
    const extracted = extractToken(req);
    if (extracted && revocationReason(extracted.token) === 'signed_in_elsewhere') {
      throw sessionReplaced();
    }
    throw unauthorized();
  }
  enforceCsrf(req, req.session);
  return { user: req.user, session: req.session };
}

export function clientIp(req: FastifyRequest): string | null {
  return req.ip ?? null;
}

export function userAgent(req: FastifyRequest): string | null {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' ? ua : null;
}
