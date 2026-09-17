import './setup.js';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { after, before, describe, it } from 'node:test';
import { api, closeApp, getApp, multipartBody, registerUser, samplePdf, uuid, type Client } from './helpers.js';

let alice: Client;
let bob: Client;
let archive: Map<string, Buffer>;

/**
 * A zip reader, in the test only.
 *
 * The point of the export is that somebody else's program can open it, so the
 * test reads the bytes the way one would rather than asking the writer what it
 * meant. It walks the central directory, which is where an unarchiver starts.
 */
function readZip(buf: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.notEqual(eocd, -1, 'no end-of-central-directory record');

  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();

  for (let n = 0; n < count; n += 1) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50, 'bad central directory header');
    const method = buf.readUInt16LE(at + 10);
    const compressedSize = buf.readUInt32LE(at + 20);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const offset = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLength).toString('utf8');

    assert.equal(buf.readUInt32LE(offset), 0x04034b50, `bad local header for ${name}`);
    const localName = buf.readUInt16LE(offset + 26);
    const localExtra = buf.readUInt16LE(offset + 28);
    const start = offset + 30 + localName + localExtra;
    const raw = buf.subarray(start, start + compressedSize);

    out.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

before(async () => {
  await getApp();
  alice = await registerUser('Export Student');
  bob = await registerUser('Nobody Else');

  const folder = (
    await api(alice, { method: 'POST', url: '/api/folders', payload: { name: 'Chemistry' } })
  ).json().folder.id;

  const doc = (
    await api(alice, {
      method: 'POST',
      url: '/api/files',
      payload: { title: 'Rates of reaction', kind: 'doc', folderId: folder },
    })
  ).json().file.id;

  const canvasFile = (
    await api(alice, {
      method: 'POST',
      url: '/api/files',
      payload: { title: 'Mechanisms', kind: 'canvas', folderId: folder },
    })
  ).json().file.id;

  const deck = (
    await api(alice, { method: 'POST', url: '/api/files', payload: { title: 'Kinetics', kind: 'deck' } })
  ).json().file.id;

  const pdfUpload = multipartBody(
    { title: 'Paper 1', folderId: folder },
    { field: 'file', filename: 'paper-1.pdf', contentType: 'application/pdf', content: samplePdf() },
  );
  const pdfRes = await api(alice, {
    method: 'POST',
    url: '/api/pdfs',
    payload: pdfUpload.payload,
    headers: pdfUpload.headers,
  });
  assert.equal(pdfRes.statusCode, 201);
  const pdfFile = pdfRes.json().fileId;

  await api(alice, {
    method: 'PUT',
    url: `/api/documents/${doc}`,
    payload: {
      blocks: [
        { id: uuid(), type: 'heading', level: 1, text: 'Collision theory' },
        { id: uuid(), type: 'paragraph', text: 'Particles must collide with **enough** energy.' },
        { id: uuid(), type: 'bullet', indent: 0, text: 'Temperature' },
        { id: uuid(), type: 'todo', done: true, text: 'Past paper Q4' },
        { id: uuid(), type: 'table', columns: ['Factor', 'Effect'], rows: [['Heat', 'Faster']] },
        { id: uuid(), type: 'pdf', fileId: pdfFile, page: 3 },
      ],
    },
  });

  const noteId = uuid();
  const cardId = uuid();
  await api(alice, {
    method: 'PUT',
    url: `/api/canvases/${canvasFile}`,
    payload: {
      background: 'squares',
      objects: [
        {
          id: noteId,
          type: 'note',
          x: 0,
          y: 0,
          width: 200,
          height: 120,
          text: 'Activation energy',
          color: 'teal',
        },
        {
          id: cardId,
          type: 'flashcard',
          x: 300,
          y: 0,
          width: 200,
          height: 120,
          front: 'Ea?',
          back: 'Activation energy',
        },
        { id: uuid(), type: 'connector', x: 250, y: 60, fromId: noteId, toId: cardId, label: 'is' },
        {
          id: uuid(),
          type: 'ink',
          x: 0,
          y: 200,
          points: [
            [10, 200, 0.5],
            [90, 260, 0.5],
          ],
          color: 'rose',
        },
      ],
    },
  });

  await api(alice, {
    method: 'POST',
    url: '/api/cards',
    payload: { deckId: deck, front: 'What is Ea?', back: 'Activation energy' },
  });

  const res = await api(alice, { method: 'GET', url: '/api/export' });
  assert.equal(res.statusCode, 200, res.body.slice(0, 200));
  assert.equal(res.headers['content-type'], 'application/zip');
  assert.match(String(res.headers['content-disposition']), /^attachment; filename="studex-export-\d{4}-\d{2}-\d{2}\.zip"$/);
  archive = readZip(res.rawPayload);
});

