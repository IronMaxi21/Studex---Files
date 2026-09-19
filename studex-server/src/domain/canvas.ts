import { z } from 'zod';
import { getDb, tx } from '../lib/db.js';
import { conflict, notFound } from '../lib/errors.js';
import { colorToken, richText, text, uuid } from '../lib/validation.js';
import { requireFile } from './library.js';
import * as search from './search.js';

const coordinate = z.number().finite().min(-1_000_000).max(1_000_000);

const objectBase = {
  id: uuid,
  x: coordinate,
  y: coordinate,
};

/** A point in an ink stroke: [x, y, pressure]. */
const inkPoint = z.tuple([coordinate, coordinate, z.number().min(0).max(1).default(0.5)]);

/**
 * The drawing properties every outlined element carries.
 *
 * They are optional with defaults rather than required, so a canvas drawn
 * before these existed still parses: an old note simply gets a solid, opaque,
 * architect-straight outline, which is exactly what it was drawn with.
 */
const strokeStyleSchema = z.enum(['solid', 'dashed', 'dotted']).default('solid');
const fillStyleSchema = z.enum(['solid', 'hachure', 'cross-hatch']).default('solid');
const roughnessSchema = z.enum(['architect', 'artist', 'cartoonist']).default('architect');
const opacitySchema = z.number().min(0.05).max(1).default(1);
/** What sits on the end of a line. */
const arrowheadSchema = z.enum(['none', 'arrow', 'triangle', 'dot', 'bar']).default('none');

const styled = {
  /** The outline colour. Also tints a note's paper, as it always has. */
  color: colorToken.nullish(),
  /** The inside. Absent means transparent, which is what a sketch usually is. */
  fill: colorToken.nullish(),
  fillStyle: fillStyleSchema,
  stroke: z.number().min(0).max(20).default(1.5),
  strokeStyle: strokeStyleSchema,
  roughness: roughnessSchema,
  opacity: opacitySchema,
};

export const canvasObjectSchema = z.discriminatedUnion('type', [
  z.object({
    ...objectBase,
    ...styled,
    type: z.literal('note'),
    width: coordinate,
    height: coordinate,
    /** Bound text: it lives inside the shape and moves and resizes with it. */
    text: richText(10_000),
    fontSize: z.number().min(8).max(96).default(15),
    shape: z.enum(['rounded', 'square', 'ellipse', 'diamond']).default('rounded'),
    /** Set when this note is the root or a branch of a mind map. */
    mindmap: z.boolean().nullish(),
  }),
  z.object({
    ...objectBase,
    type: z.literal('text'),
    width: coordinate,
    height: coordinate,
    text: richText(10_000),
    color: colorToken.nullish(),
    fontSize: z.number().min(8).max(200).default(20),
    align: z.enum(['left', 'center', 'right']).default('left'),
    opacity: opacitySchema,
  }),
  z.object({
    ...objectBase,
    type: z.literal('frame'),
    width: coordinate,
    height: coordinate,
    name: text(200).nullish(),
    color: colorToken.nullish(),
    opacity: opacitySchema,
  }),
  z.object({
    ...objectBase,
    type: z.literal('flashcard'),
    width: coordinate,
    height: coordinate,
    cardId: uuid.nullish(),
    front: richText(4_000),
    back: richText(4_000),
  }),
  z.object({
    ...objectBase,
    ...styled,
    /** A straight run of segments, with an optional head on either end. */
    type: z.literal('line'),
    points: z.array(z.tuple([coordinate, coordinate])).min(2).max(1_000),
    startArrow: arrowheadSchema,
    endArrow: arrowheadSchema,
    edge: z.enum(['sharp', 'round']).default('round'),
    label: text(200).nullish(),
  }),
  z.object({
    ...objectBase,
    type: z.literal('ink'),
    points: z.array(inkPoint).min(2).max(10_000),
    color: colorToken.nullish(),
    stroke: z.number().min(0).max(20).default(1.5),
    opacity: opacitySchema,
  }),
  z.object({
    ...objectBase,
    type: z.literal('image'),
    width: coordinate,
    height: coordinate,
    fileId: uuid.nullish(),
    alt: text(500).nullish(),
    opacity: opacitySchema,
  }),
  z.object({
    ...objectBase,
    type: z.literal('pdf_excerpt'),
    width: coordinate,
    height: coordinate,
    fileId: uuid,
    page: z.number().int().min(1).max(10_000),
    quotedText: richText(4_000).nullish(),
  }),
  z.object({
    ...objectBase,
    /**
     * Something else in the library, standing on the plane.
     *
     * A canvas is where a topic gets laid out, and most of what a topic is
     * made of already exists as a note, a deck or a PDF. Before this the only
     * way to say "and that lecture PDF belongs here" was to type its name into
     * a sticky note, which is a label, not a way back to it.
     *
     * The title is stored alongside the id so a card whose file has been
     * deleted still says what it was, rather than becoming an empty box.
     */
    type: z.literal('link'),
    width: coordinate,
    height: coordinate,
    fileId: uuid,
    title: text(200).nullish(),
  }),
  z.object({
    ...objectBase,
    type: z.literal('connector'),
    fromId: uuid,
    toId: uuid,
    label: text(200).nullish(),
    color: colorToken.nullish(),
    stroke: z.number().min(0).max(20).default(1.5),
    strokeStyle: strokeStyleSchema,
    startArrow: arrowheadSchema,
    endArrow: arrowheadSchema,
    /** How the line gets there: straight, right-angled, or bowed. */
    path: z.enum(['straight', 'elbow', 'curved']).default('straight'),
    opacity: opacitySchema,
  }),
]);

