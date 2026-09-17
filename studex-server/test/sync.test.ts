import './setup.js';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closeApp, registerUser } from './helpers.js';
import { getDb } from '../src/lib/db.js';
import { createFile, createFolder, purgeFile } from '../src/domain/library.js';
import { saveDocument } from '../src/domain/documents.js';
import { pushLibrary } from '../src/domain/sync.js';
import { fakeRemote } from './fake-remote.js';
import { openSecret, sealSecret } from '../src/lib/crypto.js';

/** A local account standing in for one linked to a Supabase identity. */
async function linkedUser() {
  const client = await registerUser();
  const supabaseUserId = randomUUID();
  getDb().prepare('UPDATE users SET supabase_user_id = ? WHERE id = ?').run(supabaseUserId, client.userId);
  return { userId: client.userId, supabaseUserId };
}

after(async () => {
  await closeApp();
});

describe('pushing a library to Supabase', () => {
  it('sends folders before anything that lives in them', async () => {
    const { userId, supabaseUserId } = await linkedUser();
    const outer = createFolder(userId, { name: 'Chemistry' });
    const inner = createFolder(userId, { name: 'Rates', parentId: outer.id });
    const file = createFile(userId, { title: 'Collision theory', kind: 'doc', folderId: inner.id });
    saveDocument(userId, file.id, [
      { id: randomUUID(), type: 'paragraph', text: 'Particles must collide.' },
    ] as never);

    const fake = fakeRemote();
    // Throws inside the fake if a child ever precedes its parent.
    const result = await pushLibrary(userId, supabaseUserId, fake.store);

    assert.deepEqual(fake.order, ['folder:Chemistry', 'folder:Rates', 'doc:Collision theory']);
    assert.equal(result.items, 3, 'two folders and the document');
    assert.equal(result.uploaded, 1, 'only the document has a body');
  });

  it('puts every object under the account that owns it', async () => {
    const { userId, supabaseUserId } = await linkedUser();
    const file = createFile(userId, { title: 'Notes', kind: 'doc' });
    saveDocument(userId, file.id, [{ id: randomUUID(), type: 'paragraph', text: 'hi' }] as never);

    const fake = fakeRemote();
    await pushLibrary(userId, supabaseUserId, fake.store);

    for (const path of fake.objects.keys()) {
      assert.equal(
        path.split('/')[0],
        supabaseUserId,
        'the storage policies read this prefix, so it is what confines the object',
      );
    }
  });

  it('uploads nothing the second time when nothing changed', async () => {
    const { userId, supabaseUserId } = await linkedUser();
    const file = createFile(userId, { title: 'Steady', kind: 'doc' });
    saveDocument(userId, file.id, [{ id: randomUUID(), type: 'paragraph', text: 'unchanged' }] as never);

    const first = fakeRemote();
    await pushLibrary(userId, supabaseUserId, first.store);
    assert.equal(first.uploads.length, 1);

    const second = fakeRemote();
    const again = await pushLibrary(userId, supabaseUserId, second.store);
    assert.equal(second.uploads.length, 0, 're-sending identical bytes is the thing to avoid');
    assert.ok(again.unchanged >= 1);
  });

  it('re-uploads a document once its contents differ', async () => {
    const { userId, supabaseUserId } = await linkedUser();
    const file = createFile(userId, { title: 'Edited', kind: 'doc' });
    const saved = saveDocument(userId, file.id, [
      { id: randomUUID(), type: 'paragraph', text: 'first draft' },
    ] as never);

    await pushLibrary(userId, supabaseUserId, fakeRemote().store);

    saveDocument(
      userId,
      file.id,
      [{ id: randomUUID(), type: 'paragraph', text: 'second draft' }] as never,
      saved.revision,
    );

    const fake = fakeRemote();
    await pushLibrary(userId, supabaseUserId, fake.store);
    assert.equal(fake.uploads.length, 1, 'the changed body goes up');
    const body = JSON.parse([...fake.objects.values()][0]!.body.toString());
    assert.equal(body.blocks[0].text, 'second draft');
  });

  it('carries a deck along with the scheduling state of its cards', async () => {
    const { userId, supabaseUserId } = await linkedUser();
    const deck = createFile(userId, { title: 'Biology', kind: 'deck' });
    const now = Date.now();
    getDb()
      .prepare(
        `INSERT INTO cards (id, user_id, deck_id, front, back, state, ease_factor,
                            interval_days, repetitions, lapses, due_at, created_at, updated_at)
         VALUES (?, ?, ?, 'Mitosis?', 'Division', 'review', 2.6, 12, 3, 1, ?, ?, ?)`,
      )
      .run(randomUUID(), userId, deck.id, now + 86400000, now, now);

    const fake = fakeRemote();
    await pushLibrary(userId, supabaseUserId, fake.store);

    const body = JSON.parse([...fake.objects.values()][0]!.body.toString());
    assert.equal(body.cards.length, 1);
    assert.equal(body.cards[0].front, 'Mitosis?');
    assert.equal(body.cards[0].interval_days, 12, 'a backup that forgets when a card is due is half a backup');
    assert.equal(body.cards[0].ease_factor, 2.6);
  });

  it('removes upstream what has been deleted locally', async () => {
    const { userId, supabaseUserId } = await linkedUser();
    const file = createFile(userId, { title: 'Temporary', kind: 'doc' });
    saveDocument(userId, file.id, [{ id: randomUUID(), type: 'paragraph', text: 'here' }] as never);

    const first = fakeRemote();
    await pushLibrary(userId, supabaseUserId, first.store);
    assert.equal(first.items.size, 1);

    purgeFile(userId, file.id);

    const second = fakeRemote();
    const result = await pushLibrary(userId, supabaseUserId, second.store);
    assert.equal(result.removed, 1);
    assert.equal(second.deletedItems.length, 1);
    assert.equal(second.deletedObjects.length, 1, 'the object goes too, not just the row');
  });

  it('keeps stored tokens unreadable without the key', () => {
    const sealed = sealSecret('a-refresh-token-worth-stealing');
    assert.ok(!sealed.includes('worth-stealing'), 'the plaintext must not survive in the sealed form');
    assert.equal(openSecret(sealed), 'a-refresh-token-worth-stealing');

    // Tampering with any part of it must fail closed rather than yield bytes.
    const [iv, tag, body] = sealed.split('.');
    assert.equal(openSecret([iv, tag, 'AAAA'].join('.')), null);
    assert.equal(openSecret('not-even-close'), null);
    assert.equal(openSecret([iv, 'AAAA', body].join('.')), null);
  });
});
