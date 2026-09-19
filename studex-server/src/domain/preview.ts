/**
 * What a file looks like without opening it.
 *
 * Home shows a file's contents beside its name — the first lines of a note,
 * the first few cards of a deck, the highlights pulled out of a PDF, a small
 * drawing of a canvas. Each kind of content is owned by its own domain, so the
 * preview is assembled here, above all of them, the same way `reindex.ts`
 * rebuilds the search index.
 *
 * Everything returned is deliberately small and bounded: a preview is a glance,
 * and a student with a two-hundred-page note should not pay for it in bytes.
 */
import { getDb } from '../lib/db.js';
import { stripInlineMarks } from '../lib/inline.js';
import { blocksToText, type Block } from './documents.js';
import { effectiveFileColor, requireFile, type FileRow } from './library.js';
import { deckStats } from './flashcards.js';
import type { CanvasObject, Background } from './canvas.js';

/** How much of each kind of content a glance is worth. */
const DOC_LINES = 14;
const DECK_CARDS = 5;
const PDF_HIGHLIGHTS = 4;
const CANVAS_SHAPES = 90;
/** Points kept from one ink stroke. Enough for the gesture, not the drawing. */
const INK_POINTS = 18;
/** A line longer than this is a paragraph, and a paragraph is not a preview. */
const LINE_CHARS = 240;

export type PreviewLineType =
  | 'heading' | 'paragraph' | 'bullet' | 'numbered' | 'todo'
  | 'quote' | 'code' | 'math' | 'card' | 'table' | 'image' | 'divider';

export interface PreviewLine {
  type: PreviewLineType;
  text: string;
  /** Headings only. */
  level?: 1 | 2 | 3;
  /** Lists only: how far in the line sits. */
  indent?: number;
  /** Tasks only. */
  done?: boolean;
}

export interface PreviewShape {
  type: 'note' | 'text' | 'frame' | 'flashcard' | 'image' | 'pdf_excerpt' | 'link' | 'line' | 'ink' | 'connector';
  x: number;
  y: number;
  width?: number;
  height?: number;
  /** Lines and ink, already thinned. */
  points?: [number, number][];
  color?: string | null;
  fill?: string | null;
  text?: string;
}

export interface FilePreview {
  file: {
    id: string;
    kind: FileRow['kind'];
    title: string;
    updated_at: number;
    pinned: boolean;
    folder_id: string | null;
    effective_color: string;
  };
  doc?: {
    lines: PreviewLine[];
    blocks: number;
    words: number;
    /** True when the note carries more than the lines above. */
    truncated: boolean;
  };
  deck?: {
    cards: { front: string; back: string }[];
    total: number;
    due: number;
    new: number;
    known: number;
    shaky: number;
  };
  pdf?: {
    page_count: number | null;
    annotations: number;
    highlights: { page: number; quote: string; note: string | null }[];
    original_name: string;
  };
  canvas?: {
    background: Background;
    objects: number;
    ink_strokes: number;
    /** The drawn extent, so a client can fit the shapes into any box. */
    bounds: { x: number; y: number; width: number; height: number } | null;
    shapes: PreviewShape[];
    truncated: boolean;
  };
}

/** One line of text, tidied: marks applied, whitespace collapsed, clipped. */
function line(raw: string): string {
  const flat = stripInlineMarks(raw).replace(/\s+/g, ' ').trim();
  return flat.length > LINE_CHARS ? `${flat.slice(0, LINE_CHARS - 1)}…` : flat;
}

