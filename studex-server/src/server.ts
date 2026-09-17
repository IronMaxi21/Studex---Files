import { buildApp } from './app.js';
import { config } from './lib/config.js';
import { closeDb } from './lib/db.js';
import { pruneAuthAttempts } from './domain/auth.js';
import { purgeExpiredTrash } from './domain/library.js';
import { startAutoSync } from './domain/autosync.js';
import { startRealtimeSync } from './domain/realtime.js';

const app = await buildApp();

// Housekeeping: aged-out rate-limit rows would otherwise grow without bound.
const pruneTimer = setInterval(
  () => {
    try {
      pruneAuthAttempts();
      // The trash promises thirty days, and keeps the promise in both directions.
      purgeExpiredTrash();
    } catch (err) {
      app.log.error({ err }, 'failed to prune auth attempts');
    }
  },
  60 * 60 * 1000,
);
pruneTimer.unref();
try { purgeExpiredTrash(); } catch (err) { app.log.error({ err }, 'failed to empty expired trash'); }

/**
 * Sync on a schedule. Nothing happens for an account that signs in locally or
 * that has switched the interval off, so on a single-Mac install this loop
 * wakes once a minute, finds nothing, and goes back to sleep.
 */
const stopAutoSync = startAutoSync(app.log);

/**
 * Sync when the project says so. This is what closes the gap the interval
 * cannot: a subscription to each linked library, and a pull a couple of
 * seconds after a row moves. With no Supabase project — or with SYNC_REALTIME
 * off — it starts nothing at all and returns a no-op.
 */
const stopRealtime = startRealtimeSync(app.log);

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  clearInterval(pruneTimer);
  stopAutoSync();
  stopRealtime();
  try {
    await app.close();
    closeDb();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal));
}

/**
 * When the desktop shell launches this process it holds the write end of our
 * stdin open. A clean quit sends SIGTERM, but a crash or a force quit does
 * not — and this process would then survive its parent, holding the database
 * open and the port bound, with no window left to close it from. End-of-stream
 * on that pipe is the signal that nobody is listening any more.
 */
if (process.env.PARENT_PIPE === '1') {
  process.stdin.resume();
  process.stdin.on('end', () => void shutdown('parent-exit'));
  process.stdin.on('error', () => void shutdown('parent-pipe-error'));
}

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error({ err }, 'failed to start');
  process.exit(1);
}
