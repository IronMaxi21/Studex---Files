import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as pdf from '../domain/pdf.js';
import { requireAuth } from '../lib/http.js';
import { blobReadStream, safeFilename } from '../lib/storage.js';
import { badRequest } from '../lib/errors.js';
import { colorToken, parse, richText, text, uuid } from '../lib/validation.js';

const idParam = z.object({ id: uuid });
const annotationParam = z.object({ id: uuid, annotationId: uuid });

export async function pdfRoutes(app: FastifyInstance): Promise<void> {
  /** Import a PDF. Uploads are capped and rate-limited more tightly than reads. */
  app.post('/pdfs', { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const { user } = requireAuth(req);

    const part = await req.file();
    if (!part) throw badRequest('Expected a multipart file upload');

    // The declared mimetype is a hint only — storeStream verifies the bytes.
    const titleField = part.fields?.title;
    const folderField = part.fields?.folderId;
    const rawTitle =
      titleField && 'value' in titleField && typeof titleField.value === 'string'
        ? titleField.value
        : part.filename;
    const rawFolder =
      folderField && 'value' in folderField && typeof folderField.value === 'string'
        ? folderField.value
        : undefined;

    const meta = parse(
      z.object({ title: text(200), folderId: uuid.optional() }),
      { title: rawTitle?.replace(/\.pdf$/i, '') || 'Untitled', folderId: rawFolder || undefined },
    );

    const result = await pdf.importPdf(user.id, {
      stream: part.file,
      originalName: safeFilename(part.filename ?? 'document.pdf'),
      title: meta.title,
      folderId: meta.folderId ?? null,
      // fastify-multipart does not error when a stream hits the configured
      // limit; it stops it and sets this flag. Asked before the blob is moved
      // into place, an oversized upload is refused without ever becoming a
      // file in the library that says "File exceeds the maximum allowed size"
      // and opens to half a document.
      complete: () => !part.file.truncated,
    });

    return reply.code(201).send({ fileId: result.fileId, pdf: result.pdf });
  });

  app.get('/pdfs/:id', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    return { pdf: pdf.requirePdf(user.id, id) };
  });

  app.patch('/pdfs/:id', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ pageCount: z.number().int().min(1).max(10_000) }), req.body);
    return { pdf: pdf.setPageCount(user.id, id, body.pageCount) };
  });

  /** Streams the stored bytes. Ownership is enforced before the stream opens. */
  app.get('/pdfs/:id/content', async (req, reply) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    const q = parse(z.object({ download: z.enum(['0', '1']).optional() }), req.query);
    const record = pdf.requirePdf(user.id, id);

    const filename = safeFilename(record.original_name);
    const disposition = q.download === '1' ? 'attachment' : 'inline';

    return reply
      .header('content-type', 'application/pdf')
      .header('content-length', String(record.byte_size))
      // nosniff plus an explicit disposition keeps the browser from ever
      // treating stored bytes as active content.
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', `${disposition}; filename="${filename}"`)
      // The app-wide policy is `frame-ancestors 'none'`, which is right for
      // every page but forbids this one from being embedded anywhere at all —
      // including the reader's own same-origin iframe, which is how the
      // platform viewer draws the file. This response relaxes exactly that one
      // directive and keeps the rest denied: the bytes are a document, and
      // nothing in them may load or run anything.
      .header(
        'content-security-policy',
        "default-src 'none'; object-src 'self'; frame-ancestors 'self'",
      )
      .header('cache-control', 'private, no-store')
      .send(blobReadStream(record.storage_key));
  });

  /* annotations */

  app.get('/pdfs/:id/annotations', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    const q = parse(z.object({ page: z.coerce.number().int().min(1).max(10_000).optional() }), req.query);
    return { annotations: pdf.listAnnotations(user.id, id, { page: q.page }) };
  });

  app.post('/pdfs/:id/annotations', async (req, reply) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    const body = parse(pdf.createAnnotationSchema, req.body);
    return reply.code(201).send({ annotation: pdf.createAnnotation(user.id, id, body) });
  });

  app.patch('/pdfs/:id/annotations/:annotationId', async (req) => {
    const { user } = requireAuth(req);
    const { id, annotationId } = parse(annotationParam, req.params);
    pdf.requireAnnotationInFile(user.id, id, annotationId);
    const body = parse(
      z
        .object({ note: richText(10_000).nullable().optional(), color: colorToken.nullable().optional() })
        .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' }),
      req.body,
    );
    return { annotation: pdf.updateAnnotation(user.id, annotationId, body) };
  });

  app.delete('/pdfs/:id/annotations/:annotationId', async (req, reply) => {
    const { user } = requireAuth(req);
    const { id, annotationId } = parse(annotationParam, req.params);
    pdf.requireAnnotationInFile(user.id, id, annotationId);
    pdf.deleteAnnotation(user.id, annotationId);
    return reply.code(204).send();
  });

  app.post('/pdfs/:id/cards-from-highlights', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    const body = parse(pdf.cardsFromHighlightsSchema, req.body);
    return pdf.createCardsFromHighlights(user.id, id, body);
  });

  app.get('/pdfs/:id/export', async (req, reply) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    const markdown = pdf.exportAnnotations(user.id, id);
    return reply
      .header('content-type', 'text/markdown; charset=utf-8')
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', 'attachment; filename="annotations.md"')
      .send(markdown);
  });
}
