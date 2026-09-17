/**
 * "Export everything" — the whole account, as files a person owns.
 *
 * Sync is a mirror, and a mirror faithfully reproduces a deletion. This is the
 * other thing: one archive, written in formats that outlive this program, that
 * can be opened on a computer which has never heard of Studex.
 *
 * So nothing here is a Studex file. Documents come out as Markdown, because
 * the blocks already store Markdown's own marks. Canvases come out as SVG,
 * which every browser and every drawing program reads, alongside the objects
 * they were drawn from so nothing is quietly lost in the picture. PDFs come
 * out as the bytes that were uploaded, unchanged. What is left — the review
 * schedule, the calendar, the shape of the library — is JSON, because it is
 * data rather than a document and pretending otherwise would only make it
 * harder to read back.
 *
 * The whole archive is produced as a stream: entries are read from the
 * database as the zip writer asks for them, and a PDF passes through without
 * ever being held. A degree's worth of notes should not have to fit in memory
 * to be rescued from an app.
 */
import type { Block } from './documents.js';
import type { CanvasObject } from './canvas.js';
import { getCanvas } from './canvas.js';
import { getDocument } from './documents.js';
import { requireImage, type ImageRow } from './images.js';
import { listEvents } from './calendar.js';
import { listCards, deckStats } from './flashcards.js';
import { listFolders, listSubjects, listFiles, storageUsage } from './library.js';
import { exportAnnotations, requirePdf } from './pdf.js';
import { getAccountSettings } from './settings.js';
import { log } from '../lib/log.js';
import { blobReadStream } from '../lib/storage.js';
import { zipName, type ZipEntry } from '../lib/zip.js';

/** Files are read a page at a time, so a large library never lands at once. */
const PAGE = 200;
/** Cards likewise. A deck of ten thousand is unusual but not impossible. */
const CARD_PAGE = 500;

/* ------------------------------- file names ------------------------------- */

/**
 * A title as a filename.
 *
 * The reserved set is the union of what Windows, macOS and Linux refuse
 * between them, because an archive is opened wherever it is carried. Trailing
 * dots and spaces go for the same reason: Windows silently drops them, which
 * turns two different names into one collision on somebody else's machine.
 */
function safeName(title: string, fallback = 'Untitled'): string {
  const cleaned = title
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 80)
    .trim();
  return cleaned || fallback;
}

/**
 * Keeps every path in the archive distinct.
 *
 * Two notes may perfectly well be called "Week 3", and on a case-insensitive
 * filesystem "week 3" is the same note again. Rather than let one overwrite
 * the other on extraction, the second gets a number — the way a download
 * folder does it, because that is the convention a person already reads.
 */
function uniquePaths(): (path: string) => string {
  const taken = new Set<string>();
  return (path: string): string => {
    const clean = zipName(path);
    if (!taken.has(clean.toLowerCase())) {
      taken.add(clean.toLowerCase());
      return clean;
    }
    const dot = clean.lastIndexOf('.');
    const slash = clean.lastIndexOf('/');
    const stem = dot > slash ? clean.slice(0, dot) : clean;
    const ext = dot > slash ? clean.slice(dot) : '';
    for (let n = 2; ; n += 1) {
      const candidate = `${stem} (${n})${ext}`;
      if (!taken.has(candidate.toLowerCase())) {
        taken.add(candidate.toLowerCase());
        return candidate;
      }
    }
  };
}

/**
 * The library's folder tree as directory paths.
 *
 * A folder whose parent is missing, or which has somehow been made its own
 * ancestor, is treated as a root — a broken row should cost its own folder its
 * place in the tree, not make the export loop forever.
 */
type FolderNode = { id: string; name: string; parent_id: string | null };

function folderPaths(folders: FolderNode[]): Map<string, string> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const paths = new Map<string, string>();

  for (const folder of folders) {
    const parts: string[] = [];
    const seen = new Set<string>();
    let current: FolderNode | undefined = folder;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      parts.unshift(safeName(current.name, 'Folder'));
      current = current.parent_id ? byId.get(current.parent_id) : undefined;
    }
    paths.set(folder.id, parts.join('/'));
  }
  return paths;
}

