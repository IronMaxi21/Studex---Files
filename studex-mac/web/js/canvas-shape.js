/**
 * How a canvas element is drawn: its outline, its fill, and how hand-made it
 * looks.
 *
 * Shapes are painted as SVG behind their text rather than with CSS borders.
 * A CSS border can only ever be a rectangle or an ellipse drawn perfectly, and
 * the canvas needs a diamond, a hatched fill and a line that looks sketched —
 * none of which a border can do. Keeping the outline in SVG and the text in
 * HTML on top of it means the text is still selectable, still editable and
 * still laid out by the browser, while the shape around it can be anything.
 *
 * The roughening is deterministic: the same element jitters the same way every
 * time it is drawn, because it is seeded from the element's own id. A shape
 * that shivered on every redraw would be unusable.
 */
import { svg, colorValue } from './dom.js';

export const FILL_STYLES = ['solid', 'hachure', 'cross-hatch'];
export const STROKE_STYLES = ['solid', 'dashed', 'dotted'];
/** Excalidraw's three names for how precise a line is, least sketchy first. */
export const ROUGHNESS = ['architect', 'artist', 'cartoonist'];
export const ARROWHEADS = ['none', 'arrow', 'triangle', 'dot', 'bar'];
export const SHAPES = ['rounded', 'square', 'ellipse', 'diamond'];

const JITTER = { architect: 0, artist: 1.4, cartoonist: 3.2 };
/** A sketched line is drawn twice, the way a pen goes back over a shape. */
const PASSES = { architect: 1, artist: 2, cartoonist: 2 };

