/**
 * Pulling a library back down.
 *
 * A second Mac is modelled as the same account with its local library and its
 * sync state removed — which is exactly what a second Mac is, since the two
 * share one Supabase project and nothing else. The fake remote in between is
 * a real little database, so what these tests exercise is the decision-making:
 * what happens when only one side moved, what happens when both did, and what
 * happens when a device that already holds the library meets it again.
 */
import './setup.js';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { api, closeApp, registerUser } from './helpers.js';
import { getDb } from '../src/lib/db.js';
import { createFile, createFolder, trashFile, updateFile } from '../src/domain/library.js';
import { saveDocument, getDocument } from '../src/domain/documents.js';
import { pushLibrary } from '../src/domain/sync.js';
import { pullLibrary } from '../src/domain/pull.js';
import { fakeRemote } from './fake-remote.js';

async function linkedUser() {
  const client = await registerUser();
  const supabaseUserId = randomUUID();
  getDb().prepare('UPDATE users SET supabase_user_id = ? WHERE id = ?').run(supabaseUserId, client.userId);
  return { userId: client.userId, supabaseUserId };
}

function para(text: string) {
  return [{ id: randomUUID(), type: 'paragraph', text }] as never;
}

/**
 * What a second Mac is: the same account, none of the library, none of the
 * record of what has already been synced.
 */
function freshDevice(userId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM files WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM folders WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM sync_state WHERE user_id = ?').run(userId);
}

/** The same device, but with no memory of ever having synced. */
function forgetSyncState(userId: string): void {
  getDb().prepare('DELETE FROM sync_state WHERE user_id = ?').run(userId);
}

function fileTitles(userId: string): string[] {
  return getDb()
    .prepare<[string], { title: string }>(
      'SELECT title FROM files WHERE user_id = ? AND trashed_at IS NULL ORDER BY title',
    )
    .all(userId)
    .map((r) => r.title);
}

function fileByTitle(userId: string, title: string) {
  return getDb()
    .prepare<[string, string], { id: string; folder_id: string | null; trashed_at: number | null }>(
      'SELECT id, folder_id, trashed_at FROM files WHERE user_id = ? AND title = ?',
    )
    .get(userId, title);
}

after(async () => {
  await closeApp();
});

