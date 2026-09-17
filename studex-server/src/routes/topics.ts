import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as topics from '../domain/topics.js';
import { requireAuth } from '../lib/http.js';
import { parse, uuid } from '../lib/validation.js';

const idParam = z.object({ id: uuid });

const listQuery = z.object({
  subjectId: uuid.optional(),
  due: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

export async function topicRoutes(app: FastifyInstance): Promise<void> {
  app.get('/topics', async (req) => {
    const { user } = requireAuth(req);
    const q = parse(listQuery, req.query);
    return {
      topics: topics.listTopics(user.id, q),
      summary: topics.topicSummary(user.id),
      confidenceDays: topics.CONFIDENCE_DAYS,
      confidenceLabels: topics.CONFIDENCE_LABELS,
    };
  });

  app.post('/topics', async (req, reply) => {
    const { user } = requireAuth(req);
    const body = parse(topics.createTopicSchema, req.body);
    return reply.code(201).send({ topic: topics.createTopic(user.id, body) });
  });

  app.post('/topics/import', async (req, reply) => {
    const { user } = requireAuth(req);
    const body = parse(topics.importTopicsSchema, req.body);
    return reply.code(201).send(topics.importTopics(user.id, body));
  });

  app.post('/topics/merge', async (req) => {
    const { user } = requireAuth(req);
    const body = parse(topics.mergeTopicsSchema, req.body);
    return topics.mergeTopics(user.id, body);
  });

  app.patch('/topics/:id', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    const body = parse(topics.updateTopicSchema, req.body);
    return { topic: topics.updateTopic(user.id, id, body) };
  });

  /**
   * The one thing the matrix asks for. The reply carries the new due date,
   * because the point of rating a topic is to be told when to come back to it.
   */
  app.post('/topics/:id/rate', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    const body = parse(topics.rateTopicSchema, req.body);
    return { topic: topics.rateTopic(user.id, id, body.confidence) };
  });

  app.get('/topics/:id/history', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    return { ratings: topics.topicHistory(user.id, id) };
  });

  app.delete('/topics/:id', async (req, reply) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    topics.deleteTopic(user.id, id);
    return reply.code(204).send();
  });
}
