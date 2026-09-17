/**
 * What the interface says to the console.
 *
 * A packaged Studex is not a place to be chatty. Anything logged here is
 * running on a student's machine with their notes in front of it, so the rule
 * is: debug and info are for someone actively debugging and are off unless
 * they ask; warnings and errors always go through, because those are the lines
 * that matter when something has gone wrong in the field and nobody is
 * watching the console.
 *
 * Turned on for a session with:
 *
 *   localStorage.setItem('studex.debug', '1')
 *
 * Never log a note, a card, a title or a query. A log line describing what
 * happened is diagnosis; a log line containing what the student wrote is a
 * copy of their work somewhere they did not put it.
 */
const KEY = 'studex.debug';

function wanted() {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    // Private mode, or storage disabled. Quiet is the safe answer.
    return false;
  }
}

const verbose = wanted();

const TAG = '[studex]';

export const log = {
  verbose,
  debug: (...args) => { if (verbose) console.debug(TAG, ...args); },
  info: (...args) => { if (verbose) console.info(TAG, ...args); },
  warn: (...args) => console.warn(TAG, ...args),
  error: (...args) => console.error(TAG, ...args),
};
