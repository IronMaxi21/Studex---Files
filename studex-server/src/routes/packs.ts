import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import * as packs from '../domain/packs.js';
import * as shares from '../domain/shares.js';
import { requireAuth } from '../lib/http.js';
import { notFound } from '../lib/errors.js';
import { parse, uuid } from '../lib/validation.js';

const idParam = z.object({ id: uuid });
const tokenParam = z.string().regex(/^[A-Za-z0-9_-]{20,128}$/);

const importBody = z.object({
  pack: z.unknown(),
  folderId: uuid.nullish(),
  subjectId: uuid.nullish(),
});

function sendPack(reply: FastifyReply, pack: packs.Pack) {
  return reply
    .header('content-type', 'application/json; charset=utf-8')
    .header('content-disposition', `attachment; filename="${packs.packFilename(pack.title)}"`)
    .header('cache-control', 'no-store')
    .send(JSON.stringify(pack, null, 2));
}

export async function packRoutes(app: FastifyInstance): Promise<void> {
  app.get('/decks/:id/pack', async (req, reply) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    return sendPack(reply, packs.deckPack(user.id, id));
  });

  app.get('/subjects/:id/pack', async (req, reply) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    return sendPack(reply, packs.topicPack(user.id, id));
  });

  app.post(
    '/packs/import',
    // A pack of 5,000 cards is a few megabytes of JSON; the default body limit
    // would refuse the large ones a class actually makes.
    { bodyLimit: 12 * 1024 * 1024, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req) => {
      const { user } = requireAuth(req);
      const body = parse(importBody, req.body);
      return { imported: packs.importPack(user.id, body.pack, { folderId: body.folderId, subjectId: body.subjectId }) };
    },
  );

  /**
   * A deck reached by a share link, as a pack — what "copy into my library"
   * reads. View permission is enough, since a pack is a read.
   */
  app.get(
    '/shared/:token/decks/:id/pack',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { token, id } = parse(z.object({ token: tokenParam, id: uuid }), req.params);
      const access = shares.requireSharedFile(token, id, 'view');
      if (access.kind !== 'deck') throw notFound('This link is no longer available');
      return sendPack(reply, packs.deckPack(access.ownerId, access.fileId));
    },
  );
}
