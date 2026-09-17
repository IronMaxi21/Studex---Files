/**
 * Reading a card aloud, so revision can happen on a walk or a bus.
 *
 * The web speech synthesiser is present in a plain browser and in the app's
 * WKWebView alike, so it carries the whole feature on its own — no native call
 * is needed for it to work today. The one rough edge it has is that a synthesis
 * job outlives the utterance object that started it unless something keeps a
 * reference, and that a new `speak` while one is mid-sentence has to cancel the
 * old one or the two overlap; both are handled here so callers only ever see
 * "say this, tell me when it's done".
 */
const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;

/** Whether this device can read a card out at all. */
export function speechAvailable() {
  return Boolean(synth && typeof window.SpeechSynthesisUtterance === 'function');
}

let current = null;

/**
 * Say one piece of text, resolving when it has finished (or been cancelled, or
 * failed — a study loop should advance either way, never wedge waiting on the
 * speaker). `rate` is the words-per-minute multiplier the student chose.
 */
export function speak(text, { rate = 1 } = {}) {
  cancelSpeech();
  const words = String(text ?? '').trim();
  if (!speechAvailable() || !words) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const settle = () => { if (!done) { done = true; if (current?.u === u) current = null; resolve(); } };
    const u = new SpeechSynthesisUtterance(words);
    u.rate = Math.min(2, Math.max(0.5, rate));
    u.onend = settle;
    u.onerror = settle;
    current = { u, settle };
    try { synth.speak(u); } catch { settle(); }
  });
}

/** Stop whatever is being read right now. Safe to call when nothing is. */
export function cancelSpeech() {
  const held = current;
  current = null;
  try { synth?.cancel(); } catch { /* nothing was speaking */ }
  held?.settle();
}

/** Whether a card is being read out at this moment. */
export function isSpeaking() {
  return Boolean(current);
}
