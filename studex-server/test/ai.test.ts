import './ai-env.js';
import './setup.js';
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import { api, closeApp, getApp, multipartBody, registerUser, samplePdfWithPages, uuid, type Client } from './helpers.js';
import fs from 'node:fs';
import path from 'node:path';
import { extractJsonArray, extractJsonObject } from '../src/lib/ai.js';
import { config } from '../src/lib/config.js';

let alice: Client;
let deckId: string;
let docId: string;
let pdfId: string;

/** Every request aimed at the model, in order. `model` is read from the URL, where Gemini puts it. */
interface Call { url: string; model: string | null; body: Record<string, unknown> }
let calls: Call[] = [];
let reply: (call: Call) => { status?: number; json: unknown } = () => ({ json: {} });

const realFetch = globalThis.fetch;

/** The shape Gemini's generateContent answers with, around whatever text is given. */
function said(text: string, finishReason = 'STOP') {
  return {
    json: {
      modelVersion: 'answering-model',
      candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason }],
      usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 60 },
    },
  };
}

interface Turn { role: string; parts: Array<{ text: string }> }
const turns = (call: Call) => call.body.contents as Turn[];
/** The system instruction sent with a call. */
const systemOf = (call: Call) =>
  ((call.body.systemInstruction as { parts: Array<{ text: string }> } | undefined)?.parts ?? []).map((p) => p.text).join('');
/** What the person asked, as opposed to the system prompt in front of it. */
const userPrompt = (call: Call) => turns(call).at(-1)!.parts.map((p) => p.text).join('');
const generation = (call: Call) => (call.body.generationConfig ?? {}) as Record<string, unknown>;

