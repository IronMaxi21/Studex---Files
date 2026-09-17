/**
 * Inline flashcards, RemNote style: a line that reads `question == answer` is
 * a card. This module owns the parsing and the round trip to the API so the
 * editor only has to say "this line changed".
 */
import { api } from './api.js';
import { loadLibrary, toast, reportError } from './store.js';

/**
 * The ways a line can say "this is a card", most specific first.
 *
 * `==` is Studex's own. The others are RemNote's, and they are here so
 * that notes brought over from RemNote keep working when they are edited —
 * and so that anyone with the habit can keep typing them.
 *
 * `==` is also the highlight mark (see inline.js), and the two do not
 * collide: a highlight is written `==like this==`, tight against its text,
 * while separatorAt below only accepts a `==` with whitespace on both sides.
 * `The ==key== idea == it matters` is therefore one highlight and one card,
 * read the way it looks.
 */
export const SEPARATORS = ['::', ';;', '->', '>>', '=='];

/**
 * Where a separator begins, or -1.
 *
 * It has to stand on its own with space around it. Without that rule
 * `std::vector` is a card whose answer is "vector", and a line of C++ in a
 * revision note would quietly turn into a flashcard.
 */
function separatorAt(text, separator) {
  const pattern = new RegExp(`(?:^|\\s)${separator.replace(/[.*+?^$}{()|[\]\\]/g, '\\$&')}(?=\\s|$)`);
  const match = pattern.exec(text);
  return match ? match.index + match[0].length - separator.length : -1;
}

export function parseCard(text) {
  const raw = text ?? '';
  for (const separator of SEPARATORS) {
    const at = separatorAt(raw, separator);
    if (at === -1) continue;
    const front = raw.slice(0, at).trim();
    const back = raw.slice(at + separator.length).trim();
    // The first separator that stands alone decides the line, whether or not
    // both sides are filled in — a half-written card is not a card with some
    // other separator further along.
    return front && back ? { front, back } : null;
  }
  return null;
}

/* ------------------------------ cloze cards ------------------------------- */

/**
 * Anki-style grouped cloze: `The {{c1::mitochondria}} is the {{c2::powerhouse}}
 * of the cell`. One sentence, several cards — each group number is a face that
 * blanks its own deletions and reveals the others, and two deletions that share
 * a number are blanked together. A deletion may carry a hint after a second
 * pair of colons: `{{c1::Paris::capital}}`.
 *
 * This is deliberately its own syntax, double-braced, so it never collides with
 * the single-brace `{blank}` the document editor turns into one card per blank
 * (see inline.js). A double-brace card is stored once, with the markup kept on
 * its front, and drawn as many by cardFaces below.
 */
const CLOZE_RE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;

/** True when the text carries at least one `{{cN::…}}` deletion. */
export function isCloze(text) {
  return /\{\{c\d+::[\s\S]*?\}\}/.test(text ?? '');
}

/** The distinct group numbers in the text, ascending: `[1, 2, …]`. */
export function clozeGroups(text) {
  const groups = new Set();
  for (const m of (text ?? '').matchAll(CLOZE_RE)) groups.add(Number(m[1]));
  return [...groups].sort((a, b) => a - b);
}

/** The sentence with every deletion filled back in — what search, exports and
 *  the deck list show instead of raw markup. */
export function clozePlain(text) {
  return (text ?? '').replace(CLOZE_RE, (_, _g, ans) => ans);
}

/**
 * One face of a cloze card: group `n` blanked, every other deletion revealed.
 *   question — group `n` shown as its hint in brackets, or `[…]`
 *   answer   — the whole sentence filled in
 *   tested   — the word(s) group `n` was hiding, for an aria label
 */
export function clozeFace(text, n) {
  const raw = text ?? '';
  const question = raw.replace(CLOZE_RE, (_, g, ans, hint) =>
    Number(g) === n ? (hint ? `[${hint}]` : '[…]') : ans);
  const answer = clozePlain(raw);
  const tested = [];
  for (const m of raw.matchAll(CLOZE_RE)) if (Number(m[1]) === n) tested.push(m[2]);
  return { question, answer, tested: tested.join(', ') };
}

/**
 * What a card shows on its front and back in the review loop, cloze cards
 * included. A cloze card rotates through its groups by how often it has been
 * seen, so one stored card is genuinely a different question sitting to sitting;
 * a plain card just honours `reverse`.
 */
export function cardFaces(card, reverse = false) {
  const front = card?.front ?? '';
  if (isCloze(front)) {
    const groups = clozeGroups(front);
    const n = groups[Math.max(0, card?.repetitions ?? 0) % groups.length] ?? groups[0];
    const { question, answer, tested } = clozeFace(front, n);
    return { front: question, back: answer, cloze: true, group: n, tested };
  }
  return reverse
    ? { front: card?.back ?? '', back: front }
    : { front, back: card?.back ?? '' };
}

/**
 * A cloze line read as a card, or null. The front keeps the `{{cN::…}}` markup
 * — it is the one source every face is drawn from — while the back holds the
 * plain sentence, so nothing that only reads `back` shows the braces.
 */
export function parseCloze(text) {
  const raw = (text ?? '').trim();
  if (!isCloze(raw)) return null;
  return { front: raw, back: clozePlain(raw) };
}


/**
 * One companion deck per document, resolved once and reused. The server side
 * is idempotent, so a second call during a race is harmless.
 */
/**
 * A line that asks a question but has not answered it on the line itself:
 * `Causes of the war ::`, with the causes indented underneath.
 *
 * `parseCard` refuses that, and rightly — on its own it is a card half typed.
 * It is only a card to a caller that can see the lines under it, which is why
 * this hands back the question and leaves finding the answer to them.
 */
export function openCard(text) {
  const raw = text ?? '';
  for (const separator of SEPARATORS) {
    const at = separatorAt(raw, separator);
    if (at === -1) continue;
    const front = raw.slice(0, at).trim();
    const back = raw.slice(at + separator.length).trim();
    return front && !back ? { front, separator } : null;
  }
  return null;
}

export function deckResolver(fileId) {
  let pending = null;
  return () => {
    if (!pending) pending = api.documentDeck(fileId).then((r) => r.deck);
    return pending;
  };
}

/**
 * Brings the card for one line into line with its text.
 *
 * A line that no longer reads as a card keeps its card and its link, and is
 * simply left alone. Two reasons: the card may already carry review history
 * that a keystroke has no business discarding, and a card imported from a
 * cloze deletion never had a separator in its line to begin with — unlinking
 * on "no separator found" would throw those away the moment they were touched.
 * Removing a card is something the deck does, on purpose.
 */
export async function syncCard({ text, cardId, getDeck }) {
  const parsed = parseCloze(text) ?? parseCard(text);
  if (!parsed) return { cardId: cardId ?? null, changed: false };

  try {
    if (cardId) {
      await api.updateCard(cardId, { front: parsed.front, back: parsed.back });
      return { cardId, changed: false };
    }
    const deck = await getDeck();
    const { card } = await api.createCard({
      deckId: deck.id,
      front: parsed.front,
      back: parsed.back,
    });
    await loadLibrary();
    toast(`Card added to \u201c${deck.title}\u201d.`);
    return { cardId: card.id, changed: true, deck };
  } catch (err) {
    reportError(err);
    return { cardId: cardId ?? null, changed: false, failed: true };
  }
}
