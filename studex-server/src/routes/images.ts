import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import * as images from '../domain/images.js';
import { requireAuth } from '../lib/http.js';
import { badRequest } from '../lib/errors.js';
import { blobReadStream, safeFilename } from '../lib/storage.js';
import { parse, uuid } from '../lib/validation.js';

const idParam = z.object({ id: uuid });

export async function imageRoutes(app: FastifyInstance): Promise<void> {
  /** Upload an image into a document. */
  app.post(
    '/documents/:id/images',
    { config: { rateLimit: { max: 120, timeWindow: '10 minutes' } } },
    upload,
  );

  /** Upload a diagram into a deck, for image occlusion cards. */
  app.post(
    '/decks/:id/images',
    { config: { rateLimit: { max: 120, timeWindow: '10 minutes' } } },
    upload,
  );

  async function upload(req: FastifyRequest, reply: FastifyReply) {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);

    const part = await req.file();
    if (!part) throw badRequest('Expected a multipart file upload');

    const image = await images.addImage(user.id, {
      fileId: id,
      stream: part.file,
      originalName: safeFilename(part.filename ?? 'image', 'image'),
      // fastify-multipart does not error when a stream hits the configured
      // limit; it stops it and sets this flag. Asked before the blob is
      // moved into place, a cut-off upload is refused outright rather than
      // stored, charged to the quota and then answered with a 413.
      complete: () => !part.file.truncated,
    });

    return reply.code(201).send({ image });
  }

  /** Streams the stored bytes. Ownership is enforced before the stream opens. */
  app.get('/images/:id/content', async (req, reply) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    const record = images.requireImage(user.id, id);

    return reply
      // The type was decided by sniffing the bytes on upload, not by what the
      // uploader called the file.
      .header('content-type', record.mime)
      .header('content-length', String(record.byte_size))
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', `inline; filename="${safeFilename(record.original_name, 'image')}"`)
      // Content is immutable under its id, and the id is unguessable.
      .header('cache-control', 'private, max-age=31536000, immutable')
      .send(blobReadStream(record.storage_key));
  });

  app.delete('/images/:id', async (req, reply) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    await images.removeImage(user.id, id);
    return reply.code(204).send();
  });
}
