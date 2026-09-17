import { z } from 'zod';
import { getDb, tx } from '../lib/db.js';
import { conflict, notFound } from '../lib/errors.js';
import { richText, text, uuid } from '../lib/validation.js';
import { stripInlineMarks, inlineLinks, inlineTags } from '../lib/inline.js';
import { createFile, requireFile, type FileRow } from './library.js';
import * as search from './search.js';
import * as tags from './tags.js';

/**
 * Document content is a validated discriminated union rather than free JSON.
 * That keeps the stored shape predictable and means a client cannot smuggle
 * arbitrary structures (or unbounded payloads) into the database.
 */
const blockBase = { id: uuid };

/**
 * The cards made from a line's `{cloze}` blanks, in the order of the blanks.
 *
 * On every kind of line that can hold running text, because a blank is a
 * property of the sentence rather than of the bullet around it — a heading or
 * a quotation can just as well have a word hidden in it. Separate from a
 * line's `cardId` because a line can be both (a definition with a word hidden
 * inside its own answer), and because deleting one blank has to be able to
 * find the one card that belonged to it.
 */
const clozeField = { clozeCardIds: z.array(uuid).max(20).default([]) };

export const blockSchema = z.discriminatedUnion('type', [
  z.object({ ...blockBase, ...clozeField, type: z.literal('heading'), level: z.union([z.literal(1), z.literal(2), z.literal(3)]), text: text(500) }),
  z.object({ ...blockBase, ...clozeField, type: z.literal('paragraph'), text: richText(20_000) }),
  z.object({
    ...blockBase,
    ...clozeField,
    type: z.literal('bullet'),
    text: richText(5_000),
    indent: z.number().int().min(0).max(6).default(0),
    /** Children hidden beneath this line. Structure is by indent, not nesting. */
    collapsed: z.boolean().default(false),
    /** Set once the line's `front == back` has been turned into a real card. */
    cardId: uuid.nullish(),
    /**
     * Where this line sits in the concept/descriptor framework.
     *
     * A `concept` is the thing being learnt and a `descriptor` is one of the
     * things said about it — its definition, its causes, an example. Null is
     * the ordinary case: most lines are prose and are not part of a frame.
     */
    cdf: z.enum(['concept', 'descriptor']).nullish(),
    /** Side-by-side children, for a pros-and-cons or comparison layout. */
    layout: z.enum(['list', 'columns']).default('list'),
  }),
  z.object({ ...blockBase, ...clozeField, type: z.literal('numbered'), text: richText(5_000), indent: z.number().int().min(0).max(6).default(0) }),
  z.object({
    ...blockBase,
    ...clozeField,
    type: z.literal('todo'),
    text: richText(5_000),
    done: z.boolean().default(false),
    /**
     * When it is due, as a plain `YYYY-MM-DD` day rather than an instant.
     *
     * A task is due on a day, not at a moment: storing it as a timestamp would
     * make the same checklist read as a different day either side of midnight
     * in another timezone, which is never what was meant.
     */
    due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  }),
  z.object({
    ...blockBase,
    type: z.literal('table'),
    columns: z.array(text(200)).min(1).max(20),
    rows: z.array(z.array(richText(2_000)).max(20)).max(500),
    /**
     * A name for each row, drawn as a header column down the left. Absent
     * means the table has no row names — which is not the same as every row
     * being named with an empty string, so it stays nullable rather than
     * defaulting to a list of blanks.
     */
    rowLabels: z.array(text(200)).max(500).nullish(),
    /**
     * What each column holds, which is what lets a table be sorted sensibly
     * and drawn with the right control. Absent means every column is text —
     * the only thing a table could hold before there was a choice.
     */
    columnTypes: z.array(z.enum(['text', 'number', 'date', 'status', 'link'])).max(20).nullish(),
    /** The column the rows are read in order of, and which way round. */
    sort: z.object({
      column: z.number().int().min(0).max(19),
      direction: z.enum(['asc', 'desc']).default('asc'),
    }).nullish(),
    /** Rows are hidden unless this column contains this text. */
    filter: z.object({ column: z.number().int().min(0).max(19), contains: text(200) }).nullish(),
  }),
  z.object({ ...blockBase, type: z.literal('flashcard'), cardId: uuid.nullish(), front: richText(4_000), back: richText(4_000) }),
  z.object({
    ...blockBase,
    type: z.literal('image'),
    imageId: uuid,
    alt: text(500).nullish(),
    caption: text(500).nullish(),
    /**
     * Parts of the picture covered over, to be uncovered one at a time.
     *
     * Held as fractions of the image rather than pixels, so the same diagram
     * tests the same labels at any width — which is the whole point of keeping
     * the picture as a reference instead of baking the masks into it.
     */
    masks: z.array(z.object({
      id: uuid,
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      width: z.number().min(0.01).max(1),
      height: z.number().min(0.01).max(1),
      label: text(200).nullish(),
      cardId: uuid.nullish(),
    })).max(60).default([]),
    /** Where this picture's scheduled occlusion cards live: the deck, and the copy of the picture in it. */
    occlusionDeckId: uuid.nullish(),
    occlusionImageId: uuid.nullish(),
  }),
  z.object({
    ...blockBase,
    type: z.literal('pdf'),
    fileId: uuid,
    page: z.number().int().min(1).max(10_000),
    /**
     * The words this block was made from, copied out of the page.
     *
     * Kept here rather than only pointed at, so the note still says something
     * when the PDF is slow to load, is missing, or is being read on a device
     * that never downloaded it — and so the quote is findable in search.
     */
    quote: richText(4_000).nullish(),
    /** What the student wrote in the margin beside it. */
    note: richText(4_000).nullish(),
  }),
  /**
   * A diagram, held as a reference to a canvas file rather than as a drawing
   * of its own.
   *
   * The alternative was a second drawing surface that only existed inside
   * documents, which would have meant two editors, two schemas and two sets of
   * export code for one idea. A canvas already has notes, ink, images and
   * connectors — boxes and arrows — so the block that was missing was never a
   * drawing tool, only a way to put one on a page. This is the same shape the
   * `pdf` block already uses for the same reason.
   */
  z.object({ ...blockBase, type: z.literal('canvas'), fileId: uuid, caption: text(500).nullish() }),
  z.object({ ...blockBase, type: z.literal('code'), language: text(40).nullish(), text: richText(50_000) }),
  /**
   * A displayed equation, stored as the LaTeX source the student typed.
   *
   * Source rather than rendered output, for the same reason the rest of the
   * document stores marks rather than HTML: the source is what can be edited,
   * searched and re-rendered, and it cannot carry markup into the page. The
   * limit is small on purpose — this is one equation, not a paper.
   */
  z.object({ ...blockBase, type: z.literal('math'), latex: text(4_000), caption: text(500).nullish() }),
  /**
   * A quotation, set apart from the prose around it.
   *
   * Its own block rather than a mark, because a quote is a shape a paragraph
   * takes rather than emphasis inside one: it wraps, it can run to several
   * sentences, and it carries a source that is not part of the quote.
   */
  z.object({ ...blockBase, ...clozeField, type: z.literal('quote'), text: richText(20_000), cite: text(500).nullish() }),
  /**
   * Something from the web, shown where it was written in rather than linked.
   *
   * Only the address is stored. What may be framed is decided when the page is
   * drawn, against a list of hosts the app knows how to embed — a URL in the
   * database is not permission to put an arbitrary site inside the app.
   */
  z.object({ ...blockBase, type: z.literal('embed'), url: z.string().url().max(2_000), caption: text(500).nullish() }),
  /**
   * A window onto another document, drawn live rather than copied.
   *
   * This is the block that makes a note reusable: what it shows is whatever
   * the other document says now, so a definition written once is correct
   * everywhere it appears. `blockId` narrows it to one line and its children;
   * absent, the portal shows the document from the top.
   */
  z.object({ ...blockBase, type: z.literal('portal'), fileId: uuid, blockId: uuid.nullish(), caption: text(500).nullish() }),
  /**
   * Lines side by side: a comparison, a pros-and-cons, a small dashboard.
   *
   * Each column is a list of its own lines rather than a slice of the document
   * order, which keeps the block self-contained — moving it moves all of it,
   * and there is no way for a column to end up holding half of its neighbour.
   */
  z.object({
    ...blockBase,
    type: z.literal('columns'),
    columns: z.array(z.object({
      title: text(200).nullish(),
      lines: z.array(richText(2_000)).max(200).default([]),
    })).min(2).max(4),
  }),
  z.object({ ...blockBase, type: z.literal('divider') }),
]);

