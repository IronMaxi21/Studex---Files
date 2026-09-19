/**
 * Inline emphasis inside a line of a document.
 *
 * Bold is `**like this**`, italic `*like this*`, underline `__like this__`,
 * highlight `==like this==` (and `==lime|like this==` for a colour other than
 * the default), coloured text `%%rose|like this%%`, and code `` `like this` ``.
 * A link to another page is `[[Title]]`, a tag is `##name`, and a cloze
 * deletion — a word blanked out for recall — is `{like this}`.
 * The marks live in the line's own text, which is why a document stays a list
 * of plain strings: nothing here produces markup the server has to trust, and
 * a note written on one machine reads the same on another.
 *
 * The rendered line always spells the raw text out in full — the marks are
 * drawn as their own spans and hidden by CSS unless the caret is in the line.
 * That is what keeps the editor honest: `node.textContent` is the stored text,
 * always, so a caret offset on screen is a caret offset in the data and there
 * is no mapping to get wrong.
 *
 * Kept in step with studex-server/src/lib/inline.ts.
 */
import { el } from './dom.js';
import { hasMath, mathSegments, renderMath } from './math.js';

/** Longest first, so `**` is never read as two italics. */
const MARKS = [
  { token: '**', key: 'bold', class: 'em-b' },
  { token: '__', key: 'underline', class: 'em-u' },
  { token: '==', key: 'highlight', class: 'em-h' },
  { token: '%%', key: 'color', class: 'em-k' },
  { token: '*', key: 'italic', class: 'em-i' },
  { token: '`', key: 'code', class: 'em-c' },
];

export const MARK_TOKENS = { bold: '**', italic: '*', underline: '__', highlight: '==', code: '`' };

/**
 * The colours a highlight can be, named rather than written as a value so the
 * theme decides what each one looks like in the end.
 *
 * A highlight with no colour named is the first of these, which is why the
 * plain `==word==` anyone would type by habit still works.
 */
export const HIGHLIGHTS = ['amber', 'lime', 'sky', 'rose', 'violet'];

/**
 * The colours the words themselves can be written in.
 *
 * The same five names as a highlight, so there is one vocabulary of colour in
 * a document rather than two — but drawn at a strength that can be read as
 * text rather than as a wash behind it. `grey` is only here: it says "this
 * line matters less", which is a thing to do to writing and not a thing to do
 * with a highlighter.
 *
 * Unlike a highlight, a colour must be named. `%%word%%` with nothing in
 * front of the bar is not a colour anyone chose, and a pair of stray per-cent
 * signs in a sentence about percentages should stay a pair of per-cent signs.
 */
export const INKS = ['amber', 'lime', 'sky', 'rose', 'violet', 'grey'];

/** `[[Title]]` — a reference to another page, by its title. */
const LINK_OPEN = '[[';
const LINK_CLOSE = ']]';
/** `##name` — runs to the first space, so a tag needs no closing token. */
const TAG_RE = /^##([^\s#]{1,60})/;

/**
 * Splits a line into runs of text and the emphasis each carries. `at` is where
 * the run starts in the raw string, so a caller can map back to it.
 */
