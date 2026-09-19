/**
 * The ordinary test environment, stamped as the build that ships.
 *
 * `config.ts` reads the channel once, at module scope, so a test that wants
 * the release build has to say so before anything imports the app. Importing
 * this instead of `./setup.js` — and before `./helpers.js` — is what does it.
 */
import './setup.js';

process.env.STUDEX_CHANNEL = 'release';