/** How many `../` it takes to get from a file back to the archive's root. */
function upToRoot(path: string): string {
  return '../'.repeat(path.split('/').length - 1);
}

/* -------------------------------- markdown -------------------------------- */

/** A table cell cannot contain a pipe or a newline without breaking the row. */
function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * A document as Markdown.
 *
 * Block text is already stored with Markdown's own marks — `**bold**`,
 * `*italic*` — so prose passes straight through. Underline, which Markdown has
 * no syntax for, stays as the `__underline__` it was written as; a renderer
 * will show it as bold, which is wrong but readable, and the alternative was
 * putting HTML tags into a text file.
 *
 * `link` resolves a reference to another file in the archive, and returns null
 * when there is nothing to point at.
 */
function documentMarkdown(
  title: string,
  blocks: Block[],
  link: (kind: 'image' | 'pdf' | 'canvas', id: string) => string | null,
): string {
  const lines: string[] = [`# ${title}`, ''];

  for (const block of blocks) {
    switch (block.type) {
      case 'heading':
        // The title is the document's only H1, so a heading starts one below
        // it and the file has a single outline rather than two.
        lines.push(`${'#'.repeat(block.level + 1)} ${block.text}`, '');
        break;
      case 'paragraph':
        lines.push(block.text, '');
        break;
      case 'bullet':
        lines.push(`${'  '.repeat(block.indent)}- ${block.text}`);
        break;
      case 'numbered':
        // Every line is "1." on purpose: Markdown renumbers an ordered list
        // itself, and a list that says 1, 1, 1 survives a line being deleted.
        lines.push(`${'  '.repeat(block.indent)}1. ${block.text}`);
        break;
      case 'todo':
        lines.push(`- [${block.done ? 'x' : ' '}] ${block.text}`);
        break;
      case 'divider':
        lines.push('', '---', '');
        break;
      case 'code':
        lines.push(`\`\`\`${block.language ?? ''}`, block.text, '```', '');
        break;
      case 'math':
        // Dollar-delimited, which is what every Markdown renderer that does
        // mathematics at all expects, and what the source was typed as anyway.
        lines.push('$$', block.latex, '$$', '');
        if (block.caption) lines.push(`_${block.caption}_`, '');
        break;
      case 'flashcard':
        lines.push(`> **Q.** ${cell(block.front)}`, '>', `> **A.** ${cell(block.back)}`, '');
        break;
      case 'table': {
        lines.push('');
        const head = block.rowLabels ? ['', ...block.columns] : block.columns;
        lines.push(`| ${head.map(cell).join(' | ')} |`);
        lines.push(`| ${head.map(() => '---').join(' | ')} |`);
        block.rows.forEach((row, i) => {
          const cells = block.rowLabels ? [block.rowLabels[i] ?? '', ...row] : [...row];
          // A short row is padded so the table stays rectangular; a renderer
          // given a ragged one drops the columns it cannot account for.
          while (cells.length < head.length) cells.push('');
          lines.push(`| ${cells.map(cell).join(' | ')} |`);
        });
        lines.push('');
        break;
      }
      case 'image': {
        const href = link('image', block.imageId);
        const alt = block.alt ?? block.caption ?? 'Image';
        lines.push(href ? `![${cell(alt)}](${href})` : `_[missing image: ${cell(alt)}]_`, '');
        if (block.caption) lines.push(`_${block.caption}_`, '');
        break;
      }
      case 'pdf': {
        const href = link('pdf', block.fileId);
        lines.push(
          href ? `[PDF, page ${block.page}](${href})` : `_[missing PDF, page ${block.page}]_`,
          '',
        );
        break;
      }
      case 'canvas': {
        const href = link('canvas', block.fileId);
        const alt = block.caption ?? 'Canvas';
        lines.push(href ? `![${cell(alt)}](${href})` : `_[missing canvas: ${cell(alt)}]_`, '');
        if (block.caption) lines.push(`_${block.caption}_`, '');
        break;
      }
      default:
        break;
    }
  }

  // Lists are written line by line above, so the blank lines that separate a
  // list from the prose around it are normalised here rather than counted.
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

/* ----------------------------------- svg ---------------------------------- */

/**
 * The colour roles, resolved for a file that has to look the same everywhere.
 *
 * On screen these are `oklch(var(--folder-l) var(--folder-c) <hue>)`, which
 * follows the theme. An exported drawing has no theme to follow and may be
 * opened by something that has never implemented oklch, so the roles are
 * flattened here to the sRGB the light theme resolves them to.
 */
const ROLE_HEX: Record<string, string> = {
  accent: '#4c4671',
  'accent-2': '#4c4671',
  violet: '#4c4671',
  sky: '#25526f',
  teal: '#055959',
  lime: '#385631',
  amber: '#61481b',
  rose: '#6e3d3d',
  neutral: '#6b6b76',
};

function colorHex(color: string | null | undefined): string {
  if (color && /^#[0-9a-fA-F]{6}$/.test(color)) return color;
  return (color && ROLE_HEX[color]) || ROLE_HEX['accent']!;
}

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const FONT_SIZE = 14;
const LINE_HEIGHT = 19;
/** Average glyph width as a fraction of the size, for a proportional face. */
const GLYPH_RATIO = 0.52;

/**
 * Text laid out by hand, because SVG has no text wrapping.
 *
 * `foreignObject` would wrap it properly but is not rendered by half the
 * programs that open an SVG, and a drawing whose every note is blank in
 * Preview is not an export. So the words are measured approximately and
 * broken into `tspan`s, which everything draws.
 */
function wrapped(text: string, x: number, y: number, width: number, fill: string): string {
  const columns = Math.max(6, Math.floor(width / (FONT_SIZE * GLYPH_RATIO)));
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    if (!paragraph.trim()) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (!line) line = word;
      else if (line.length + 1 + word.length <= columns) line += ` ${word}`;
      else {
        lines.push(line);
        line = word;
      }
      // A single unbroken run — a URL, a chemical name — is cut rather than
      // allowed to run off the side of the note it is in.
      while (line.length > columns) {
        lines.push(line.slice(0, columns));
        line = line.slice(columns);
      }
    }
    if (line) lines.push(line);
  }

  const spans = lines
    .slice(0, 40)
    .map((line, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : LINE_HEIGHT}">${xml(line)}</tspan>`)
    .join('');
  return `<text x="${x}" y="${y + FONT_SIZE}" font-size="${FONT_SIZE}" fill="${fill}" font-family="Helvetica, Arial, sans-serif">${spans}</text>`;
}

/** Where a connector should attach: the middle of whatever it points at. */
function centre(object: CanvasObject): { x: number; y: number } {
  if (object.type === 'ink') {
    const xs = object.points.map((p) => p[0]!);
    const ys = object.points.map((p) => p[1]!);
    return {
      x: (Math.min(...xs) + Math.max(...xs)) / 2,
      y: (Math.min(...ys) + Math.max(...ys)) / 2,
    };
  }
  if (object.type === 'line') {
    const xs = object.points.map((p) => p[0]);
    const ys = object.points.map((p) => p[1]);
    return {
      x: (Math.min(...xs) + Math.max(...xs)) / 2,
      y: (Math.min(...ys) + Math.max(...ys)) / 2,
    };
  }
  if (object.type === 'connector') return { x: object.x, y: object.y };
  return { x: object.x + object.width / 2, y: object.y + object.height / 2 };
}

/**
 * A canvas as a drawing.
 *
 * The viewBox is the canvas's own contents rather than the viewport it was
 * last looked at through — where the student had scrolled to is not part of
 * the drawing, and an export cropped to it would be a screenshot.
 */
function canvasSvg(title: string, objects: CanvasObject[], background: string): string {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const object of objects) {
    if (object.type === 'connector') continue;
    if (object.type === 'ink' || object.type === 'line') {
      for (const point of object.points) {
        xs.push(point[0]!);
        ys.push(point[1]!);
      }
    } else {
      xs.push(object.x, object.x + object.width);
      ys.push(object.y, object.y + object.height);
    }
  }

  const pad = 40;
  const minX = (xs.length ? Math.min(...xs) : 0) - pad;
  const minY = (ys.length ? Math.min(...ys) : 0) - pad;
  const width = Math.max(320, (xs.length ? Math.max(...xs) : 0) + pad - minX);
  const height = Math.max(240, (ys.length ? Math.max(...ys) : 0) + pad - minY);

  const byId = new Map(objects.map((o) => [o.id, o]));
  const body: string[] = [];

  // The paper. Squares and lines are patterns; dots are quiet enough on screen
  // that on a white page they are better left off than drawn ten thousand
  // times.
  if (background === 'squares' || background === 'lines') {
    const rule = '#e4e4ea';
    body.push(
      `<defs><pattern id="paper" width="24" height="24" patternUnits="userSpaceOnUse">` +
        (background === 'squares'
          ? `<path d="M24 0H0v24" fill="none" stroke="${rule}" stroke-width="1"/>`
          : `<path d="M0 24h24" fill="none" stroke="${rule}" stroke-width="1"/>`) +
        `</pattern></defs>`,
      `<rect x="${minX}" y="${minY}" width="${width}" height="${height}" fill="url(#paper)"/>`,
    );
  }

  // Connectors first, so a line always passes behind the things it joins.
  for (const object of objects) {
    if (object.type !== 'connector') continue;
    const from = byId.get(object.fromId);
    const to = byId.get(object.toId);
    if (!from || !to) continue;
    const a = centre(from);
    const b = centre(to);
    body.push(
      `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#6b6b76" stroke-width="1.5"/>`,
    );
    if (object.label) {
      body.push(
        `<text x="${(a.x + b.x) / 2}" y="${(a.y + b.y) / 2 - 6}" font-size="12" fill="#6b6b76" text-anchor="middle" font-family="Helvetica, Arial, sans-serif">${xml(object.label)}</text>`,
      );
    }
  }

  for (const object of objects) {
    switch (object.type) {
      case 'note': {
        const stroke = colorHex(object.color);
        const fill = object.fill ? colorHex(object.fill) : '#ffffff';
        const dash = object.strokeStyle === 'dashed' ? ' stroke-dasharray="9 6"'
          : object.strokeStyle === 'dotted' ? ' stroke-dasharray="1 5" stroke-linecap="round"' : '';
        const cx = object.x + object.width / 2;
        const cy = object.y + object.height / 2;
        body.push(
          object.shape === 'ellipse'
            ? `<ellipse cx="${cx}" cy="${cy}" rx="${object.width / 2}" ry="${object.height / 2}" fill="${fill}" stroke="${stroke}" stroke-width="${object.stroke}"${dash} opacity="${object.opacity}"/>`
            : object.shape === 'diamond'
              ? `<polygon points="${cx},${object.y} ${object.x + object.width},${cy} ${cx},${object.y + object.height} ${object.x},${cy}" fill="${fill}" stroke="${stroke}" stroke-width="${object.stroke}"${dash} opacity="${object.opacity}"/>`
              : `<rect x="${object.x}" y="${object.y}" width="${object.width}" height="${object.height}" rx="${object.shape === 'square' ? 0 : 10}" fill="${fill}" stroke="${stroke}" stroke-width="${object.stroke}"${dash} opacity="${object.opacity}"/>`,
          wrapped(object.text, object.x + 12, object.y + 10, object.width - 24, '#101014'),
        );
        break;
      }
      case 'flashcard': {
        const half = object.height / 2;
        body.push(
          `<rect x="${object.x}" y="${object.y}" width="${object.width}" height="${object.height}" rx="10" fill="#ffffff" stroke="#4c4671" stroke-width="1.5"/>`,
          `<line x1="${object.x}" y1="${object.y + half}" x2="${object.x + object.width}" y2="${object.y + half}" stroke="#4c4671" stroke-width="1" stroke-dasharray="4 3"/>`,
          wrapped(object.front, object.x + 12, object.y + 10, object.width - 24, '#101014'),
          wrapped(object.back, object.x + 12, object.y + half + 10, object.width - 24, '#4c4671'),
        );
        break;
      }
      case 'ink': {
        const points = object.points.map((p) => `${p[0]!},${p[1]!}`).join(' ');
        body.push(
          `<polyline points="${points}" fill="none" stroke="${colorHex(object.color)}" stroke-width="${object.stroke}" stroke-linecap="round" stroke-linejoin="round"/>`,
        );
        break;
      }
      case 'image': {
        // The picture itself is in Images/ and its link is in the document
        // that uses it; here it is a labelled frame, because an SVG pointing
        // at a file beside it would break the moment either one moved.
        body.push(
          `<rect x="${object.x}" y="${object.y}" width="${object.width}" height="${object.height}" rx="6" fill="#f2f2f5" stroke="#b4b4bd" stroke-width="1"/>`,
          wrapped(object.alt ?? 'Image', object.x + 10, object.y + 10, object.width - 20, '#6b6b76'),
        );
        break;
      }
      case 'pdf_excerpt': {
        body.push(
          `<rect x="${object.x}" y="${object.y}" width="${object.width}" height="${object.height}" rx="6" fill="#ffffff" stroke="#b4b4bd" stroke-width="1"/>`,
          `<rect x="${object.x}" y="${object.y}" width="3" height="${object.height}" fill="#4c4671"/>`,
          wrapped(
            `${object.quotedText ?? ''}\n\npage ${object.page}`.trim(),
            object.x + 14,
            object.y + 10,
            object.width - 26,
            '#101014',
          ),
        );
        break;
      }
      case 'text': {
        body.push(wrapped(object.text, object.x, object.y, object.width, colorHex(object.color)));
        break;
      }
      case 'frame': {
        // A frame is the box its contents sit in, so it is drawn as an outline
        // with its name above it and nothing filled in behind — anything else
        // would paint over the very elements it was grouping.
        body.push(
          `<rect x="${object.x}" y="${object.y}" width="${object.width}" height="${object.height}" rx="8" fill="none" stroke="${colorHex(object.color)}" stroke-width="1.5"/>`,
          `<text x="${object.x}" y="${object.y - 6}" font-size="12" fill="${colorHex(object.color)}" font-family="Helvetica, Arial, sans-serif">${xml(object.name ?? 'Frame')}</text>`,
        );
        break;
      }
      case 'line': {
        const points = object.points.map((p) => `${p[0]!},${p[1]!}`).join(' ');
        const dash = object.strokeStyle === 'dashed' ? ' stroke-dasharray="9 6"'
          : object.strokeStyle === 'dotted' ? ' stroke-dasharray="1 5"' : '';
        body.push(
          `<polyline points="${points}" fill="none" stroke="${colorHex(object.color)}" stroke-width="${object.stroke}" stroke-linecap="round" stroke-linejoin="round"${dash} opacity="${object.opacity}"/>`,
        );
        if (object.label) {
          const mid = centre(object);
          body.push(
            `<text x="${mid.x}" y="${mid.y - 6}" font-size="12" fill="${colorHex(object.color)}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif">${xml(object.label)}</text>`,
          );
        }
        break;
      }
      default:
        break;
    }
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${width} ${height}" width="${width}" height="${height}">`,
    `<title>${xml(title)}</title>`,
    `<rect x="${minX}" y="${minY}" width="${width}" height="${height}" fill="#ffffff"/>`,
    ...body,
    '</svg>',
  ].join('\n');
}