export const blocksSchema = z.array(blockSchema).max(5_000);
export type Block = z.infer<typeof blockSchema>;

/** Flattens blocks to plain text so documents are findable in search. */
export function blocksToText(blocks: Block[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'heading':
      case 'paragraph':
      case 'bullet':
      case 'numbered':
      case 'todo':
        // Search should match what the page says, not how it is emphasised:
        // `**mitosis**` has to be findable as "mitosis".
        parts.push(stripInlineMarks(b.text));
        break;
      case 'code':
        // Code is not prose: an asterisk in it is an asterisk.
        parts.push(b.text);
        break;
      case 'math':
        // The LaTeX source is indexed as written. Searching for "\\frac" is a
        // real thing a student does, and the caption is ordinary prose.
        parts.push(b.latex);
        if (b.caption) parts.push(b.caption);
        break;
      case 'canvas':
        // The diagram's own contents are indexed against the canvas file that
        // holds them, so only the caption written here belongs to this
        // document. Indexing the canvas twice would return both files for one
        // hit and make the search results look duplicated.
        if (b.caption) parts.push(b.caption);
        break;
      case 'table':
        parts.push(
          b.columns.join(' '),
          ...(b.rowLabels ?? []),
          ...b.rows.map((r) => r.map(stripInlineMarks).join(' ')),
        );
        break;
      case 'flashcard':
        parts.push(stripInlineMarks(b.front), stripInlineMarks(b.back));
        break;
      case 'image':
        if (b.alt) parts.push(b.alt);
        if (b.caption) parts.push(b.caption);
        // What each covered part of the diagram is called is the only thing
        // written on an occlusion, so it is the only thing to find it by.
        for (const mask of b.masks) if (mask.label) parts.push(mask.label);
        break;
      case 'pdf':
        if (b.quote) parts.push(stripInlineMarks(b.quote));
        if (b.note) parts.push(stripInlineMarks(b.note));
        break;
      case 'quote':
        parts.push(stripInlineMarks(b.text));
        if (b.cite) parts.push(b.cite);
        break;
      case 'embed':
        // The address is indexed as well as the caption: looking a page up by
        // the video that is on it is a reasonable thing to want.
        parts.push(b.url);
        if (b.caption) parts.push(b.caption);
        break;
      case 'portal':
        // Only the caption, for the same reason a canvas block indexes only
        // its own: what the portal shows belongs to the document it came from
        // and is already findable there.
        if (b.caption) parts.push(b.caption);
        break;
      case 'columns':
        for (const column of b.columns) {
          if (column.title) parts.push(column.title);
          parts.push(...column.lines.map(stripInlineMarks));
        }
        break;
      default:
        break;
    }
  }
  return parts.join('\n');
}

