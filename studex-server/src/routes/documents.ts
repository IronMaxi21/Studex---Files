import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as docs from '../domain/documents.js';
import { requireAuth } from '../lib/http.js';
import { parse, text, uuid } from '../lib/validation.js';

const idParam = z.object({ id: uuid });

const saveBody = z.object({
  blocks: docs.blocksSchema,
  expectedRevision: z.number().int().min(0).optional(),
  style: docs.documentStyleSchema.optional(),
});

export async function documentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/documents/:id', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    return { document: docs.getDocument(user.id, id) };
  });

  // A document may hold 5,000 lines, and an imported Word file or textbook
  // chapter comes to far more than the app-wide 2 MB — which answered a large
  // import with a bare 413 after the empty document had already been made.
  app.put('/documents/:id', { bodyLimit: 16 * 1024 * 1024 }, async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    const body = parse(saveBody, req.body);
    return { document: docs.saveDocument(user.id, id, body.blocks, body.expectedRevision, body.style) };
  });

  /** Idempotent: the document's companion deck, created on first use. */
  app.post('/documents/:id/deck', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    return { deck: docs.ensureCardDeck(user.id, id) };
  });

  app.get('/documents/:id/outline', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    return { outline: docs.documentOutline(user.id, id) };
  });

  /** The pages that point at this one with `[[ ]]`. */
  app.get('/documents/:id/backlinks', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    return { backlinks: docs.backlinks(user.id, id) };
  });

  /**
   * What a `[[Title]]` resolves to. A miss is a 200 with a null, not a 404:
   * naming a page that does not exist yet is the ordinary way to make one, and
   * an error in the log every time somebody types a new link would be noise.
   */
  app.get('/documents/by-title/:title', async (req) => {
    const { user } = requireAuth(req);
    const { title } = parse(z.object({ title: text(300) }), req.params);
    return { file: docs.documentByTitle(user.id, title) };
  });
}
