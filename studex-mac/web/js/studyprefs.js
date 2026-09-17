/**
 * How a review or test sitting behaves, kept on this Mac.
 *
 * These are habits of a sitting rather than facts about the cards, so they do
 * not travel with the account: the scheduler never sees them.
 */
const KEY = 'studex.study-prefs';

export const STUDY_DEFAULTS = {
  shuffle: false,        // review cards in a random order
  reverse: false,        // show the back first
  sessionCap: 0,         // cards per sitting, 0 for the whole queue
  autoReveal: 0,         // seconds before the answer shows itself, 0 for never
  requeueAgain: true,    // cards rated Again come back in the same sitting
  showExplain: true,     // the AI Explain chip on a revealed card
  showCardInfo: true,    // seen count and interval under the card
  testMode: 'typed',     // typed | choice | truefalse
  testLength: 0,         // cards per test, 0 for the whole deck
  testShuffle: true,
  testTimer: 0,          // minutes, 0 for untimed
  strictness: 'lenient', // exact | normal | lenient
  mockCount: 20,         // questions on a mock paper
  mockTimer: 0,          // minutes, 0 for untimed
  audioReview: false,    // read each card aloud, front then back, for hands-free revision
  speechRate: 1,         // how fast the card is read (0.5–2×)
};

export function studyPrefs() {
  try {
    return { ...STUDY_DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...STUDY_DEFAULTS };
  }
}

export function saveStudyPrefs(patch) {
  const next = { ...studyPrefs(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* kept for this sitting only */ }
  return next;
}

export function shuffled(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
