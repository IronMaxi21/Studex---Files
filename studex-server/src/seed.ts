/**
 * Seeds the demo account from the Studex design: Aisha's Chemistry revision,
 * eleven days before Paper 2. Idempotent — running it twice is a no-op.
 */
import { getDb, migrate } from './lib/db.js';
import { newId } from './lib/ids.js';
import { hashPassword } from './lib/password.js';
import { config } from './lib/config.js';
import { DAY_MS } from './lib/time.js';

const EMAIL = 'aisha@studex.test';
const PASSWORD = 'revision-season-2026';

const HOUR = 60 * 60 * 1000;

async function seed(): Promise<void> {
  migrate();
  const db = getDb();

  const existing = db
    .prepare<[string], { id: string }>('SELECT id FROM users WHERE email_normalized = ?')
    .get(EMAIL);
  if (existing) {
    console.log(`Demo user already present (${EMAIL}). Nothing to do.`);
    return;
  }

  const now = Date.now();
  const userId = newId();
  const passwordHash = await hashPassword(PASSWORD);

  db.prepare(
    `INSERT INTO users (id, email, email_normalized, password_hash, display_name, plan,
                        plan_renews_at, storage_used_bytes, storage_quota_bytes, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Aisha K.', 'pro', ?, 0, ?, ?, ?)`,
  ).run(
    userId, EMAIL, EMAIL, passwordHash, now + 21 * DAY_MS,
    config.storageQuotaBytes * config.proQuotaMultiplier, now, now,
  );

  // The demo account is on Pro, so it needs the thing that makes Pro legal.
  // Without it the seeded library would be a tier nothing had granted.
  db.prepare(
    `INSERT INTO billing_entitlements (user_id, plan, source, reference, granted_at, expires_at)
     VALUES (?, 'pro', 'licence', 'seed', ?, NULL)`,
  ).run(userId, now);

  db.prepare(
    `INSERT INTO user_settings (user_id, theme, accent, timezone, updated_at)
     VALUES (?, 'dark', '#9184d9', 'Europe/London', ?)`,
  ).run(userId, now);

  /* subjects and folders, matching the sidebar */

  const subjects: Record<string, string> = {};
  const subjectSpec: [string, string][] = [
    ['Chemistry', 'accent'],
    ['History A2', 'amber'],
    ['Maths', 'teal'],
    ['Biology', 'lime'],
  ];
  subjectSpec.forEach(([name, color], i) => {
    const id = newId();
    subjects[name] = id;
    db.prepare(
      'INSERT INTO subjects (id, user_id, name, color, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, userId, name, color, i, now, now);
  });

  const folders: Record<string, string> = {};
  const folderSpec: [string, string | null, string | null][] = [
    ['Chemistry', subjects.Chemistry!, 'accent'],
    ['History A2', subjects['History A2']!, 'amber'],
    ['Maths', subjects.Maths!, 'teal'],
    ['Biology', subjects.Biology!, 'lime'],
    // The dissertation is a folder without a subject — it has no exam.
    ['Dissertation', null, 'rose'],
  ];
  folderSpec.forEach(([name, subjectId, color], i) => {
    const id = newId();
    folders[name] = id;
    db.prepare(
      `INSERT INTO folders (id, user_id, parent_id, subject_id, name, color, pinned, position, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, 0, ?, ?, ?)`,
    ).run(id, userId, subjectId, name, color, i, now, now);
  });

  /* files */

  const insertFile = (
    title: string,
    kind: 'canvas' | 'doc' | 'pdf' | 'deck',
    folder: string,
    updatedAt: number,
    pinned = false,
  ): string => {
    const id = newId();
    db.prepare(
      `INSERT INTO files (id, user_id, folder_id, kind, title, pinned, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, userId, folders[folder]!, kind, title, pinned ? 1 : 0, now - 30 * DAY_MS, updatedAt);
    db.prepare(
      `INSERT INTO search_index (title, body, user_id, entity_type, entity_id, file_id)
       VALUES (?, '', ?, 'file', ?, ?)`,
    ).run(title, userId, id, id);
    const rowid = db.prepare('SELECT last_insert_rowid() AS r').get() as { r: number };
    db.prepare(
      'INSERT INTO search_docs (entity_id, user_id, entity_type, fts_rowid) VALUES (?, ?, ?, ?)',
    ).run(`file:${id}`, userId, 'file', rowid.r);
    return id;
  };

  const equilibriaMap = insertFile('Equilibria map', 'canvas', 'Chemistry', now - 2 * 60 * 1000, true);
  const ratesDoc = insertFile('Rates of reaction', 'doc', 'Chemistry', now - HOUR);
  const mechanismsDeck = insertFile('Organic mechanisms', 'deck', 'Chemistry', now - 3 * HOUR, true);
  const paper2 = insertFile('Paper 2 2024', 'pdf', 'Chemistry', now - 5 * HOUR, true);
  insertFile('Paper 2 plan', 'doc', 'Chemistry', now - 2 * DAY_MS);
  insertFile('Titration walkthrough', 'canvas', 'Chemistry', now - 3 * DAY_MS);
  insertFile('Redox summary', 'doc', 'Chemistry', now - 9 * DAY_MS);

  db.prepare('INSERT INTO canvases (file_id, objects, viewport, updated_at) VALUES (?, ?, ?, ?)').run(
    equilibriaMap,
    JSON.stringify([
      {
        id: newId(),
        type: 'note',
        x: 0,
        y: 0,
        width: 260,
        height: 120,
        text: 'Dynamic equilibrium: forward and reverse rates are equal, concentrations constant.',
        shape: 'rounded',
        stroke: 1.5,
      },
      {
        id: newId(),
        type: 'note',
        x: 320,
        y: 40,
        width: 240,
        height: 110,
        text: "Le Chatelier: increase pressure → shifts to the side with fewer gas moles.",
        shape: 'rounded',
        stroke: 1.5,
      },
    ]),
    JSON.stringify({ x: 0, y: 0, zoom: 0.68 }),
    now - 2 * 60 * 1000,
  );

  db.prepare('INSERT INTO documents (file_id, blocks, updated_at) VALUES (?, ?, ?)').run(
    ratesDoc,
    JSON.stringify([
      { id: newId(), type: 'heading', level: 1, text: 'Rates of reaction' },
      {
        id: newId(),
        type: 'bullet',
        indent: 0,
        text: 'Collision theory: particles must collide with energy at or above the activation energy, and in the correct orientation.',
      },
      { id: newId(), type: 'bullet', indent: 0, text: 'Rate is proportional to the frequency of successful collisions.' },
      { id: newId(), type: 'heading', level: 2, text: 'Factors table' },
      {
        id: newId(),
        type: 'table',
        columns: ['Factor', 'Effect on rate', 'Why'],
        rows: [
          ['Temperature', 'Increases', 'More particles with energy above Ea'],
          ['Surface area', 'Increases', 'More contact points'],
          ['Catalyst', 'Increases', 'Lowers Ea'],
          ['Concentration', 'Increases', 'More frequent collisions'],
        ],
      },
      { id: newId(), type: 'heading', level: 2, text: 'Practice' },
      { id: newId(), type: 'todo', done: true, text: 'Read pp. 112-118' },
      { id: newId(), type: 'todo', done: false, text: 'Past paper Q4-Q7' },
      { id: newId(), type: 'todo', done: false, text: 'Make cards for catalysts' },
    ]),
    now - HOUR,
  );

  db.prepare('INSERT INTO decks (file_id, description, updated_at) VALUES (?, ?, ?)').run(
    mechanismsDeck,
    'Reaction mechanisms for Paper 2',
    now - 3 * HOUR,
  );

  /* cards — a mix of due, new and comfortably scheduled */

  const cardSpec: [string, string, string, number][] = [
    ["Why does Markovnikov's rule favour the more substituted carbocation?",
     'Alkyl groups are electron-donating, so they stabilise the positive charge through induction and hyperconjugation.',
     'Electrophilic addition', -HOUR],
    ['Which reagent converts a primary alcohol to an aldehyde without over-oxidising?',
     'PCC in dichloromethane.', 'Oxidation', -2 * HOUR],
    ['What are the two conditions for a successful collision?',
     'Sufficient energy (at or above Ea) and correct orientation.', 'Collision theory', 3 * DAY_MS],
    ['Effect of a catalyst on the value of Kc?',
     'None — it speeds both forward and reverse rates equally.', 'Equilibria', -30 * 60 * 1000],
    ['What does a higher Kc value indicate?',
     'The position of equilibrium lies further to the right.', 'Equilibria', 9 * DAY_MS],
  ];

  for (const [front, back, topic, dueOffset] of cardSpec) {
    const id = newId();
    const isNew = dueOffset > 2 * DAY_MS;
    db.prepare(
      `INSERT INTO cards (id, user_id, deck_id, front, back, topic, state, ease_factor,
                          interval_days, repetitions, lapses, due_at, last_reviewed_at,
                          suspended, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 2.5, ?, ?, 0, ?, ?, 0, ?, ?)`,
    ).run(
      id,
      userId,
      mechanismsDeck,
      front,
      back,
      topic,
      isNew ? 'review' : 'review',
      isNew ? 9 : 6,
      isNew ? 6 : 4,
      now + dueOffset,
      now - 3 * DAY_MS,
      now - 20 * DAY_MS,
      now,
    );
    db.prepare(
      `INSERT INTO search_index (title, body, user_id, entity_type, entity_id, file_id)
       VALUES (?, ?, ?, 'card', ?, ?)`,
    ).run(front.slice(0, 200), `${front}\n${back}\n${topic}`, userId, id, mechanismsDeck);
    const rowid = db.prepare('SELECT last_insert_rowid() AS r').get() as { r: number };
    db.prepare(
      'INSERT INTO search_docs (entity_id, user_id, entity_type, fts_rowid) VALUES (?, ?, ?, ?)',
    ).run(`card:${id}`, userId, 'card', rowid.r);
  }

  /* annotations on the past paper */

  const annotationSpec: [number, 'highlight' | 'comment', string | null, string | null][] = [
    [2, 'highlight', 'what is meant by the term dynamic equilibrium', 'Definition mark is for rates equal, not "nothing happens".'],
    [2, 'highlight', 'adding a catalyst on the value of Kc', 'No effect — both rates increase equally.'],
    [2, 'comment', null, 'Cooling raised the yield, so forward is exothermic. Check the 2023 mark scheme wording.'],
  ];
  for (const [page, kind, quoted, note] of annotationSpec) {
    const id = newId();
    const geometry =
      kind === 'highlight'
        ? { kind: 'quads', quads: [{ x: 80, y: 220, width: 340, height: 16 }] }
        : { kind: 'point', x: 460, y: 300 };
    db.prepare(
      `INSERT INTO annotations (id, user_id, file_id, page, kind, geometry, quoted_text, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, userId, paper2, page, kind, JSON.stringify(geometry), quoted, note, now - DAY_MS, now - DAY_MS);
    db.prepare(
      `INSERT INTO search_index (title, body, user_id, entity_type, entity_id, file_id)
       VALUES (?, ?, ?, 'annotation', ?, ?)`,
    ).run(quoted ?? `${kind} on page ${page}`, [quoted, note].filter(Boolean).join('\n'), userId, id, paper2);
    const rowid = db.prepare('SELECT last_insert_rowid() AS r').get() as { r: number };
    db.prepare(
      'INSERT INTO search_docs (entity_id, user_id, entity_type, fts_rowid) VALUES (?, ?, ?, ?)',
    ).run(`annotation:${id}`, userId, 'annotation', rowid.r);
  }

  /* calendar */

  const events: [string, 'exam' | 'deadline' | 'study_block', string | null, number, number | null, string | null][] = [
    ['Chem Paper 2', 'exam', subjects.Chemistry!, now + 2 * DAY_MS, null, 'Hall B'],
    ['Essay 2 hand-in', 'deadline', subjects['History A2']!, now + 7 * DAY_MS, null, null],
    ['Maths mock', 'exam', subjects.Maths!, now + 14 * DAY_MS, null, null],
    ['History Paper 1', 'exam', subjects['History A2']!, now + 21 * DAY_MS, null, null],
    ['Biology Paper 3', 'exam', subjects.Biology!, now + 28 * DAY_MS, null, null],
    ['Equilibria', 'study_block', subjects.Chemistry!, now + 2 * HOUR, now + 2 * HOUR + 45 * 60 * 1000, null],
    ['Flashcards', 'study_block', subjects.Chemistry!, now + 3 * HOUR, now + 3 * HOUR + 30 * 60 * 1000, null],
    ['History essay plan', 'study_block', subjects['History A2']!, now + 4 * HOUR, now + 5 * HOUR, null],
  ];

  for (const [title, kind, subjectId, startsAt, endsAt, location] of events) {
    db.prepare(
      `INSERT INTO events (id, user_id, subject_id, kind, title, location, starts_at, ends_at,
                           all_day, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'manual', ?, ?)`,
    ).run(newId(), userId, subjectId, kind, title, location, startsAt, endsAt, now, now);
  }

  /* an 18-day study streak, roughly 11 hours in the last week */

  for (let day = 0; day < 18; day++) {
    const started = now - day * DAY_MS - 3 * HOUR;
    db.prepare(
      `INSERT INTO study_sessions (id, user_id, subject_id, planned_minutes, elapsed_seconds,
                                   cycle_index, cycle_total, status, started_at, ended_at)
       VALUES (?, ?, ?, 45, ?, 1, 4, 'completed', ?, ?)`,
    ).run(
      newId(),
      userId,
      subjects.Chemistry!,
      day < 7 ? 5_880 : 3_600, // ~11.4h across the last week
      started,
      started + 45 * 60 * 1000,
    );

    // A handful of reviews each day keeps the recall figure meaningful.
    for (let i = 0; i < 6; i++) {
      db.prepare(
        `INSERT INTO review_logs (id, user_id, card_id, rating, mode, duration_ms,
                                  interval_before, interval_after, reviewed_at)
         SELECT ?, ?, id, ?, 'review', 6200, 4, 6, ? FROM cards WHERE user_id = ? LIMIT 1`,
      ).run(newId(), userId, i % 5 === 0 ? 2 : 3, started + i * 60_000, userId);
    }
  }

  console.log(`Seeded ${EMAIL} / ${PASSWORD}`);
  console.log(`  user id: ${userId}`);
}

await seed();
