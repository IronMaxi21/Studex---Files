import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as stats from '../domain/stats.js';
import { requireAuth } from '../lib/http.js';
import { parse } from '../lib/validation.js';

export async function statsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/stats/overview', async (req) => {
    const { user } = requireAuth(req);
    return { overview: stats.overview(user.id) };
  });

  app.get('/stats/hours', async (req) => {
    const { user } = requireAuth(req);
    const q = parse(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), req.query);
    return { series: stats.hoursSeries(user.id, q.days) };
  });

  app.get('/stats/hours-by-subject', async (req) => {
    const { user } = requireAuth(req);
    const q = parse(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), req.query);
    return { subjects: stats.hoursBySubject(user.id, q.days) };
  });

  app.get('/stats/term', async (req) => {
    const { user } = requireAuth(req);
    const q = parse(z.object({ weeks: z.coerce.number().int().min(1).max(26).default(14) }), req.query);
    return { term: stats.termProgress(user.id, q.weeks) };
  });

  app.get('/stats/mastery', async (req) => {
    const { user } = requireAuth(req);
    return { mastery: stats.masteryBySubject(user.id) };
  });

  app.get('/stats/readiness', async (req) => {
    const { user } = requireAuth(req);
    return { readiness: stats.examReadiness(user.id) };
  });

  /** Weak topics, lapse-heavy cards and subjects behind their exams, together. */
  app.get('/stats/needs-work', async (req) => {
    const { user } = requireAuth(req);
    return { needs_work: stats.needsWork(user.id) };
  });
}