/** The first lines of a note, in the order they are written. */
function docLines(blocks: Block[]): PreviewLine[] {
  const lines: PreviewLine[] = [];
  for (const block of blocks) {
    if (lines.length >= DOC_LINES) break;
    const push = (item: PreviewLine) => { if (item.text) lines.push(item); };
    switch (block.type) {
      case 'heading': push({ type: 'heading', text: line(block.text), level: block.level }); break;
      case 'paragraph': push({ type: 'paragraph', text: line(block.text) }); break;
      case 'bullet': push({ type: 'bullet', text: line(block.text), indent: block.indent }); break;
      case 'numbered': push({ type: 'numbered', text: line(block.text), indent: block.indent }); break;
      case 'todo': push({ type: 'todo', text: line(block.text), done: block.done }); break;
      case 'quote': push({ type: 'quote', text: line(block.text) }); break;
      case 'code': push({ type: 'code', text: line(block.text.split('\n').slice(0, 2).join(' ⏎ ')) }); break;
      case 'math': push({ type: 'math', text: line(block.latex) }); break;
      case 'flashcard': push({ type: 'card', text: line(block.front) }); break;
      case 'table': push({ type: 'table', text: block.columns.map((c) => line(c)).filter(Boolean).join(' · ') }); break;
      case 'image': push({ type: 'image', text: line(block.caption ?? block.alt ?? 'Picture') }); break;
      case 'pdf': push({ type: 'quote', text: line(block.quote ?? block.note ?? '') }); break;
      case 'columns': {
        const titles = block.columns.map((c) => (c.title ? line(c.title) : '')).filter(Boolean);
        push({ type: 'table', text: titles.join(' · ') });
        break;
      }
      case 'divider': push({ type: 'divider', text: '—' }); break;
      default:
        // canvas, portal and embed blocks are references to something else;
        // a caption is all that belongs to this note.
        if ('caption' in block && block.caption) push({ type: 'paragraph', text: line(block.caption) });
        break;
    }
  }
  return lines;
}

function docPreview(fileId: string): FilePreview['doc'] {
  const row = getDb()
    .prepare<[string], { blocks: string }>('SELECT blocks FROM documents WHERE file_id = ?')
    .get(fileId);
  if (!row) return { lines: [], blocks: 0, words: 0, truncated: false };

  let blocks: Block[] = [];
  try { blocks = JSON.parse(row.blocks) as Block[]; } catch { blocks = []; }

  const text = blocksToText(blocks).trim();
  const lines = docLines(blocks);
  return {
    lines,
    blocks: blocks.length,
    words: text ? text.split(/\s+/).length : 0,
    truncated: blocks.length > lines.length,
  };
}

function deckPreview(userId: string, fileId: string): FilePreview['deck'] {
  const stats = deckStats(userId, fileId);
  const cards = getDb()
    .prepare<[string, string, number], { front: string; back: string }>(
      `SELECT front, back FROM cards WHERE user_id = ? AND deck_id = ?
       ORDER BY created_at ASC LIMIT ?`,
    )
    .all(userId, fileId, DECK_CARDS)
    .map((c) => ({ front: line(c.front), back: line(c.back) }));
  return { cards, total: stats.total, due: stats.due, new: stats.new, known: stats.known, shaky: stats.shaky };
}

function pdfPreview(userId: string, fileId: string): FilePreview['pdf'] {
  const row = getDb()
    .prepare<[string], { page_count: number | null; original_name: string }>(
      'SELECT page_count, original_name FROM pdf_files WHERE file_id = ?',
    )
    .get(fileId);

  const count = getDb()
    .prepare<[string, string], { total: number }>(
      'SELECT COUNT(*) AS total FROM annotations WHERE user_id = ? AND file_id = ?',
    )
    .get(userId, fileId);

  // What the student marked, in page order: the highlights are the reading,
  // and a comment with something written in it counts as one.
  const highlights = getDb()
    .prepare<[string, string, number], { page: number; quoted_text: string | null; note: string | null }>(
      `SELECT page, quoted_text, note FROM annotations
       WHERE user_id = ? AND file_id = ? AND (quoted_text IS NOT NULL OR note IS NOT NULL)
       ORDER BY page ASC, created_at ASC LIMIT ?`,
    )
    .all(userId, fileId, PDF_HIGHLIGHTS)
    .map((a) => ({ page: a.page, quote: line(a.quoted_text ?? ''), note: a.note ? line(a.note) : null }));

  return {
    page_count: row?.page_count ?? null,
    annotations: count?.total ?? 0,
    highlights,
    original_name: row?.original_name ?? '',
  };
}