/** Every line of a document that can carry inline notation, as raw text. */
function inlineTexts(blocks: Block[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'paragraph':
      case 'bullet':
      case 'numbered':
      case 'todo':
      case 'quote':
        out.push(b.text);
        break;
      case 'flashcard':
        out.push(b.front, b.back);
        break;
      case 'pdf':
        if (b.quote) out.push(b.quote);
        if (b.note) out.push(b.note);
        break;
      case 'table':
        for (const row of b.rows) out.push(...row);
        break;
      case 'columns':
        for (const column of b.columns) out.push(...column.lines);
        break;
      default:
        break;
    }
  }
  return out;
}

/** The pages a document points at with `[[ ]]`, deduplicated. */
export function documentLinks(blocks: Block[]): string[] {
  const names = inlineTexts(blocks).flatMap(inlineLinks);
  return [...new Set(names)];
}

/** The tags a document carries with `##`, deduplicated and lowercased. */
export function documentTags(blocks: Block[]): string[] {
  const names = inlineTexts(blocks).flatMap(inlineTags).map((t) => t.toLowerCase());
  return [...new Set(names)];
}

/**
 * How the page draws itself. 'bulleted' marks every top-level block the way an
 * outliner does; 'standard' leaves prose looking like prose.
 */
export const documentStyleSchema = z.enum(['standard', 'bulleted']);
export type DocumentStyle = z.infer<typeof documentStyleSchema>;

