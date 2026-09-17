import zlib from 'node:zlib';

/**
 * Counting the pages in a PDF, from the bytes, without trusting the client.
 *
 * `page_count` decides whether an annotation's page number is in range. While
 * the client was the only one who knew it, that check could not be made at
 * upload time — the bound arrived after the first write, from the same party
 * the bound is meant to constrain. This reads it off the file instead.
 *
 * It is deliberately a reader, not a parser: no xref table is walked and no
 * object graph is built. A PDF that has been linearised, incrementally
 * updated, or written by something creative still has to state the size of its
 * page tree somewhere, and that is all we are looking for.
 *
 * When the file does not say — or says something that fails to parse — the
 * answer is `null`, not a guess. A wrong bound is worse than no bound: it
 * silently refuses annotations on pages that exist.
 */

/** Object streams above this inflate to nothing useful for our purposes. */
const MAX_INFLATE_BYTES = 32 * 1024 * 1024;
/** No real page tree needs more than this, and PDF page numbers cap at 10,000. */
const MAX_PLAUSIBLE_PAGES = 10_000;

/**
 * `/Type /Pages` with any of the whitespace and comment noise the spec allows
 * between a key and its value. `/Type/Pages`, `/Type  /Pages` and a `/Type`
 * with a newline before `/Pages` are all the same declaration.
 */
const PAGES_NODE = /\/Type\s*\/Pages[\s/>\]]/;
/** `/Type /Page` — the leaf. The trailing class is what keeps `/Pages` out. */
const PAGE_LEAF = /\/Type\s*\/Page[\s/>\]]/g;
const COUNT_KEY = /\/Count\s+(\d+)/g;

/**
 * The largest `/Count` on any page-tree node in this text.
 *
 * The root of the page tree carries the total; interior nodes carry their own
 * subtree. Taking the maximum finds the root without having to identify it,
 * which matters because identifying it means resolving `/Root` through an xref
 * table that may itself be in a compressed stream.
 *
 * Only dictionaries that say `/Type /Pages` are considered. `/Count` is not
 * unique to the page tree — an outline node uses the same key for the number
 * of visible descendants, and an outline can easily be larger than the
 * document. That is the false positive this function exists to avoid.
 */
function largestPageTreeCount(text: string): number | null {
  let best: number | null = null;

  // Objects, not the whole string: /Count has to be read from the same
  // dictionary that declared /Type /Pages, or it proves nothing.
  for (const chunk of text.split('endobj')) {
    if (!PAGES_NODE.test(chunk)) continue;

    COUNT_KEY.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = COUNT_KEY.exec(chunk)) !== null) {
      const n = Number(match[1]);
      if (Number.isSafeInteger(n) && n > 0 && n <= MAX_PLAUSIBLE_PAGES) {
        if (best === null || n > best) best = n;
      }
    }
  }

  return best;
}

/** How many `/Type /Page` leaves this text declares. */
function pageLeafCount(text: string): number {
  PAGE_LEAF.lastIndex = 0;
  let n = 0;
  while (PAGE_LEAF.exec(text) !== null) n += 1;
  return n > 0 && n <= MAX_PLAUSIBLE_PAGES ? n : 0;
}

/**
 * The inflated contents of every FlateDecode stream in the file, concatenated.
 *
 * From PDF 1.5 on, the catalogue and the page tree are routinely packed into
 * compressed object streams, so a scan of the raw bytes finds nothing at all.
 * Streams that are encrypted, use a filter we do not implement, or are simply
 * damaged fail to inflate; those are skipped rather than fatal, because one
 * unreadable image must not cost us a page tree that inflated fine.
 */
function inflatedStreams(text: string, raw: Buffer): string {
  const parts: string[] = [];
  let budget = MAX_INFLATE_BYTES;
  let cursor = 0;

  while (budget > 0) {
    const streamAt = text.indexOf('stream', cursor);
    if (streamAt === -1) break;

    // Only streams whose dictionary asked for Flate. The dictionary is what
    // precedes the keyword, so a bounded look back is enough to classify it.
    const dict = text.slice(Math.max(0, streamAt - 512), streamAt);
    const endAt = text.indexOf('endstream', streamAt);
    if (endAt === -1) break;
    cursor = endAt + 'endstream'.length;
    if (!dict.includes('/FlateDecode')) continue;

    // Past the keyword, the spec allows CRLF or LF — never a bare CR.
    let from = streamAt + 'stream'.length;
    if (text[from] === '\r') from += 1;
    if (text[from] === '\n') from += 1;
    if (endAt <= from) continue;

    try {
      const out = zlib.inflateSync(raw.subarray(from, endAt), { maxOutputLength: budget });
      budget -= out.length;
      parts.push(out.toString('latin1'));
    } catch {
      // Not our stream to read. Encrypted, another filter, or corrupt.
    }
  }

  return parts.join('\n');
}

/**
 * The number of pages in `bytes`, or `null` when the file does not say clearly.
 *
 * Pure and synchronous: it is given the whole file and returns a number, which
 * is what makes the awkward cases (object streams, incremental updates, a
 * page tree that lies) testable without a filesystem.
 */
export function countPdfPages(bytes: Buffer): number | null {
  // latin1 maps bytes to code points one to one, so offsets into the string
  // are offsets into the buffer — which is what lets the stream slices above
  // be taken from the raw bytes rather than from a lossy decode.
  const text = bytes.toString('latin1');

  // An incremental update appends a whole new page tree without removing the
  // old one, so the last word on the subject is the largest /Count present.
  const stated = largestPageTreeCount(text);
  if (stated !== null) return stated;

  const compressed = inflatedStreams(text, bytes);
  if (compressed.length > 0) {
    const inStream = largestPageTreeCount(compressed);
    if (inStream !== null) return inStream;

    const leaves = pageLeafCount(compressed);
    if (leaves > 0) return leaves;
  }

  // No page tree said its size. Counting the leaves is the weaker answer —
  // it cannot see pages that were never written as their own object — but a
  // one-page file that only ever says `/Type /Page` is common enough to be
  // worth reading correctly.
  const leaves = pageLeafCount(text);
  return leaves > 0 ? leaves : null;
}
