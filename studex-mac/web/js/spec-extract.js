/**
 * The text of a specification file, page by page.
 *
 * Done here rather than on the server because the file is already in the
 * browser and the text is a fraction of its size: a 200-page PDF is megabytes,
 * its words are a few hundred kilobytes, and only the words are any use to the
 * model that reads it. Nothing is uploaded that the reader would not see.
 *
 * Three kinds of file, one shape out: `[{ page, text }]`. A PDF has real pages
 * and they are kept, so a topic can say where it came from. A Word document or
 * a text file has none, so it is cut into page-sized pieces at paragraph
 * breaks — the numbers are then positions, not printed page numbers, which is
 * why the import screen does not show them for those files.
 */
import { pdfjs } from './pdf-render.js';

/** About a printed page of a dense specification. */
const PSEUDO_PAGE_CHARS = 3_500;
/** The server's limit per page, less a margin. */
const MAX_PAGE_CHARS = 39_000;
const MAX_PAGES = 1_500;
const MAX_FILE_BYTES = 60 * 1024 * 1024;

export class ExtractError extends Error {}

/** `{ pages, realPages }` — `realPages` is false when the numbers are positions. */
export async function extractSpec(file, { onProgress } = {}) {
  if (file.size > MAX_FILE_BYTES) throw new ExtractError('That file is larger than 60 MB. Import the part with the specification in it.');
  const name = file.name.toLowerCase();

  if (name.endsWith('.pdf') || file.type === 'application/pdf') {
    return { pages: await fromPdf(file, onProgress), realPages: true };
  }
  if (name.endsWith('.docx')) {
    return { pages: paginate(await fromDocx(file)), realPages: false };
  }
  if (name.endsWith('.doc')) {
    throw new ExtractError('An old .doc file cannot be read. Save it as .docx or PDF and try again.');
  }
  if (name.endsWith('.txt') || name.endsWith('.md') || file.type.startsWith('text/')) {
    return { pages: paginate((await file.text()).split(/\r?\n/)), realPages: false };
  }
  throw new ExtractError('Studex can read a specification from a PDF, a Word document (.docx) or a text file.');
}

/* ── PDF ──────────────────────────────────────────────────────────────── */

async function fromPdf(file, onProgress) {
  const lib = await pdfjs();
  const task = lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    await task.destroy();
    throw new ExtractError(err?.name === 'PasswordException'
      ? 'That PDF is password-protected. Remove the password and try again.'
      : 'That PDF could not be opened.');
  }

  try {
    const pages = [];
    const count = Math.min(doc.numPages, MAX_PAGES);
    for (let n = 1; n <= count; n += 1) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      pages.push({ page: n, text: pdfPageText(content.items).slice(0, MAX_PAGE_CHARS) });
      page.cleanup();
      onProgress?.(n, count);
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

/**
 * Text runs into lines. pdf.js marks most line ends itself; where it does not,
 * a change in baseline is the line end. Lines matter here: a specification's
 * references ("3.1.2") are found at the start of one.
 */
function pdfPageText(items) {
  let out = '';
  let lastY = null;
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    const y = item.transform?.[5] ?? null;
    if (lastY !== null && y !== null && Math.abs(y - lastY) > 2 && !out.endsWith('\n')) out += '\n';
    else if (out && !out.endsWith('\n') && !out.endsWith(' ') && item.str && !item.str.startsWith(' ')) out += ' ';
    out += item.str;
    if (item.hasEOL) out += '\n';
    lastY = y;
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ── DOCX ─────────────────────────────────────────────────────────────── */

/**
 * A .docx is a zip, and the words are in one file inside it. Reading the zip
 * by hand is forty lines; a library for it would be the largest file in the
 * app. Only stored and deflated entries exist in a Word file, and the browser
 * inflates.
 */
async function fromDocx(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const xml = await zipEntry(bytes, 'word/document.xml');
  if (!xml) throw new ExtractError('That does not look like a Word document.');

  const doc = new DOMParser().parseFromString(new TextDecoder().decode(xml), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new ExtractError('That Word document could not be read.');

  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const lines = [];
  for (const para of doc.getElementsByTagNameNS(W, 'p')) {
    let line = '';
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.namespaceURI === W && child.localName === 't') line += child.textContent;
        else if (child.namespaceURI === W && child.localName === 'tab') line += '\t';
        else if (child.namespaceURI === W && (child.localName === 'br' || child.localName === 'cr')) line += '\n';
        else if (child.namespaceURI === W && child.localName === 'p') continue; // nested (text boxes): read on its own
        else if (child.nodeType === 1) walk(child);
      }
    };
    walk(para);
    lines.push(line);
  }
  return lines;
}

async function zipEntry(bytes, wanted) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-central-directory record is in the last 64 KB, signature first.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;

  const entries = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();

  for (let n = 0; n < entries && at + 46 <= bytes.length; n += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) return null;
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (name !== wanted) continue;

    if (view.getUint32(localOffset, true) !== 0x04034b50) return null;
    const start = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    const data = bytes.subarray(start, start + compressedSize);
    if (method === 0) return data;
    if (method !== 8) return null;
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return null;
}

/* ── paging ───────────────────────────────────────────────────────────── */

/** Lines into page-sized pieces, broken between lines and never inside one. */
function paginate(lines) {
  const pages = [];
  let current = '';
  const flush = () => {
    if (current.trim()) pages.push({ page: pages.length + 1, text: current.trim() });
    current = '';
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '').slice(0, MAX_PAGE_CHARS);
    if (current.length + line.length + 1 > PSEUDO_PAGE_CHARS && current) flush();
    current += `${line}\n`;
    if (pages.length >= MAX_PAGES) break;
  }
  flush();
  return pages.slice(0, MAX_PAGES);
}