export interface DocumentRecord {
  file_id: string;
  blocks: Block[];
  style: DocumentStyle;
  revision: number;
  updated_at: number;
}

interface DocumentRow {
  file_id: string;
  blocks: string;
  style: string;
  revision: number;
  updated_at: number;
}

/** A style the database has never heard of reads as the ordinary one. */
function readStyle(value: string | null | undefined): DocumentStyle {
  const parsed = documentStyleSchema.safeParse(value);
  return parsed.success ? parsed.data : 'standard';
}

export function getDocument(userId: string, fileId: string): DocumentRecord {
  const file = requireFile(userId, fileId);
  if (file.kind !== 'doc') throw notFound('File is not a document');

  const row = getDb()
    .prepare<[string], DocumentRow>('SELECT * FROM documents WHERE file_id = ?')
    .get(fileId);
  if (!row) throw notFound('Document content missing');

  return {
    file_id: row.file_id,
    blocks: JSON.parse(row.blocks) as Block[],
    style: readStyle(row.style),
    revision: row.revision,
    updated_at: row.updated_at,
  };
}

/**
 * Saves document content with optimistic concurrency. A client that has not
 * seen the latest revision is rejected rather than silently clobbering another
 * device's edits.
 */
export function saveDocument(
  userId: string,
  fileId: string,
  blocks: Block[],
  expectedRevision?: number,
  style?: DocumentStyle,
): DocumentRecord {
  const file = requireFile(userId, fileId);
  if (file.kind !== 'doc') throw notFound('File is not a document');

  return tx(() => {
    const current = getDb()
      .prepare<[string], { revision: number; style: string }>(
        'SELECT revision, style FROM documents WHERE file_id = ?',
      )
      .get(fileId);
    if (!current) throw notFound('Document content missing');

    if (expectedRevision !== undefined && expectedRevision !== current.revision) {
      throw conflict(
        `Document was modified elsewhere (expected revision ${expectedRevision}, found ${current.revision})`,
      );
    }

    const now = Date.now();
    const nextRevision = current.revision + 1;
    const nextStyle = style ?? readStyle(current.style);
    getDb()
      .prepare('UPDATE documents SET blocks = ?, style = ?, revision = ?, updated_at = ? WHERE file_id = ?')
      .run(JSON.stringify(blocks), nextStyle, nextRevision, now, fileId);
    getDb().prepare('UPDATE files SET updated_at = ? WHERE id = ?').run(now, fileId);

    search.indexEntity({
      userId,
      entityType: 'file',
      entityId: fileId,
      fileId,
      title: file.title,
      body: blocksToText(blocks),
    });
    indexReferences(userId, fileId, blocks);

    return { file_id: fileId, blocks, style: nextStyle, revision: nextRevision, updated_at: now };
  });
}