describe('pulling a library from Supabase', () => {
  it('adopts a whole library onto a device that has none of it', async () => {
    const { userId, supabaseUserId } = await linkedUser();
    const chemistry = createFolder(userId, { name: 'Chemistry' });
    const rates = createFolder(userId, { name: 'Rates', parentId: chemistry.id });
    const note = createFile(userId, { title: 'Collision theory', kind: 'doc', folderId: rates.id });
    saveDocument(userId, note.id, para('Particles must collide.'));

    const deck = createFile(userId, { title: 'Organic mechanisms', kind: 'deck' });
    const cardId = randomUUID();
    getDb()
      .prepare(
        `INSERT INTO cards (id, user_id, deck_id, front, back, state, ease_factor, interval_days,
                            repetitions, lapses, due_at, created_at, updated_at)
         VALUES (?, ?, ?, 'SN1', 'Carbocation', 'review', 2.35, 12.5, 4, 1, 1700000000000, 1, 2)`,
      )
      .run(cardId, userId, deck.id);

    const fake = fakeRemote();
    await pushLibrary(userId, supabaseUserId, fake.store);

    freshDevice(userId);
    assert.deepEqual(fileTitles(userId), [], 'the second device starts with nothing');

    const result = await pullLibrary(userId, supabaseUserId, fake.store);

    assert.equal(result.created, 4, 'two folders, a note and a deck');
    assert.equal(result.conflicted, 0);
    assert.deepEqual(fileTitles(userId), ['Collision theory', 'Organic mechanisms']);

    // The tree, not just the files: a note that came back to the wrong place
    // is not the same library.
    const pulledNote = fileByTitle(userId, 'Collision theory')!;
    const parent = getDb()
      .prepare<[string], { name: string; parent_id: string | null }>(
        'SELECT name, parent_id FROM folders WHERE id = ?',
      )
      .get(pulledNote.folder_id!)!;
    assert.equal(parent.name, 'Rates');
    const grandparent = getDb()
      .prepare<[string], { name: string }>('SELECT name FROM folders WHERE id = ?')
      .get(parent.parent_id!)!;
    assert.equal(grandparent.name, 'Chemistry');

    const blocks = getDocument(userId, pulledNote.id).blocks as Array<{ text?: string }>;
    assert.equal(blocks[0]!.text, 'Particles must collide.');

    // The half of a deck that is actually worth restoring.
    const card = getDb()
      .prepare<[string], { id: string; ease_factor: number; interval_days: number; repetitions: number; due_at: number }>(
        'SELECT id, ease_factor, interval_days, repetitions, due_at FROM cards WHERE user_id = ?',
      )
      .get(userId)!;
    assert.equal(card.id, cardId, 'card ids survive, because documents reference them');
    assert.equal(card.ease_factor, 2.35);

    // A deck written by a client that predates FSRS carries no memory state.
    // Defaulting it to something invented would give the card a schedule it
    // never earned, so it comes back null and the next review establishes it.
    const memory = getDb()
      .prepare<[string], { stability: number | null; difficulty: number | null }>(
        'SELECT stability, difficulty FROM cards WHERE id = ?',
      )
      .get(card.id)!;
    assert.equal(memory.stability, null);
    assert.equal(memory.difficulty, null);
    assert.equal(card.interval_days, 12.5);
    assert.equal(card.repetitions, 4);
    assert.equal(card.due_at, 1700000000000);
  });

  it('does nothing at all the second time', async () => {
    const { userId, supabaseUserId } = await linkedUser();
    const note = createFile(userId, { title: 'Steady state', kind: 'doc' });
    saveDocument(userId, note.id, para('Nothing changes.'));

    const fake = fakeRemote();
    await pushLibrary(userId, supabaseUserId, fake.store);
    freshDevice(userId);

    await pullLibrary(userId, supabaseUserId, fake.store);
    const downloadsAfterFirst = fake.downloads.length;

    const second = await pullLibrary(userId, supabaseUserId, fake.store);
    assert.equal(second.created, 0);
    assert.equal(second.updated, 0);
    assert.equal(second.conflicted, 0);
    assert.equal(second.unchanged, 1);
    assert.equal(fake.downloads.length, downloadsAfterFirst, 'nothing was fetched again');
    assert.deepEqual(fileTitles(userId), ['Steady state']);
  });

  it('leaves nothing for the next push to do, so two devices settle', async () => {
    const { userId, supabaseUserId } = await linkedUser();
    const note = createFile(userId, { title: 'Settling', kind: 'doc' });
    saveDocument(userId, note.id, para('Written once.'));

    const fake = fakeRemote();
    await pushLibrary(userId, supabaseUserId, fake.store);
    freshDevice(userId);
    await pullLibrary(userId, supabaseUserId, fake.store);

    // The pulled copy has to hash to what is already upstream. If it did not,
    // this push would re-upload it, the other Mac would see a change and pull
    // it back, and the two would trade the same note for ever.
    const uploadsBefore = fake.uploads.length;
    const after = await pushLibrary(userId, supabaseUserId, fake.store);
    assert.equal(fake.uploads.length, uploadsBefore, 'a pulled note is not re-uploaded');
    assert.equal(after.uploaded, 0);
    assert.equal(after.removed, 0);
  });

  it('takes an edit made elsewhere over a copy this device has not touched', async () => {
    const { userId, supabaseUserId } = await linkedUser();
    const note = createFile(userId, { title: 'Rates of reaction', kind: 'doc' });
    saveDocument(userId, note.id, para('First draft.'));

    const fake = fakeRemote();
    await pushLibrary(userId, supabaseUserId, fake.store);

    // The other Mac edits and pushes.
    fake.edit(
      'Rates of reaction',
      Buffer.from(JSON.stringify({ kind: 'doc', style: 'standard', blocks: [{ id: randomUUID(), type: 'paragraph', text: 'Second draft.' }] })),
    );

    const result = await pullLibrary(userId, supabaseUserId, fake.store);
    assert.equal(result.updated, 1);
    assert.equal(result.conflicted, 0);
    assert.deepEqual(fileTitles(userId), ['Rates of reaction'], 'no second copy was made');

    const blocks = getDocument(userId, note.id).blocks as Array<{ text?: string }>;
    assert.equal(blocks[0]!.text, 'Second draft.');
  });

  it('keeps both versions when both sides changed', async () => {
    const { userId, supabaseUserId } = await linkedUser();
    const note = createFile(userId, { title: 'Equilibria', kind: 'doc' });
    saveDocument(userId, note.id, para('Agreed text.'));

    const fake = fakeRemote();
    await pushLibrary(userId, supabaseUserId, fake.store);

    // Both Macs write, neither having seen the other.
    saveDocument(userId, note.id, para('What I wrote here.'));
    fake.edit(
      'Equilibria',
      Buffer.from(JSON.stringify({ kind: 'doc', style: 'standard', blocks: [{ id: randomUUID(), type: 'paragraph', text: 'What I wrote there.' }] })),
    );

    const result = await pullLibrary(userId, supabaseUserId, fake.store);
    assert.equal(result.conflicted, 1);
    assert.equal(result.updated, 0);

    // Nothing is thrown away: this device keeps its own text, and the other
    // one's arrives beside it.
    assert.deepEqual(fileTitles(userId), ['Equilibria', 'Equilibria (from another device)']);

    const mine = getDocument(userId, note.id).blocks as Array<{ text?: string }>;
    assert.equal(mine[0]!.text, 'What I wrote here.');

    const theirs = fileByTitle(userId, 'Equilibria (from another device)')!;
    const theirBlocks = getDocument(userId, theirs.id).blocks as Array<{ text?: string }>;
    assert.equal(theirBlocks[0]!.text, 'What I wrote there.');

    // And the next push settles it: this device's version wins the original
    // item, and the copy travels up as something new.
    const pushed = await pushLibrary(userId, supabaseUserId, fake.store);
    assert.equal(pushed.removed, 0, 'nothing was deleted upstream by resolving a conflict');
    const upstream = [...fake.items.values()].filter((i) => i.kind === 'doc').map((i) => i.name).sort();
    assert.deepEqual(upstream, ['Equilibria', 'Equilibria (from another device)']);
  });

  it('adopts a library it already holds instead of duplicating it', async () => {
    const { userId, supabaseUserId } = await linkedUser();
    const folder = createFolder(userId, { name: 'Biology' });
    const note = createFile(userId, { title: 'Cell transport', kind: 'doc', folderId: folder.id });
    saveDocument(userId, note.id, para('Diffusion is passive.'));

    const fake = fakeRemote();
    await pushLibrary(userId, supabaseUserId, fake.store);

    // The same files, and no record of them ever having been synced — which is
    // what a device that was restored from a backup looks like.
    forgetSyncState(userId);

    const result = await pullLibrary(userId, supabaseUserId, fake.store);
    assert.equal(result.created, 0, 'nothing had to be made');
    assert.equal(result.conflicted, 0);
    assert.equal(result.unchanged, 2, 'the folder and the note were recognised');
    assert.deepEqual(fileTitles(userId), ['Cell transport']);
    assert.equal(
      getDb().prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM folders WHERE user_id = ?').get(userId)!.n,
      1,
    );
  });

  it('follows a rename made on the other device, for folders as well as files', async () => {
    const { userId, supabaseUserId } = await linkedUser();
    const folder = createFolder(userId, { name: 'Chemistry' });
    const note = createFile(userId, { title: 'Titration', kind: 'doc', folderId: folder.id });
    saveDocument(userId, note.id, para('Add slowly.'));

    const fake = fakeRemote();
    await pushLibrary(userId, supabaseUserId, fake.store);

    // Renaming upstream is the other Mac having pushed a rename. Note that
    // only the name changes: a rename spends no bytes, so the content hash
    // stands still. That is exactly the case a body-only comparison misses.
    const folderItem = fake.find('Chemistry');
    fake.items.set(folderItem.id, { ...folderItem, name: 'Chem A2' });
    const fileItem = fake.find('Titration');
    fake.items.set(fileItem.id, { ...fileItem, name: 'Titration walkthrough' });

    const result = await pullLibrary(userId, supabaseUserId, fake.store);
    assert.equal(result.updated, 2, 'both the folder and the note followed their new names');
    assert.equal(result.conflicted, 0);
    assert.equal(fake.downloads.length, 0, 'a rename does not fetch the body again');

    const renamed = getDb()
      .prepare<[string], { name: string }>('SELECT name FROM folders WHERE user_id = ?')
      .get(userId)!;
    assert.equal(renamed.name, 'Chem A2');
    assert.deepEqual(fileTitles(userId), ['Titration walkthrough']);
  });

  it('keeps this device\'s name when both sides renamed the same file', async () => {
    const { userId, supabaseUserId } = await linkedUser();
    const note = createFile(userId, { title: 'Working title', kind: 'doc' });
    saveDocument(userId, note.id, para('Unchanged text.'));

    const fake = fakeRemote();
    await pushLibrary(userId, supabaseUserId, fake.store);

    const item = fake.find('Working title');
    fake.items.set(item.id, { ...item, name: 'Their name' });
    updateFile(userId, note.id, { title: 'My name' });

    const result = await pullLibrary(userId, supabaseUserId, fake.store);
    assert.equal(result.conflicted, 1);
    // No second copy: a disagreement about a label is not a disagreement about
    // work, and there is nothing to keep two of.
    assert.deepEqual(fileTitles(userId), ['My name']);

    await pushLibrary(userId, supabaseUserId, fake.store);
    assert.equal(fake.find('My name').id, item.id, 'the same item upstream, renamed');
  });

  it('moves a file to the trash when it was purged on the other device', async () => {
    const { userId, supabaseUserId } = await linkedUser();
    const keep = createFile(userId, { title: 'Keep this', kind: 'doc' });
    saveDocument(userId, keep.id, para('Still wanted.'));
    const gone = createFile(userId, { title: 'Deleted elsewhere', kind: 'doc' });
    saveDocument(userId, gone.id, para('Not wanted.'));

    const fake = fakeRemote();
    await pushLibrary(userId, supabaseUserId, fake.store);

    // The other Mac deleted it outright, so its row is no longer upstream.
    const item = fake.find('Deleted elsewhere');
    fake.items.delete(item.id);

    const result = await pullLibrary(userId, supabaseUserId, fake.store);
    assert.equal(result.trashed, 1);

    // Trashed, not purged: a delete arriving over a network is exactly the
    // kind of instruction worth being able to take back.
    assert.deepEqual(fileTitles(userId), ['Keep this']);
    assert.ok(fileByTitle(userId, 'Deleted elsewhere')!.trashed_at, 'it is in the trash, not gone');
  });

  it('keeps a file that was deleted elsewhere but edited here', async () => {
    const { userId, supabaseUserId } = await linkedUser();
    const note = createFile(userId, { title: 'Contested', kind: 'doc' });
    saveDocument(userId, note.id, para('Original.'));

    const fake = fakeRemote();
    await pushLibrary(userId, supabaseUserId, fake.store);

    fake.items.delete(fake.find('Contested').id);
    saveDocument(userId, note.id, para('But I was still working on this.'));

    const result = await pullLibrary(userId, supabaseUserId, fake.store);
    assert.equal(result.trashed, 0, 'an edit is a stronger signal than a delete');
    assert.deepEqual(fileTitles(userId), ['Contested']);

    // With the mapping dropped, the next push sends it back up as new work
    // rather than leaving it stranded on this Mac alone.
    await pushLibrary(userId, supabaseUserId, fake.store);
    assert.equal([...fake.items.values()].filter((i) => i.name === 'Contested').length, 1);
  });

  it('never sends the trash up', async () => {
    const { userId, supabaseUserId } = await linkedUser();
    const keep = createFile(userId, { title: 'Still revising', kind: 'doc' });
    saveDocument(userId, keep.id, para('In use.'));
    const binned = createFile(userId, { title: 'Binned', kind: 'doc' });
    saveDocument(userId, binned.id, para('Done with this.'));
    trashFile(userId, binned.id);

    const fake = fakeRemote();
    const result = await pushLibrary(userId, supabaseUserId, fake.store);

    assert.equal(result.items, 1, 'only the live note');
    assert.deepEqual([...fake.items.values()].map((i) => i.name), ['Still revising']);
    assert.equal(fake.uploads.length, 1, 'the binned note was never uploaded');
  });

  it('takes a file out of the project when it is trashed here', async () => {
    const { userId, supabaseUserId } = await linkedUser();
    const note = createFile(userId, { title: 'Second thoughts', kind: 'doc' });
    saveDocument(userId, note.id, para('Maybe not.'));

    const fake = fakeRemote();
    await pushLibrary(userId, supabaseUserId, fake.store);
    const item = fake.find('Second thoughts');
    assert.ok(fake.objects.has(item.storagePath!), 'it went up to begin with');

    trashFile(userId, note.id);
    const after = await pushLibrary(userId, supabaseUserId, fake.store);

    // Row and object both, so nothing is left paying for storage upstream.
    assert.equal(after.removed, 1);
    assert.equal(fake.items.size, 0);
    assert.equal(fake.objects.size, 0);

    // And it is still here, in the bin, where it can be got back.
    assert.ok(fileByTitle(userId, 'Second thoughts')!.trashed_at);
  });

  it('does not rebuild the bin on a second Mac', async () => {
    const { userId, supabaseUserId } = await linkedUser();
    const keep = createFile(userId, { title: 'Wanted', kind: 'doc' });
    saveDocument(userId, keep.id, para('Keep me.'));
    const binned = createFile(userId, { title: 'Unwanted', kind: 'doc' });
    saveDocument(userId, binned.id, para('Bin me.'));
    trashFile(userId, binned.id);

    const fake = fakeRemote();
    await pushLibrary(userId, supabaseUserId, fake.store);

    freshDevice(userId);
    const result = await pullLibrary(userId, supabaseUserId, fake.store);

    assert.equal(result.created, 1);
    assert.deepEqual(fileTitles(userId), ['Wanted']);
    // Not trashed here either — it simply never arrived.
    assert.equal(fileByTitle(userId, 'Unwanted'), undefined);
  });

  it('ignores a trashed row left upstream by an older build', async () => {
    const { userId, supabaseUserId } = await linkedUser();
    const note = createFile(userId, { title: 'Legacy bin item', kind: 'doc' });
    saveDocument(userId, note.id, para('Pushed before the rule changed.'));

    const fake = fakeRemote();
    await pushLibrary(userId, supabaseUserId, fake.store);
    // What the previous build would have written.
    const item = fake.find('Legacy bin item');
    fake.items.set(item.id, { ...item, trashedAt: Date.now() });

    freshDevice(userId);
    const result = await pullLibrary(userId, supabaseUserId, fake.store);
    assert.equal(result.created, 0);
    assert.deepEqual(fileTitles(userId), []);
  });

  it('leaves a file this Mac has binned alone, however it changed upstream', async () => {
    const { userId, supabaseUserId } = await linkedUser();
    const note = createFile(userId, { title: 'On its way out', kind: 'doc' });
    saveDocument(userId, note.id, para('Original.'));

    const fake = fakeRemote();
    await pushLibrary(userId, supabaseUserId, fake.store);

    trashFile(userId, note.id);
    fake.edit(
      'On its way out',
      Buffer.from(JSON.stringify({ kind: 'doc', style: 'standard', blocks: [{ id: randomUUID(), type: 'paragraph', text: 'Edited elsewhere.' }] })),
    );

    const result = await pullLibrary(userId, supabaseUserId, fake.store);
    assert.equal(result.conflicted, 0, 'no copy is made of something being thrown away');
    assert.deepEqual(fileTitles(userId), []);
    // The bin is not a place to write incoming edits into. Read straight from
    // the row, because a trashed document will not open through the domain.
    const stored = getDb()
      .prepare<[string], { blocks: string }>('SELECT blocks FROM documents WHERE file_id = ?')
      .get(note.id)!;
    assert.equal((JSON.parse(stored.blocks) as Array<{ text?: string }>)[0]!.text, 'Original.');
  });

  it('counts only what a sync would actually send', async () => {
    const client = await registerUser('Counting');
    const live = createFile(client.userId, { title: 'Counted', kind: 'doc' });
    saveDocument(client.userId, live.id, para('One.'));
    const gone = createFile(client.userId, { title: 'Not counted', kind: 'doc' });
    saveDocument(client.userId, gone.id, para('Two.'));
    trashFile(client.userId, gone.id);

    const res = await api(client, { method: 'GET', url: '/api/sync/status' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().items, 1, 'the bin is not pending anything');
  });

  it('tells an unlinked account there is nothing to pull from', async () => {
    const client = await registerUser('Local Only');
    for (const url of ['/api/sync/pull', '/api/sync']) {
      const res = await api(client, { method: 'POST', url });
      assert.equal(res.statusCode, 409, url);
      assert.equal(res.json().error.code, 'not_linked', url);
    }
  });

  it('does not sign the student out when only the Supabase session is missing', async () => {
    const client = await registerUser('Linked But Tokenless');
    getDb()
      .prepare('UPDATE users SET supabase_user_id = ? WHERE id = ?')
      .run(randomUUID(), client.userId);

    // A 401 here would be read by the app as "your session ended" and bounce
    // the student to the login screen. Their Studex session is fine; it is the
    // Supabase one that has to be re-established.
    for (const url of ['/api/sync/pull', '/api/sync', '/api/sync/push']) {
      const res = await api(client, { method: 'POST', url });
      assert.notEqual(res.statusCode, 401, url);
      assert.equal(res.statusCode, 409, url);
      assert.equal(res.json().error.code, 'sync_signin_required', url);
    }
  });

  it('refuses to let one account read another account\'s library', async () => {
    const mine = await linkedUser();
    const theirs = await linkedUser();

    const note = createFile(mine.userId, { title: 'Private notes', kind: 'doc' });
    saveDocument(mine.userId, note.id, para('Mine alone.'));

    const fake = fakeRemote();
    await pushLibrary(mine.userId, mine.supabaseUserId, fake.store);

    // The store is shared, but listItems is scoped by the identity asking —
    // the same scoping row-level security applies upstream.
    const result = await pullLibrary(theirs.userId, theirs.supabaseUserId, fake.store);
    assert.equal(result.created, 0);
    assert.deepEqual(fileTitles(theirs.userId), []);
  });
});