/* --------------------------------- readme --------------------------------- */

function readme(at: number, counts: Record<string, number>): string {
  return `# Your Studex data

Exported ${new Date(at).toISOString()}.

Everything in this archive is a plain file. Nothing in it needs Studex, or any
other program in particular, to be read.

## What is here

- \`Notes/\` — ${counts['doc'] ?? 0} document(s) as Markdown, in the folders they
  were filed under. Bold and italic are written the way Markdown writes them.
  Underline has no Markdown syntax and is left as \`__underline__\`, which most
  renderers show as bold.
- \`Canvases/\` — ${counts['canvas'] ?? 0} canvas(es). Each is an SVG, which any
  browser will open, next to a \`.json\` of the objects it was drawn from — in
  case you ever want the drawing back rather than a picture of it.
- \`PDFs/\` — ${counts['pdf'] ?? 0} PDF(s), byte for byte as they were uploaded.
  Any highlights and notes made on one are beside it as \`.annotations.md\`.
- \`Images/\` — the pictures used in the documents, linked from them.
- \`decks.json\` — ${counts['deck'] ?? 0} deck(s) and every card in them, with the
  review schedule: when each card is next due, how many times it has been seen
  and how it has been going.
- \`calendar.json\` — exams, deadlines, classes and study blocks.
- \`library.json\` — subjects, folders and the list of files, so the shape of
  the library is recoverable even though the folders are here as folders.
- \`settings.json\` — your account preferences.

## Reading it

Markdown is text: open it in anything. If you want it to look like a document,
Obsidian, iA Writer, VS Code and GitHub all render these files directly, and
the folder structure is a working Obsidian vault as it stands.

The JSON files are formatted for reading. Times in them are milliseconds since
the Unix epoch, in UTC.
`;
}