export const canvasObjectsSchema = z.array(canvasObjectSchema).max(20_000);
export type CanvasObject = z.infer<typeof canvasObjectSchema>;

export const viewportSchema = z.object({
  x: coordinate.default(0),
  y: coordinate.default(0),
  zoom: z.number().min(0.05).max(20).default(1),
  /**
   * How far the plane has been turned under the hand, in degrees.
   *
   * A trackpad twist rotates the canvas rather than anything on it, so the
   * angle belongs to the view and not to the objects. Bounded to a turn each
   * way: the client normalises to (-180, 180], and a canvas saved by an older
   * client simply has none, which is zero.
   */
  rotation: z.number().min(-360).max(360).default(0),
});

function objectsToText(objects: CanvasObject[]): string {
  const parts: string[] = [];
  for (const o of objects) {
    if (o.type === 'note') parts.push(o.text);
    else if (o.type === 'text') parts.push(o.text);
    else if (o.type === 'frame' && o.name) parts.push(o.name);
    else if (o.type === 'flashcard') parts.push(o.front, o.back);
    else if (o.type === 'pdf_excerpt' && o.quotedText) parts.push(o.quotedText);
    else if (o.type === 'image' && o.alt) parts.push(o.alt);
    else if (o.type === 'line' && o.label) parts.push(o.label);
    else if (o.type === 'connector' && o.label) parts.push(o.label);
  }
  return parts.join('\n');
}

/** The four papers a canvas can be set on, chosen when it is created. */
export const BACKGROUNDS = ['dots', 'plain', 'lines', 'squares'] as const;
export type Background = (typeof BACKGROUNDS)[number];
export const backgroundSchema = z.enum(BACKGROUNDS);

export interface CanvasRecord {
  file_id: string;
  objects: CanvasObject[];
  viewport: z.infer<typeof viewportSchema>;
  background: Background;
  revision: number;
  updated_at: number;
  stats: { objects: number; ink_strokes: number };
}

function toRecord(
  fileId: string,
  objects: CanvasObject[],
  viewport: z.infer<typeof viewportSchema>,
  background: Background,
  revision: number,
  updatedAt: number,
): CanvasRecord {
  return {
    file_id: fileId,
    objects,
    viewport,
    background,
    revision,
    updated_at: updatedAt,
    stats: {
      objects: objects.length,
      ink_strokes: objects.filter((o) => o.type === 'ink').length,
    },
  };
}

export function getCanvas(userId: string, fileId: string): CanvasRecord {
  const file = requireFile(userId, fileId);
  if (file.kind !== 'canvas') throw notFound('File is not a canvas');

  const row = getDb()
    .prepare<
      [string],
      { objects: string; viewport: string; background: string; revision: number; updated_at: number }
    >('SELECT * FROM canvases WHERE file_id = ?')
    .get(fileId);
  if (!row) throw notFound('Canvas content missing');

  return toRecord(
    fileId,
    JSON.parse(row.objects) as CanvasObject[],
    JSON.parse(row.viewport),
    readBackground(row.background),
    row.revision,
    row.updated_at,
  );
}

/** A value written before this was a column, or by an older client. */
function readBackground(raw: string | null | undefined): Background {
  const parsed = backgroundSchema.safeParse(raw);
  return parsed.success ? parsed.data : 'dots';
}

export function saveCanvas(
  userId: string,
  fileId: string,
  input: {
    objects: CanvasObject[];
    viewport?: z.infer<typeof viewportSchema>;
    background?: Background;
    expectedRevision?: number;
  },
): CanvasRecord {
  const file = requireFile(userId, fileId);
  if (file.kind !== 'canvas') throw notFound('File is not a canvas');

  return tx(() => {
    const current = getDb()
      .prepare<[string], { revision: number; viewport: string; background: string }>(
        'SELECT revision, viewport, background FROM canvases WHERE file_id = ?',
      )
      .get(fileId);
    if (!current) throw notFound('Canvas content missing');

    if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
      throw conflict(
        `Canvas was modified elsewhere (expected revision ${input.expectedRevision}, found ${current.revision})`,
      );
    }

    // Connectors must reference objects that exist on this canvas, otherwise
    // the client would render dangling edges.
    const ids = new Set(input.objects.map((o) => o.id));
    for (const o of input.objects) {
      if (o.type === 'connector' && (!ids.has(o.fromId) || !ids.has(o.toId))) {
        throw conflict(`Connector ${o.id} references an object that is not on the canvas`);
      }
    }

    const now = Date.now();
    const nextRevision = current.revision + 1;
    const viewport = input.viewport ?? JSON.parse(current.viewport);
    const background = input.background ?? readBackground(current.background);

    getDb()
      .prepare(
        `UPDATE canvases SET objects = ?, viewport = ?, background = ?, revision = ?, updated_at = ?
         WHERE file_id = ?`,
      )
      .run(JSON.stringify(input.objects), JSON.stringify(viewport), background, nextRevision, now, fileId);
    getDb().prepare('UPDATE files SET updated_at = ? WHERE id = ?').run(now, fileId);

    search.indexEntity({
      userId,
      entityType: 'file',
      entityId: fileId,
      fileId,
      title: file.title,
      body: objectsToText(input.objects),
    });

    return toRecord(fileId, input.objects, viewport, background, nextRevision, now);
  });
}
