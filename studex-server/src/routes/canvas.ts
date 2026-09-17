import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as canvas from '../domain/canvas.js';
import { requireAuth } from '../lib/http.js';
import { parse, uuid } from '../lib/validation.js';

const idParam = z.object({ id: uuid });

const saveBody = z.object({
  objects: canvas.canvasObjectsSchema,
  viewport: canvas.viewportSchema.optional(),
  background: canvas.backgroundSchema.optional(),
  expectedRevision: z.number().int().min(0).optional(),
});

export async function canvasRoutes(app: FastifyInstance): Promise<void> {
  app.get('/canvases/:id', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    return { canvas: canvas.getCanvas(user.id, id) };
  });

  app.put('/canvases/:id', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    const body = parse(saveBody, req.body);
    return { canvas: canvas.saveCanvas(user.id, id, body) };
  });
}