/* --------------------------------- entries -------------------------------- */

function json(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

/** The name an export is offered under. Dated, because people keep several. */
export function exportFilename(at = Date.now()): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `studex-export-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.zip`;
}

/**
 * Everything in the account, as archive entries, in the order they are written.
 *
 * A file that cannot be read — a blob missing from disk, a row referring to
 * content that was never written — is logged and skipped. An export that
 * refused to produce anything because one document in four hundred is broken
 * would fail exactly the person it exists for.
 */
export async function* exportEntries(userId: string): AsyncGenerator<ZipEntry> {
  const at = Date.now();
  const unique = uniquePaths();
  const folders = listFolders(userId);
  const paths = folderPaths(folders);

  /** Images are emitted at the end, once the documents have asked for them. */
  const images = new Map<string, ImageRow>();
  /** Where each file ended up, so one file can link to another. */
  const placed = new Map<string, string>();

  const files: ReturnType<typeof listFiles> = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = listFiles(userId, { limit: PAGE, offset, sort: 'title' });
    files.push(...page);
    if (page.length < PAGE) break;
  }

  const counts: Record<string, number> = {};
  for (const file of files) counts[file.kind] = (counts[file.kind] ?? 0) + 1;

  yield { name: 'README.md', body: Buffer.from(readme(at, counts), 'utf8'), mtime: at };

  const dirFor = (kind: string, folderId: string | null): string => {
    const under = folderId ? paths.get(folderId) : undefined;
    return under ? `${kind}/${under}` : kind;
  };

  // Two passes over the files: the first decides where everything goes, so a
  // document written in the second can link to a PDF that has not been reached
  // yet. Names have to be settled before any of them can be pointed at.
  for (const file of files) {
    if (file.kind === 'doc') {
      placed.set(file.id, unique(`${dirFor('Notes', file.folder_id)}/${safeName(file.title)}.md`));
    } else if (file.kind === 'canvas') {
      placed.set(
        file.id,
        unique(`${dirFor('Canvases', file.folder_id)}/${safeName(file.title)}.svg`),
      );
    } else if (file.kind === 'pdf') {
      placed.set(file.id, unique(`${dirFor('PDFs', file.folder_id)}/${safeName(file.title)}.pdf`));
    }
  }

  for (const file of files) {
    const path = placed.get(file.id);
    if (!path) continue;

    try {
      if (file.kind === 'doc') {
        const record = getDocument(userId, file.id);
        const up = upToRoot(path);
        const markdown = documentMarkdown(file.title, record.blocks, (kind, id) => {
          if (kind === 'image') {
            let row = images.get(id);
            if (!row) {
              try {
                row = requireImage(userId, id);
              } catch {
                return null;
              }
              images.set(id, row);
            }
            return `${up}Images/${id}${IMAGE_EXTENSIONS[row.mime] ?? ''}`;
          }
          const target = placed.get(id);
          return target ? up + target : null;
        });
        yield { name: path, body: Buffer.from(markdown, 'utf8'), mtime: file.updated_at };
      } else if (file.kind === 'canvas') {
        const record = getCanvas(userId, file.id);
        yield {
          name: path,
          body: Buffer.from(canvasSvg(file.title, record.objects, record.background), 'utf8'),
          mtime: file.updated_at,
        };
        yield {
          name: `${path.slice(0, -4)}.json`,
          body: json({
            title: file.title,
            background: record.background,
            objects: record.objects,
            updated_at: record.updated_at,
          }),
          mtime: file.updated_at,
        };
      } else if (file.kind === 'pdf') {
        const record = requirePdf(userId, file.id);
        yield {
          name: path,
          // The original bytes, streamed and stored rather than deflated: a
          // PDF is already compressed, and re-compressing it costs time to
          // make it fractionally bigger.
          body: () => blobReadStream(record.storage_key),
          compress: false,
          mtime: file.updated_at,
        };
        const notes = exportAnnotations(userId, file.id);
        // The title heading alone means there were no annotations, and an
        // archive of empty note files is worse than one without them.
        if (notes.trim().split('\n').length > 1) {
          yield {
            name: `${path.slice(0, -4)}.annotations.md`,
            body: Buffer.from(`${notes.trimEnd()}\n`, 'utf8'),
            mtime: file.updated_at,
          };
        }
      }
    } catch (err) {
      log.error({ fileId: file.id, kind: file.kind, err }, 'export skipped a file');
    }
  }

  for (const [id, row] of images) {
    yield {
      name: `Images/${id}${IMAGE_EXTENSIONS[row.mime] ?? ''}`,
      body: () => blobReadStream(row.storage_key),
      compress: false,
      mtime: row.created_at,
    };
  }

  const decks: unknown[] = [];
  for (const file of files) {
    if (file.kind !== 'deck') continue;
    try {
      const cards = [];
      for (let offset = 0; ; offset += CARD_PAGE) {
        const page = listCards(userId, file.id, CARD_PAGE, offset);
        cards.push(...page);
        if (page.length < CARD_PAGE) break;
      }
      decks.push({
        id: file.id,
        title: file.title,
        folder: file.folder_id ? paths.get(file.folder_id) ?? null : null,
        stats: deckStats(userId, file.id),
        cards,
      });
    } catch (err) {
      log.error({ fileId: file.id, err }, 'export skipped a deck');
    }
  }
  yield { name: 'decks.json', body: json({ exported_at: at, decks }), mtime: at };

  yield {
    name: 'calendar.json',
    body: json({ exported_at: at, events: listEvents(userId, { limit: 10_000 }) }),
    mtime: at,
  };

  yield {
    name: 'library.json',
    body: json({
      exported_at: at,
      subjects: listSubjects(userId),
      folders,
      files: files.map((f) => ({ ...f, path: placed.get(f.id) ?? null })),
      storage: storageUsage(userId),
    }),
    mtime: at,
  };

  yield {
    name: 'settings.json',
    body: json({ exported_at: at, settings: getAccountSettings(userId) }),
    mtime: at,
  };
}
