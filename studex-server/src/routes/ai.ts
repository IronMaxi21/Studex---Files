/**
 * The AI endpoints.
 *
 * Thin by design: the interesting decisions — what the allowance is, what the
 * model is asked, and what is done with the answer — are all in the domain.
 * What lives here is the authentication, the rate limit, and turning the two
 * things that can go wrong with a remote model into HTTP that says which one
 * it was.
 */
import type { FastifyInstance } from 'fastify';
import * as ai from '../domain/ai.js';
import { z } from 'zod';
import { AiError } from '../lib/ai.js';
import { clearKey, currentKey, keyHint, keySource, saveKey } from '../lib/ai-key.js';
import { config } from '../lib/config.js';
import { ApiError, badRequest, forbidden } from '../lib/errors.js';
import { requireAuth } from '../lib/http.js';
import { parse, uuid } from '../lib/validation.js';

/**
 * A model failure the person can read.
 *
 * 502 for "the model did not answer", because that is what it is: an upstream
 * that is down or busy, and the honest advice is to try again. 400 for a
 * request the model was right to refuse. Neither is a 500, which would be
 * logged as a bug in Studex and reported as "something went wrong" — true, but
 * not something anyone can act on.
 */
async function surfaced<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof AiError) {
      throw new ApiError(err.retryable ? 502 : 400, err.retryable ? 'ai_unavailable' : 'ai_refused', err.message);
    }
    throw err;
  }
}

/** The loop-stopper. The monthly allowance in the domain is the real limit. */
const LIMIT = { config: { rateLimit: { max: config.aiRateLimitMax, timeWindow: '1 minute' } } };

const NO_AI = 'No AI key is set. Add one in Settings → AI.';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Whether this server may have its key changed over HTTP.
 *
 * The desktop app's server listens on loopback and belongs to whoever is at the
 * Mac, so its Settings screen can set the key. A server on a public address is
 * someone's deployment, and its key belongs in its environment, not in a form
 * any signed-in account could submit.
 */
function keyEditable(): boolean {
  return !config.isProd || LOOPBACK.has(config.host);
}

const keySchema = z.object({
  // Classic keys are `AIza…`; newer AI Studio keys are `AQ.…` and carry dots.
  key: z.string().trim().min(20, 'That key is too short — copy the whole key from Google AI Studio').max(512).regex(/^[\x21-\x7E]+$/, 'That does not look like a Google AI Studio key'),
  /** Ask Google whether the key works before keeping it. */
  verify: z.boolean().default(true),
});

/** Lists the models the key can see: the cheapest call that proves a key works. */
async function verifyKey(key: string): Promise<{ ok: true; models: number } | { ok: false; reason: string }> {
  try {
    const response = await fetch(`${config.ai.baseUrl}/v1beta/models?pageSize=50`, {
      headers: { 'x-goog-api-key': key },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'Google AI Studio did not accept that key.' };
    }
    if (!response.ok) return { ok: false, reason: `Google answered ${response.status} when the key was checked.` };
    const body = (await response.json().catch(() => ({}))) as { models?: unknown[] };
    return { ok: true, models: Array.isArray(body.models) ? body.models.length : 0 };
  } catch (err) {
    return { ok: false, reason: `Could not reach Google to check the key: ${(err as Error).message}` };
  }
}