export function parseInline(text, active = {}, offset = 0) {
  const out = [];
  let buffer = '';
  let bufferAt = offset;
  let i = 0;

  const flush = () => {
    if (buffer) out.push({ text: buffer, at: bufferAt, ...active });
    buffer = '';
  };

  while (i < text.length) {
    // Inside code nothing else is notation. A backtick run is there to quote
    // characters exactly, and an asterisk in it is an asterisk.
    if (!active.code) {
      // [[Another page]]
      if (text.startsWith(LINK_OPEN, i)) {
        const close = text.indexOf(LINK_CLOSE, i + LINK_OPEN.length);
        if (close > i + LINK_OPEN.length) {
          flush();
          const name = text.slice(i + LINK_OPEN.length, close);
          out.push({ mark: LINK_OPEN, at: offset + i, class: 'em-l' });
          out.push({ text: name, at: offset + i + LINK_OPEN.length, ...active, link: name });
          out.push({ mark: LINK_CLOSE, at: offset + close, class: 'em-l' });
          i = close + LINK_CLOSE.length;
          bufferAt = offset + i;
          continue;
        }
      }
      // ##tag
      const tag = TAG_RE.exec(text.slice(i));
      if (tag) {
        flush();
        out.push({ mark: '##', at: offset + i, class: 'em-t' });
        out.push({ text: tag[1], at: offset + i + 2, ...active, tag: tag[1] });
        i += tag[0].length;
        bufferAt = offset + i;
        continue;
      }
      // {{c1::…}} — an Anki-style grouped cloze. It is one card made of many
      // faces (cards-inline.js), not a per-brace document blank, so the whole
      // token is passed through as plain text and left for that layer to read.
      if (text[i] === '{' && text[i + 1] === '{' && !active.cloze) {
        const close = text.indexOf('}}', i + 2);
        if (close > i + 1) {
          if (!buffer) bufferAt = offset + i;
          buffer += text.slice(i, close + 2);
          i = close + 2;
          continue;
        }
      }
      // {a blanked-out phrase}
      if (text[i] === '{' && !active.cloze) {
        const close = text.indexOf('}', i + 1);
        if (close > i + 1) {
          flush();
          out.push({ mark: '{', at: offset + i, class: 'em-z' });
          out.push(...parseInline(text.slice(i + 1, close), { ...active, cloze: true }, offset + i + 1));
          out.push({ mark: '}', at: offset + close, class: 'em-z' });
          i = close + 1;
          bufferAt = offset + i;
          continue;
        }
      }
    }

    const mark = active.code ? null : MARKS.find((m) => text.startsWith(m.token, i) && !active[m.key]);
    if (mark) {
      const close = text.indexOf(mark.token, i + mark.token.length);
      if (close > i + mark.token.length) {
        let from = i + mark.token.length;
        let hue = null;
        let ink = null;
        // A mark may name a colour first: `==lime|photosynthesis==`, or
        // `%%rose|the exception%%`. The name is drawn as part of the marker
        // rather than as text, so the line still spells out every character it
        // stores. Highlight and colour keep separate fields because a coloured
        // word inside a highlight has both, and one field would lose one.
        const named = /^([a-z]{3,8})\|/.exec(text.slice(from, close));
        if (mark.key === 'highlight' && named && HIGHLIGHTS.includes(named[1])) {
          hue = named[1];
          from += named[0].length;
        }
        if (mark.key === 'color') {
          if (!named || !INKS.includes(named[1])) {
            // Not a colour anyone chose. The per-cent signs are per-cent signs.
            if (!buffer) bufferAt = offset + i;
            buffer += text[i];
            i += 1;
            continue;
          }
          ink = named[1];
          from += named[0].length;
        }
        flush();
        out.push({ mark: text.slice(i, from), at: offset + i, class: mark.class });
        const inner = { ...active, [mark.key]: true, ...(hue ? { hue } : {}), ...(ink ? { ink } : {}) };
        if (mark.key === 'code') {
          // Not recursed into: see above.
          if (close > from) out.push({ text: text.slice(from, close), at: offset + from, ...inner });
        } else {
          out.push(...parseInline(text.slice(from, close), inner, offset + from));
        }
        out.push({ mark: mark.token, at: offset + close, class: mark.class });
        i = close + mark.token.length;
        bufferAt = offset + i;
        continue;
      }
    }
    if (!buffer) bufferAt = offset + i;
    buffer += text[i];
    i += 1;
  }

  flush();
  return out;
}

/** The line as a reader sees it: emphasis applied, marks gone. */
export function stripMarks(text) {
  return parseInline(text).filter((s) => !s.mark).map((s) => s.text).join('');
}

/** The pages this line points at, in the order it names them, deduplicated. */
export function inlineLinks(text) {
  return [...new Set(parseInline(text).filter((s) => s.link).map((s) => s.link))];
}

/** The tags on this line, without their `##`, deduplicated. */
export function inlineTags(text) {
  return [...new Set(parseInline(text).filter((s) => s.tag).map((s) => s.tag))];
}

/**
 * The blanked-out phrases in this line, in order.
 *
 * One card is made per phrase, so the order is the order they will be asked
 * in, and a line with none of them is not a cloze at all.
 */
export function inlineClozes(text) {
  const out = [];
  let depth = 0;
  let buffer = '';
  for (const segment of parseInline(text)) {
    if (segment.mark === '{') { depth += 1; buffer = ''; continue; }
    if (segment.mark === '}') {
      depth -= 1;
      if (depth === 0 && buffer) out.push(buffer);
      continue;
    }
    if (depth > 0 && segment.text) buffer += segment.text;
  }
  return out;
}

/**
 * The line with one cloze blanked and the rest of them merely revealed.
 *
 * `which` is a zero-based index over `inlineClozes`. The blank is drawn with
 * the same number of underscores whatever the word was, because a blank whose
 * width gives the answer away is not a test of anything.
 */
export function clozeQuestion(text, which) {
  let index = -1;
  let depth = 0;
  let out = '';
  for (const segment of parseInline(text)) {
    if (segment.mark === '{') {
      depth += 1;
      // Only the outermost brace starts a new blank; a brace inside one is
      // part of the phrase being hidden, not a second question.
      if (depth === 1) {
        index += 1;
        if (index === which) out += '[…]';
      }
      continue;
    }
    if (segment.mark === '}') { depth -= 1; continue; }
    if (segment.mark) continue;
    if (depth > 0 && index === which) continue;
    out += segment.text;
  }
  return out;
}

/**
 * The line as nodes. The marker characters are kept as `.mk` spans rather than
 * dropped, so the rendered text is character-for-character the stored text.
 */
export function renderInline(text) {
  return renderMarks(text, { arrowed: false });
}

/**
 * The same line, with its equations typeset.
 *
 * This one deliberately breaks the character-for-character rule above, so it
 * is only ever used on a line the caret is not in: a rendered equation is a
 * `contenteditable="false"` island whose text has nothing to do with the
 * `$x^2$` it stands for, and a caret offset measured across it would be wrong.
 * The editor paints a line this way at rest and repaints it plain the moment
 * it takes focus, which is the only reason the offsets can be trusted
 * everywhere else.
 *
 * The maths is lifted out before the emphasis pass for the same reason it is
 * in the tutor's answers: `$a * b * c$` run through the italic rule first
 * comes back with the middle eaten.
 */