/** Every point a shape occupies, for the bounding box. */
function extent(object: CanvasObject): [number, number, number, number] | null {
  if (object.type === 'ink') {
    const xs = object.points.map((p) => p[0]);
    const ys = object.points.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  if (object.type === 'line') {
    const xs = object.points.map((p) => p[0]);
    const ys = object.points.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  if (object.type === 'connector') return null; // its ends are other objects
  return [object.x, object.y, object.x + object.width, object.y + object.height];
}

/** Keeps the shape of a stroke while throwing most of its points away. */
function thin(points: [number, number][], keep: number): [number, number][] {
  if (points.length <= keep) return points;
  const step = (points.length - 1) / (keep - 1);
  const out: [number, number][] = [];
  for (let i = 0; i < keep; i += 1) {
    const point = points[Math.round(i * step)];
    if (point) out.push(point);
  }
  return out;
}

function canvasPreview(fileId: string): FilePreview['canvas'] {
  const row = getDb()
    .prepare<[string], { objects: string; background: string }>(
      'SELECT objects, background FROM canvases WHERE file_id = ?',
    )
    .get(fileId);
  if (!row) return undefined;

  let objects: CanvasObject[] = [];
  try { objects = JSON.parse(row.objects) as CanvasObject[]; } catch { objects = []; }

  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const object of objects) {
    const box = extent(object);
    if (!box) continue;
    minX = Math.min(minX, box[0]); minY = Math.min(minY, box[1]);
    maxX = Math.max(maxX, box[2]); maxY = Math.max(maxY, box[3]);
  }
  const bounds = Number.isFinite(minX)
    ? { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) }
    : null;

  const shapes: PreviewShape[] = [];
  for (const object of objects) {
    if (shapes.length >= CANVAS_SHAPES) break;
    // A connector is drawn between two objects the thumbnail may not be
    // showing, so it is counted rather than drawn.
    if (object.type === 'connector') continue;
    const shape: PreviewShape = { type: object.type, x: object.x, y: object.y };
    if ('width' in object) shape.width = object.width;
    if ('height' in object) shape.height = object.height;
    if (object.type === 'ink') shape.points = thin(object.points.map((p) => [p[0], p[1]] as [number, number]), INK_POINTS);
    if (object.type === 'line') shape.points = thin(object.points as [number, number][], INK_POINTS);
    if ('color' in object) shape.color = object.color ?? null;
    if ('fill' in object) shape.fill = object.fill ?? null;
    if (object.type === 'note' || object.type === 'text') shape.text = line(object.text);
    if (object.type === 'flashcard') shape.text = line(object.front);
    if (object.type === 'frame' && object.name) shape.text = line(object.name);
    if (object.type === 'link' && object.title) shape.text = line(object.title);
    shapes.push(shape);
  }

  return {
    background: (row.background as Background) ?? 'dots',
    objects: objects.length,
    ink_strokes: objects.filter((o) => o.type === 'ink').length,
    bounds,
    shapes,
    truncated: shapes.length < objects.filter((o) => o.type !== 'connector').length,
  };
}

/** Everything a glance at one file shows, whatever kind of file it is. */
export function filePreview(userId: string, fileId: string): FilePreview {
  const file = requireFile(userId, fileId);
  const preview: FilePreview = {
    file: {
      id: file.id,
      kind: file.kind,
      title: file.title,
      updated_at: file.updated_at,
      pinned: file.pinned === 1,
      folder_id: file.folder_id,
      effective_color: effectiveFileColor(userId, file),
    },
  };

  if (file.kind === 'doc') preview.doc = docPreview(file.id);
  else if (file.kind === 'deck') preview.deck = deckPreview(userId, file.id);
  else if (file.kind === 'pdf') preview.pdf = pdfPreview(userId, file.id);
  else if (file.kind === 'canvas') preview.canvas = canvasPreview(file.id);

  return preview;
}