function keyStatus() {
  return {
    keySet: currentKey() !== null,
    keySource: keySource(),
    keyHint: keyHint(),
    keyEditable: keyEditable() && keySource() !== 'env',
  };
}

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  /** Whether to show the buttons at all, how much of the month is left, and which models do what. */
  app.get('/ai/status', async (req) => {
    const { user } = requireAuth(req);
    const available = ai.available();
    return {
      available,
      usage: available ? ai.usageFor(user.id) : null,
      ...keyStatus(),
      models: config.ai.models,
      roles: ai.ROLE_OF,
      weights: ai.WEIGHT,
    };
  });

  app.put('/ai/key', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    requireAuth(req);
    if (!keyEditable()) throw forbidden('This server’s AI key is set where it is deployed, not from the app.');
    if (keySource() === 'env') throw badRequest('This install’s key comes from its environment, which wins over Settings.');
    const body = parse(keySchema, req.body);
    let account = null;
    if (body.verify) {
      const checked = await verifyKey(body.key);
      if (!checked.ok) throw badRequest(checked.reason);
      account = checked;
    }
    saveKey(body.key);
    return { ...keyStatus(), account };
  });

  app.delete('/ai/key', async (req) => {
    requireAuth(req);
    if (!keyEditable()) throw forbidden('This server’s AI key is set where it is deployed, not from the app.');
    if (keySource() === 'env') throw badRequest('This install’s key comes from its environment, and cannot be removed here.');
    clearKey();
    return keyStatus();
  });

  app.get('/ai/calls', async (req) => {
    const { user } = requireAuth(req);
    return { calls: ai.recentCalls(user.id) };
  });

  app.post('/ai/cards', LIMIT, async (req) => {
    const { user } = requireAuth(req);
    if (!ai.available()) throw badRequest(NO_AI);
    const body = parse(ai.generateCardsSchema, req.body);
    return surfaced(() => ai.generateCards(user.id, body));
  });

  app.post('/ai/explain', LIMIT, async (req) => {
    const { user } = requireAuth(req);
    if (!ai.available()) throw badRequest(NO_AI);
    const body = parse(ai.explainSchema, req.body);
    return surfaced(() => ai.explain(user.id, body));
  });

  app.post('/ai/revision-plan', LIMIT, async (req) => {
    const { user } = requireAuth(req);
    if (!ai.available()) throw badRequest(NO_AI);
    const body = parse(ai.revisionPlanSchema, req.body);
    return surfaced(() => ai.revisionPlan(user.id, body));
  });

  /** A specification's text in, a proposed topic list out. Nothing is saved. */
  app.post('/ai/spec/unpack', { ...LIMIT, bodyLimit: 4 * 1024 * 1024 }, async (req) => {
    const { user } = requireAuth(req);
    if (!ai.available()) throw badRequest(NO_AI);
    const body = parse(ai.specUnpackSchema, req.body);
    return surfaced(() => ai.unpackSpec(user.id, body));
  });

  app.post('/ai/quiz', LIMIT, async (req) => {
    const { user } = requireAuth(req);
    if (!ai.available()) throw badRequest(NO_AI);
    const body = parse(ai.quizSchema, req.body);
    return surfaced(() => ai.quiz(user.id, body));
  });

  /** Written answers marked against the model answers the quiz came with. */
  app.post('/ai/quiz/mark', LIMIT, async (req) => {
    const { user } = requireAuth(req);
    if (!ai.available()) throw badRequest(NO_AI);
    const body = parse(ai.markSchema, req.body);
    return surfaced(() => ai.markAnswers(user.id, body));
  });

  app.post('/ai/chat', { ...LIMIT, bodyLimit: 1024 * 1024 }, async (req) => {
    const { user } = requireAuth(req);
    if (!ai.available()) throw badRequest(NO_AI);
    const body = parse(ai.chatSchema, req.body);
    return surfaced(() => ai.chat(user.id, body));
  });

  app.get('/ai/chats', async (req) => {
    const { user } = requireAuth(req);
    return { chats: ai.listChats(user.id) };
  });

  app.get('/ai/chats/:id', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    return { chat: ai.getChat(user.id, id) };
  });

  app.delete('/ai/chats/:id', async (req, reply) => {
    const { user } = requireAuth(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    ai.deleteChat(user.id, id);
    return reply.code(204).send();
  });

  app.delete('/ai/chats', async (req, reply) => {
    const { user } = requireAuth(req);
    ai.clearChats(user.id);
    return reply.code(204).send();
  });

  app.post('/ai/topics/dedupe', LIMIT, async (req) => {
    const { user } = requireAuth(req);
    if (!ai.available()) throw badRequest(NO_AI);
    const body = parse(ai.dedupeSchema, req.body ?? {});
    return surfaced(() => ai.findDuplicateTopics(user.id, body));
  });
}