export function renderTypeset(text) {
  const raw = String(text ?? '');
  if (!hasMath(raw)) return renderInline(raw);
  const state = { arrowed: false };
  const out = [];
  for (const seg of mathSegments(raw)) {
    if (seg.type === 'text') { out.push(...renderMarks(seg.value, state)); continue; }
    const node = el('span', { class: 'em-math', contenteditable: 'false' });
    renderMath(node, seg.value, { display: false });
    out.push(node);
  }
  return out;
}

function renderMarks(text, state) {
  return parseInline(text).flatMap((segment) => {
    if (segment.mark) return el('span', { class: 'mk ' + segment.class, text: segment.mark });
    // A card's `::` is drawn as an arrow, RemNote style. The two colons stay in
    // the DOM (only painted over), so caret offsets still match the stored text.
    if (!state.arrowed && !segment.code && segment.text) {
      const match = /(^|\s)::(?=\s|$)/.exec(segment.text);
      if (match) {
        state.arrowed = true;
        const at = match.index + match[1].length;
        return [
          ...renderSegment({ ...segment, text: segment.text.slice(0, at) }),
          el('span', { class: 'card-arrow', text: '::', 'aria-label': 'answer' }),
          ...renderSegment({ ...segment, text: segment.text.slice(at + 2) }),
        ];
      }
    }
    return renderSegment(segment);
  });
}

function renderSegment(segment) {
  if (!segment.text) return [];
  return [(() => {
    const classes = [
      segment.bold ? 'em-b' : null,
      segment.italic ? 'em-i' : null,
      segment.underline ? 'em-u' : null,
      segment.code ? 'em-c' : null,
      segment.cloze ? 'em-z' : null,
      segment.link ? 'em-l' : null,
      segment.tag ? 'em-t' : null,
      // A highlight with no colour named takes the first one, so `==word==`
      // typed out of habit still lands somewhere deliberate.
      segment.highlight ? `em-h hl-${segment.hue ?? HIGHLIGHTS[0]}` : null,
      // A colour always names itself — the parser refuses the mark otherwise —
      // so there is no default to fall back to here.
      segment.ink ? `em-k tx-${segment.ink}` : null,
    ].filter(Boolean);
    if (!classes.length) return document.createTextNode(segment.text);
    // A link and a tag carry what they point at, so a click has something to
    // go on without having to re-read the line around it.
    const props = { class: classes.join(' '), text: segment.text };
    if (segment.link) props['data-link'] = segment.link;
    if (segment.tag) props['data-tag'] = segment.tag;
    return el('span', props);
  })()];
}

/**
 * Adds or removes one kind of emphasis over a range of the raw text.
 *
 * Toggling off is the same gesture as toggling on, so a selection that is
 * already wrapped has its marks taken away rather than a second pair added.
 * Returns the new text and where the selection should sit in it.
 */
export function toggleMark(text, start, end, key) {
  const token = MARK_TOKENS[key];
  if (!token) return { text, start, end };
  const width = token.length;

  const wrappedOutside = text.slice(start - width, start) === token && text.slice(end, end + width) === token;
  if (wrappedOutside) {
    return {
      text: text.slice(0, start - width) + text.slice(start, end) + text.slice(end + width),
      start: start - width,
      end: end - width,
    };
  }

  const wrappedInside =
    end - start >= width * 2 &&
    text.slice(start, start + width) === token &&
    text.slice(end - width, end) === token;
  if (wrappedInside) {
    return {
      text: text.slice(0, start) + text.slice(start + width, end - width) + text.slice(end),
      start,
      end: end - width * 2,
    };
  }

  // An empty selection opens an empty pair and leaves the caret inside it, so
  // the button works before the words exist as well as after.
  return {
    text: text.slice(0, start) + token + text.slice(start, end) + token + text.slice(end),
    start: start + width,
    end: end + width,
  };
}

/* ── caret ────────────────────────────────────────────────────────────── */

/** Where the selection sits in `node`, counted in characters of its text. */
export function caretRange(node) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!node.contains(range.startContainer)) return null;

  const before = document.createRange();
  before.selectNodeContents(node);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  return { start, end: start + range.toString().length };
}

/** Puts the selection back at a character range of `node`. */
export function setCaretRange(node, start, end = start) {
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let seen = 0;
  let placedStart = false;
  let text = walker.nextNode();

  if (!text) {
    range.selectNodeContents(node);
    range.collapse(true);
  }

  while (text) {
    const length = text.textContent.length;
    if (!placedStart && seen + length >= start) {
      range.setStart(text, start - seen);
      placedStart = true;
    }
    if (placedStart && seen + length >= end) {
      range.setEnd(text, end - seen);
      break;
    }
    seen += length;
    const next = walker.nextNode();
    if (!next) {
      if (!placedStart) range.setStart(text, length);
      range.setEnd(text, length);
      break;
    }
    text = next;
  }

  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}
