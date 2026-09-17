import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as search from '../domain/search.js';
import * as stats from '../domain/stats.js';
import * as cal from '../domain/calendar.js';
import * as lib from '../domain/library.js';
import { requireAuth } from '../lib/http.js';
import { parse } from '../lib/validation.js';

const searchQuery = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  types: z
    .string()
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.enum(['file', 'annotation', 'card', 'folder'])).max(4))
    .optional(),
});

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  /** "Search everything" behind ⌘K. */
  app.get('/search', async (req) => {
    const { user } = requireAuth(req);
    const q = parse(searchQuery, req.query);
    return { results: search.search(user.id, q.q, { limit: q.limit, types: q.types }) };
  });

  /**
   * Everything worth making findable from Spotlight, in one request.
   *
   * The shell is the side that can talk to CoreSpotlight and the page is the
   * side holding the session, so the page fetches this and hands it over. It
   * is only ever asked for when the student has turned indexing on.
   */
  app.get('/search/corpus', async (req) => {
    const { user } = requireAuth(req);
    return { items: search.corpus(user.id) };
  });

  /**
   * The home screen in one round trip: everything the dashboard shows, so the
   * client does not have to fan out into a dozen requests on launch.
   */
  app.get('/home', async (req) => {
    const { user } = requireAuth(req);
    const now = Date.now();
    const streak = stats.streakState(user.id, now);

    return {
      user: { display_name: user.display_name, plan: user.plan },
      next_exam: cal.upcoming(user.id, 1)[0] ?? null,
      cards_due: stats.dueCount(user.id, now),
      streak_days: streak.current,
      streak_freezes: streak.freezes,
      week: stats.weekProgress(user.id, now),
      hours_this_week: stats.hoursInWindow(user.id, 7 * 24 * 60 * 60 * 1000, now),
      active_session: cal.activeStudySession(user.id),
      deadlines: cal.upcoming(user.id, 4),
      exam_readiness: stats.examReadiness(user.id, now).slice(0, 4),
      recent_files: lib.listFiles(user.id, { limit: 6, offset: 0, sort: 'recent' }),
      pinned_files: lib.listFiles(user.id, { limit: 6, offset: 0, pinned: true }),
      storage: lib.storageUsage(user.id),
    };
  });
}
