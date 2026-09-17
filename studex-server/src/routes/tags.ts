import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as tags from '../domain/tags.js';
import { requireAuth } from '../lib/http.js';
import { notFound } from '../lib/errors.js';
import { parse, text, uuid } from '../lib/validation.js';

const idParam = z.object({ id: uuid });
const nameParam = z.object({ name: text(60) });
const itemParams = z.object({ itemType: z.enum(['folder', 'file']), itemId: uuid });

export async function tagRoutes(app: FastifyInstance): Promise<void> {
  /** Every tag in the account, with how many folders and files are on each. */
  app.get('/tags', async (req) => {
    const { user } = requireAuth(req);
    return { tags: tags.listTags(user.id) };
  });

  /** Every tag with every link, for drawing dots and filtering in the client. */
  app.get('/tags/links', async (req) => {
    const { user } = requireAuth(req);
    return { tags: tags.listTags(user.id), links: tags.tagLinks(user.id) };
  });

  app.post('/tags', async (req, reply) => {
    const { user } = requireAuth(req);
    const body = parse(tags.createTagSchema, req.body);
    return reply.code(201).send({ tag: tags.createTag(user.id, body) });
  });

  /**
   * A tag and everything on it, looked up by name rather than by id.
   *
   * By name because that is what the URL in the app holds — `#tag/biology` is
   * a link a student can read, share and type, and it keeps working after a
   * tag is deleted and written again.
   */
  app.get('/tags/by-name/:name', async (req, reply) => {
    const { user } = requireAuth(req);
    const { name } = parse(nameParam, req.params);
    const found = tags.tagged(user.id, name);
    if (!found) throw notFound('No such tag.');
    return found;
  });

  app.patch('/tags/:id', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    const body = parse(tags.updateTagSchema, req.body);
    return { tag: tags.updateTag(user.id, id, body) };
  });

  app.delete('/tags/:id', async (req, reply) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    tags.deleteTag(user.id, id);
    return reply.code(204).send();
  });

  /** The tags on one folder or file, and everything that shares them. */
  app.get('/tags/on/:itemType/:itemId', async (req) => {
    const { user } = requireAuth(req);
    const { itemType, itemId } = parse(itemParams, req.params);
    return {
      tags: tags.tagsFor(user.id, itemType, itemId),
      related: tags.related(user.id, itemType, itemId),
    };
  });

  app.post('/tags/attach', async (req, reply) => {
    const { user } = requireAuth(req);
    const body = parse(tags.attachSchema, req.body);
    return reply.code(201).send(tags.attach(user.id, body));
  });

  app.delete('/tags/:id/on/:itemType/:itemId', async (req, reply) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    const { itemType, itemId } = parse(itemParams, req.params);
    tags.detach(user.id, id, itemType, itemId);
    return reply.code(204).send();
  });
}
