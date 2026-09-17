/**
 * Inline emphasis, written into the text of a line rather than beside it.
 *
 * A block's text stays a plain string: bold is `**like this**`, italic
 * `*like this*`, underline `__like this__`, highlight `==like this==` (with an
 * optional colour, `==lime|like this==`) and code `` `like this` ``. A
 * reference to another page is `[[Title]]`, a tag is `##name`, and a cloze
 * deletion — a phrase blanked out for recall — is `{like this}`.
 *
 * Storing the marks in the text keeps documents diffable, searchable and free
 * of any markup the client would have to trust — the editor renders them, and
 * this file is the one definition of what they mean. Kept in step with
 * studex-mac/web/js/inline.js.
 */

export interface InlineSegment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  highlight?: boolean;
  hue?: string;
  code?: boolean;
  cloze?: boolean;
  /** The page this run names, when the run is inside `[[ ]]`. */
  link?: string;
  /** The tag this run names, when the run followed `##`. */
  tag?: string;
}

type MarkKey = 'bold' | 'underline' | 'highlight' | 'italic' | 'code';

/** Longest first, so `**` is never read as two italics. */
const MARKS: { token: string; key: MarkKey }[] = [
  { token: '**', key: 'bold' },
  { token: '__', key: 'underline' },
  { token: '==', key: 'highlight' },
  { token: '*', key: 'italic' },
  { token: '`', key: 'code' },
];

/**
 * The colours a highlight can be, named rather than written as a value so the
 * theme decides what each one looks like. The first is the default.
 */
export const HIGHLIGHTS = ['amber', 'lime', 'sky', 'rose', 'violet'];

const LINK_OPEN = '[[';
const LINK_CLOSE = ']]';
/** `##name` runs to the first space, so a tag needs no closing token. */
const TAG_RE = /^##([^\s#]{1,60})/;
const HUE_RE = /^([a-z]{3,8})\|/;

/**
 * Splits a line into runs of text and the emphasis each carries.
 *
 * A mark only opens when its partner appears later in the same line with
 * something between them, so a lone asterisk in `2 * 3` stays an asterisk.
 */
export function parseInline(text: string, active: Omit<InlineSegment, 'text'> = {}): InlineSegment[] {
  const out: InlineSegment[] = [];
  let buffer = '';
  let i = 0;

  const flush = (): void => {
    if (buffer) out.push({ text: buffer, ...active });
    buffer = '';
  };

  while (i < text.length) {
    // Inside code nothing else is notation: a backtick run quotes characters
    // exactly, and an asterisk in it is an asterisk.
    if (!active.code) {
      if (text.startsWith(LINK_OPEN, i)) {
        const close = text.indexOf(LINK_CLOSE, i + LINK_OPEN.length);
        if (close > i + LINK_OPEN.length) {
          flush();
          const name = text.slice(i + LINK_OPEN.length, close);
          out.push({ text: name, ...active, link: name });
          i = close + LINK_CLOSE.length;
          continue;
        }
      }
      const tag = TAG_RE.exec(text.slice(i));
      if (tag?.[1]) {
        flush();
        out.push({ text: tag[1], ...active, tag: tag[1] });
        i += tag[0].length;
        continue;
      }
      if (text[i] === '{' && !active.cloze) {
        const close = text.indexOf('}', i + 1);
        if (close > i + 1) {
          flush();
          out.push(...parseInline(text.slice(i + 1, close), { ...active, cloze: true }));
          i = close + 1;
          continue;
        }
      }
    }

    const mark = active.code ? undefined : MARKS.find((m) => text.startsWith(m.token, i) && !active[m.key]);
    if (mark) {
      const close = text.indexOf(mark.token, i + mark.token.length);
      if (close > i + mark.token.length) {
        flush();
        let from = i + mark.token.length;
        let hue: string | undefined;
        if (mark.key === 'highlight') {
          const named = HUE_RE.exec(text.slice(from, close));
          if (named?.[1] && HIGHLIGHTS.includes(named[1])) {
            hue = named[1];
            from += named[0].length;
          }
        }
        const inner = { ...active, [mark.key]: true, ...(hue ? { hue } : {}) };
        if (mark.key === 'code') {
          if (close > from) out.push({ text: text.slice(from, close), ...inner });
        } else {
          out.push(...parseInline(text.slice(from, close), inner));
        }
        i = close + mark.token.length;
        continue;
      }
    }
    buffer += text[i];
    i += 1;
  }

  flush();
  return out;
}

/** The line as a reader sees it: emphasis applied, marks gone. */
export function stripInlineMarks(text: string): string {
  return parseInline(text)
    .map((segment) => segment.text)
    .join('');
}

/** The pages this line points at, in the order it names them, deduplicated. */
export function inlineLinks(text: string): string[] {
  const names = parseInline(text)
    .map((segment) => segment.link)
    .filter((name): name is string => Boolean(name));
  return [...new Set(names)];
}

/** The tags on this line, without their `##`, deduplicated. */
export function inlineTags(text: string): string[] {
  const names = parseInline(text)
    .map((segment) => segment.tag)
    .filter((name): name is string => Boolean(name));
  return [...new Set(names)];
}

/**
 * The blanked-out phrases in this line, in the order they will be asked.
 *
 * Scanned over the braces directly rather than read back out of `parseInline`:
 * that returns one segment per run of emphasis, so a phrase with a bold word
 * in it would come back as three clozes instead of one.
 */
export function inlineClozes(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '{') {
      i += 1;
      continue;
    }
    const close = text.indexOf('}', i + 1);
    if (close <= i + 1) break;
    out.push(stripInlineMarks(text.slice(i + 1, close)));
    i = close + 1;
  }
  return out;
}