before(async () => {
  await getApp();
  alice = await registerUser('Aisha');

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith('https://generativelanguage.googleapis.com/')) {
      throw new Error(`unexpected outbound request to ${url}`);
    }
    const model = /\/models\/([^:/?]+):/.exec(url)?.[1] ?? null;
    const call: Call = { url, model, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> };
    calls.push(call);
    const answer = reply(call);
    return new Response(JSON.stringify(answer.json), {
      status: answer.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const file = async (title: string, kind: string) =>
    (await api(alice, { method: 'POST', url: '/api/files', payload: { title, kind } })).json().file.id as string;

  deckId = await file('Chemistry', 'deck');
  docId = await file('Rates of reaction', 'doc');

  await api(alice, {
    method: 'PUT',
    url: `/api/documents/${docId}`,
    payload: {
      blocks: [
        { id: uuid(), type: 'heading', level: 1, text: 'Rates of reaction' },
        { id: uuid(), type: 'paragraph', text: 'A catalyst lowers the activation energy of a reaction.' },
      ],
    },
  });

  const upload = multipartBody(
    { title: 'Paper 2' },
    { field: 'file', filename: 'paper.pdf', contentType: 'application/pdf', content: samplePdfWithPages(6) },
  );
  pdfId = (await api(alice, { method: 'POST', url: '/api/pdfs', payload: upload.payload, headers: upload.headers }))
    .json().fileId as string;

  await api(alice, {
    method: 'POST',
    url: `/api/pdfs/${pdfId}/annotations`,
    payload: {
      page: 2,
      kind: 'highlight',
      geometry: { kind: 'quads', quads: [{ x: 80, y: 220, width: 340, height: 16 }] },
      quotedText: 'Dynamic equilibrium is reached when the forward and reverse rates are equal.',
    },
  });
});

after(async () => {
  globalThis.fetch = realFetch;
  await closeApp();
});

afterEach(() => {
  calls = [];
  reply = () => ({ json: {} });
});

/** Puts the month's allowance back, so one test's spend is not another's. */
async function resetAllowance() {
  const { getDb } = await import('../src/lib/db.js');
  getDb().prepare('DELETE FROM ai_usage').run();
  getDb().prepare('DELETE FROM ai_calls').run();
}

describe('reading what the model sent back', () => {
  it('takes the array out of a fenced answer', () => {
    const parsed = extractJsonArray('```json\n[{"front":"a","back":"b"}]\n```');
    assert.equal(parsed.length, 1);
  });

  it('takes the array out of an answer with a sentence in front of it', () => {
    const parsed = extractJsonArray('Here are the cards:\n[{"front":"a","back":"b"}]');
    assert.equal(parsed.length, 1);
  });

  it('refuses an answer with no list in it', () => {
    assert.throws(() => extractJsonArray('I would rather not.'), /did not answer with a list/);
  });
});

describe('status', () => {
  it('reports the allowance, not just that the feature exists', async () => {
    await resetAllowance();
    const res = await api(alice, { method: 'GET', url: '/api/ai/status' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().available, true);
    assert.deepEqual(
      { used: res.json().usage.used, limit: res.json().usage.limit },
      { used: 0, limit: 6 },
    );
  });

  it('is not readable without a session', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/api/ai/status' });
    assert.equal(res.statusCode, 401);
  });
});

describe('cards from material', () => {
  it('writes what came back into the deck, and only what parsed', async () => {
    await resetAllowance();
    reply = () => said(JSON.stringify([
      { front: 'What does a catalyst do?', back: 'Lowers the activation energy.', topic: 'Catalysis' },
      { front: 'Missing a back' },
      { front: 'What is activation energy?', back: 'The minimum energy for a reaction to proceed.' },
    ]));

    const res = await api(alice, {
      method: 'POST',
      url: '/api/ai/cards',
      payload: { deckId, source: { from: 'document', fileId: docId }, count: 10 },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().created, 2);

    const cards = await api(alice, { method: 'GET', url: `/api/decks/${deckId}/cards` });
    const fronts = cards.json().cards.map((c: { front: string }) => c.front);
    assert.ok(fronts.includes('What does a catalyst do?'));
    assert.ok(!fronts.includes('Missing a back'));
  });

  it('sends the note itself, not a reference to it', async () => {
    await resetAllowance();
    reply = () => said('[{"front":"q","back":"a"}]');
    await api(alice, {
      method: 'POST',
      url: '/api/ai/cards',
      payload: { deckId, source: { from: 'document', fileId: docId } },
    });
    const prompt = userPrompt(calls[0]!);
    assert.match(prompt, /lowers the activation energy/i);
  });

  it('can hand the cards back without writing any of them', async () => {
    await resetAllowance();
    reply = () => said('[{"front":"held back","back":"a"}]');
    const res = await api(alice, {
      method: 'POST',
      url: '/api/ai/cards',
      payload: { deckId, source: { from: 'text', text: 'Le Chatelier’s principle.' }, commit: false },
    });
    assert.equal(res.json().created, 0);
    assert.equal(res.json().cards.length, 1);

    const cards = await api(alice, { method: 'GET', url: `/api/decks/${deckId}/cards` });
    assert.ok(!cards.json().cards.some((c: { front: string }) => c.front === 'held back'));
  });

  it('makes cards from the passages marked up in a page range', async () => {
    await resetAllowance();
    reply = () => said('[{"front":"q","back":"a"}]');
    const res = await api(alice, {
      method: 'POST',
      url: '/api/ai/cards',
      payload: { deckId, source: { from: 'pdf', fileId: pdfId, fromPage: 1, toPage: 3 } },
    });
    assert.equal(res.statusCode, 200);
    const prompt = userPrompt(calls[0]!);
    assert.match(prompt, /dynamic equilibrium/i);
  });

  it('says so when nothing in those pages is marked up, without paying for it', async () => {
    await resetAllowance();
    const res = await api(alice, {
      method: 'POST',
      url: '/api/ai/cards',
      payload: { deckId, source: { from: 'pdf', fileId: pdfId, fromPage: 4, toPage: 6 } },
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error.message, /nothing marked up/i);
    assert.equal(calls.length, 0);

    const status = await api(alice, { method: 'GET', url: '/api/ai/status' });
    assert.equal(status.json().usage.used, 0);
  });

  it('will not read a note belonging to somebody else', async () => {
    await resetAllowance();
    const bob = await registerUser('Bob');
    const bobDeck = (await api(bob, { method: 'POST', url: '/api/files', payload: { title: 'D', kind: 'deck' } }))
      .json().file.id;
    const res = await api(bob, {
      method: 'POST',
      url: '/api/ai/cards',
      payload: { deckId: bobDeck, source: { from: 'document', fileId: docId } },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(calls.length, 0);
  });
});

describe('explaining a highlight', () => {
  it('explains the passage the annotation quoted', async () => {
    await resetAllowance();
    reply = () => said('Both reactions carry on; the rates simply match.');
    const list = await api(alice, { method: 'GET', url: `/api/pdfs/${pdfId}/annotations` });
    const annotationId = list.json().annotations[0].id;

    const res = await api(alice, {
      method: 'POST',
      url: '/api/ai/explain',
      payload: { fileId: pdfId, annotationId },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.json().answer, /rates simply match/);
    assert.match(res.json().passage, /Dynamic equilibrium/);
    const prompt = userPrompt(calls[0]!);
    assert.match(prompt, /page 2 of/i);
  });

  it('refuses a request that names neither text nor a highlight', async () => {
    await resetAllowance();
    const res = await api(alice, { method: 'POST', url: '/api/ai/explain', payload: { question: 'why?' } });
    assert.equal(res.statusCode, 422);
    assert.equal(calls.length, 0);
  });
});

describe('a revision plan', () => {
  const inDays = (n: number) => Date.now() + n * 24 * 60 * 60 * 1000;

  it('spaces the sessions out itself, and writes nothing unless asked', async () => {
    await resetAllowance();
    reply = () => said(JSON.stringify([
      { title: 'Rates and catalysts', focus: 'Recall the definitions.' },
      { title: 'Equilibria', focus: 'Past paper questions.' },
      { title: 'Review of rates', focus: 'Blank-page recall.' },
    ]));

    const res = await api(alice, {
      method: 'POST',
      url: '/api/ai/revision-plan',
      payload: { examTitle: 'Chemistry Paper 2', examAt: inDays(21), syllabus: 'Rates. Equilibria.' },
    });

    assert.equal(res.statusCode, 200);
    const sessions = res.json().sessions as Array<{ startsAt: number; endsAt: number; title: string }>;
    assert.equal(sessions.length, 3);
    assert.equal(res.json().created, 0);

    // In order, in the future, and every one of them before the exam.
    for (let i = 1; i < sessions.length; i += 1) {
      assert.ok(sessions[i]!.startsAt > sessions[i - 1]!.startsAt, 'sessions run forwards');
    }
    assert.ok(sessions[sessions.length - 1]!.startsAt < inDays(21), 'the last one is before the exam');
    assert.equal(sessions[0]!.endsAt - sessions[0]!.startsAt, 45 * 60 * 1000);

    const events = await api(alice, { method: 'GET', url: '/api/events', query: { kinds: 'study_block' } });
    assert.ok(!events.json().events.some((e: { title: string }) => e.title === 'Equilibria'));
  });

  it('puts the blocks in the calendar when asked to', async () => {
    await resetAllowance();
    reply = () => said('[{"title":"Organic mechanisms","focus":"Draw them from memory."}]');
    const res = await api(alice, {
      method: 'POST',
      url: '/api/ai/revision-plan',
      payload: { examTitle: 'Chemistry Paper 3', examAt: inDays(10), commit: true },
    });
    assert.equal(res.json().created, 1);

    const events = await api(alice, { method: 'GET', url: '/api/events', query: { kinds: 'study_block' } });
    const made = events.json().events.find((e: { title: string }) => e.title === 'Organic mechanisms');
    assert.ok(made, 'the study block reached the calendar');
    assert.equal(made.kind, 'study_block');
  });

  it('will not plan for an exam that has already happened', async () => {
    await resetAllowance();
    const res = await api(alice, {
      method: 'POST',
      url: '/api/ai/revision-plan',
      payload: { examTitle: 'Last year', examAt: Date.now() - 1000 },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0);
  });
});

describe('the month’s allowance', () => {
  it('stops at the cap, and says when it lifts', async () => {
    await resetAllowance();
    reply = () => said('[{"front":"q","back":"a"}]');

    const ask = () => api(alice, {
      method: 'POST',
      url: '/api/ai/cards',
      payload: { deckId, source: { from: 'text', text: 'Anything at all.' } },
    });

    for (let i = 0; i < 6; i += 1) assert.equal((await ask()).statusCode, 200);

    const refused = await ask();
    assert.equal(refused.statusCode, 402);
    assert.match(refused.json().error.message, /all 6 AI requests/);
    assert.equal(calls.length, 6, 'the refused request never reached the model');
  });

  it('gives the request back when the model could not be reached at all', async () => {
    await resetAllowance();
    reply = () => { throw new Error('connect ECONNREFUSED'); };

    const res = await api(alice, {
      method: 'POST',
      url: '/api/ai/cards',
      payload: { deckId, source: { from: 'text', text: 'Anything at all.' } },
    });
    assert.equal(res.statusCode, 502);

    const status = await api(alice, { method: 'GET', url: '/api/ai/status' });
    assert.equal(status.json().usage.used, 0);
  });

  it('keeps the request when the model answered and charged for it', async () => {
    await resetAllowance();
    reply = () => ({ status: 400, json: { error: { message: 'too many tokens' } } });

    const res = await api(alice, {
      method: 'POST',
      url: '/api/ai/cards',
      payload: { deckId, source: { from: 'text', text: 'Anything at all.' } },
    });
    assert.equal(res.statusCode, 400);

    const status = await api(alice, { method: 'GET', url: '/api/ai/status' });
    assert.equal(status.json().usage.used, 1);
  });
});

describe('roles and the backup model', () => {
  it('sends each feature to the model behind its role', async () => {
    await resetAllowance();
    reply = () => said('[{"front":"q","back":"a"}]');
    await api(alice, { method: 'POST', url: '/api/ai/cards', payload: { deckId, source: { from: 'text', text: 'Anything.' } } });
    assert.equal(calls[0]!.model, config.ai.models.writer.primary);
    assert.deepEqual(generation(calls[0]!).thinkingConfig, { thinkingBudget: 512 }, 'the reasoning model is given more room to think');

    calls = [];
    reply = () => said('[{"title":"Rates","focus":"Recall."}]');
    await api(alice, {
      method: 'POST',
      url: '/api/ai/revision-plan',
      payload: { examTitle: 'Chemistry', examAt: Date.now() + 9 * 24 * 60 * 60 * 1000 },
    });
    assert.equal(calls[0]!.model, config.ai.models.checker.primary);
  });

  it('asks the backup when the first choice is rate-limited, and logs both', async () => {
    await resetAllowance();
    reply = (call) => call.model === config.ai.models.writer.primary
      ? { status: 429, json: { error: { code: 429, message: 'rate limited upstream' } } }
      : said('[{"front":"from the backup","back":"a"}]');

    const res = await api(alice, {
      method: 'POST',
      url: '/api/ai/cards',
      payload: { deckId, source: { from: 'text', text: 'Anything.' }, commit: false },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().cards[0].front, 'from the backup');
    assert.deepEqual(calls.map((c) => c.model), [config.ai.models.writer.primary, config.ai.models.writer.backup]);

    const log = (await api(alice, { method: 'GET', url: '/api/ai/calls' })).json().calls as Array<{ ok: boolean; status: number; feature: string }>;
    assert.equal(log.length, 2);
    assert.deepEqual(log.map((c) => c.ok).sort(), [false, true]);
    assert.ok(log.every((c) => c.feature === 'cards'));
  });

  it('believes an error inside a 200', async () => {
    await resetAllowance();
    reply = () => ({ json: { error: { code: 502, message: 'provider down' } } });
    const res = await api(alice, {
      method: 'POST',
      url: '/api/ai/cards',
      payload: { deckId, source: { from: 'text', text: 'Anything.' } },
    });
    assert.equal(res.statusCode, 502);
    // The backup is tried, then every other configured model: a whole
    // provider being down is exactly when one elsewhere is worth asking.
    assert.equal(calls.length, new Set(Object.values(config.ai.models).flatMap((r) => [r.primary, r.backup])).size, 'every model was tried');
    const status = await api(alice, { method: 'GET', url: '/api/ai/status' });
    assert.equal(status.json().usage.used, 0, 'nothing answered, so nothing is spent');
  });

  it('asks once more when the answer does not parse', async () => {
    await resetAllowance();
    let n = 0;
    reply = () => (n++ === 0 ? said('Sure! Here you go: front: q') : said('[{"front":"second try","back":"a"}]'));
    const res = await api(alice, {
      method: 'POST',
      url: '/api/ai/cards',
      payload: { deckId, source: { from: 'text', text: 'Anything.' }, commit: false },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().cards[0].front, 'second try');
    assert.match(userPrompt(calls[1]!), /could not be used/);
  });

  it('reports a cut-off answer rather than half of one', async () => {
    await resetAllowance();
    reply = () => said('[{"front":"q","ba', 'MAX_TOKENS');
    const res = await api(alice, {
      method: 'POST',
      url: '/api/ai/explain',
      payload: { text: 'A long passage.' },
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error.message, /longer than the space/);
  });

  it('reads an object wrapping a single list as that list', () => {
    assert.equal(extractJsonArray('{"questions":[1,2,3]}').length, 3);
    assert.deepEqual(extractJsonObject('<think>hmm</think>```json\n{"a":1}\n```'), { a: 1 });
  });
});

describe('importing a specification', () => {
  const pages = [
    { page: 1, text: 'Contents\nUnit 1 Biological molecules .......... 5' },
    { page: 5, text: 'Unit 1 Biological molecules\n1.1 Monomers and polymers\n1.2 Carbohydrates\n1.3 Lipids' },
    { page: 6, text: '1.4 Proteins\n1.4.1 Enzyme action\nAssessment objectives are described in section 9.' },
  ];

  it('proposes topics grouped by unit, with where they came from, and saves nothing', async () => {
    await resetAllowance();
    reply = (call) => {
      if (call.model === config.ai.models.reader.primary) {
        return said(JSON.stringify({
          units: [{
            unit: 'Unit 1 Biological molecules',
            topics: [
              { ref: '1.1', name: 'Monomers and polymers', page: 5 },
              { ref: '1.2', name: 'Carbohydrates', page: 5 },
              { ref: '1.2', name: 'Carbohydrates', page: 5 },
              { ref: '1.4.1', name: 'Enzyme action', page: 99 },
            ],
          }],
        }));
      }
      return said(JSON.stringify({ flags: [{ index: 1, issue: 'unclear', note: 'too broad?' }, { index: 40, issue: 'duplicate' }] }));
    };

    const before = (await api(alice, { method: 'GET', url: '/api/topics' })).json().topics.length;
    const res = await api(alice, {
      method: 'POST',
      url: '/api/ai/spec/unpack',
      payload: { fileName: 'biology-spec.pdf', pages },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();

    assert.equal(calls[0]!.model, config.ai.models.reader.primary);
    assert.deepEqual(generation(calls[0]!).thinkingConfig, { thinkingBudget: /pro/.test(config.ai.models.reader.primary) ? 2048 : 512 });
    assert.match(userPrompt(calls[0]!), /\[\[page 5\]\]/);

    assert.equal(body.units.length, 1);
    const topics = body.units[0].topics as Array<{ ref: string; name: string; page: number | null; flags: unknown[] }>;
    assert.equal(topics.length, 3, 'the repeated topic is folded');
    assert.equal(topics[2]!.page, null, 'a page outside what the Reader was shown is dropped');
    assert.equal(topics[1]!.flags.length, 1, 'the Checker flag lands on the item it named');
    assert.equal(body.checked, true);

    // 1.3 and 1.4 are plainly in the document and were not extracted; 1.4 is
    // covered by 1.4.1, so only 1.3 is missing.
    assert.deepEqual(body.missing.map((m: { ref: string }) => m.ref), ['1.3']);

    const after = (await api(alice, { method: 'GET', url: '/api/topics' })).json().topics.length;
    assert.equal(after, before);

    const status = await api(alice, { method: 'GET', url: '/api/ai/status' });
    assert.equal(status.json().usage.used, 5, 'a specification counts as five');
  });

  it('keeps the list when the check fails', async () => {
    await resetAllowance();
    reply = (call) => call.model === config.ai.models.reader.primary
      ? said('{"units":[{"unit":"Unit 1","topics":[{"ref":"1.1","name":"Monomers","page":5}]}]}')
      : { status: 500, json: { error: { message: 'down' } } };
    const res = await api(alice, { method: 'POST', url: '/api/ai/spec/unpack', payload: { fileName: 's.pdf', pages } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().checked, false);
    assert.equal(res.json().units[0].topics.length, 1);
  });

  it('refuses a file with no text in it before asking anyone', async () => {
    await resetAllowance();
    const res = await api(alice, {
      method: 'POST',
      url: '/api/ai/spec/unpack',
      payload: { fileName: 'scan.pdf', pages: [{ page: 1, text: '' }] },
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error.message, /no text/);
    assert.equal(calls.length, 0);
  });

  it('imports the reviewed list with references and pages', async () => {
    const res = await api(alice, {
      method: 'POST',
      url: '/api/topics/import',
      payload: { unit: 'Unit 1', names: [{ name: 'Lipids', ref: '1.3', page: 5 }, 'Proteins'] },
    });
    assert.equal(res.statusCode, 201);
    const created = res.json().created as Array<{ name: string; spec_ref: string | null; spec_page: number | null }>;
    assert.deepEqual(created.map((t) => [t.name, t.spec_ref, t.spec_page]), [['Lipids', '1.3', 5], ['Proteins', null, null]]);
  });
});

describe('a quiz', () => {
  it('parses, drops broken questions, and does not always put the answer first', async () => {
    await resetAllowance();
    const good = { question: 'What does a catalyst lower?', options: ['Activation energy', 'Enthalpy', 'Temperature', 'Pressure'], answer: 0, explanation: 'It offers another route.' };
    reply = () => said(JSON.stringify({
      questions: [
        good,
        { question: 'Answer out of range', options: ['a', 'b'], answer: 5 },
        { question: 'Same option twice', options: ['a', 'a'], answer: 0 },
      ],
    }));
    const res = await api(alice, {
      method: 'POST',
      url: '/api/ai/quiz',
      payload: { source: { from: 'document', fileId: docId }, count: 5 },
    });
    assert.equal(res.statusCode, 200, res.body);
    const questions = res.json().questions as Array<{ options: string[]; answer: number }>;
    assert.equal(questions.length, 1);
    assert.equal(questions[0]!.options[questions[0]!.answer], 'Activation energy', 'the answer follows its option');
    assert.equal(calls[0]!.model, config.ai.models.writer.primary);
  });

  it('writes true/false and short-answer quizzes, and marks written answers', async () => {
    await resetAllowance();
    reply = () => said('{"questions":[{"question":"Catalysts are used up.","answer":false,"explanation":"They are regenerated."},{"question":"Broken","answer":"maybe"}]}');
    let res = await api(alice, { method: 'POST', url: '/api/ai/quiz', payload: { source: { from: 'text', text: 'Catalysts are not used up.' }, mode: 'truefalse' } });
    assert.equal(res.statusCode, 200, res.body);
    let questions = res.json().questions as Array<{ options: string[]; answer: number }>;
    assert.equal(questions.length, 1);
    assert.deepEqual(questions[0]!.options, ['True', 'False']);
    assert.equal(questions[0]!.answer, 1);

    reply = () => said('{"questions":[{"question":"What does a catalyst lower?","answer":"Activation energy"}]}');
    res = await api(alice, { method: 'POST', url: '/api/ai/quiz', payload: { source: { from: 'text', text: 'Catalysts lower activation energy.' }, mode: 'short' } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().questions[0].model_answer, 'Activation energy');

    reply = () => said('{"results":[{"score":1,"correct":true,"feedback":"Right."}]}');
    res = await api(alice, { method: 'POST', url: '/api/ai/quiz/mark', payload: { answers: [
      { question: 'What does a catalyst lower?', expected: 'Activation energy', given: 'the activation energy' },
      { question: 'Second', expected: 'x', given: '  ' },
    ] } });
    assert.equal(res.statusCode, 200, res.body);
    const results = res.json().results as Array<{ correct: boolean }>;
    assert.deepEqual(results.map((r) => r.correct), [true, false]);
  });

  it('quizzes a topic from its name and notes', async () => {
    await resetAllowance();
    const topic = (await api(alice, { method: 'POST', url: '/api/topics', payload: { name: 'Le Chatelier', notes: 'Position shifts to oppose change.' } })).json().topic;
    reply = () => said('[{"question":"q?","options":["a","b"],"answer":1,"explanation":"e"}]');
    const res = await api(alice, { method: 'POST', url: '/api/ai/quiz', payload: { topicId: topic.id } });
    assert.equal(res.statusCode, 200);
    assert.match(userPrompt(calls[0]!), /oppose change/);
  });

  it('will not quiz a topic belonging to somebody else', async () => {
    await resetAllowance();
    const bob = await registerUser('Bobby');
    const topic = (await api(alice, { method: 'POST', url: '/api/topics', payload: { name: 'Private' } })).json().topic;
    const res = await api(bob, { method: 'POST', url: '/api/ai/quiz', payload: { topicId: topic.id } });
    assert.equal(res.statusCode, 404);
    assert.equal(calls.length, 0);
  });
});

describe('duplicate topics', () => {
  it('maps the groups back to ids, ignoring anything invalid, and merges on request', async () => {
    await resetAllowance();
    const carol = await registerUser('Carol');
    const make = async (name: string, extra: Record<string, unknown> = {}) =>
      (await api(carol, { method: 'POST', url: '/api/topics', payload: { name, ...extra } })).json().topic;
    const a = await make('Enzyme inhibition', { notes: 'Competitive vs non-competitive.' });
    const b = await make('Inhibition of enzymes', { notes: 'End-product inhibition.' });
    await make('Photosynthesis');
    await api(carol, { method: 'POST', url: `/api/topics/${b.id}/rate`, payload: { confidence: 3 } });

    reply = () => said(JSON.stringify({
      groups: [
        { keep: 0, merge: [1], reason: 'same content' },
        { keep: 2, merge: [0], reason: 'reuses 0' },
        { keep: 9, merge: [1] },
      ],
    }));
    const res = await api(carol, { method: 'POST', url: '/api/ai/topics/dedupe', payload: {} });
    assert.equal(res.statusCode, 200, res.body);
    const groups = res.json().groups as Array<{ keep: { id: string }; merge: Array<{ id: string }> }>;
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.keep.id, a.id);
    assert.deepEqual(groups[0]!.merge.map((m) => m.id), [b.id]);
    assert.equal(calls[0]!.model, config.ai.models.checker.primary);

    const merged = await api(carol, { method: 'POST', url: '/api/topics/merge', payload: { keepId: a.id, mergeIds: [b.id] } });
    assert.equal(merged.statusCode, 200);
    assert.equal(merged.json().merged, 1);
    assert.equal(merged.json().topic.confidence, 3, 'the kept topic takes the rating it did not have');
    assert.match(merged.json().topic.notes, /End-product/);
    const left = (await api(carol, { method: 'GET', url: '/api/topics' })).json().topics as Array<{ id: string }>;
    assert.ok(!left.some((t) => t.id === b.id));
  });

  it('will not merge a topic belonging to somebody else', async () => {
    const dan = await registerUser('Dan');
    const mine = (await api(dan, { method: 'POST', url: '/api/topics', payload: { name: 'Mine' } })).json().topic;
    const theirs = (await api(alice, { method: 'POST', url: '/api/topics', payload: { name: 'Theirs' } })).json().topic;
    const res = await api(dan, { method: 'POST', url: '/api/topics/merge', payload: { keepId: mine.id, mergeIds: [theirs.id] } });
    assert.equal(res.statusCode, 404);
  });
});

describe('the key', () => {
  const keyFile = () => path.join(path.dirname(config.databasePath), 'gemini.key');

  it('says where the key came from without ever saying the key', async () => {
    const res = await api(alice, { method: 'GET', url: '/api/ai/status' });
    assert.equal(res.json().keySource, 'env');
    assert.equal(res.json().keyHint, '…-key');
    assert.ok(!res.body.includes('not-a-real-key'));
    assert.equal(res.json().models.reader.primary, 'gemini-flash-latest');
  });

  it('will not let Settings override a key set in the environment', async () => {
    const res = await api(alice, { method: 'PUT', url: '/api/ai/key', payload: { key: 'AIzaSyabcdefghijklmnopqrstuvwxyz', verify: false } });
    assert.equal(res.statusCode, 400);
  });

  it('saves a pasted key to a private file, uses it at once, and removes it', async () => {
    const envKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      await resetAllowance();
      let status = (await api(alice, { method: 'GET', url: '/api/ai/status' })).json();
      assert.equal(status.available, false);
      assert.equal(status.keySet, false);

      reply = () => said('[{"front":"q","back":"a"}]');
      const blocked = await api(alice, { method: 'POST', url: '/api/ai/cards', payload: { deckId, source: { from: 'text', text: 'x' } } });
      assert.equal(blocked.statusCode, 400);
      assert.match(blocked.json().error.message, /Settings → AI/);

      const saved = await api(alice, { method: 'PUT', url: '/api/ai/key', payload: { key: 'AIzaSyabcdefghijklmnopqrstuvwxyz', verify: false } });
      assert.equal(saved.statusCode, 200, saved.body);
      assert.equal(saved.json().keyHint, '…wxyz');
      assert.ok(!saved.body.includes('abcdefghij'));
      assert.equal(fs.statSync(keyFile()).mode & 0o777, 0o600);

      status = (await api(alice, { method: 'GET', url: '/api/ai/status' })).json();
      assert.equal(status.available, true);
      assert.equal(status.keySource, 'settings');
      assert.equal(status.usage.limit, 1000, 'the owner’s own key is not rationed like a shared one');

      await api(alice, { method: 'POST', url: '/api/ai/cards', payload: { deckId, source: { from: 'text', text: 'x' }, commit: false } });
      assert.equal(calls.length, 1);

      const removed = await api(alice, { method: 'DELETE', url: '/api/ai/key' });
      assert.equal(removed.json().keySet, false);
      assert.ok(!fs.existsSync(keyFile()));
    } finally {
      process.env.GEMINI_API_KEY = envKey;
    }
  });

  it('checks a key with Google AI Studio before keeping it', async () => {
    const envKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      reply = () => ({ status: 400, json: { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } } });
      const res = await api(alice, { method: 'PUT', url: '/api/ai/key', payload: { key: 'AIzaSywrongwrongwrongwrongwrong' } });
      assert.equal(res.statusCode, 400);
      assert.match(res.json().error.message, /did not accept/);
      assert.match(calls[0]!.url, /\/v1beta\/models\?/);
      assert.ok(!fs.existsSync(keyFile()));
    } finally {
      process.env.GEMINI_API_KEY = envKey;
    }
  });
});

describe('chat', () => {
  it('answers with the open note in front of the model, and keeps the conversation in order', async () => {
    await resetAllowance();
    reply = () => said('A catalyst gives the reaction an easier route.');
    const res = await api(alice, {
      method: 'POST',
      url: '/api/ai/chat',
      payload: {
        messages: [
          { role: 'user', content: 'What is this note about?' },
          { role: 'assistant', content: 'Rates of reaction.' },
          { role: 'user', content: 'What does a catalyst do?' },
        ],
        context: { route: 'doc', fileId: docId },
      },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().answer, 'A catalyst gives the reaction an easier route.');
    assert.equal(res.json().context, '“Rates of reaction”');

    assert.deepEqual(turns(calls[0]!).map((m) => m.role), ['user', 'model', 'user']);
    assert.match(systemOf(calls[0]!), /activation energy/);
    assert.equal(userPrompt(calls[0]!), 'What does a catalyst do?');
    assert.equal(calls[0]!.model, config.ai.models.writer.primary);

    const log = (await api(alice, { method: 'GET', url: '/api/ai/calls' })).json().calls as Array<{ feature: string }>;
    assert.equal(log[0]!.feature, 'chat');
  });

  it('refuses a conversation that does not end with a question', async () => {
    const res = await api(alice, {
      method: 'POST',
      url: '/api/ai/chat',
      payload: { messages: [{ role: 'assistant', content: 'Hello.' }] },
    });
    assert.equal(res.statusCode, 422);
    assert.equal(calls.length, 0);
  });

  it('does not read a file the account does not own', async () => {
    await resetAllowance();
    const bob = await registerUser('Bea');
    reply = () => said('I cannot see any material.');
    const res = await api(bob, {
      method: 'POST',
      url: '/api/ai/chat',
      payload: { messages: [{ role: 'user', content: 'Summarise this.' }], context: { fileId: docId } },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().context, null);
    const system = systemOf(calls[0]!);
    assert.doesNotMatch(system, /activation energy/);
  });
});

describe('chat history', () => {
  it('keeps a conversation, carries it on under the same id, and lists it', async () => {
    await resetAllowance();
    reply = () => said('Try recalling what a catalyst changes. **Your turn:** name one.');
    const first = await api(alice, {
      method: 'POST',
      url: '/api/ai/chat',
      payload: { messages: [{ role: 'user', content: 'Quiz me on catalysts' }] },
    });
    assert.equal(first.statusCode, 200, first.body);
    const chatId = first.json().chatId as string;
    assert.ok(chatId);

    const second = await api(alice, {
      method: 'POST',
      url: '/api/ai/chat',
      payload: {
        chatId,
        messages: [
          { role: 'user', content: 'Quiz me on catalysts' },
          { role: 'assistant', content: first.json().answer },
          { role: 'user', content: 'Activation energy' },
        ],
      },
    });
    assert.equal(second.json().chatId, chatId);

    const list = (await api(alice, { method: 'GET', url: '/api/ai/chats' })).json().chats as Array<{ id: string; title: string; turns: number }>;
    const kept = list.find((c) => c.id === chatId)!;
    assert.equal(kept.title, 'Quiz me on catalysts');
    assert.equal(kept.turns, 4);

    const one = (await api(alice, { method: 'GET', url: `/api/ai/chats/${chatId}` })).json();
    assert.deepEqual(one.chat.messages.map((m: { role: string }) => m.role), ['user', 'assistant', 'user', 'assistant']);
  });

  it('keeps each account’s chats to itself, and deletes them', async () => {
    await resetAllowance();
    reply = () => said('Hint 1: think about energy.');
    const res = await api(alice, { method: 'POST', url: '/api/ai/chat', payload: { messages: [{ role: 'user', content: 'Help' }] } });
    const chatId = res.json().chatId as string;

    const bob = await registerUser('Bram');
    assert.equal((await api(bob, { method: 'GET', url: `/api/ai/chats/${chatId}` })).statusCode, 404);
    assert.equal((await api(bob, { method: 'GET', url: '/api/ai/chats' })).json().chats.length, 0);
    assert.equal((await api(bob, { method: 'DELETE', url: `/api/ai/chats/${chatId}` })).statusCode, 404);

    assert.equal((await api(alice, { method: 'DELETE', url: `/api/ai/chats/${chatId}` })).statusCode, 204);
    assert.equal((await api(alice, { method: 'GET', url: `/api/ai/chats/${chatId}` })).statusCode, 404);

    assert.equal((await api(alice, { method: 'DELETE', url: '/api/ai/chats' })).statusCode, 204);
    assert.equal((await api(alice, { method: 'GET', url: '/api/ai/chats' })).json().chats.length, 0);
  });
});
