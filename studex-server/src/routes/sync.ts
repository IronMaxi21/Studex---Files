import type { FastifyInstance } from 'fastify';
import * as sync from '../domain/sync.js';
import * as pull from '../domain/pull.js';
import { autoSyncSummary, clearAutoSyncBackoff } from '../domain/autosync.js';
import { realtimeSummary } from '../domain/realtime.js';
import { requireAuth } from '../lib/http.js';
import { authProvider } from '../domain/auth.js';

/** Walking a whole library is not something to allow on a tight loop. */
const throttled = { config: { rateLimit: { max: 12, timeWindow: '5 minutes' } } };

export async function syncRoutes(app: FastifyInstance): Promise<void> {
  app.get('/sync/status', async (req) => {
    const { user } = requireAuth(req);
    return {
      provider: authProvider(),
      items: sync.pendingCount(user.id),
      last: sync.lastRun(user.id),
      auto: autoSyncSummary(user.id),
      // Whether this account is being told about changes as they happen, as
      // opposed to waiting for its turn on the timer. `connected` is the
      // honest one: the feature can be on while the socket is down.
      live: realtimeSummary(user.id),
    };
  });

  /**
   * Both directions. This is what "Sync now" means: a device that only ever
   * sent would never learn anything, and one that only ever received would
   * never be backed up.
   */
  app.post('/sync', throttled, async (req) => {
    const { user } = requireAuth(req);
    const result = await pull.runTwoWay(user.id);
    clearAutoSyncBackoff(user.id);
    return result;
  });

  /** The halves on their own, for when only one of them is wanted. */
  app.post('/sync/push', throttled, async (req) => {
    const { user } = requireAuth(req);
    const pushed = await sync.runSync(user.id);
    clearAutoSyncBackoff(user.id);
    return { pushed };
  });

  app.post('/sync/pull', throttled, async (req) => {
    const { user } = requireAuth(req);
    const pulled = await pull.runPull(user.id);
    clearAutoSyncBackoff(user.id);
    return { pulled };
  });
}