/**
 * Rewrites what this document points at and what it is tagged with.
 *
 * Replaced wholesale on every save rather than diffed: the set is small, the
 * rows are derived, and working out which three of twenty links changed costs
 * more than writing all twenty. Runs inside the caller's transaction.
 */
function indexReferences(userId: string, fileId: string, blocks: Block[]): void {
  const db = getDb();
  db.prepare('DELETE FROM document_links WHERE file_id = ?').run(fileId);

  const link = db.prepare(
    'INSERT OR IGNORE INTO document_links (user_id, file_id, target, target_key) VALUES (?, ?, ?, ?)',
  );
  for (const target of documentLinks(blocks)) {
    const key = target.trim().toLowerCase();
    if (key) link.run(userId, fileId, target.trim(), key);
  }

  tags.syncTextTags(userId, fileId, documentTags(blocks));
}

export interface Backlink {
  id: string;
  title: string;
  kind: string;
  color: string | null;
  /** How the linking page wrote the name, which is not always this page's. */
  target: string;
  updated_at: number;
}

/**
 * The pages that point at this one.
 *
 * Matched on title rather than on id, because that is what a `[[ ]]` holds.
 * A page renamed out from under its links loses them, which is the honest
 * outcome: the links now name something else, and silently following a page
 * around would mean `[[Photosynthesis]]` quietly leading somewhere that no
 * longer says that word anywhere.
 */
export function backlinks(userId: string, fileId: string): Backlink[] {
  const file = requireFile(userId, fileId);
  return getDb()
    .prepare<[string, string, string], Backlink>(
      `SELECT l.file_id AS id, f.title AS title, f.kind AS kind, f.color_override AS color,
              l.target AS target, f.updated_at AS updated_at
         FROM document_links l
         JOIN files f ON f.id = l.file_id
        WHERE l.user_id = ? AND l.target_key = ? AND l.file_id <> ? AND f.trashed_at IS NULL
        ORDER BY f.updated_at DESC
        LIMIT 200`,
    )
    .all(userId, file.title.trim().toLowerCase(), fileId);
}

/**
 * The document whose title is `name`, if there is one.
 *
 * What a `[[ ]]` resolves to when it is followed. Returns null rather than
 * throwing, because a link to a page that does not exist yet is ordinary —
 * the caller offers to create it.
 */
export function documentByTitle(userId: string, name: string): FileRow | null {
  return getDb()
    .prepare<[string, string], FileRow>(
      `SELECT * FROM files
        WHERE user_id = ? AND kind = 'doc' AND trashed_at IS NULL AND LOWER(TRIM(title)) = ?
        ORDER BY updated_at DESC
        LIMIT 1`,
    )
    .get(userId, name.trim().toLowerCase()) ?? null;
}

/** Outline panel: the heading structure of a document. */
export function documentOutline(userId: string, fileId: string) {
  const doc = getDocument(userId, fileId);
  return doc.blocks
    .filter((b): b is Extract<Block, { type: 'heading' }> => b.type === 'heading')
    .map((b) => ({ id: b.id, level: b.level, text: b.text }));
}


/**
 * The deck a document writes its inline cards into. One per document, created
 * on demand and reused afterwards. The link lives on the deck's own file row,
 * so renaming or moving either file does not lose it.
 */
export function ensureCardDeck(userId: string, fileId: string): FileRow {
  const doc = requireFile(userId, fileId);
  const existing = getDb()
    .prepare<[string, string], FileRow>(
      `SELECT * FROM files
        WHERE user_id = ? AND source_file_id = ? AND kind = 'deck' AND trashed_at IS NULL
        LIMIT 1`,
    )
    .get(userId, fileId);
  if (existing) return existing;

  return createFile(userId, {
    title: doc.title,
    kind: 'deck',
    folderId: doc.folder_id,
    sourceFileId: fileId,
  });
}
