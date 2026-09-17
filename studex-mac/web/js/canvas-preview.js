/**
 * A canvas, drawn small and read-only.
 *
 * Documents embed diagrams by reference (the `canvas` block), so a page has to
 * be able to show a canvas it does not own and cannot edit. Re-using the real
 * editor for that would mean instantiating its tools, pointer handling and
 * autosave to draw something nobody can touch, so this is a separate and much
 * smaller renderer: it takes the stored objects and returns one SVG element.
 *
 * SVG rather than a bitmap because the embed has to stay sharp at whatever
 * width the document column happens to be, and because it costs nothing to
 * render — there is no canvas context, no image encoding and no cache to
 * invalidate when the diagram changes.
 */
import { svg, colorValue } from './dom.js';
import {
  outlinePoints, roughPath, dashFor, arrowHead, edgePoint, elbowPoints, seedOf,
  curvedPath, curveMidpoint,
} from './canvas-shape.js';

/** Matches HIGHLIGHT_MIN in the canvas editor: above this a stroke is a
 *  highlighter, and highlighter is translucent wherever it is drawn. */
const HIGHLIGHT_MIN = 8;

const PAD = 24;

/** The box every object in the canvas fits inside, in canvas coordinates. */
function bounds(objects) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  const grow = (x, y) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  for (const o of objects) {
    if (o.type === 'ink' || o.type === 'line') {
      for (const [x, y] of o.points) grow(x, y);
    } else if (o.type === 'connector') {
      // A connector has no coordinates of its own; it is bounded by the two
      // objects it joins, which are measured on their own account.
      continue;
    } else {
      grow(o.x, o.y);
      grow(o.x + (o.width ?? 220), o.y + (o.height ?? 120));
    }
  }

  if (minX === Infinity) return null;
  return { x: minX - PAD, y: minY - PAD, width: maxX - minX + PAD * 2, height: maxY - minY + PAD * 2 };
}

/** Centre of an object, which is where a connector attaches. */
function centre(o) {
  return { x: o.x + (o.width ?? 0) / 2, y: o.y + (o.height ?? 0) / 2 };
}

/**
 * Lays text out by hand, because SVG has no wrapping.
 *
 * The estimate is deliberately crude — this is a preview, and a line that
 * breaks a word early is a better outcome than measuring text in a hidden
 * element on every render.
 */
function wrapped(text, width, size) {
  const perLine = Math.max(4, Math.floor(width / (size * 0.55)));
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    if (!paragraph.trim()) { lines.push(''); continue; }
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length <= perLine) { line = candidate; continue; }
      if (line) lines.push(line);
      // A single word longer than the line is cut rather than allowed to
      // overflow the shape it is sitting in.
      line = word.length > perLine ? `${word.slice(0, perLine - 1)}…` : word;
    }
    if (line) lines.push(line);
  }
  return lines;
}

function textBlock(text, box, { size = 13, top = 20, colour = 'var(--color-neutral-900)', weight = null } = {}) {
  const lines = wrapped(text, box.width - 20, size);
  const max = Math.max(1, Math.floor((box.height - top) / (size * 1.35)));
  const shown = lines.slice(0, max);
  // The last visible line says there is more rather than stopping mid-thought.
  if (lines.length > max && shown.length) shown[shown.length - 1] = `${shown[shown.length - 1].slice(0, -1)}…`;

  return svg('text', {
    x: box.x + 10,
    y: box.y + top,
    'font-size': size,
    'font-weight': weight,
    fill: colour,
    'font-family': 'inherit',
  }, shown.map((line, i) => svg('tspan', {
    x: box.x + 10,
    dy: i === 0 ? 0 : size * 1.35,
    text: line,
  })));
}

