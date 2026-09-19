import type { FastifyInstance } from 'fastify';
import { may } from '../domain/capabilities.js';
import * as updates from '../domain/updates.js';
import { requireAuth } from '../lib/http.js';

export async function updateRoutes(app: FastifyInstance): Promise<void> {
  /** What is running. Cheap, and never leaves the machine. */
  app.get('/updates', async (req) => {
    requireAuth(req);
    return { update: updates.stateFor() };
  });

  /**
   * Asks the project's releases table. Rate limited because it reaches out of
   * the machine, and a button anyone can hold down should not become a way to
   * hammer a server with.
   */
  app.post('/updates/check', { config: { rateLimit: { max: 20, timeWindow: '5 minutes' } } }, async (req) => {
    requireAuth(req);
    const body = (req.body ?? {}) as { channel?: unknown };
    // A build that may not take unfinished releases is answered as if it had
    // asked for finished ones, whoever is asking and whatever it sent.
    const channel = may('betaChannel') && body.channel === 'beta' ? 'beta' : 'stable';
    return { update: await updates.check(updates.supabaseReleases(), { channel }) };
  });

  /** The same releases as a Sparkle appcast, for anything that reads one. */
  app.get('/updates/appcast.xml', async (req, reply) => {
    requireAuth(req);
    const query = req.query as { channel?: string };
    const result = await updates.check(updates.supabaseReleases(), {
      channel: may('betaChannel') && query.channel === 'beta' ? 'beta' : 'stable',
      system: null,
    });
    reply.type('application/rss+xml; charset=utf-8');
    return updates.appcastXml(result.releases);
  });
}
