import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as tt from '../domain/timetable.js';
import { requireAuth } from '../lib/http.js';
import { epochMsParam, parse, uuid } from '../lib/validation.js';

const idParam = z.object({ id: uuid });
const weekParam = z.object({ week: tt.weekLabel });

export async function timetableRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The whole pattern in one response.
   *
   * Periods, both weeks of lessons and the A/B anchor together, because the grid
   * cannot be drawn without all three and asking for them separately would only
   * mean three round trips to draw one screen.
   */
  app.get('/timetable', async (req) => {
    const { user } = requireAuth(req);
    const anchor = tt.getWeekAnchor(user.id);
    return {
      periods: tt.listPeriods(user.id),
      lessons: tt.listLessons(user.id),
      weekAStart: anchor,
      currentWeek: tt.weekOf(anchor, Date.now()),
    };
  });

  app.put('/timetable/periods', async (req) => {
    const { user } = requireAuth(req);
    const body = parse(tt.periodsSchema, req.body);
    return { periods: tt.setPeriods(user.id, body) };
  });

  app.put('/timetable/anchor', async (req) => {
    const { user } = requireAuth(req);
    const body = parse(tt.anchorSchema, req.body);
    const anchor = tt.setWeekAnchor(user.id, body.weekAStart);
    return { weekAStart: anchor, currentWeek: tt.weekOf(anchor, Date.now()) };
  });

  app.put('/timetable/lessons', async (req) => {
    const { user } = requireAuth(req);
    const body = parse(tt.lessonSchema, req.body);
    return { lesson: tt.putLesson(user.id, body) };
  });

  app.delete('/timetable/lessons/:id', async (req, reply) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    tt.deleteLesson(user.id, id);
    return reply.code(204).send();
  });

  app.delete('/timetable/weeks/:week', async (req) => {
    const { user } = requireAuth(req);
    const { week } = parse(weekParam, req.params);
    return { cleared: tt.clearWeek(user.id, week) };
  });

  app.post('/timetable/weeks/:week/copy', async (req) => {
    const { user } = requireAuth(req);
    const { week } = parse(weekParam, req.params);
    return { lessons: tt.copyWeek(user.id, week) };
  });

  /** The pattern placed on real dates, for the calendar and the week grid. */
  app.get('/timetable/lessons', async (req) => {
    const { user } = requireAuth(req);
    const q = parse(z.object({ from: epochMsParam, to: epochMsParam }), req.query);
    return { lessons: tt.lessonsBetween(user.id, q.from, q.to) };
  });
}