function note(o) {
  const colour = colorValue(o.color);
  const shape = o.shape ?? 'rounded';
  const box = { x: o.x, y: o.y, width: o.width ?? 220, height: o.height ?? 120 };

  // The same outline the editor draws, moved into canvas coordinates — a
  // preview that squared off its diamonds would not be a preview of anything.
  const points = outlinePoints(shape, box.width, box.height).map(([x, y]) => [x + box.x, y + box.y]);
  const outline = svg('path', {
    d: roughPath(points, {
      roughness: o.roughness ?? 'architect',
      seed: seedOf(o.id),
      closed: true,
      radius: shape === 'rounded' ? 10 : 0,
    }),
    fill: o.fill ? colorValue(o.fill) : colour,
    'fill-opacity': o.fill ? 0.2 : 0.12,
    stroke: colour,
    'stroke-width': o.stroke ?? 1.5,
    'stroke-dasharray': dashFor(o.strokeStyle ?? 'solid', o.stroke ?? 1.5),
    'stroke-linejoin': 'round',
  });

  const group = svg('g', null, outline, o.text ? textBlock(o.text, box) : null);
  if (o.opacity !== undefined && o.opacity !== null) group.setAttribute('opacity', String(o.opacity));
  return group;
}

/** A standalone text block: no box around it, just the words. */
function textObject(o) {
  const box = { x: o.x, y: o.y, width: o.width ?? 200, height: o.height ?? 40 };
  return textBlock(o.text ?? '', box, {
    size: Math.min(28, o.fontSize ?? 20),
    top: Math.min(28, o.fontSize ?? 20),
    colour: colorValue(o.color ?? 'neutral'),
  });
}

/** A frame: the outline of a group and its name, and nothing filled in. */
function frame(o) {
  const colour = colorValue(o.color ?? 'neutral');
  return svg('g', null,
    svg('rect', {
      x: o.x, y: o.y, width: o.width ?? 400, height: o.height ?? 300, rx: 8,
      fill: 'none', stroke: colour, 'stroke-width': 1.5, 'stroke-opacity': 0.5,
    }),
    svg('text', { x: o.x, y: o.y - 6, 'font-size': 11, fill: colour, text: o.name ?? 'Frame' }),
  );
}

/** A free line or arrow, with whatever sits on its ends. */
function lineObject(o) {
  const colour = colorValue(o.color ?? 'accent');
  const group = svg('g', null, svg('polyline', {
    points: o.points.map((p) => `${p[0]},${p[1]}`).join(' '),
    fill: 'none',
    stroke: colour,
    'stroke-width': o.stroke ?? 1.5,
    'stroke-dasharray': dashFor(o.strokeStyle ?? 'solid', o.stroke ?? 1.5),
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  }));

  const first = o.points[0];
  const second = o.points[1] ?? first;
  const last = o.points[o.points.length - 1];
  const prior = o.points[o.points.length - 2] ?? last;
  const head = arrowHead(o.endArrow, last, prior, o.color ?? 'accent', o.stroke ?? 1.5);
  const tail = arrowHead(o.startArrow, first, second, o.color ?? 'accent', o.stroke ?? 1.5);
  if (head) group.appendChild(head);
  if (tail) group.appendChild(tail);
  return group;
}

function panel(o, kicker, body) {
  const box = { x: o.x, y: o.y, width: o.width ?? 220, height: o.height ?? 120 };
  return svg('g', null,
    svg('rect', {
      x: box.x, y: box.y, width: box.width, height: box.height, rx: 10,
      fill: 'var(--color-surface, #fff)',
      stroke: 'var(--color-neutral-300, #d4d4d8)',
      'stroke-width': 1,
    }),
    svg('text', {
      x: box.x + 10, y: box.y + 18,
      'font-size': 9, 'letter-spacing': 0.6,
      fill: 'var(--color-neutral-500, #71717a)',
      text: kicker,
    }),
    body ? textBlock(body, box, { top: 38, size: 12 }) : null,
  );
}

function ink(o) {
  const width = o.stroke ?? 1.5;
  return svg('polyline', {
    points: o.points.map((p) => `${p[0]},${p[1]}`).join(' '),
    fill: 'none',
    stroke: colorValue(o.color ?? 'accent'),
    'stroke-width': width,
    'stroke-opacity': width >= HIGHLIGHT_MIN ? 0.35 : 1,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  });
}

