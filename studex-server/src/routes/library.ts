import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as lib from '../domain/library.js';
import * as preview from '../domain/preview.js';
import * as revisions from '../domain/revisions.js';
import { backgroundSchema } from '../domain/canvas.js';
import { documentStyleSchema } from '../domain/documents.js';
import { requireAuth } from '../lib/http.js';
import { colorToken, nameOrUntitled, pagination, parse, text, uuid } from '../lib/validation.js';

const fileKind = z.enum(['canvas', 'doc', 'pdf', 'deck']);

const idParam = z.object({ id: uuid });

const revisionParams = z.object({ id: uuid, revisionId: uuid });

const createFolderBody = z.object({
  name: nameOrUntitled(120),
  parentId: uuid.nullish(),
  subjectId: uuid.nullish(),
  color: colorToken.nullish(),
});

const updateFolderBody = z
  .object({
    name: nameOrUntitled(120).optional(),
    parentId: uuid.nullable().optional(),
    subjectId: uuid.nullable().optional(),
    color: colorToken.nullable().optional(),
    pinned: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

const createFileBody = z.object({
  title: nameOrUntitled(200),
  kind: fileKind,
  folderId: uuid.nullish(),
  colorOverride: colorToken.nullish(),
  /** Canvases only: which paper to start on. Ignored for every other kind. */
  background: backgroundSchema.optional(),
  /** Documents only: standard prose, or every block marked as an item. */
  style: documentStyleSchema.optional(),
});

const updateFileBody = z
  .object({
    title: nameOrUntitled(200).optional(),
    folderId: uuid.nullable().optional(),
    colorOverride: colorToken.nullable().optional(),
    pinned: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

const listFilesQuery = pagination.extend({
  folderId: z.union([uuid, z.literal('root')]).optional(),
  kind: fileKind.optional(),
  pinned: z.enum(['true', 'false']).optional(),
  sort: z.enum(['recent', 'title']).optional(),
  trashed: z.enum(['1', '0', 'true', 'false']).optional(),
});

export async function libraryRoutes(app: FastifyInstance): Promise<void> {
  /* subjects */

  app.get('/subjects', async (req) => {
    const { user } = requireAuth(req);
    return { subjects: lib.listSubjects(user.id) };
  });

  app.post('/subjects', async (req, reply) => {
    const { user } = requireAuth(req);
    const body = parse(
      z.object({ name: text(80), color: colorToken.optional(), teacher: text(60).nullish() }),
      req.body,
    );
    return reply.code(201).send({ subject: lib.createSubject(user.id, body) });
  });

  app.patch('/subjects/:id', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({ name: text(80).optional(), color: colorToken.optional(), teacher: text(60).nullable().optional() }),
      req.body,
    );
    return { subject: lib.updateSubject(user.id, id, body) };
  });

  /* folders */

  app.get('/folders', async (req) => {
    const { user } = requireAuth(req);
    return { folders: lib.listFolders(user.id) };
  });

  app.post('/folders', async (req, reply) => {
    const { user } = requireAuth(req);
    const body = parse(createFolderBody, req.body);
    return reply.code(201).send({ folder: lib.createFolder(user.id, body) });
  });

  app.patch('/folders/:id', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    const body = parse(updateFolderBody, req.body);
    return { folder: lib.updateFolder(user.id, id, body) };
  });

  app.delete('/folders/:id', async (req, reply) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    lib.deleteFolder(user.id, id);
    return reply.code(204).send();
  });

  /* files */

  app.get('/files', async (req) => {
    const { user } = requireAuth(req);
    const q = parse(listFilesQuery, req.query);
    const filter = {
      // 'root' selects files that sit outside any folder.
      folderId: q.folderId === undefined ? undefined : q.folderId === 'root' ? null : q.folderId,
      kind: q.kind,
      pinned: q.pinned === undefined ? undefined : q.pinned === 'true',
      sort: q.sort,
      trashed: q.trashed === '1' || q.trashed === 'true',
    };
    const files = lib.listFiles(user.id, { ...filter, limit: q.limit, offset: q.offset });
    // `total` is what lets a client page: without it the only way to learn how
    // many files there are is to ask for all of them.
    return { files, total: lib.countFiles(user.id, filter), limit: q.limit, offset: q.offset };
  });

  app.post('/files', async (req, reply) => {
    const { user } = requireAuth(req);
    const body = parse(createFileBody, req.body);
    return reply.code(201).send({ file: lib.createFile(user.id, body) });
  });

  app.get('/files/:id', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    const file = lib.requireFile(user.id, id);
    return { file: { ...file, pinned: file.pinned === 1, effective_color: lib.effectiveFileColor(user.id, file) } };
  });

  /** Everything a glance at a file shows, without opening it. */
  app.get('/files/:id/preview', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    return preview.filePreview(user.id, id);
  });

  /**
   * The states this file was in before sync or a restore replaced them. A file
   * is one file on every device, so this is where the version that lost sits.
   */
  app.get('/files/:id/revisions', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    return { revisions: revisions.listRevisions(user.id, id) };
  });

  app.post('/files/:id/revisions/:revisionId/restore', async (req) => {
    const { user } = requireAuth(req);
    const { id, revisionId } = parse(revisionParams, req.params);
    return { revisions: await revisions.restoreRevision(user.id, id, revisionId) };
  });

  app.patch('/files/:id', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    const body = parse(updateFileBody, req.body);
    return { file: lib.updateFile(user.id, id, body) };
  });

  app.delete('/files/:id', async (req, reply) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    lib.trashFile(user.id, id);
    return reply.code(204).send();
  });

  app.post('/files/:id/restore', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    return { file: lib.restoreFile(user.id, id) };
  });

  app.delete('/files/:id/purge', async (req, reply) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    lib.purgeFile(user.id, id);
    return reply.code(204).send();
  });

  app.get('/storage', async (req) => {
    const { user } = requireAuth(req);
    return { storage: lib.storageUsage(user.id) };
  });
}
