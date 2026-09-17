import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as cards from '../domain/flashcards.js';
import * as mock from '../domain/mockexam.js';
import * as tuning from '../domain/tuning.js';
import * as occlusion from '../domain/occlusion.js';
import { requireAuth } from '../lib/http.js';
import { pagination, parse, richText, text, uuid } from '../lib/validation.js';

const idParam = z.object({ id: uuid });

const createCardBody = z.object({
  deckId: uuid,
  front: richText(4_000),
  back: richText(4_000),
  topic: text(120).nullish(),
  extra1: richText(4_000).nullish(),
  extra2: richText(4_000).nullish(),
  sourceFileId: uuid.nullish(),
});

const updateCardBody = z
  .object({
    front: richText(4_000).optional(),
    back: richText(4_000).optional(),
    topic: text(120).nullable().optional(),
    extra1: richText(4_000).nullable().optional(),
    extra2: richText(4_000).nullable().optional(),
    suspended: z.boolean().optional(),
    deckId: uuid.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

const templateBody = z.object({
  template: z
    .object({
      align: z.enum(['left', 'center']),
      size: z.enum(['small', 'medium', 'large']),
      backFirst: z.boolean(),
      fields: z.array(z.object({ label: text(40), kind: z.enum(['line', 'worked']) })).max(2),
    })
    .nullable(),
});

const reviewBody = z.object({
  rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  durationMs: z.number().int().min(0).max(3_600_000).optional(),
  mode: z.enum(['review', 'test']).optional(),
});

export async function flashcardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/decks/:id/cards', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    const q = parse(pagination, req.query);
    return { cards: cards.listCards(user.id, id, q.limit, q.offset) };
  });

  app.get('/decks/:id/stats', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    return { stats: cards.deckStats(user.id, id) };
  });

  app.get('/decks/:id/template', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    return { template: cards.deckTemplate(user.id, id) };
  });

  app.put('/decks/:id/template', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    const body = parse(templateBody, req.body);
    return { template: cards.setDeckTemplate(user.id, id, body.template) };
  });

  /** Makes (or remakes) the image occlusion cards for one diagram. */
  app.post('/decks/:id/occlusion', async (req, reply) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    const body = parse(occlusion.occlusionInputSchema, req.body);
    return reply.code(201).send(occlusion.createOcclusionCards(user.id, id, body));
  });

  app.post('/cards', async (req, reply) => {
    const { user } = requireAuth(req);
    const body = parse(createCardBody, req.body);
    return reply.code(201).send({ card: cards.createCard(user.id, body) });
  });

  app.patch('/cards/:id', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    const body = parse(updateCardBody, req.body);
    return { card: cards.updateCard(user.id, id, body) };
  });

  app.delete('/cards/:id', async (req, reply) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    cards.deleteCard(user.id, id);
    return reply.code(204).send();
  });

  /** The study queue: due cards first, then new ones up to the daily limit. */
  app.get('/study/today', async (req) => {
    const { user } = requireAuth(req);
    return { today: cards.todayReview(user.id) };
  });

  app.get('/study/queue', async (req) => {
    const { user } = requireAuth(req);
    const q = parse(
      z.object({
        deckId: uuid.optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        // A mixed session across decks, narrowed to one subject, tag or topic.
        subjectId: uuid.optional(),
        tagId: uuid.optional(),
        topic: text(120).optional(),
        // The "Needs work" session: the cards lapsed on most, whatever their
        // schedule. Combines with the scope filters above.
        weak: z.coerce.boolean().optional(),
      }),
      req.query,
    );
    return cards.reviewQueue(user.id, {
      deckId: q.deckId,
      limit: q.limit,
      subjectId: q.subjectId,
      tagId: q.tagId,
      topic: q.topic,
      weak: q.weak,
    });
  });

  app.get('/scheduler', async (req) => {
    const { user } = requireAuth(req);
    return { scheduler: tuning.schedulerStatus(user.id) };
  });

  /** "Tune my scheduler": fits FSRS to this account's own reviews. */
  app.post('/scheduler/tune', async (req) => {
    const { user } = requireAuth(req);
    return { result: tuning.tuneScheduler(user.id), scheduler: tuning.schedulerStatus(user.id) };
  });

  app.delete('/scheduler/tune', async (req) => {
    const { user } = requireAuth(req);
    tuning.resetScheduler(user.id);
    return { scheduler: tuning.schedulerStatus(user.id) };
  });

  app.post('/cards/:id/review', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    const body = parse(reviewBody, req.body);
    return cards.reviewCard(user.id, id, body);
  });

  /* test mode */

  app.post('/tests', async (req, reply) => {
    const { user } = requireAuth(req);
    const body = parse(z.object({ deckId: uuid.nullish() }), req.body ?? {});
    return reply.code(201).send({ test: cards.startTest(user.id, body.deckId ?? null) });
  });

  app.get('/tests/:id', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    return { test: cards.getTest(user.id, id) };
  });

  app.post('/tests/:id/answers', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        cardId: uuid,
        correct: z.boolean(),
        durationMs: z.number().int().min(0).max(3_600_000).optional(),
      }),
      req.body,
    );
    return { test: cards.submitTestAnswer(user.id, id, body) };
  });

  app.post('/tests/:id/end', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    return { test: cards.endTest(user.id, id) };
  });

  /* mock exams */

  app.get('/mocks', async (req) => {
    const { user } = requireAuth(req);
    return { mocks: mock.listMockExams(user.id) };
  });

  app.post('/mocks', async (req, reply) => {
    const { user } = requireAuth(req);
    const body = parse(
      z.object({
        subjectId: uuid,
        count: z.number().int().min(1).max(60).default(20),
        durationMin: z.number().int().min(0).max(360).default(0),
      }),
      req.body,
    );
    return reply.code(201).send({ mock: mock.startMockExam(user.id, body) });
  });

  app.get('/mocks/:id', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    return { mock: mock.getMockExam(user.id, id) };
  });

  app.post('/mocks/:id/answers', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        questionId: uuid,
        correct: z.boolean(),
        durationMs: z.number().int().min(0).max(3_600_000).optional(),
      }),
      req.body,
    );
    return { mock: mock.answerMockQuestion(user.id, id, body) };
  });

  app.post('/mocks/:id/finish', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParam, req.params);
    return { mock: mock.finishMockExam(user.id, id) };
  });
}