function connector(o, byId) {
  const from = byId.get(o.fromId);
  const to = byId.get(o.toId);
  // A connector whose ends were deleted is not drawn, the same as in the editor.
  if (!from || !to) return null;
  const a = centre(from);
  const b = centre(to);
  const colour = o.color ? colorValue(o.color) : 'var(--color-neutral-600, #52525b)';
  const fromBox = { x: from.x, y: from.y, width: from.width ?? 0, height: from.height ?? 0 };
  const toBox = { x: to.x, y: to.y, width: to.width ?? 0, height: to.height ?? 0 };
  const start = edgePoint(fromBox, b);
  const stop = edgePoint(toBox, a);
  const route = o.path ?? 'straight';
  const curved = route === 'curved';
  const path = route === 'elbow' ? elbowPoints(start, stop) : [[start.x, start.y], [stop.x, stop.y]];

  const shared = {
    fill: 'none',
    stroke: colour,
    'stroke-width': o.stroke ?? 1.5,
    'stroke-dasharray': dashFor(o.strokeStyle ?? 'solid', o.stroke ?? 1.5) ?? '4 4',
    'stroke-linejoin': 'round',
  };
  const line = curved
    ? svg('path', { d: curvedPath(start, stop), ...shared })
    : svg('polyline', { points: path.map((p) => `${p[0]},${p[1]}`).join(' '), ...shared });

  // An arrowhead points along the last leg of the route rather than along the
  // chord, which for an elbow is a different direction and for a curve leaves
  // the end horizontally whatever the two boxes are doing.
  const beforeEnd = curved ? { x: stop.x - 1, y: stop.y } : { x: path[path.length - 2][0], y: path[path.length - 2][1] };
  const afterStart = curved ? { x: start.x + 1, y: start.y } : { x: path[1][0], y: path[1][1] };
  const head = arrowHead(o.endArrow, [stop.x, stop.y], [beforeEnd.x, beforeEnd.y], o.color ?? 'neutral', o.stroke ?? 1.5);
  const tail = arrowHead(o.startArrow, [start.x, start.y], [afterStart.x, afterStart.y], o.color ?? 'neutral', o.stroke ?? 1.5);
  const mid = curved ? curveMidpoint(start, stop) : { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  if (!o.label && !head && !tail) return line;
  return svg('g', null, line, head, tail, o.label ? svg('text', {
    x: mid.x, y: mid.y - 4,
    'font-size': 11, 'text-anchor': 'middle',
    fill: colour,
    text: o.label,
  }) : null);
}

/**
 * Renders the objects of a canvas into one SVG element, fitted to its content.
 *
 * Returns null when there is nothing to draw, so a caller can tell an empty
 * diagram from a missing one and say something useful about each.
 */
export function canvasPreview(objects, { maxHeight = 420 } = {}) {
  const list = Array.isArray(objects) ? objects : [];
  const box = bounds(list);
  if (!box) return null;

  const byId = new Map(list
    .filter((o) => o.type !== 'connector' && o.type !== 'ink' && o.type !== 'line')
    .map((o) => [o.id, o]));

  const root = svg('svg', {
    class: 'canvas-preview',
    viewBox: `${box.x} ${box.y} ${box.width} ${box.height}`,
    // Fitting to the content's own aspect ratio keeps a wide flowchart wide
    // and a tall one tall, up to a ceiling so one stray object cannot make a
    // diagram taller than the page it sits on.
    style: { maxHeight: `${maxHeight}px`, aspectRatio: `${box.width} / ${box.height}` },
    preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
  });

  // Frames are the ground everything else is arranged on, so they go down
  // first; ink, lines and connectors sit beneath the objects, as in the editor.
  for (const o of list) if (o.type === 'frame') root.appendChild(frame(o));
  for (const o of list) {
    if (o.type === 'ink') root.appendChild(ink(o));
    else if (o.type === 'line') root.appendChild(lineObject(o));
    else if (o.type === 'connector') { const c = connector(o, byId); if (c) root.appendChild(c); }
  }
  for (const o of list) {
    if (o.type === 'note') root.appendChild(note(o));
    else if (o.type === 'text') root.appendChild(textObject(o));
    else if (o.type === 'flashcard') root.appendChild(panel(o, 'FLASHCARD', o.front));
    else if (o.type === 'pdf_excerpt') root.appendChild(panel(o, `PDF · PAGE ${o.page}`, o.quotedText ?? ''));
    else if (o.type === 'image') root.appendChild(panel(o, (o.alt ?? 'Image').toUpperCase(), ''));
  }

  return root;
}
