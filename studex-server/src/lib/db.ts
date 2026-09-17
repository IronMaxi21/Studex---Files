import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

export type DB = Database.Database;

let instance: DB | null = null;

function applyPragmas(db: DB): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  // Defence in depth: the app never loads extensions or reads files via SQL.
  db.pragma('trusted_schema = OFF');
}

export function getDb(): DB {
  if (instance) return instance;
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  const db = new Database(config.databasePath);
  applyPragmas(db);
  instance = db;
  return db;
}

export function closeDb(): void {
  instance?.close();
  instance = null;
}

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

/** Applies any migration files not yet recorded, each in its own transaction. */
export function migrate(db: DB = getDb()): string[] {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name TEXT PRIMARY KEY,
       applied_at INTEGER NOT NULL
     )`,
  );
  const applied = new Set(
    db.prepare<[], { name: string }>('SELECT name FROM schema_migrations').all().map((r) => r.name),
  );
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

    // Rebuilding a table means dropping it, and dropping a table that other
    // tables reference fires their ON DELETE actions — SET NULL included. A
    // migration that has to do that says so on its first line, and gets
    // enforcement lifted for the length of its transaction. The pragma cannot
    // be set inside one, so it is moved either side.
    const withoutForeignKeys = /^\s*--\s*pragma:\s*foreign_keys\s*=\s*off\b/i.test(sql);

    const run = db.transaction(() => {
      db.exec(sql);
      if (withoutForeignKeys) {
        // Nothing may be left dangling. A rebuild that lost a reference has to
        // fail here, while the transaction can still be rolled back.
        const broken = db.pragma('foreign_key_check') as unknown[];
        if (broken.length > 0) {
          throw new Error(`${file} left ${broken.length} broken foreign key reference(s)`);
        }
      }
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(
        file,
        Date.now(),
      );
    });

    if (withoutForeignKeys) db.pragma('foreign_keys = OFF');
    try {
      run();
    } finally {
      if (withoutForeignKeys) db.pragma('foreign_keys = ON');
    }
    ran.push(file);
  }
  return ran;
}

/** Wraps a unit of work in a transaction. */
export function tx<T>(fn: () => T, db: DB = getDb()): T {
  return db.transaction(fn)();
}
