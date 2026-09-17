import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as cal from '../domain/calendar.js';
import * as revision from '../domain/revision.js';
import { requireAuth } from '../lib/http.js';
import { epochMsParam, parse, uuid } from '../lib/validation.js';

const idParam = z.object({ id: uuid });

/** Comma-separated repeated query params, e.g. ?kinds=exam,deadline */
const csv = (inner: z.ZodTypeAny) =>
  z
    .string()
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(inner).max(20));

const listQuery = z.object({
  from: epochMsParam.optional(),
  to: epochMsParam.optional(),
  kinds: csv(cal.eventKind).optional(),
  subjectIds: csv(z.string().uuid()).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

export async function calendarRoutes(app: FastifyInstance): Promise<void> {
  app.get('/events', async (req) => {
    const { user } = requireAuth(req);
    const q = parse(listQuery, req.query);
    return { events: cal.listEvents(user.id, q) };
  });

  app.post('/events', async (req, reply) => {
    const { user } = requireAuth(req);
    const body = parse(cal.createEventSchema, req.body);
    return reply.code(201).send({ event: cal.createEvent(user.id, body) });
  });

  app.patch('/events/:id', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    const body = parse(cal.updateEventSchema, req.body);
    return { event: cal.updateEvent(user.id, id, body) };
  });

  app.delete('/events/:id', async (req, reply) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    cal.deleteEvent(user.id, id);
    return reply.code(204).send();
  });

  // The revision plan an exam writes from the student's own weak spots.
  app.post('/events/:id/revision-plan/draft', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    const body = parse(revision.planOptionsSchema, req.body ?? {});
    return { plan: revision.draftPlan(user.id, id, body) };
  });

  app.get('/events/:id/revision-plan', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    return { sessions: revision.planSessions(user.id, id) };
  });

  app.put('/events/:id/revision-plan', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    const body = parse(revision.acceptPlanSchema, req.body);
    return revision.acceptPlan(user.id, id, body);
  });

  app.delete('/events/:id/revision-plan', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    return { removed: revision.clearPlan(user.id, id) };
  });

  app.get('/events/upcoming', async (req) => {
    const { user } = requireAuth(req);
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(20).default(5) }), req.query);
    return { events: cal.upcoming(user.id, q.limit) };
  });

  app.get('/plan/today', async (req) => {
    const { user } = requireAuth(req);
    const q = parse(z.object({ from: epochMsParam, to: epochMsParam }), req.query);
    return { blocks: cal.todaysPlan(user.id, q.from, q.to) };
  });

  /* focus timer */

  app.get('/study-sessions/active', async (req) => {
    const { user } = requireAuth(req);
    return { session: cal.activeStudySession(user.id) };
  });

  app.post('/study-sessions', async (req, reply) => {
    const { user } = requireAuth(req);
    const body = parse(
      z.object({
        subjectId: uuid.nullish(),
        fileId: uuid.nullish(),
        eventId: uuid.nullish(),
        goal: z.string().max(200).nullish(),
        plannedMinutes: z.number().int().min(1).max(600).default(25),
        cycleIndex: z.number().int().min(1).max(20).optional(),
        cycleTotal: z.number().int().min(1).max(20).optional(),
      }),
      req.body ?? {},
    );
    return reply.code(201).send({ session: cal.startStudySession(user.id, body) });
  });

  app.post('/study-sessions/:id/pause', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    return { session: cal.pauseStudySession(user.id, id) };
  });

  app.post('/study-sessions/:id/resume', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    return { session: cal.resumeStudySession(user.id, id) };
  });

  app.post('/study-sessions/:id/end', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        status: z.enum(['completed', 'abandoned']).default('completed'),
        goalMet: z.boolean().nullish(),
      }),
      req.body ?? {},
    );
    return { session: cal.endStudySession(user.id, id, body.status, body.goalMet) };
  });

  app.post('/study-sessions/:id/goal', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ met: z.boolean() }), req.body ?? {});
    return { session: cal.markSessionGoal(user.id, id, body.met) };
  });

  app.get('/study-sessions/goals', async (req) => {
    const { user } = requireAuth(req);
    return { sessions: cal.recentGoals(user.id) };
  });
}
