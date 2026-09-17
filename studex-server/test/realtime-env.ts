/**
 * Turns the library subscription on for one test file.
 *
 * Same reason as `ai-env.ts`: config.ts reads the environment once at module
 * scope, so this has to be evaluated before anything that imports it. Outside
 * this file the flag defaults to off, because `setup.ts` clears the Supabase
 * settings and there would be nothing to subscribe to.
 *
 * Nothing here opens a socket. The watcher and the token source are both
 * handed in by the tests.
 */
import './setup.js';

process.env.SYNC_REALTIME = 'true';
