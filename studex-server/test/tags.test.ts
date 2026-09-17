import './setup.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { api, closeApp, getApp, registerUser, uuid, type Client } from './helpers.js';

let alice: Client;
let bob: Client;

/** Somewhere to hang tags off: a folder, and a document inside it. */
let folderId: string;
let fileId: string;

before(async () => {
  await getApp();
  alice = await registerUser('Aisha K.');
  bob = await registerUser('Someone Else');

  const folder = await api(alice, {
    method: 'POST',
    url: '/api/folders',
    payload: { name: 'Biology' },
  });
  folderId = folder.json().folder.id;

  const file = await api(alice, {
    method: 'POST',
    url: '/api/files',
    payload: { title: 'Photosynthesis', kind: 'doc', folderId },
  });
  fileId = file.json().file.id;
});

after(async () => {
  await closeApp();
});

async function attach(client: Client, payload: Record<string, unknown>) {
  return api(client, { method: 'POST', url: '/api/tags/attach', payload });
}

describe('tags', () => {
  it('creates a tag by attaching a name that does not exist yet', async () => {
    const res = await attach(alice, { name: 'revision', itemType: 'folder', itemId: folderId });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().tag.name, 'revision');
    assert.equal(res.json().tag.key, 'revision');
  });

  it('folds a second spelling into the tag that already exists', async () => {
    const res = await attach(alice, { name: 'REVISION', itemType: 'file', itemId: fileId });
    assert.equal(res.statusCode, 201);

    const list = await api(alice, { method: 'GET', url: '/api/tags' });
    const rows = list.json().tags.filter((t: { key: string }) => t.key === 'revision');
    assert.equal(rows.length, 1, 'one tag, not two spellings of it');
    assert.equal(rows[0].folders, 1);
    assert.equal(rows[0].files, 1);
    assert.equal(rows[0].count, 2);
  });

  it('gathers a folder and a file under one tag', async () => {
    const res = await api(alice, { method: 'GET', url: '/api/tags/by-name/revision' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().folders.map((f: { id: string }) => f.id), [folderId]);
    assert.deepEqual(res.json().files.map((f: { id: string }) => f.id), [fileId]);
  });

  it('finds a tag by a spelling other than the one it was made with', async () => {
    const res = await api(alice, { method: 'GET', url: '/api/tags/by-name/Revision' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().tag.name, 'revision');
  });

  it('answers 404 for a tag that was never written', async () => {
    const res = await api(alice, { method: 'GET', url: '/api/tags/by-name/mitochondria' });
    assert.equal(res.statusCode, 404);
  });

  it('reports what shares a tag with a file, excluding the file itself', async () => {
    const res = await api(alice, { method: 'GET', url: `/api/tags/on/file/${fileId}` });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().tags.map((t: { key: string }) => t.key), ['revision']);
    assert.deepEqual(res.json().related.folders.map((f: { id: string }) => f.id), [folderId]);
    assert.equal(res.json().related.files.length, 0);
  });

  it('refuses a tag with a space in it', async () => {
    const res = await api(alice, {
      method: 'POST',
      url: '/api/tags',
      payload: { name: 'past papers' },
    });
    assert.equal(res.statusCode, 422);
  });

  it('refuses an item type it does not know', async () => {
    const res = await attach(alice, { name: 'x', itemType: 'planet', itemId: folderId });
    assert.equal(res.statusCode, 422);
  });

  it('refuses to tag something belonging to somebody else', async () => {
    const res = await attach(bob, { name: 'stolen', itemType: 'file', itemId: fileId });
    assert.equal(res.statusCode, 404);
  });

  it('keeps one account’s tags out of another’s list', async () => {
    const res = await api(bob, { method: 'GET', url: '/api/tags' });
    assert.deepEqual(res.json().tags, []);
  });

  it('refuses a second tag with a name already taken', async () => {
    const res = await api(alice, { method: 'POST', url: '/api/tags', payload: { name: 'revision' } });
    assert.equal(res.statusCode, 409);
  });

  it('detaches one item without touching the others', async () => {
    const tagId = (await api(alice, { method: 'GET', url: '/api/tags/by-name/revision' })).json()
      .tag.id;

    const gone = await api(alice, {
      method: 'DELETE',
      url: `/api/tags/${tagId}/on/folder/${folderId}`,
    });
    assert.equal(gone.statusCode, 204);

    const after_ = await api(alice, { method: 'GET', url: '/api/tags/by-name/revision' });
    assert.equal(after_.json().folders.length, 0);
    assert.equal(after_.json().files.length, 1);
  });

  it('renames and recolours a tag', async () => {
    const tagId = (await api(alice, { method: 'GET', url: '/api/tags/by-name/revision' })).json()
      .tag.id;

    const res = await api(alice, {
      method: 'PATCH',
      url: `/api/tags/${tagId}`,
      payload: { name: 'Recall', color: 'lime' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().tag.name, 'Recall');
    assert.equal(res.json().tag.key, 'recall', 'the key follows the name so links keep resolving');
    assert.equal(res.json().tag.color, 'lime');
  });

  it('cuts the thread but keeps the documents when a tag is deleted', async () => {
    const tagId = (await api(alice, { method: 'GET', url: '/api/tags/by-name/recall' })).json()
      .tag.id;

    const res = await api(alice, { method: 'DELETE', url: `/api/tags/${tagId}` });
    assert.equal(res.statusCode, 204);

    const file = await api(alice, { method: 'GET', url: `/api/files/${fileId}` });
    assert.equal(file.statusCode, 200, 'the document outlives the tag');

    const on = await api(alice, { method: 'GET', url: `/api/tags/on/file/${fileId}` });
    assert.deepEqual(on.json().tags, []);
  });

  it('rejects an unknown tag id rather than silently doing nothing', async () => {
    const res = await api(alice, { method: 'DELETE', url: `/api/tags/${uuid()}` });
    assert.equal(res.statusCode, 404);
  });
});

describe('tags written into a document', () => {
  let textFile: string;

  before(async () => {
    const created = await api(alice, {
      method: 'POST',
      url: '/api/files',
      payload: { title: 'Rates of reaction', kind: 'doc', folderId },
    });
    textFile = created.json().file.id;
  });

  it('picks up a ##tag typed into the text', async () => {
    const saved = await api(alice, {
      method: 'PUT',
      url: `/api/documents/${textFile}`,
      payload: { blocks: [{ id: uuid(), type: 'paragraph', text: 'Collision theory ##kinetics' }] },
    });
    assert.equal(saved.statusCode, 200);

    const res = await api(alice, { method: 'GET', url: '/api/tags/by-name/kinetics' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().files.map((f: { id: string }) => f.id), [textFile]);
  });

  it('drops a text tag once the words are deleted', async () => {
    await api(alice, {
      method: 'PUT',
      url: `/api/documents/${textFile}`,
      payload: { blocks: [{ id: uuid(), type: 'paragraph', text: 'Collision theory' }] },
    });

    const res = await api(alice, { method: 'GET', url: '/api/tags/by-name/kinetics' });
    assert.equal(res.json().files.length, 0);
  });

  it('leaves a hand-attached tag alone when the text is rewritten', async () => {
    await attach(alice, { name: 'chemistry', itemType: 'file', itemId: textFile });
    await api(alice, {
      method: 'PUT',
      url: `/api/documents/${textFile}`,
      payload: { blocks: [{ id: uuid(), type: 'paragraph', text: 'Nothing about tags here.' }] },
    });

    const res = await api(alice, { method: 'GET', url: `/api/tags/on/file/${textFile}` });
    assert.deepEqual(res.json().tags.map((t: { key: string }) => t.key), ['chemistry']);
  });

  it('forgets a file’s tags when the file is purged', async () => {
    await api(alice, { method: 'POST', url: `/api/files/${textFile}/trash` });
    await api(alice, { method: 'DELETE', url: `/api/files/${textFile}` });

    const res = await api(alice, { method: 'GET', url: '/api/tags/by-name/chemistry' });
    assert.equal(res.json().files.length, 0);
  });

  it('forgets a folder’s tags when the folder is deleted', async () => {
    const folder = (await api(alice, {
      method: 'POST',
      url: '/api/folders',
      payload: { name: 'Temporary' },
    })).json().folder.id;
    await attach(alice, { name: 'scratch', itemType: 'folder', itemId: folder });

    await api(alice, { method: 'DELETE', url: `/api/folders/${folder}` });

    const res = await api(alice, { method: 'GET', url: '/api/tags/by-name/scratch' });
    assert.equal(res.json().folders.length, 0);
  });
});
