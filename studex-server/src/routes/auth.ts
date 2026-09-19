import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as auth from '../domain/auth.js';
import * as plan from '../domain/plan.js';
import { clearSessionCookies, clientIp, requireAuth, setSessionCookies, userAgent } from '../lib/http.js';
import { email, parse, password, text } from '../lib/validation.js';
import { notFound } from '../lib/errors.js';
import { config } from '../lib/config.js';

const registerBody = z.object({
  email,
  password,
  displayName: text(80),
});

const loginBody = z.object({
  email,
  password: z.string().min(1).max(1024),
});

const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: password,
});

/** Tight limits on credential endpoints, independent of the global limiter. */
const credentialLimit = {
  rateLimit: { max: config.authRateLimitMax, timeWindow: '5 minutes' },
};

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get('/status', async () => ({
    hasUsers: auth.hasAnyUser(),
    // Which credential store is in play. The sign-in view needs this: under
    // Supabase, accounts live in the project rather than in this database, so
    // an empty local users table says nothing about whether one exists.
    provider: auth.authProvider(),
  }));

  app.post('/register', { config: credentialLimit }, async (req, reply) => {
    const body = parse(registerBody, req.body);
    const result = await auth.register({
      email: body.email,
      password: body.password,
      displayName: body.displayName,
      ip: clientIp(req),
      userAgent: userAgent(req),
    });

    // Supabase can be configured to require a confirmation email, in which
    // case the account exists but nothing yet proves the address belongs to
    // whoever asked. There is no session to hand back and no local account to
    // create until they follow the link.
    if (result.status === 'confirm-email') {
      return reply.code(202).send({ pendingConfirmation: true });
    }

    const { user, session } = result;
    setSessionCookies(reply, session);
    return reply.code(201).send({
      user,
      // Returned once so non-browser clients can use bearer auth.
      token: session.token,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
      // An account holds one live session, so a sign-in here may have ended
      // one elsewhere. The client says so rather than leaving it a mystery.
      signedOutElsewhere: session.signedOutElsewhere,
    });
  });

  app.post('/login', { config: credentialLimit }, async (req, reply) => {
    const body = parse(loginBody, req.body);
    const { user, session } = await auth.login({
      email: body.email,
      password: body.password,
      ip: clientIp(req),
      userAgent: userAgent(req),
    });
    setSessionCookies(reply, session);
    return reply.send({
      user,
      token: session.token,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
      // An account holds one live session, so a sign-in here may have ended
      // one elsewhere. The client says so rather than leaving it a mystery.
      signedOutElsewhere: session.signedOutElsewhere,
    });
  });

  app.post('/logout', async (req, reply) => {
    const { session } = requireAuth(req);
    auth.revokeSession(session.id);
    clearSessionCookies(reply);
    return reply.code(204).send();
  });

  app.get('/me', async (req) => {
    const { user } = requireAuth(req);
    const fresh = auth.getUser(user.id);
    if (!fresh) throw notFound('User no longer exists');
    return { user: fresh };
  });

  /**
   * What this account is allowed, and whether it may move up.
   *
   * `entitled` is the answer to "would an upgrade be accepted", so the Plan
   * screen can offer the right thing rather than offering a switch that the
   * server is going to refuse.
   */
  app.get('/me/plan', async (req) => {
    const { user } = requireAuth(req);
    const usage = plan.planUsage(user.id);
    return {
      plan: usage.plan,
      entitled: auth.hasProEntitlement(user.id),
      limits: usage.items,
      freeLimits: plan.FREE_LIMITS,
    };
  });

  app.patch('/me/plan', async (req) => {
    const { user } = requireAuth(req);
    const body = parse(z.object({ plan: z.enum(['free', 'pro']) }), req.body);
    return { user: auth.setPlan(user.id, body.plan) };
  });

  app.get('/sessions', async (req) => {
    const { user, session } = requireAuth(req);
    return { sessions: auth.listSessions(user.id, session.id) };
  });

  app.delete('/sessions', async (req) => {
    const { user, session } = requireAuth(req);
    const revoked = auth.revokeAllSessions(user.id, session.id);
    return { revoked };
  });

  app.post('/change-password', { config: credentialLimit }, async (req, reply) => {
    const { user, session } = requireAuth(req);
    const body = parse(changePasswordBody, req.body);
    await auth.changePassword({
      userId: user.id,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
      keepSessionId: session.id,
    });
    return reply.code(204).send();
  });
}