after(async () => {
  await closeApp();
});

describe('export', () => {
  it('turns away a request with no session', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/api/export' });
    assert.equal(res.statusCode, 401);
  });

  it('writes a readme and the four data files', () => {
    for (const name of ['README.md', 'decks.json', 'calendar.json', 'library.json', 'settings.json']) {
      assert.ok(archive.has(name), `missing ${name}`);
    }
  });

  it('files documents under the folders they were filed in', () => {
    assert.ok(archive.has('Notes/Chemistry/Rates of reaction.md'));
    assert.ok(archive.has('Canvases/Chemistry/Mechanisms.svg'));
    assert.ok(archive.has('Canvases/Chemistry/Mechanisms.json'));
    assert.ok(archive.has('PDFs/Chemistry/Paper 1.pdf'));
  });

  it('writes a document as Markdown, with its links relative to the file', () => {
    const md = archive.get('Notes/Chemistry/Rates of reaction.md')!.toString('utf8');
    assert.match(md, /^# Rates of reaction/);
    assert.match(md, /^## Collision theory$/m);
    assert.match(md, /enough\*\* energy/);
    assert.match(md, /^- Temperature$/m);
    assert.match(md, /^- \[x\] Past paper Q4$/m);
    assert.match(md, /^\| Factor \| Effect \|$/m);
    // Two folders deep, so the link back out to the PDF climbs twice.
    assert.match(md, /\[PDF, page 3\]\(\.\.\/\.\.\/PDFs\/Chemistry\/Paper 1\.pdf\)/);
  });

  it('writes a canvas as an SVG holding what was drawn on it', () => {
    const svg = archive.get('Canvases/Chemistry/Mechanisms.svg')!.toString('utf8');
    assert.match(svg, /^<\?xml version="1\.0"/);
    assert.match(svg, /<title>Mechanisms<\/title>/);
    assert.match(svg, /Activation/);
    assert.match(svg, /<polyline/);
    assert.match(svg, /pattern id="paper"/);
    // The roles are flattened to sRGB, because an SVG has no theme to follow.
    assert.match(svg, /#055959/);

    const objects = JSON.parse(archive.get('Canvases/Chemistry/Mechanisms.json')!.toString('utf8'));
    assert.equal(objects.objects.length, 4);
    assert.equal(objects.background, 'squares');
  });

  it('keeps the PDF byte for byte', () => {
    assert.deepEqual(archive.get('PDFs/Chemistry/Paper 1.pdf'), samplePdf());
  });

  it('writes the decks with their cards and schedule', () => {
    const decks = JSON.parse(archive.get('decks.json')!.toString('utf8'));
    assert.equal(decks.decks.length, 1);
    assert.equal(decks.decks[0].title, 'Kinetics');
    assert.equal(decks.decks[0].cards.length, 1);
    assert.equal(decks.decks[0].cards[0].front, 'What is Ea?');
    assert.ok(typeof decks.decks[0].stats.total === 'number');
  });

  it('describes the library well enough to rebuild its shape', () => {
    const library = JSON.parse(archive.get('library.json')!.toString('utf8'));
    assert.ok(library.folders.some((f: { name: string }) => f.name === 'Chemistry'));
    const doc = library.files.find((f: { kind: string }) => f.kind === 'doc');
    assert.equal(doc.path, 'Notes/Chemistry/Rates of reaction.md');
  });

  it("exports nothing of another student's library", async () => {
    const res = await api(bob, { method: 'GET', url: '/api/export' });
    assert.equal(res.statusCode, 200);
    const theirs = readZip(res.rawPayload);
    assert.ok(!theirs.has('Notes/Chemistry/Rates of reaction.md'));
    assert.equal(JSON.parse(theirs.get('library.json')!.toString('utf8')).files.length, 0);
  });
});