/** A small, fast, repeatable random source. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A number from a string, so an element's id can seed its own jitter. */
export function seedOf(id) {
  let h = 2166136261;
  for (let i = 0; i < String(id).length; i += 1) {
    h ^= String(id).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** The corners of a shape, as a closed ring of points. */
export function outlinePoints(shape, width, height) {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  if (shape === 'ellipse') {
    const steps = 44;
    const points = [];
    for (let i = 0; i < steps; i += 1) {
      const angle = (i / steps) * Math.PI * 2;
      points.push([w / 2 + (w / 2) * Math.cos(angle), h / 2 + (h / 2) * Math.sin(angle)]);
    }
    return points;
  }
  if (shape === 'diamond') return [[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]];
  return [[0, 0], [w, 0], [w, h], [0, h]];
}

/**
 * A path through `points`, roughened by `roughness`.
 *
 * Architect is the points themselves. The other two walk each edge in short
 * steps and nudge every step sideways, which is what makes a straight line
 * read as a drawn one rather than a printed one.
 */
export function roughPath(points, { roughness = 'architect', seed = 1, closed = true, radius = 0 } = {}) {
  const amount = JITTER[roughness] ?? 0;
  if (!points.length) return '';

  if (!amount) {
    if (radius > 0 && points.length === 4) return roundedRect(points, radius);
    const head = `M ${fix(points[0][0])} ${fix(points[0][1])}`;
    const rest = points.slice(1).map((p) => `L ${fix(p[0])} ${fix(p[1])}`).join(' ');
    return `${head} ${rest}${closed ? ' Z' : ''}`;
  }

  const random = seeded(seed);
  const wobble = () => (random() - 0.5) * 2 * amount;
  const ring = closed ? [...points, points[0]] : points;
  const parts = [];

  for (let i = 0; i < ring.length - 1; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    const length = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.max(2, Math.min(14, Math.round(length / 22)));
    if (i === 0) parts.push(`M ${fix(x1 + wobble())} ${fix(y1 + wobble())}`);
    for (let s = 1; s <= steps; s += 1) {
      const t = s / steps;
      parts.push(`L ${fix(x1 + (x2 - x1) * t + wobble())} ${fix(y1 + (y2 - y1) * t + wobble())}`);
    }
  }
  return parts.join(' ');
}

function roundedRect(points, radius) {
  const [tl, tr, br, bl] = points;
  const r = Math.max(0, Math.min(radius, Math.abs(tr[0] - tl[0]) / 2, Math.abs(bl[1] - tl[1]) / 2));
  return [
    `M ${fix(tl[0] + r)} ${fix(tl[1])}`,
    `L ${fix(tr[0] - r)} ${fix(tr[1])}`, `Q ${fix(tr[0])} ${fix(tr[1])} ${fix(tr[0])} ${fix(tr[1] + r)}`,
    `L ${fix(br[0])} ${fix(br[1] - r)}`, `Q ${fix(br[0])} ${fix(br[1])} ${fix(br[0] - r)} ${fix(br[1])}`,
    `L ${fix(bl[0] + r)} ${fix(bl[1])}`, `Q ${fix(bl[0])} ${fix(bl[1])} ${fix(bl[0])} ${fix(bl[1] - r)}`,
    `L ${fix(tl[0])} ${fix(tl[1] + r)}`, `Q ${fix(tl[0])} ${fix(tl[1])} ${fix(tl[0] + r)} ${fix(tl[1])}`,
    'Z',
  ].join(' ');
}

function fix(n) { return Math.round(n * 100) / 100; }

/** The dash pattern for a stroke style, scaled so it reads at any width. */
export function dashFor(strokeStyle, strokeWidth = 1.5) {
  const w = Math.max(1, strokeWidth);
  if (strokeStyle === 'dashed') return `${w * 4} ${w * 3}`;
  if (strokeStyle === 'dotted') return `${w * 0.1} ${w * 2.4}`;
  return null;
}

/**
 * The fill behind a shape.
 *
 * Solid is a colour. The other two are patterns, which have to be defined per
 * element because the colour is part of the pattern — so each one is given an
 * id built from the element's own, and lives in that element's own <defs>.
 */
export function fillFor(id, fillStyle, colour) {
  if (!colour) return { paint: 'none', defs: null };
  const hex = colorValue(colour);
  if (fillStyle !== 'hachure' && fillStyle !== 'cross-hatch') {
    return { paint: hex, defs: null, opacity: 0.16 };
  }

  const patternId = `hatch-${id}`;
  const line = (d) => svg('path', { d, stroke: hex, 'stroke-width': 1.2, 'stroke-linecap': 'round' });
  const pattern = svg('pattern', {
    id: patternId, width: 8, height: 8, patternUnits: 'userSpaceOnUse',
    patternTransform: 'rotate(45)',
  }, line('M 0 0 V 8'), fillStyle === 'cross-hatch' ? line('M 0 4 H 8') : null);

  return { paint: `url(#${patternId})`, defs: svg('defs', null, pattern), opacity: 0.9 };
}

/**
 * One element's outline, as an SVG sized to the element.
 *
 * `preserveAspectRatio` is left alone and the viewBox matches the pixel size,
 * so nothing is scaled: a roughened edge stays the same thickness whatever
 * shape it is drawn around.
 */
export function shapeSvg(object, width, height, { className = 'obj-shape' } = {}) {
  const shape = object.shape ?? 'rounded';
  const roughness = object.roughness ?? 'architect';
  const strokeWidth = object.stroke ?? 1.5;
  const inset = Math.max(1, strokeWidth) / 2;
  const w = Math.max(1, width - inset * 2);
  const h = Math.max(1, height - inset * 2);

  const points = outlinePoints(shape, w, h).map(([x, y]) => [x + inset, y + inset]);
  const seed = seedOf(object.id);
  const fill = fillFor(object.id, object.fillStyle ?? 'solid', object.fill ?? null);
  const stroke = colorValue(object.color ?? 'accent');
  const dash = dashFor(object.strokeStyle ?? 'solid', strokeWidth);

  const root = svg('svg', {
    class: className,
    width, height,
    viewBox: `0 0 ${width} ${height}`,
    'aria-hidden': 'true',
  });
  if (fill.defs) root.appendChild(fill.defs);

  const radius = shape === 'rounded' ? 12 : 0;
  const base = roughPath(points, { roughness, seed, closed: true, radius });

  if (fill.paint !== 'none') {
    root.appendChild(svg('path', { d: base, fill: fill.paint, 'fill-opacity': fill.opacity, stroke: 'none' }));
  }

  for (let pass = 0; pass < (PASSES[roughness] ?? 1); pass += 1) {
    root.appendChild(svg('path', {
      d: pass === 0 ? base : roughPath(points, { roughness, seed: seed + 977 * pass, closed: true, radius }),
      fill: 'none',
      stroke,
      'stroke-width': strokeWidth,
      'stroke-dasharray': dash,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'stroke-opacity': pass === 0 ? 1 : 0.55,
    }));
  }
  return root;
}

/**
 * The head on the end of a line, as a path.
 *
 * Drawn explicitly rather than with an SVG <marker>, because a marker takes
 * its colour from a definition that would have to be duplicated per colour and
 * given an id no other canvas could collide with.
 */
export function arrowHead(kind, tip, from, colour, strokeWidth = 1.5) {
  if (!kind || kind === 'none') return null;
  const size = Math.max(9, strokeWidth * 4.5);
  const angle = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
  const hex = colorValue(colour ?? 'accent');

  if (kind === 'dot') {
    return svg('circle', { cx: tip[0], cy: tip[1], r: size / 3, fill: hex });
  }
  if (kind === 'bar') {
    const nx = Math.cos(angle + Math.PI / 2) * (size / 2);
    const ny = Math.sin(angle + Math.PI / 2) * (size / 2);
    return svg('path', {
      d: `M ${fix(tip[0] - nx)} ${fix(tip[1] - ny)} L ${fix(tip[0] + nx)} ${fix(tip[1] + ny)}`,
      stroke: hex, 'stroke-width': strokeWidth * 1.4, 'stroke-linecap': 'round',
    });
  }

  const spread = kind === 'triangle' ? 0.42 : 0.55;
  const ax = tip[0] - Math.cos(angle - spread) * size;
  const ay = tip[1] - Math.sin(angle - spread) * size;
  const bx = tip[0] - Math.cos(angle + spread) * size;
  const by = tip[1] - Math.sin(angle + spread) * size;

  if (kind === 'triangle') {
    return svg('path', {
      d: `M ${fix(tip[0])} ${fix(tip[1])} L ${fix(ax)} ${fix(ay)} L ${fix(bx)} ${fix(by)} Z`,
      fill: hex, stroke: 'none',
    });
  }
  return svg('path', {
    d: `M ${fix(ax)} ${fix(ay)} L ${fix(tip[0])} ${fix(tip[1])} L ${fix(bx)} ${fix(by)}`,
    fill: 'none', stroke: hex, 'stroke-width': strokeWidth, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  });
}

/**
 * Where a line leaving `box` towards `to` should start.
 *
 * A connector drawn centre to centre disappears under both shapes; this walks
 * it out to the edge so the line begins where the shape ends. The shape is
 * treated as its bounding box, which is right for a rectangle and close enough
 * for the others at any size a reader can see.
 */
export function edgePoint(box, to) {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const dx = to.x - cx;
  const dy = to.y - cy;
  if (!dx && !dy) return { x: cx, y: cy };

  const scaleX = dx ? (box.width / 2) / Math.abs(dx) : Infinity;
  const scaleY = dy ? (box.height / 2) / Math.abs(dy) : Infinity;
  const scale = Math.min(scaleX, scaleY);
  return { x: cx + dx * scale, y: cy + dy * scale };
}

/** The right-angled way from a to b, as the points of a polyline. */
export function elbowPoints(a, b) {
  const midX = (a.x + b.x) / 2;
  return [[a.x, a.y], [midX, a.y], [midX, b.y], [b.x, b.y]];
}

/**
 * The curved way from a to b, as a path `d`.
 *
 * A cubic whose control points leave each end horizontally, which is the shape
 * a mindmap branch wants: the line comes out of the side of the parent and
 * goes into the side of the child rather than cutting the corner between them.
 * The handles are a third of the horizontal run, floored so that two boxes
 * almost above one another still bow rather than kinking.
 */
export function curvedPath(a, b) {
  const reach = Math.max(30, Math.abs(b.x - a.x) / 2);
  return `M ${fix(a.x)} ${fix(a.y)} C ${fix(a.x + reach)} ${fix(a.y)}, ${fix(b.x - reach)} ${fix(b.y)}, ${fix(b.x)} ${fix(b.y)}`;
}

/**
 * The point a curve of `curvedPath` passes through at its halfway mark, which
 * is where a label on it belongs.
 *
 * Both handles leave their end horizontally by the same reach, so the two
 * cancel in the cubic at t = 0.5 and the curve crosses its own chord's middle.
 */
export function curveMidpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
