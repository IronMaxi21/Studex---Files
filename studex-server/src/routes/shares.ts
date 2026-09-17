import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as shares from '../domain/shares.js';
import * as docs from '../domain/documents.js';
import * as canvas from '../domain/canvas.js';
import * as images from '../domain/images.js';
import { requireAuth } from '../lib/http.js';
import { notFound } from '../lib/errors.js';
import { blobReadStream, safeFilename } from '../lib/storage.js';
import { epochMs, parse, uuid } from '../lib/validation.js';

const tokenParam = z.string().regex(/^[A-Za-z0-9_-]{20,128}$/);

/** Anonymous, so every one of these is rate limited: a token is the only
 *  credential, and the limit is what stops the space being swept. */
const publicLimit = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };

export async function shareRoutes(app: FastifyInstance): Promise<void> {
  app.get('/shares', async (req) => {
    const { user } = requireAuth(req);
    return { shares: shares.listShares(user.id) };
  });

  app.post('/shares', async (req, reply) => {
    const { user } = requireAuth(req);
    const body = parse(
      z.object({
        targetType: z.enum(['file', 'folder']),
        targetId: uuid,
        // Absent means view. An edit link is only ever created on purpose.
        permission: z.enum(['view', 'edit']).optional(),
        expiresAt: epochMs.nullish(),
      }),
      req.body,
    );
    const { share, token } = shares.createShare(user.id, body);
    // The token is shown once; it is not recoverable from the share record.
    return reply.code(201).send({ share, token });
  });

  app.delete('/shares/:id', async (req, reply) => {
    const { user } = requireAuth(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    shares.revokeShare(user.id, id);
    return reply.code(204).send();
  });

  /**
   * Public read of a shared target. Deliberately unauthenticated, and rate
   * limited so the token space cannot be swept.
   */
  app.get('/shared/:token', publicLimit, async (req) => {
    const { token } = parse(z.object({ token: tokenParam }), req.params);
    const resolved = shares.resolveShareToken(token);
    // Revoked, expired and never-existed all look identical from outside.
    if (!resolved) throw notFound('This link is no longer available');
    return { shared: resolved };
  });

  /**
   * Content routes for a shared file.
   *
   * Each one resolves the token to the owner and then calls the very same
   * domain function the owner's own routes call, passing the owner's id. The
   * link decides *which* file may be touched; everything after that — kind
   * checks, block validation, revision conflicts, quota — is the ordinary
   * path, so shared editing cannot drift away from authenticated editing.
   */
  const sharedParams = z.object({ token: tokenParam, id: uuid });

  app.get('/shared/:token/documents/:id', publicLimit, async (req) => {
    const { token, id } = parse(sharedParams, req.params);
    const access = shares.requireSharedFile(token, id);
    return { document: docs.getDocument(access.ownerId, id), permission: access.permission };
  });

  app.put('/shared/:token/documents/:id', publicLimit, async (req) => {
    const { token, id } = parse(sharedParams, req.params);
    const access = shares.requireSharedFile(token, id, 'edit');
    const body = parse(
      z.object({
        blocks: docs.blocksSchema,
        expectedRevision: z.number().int().min(0).optional(),
        style: docs.documentStyleSchema.optional(),
      }),
      req.body,
    );
    return {
      document: docs.saveDocument(
        access.ownerId,
        id,
        body.blocks,
        body.expectedRevision,
        body.style,
      ),
    };
  });

  /**
   * The images inside a shared document.
   *
   * A document that reaches the reader without its pictures is not the
   * document, so the bytes have to be servable without a session. The scope is
   * drawn as narrowly as it can be: the image is looked up as the owner, and
   * then checked to belong to the very file the link admits. An image sitting
   * in some other document of theirs is a 404 here, exactly as it is to a
   * stranger with no link at all.
   */
  app.get('/shared/:token/documents/:id/images/:imageId/content', publicLimit, async (req, reply) => {
    const { token, id, imageId } = parse(sharedParams.extend({ imageId: uuid }), req.params);
    const access = shares.requireSharedFile(token, id);
    const record = images.requireImage(access.ownerId, imageId);
    if (record.file_id !== access.fileId) throw notFound('Image not found');

    return reply
      .header('content-type', record.mime)
      .header('content-length', String(record.byte_size))
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', `inline; filename="${safeFilename(record.original_name, 'image')}"`)
      // A share can be revoked, so this must not outlive the check that
      // granted it the way the owner's own immutable copy may.
      .header('cache-control', 'no-store')
      .send(blobReadStream(record.storage_key));
  });

  app.get('/shared/:token/canvases/:id', publicLimit, async (req) => {
    const { token, id } = parse(sharedParams, req.params);
    const access = shares.requireSharedFile(token, id);
    return { canvas: canvas.getCanvas(access.ownerId, id), permission: access.permission };
  });

  app.put('/shared/:token/canvases/:id', publicLimit, async (req) => {
    const { token, id } = parse(sharedParams, req.params);
    const access = shares.requireSharedFile(token, id, 'edit');
    const body = parse(
      z.object({
        objects: canvas.canvasObjectsSchema,
        viewport: canvas.viewportSchema.optional(),
        background: canvas.backgroundSchema.optional(),
        expectedRevision: z.number().int().min(0).optional(),
      }),
      req.body,
    );
    return { canvas: canvas.saveCanvas(access.ownerId, id, body) };
  });
}
