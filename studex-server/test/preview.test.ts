import './setup.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  api,
  closeApp,
  getApp,
  multipartBody,
  registerUser,
  samplePdfWithPages,
  uuid,
  type Client,
} from './helpers.js';

let alice: Client;
let bob: Client;

before(async () => {
  await getApp();
  alice = await registerUser('Preview Student');
  bob = await registerUser('Nosy Neighbour');
});

after(async () => {
  await closeApp();
});

async function newFile(client: Client, title: string, kind: string): Promise<string> {
  const res = await api(client, { method: 'POST', url: '/api/files', payload: { title, kind } });
  assert.equal(res.statusCode, 201);
  return res.json().file.id;
}

/* -------------------------------------------------------------------------- */

describe('file preview', () => {
  it('reads the opening lines of a document, with their shape kept', async () => {
    const fileId = await newFile(alice, 'Rates of reaction', 'doc');
    await api(alice, {
      method: 'PUT',
      url: `/api/documents/${fileId}`,
      payload: {
        blocks: [
          { id: uuid(), type: 'heading', level: 2, text: 'Collision theory' },
          { id: uuid(), type: 'paragraph', text: 'A reaction happens when **particles** collide hard enough.' },
          { id: uuid(), type: 'bullet', text: 'Higher temperature, faster particles', indent: 1 },
          { id: uuid(), type: 'todo', text: 'Learn the Maxwell-Boltzmann curve', done: true },
        ],
      },
    });

    const res = await api(alice, { method: 'GET', url: `/api/files/${fileId}/preview` });
    assert.equal(res.statusCode, 200);
    const preview = res.json();

    assert.equal(preview.file.id, fileId);
    assert.equal(preview.file.kind, 'doc');
    assert.equal(preview.doc.blocks, 4);
    assert.equal(preview.doc.truncated, false);
    assert.ok(preview.doc.words > 0);
    assert.deepEqual(
      preview.doc.lines.map((l: { type: string }) => l.type),
      ['heading', 'paragraph', 'bullet', 'todo'],
    );
    assert.equal(preview.doc.lines[0].level, 2);
    assert.equal(preview.doc.lines[2].indent, 1);
    assert.equal(preview.doc.lines[3].done, true);
    // The glance is plain text: inline marks are for the editor, not a thumbnail.
    assert.equal(
      preview.doc.lines[1].text,
      'A reaction happens when particles collide hard enough.',
    );
    // Nothing else comes back — a doc preview carries no deck or canvas.
    assert.equal(preview.deck, undefined);
    assert.equal(preview.canvas, undefined);
  });

  it('stops reading a long document once it has enough to show', async () => {
    const fileId = await newFile(alice, 'Whole of paper 1', 'doc');
    const blocks = Array.from({ length: 60 }, (_, i) => ({
      id: uuid(),
      type: 'paragraph',
      text: `Point number ${i + 1}`,
    }));
    await api(alice, { method: 'PUT', url: `/api/documents/${fileId}`, payload: { blocks } });

    const preview = (await api(alice, { method: 'GET', url: `/api/files/${fileId}/preview` })).json();
    assert.equal(preview.doc.blocks, 60);
    assert.equal(preview.doc.truncated, true);
    assert.ok(preview.doc.lines.length < 20, 'a long note costs no more than a short one');
    assert.equal(preview.doc.lines[0].text, 'Point number 1');
  });

  it('shows the first cards of a deck beside how it is going', async () => {
    const deckId = await newFile(alice, 'Equilibrium', 'deck');
    for (const [front, back] of [
      ['Le Chatelier', 'A system opposes a change made to it'],
      ['Kc', 'Products over reactants, each to its power'],
    ]) {
      const res = await api(alice, {
        method: 'POST',
        url: '/api/cards',
        payload: { deckId, front, back },
      });
      assert.equal(res.statusCode, 201);
    }

    const preview = (await api(alice, { method: 'GET', url: `/api/files/${deckId}/preview` })).json();
    assert.equal(preview.deck.total, 2);
    assert.equal(preview.deck.new, 2);
    assert.equal(preview.deck.cards.length, 2);
    assert.equal(preview.deck.cards[0].front, 'Le Chatelier');
    assert.equal(preview.deck.cards[0].back, 'A system opposes a change made to it');
    assert.equal(typeof preview.deck.due, 'number');
  });

  it('shows a PDF by its length and what was highlighted in it', async () => {
    const body = multipartBody(
      { title: 'Paper 2 2023' },
      {
        field: 'file',
        filename: 'paper2.pdf',
        contentType: 'application/pdf',
        content: samplePdfWithPages(9),
      },
    );
    const upload = await api(alice, {
      method: 'POST',
      url: '/api/pdfs',
      payload: body.payload,
      headers: body.headers,
    });
    assert.equal(upload.statusCode, 201);
    const fileId = upload.json().fileId;

    await api(alice, {
      method: 'POST',
      url: `/api/pdfs/${fileId}/annotations`,
      payload: {
        page: 3,
        kind: 'highlight',
        geometry: { kind: 'quads', quads: [{ x: 80, y: 220, width: 340, height: 16 }] },
        quotedText: 'state and explain the effect of increasing pressure',
        note: 'Mark is for the shift, not the rate.',
      },
    });
    // A pin with no quotation still counts, and still carries its note.
    await api(alice, {
      method: 'POST',
      url: `/api/pdfs/${fileId}/annotations`,
      payload: { page: 4, kind: 'comment', geometry: { kind: 'point', x: 100, y: 100 }, note: 'Redo this one.' },
    });

    const preview = (await api(alice, { method: 'GET', url: `/api/files/${fileId}/preview` })).json();
    assert.equal(preview.pdf.page_count, 9);
    assert.equal(preview.pdf.annotations, 2);
    assert.equal(preview.pdf.original_name, 'paper2.pdf');
    assert.equal(preview.pdf.highlights.length, 2);
    assert.equal(preview.pdf.highlights[0].page, 3);
    assert.match(preview.pdf.highlights[0].quote, /increasing pressure/);
    assert.equal(preview.pdf.highlights[0].note, 'Mark is for the shift, not the rate.');
  });

  it('measures a canvas and hands back enough of it to draw a miniature', async () => {
    const canvasId = await newFile(alice, 'Equilibrium map', 'canvas');
    const a = uuid();
    const b = uuid();
    const saved = await api(alice, {
      method: 'PUT',
      url: `/api/canvases/${canvasId}`,
      payload: {
        objects: [
          { id: a, type: 'note', x: 0, y: 0, width: 200, height: 100, text: 'Dynamic equilibrium' },
          { id: b, type: 'note', x: 300, y: 40, width: 200, height: 100, text: 'Le Chatelier' },
          { id: uuid(), type: 'connector', x: 0, y: 0, fromId: a, toId: b },
          {
            id: uuid(),
            type: 'ink',
            x: 0,
            y: 0,
            points: Array.from({ length: 200 }, (_, i) => [i, i % 40, 0.5]),
          },
        ],
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    });
    assert.equal(saved.statusCode, 200);

    const preview = (await api(alice, { method: 'GET', url: `/api/files/${canvasId}/preview` })).json();
    assert.equal(preview.canvas.objects, 4);
    assert.equal(preview.canvas.ink_strokes, 1);
    assert.equal(preview.canvas.background, 'dots');
    assert.deepEqual(preview.canvas.bounds, { x: 0, y: 0, width: 500, height: 140 });

    const types = preview.canvas.shapes.map((s: { type: string }) => s.type);
    assert.deepEqual(types.sort(), ['ink', 'note', 'note']);
    // A connector's ends are other objects, so it is counted and not drawn.
    assert.ok(!types.includes('connector'));

    const ink = preview.canvas.shapes.find((s: { type: string }) => s.type === 'ink');
    assert.ok(ink.points.length >= 2 && ink.points.length <= 20, 'a long stroke is thinned');
    assert.deepEqual(ink.points[0], [0, 0]);

    const note = preview.canvas.shapes.find((s: { type: string }) => s.type === 'note');
    assert.equal(note.width, 200);
    assert.equal(note.text, 'Dynamic equilibrium');
  });

  it('gives an empty canvas no bounds to draw into', async () => {
    const canvasId = await newFile(alice, 'Blank', 'canvas');
    const preview = (await api(alice, { method: 'GET', url: `/api/files/${canvasId}/preview` })).json();
    assert.equal(preview.canvas.objects, 0);
    assert.equal(preview.canvas.bounds, null);
    assert.deepEqual(preview.canvas.shapes, []);
    assert.equal(preview.canvas.truncated, false);
  });

  it("will not preview another user's file", async () => {
    const fileId = await newFile(alice, 'Private revision', 'doc');
    const res = await api(bob, { method: 'GET', url: `/api/files/${fileId}/preview` });
    assert.equal(res.statusCode, 404);
  });
});
