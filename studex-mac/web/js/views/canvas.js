/** Screen 05 — infinite canvas. Notes, ink, connectors, pan and zoom. */
import { el, svg, icon, mount, applyColor, colorValue, colorLabel } from '../dom.js';
import { api } from '../api.js';
import { state, fileById, loadLibrary, toast, reportError } from '../store.js';
import { navigate, paneIsActive } from '../router.js';
import { topbar, fileCrumbs, pageMenu, fileItems } from '../shell.js';
import { openMenu } from '../menu.js';
import { promptText } from '../dialog.js';
import { relative, FILE_ICON } from '../format.js';
import { onPrint } from '../print.js';
import { onSmartMagnify } from '../native.js';
import { sfx } from '../sfx.js';
import { carriesBlock, readBlock, carriesItem, readItem, routeFor } from '../dnd.js';
import {
  shapeSvg, arrowHead, edgePoint, elbowPoints, curvedPath, curveMidpoint, dashFor,
  SHAPES,
} from '../canvas-shape.js';

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
/** One frame at 60Hz, the unit the coast is measured in. */
const FRAME_MS = 16;
/** A pause this long before letting go means the drag had already stopped. */
const HOLD_MS = 90;
/**
 * Five colours are enough to colour-code notes by topic without the palette
 * itself becoming the thing to study. Canvases saved with other roles still
 * draw in them; they just are not offered.
 */
const NOTE_COLORS = ['neutral', 'accent', 'sky', 'amber', 'rose'];
const STROKES = [2, 4, 8];

/** Custom ink colours picked recently, newest first, remembered per device. */
const RECENT_INKS_KEY = 'studex.canvas-inks';
function recentInks() {
  try { return JSON.parse(localStorage.getItem(RECENT_INKS_KEY) || '[]').filter((c) => /^#[0-9a-fA-F]{6}$/.test(c)); } catch { return []; }
}
function rememberInk(hex) {
  const next = [hex, ...recentInks().filter((c) => c.toLowerCase() !== hex.toLowerCase())].slice(0, 6);
  try { localStorage.setItem(RECENT_INKS_KEY, JSON.stringify(next)); } catch { /* this sitting only */ }
}

/**
 * The room a mindmap leaves around itself, in canvas units.
 *
 * A branch grows to the right and a sibling falls below it, which is the only
 * arrangement that stays readable as a tree gets deep: everything at one
 * remove from the root shares a column, so the eye can follow a level across
 * without having to find it again.
 */
const MIND_GAP_X = 80;
const MIND_GAP_Y = 22;
const MIND_NODE = { width: 180, height: 62 };

/**
 * The box a printed canvas lands in, in CSS pixels.
 *
 * web/css/print.css gives the canvas 170mm of a page whose width is whatever
 * the paper has left after 14mm of margin on each side — 182mm on A4, 190mm on
 * US Letter. The narrower is assumed, so a canvas fitted for one size of paper
 * is not cropped by the other, and the whole of it is inside the box either
 * way.
 */
const PRINT_BOX = { width: 688, height: 642 };

/** What a linked file calls itself on the plane. */
const LINK_KINDS = { doc: 'NOTE', pdf: 'PDF', deck: 'DECK', canvas: 'CANVAS' };
const PRINT_MARGIN = 12;

/**
 * A highlighter is an ink stroke laid down thick. The stored shape has no flag
 * for one, and inventing a field would leave every canvas already saved unable
 * to describe itself — so width carries the meaning, and anything this thick is
 * drawn translucent so it behaves like a highlighter rather than a fat pen.
 */
const HIGHLIGHT_STROKE = 16;
const HIGHLIGHT_MIN = 8;

/**
 * Pressure, as a multiplier on the width the pen was set to.
 *
 * A device that cannot report pressure is required by the spec to report 0.5
 * while its button is down, so 0.5 has to mean "exactly the width you chose"
 * and the range is built outwards from there rather than up from zero. The
 * floor is well clear of zero because a stroke that tapers away to nothing
 * reads as a rendering fault rather than as a light touch.
 */
const PRESSURE_FLOOR = 0.45;
const PRESSURE_CEILING = 1.55;

function pressureScale(pressure) {
  const p = typeof pressure === 'number' && pressure > 0 ? Math.min(1, pressure) : 0.5;
  return PRESSURE_FLOOR + (PRESSURE_CEILING - PRESSURE_FLOOR) * p;
}

/**
 * Whether a stroke carries pressure worth drawing.
 *
 * Every stroke drawn before the canvas read the field, and every stroke drawn
 * since with a mouse or a trackpad, is 0.5 from end to end — so this is false
 * for all of them and they keep the constant-width polyline they have always
 * been. Only a stroke that actually varies pays for the outline below.
 */
function hasPressure(points) {
  return points.some((p) => p[2] !== undefined && p[2] !== 0.5);
}

/**
 * A stroke whose width follows the pressure at each point, as a filled outline.
 *
 * SVG can only stroke a path at one width, so a nib that answers to the hand
 * has to be drawn rather than stroked: down one side of the spine, a half-circle
 * cap around the end, back up the other side, and a cap around the start. The
 * direction at a point is taken from its neighbours on both sides, which keeps
 * corners from pinching; a point that lands on top of the last one carries no
 * direction at all, so it borrows the last one that did.
 */
function inkOutline(points, nominal) {
  if (points.length < 2) return '';
  const half = (i) => (nominal * pressureScale(points[i][2])) / 2;
  const left = [];
  const right = [];
  let nx = 0;
  let ny = 0;

  for (let i = 0; i < points.length; i += 1) {
    const [x, y] = points[i];
    const prev = points[i - 1] ?? points[i];
    const next = points[i + 1] ?? points[i];
    const dx = next[0] - prev[0];
    const dy = next[1] - prev[1];
    const len = Math.hypot(dx, dy);
    if (len > 1e-4) { nx = -dy / len; ny = dx / len; }
    const h = half(i);
    left.push([x + nx * h, y + ny * h]);
    right.push([x - nx * h, y - ny * h]);
  }

  const at = ([x, y]) => `${round(x)},${round(y)}`;
  const last = points.length - 1;
  const endCap = round(half(last));
  const startCap = round(half(0));
  return [
    left.map((pt, i) => `${i === 0 ? 'M' : 'L'}${at(pt)}`).join(''),
    `A${endCap},${endCap} 0 0 0 ${at(right[last])}`,
    right.slice(0, -1).reverse().map((pt) => `L${at(pt)}`).join(''),
    `A${startCap},${startCap} 0 0 0 ${at(left[0])}`,
    'Z',
  ].join('');
}

export async function canvasView(route, host) {
  const fileId = route.path[1];
  if (!fileId) { navigate('library'); return; }

  const { canvas: record } = await api.canvas(fileId);
  const file = fileById(fileId) ?? (await api.file(fileId)).file;

  let objects = record.objects ?? [];
  let viewport = {
    x: record.viewport?.x ?? 0,
    y: record.viewport?.y ?? 0,
    zoom: record.viewport?.zoom ?? 1,
    rotation: record.viewport?.rotation ?? 0,
  };
  let revision = record.revision;

  let tool = 'select';
  let selectedId = null;
  /**
   * Everything selected. `selectedId` is the one of them the pointer last
   * landed on — the one resize handles and the style bar describe — and
   * `picked` is the whole set a move, a restyle or a delete applies to.
   */
  const picked = new Set();
  const select = (id) => { selectedId = id; picked.clear(); if (id) picked.add(id); };
  const selectedObjects = () => objects.filter((o) => picked.has(o.id));
  let drawColor = 'accent';
  let drawStroke = 4;
  /**
   * The rest of the pen.
   *
   * Everything the style panel sets lives here rather than on a selection,
   * because these are what the *next* shape will look like — and because a
   * panel that only worked once something was selected would be empty at
   * exactly the moment you reach for it. Changing one also retints whatever
   * is selected, so it reads as a property sheet when there is a selection
   * and as a pen when there is not.
   */
  let drawFill = null;

  /**
   * Snapping and the eraser's mode are habits of the hand rather than facts
   * about one canvas, so they are remembered on this device and carried to
   * every canvas opened after.
   */
  const pref = (key, fallback) => { try { return localStorage.getItem(`studex.canvas.${key}`) ?? fallback; } catch { return fallback; } };
  const keep = (key, value) => { try { localStorage.setItem(`studex.canvas.${key}`, String(value)); } catch { /* storage unavailable */ } };
  const GRID_SIZES = [
    { size: 9, label: 'Fine' },
    { size: 18, label: 'Medium' },
    { size: 36, label: 'Large' },
  ];
  let snapOn = pref('snap', 'on') === 'on';
  let gridSize = Number(pref('grid', 18));
  if (!GRID_SIZES.some((g) => g.size === gridSize)) gridSize = 18;
  /** `stroke` removes whatever the eraser touches; `pixel` cuts away only the touched part of a stroke. */
  let eraseMode = pref('erase', 'stroke') === 'pixel' ? 'pixel' : 'stroke';
  const snap = (value) => (snapOn ? Math.round(value / gridSize) * gridSize : value);
  const snapPoint = (point) => ({ x: snap(point.x), y: snap(point.y) });
  /** The first end of a connector, while its second end is being chosen. */
  let linkFrom = null;
  let dirty = false;
  let saving = false;
  let saveTimer = null;

  const status = el('span', { class: 'save-state' }, el('span', { text: `Saved ${relative(record.updated_at)}` }));
  const layer = el('div', { class: 'canvas-layer' });
  const inkLayer = svg('svg', { class: 'canvas-ink' });
  const grid = el('div', { class: 'canvas-grid' });
  const PAPERS = [
    { id: 'dots', label: 'Dotted', icon: 'dots-nine' },
    { id: 'lines', label: 'Lined', icon: 'rows' },
    { id: 'squares', label: 'Squared', icon: 'grid-four' },
    { id: 'plain', label: 'Plain', icon: 'square' },
  ];
  let paper = PAPERS.some((p) => p.id === record.background) ? record.background
    : PAPERS.some((p) => p.id === state.device?.canvas_grid) ? state.device.canvas_grid : 'dots';
  const stage = el('div', { class: 'canvas-wrap' }, grid, inkLayer, layer);
  const chrome = state.device?.canvas_chrome ?? 'floating_dock';

  /* ── persistence ───────────────────────────────────────────────────── */

  const setStatus = (node) => mount(status, node);

  async function save() {
    if (saving || !dirty) return;
    saving = true;
    dirty = false;
    setStatus(el('span', null, el('span', { class: 'spinner', style: { width: '11px', height: '11px' } }), ' Saving…'));
    try {
      const res = await api.saveCanvas(fileId, objects, viewport, revision, paper);
      revision = res.canvas.revision;
      setStatus(el('span', { text: 'Saved just now' }));
    } catch (err) {
      if (err?.status === 409) {
        setStatus(el('span', { style: { color: 'oklch(0.8 0.12 60)' }, text: 'Reloaded — edited elsewhere' }));
        const fresh = await api.canvas(fileId);
        objects = fresh.canvas.objects ?? [];
        revision = fresh.canvas.revision;
        // The steps behind us describe a canvas that no longer exists; undoing
        // into one would quietly overwrite whatever the other window just saved.
        past.length = 0;
        future.length = 0;
        snapshot = JSON.stringify(objects);
        drawObjects();
        drawChrome();
      } else {
        dirty = true;
        setStatus(el('span', { style: { color: 'oklch(0.78 0.12 25)' }, text: 'Not saved' }));
        reportError(err);
      }
    } finally {
      saving = false;
      // Re-arming the timer, not a new edit — the step is already remembered.
      if (dirty) schedule();
    }
  }

  function schedule(delay = 800) {
    dirty = true;
    setStatus(el('span', { text: 'Unsaved changes' }));
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, delay);
  }

  /** An edit: the object list moved, so the step before it is remembered. */
  function queue() {
    remember();
    schedule();
  }

  /**
   * Panning and zooming are saved as well, but they are not edits — nothing
   * about the objects changed — so they make no undo step, and do not pay on
   * every wheel tick for the comparison that would decide they hadn't.
   */
  function queueViewport() {
    schedule();
  }

  /* ── undo ──────────────────────────────────────────────────────────── */

  /**
   * Undo over the object list, the same shape as the document's.
   *
   * ⌘Z has always been in the Edit menu — MainMenu.swift sends `undo:` to the
   * first responder — but on a canvas the first responder had nothing to give
   * back, so an erased stroke was simply gone and an enabled menu item did
   * nothing. The objects are already a plain list, so a step is a copy of it.
   *
   * Every mutation already ends in `queue()`, which is why the remembering
   * happens there rather than at a dozen call sites that would eventually
   * disagree with each other. Steps coalesce: typing into a note, or nudging
   * one across the canvas, arrives as a run of small changes, and a run of
   * small changes should take one press to take back rather than forty.
   */
  const past = [];
  const future = [];
  let snapshot = JSON.stringify(objects);
  let snapshotAt = 0;
  const COALESCE_MS = 700;
  const HISTORY_LIMIT = 60;

  const depth = () => `${past.length > 0}/${future.length > 0}`;

  function remember() {
    const now = JSON.stringify(objects);
    if (now === snapshot) return;
    const before = depth();
    // Adding or removing an object is always its own step; editing one that is
    // already there folds into the step beside it if it lands soon enough.
    const structural = objects.length !== JSON.parse(snapshot).length;
    if (structural || Date.now() - snapshotAt > COALESCE_MS) {
      past.push(snapshot);
      if (past.length > HISTORY_LIMIT) past.shift();
      snapshotAt = Date.now();
    }
    // A fresh edit ends the branch redo would have walked back up.
    future.length = 0;
    snapshot = now;
    if (before !== depth()) drawChrome();
  }

  function undo() {
    // Mid-gesture the drag holds a node that the restored list may not contain.
    if (drag) return;
    const previous = past.pop();
    if (previous === undefined) { toast('Nothing to undo.'); return; }
    future.push(snapshot);
    restore(previous);
  }

  function redo() {
    if (drag) return;
    const next = future.pop();
    if (next === undefined) { toast('Nothing to redo.'); return; }
    past.push(snapshot);
    restore(next);
  }

  /**
   * Puts a remembered list back, without remembering the act of doing so —
   * hence the saving here rather than through `queue()`, which would push the
   * step that has just been taken back.
   */
  function restore(json) {
    objects = JSON.parse(json);
    snapshot = json;
    snapshotAt = 0;
    for (const id of [...picked]) if (!objects.some((o) => o.id === id)) picked.delete(id);
    if (!picked.has(selectedId)) selectedId = [...picked][0] ?? null;
    if (linkFrom && !objects.some((o) => o.id === linkFrom)) linkFrom = null;
    schedule(300);
    drawObjects();
    drawChrome();
  }

  /* ── viewport ──────────────────────────────────────────────────────── */

  const RAD = Math.PI / 180;

  /** A point turned about the origin. Positive degrees turn clockwise, as CSS does. */
  function spin(x, y, degrees) {
    if (!degrees) return { x, y };
    const cos = Math.cos(degrees * RAD);
    const sin = Math.sin(degrees * RAD);
    return { x: x * cos - y * sin, y: x * sin + y * cos };
  }

  function clampZoom(zoom) {
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
  }

  function applyViewport() {
    const turn = viewport.rotation ? ` rotate(${viewport.rotation}deg)` : '';
    layer.style.transform = `translate(${viewport.x}px, ${viewport.y}px)${turn} scale(${viewport.zoom})`;
    inkLayer.style.transform = layer.style.transform;
    // Handles and outlines are sized in screen pixels, whatever the zoom.
    stage.style.setProperty('--inv-zoom', String(1 / viewport.zoom));
    drawGrid();
    drawZoomLabel();
  }

  /**
   * The paper under the drawing.
   *
   * It used to be a background on the stage, which was enough while the plane
   * could only slide and scale — a background tile cannot be turned, and until
   * there was a rotate gesture nothing ever asked it to. Now it is its own
   * layer, turned with the plane: a square as wide as the stage's diagonal, so
   * that at any angle its corners still cover the window's.
   */
  function drawGrid() {
    const rect = stage.getBoundingClientRect();
    const side = Math.hypot(rect.width, rect.height);
    const originX = (rect.width - side) / 2;
    const originY = (rect.height - side) / 2;
    const centre = side / 2;

    // Inside the turned layer the plane is square again, so the pattern only
    // has to be scaled; it is the pattern's origin that comes back through the
    // rotation, about the square's own middle, which is what CSS turns it on.
    const at = spin(viewport.x - originX - centre, viewport.y - originY - centre, -viewport.rotation);
    // Lined paper is for writing on, so its rows are two grid steps tall.
    const size = gridSize * viewport.zoom * (paper === 'lines' ? 2 : 1);

    Object.assign(grid.style, {
      left: `${originX}px`,
      top: `${originY}px`,
      width: `${side}px`,
      height: `${side}px`,
      transform: viewport.rotation ? `rotate(${viewport.rotation}deg)` : '',
      backgroundSize: `${size}px ${size}px`,
      backgroundPosition: `${at.x + centre}px ${at.y + centre}px`,
    });
  }

  /** Screen coordinates → canvas coordinates. */
  function toCanvas(clientX, clientY) {
    const rect = stage.getBoundingClientRect();
    const at = spin(clientX - rect.left - viewport.x, clientY - rect.top - viewport.y, -viewport.rotation);
    return { x: at.x / viewport.zoom, y: at.y / viewport.zoom };
  }

  /**
   * Moves and scales the viewport so that a canvas point stays under a point on
   * the screen. Every zoom in the app is anchored on something — the cursor,
   * the fingers, the middle of the window — because a zoom that is not is a
   * zoom that loses whatever you were looking at.
   *
   * The rotation is read as it stands, so a gesture that turns and pinches at
   * once must set the angle first.
   */
  function anchor(point, clientX, clientY, zoom = viewport.zoom) {
    const rect = stage.getBoundingClientRect();
    const at = spin(point.x * zoom, point.y * zoom, viewport.rotation);
    viewport.x = clientX - rect.left - at.x;
    viewport.y = clientY - rect.top - at.y;
    viewport.zoom = zoom;
  }

  /* ── momentum ──────────────────────────────────────────────────────── */

  /**
   * A pan that has been let go of still has a speed.
   *
   * Two fingers on a trackpad get this from the system: the scroll events keep
   * arriving after the fingers lift, with deltas that fall away. A drag — with
   * a mouse, a pen, or the hand tool — gets no such help, and stopping dead the
   * instant the button comes up is the single clearest tell that a canvas is a
   * web page. So the last few milliseconds of travel become a velocity, and the
   * plane coasts to a stop against a constant friction.
   *
   * Anything that touches the viewport cancels it, so a coast is never
   * something the next gesture has to fight.
   */
  const FRICTION = 0.94;
  /** Pixels per frame below which the motion is no longer visible. */
  const GLIDE_FLOOR = 0.1;
  /** A flick can be fast; a bad sample can be absurd. */
  const GLIDE_CEILING = 90;

  const glide = (() => {
    let handle = 0;
    let vx = 0;
    let vy = 0;

    const step = () => {
      vx *= FRICTION;
      vy *= FRICTION;
      if (Math.abs(vx) < GLIDE_FLOOR && Math.abs(vy) < GLIDE_FLOOR) {
        handle = 0;
        queueViewport();
        return;
      }
      viewport.x += vx;
      viewport.y += vy;
      applyViewport();
      handle = requestAnimationFrame(step);
    };

    return {
      start(x, y) {
        const clamp = (v) => Math.max(-GLIDE_CEILING, Math.min(GLIDE_CEILING, v));
        if (Math.abs(x) < GLIDE_FLOOR && Math.abs(y) < GLIDE_FLOOR) { queueViewport(); return; }
        vx = clamp(x);
        vy = clamp(y);
        handle = requestAnimationFrame(step);
      },
      stop() {
        if (!handle) return;
        cancelAnimationFrame(handle);
        handle = 0;
        queueViewport();
      },
    };
  })();

  stage.addEventListener('wheel', (event) => {
    event.preventDefault();
    glide.stop();
    zoomedFrom = null;
    if (event.ctrlKey || event.metaKey) {
      // Pinch-zoom on a trackpad without gesture events, and ⌘-scroll with a
      // mouse, both arrive here as a ctrl-wheel event.
      const factor = Math.exp(-event.deltaY / 180);
      anchor(
        toCanvas(event.clientX, event.clientY),
        event.clientX, event.clientY,
        clampZoom(viewport.zoom * factor),
      );
    } else {
      viewport.x -= event.deltaX;
      viewport.y -= event.deltaY;
    }
    applyViewport();
    queueViewport();
  }, { passive: false });

  /* ── trackpad gestures ─────────────────────────────────────────────── */

  /**
   * Pinch and twist, as the trackpad reports them.
   *
   * WebKit sends `gesturestart`/`gesturechange` with a `scale` and a `rotation`
   * measured from the moment the fingers went down, not from the last event —
   * which is why the viewport is remembered at the start and recomputed from
   * it each time rather than accumulated. Accumulating drifts, and a gesture
   * that drifts is one the hand cannot undo by going back the way it came.
   *
   * The twist turns the plane, not the objects on it: what is written on a
   * canvas stays the right way up relative to the canvas, and turning the page
   * to write in a margin is a thing people do with paper.
   */
  /** How close to square counts as square. Nobody twisting by hand means 88.6°. */
  const SNAP_DEGREES = 6;

  let gesture = null;

  stage.addEventListener('gesturestart', (event) => {
    event.preventDefault();
    glide.stop();
    zoomedFrom = null;
    gesture = {
      zoom: viewport.zoom,
      rotation: viewport.rotation,
      at: toCanvas(event.clientX, event.clientY),
      clientX: event.clientX,
      clientY: event.clientY,
    };
  });

  stage.addEventListener('gesturechange', (event) => {
    event.preventDefault();
    if (!gesture) return;
    const turned = gesture.rotation + event.rotation;
    const square = Math.round(turned / 90) * 90;
    viewport.rotation = Math.abs(turned - square) < SNAP_DEGREES ? square : turned;
    // Set before the anchor, which turns the pivot through it: the point under
    // the fingers has to stay under the fingers while both are happening.
    anchor(gesture.at, gesture.clientX, gesture.clientY, clampZoom(gesture.zoom * event.scale));
    applyViewport();
  });

  const endGesture = (event) => {
    event.preventDefault();
    if (!gesture) return;
    gesture = null;
    // Three full turns and a bit is a bit, and the number in the corner should
    // say so — and the stored angle has a turn each way to live in.
    viewport.rotation = ((viewport.rotation % 360) + 360) % 360;
    if (viewport.rotation > 180) viewport.rotation -= 360;
    applyViewport();
    queueViewport();
  };

  stage.addEventListener('gestureend', endGesture);

  /* ── smart zoom ────────────────────────────────────────────────────── */

  /**
   * The two-finger double tap, and the double click that stands in for it.
   *
   * macOS hands smart magnify to the view rather than to the page, so the
   * shell forwards the point (see WebViewController.swift). What it means here
   * is what it means in Preview: go in on whatever is under the pointer, and
   * if you are already there, come back out to exactly where you were. With
   * nothing under the pointer the subject is the whole canvas, so it fits.
   */
  let zoomedFrom = null;

  function smartZoom(clientX, clientY) {
    glide.stop();
    if (zoomedFrom) {
      viewport = zoomedFrom;
      zoomedFrom = null;
      applyViewport();
      queueViewport();
      return;
    }

    const before = { ...viewport };
    const at = toCanvas(clientX, clientY);
    // Last first: the objects are drawn in order, so the last one that covers
    // the point is the one the pointer is actually on.
    const target = boxObjects().reverse().find((o) => at.x >= o.x
      && at.x <= o.x + (o.width ?? 0)
      && at.y >= o.y
      && at.y <= o.y + (o.height ?? 0));

    if (target) frame({ x: target.x, y: target.y, width: target.width ?? 0, height: target.height ?? 0 }, 60);
    else fit();
    zoomedFrom = before;
  }

  const stopSmartZoom = onSmartMagnify(smartZoom);

  // A line dragged out of a document lands as a sticky note where it is let go;
  // a file dragged out of the library lands as a card that opens it.
  stage.addEventListener('dragover', (event) => {
    if (!carriesBlock(event) && !carriesItem(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = carriesItem(event) ? 'link' : 'copy';
  });

  /** How wide a dropped file stands on the plane. */
  const LINK_SIZE = { width: 210, height: 84 };

  stage.addEventListener('drop', (event) => {
    if (!carriesItem(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const item = readItem(event);
    const dropped = (item?.items ?? (item ? [item] : []))
      .filter((one) => one.kind === 'file' && one.id !== fileId);
    if (!dropped.length) {
      if (item?.id === fileId) toast('That is this canvas.');
      return;
    }
    const at = toCanvas(event.clientX, event.clientY);
    // Several at once come down in a column, in the order they were picked up,
    // rather than in one pile that has to be dealt out by hand.
    dropped.forEach((one, i) => {
      objects.push({
        id: crypto.randomUUID(), type: 'link',
        x: round(at.x - LINK_SIZE.width / 2),
        y: round(at.y - LINK_SIZE.height / 2 + i * (LINK_SIZE.height + 12)),
        ...LINK_SIZE,
        fileId: one.id,
        title: fileById(one.id)?.title ?? one.title ?? 'Untitled',
      });
    });
    select(objects[objects.length - 1].id);
    queue();
    drawObjects();
    sfx('drop');
    toast(dropped.length === 1 ? 'Added to the canvas.' : `${dropped.length} added to the canvas.`);
  });

  stage.addEventListener('drop', (event) => {
    if (!carriesBlock(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const line = readBlock(event);
    if (!line) return;
    const at = toCanvas(event.clientX, event.clientY);
    const text = line.back ? `${line.front}\n\n${line.back}` : line.text;
    const object = {
      id: crypto.randomUUID(), type: 'note',
      x: round(at.x - 110), y: round(at.y - 60), width: 220, height: text.length > 120 ? 180 : 120,
      text, shape: 'rounded', ...penStyle(), stroke: 1.5,
    };
    objects.push(object);
    select(object.id);
    queue();
    drawObjects();
    toast('Added as a sticky note.');
  });

  stage.addEventListener('dblclick', (event) => {
    // Only when the pointer is on the canvas itself, and only when the tool in
    // hand does not already make something out of a click: two notes and then
    // a lurch across the plane is nobody's idea of a double click.
    if (tool !== 'select' && tool !== 'pan') return;
    if (event.target !== stage && event.target !== grid && event.target !== layer && event.target !== inkLayer) return;
    smartZoom(event.clientX, event.clientY);
  });

  /* ── pointer interaction ───────────────────────────────────────────── */

  /**
   * The tools that are drawn rather than dropped, and the default each falls
   * back to when the gesture was a click rather than a drag.
   *
   * A click still has to work: reaching for a shape and tapping once is how
   * most of these get made, and answering that with a zero-sized object would
   * be a worse tool than the one this replaces.
   */
  const DRAWABLE = {
    note: { type: 'note', shape: 'rounded', preview: 'rounded', width: 220, height: 120 },
    rect: { type: 'note', shape: 'square', preview: 'square', width: 170, height: 130 },
    diamond: { type: 'note', shape: 'diamond', preview: 'diamond', width: 180, height: 140 },
    ellipse: { type: 'note', shape: 'ellipse', preview: 'ellipse', width: 170, height: 130 },
    text: { type: 'text', preview: 'text', width: 240, height: 44 },
    frame: { type: 'frame', preview: 'frame', width: 480, height: 340 },
    card: { type: 'flashcard', preview: 'square', width: 230, height: 140 },
  };

  /**
   * The tools that are two points rather than a box.
   *
   * A line and an arrow are the same object — the arrow is a line that has
   * something on its end — so they share everything below and differ only in
   * what they start out wearing.
   */
  const LINEAR = {
    line: { startArrow: 'none', endArrow: 'none' },
    arrow: { startArrow: 'none', endArrow: 'arrow' },
  };

  /** Snaps a drag to the nearest 45°, for the shift key. */
  function constrain(from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const step = Math.PI / 4;
    const angle = Math.round(Math.atan2(dy, dx) / step) * step;
    const reach = Math.hypot(dx, dy);
    return { x: from.x + Math.cos(angle) * reach, y: from.y + Math.sin(angle) * reach };
  }

  /** Below this the gesture was a click, not a drag. In canvas units. */
  const DRAW_THRESHOLD = 8;

  let drag = null;

  /* ── what the pointer's own hardware is saying ──────────────────────── */

  /**
   * When a pen last reported anything, hovering included. Palm rejection turns
   * on it: a broad contact that arrives while the stylus is in the air just
   * above the glass is the hand resting on it, not a finger drawing.
   */
  let penSeenAt = 0;
  const PEN_PROXIMITY_MS = 900;
  /** Wider than this, in CSS pixels, and the contact is a palm, not a finger. */
  const PALM_CONTACT = 40;
  /** Half a canvas unit apart is below what any screen can show them apart at,
      and a stroke has a ten-thousand point ceiling to stay inside. */
  const INK_MIN_STEP = 0.5;

  /**
   * What the device says it is being pressed with. A mouse and a trackpad
   * report the constant 0.5 the spec requires of them, which maps to exactly
   * the nominal width — so nothing downstream has to special-case them.
   */
  const pressureOf = (event) =>
    Math.round(Math.min(1, Math.max(0, event.pressure || 0.5)) * 100) / 100;

  function addInkPoint(sample) {
    const at = toCanvas(sample.clientX, sample.clientY);
    const last = drag.points[drag.points.length - 1];
    if (Math.hypot(at.x - last[0], at.y - last[1]) < INK_MIN_STEP) return;
    drag.points.push([round(at.x), round(at.y), pressureOf(sample)]);
  }

  /** Redraws the stroke in flight, in whichever of the two shapes it is. */
  function drawInkPreview() {
    if (drag.variable) drag.preview.setAttribute('d', inkOutline(drag.points, drag.width));
    else drag.preview.setAttribute('points', drag.points.map((pt) => `${pt[0]},${pt[1]}`).join(' '));
  }

  stage.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'pen') penSeenAt = Date.now();
    // The palm goes down before the nib does, and it is wide. A touch that
    // arrives with no pen anywhere near is a finger, and still draws.
    if (event.pointerType === 'touch'
      && Date.now() - penSeenAt < PEN_PROXIMITY_MS
      && (event.width >= PALM_CONTACT || event.height >= PALM_CONTACT)) return;

    // Whatever this press turns out to be, a plane still coasting under it is
    // a plane the hand did not ask for.
    glide.stop();

    if (event.button === 1 || (event.button === 0 && event.altKey) || tool === 'pan') {
      zoomedFrom = null;
      drag = {
        kind: 'pan',
        startX: event.clientX, startY: event.clientY,
        originX: viewport.x, originY: viewport.y,
        // The travel of the last moment, for the coast after the release.
        vx: 0, vy: 0, lastX: event.clientX, lastY: event.clientY, lastAt: event.timeStamp,
      };
      stage.classList.add('panning');
      stage.setPointerCapture(event.pointerId);
      return;
    }

    // A pen, a shape or the eraser starts wherever it is put down — over a
    // note as readily as over empty paper — and must not hand focus to the
    // text it happens to land on. Select only acts on the paper itself; an
    // object under it has its own handler.
    const drawing = tool === 'ink' || tool === 'highlight' || tool === 'eraser'
      || tool in DRAWABLE || tool in LINEAR;
    const onPaper = event.target === stage || event.target === layer
      || event.target === inkLayer || event.target === grid;
    if (!onPaper && !drawing) return;
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    if (drawing) event.preventDefault();

    // A stylus turned over reports itself as a pen with button 5 held down.
    // It is an eraser in the hand, so it is an eraser here, whatever the
    // toolbar happens to say — and the toolbar is left exactly as it was, so
    // turning the pen back the right way up resumes drawing.
    const flipped = event.pointerType === 'pen' && (event.buttons & 32) !== 0;

    if (tool === 'eraser' || flipped) {
      drag = { kind: 'erase', last: null };
      stage.setPointerCapture(event.pointerId);
      eraseAt(event.clientX, event.clientY);
      return;
    }

    if (LINEAR[tool]) {
      const at = snapPoint(toCanvas(event.clientX, event.clientY));
      drag = {
        kind: 'line',
        spec: LINEAR[tool],
        anchor: at,
        to: at,
        preview: svg('polyline', {
          fill: 'none',
          stroke: colorValue(drawColor),
          'stroke-width': drawStroke,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        }),
      };
      inkLayer.appendChild(drag.preview);
      stage.setPointerCapture(event.pointerId);
      return;
    }

    if (DRAWABLE[tool]) {
      // Drawn rather than dropped: the drag decides the size, and the anchor is
      // wherever the pointer went down — so dragging up and to the left builds
      // the shape in that direction instead of refusing to.
      const at = snapPoint(toCanvas(event.clientX, event.clientY));
      const spec = DRAWABLE[tool];
      drag = {
        kind: 'draw',
        spec,
        anchor: at,
        box: { x: at.x, y: at.y, width: 0, height: 0 },
        preview: el('div', { class: `draw-preview ${spec.preview}` }),
      };
      layer.appendChild(drag.preview);
      stage.setPointerCapture(event.pointerId);
      return;
    }

    if (tool === 'ink' || tool === 'highlight') {
      const width = tool === 'highlight' ? HIGHLIGHT_STROKE : drawStroke;
      const at = toCanvas(event.clientX, event.clientY);
      // A highlighter is a chisel of one width and stays one width. A pen is a
      // nib, and a nib answers to the hand — but only a device that can say how
      // hard it is being pressed has anything to answer with, so everything
      // else keeps the constant-width polyline it has always drawn.
      const variable = tool !== 'highlight' && event.pointerType === 'pen';
      const preview = variable
        ? svg('path', { fill: colorValue(drawColor), stroke: 'none' })
        : svg('polyline', {
            fill: 'none', stroke: colorValue(drawColor), 'stroke-width': width,
            'stroke-opacity': width >= HIGHLIGHT_MIN ? 0.35 : 1,
            'stroke-linecap': 'round', 'stroke-linejoin': 'round',
          });
      drag = {
        kind: 'ink', width, variable, preview,
        points: [[round(at.x), round(at.y), pressureOf(event)]],
      };
      inkLayer.appendChild(preview);
      stage.setPointerCapture(event.pointerId);
      return;
    }

    // Empty canvas under the select tool: a marquee. Shift adds to what is
    // already selected rather than starting again.
    if (linkFrom) { linkFrom = null; drawChrome(); }
    if (tool !== 'select') { select(null); drawObjects(); return; }
    if (!event.shiftKey) select(null);
    const rect = stage.getBoundingClientRect();
    drag = {
      kind: 'marquee',
      startX: event.clientX - rect.left, startY: event.clientY - rect.top,
      base: new Set(picked),
      box: el('div', { class: 'marquee' }),
    };
    stage.appendChild(drag.box);
    stage.setPointerCapture(event.pointerId);
    drawObjects();
  });

  stage.addEventListener('pointermove', (event) => {
    // Taken before the guard: a stylus hovering over the canvas is not dragging
    // anything, and hovering is exactly when the palm arrives.
    if (event.pointerType === 'pen') penSeenAt = Date.now();
    if (!drag) return;
    if (drag.kind === 'pan') {
      viewport.x = drag.originX + (event.clientX - drag.startX);
      viewport.y = drag.originY + (event.clientY - drag.startY);
      // Smoothed towards the newest sample rather than taken from it: pointer
      // timings are ragged, and one short frame at the end of an otherwise
      // steady drag should not decide how far the canvas flies.
      const elapsed = Math.max(1, event.timeStamp - drag.lastAt);
      const perFrame = FRAME_MS / elapsed;
      drag.vx = drag.vx * 0.6 + (event.clientX - drag.lastX) * perFrame * 0.4;
      drag.vy = drag.vy * 0.6 + (event.clientY - drag.lastY) * perFrame * 0.4;
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;
      drag.lastAt = event.timeStamp;
      applyViewport();
    } else if (drag.kind === 'ink') {
      // Coalesced events are the samples the device actually took between one
      // frame and the next. A pen samples several times faster than the display
      // refreshes, and reading them rather than one point per frame is the
      // difference between a curve and a polygon.
      const samples = event.getCoalescedEvents ? event.getCoalescedEvents() : [];
      for (const sample of samples.length > 0 ? samples : [event]) addInkPoint(sample);
      drawInkPreview();
    } else if (drag.kind === 'draw') {
      const at = snapPoint(toCanvas(event.clientX, event.clientY));
      // Normalised, so which corner the drag started from stops mattering.
      drag.box = {
        x: Math.min(drag.anchor.x, at.x),
        y: Math.min(drag.anchor.y, at.y),
        width: Math.abs(at.x - drag.anchor.x),
        height: Math.abs(at.y - drag.anchor.y),
      };
      Object.assign(drag.preview.style, {
        left: `${drag.box.x}px`,
        top: `${drag.box.y}px`,
        width: `${drag.box.width}px`,
        height: `${drag.box.height}px`,
      });
    } else if (drag.kind === 'line') {
      const at = toCanvas(event.clientX, event.clientY);
      // Shift is the straight edge: held, the line lands on the nearest
      // eighth of a turn rather than wherever the hand happened to stop.
      drag.to = event.shiftKey ? constrain(drag.anchor, at) : snapPoint(at);
      drag.preview.setAttribute('points', `${round(drag.anchor.x)},${round(drag.anchor.y)} ${round(drag.to.x)},${round(drag.to.y)}`);
    } else if (drag.kind === 'marquee') {
      const rect = stage.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const box = {
        left: Math.min(x, drag.startX), top: Math.min(y, drag.startY),
        right: Math.max(x, drag.startX), bottom: Math.max(y, drag.startY),
      };
      Object.assign(drag.box.style, {
        left: `${box.left}px`, top: `${box.top}px`,
        width: `${box.right - box.left}px`, height: `${box.bottom - box.top}px`,
      });
      const next = new Set(drag.base);
      for (const object of objects) if (object.type !== 'connector' && inMarquee(object, box)) next.add(object.id);
      const same = next.size === picked.size && [...next].every((id) => picked.has(id));
      if (!same) {
        picked.clear();
        for (const id of next) picked.add(id);
        selectedId = [...picked].pop() ?? null;
        drawObjects();
      }
    } else if (drag.kind === 'erase') {
      eraseAt(event.clientX, event.clientY);
    } else if (drag.kind === 'resize') {
      resizeTo(event.clientX, event.clientY, event.shiftKey);
    } else if (drag.kind === 'move') {
      const at = toCanvas(event.clientX, event.clientY);
      const object = objects.find((o) => o.id === drag.id);
      if (object) {
        // A line keeps its position in its points and a box keeps it in its
        // corner, so the delta is measured from whichever one this has.
        const linear = Array.isArray(object.points);
        const fromX = linear ? object.points[0][0] : object.x;
        const fromY = linear ? object.points[0][1] : object.y;
        // The grabbed object's corner lands on the grid; everything carried
        // with it moves by the same step, so a group keeps its own spacing.
        const dx = round(snap(at.x - drag.offsetX)) - fromX;
        const dy = round(snap(at.y - drag.offsetY)) - fromY;
        translate(object, dx, dy);
        if (!linear && drag.node) {
          drag.node.style.left = `${object.x}px`;
          drag.node.style.top = `${object.y}px`;
        }
        // A frame is a container, and a container that left its contents
        // behind when it moved would not be one.
        for (const child of drag.carried ?? []) {
          translate(child, dx, dy);
          const node = layer.querySelector(`[data-obj="${child.id}"]`);
          if (node) { node.style.left = `${child.x}px`; node.style.top = `${child.y}px`; }
        }
        drawConnectors();
      }
    }
  });

  stage.addEventListener('pointerup', (event) => {
    if (!drag) return;
    if (drag.kind === 'pan') {
      stage.classList.remove('panning');
      // A hand that stopped before it let go meant to stop there. Only a
      // release that is still moving gets a coast.
      const still = event.timeStamp - drag.lastAt > HOLD_MS;
      if (still) queueViewport(); else glide.start(drag.vx, drag.vy);
    }
    else if (drag.kind === 'ink') {
      drag.preview.remove();
      // A stroke needs at least two points to be a stroke.
      if (drag.points.length >= 2) {
        objects.push({
          id: crypto.randomUUID(),
          type: 'ink',
          x: 0, y: 0,
          points: drag.points.slice(0, 10_000),
          color: drawColor,
          stroke: drag.width,
        });
        queue();
        drawObjects();
      }
      // The pen stays down: a tool you have to pick up again after every
      // stroke is not a pen. Escape, or Select, puts it away.
      drawChrome();
    } else if (drag.kind === 'line') {
      drag.preview.remove();
      const { anchor, to, spec } = drag;
      // A line from a point to itself is a click, and a click with the line
      // tool in hand meant nothing rather than a zero-length line.
      if (Math.hypot(to.x - anchor.x, to.y - anchor.y) >= DRAW_THRESHOLD) addLine(anchor, to, spec);
      tool = 'select';
      drawChrome();
      updateCursor();
    } else if (drag.kind === 'draw') {
      drag.preview.remove();
      const { spec, box, anchor } = drag;
      const drawn = Math.max(box.width, box.height) >= DRAW_THRESHOLD;
      const geometry = drawn
        ? {
            x: box.x,
            y: box.y,
            width: Math.max(MIN_SIZE, box.width),
            height: Math.max(MIN_SIZE, box.height),
          }
        : { x: anchor.x, y: anchor.y, width: spec.width, height: spec.height };

      if (spec.type === 'flashcard') addFlashcard(geometry);
      else if (spec.type === 'text') addText(geometry);
      else if (spec.type === 'frame') addFrame(geometry);
      else addNote(geometry, spec.shape);

      tool = 'select';
      drawChrome();
      updateCursor();
    } else if (drag.kind === 'marquee') { drag.box.remove(); drawObjects(); }
    else if (drag.kind === 'erase') { queue(); drawObjects(); }
    else if (drag.kind === 'resize') { queue(); drawObjects(); }
    else if (drag.kind === 'move') { queue(); drawObjects(); }
    drag = null;
    try { stage.releasePointerCapture(event.pointerId); } catch { /* already released */ }
  });

  /* ── objects ───────────────────────────────────────────────────────── */

  /** The pen as it stands, as the fields a drawn shape carries. */
  function penStyle() {
    return {
      color: drawColor,
      fill: drawFill,
      fillStyle: 'solid',
      stroke: drawStroke,
      strokeStyle: 'solid',
      roughness: 'architect',
      opacity: 1,
    };
  }

  /** Moves an object by a delta, whichever of the two shapes it has. */
  function translate(object, dx, dy) {
    if (Array.isArray(object.points)) {
      for (const point of object.points) {
        point[0] = round(point[0] + dx);
        point[1] = round(point[1] + dy);
      }
      return;
    }
    object.x = round(object.x + dx);
    object.y = round(object.y + dy);
  }

  /**
   * What a frame is holding: everything wholly inside it.
   *
   * Wholly, rather than overlapping, because a shape that is half in and half
   * out was not put in the frame — and dragging the frame off with somebody
   * else's diagram hanging from its edge is a worse surprise than leaving
   * behind something that was nearly inside.
   *
   * Frames do not nest: a frame inside a frame would need a tree, and one
   * level of grouping is what the tool is for.
   */
  function carriedBy(container) {
    const width = container.width ?? 0;
    const height = container.height ?? 0;
    const inside = (x, y) => x >= container.x && x <= container.x + width
      && y >= container.y && y <= container.y + height;
    return objects.filter((o) => {
      if (o.id === container.id || o.type === 'connector' || o.type === 'frame') return false;
      if (Array.isArray(o.points)) return o.points.every(([x, y]) => inside(x, y));
      return inside(o.x, o.y) && inside(o.x + (o.width ?? 0), o.y + (o.height ?? 0));
    });
  }

  function addNote(box, shape = 'rounded') {
    const object = {
      id: crypto.randomUUID(),
      type: 'note',
      x: round(box.x), y: round(box.y),
      width: round(box.width),
      height: round(box.height),
      text: '',
      shape,
      ...penStyle(),
      stroke: 1.5,
    };
    objects.push(object);
    select(object.id);
    queue();
    drawObjects();
    if (shape === 'rounded') setTimeout(() => layer.querySelector(`[data-obj="${object.id}"] .text-edit`)?.focus(), 0);
  }

  /**
   * A standalone text block: words on the plane with nothing drawn around
   * them. It is a note with the box taken away rather than a note with a
   * transparent fill, because a note has an outline, a fill style and a
   * roughness, and none of those mean anything to a caption.
   */
  function addText(box) {
    const object = {
      id: crypto.randomUUID(),
      type: 'text',
      x: round(box.x), y: round(box.y),
      width: round(box.width),
      height: round(box.height),
      text: '',
      color: drawColor,
      fontSize: 20,
      align: 'left',
      opacity: 1,
    };
    objects.push(object);
    select(object.id);
    queue();
    drawObjects();
    setTimeout(() => layer.querySelector(`[data-obj="${object.id}"] .text-edit`)?.focus(), 0);
  }

  /** A titled container. Drawn behind everything, and dragged by its name. */
  function addFrame(box) {
    const object = {
      id: crypto.randomUUID(),
      type: 'frame',
      x: round(box.x), y: round(box.y),
      width: round(box.width),
      height: round(box.height),
      name: `Frame ${objects.filter((o) => o.type === 'frame').length + 1}`,
      color: 'neutral',
      opacity: 1,
    };
    // Under everything: a frame is the paper its contents sit on, and one
    // drawn on top would swallow every click meant for what it holds.
    objects.unshift(object);
    select(object.id);
    queue();
    drawObjects();
  }

  /** A free line or arrow between two points. */
  function addLine(from, to, spec) {
    const object = {
      id: crypto.randomUUID(),
      type: 'line',
      x: 0, y: 0,
      points: [[round(from.x), round(from.y)], [round(to.x), round(to.y)]],
      edge: 'round',
      label: null,
      startArrow: spec.startArrow,
      endArrow: spec.endArrow,
      ...penStyle(),
      fill: null,
    };
    objects.push(object);
    select(object.id);
    queue();
    drawObjects();
  }

  /* ── z-order ───────────────────────────────────────────────────────── */

  /**
   * The object list is the stacking order, so these are four moves within one
   * array. Frames are pinned to the bottom of it — they are the surface the
   * rest is drawn on — so nothing can be sent behind one and lost.
   */
  function reorder(object, where) {
    const at = objects.indexOf(object);
    if (at === -1) return;
    const floor = object.type === 'frame' ? 0 : objects.filter((o) => o.type === 'frame').length;
    objects.splice(at, 1);
    const ceiling = objects.length;
    const to = {
      front: ceiling,
      back: floor,
      forward: Math.min(ceiling, at + 1),
      backward: Math.max(floor, at - 1),
    }[where] ?? at;
    objects.splice(Math.max(floor, Math.min(ceiling, to)), 0, object);
    queue();
    drawObjects();
  }

  /** A copy of an object, offset so it is visibly a second one. */
  function duplicate(object) {
    const copy = structuredClone(object);
    copy.id = crypto.randomUUID();
    translate(copy, 20, 20);
    // A copy of a connector would join the originals, not the copies, so a
    // connector is duplicated only as part of a duplicated pair — which is
    // not a thing one selection can express. Its copy is dropped.
    if (copy.type === 'connector') return;
    objects.push(copy);
    select(copy.id);
    queue();
    drawObjects();
  }

  function addFlashcard(box) {
    const object = {
      id: crypto.randomUUID(),
      type: 'flashcard',
      x: round(box.x), y: round(box.y),
      width: round(box.width),
      height: round(box.height),
      front: '',
      back: '',
      cardId: null,
    };
    objects.push(object);
    select(object.id);
    queue();
    drawObjects();
    setTimeout(() => layer.querySelector(`[data-obj="${object.id}"] .front`)?.focus(), 0);
  }

  /** Small enough to be a deliberate choice, large enough to still be grabbable. */
  const MIN_SIZE = 60;

  /** How close, as a fraction, a drag has to come to a ratio before it is pulled onto it. */
  const RATIO_PULL = 0.06;

  /**
   * Resizes from whichever handle is being dragged. A north or west handle
   * moves the object's own corner as well as its size, which is what makes the
   * opposite edge appear to stay put.
   *
   * The edge being dragged lands on the grid. On a corner, a shape dragged
   * close to its original proportions — or to a square — is pulled onto them,
   * so a tidy ratio is easy to hit without holding anything; Shift locks the
   * proportions outright.
   */
  function resizeTo(clientX, clientY, keepRatio = false) {
    const object = objects.find((o) => o.id === drag.id);
    if (!object) return;
    const at = toCanvas(clientX, clientY);
    const dx = at.x - drag.start.x;
    const dy = at.y - drag.start.y;
    const { x, y, width, height } = drag.origin;
    const right = x + width;
    const bottom = y + height;

    let nextX = x;
    let nextY = y;
    let nextW = width;
    let nextH = height;

    if (drag.dir.includes('e')) nextW = Math.max(MIN_SIZE, snap(right + dx) - x);
    if (drag.dir.includes('s')) nextH = Math.max(MIN_SIZE, snap(bottom + dy) - y);
    if (drag.dir.includes('w')) {
      nextX = Math.min(snap(x + dx), right - MIN_SIZE);
      nextW = right - nextX;
    }
    if (drag.dir.includes('n')) {
      nextY = Math.min(snap(y + dy), bottom - MIN_SIZE);
      nextH = bottom - nextY;
    }

    const corner = drag.dir.length === 2;
    const original = width / height;
    const ratio = nextW / nextH;
    let lockTo = null;
    if (corner && keepRatio) lockTo = original;
    else if (corner && Math.abs(ratio / original - 1) < RATIO_PULL) lockTo = original;
    else if (corner && Math.abs(ratio - 1) < RATIO_PULL) lockTo = 1;

    if (lockTo !== null) {
      // Whichever edge moved further decides the size; the other follows.
      if (nextW / lockTo >= nextH) nextH = nextW / lockTo;
      else nextW = nextH * lockTo;
      if (nextW < MIN_SIZE) { nextW = MIN_SIZE; nextH = MIN_SIZE / lockTo; }
      if (nextH < MIN_SIZE) { nextH = MIN_SIZE; nextW = MIN_SIZE * lockTo; }
      nextX = drag.dir.includes('w') ? right - nextW : x;
      nextY = drag.dir.includes('n') ? bottom - nextH : y;
    }
    drag.node.classList.toggle('ratio-snap', lockTo !== null && !keepRatio);

    object.x = round(nextX);
    object.y = round(nextY);
    object.width = round(nextW);
    object.height = round(nextH);

    drag.node.style.left = `${object.x}px`;
    drag.node.style.top = `${object.y}px`;
    drag.node.style.width = `${object.width}px`;
    drag.node.style.height = `${object.height}px`;
    drawConnectors();
  }

  /** How near the pointer has to be, in canvas units, to rub a stroke out. */
  const ERASE_RADIUS = 12;

  /** Distance from a point to the segment between two others. */
  function segmentDistance(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const span = dx * dx + dy * dy;
    const t = span ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / span)) : 0;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  /** Whether any of a stroke's segments passes within `reach` of any of the eraser's positions. */
  function strokeTouched(points, spots, reach) {
    if (points.length === 1) return spots.some((c) => Math.hypot(points[0][0] - c.x, points[0][1] - c.y) <= reach);
    for (let i = 1; i < points.length; i += 1) {
      const [ax, ay] = points[i - 1];
      const [bx, by] = points[i];
      if (spots.some((c) => segmentDistance(c.x, c.y, ax, ay, bx, by) <= reach)) return true;
    }
    return false;
  }

  /**
   * What is left of a stroke once the eraser has cut through it: one run of
   * points for every stretch it did not touch.
   *
   * Only the segments near the eraser are subdivided before the cut, so the
   * edge of the gap sits where the eraser was rather than at whichever sample
   * the pen happened to take — and the rest of the stroke stays as light as
   * it was drawn.
   */
  function sliceStroke(points, spots, reach) {
    const step = Math.max(1, ERASE_RADIUS / 3);
    const dense = [points[0]];
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1];
      const b = points[i];
      const near = spots.some((c) => segmentDistance(c.x, c.y, a[0], a[1], b[0], b[1]) <= reach + step);
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const cuts = near ? Math.floor(length / step) : 0;
      for (let k = 1; k < cuts; k += 1) {
        const t = k / cuts;
        const point = [round(a[0] + (b[0] - a[0]) * t), round(a[1] + (b[1] - a[1]) * t)];
        if (a.length > 2) point.push(Math.round(((a[2] ?? 0.5) + ((b[2] ?? 0.5) - (a[2] ?? 0.5)) * t) * 100) / 100);
        dense.push(point);
      }
      dense.push(b);
    }
    const runs = [];
    let run = [];
    for (const point of dense) {
      if (spots.some((c) => Math.hypot(point[0] - c.x, point[1] - c.y) <= reach)) {
        if (run.length) runs.push(run);
        run = [];
      } else {
        run.push(point);
      }
    }
    if (run.length) runs.push(run);
    return { cut: runs.reduce((n, r) => n + r.length, 0) !== dense.length, runs: runs.filter((r) => r.length >= 2) };
  }

  /**
   * Rubs out what is under the eraser, in one of two ways.
   *
   * Whole-object mode removes any stroke, line or shape the eraser touches at
   * all. Precise mode only cuts: a stroke loses the part under the eraser and
   * splits into what is left either side, and shapes are left alone, because a
   * note has no part that could be rubbed away and still be a note.
   *
   * The eraser is tested along the path it travelled since the last event,
   * not just where it is now, so a quick swipe cannot jump over a thin line.
   */
  function eraseAt(clientX, clientY) {
    const at = toCanvas(clientX, clientY);
    const from = drag?.last ?? at;
    if (drag) drag.last = at;
    const travelled = Math.hypot(at.x - from.x, at.y - from.y);
    const hops = Math.min(200, Math.ceil(travelled / (ERASE_RADIUS / 2)));
    const spots = [at];
    for (let k = 0; k < hops; k += 1) {
      const t = k / hops;
      spots.push({ x: from.x + (at.x - from.x) * t, y: from.y + (at.y - from.y) * t });
    }

    const gone = new Set();
    let changed = false;
    const next = [];

    for (const object of objects) {
      if (object.type === 'ink' || object.type === 'line') {
        const reach = ERASE_RADIUS + (object.stroke ?? 2) / 2;
        if (!strokeTouched(object.points, spots, reach)) { next.push(object); continue; }
        if (eraseMode === 'stroke') { gone.add(object.id); continue; }
        const { cut, runs } = sliceStroke(object.points, spots, reach);
        if (!cut) { next.push(object); continue; }
        changed = true;
        if (!runs.length) { gone.add(object.id); continue; }
        // The first piece keeps the stroke's identity, so a selection or a
        // label on it survives; a line's arrowheads stay on the ends they were on.
        runs.forEach((points, i) => {
          const piece = { ...object, id: i === 0 ? object.id : crypto.randomUUID(), points: points.slice(0, 10_000) };
          if (object.type === 'line') {
            piece.startArrow = i === 0 ? object.startArrow : 'none';
            piece.endArrow = i === runs.length - 1 ? object.endArrow : 'none';
            if (i > 0) delete piece.label;
          }
          next.push(piece);
        });
        continue;
      }
      if (eraseMode === 'pixel' || object.type === 'connector') { next.push(object); continue; }

      const w = object.width ?? 0;
      const h = object.height ?? 0;
      const touches = (c) => {
        const nx = Math.max(object.x, Math.min(c.x, object.x + w));
        const ny = Math.max(object.y, Math.min(c.y, object.y + h));
        return Math.hypot(c.x - nx, c.y - ny) <= ERASE_RADIUS;
      };
      if (object.type === 'frame') {
        // A frame is mostly empty space with other people's work standing in
        // it. Rubbing at the middle of one is aimed at what is inside, so only
        // its border answers to the eraser.
        const deep = (c) => c.x >= object.x + ERASE_RADIUS && c.x <= object.x + w - ERASE_RADIUS
          && c.y >= object.y + ERASE_RADIUS && c.y <= object.y + h - ERASE_RADIUS;
        if (spots.some((c) => touches(c) && !deep(c))) { gone.add(object.id); continue; }
      } else if (spots.some(touches)) {
        gone.add(object.id);
        continue;
      }
      next.push(object);
    }
    if (!gone.size && !changed) return;

    // A connector with nothing left to join is not a connector.
    objects = next.filter((o) => !gone.has(o.fromId) && !gone.has(o.toId));
    for (const id of gone) picked.delete(id);
    if (gone.has(selectedId)) selectedId = [...picked][0] ?? null;
    drawObjects();
  }

  function setEraseMode(mode) {
    eraseMode = mode;
    keep('erase', mode);
    drawStyle();
  }

  function toggleSnap() {
    snapOn = !snapOn;
    keep('snap', snapOn ? 'on' : 'off');
    toast(snapOn ? `Snapping to the grid (${gridSize} px)` : 'Grid snapping off');
    drawChrome();
  }

  function setGridSize(size) {
    gridSize = size;
    keep('grid', size);
    if (!snapOn) { snapOn = true; keep('snap', 'on'); }
    applyViewport();
    drawChrome();
  }

  function setPaper(id) {
    if (id === paper) return;
    grid.classList.remove(`grid-${paper}`);
    paper = id;
    grid.classList.add(`grid-${paper}`);
    drawGrid();
    dirty = true;
    void save();
  }

  function gridItems() {
    return [
      { head: 'PAPER' },
      ...PAPERS.map((p) => ({ icon: p.icon, label: p.label, on: paper === p.id, onSelect: () => setPaper(p.id) })),
      { sep: true },
      { icon: 'grid-four', label: 'Snap to grid', kbd: 'G', on: snapOn, onSelect: () => toggleSnap() },
      ...GRID_SIZES.map((g) => ({
        icon: 'dots-nine', label: `${g.label} grid · ${g.size} px`, on: snapOn && gridSize === g.size, onSelect: () => setGridSize(g.size),
      })),
    ];
  }

  /** Joins two objects, once the second one has been picked. */
  function link(objectId) {
    if (!linkFrom) { linkFrom = objectId; drawChrome(); return; }
    if (linkFrom === objectId) { linkFrom = null; drawChrome(); return; }
    const exists = objects.some((o) => o.type === 'connector'
      && ((o.fromId === linkFrom && o.toId === objectId) || (o.fromId === objectId && o.toId === linkFrom)));
    if (!exists) {
      objects.push({
        id: crypto.randomUUID(), type: 'connector', x: 0, y: 0,
        fromId: linkFrom, toId: objectId, label: null,
        color: drawColor, stroke: Math.min(drawStroke, 2), strokeStyle: 'solid',
        startArrow: 'none', endArrow: 'arrow', path: 'straight', opacity: 1,
      });
      queue();
    }
    linkFrom = null;
    tool = 'select';
    drawChrome();
    drawObjects();
  }

  /* ── mindmap ───────────────────────────────────────────────────────── */

  /**
   * A mindmap, built with the two keys everybody already knows.
   *
   * The old canvas could draw one, in the sense that a canvas with notes and
   * connectors on it can be arranged into the shape of a mindmap by hand. That
   * is not the same as having one: a mindmap is made at the speed of thought
   * or it is not made at all, and stopping to drag a box and then drag a line
   * to it is three gestures per idea.
   *
   * So: Tab makes a child of whatever is selected, Enter makes a sibling of
   * it, both place themselves, both draw their own branch, and both leave the
   * caret in the new node. The tree is not stored anywhere — it is read back
   * out of the connectors each time, so a branch dragged somewhere else by
   * hand is still a branch, and a mindmap is still an ordinary canvas that
   * anything else on this screen can edit.
   */

  /** The connectors leaving `id`, i.e. the branches to its children. */
  const branchesFrom = (id) => objects.filter((o) => o.type === 'connector' && o.fromId === id);

  /** The node this one hangs off, if any. */
  function parentOf(id) {
    const branch = objects.find((o) => o.type === 'connector' && o.toId === id);
    return branch ? objects.find((o) => o.id === branch.fromId) ?? null : null;
  }

  const childrenOf = (id) => branchesFrom(id)
    .map((branch) => objects.find((o) => o.id === branch.toId))
    .filter(Boolean);

  /** Every box in the subtree under `id`, itself included. Cycle-safe. */
  function subtree(id, seen = new Set()) {
    if (seen.has(id)) return [];
    seen.add(id);
    const node = objects.find((o) => o.id === id);
    const out = node ? [node] : [];
    for (const child of childrenOf(id)) out.push(...subtree(child.id, seen));
    return out;
  }

  /** The box holding a whole subtree, which is what a sibling has to clear. */
  function subtreeBox(id) {
    const nodes = subtree(id);
    if (!nodes.length) return null;
    return {
      x: Math.min(...nodes.map((o) => o.x)),
      y: Math.min(...nodes.map((o) => o.y)),
      bottom: Math.max(...nodes.map((o) => o.y + (o.height ?? 0))),
      right: Math.max(...nodes.map((o) => o.x + (o.width ?? 0))),
    };
  }

  /** Does this box overlap anything already on the plane, with room to spare? */
  function occupied(box, ignore) {
    const pad = MIND_GAP_Y / 2;
    return objects.some((o) => {
      if (o.type === 'connector' || o.type === 'ink' || o.type === 'line' || o.type === 'frame') return false;
      if (ignore.has(o.id)) return false;
      return box.x < o.x + (o.width ?? 0) + pad
        && box.x + box.width + pad > o.x
        && box.y < o.y + (o.height ?? 0) + pad
        && box.y + box.height + pad > o.y;
    });
  }

  /** Slides a box down until it is standing on nothing. */
  function settle(box, ignore) {
    let guard = 0;
    while (occupied(box, ignore) && guard < 400) {
      box.y = round(box.y + MIND_NODE.height / 2 + MIND_GAP_Y);
      guard += 1;
    }
    return box;
  }

  /**
   * Adds a node to the map and joins it to its parent.
   *
   * The branch is curved and headless: a mindmap's lines say "belongs to",
   * not "leads to", and an arrowhead on every one of them turns a map of one
   * idea into a flowchart of forty.
   */
  function growMindmap(parent, box) {
    const node = {
      id: crypto.randomUUID(),
      type: 'note',
      x: round(box.x), y: round(box.y),
      width: round(box.width), height: round(box.height),
      text: '',
      shape: 'rounded',
      mindmap: true,
      ...penStyle(),
      color: parent.color ?? drawColor,
      fill: parent.fill ?? null,
    };
    objects.push(node, {
      id: crypto.randomUUID(),
      type: 'connector',
      x: 0, y: 0,
      fromId: parent.id,
      toId: node.id,
      label: null,
      color: parent.color ?? drawColor,
      stroke: parent.stroke ?? drawStroke,
      strokeStyle: 'solid',
      startArrow: 'none',
      endArrow: 'none',
      path: 'curved',
      opacity: 1,
    });
    // The parent is a mindmap node too, whatever it started life as: a map
    // grown from an ordinary note should tidy along with everything else.
    parent.mindmap = true;
    select(node.id);
    queue();
    drawObjects();
    setTimeout(() => layer.querySelector(`[data-obj="${node.id}"] .text-edit`)?.focus(), 0);
  }

  /** Tab: a new branch off the selection, out to its right. */
  function addChildNode(parent) {
    const kin = childrenOf(parent.id);
    const boxes = kin.map((child) => subtreeBox(child.id)).filter(Boolean);
    const top = boxes.length
      ? Math.max(...boxes.map((b) => b.bottom)) + MIND_GAP_Y
      : parent.y + (parent.height ?? 0) / 2 - MIND_NODE.height / 2;
    const box = {
      x: parent.x + (parent.width ?? 0) + MIND_GAP_X,
      y: top,
      ...MIND_NODE,
    };
    growMindmap(parent, settle(box, new Set([parent.id])));
  }

  /** Enter: another node alongside this one, under the same parent. */
  function addSiblingNode(node) {
    const parent = parentOf(node.id);
    // The root has no siblings — a second root is a second map — so Enter on
    // it does what Tab would have: it starts the first branch.
    if (!parent) { addChildNode(node); return; }
    const own = subtreeBox(node.id);
    const box = {
      x: node.x,
      y: (own?.bottom ?? node.y + (node.height ?? 0)) + MIND_GAP_Y,
      width: node.width ?? MIND_NODE.width,
      height: node.height ?? MIND_NODE.height,
    };
    growMindmap(parent, settle(box, new Set([parent.id, node.id])));
  }

  /**
   * Lays a whole map out again, from its root.
   *
   * Depth sets the column, so every node the same distance from the root
   * shares an x; within a column each subtree is given exactly the height it
   * needs and centred on it, which is the layout that stops a map from
   * drifting into a diagonal as it grows. Nothing outside the map is touched.
   */
  function tidyMindmap(from) {
    let root = from;
    const guard = new Set();
    while (!guard.has(root.id)) {
      guard.add(root.id);
      const up = parentOf(root.id);
      if (!up) break;
      root = up;
    }

    const laid = new Set();
    /** Lays out a subtree with its top edge at `top`, and returns its height. */
    const place = (node, left, top) => {
      if (laid.has(node.id)) return 0;
      laid.add(node.id);
      const width = node.width ?? MIND_NODE.width;
      const height = node.height ?? MIND_NODE.height;
      const kin = childrenOf(node.id).filter((child) => !laid.has(child.id));
      if (!kin.length) {
        node.x = round(left);
        node.y = round(top);
        return height;
      }
      let used = 0;
      for (const child of kin) used += place(child, left + width + MIND_GAP_X, top + used) + MIND_GAP_Y;
      used = Math.max(height, used - MIND_GAP_Y);
      node.x = round(left);
      // Centred on its branches rather than level with the first of them.
      node.y = round(top + (used - height) / 2);
      return used;
    };

    place(root, root.x, root.y);
    queue();
    drawObjects();
    toast('Mindmap tidied.');
  }

  /**
   * Starts dragging an object, and everything else selected along with it.
   *
   * The node is looked up again after the redraw: `drawObjects` rebuilds the
   * layer, and moving the node that was clicked would move one that is no
   * longer on the page.
   */
  function startMove(object, event) {
    const linear = Array.isArray(object.points);
    const at = toCanvas(event.clientX, event.clientY);
    const carried = new Map();
    for (const other of selectedObjects()) {
      if (other.id === object.id || other.type === 'connector') continue;
      carried.set(other.id, other);
    }
    for (const holder of [object, ...carried.values()]) {
      if (holder.type !== 'frame') continue;
      for (const child of carriedBy(holder)) if (child.id !== object.id) carried.set(child.id, child);
    }
    drag = {
      kind: 'move', id: object.id, node: null,
      offsetX: at.x - (linear ? object.points[0][0] : object.x),
      offsetY: at.y - (linear ? object.points[0][1] : object.y),
      carried: [...carried.values()],
    };
    stage.setPointerCapture(event.pointerId);
    drawObjects();
    drag.node = layer.querySelector(`[data-obj="${object.id}"]`);
  }

  /** Canvas → stage-local screen pixels, the inverse of `toCanvas`. */
  function toStage(x, y) {
    const at = spin(x * viewport.zoom, y * viewport.zoom, viewport.rotation);
    return { x: at.x + viewport.x, y: at.y + viewport.y };
  }

  /** Whether any of an object lies inside a marquee drawn in stage pixels. */
  function inMarquee(object, box) {
    let corners;
    if (Array.isArray(object.points)) {
      const xs = object.points.map((p) => p[0]);
      const ys = object.points.map((p) => p[1]);
      corners = [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]];
    } else {
      corners = [[object.x, object.y], [object.x + (object.width ?? 0), object.y + (object.height ?? 0)]];
    }
    const [[x0, y0], [x1, y1]] = corners;
    const screen = [toStage(x0, y0), toStage(x1, y0), toStage(x0, y1), toStage(x1, y1)];
    const left = Math.min(...screen.map((p) => p.x));
    const right = Math.max(...screen.map((p) => p.x));
    const top = Math.min(...screen.map((p) => p.y));
    const bottom = Math.max(...screen.map((p) => p.y));
    return left <= box.right && right >= box.left && top <= box.bottom && bottom >= box.top;
  }

  /** Removes everything selected, and any connector left with nothing to join. */
  function deleteSelection() {
    if (!picked.size) return;
    objects = objects.filter((o) => !picked.has(o.id) && !picked.has(o.fromId) && !picked.has(o.toId));
    select(null);
    queue();
    drawObjects();
  }

  function drawObjects() {
    mount(layer);
    for (const object of objects) {
      if (object.type === 'ink' || object.type === 'connector' || object.type === 'line') continue;
      layer.appendChild(renderObject(object));
    }
    drawConnectors();
    drawStyle();
  }

  function renderObject(object) {
    const width = object.width ?? 220;
    const height = object.height ?? 120;
    // A note draws its own outline in SVG, so the CSS box behind it stands
    // down: `shaped` is what tells the stylesheet to stop painting a border
    // and a background that a diamond or a hatched fill could never be.
    const shaped = object.type === 'note';
    const node = el('div', {
      class: `obj ${object.type === 'flashcard' ? 'card' : object.type}` +
        (object.type === 'note' && object.shape !== 'rounded' ? ` ${object.shape}` : '') +
        (shaped ? ' shaped' : '') +
        (object.mindmap ? ' mind' : '') +
        (picked.has(object.id) ? ' selected' : '') +
        (linkFrom === object.id ? ' linking' : ''),
      dataset: { obj: object.id },
      style: {
        left: `${object.x}px`, top: `${object.y}px`,
        width: `${width}px`, height: `${height}px`,
        opacity: object.opacity !== undefined && object.opacity !== null && object.opacity !== 1
          ? String(object.opacity) : null,
      },
      onpointerdown: (event) => {
        if (event.button !== 0 || event.altKey) return;
        if (tool === 'connector') { event.stopPropagation(); link(object.id); return; }
        if (tool !== 'select') return;
        // The first press on a note picks it up; once it is the selection, a
        // press on its words puts the caret there instead.
        if (event.target.isContentEditable && picked.size === 1 && selectedId === object.id) return;
        event.stopPropagation();
        event.preventDefault();
        if (event.shiftKey) {
          if (picked.has(object.id)) {
            picked.delete(object.id);
            selectedId = [...picked].pop() ?? null;
            drawObjects();
            return;
          }
          picked.add(object.id);
          selectedId = object.id;
        } else if (!picked.has(object.id)) {
          select(object.id);
        } else {
          selectedId = object.id;
        }
        startMove(object, event);
      },
      oncontextmenu: (event) => { event.preventDefault(); event.stopPropagation(); objectMenu(object, event.clientX, event.clientY); },
    });

    // Handles belong to the selection, so they appear on it and nowhere else.
    if (selectedId === object.id && picked.size === 1 && object.width !== undefined && tool === 'select') {
      for (const dir of ['nw', 'ne', 'se', 'sw', 'n', 'e', 's', 'w']) {
        node.appendChild(el('span', {
          class: `rz rz-${dir}`,
          onpointerdown: (event) => {
            event.stopPropagation();
            event.preventDefault();
            drag = {
              kind: 'resize', id: object.id, dir, node,
              origin: { x: object.x, y: object.y, width: object.width, height: object.height },
              start: toCanvas(event.clientX, event.clientY),
            };
            stage.setPointerCapture(event.pointerId);
          },
        }));
      }
    }

    if (object.type === 'note') {
      // Behind the text, and first, so the words stay HTML — selectable,
      // editable and wrapped by the browser — while the shape around them is
      // free to be a diamond with a cross-hatched fill and a shaky outline.
      node.appendChild(shapeSvg(object, width, height));
      // A rectangle, ellipse or diamond is a drawn shape, not a note: it has no
      // words inside it (a shape from before that kept its words keeps them).
      const plainShape = object.shape && object.shape !== 'rounded' && !object.mindmap && !object.text;
      const editor = plainShape ? null : el('div', {
        class: 'text-edit',
        contenteditable: 'plaintext-only',
        'data-placeholder': object.mindmap ? 'Idea' : 'Note',
        style: { fontSize: object.fontSize ? `${object.fontSize}px` : null },
      });
      if (editor) {
        editor.textContent = object.text;
        editor.addEventListener('input', () => { object.text = editor.textContent; queue(); });
        editor.addEventListener('keydown', (event) => {
          // Tab and Enter grow the map. They only mean that inside a node that
          // is part of one, so ordinary notes keep their ordinary newlines.
          if (!object.mindmap || event.metaKey || event.ctrlKey || event.altKey) return;
          if (event.key === 'Tab') { event.preventDefault(); addChildNode(object); }
          else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); addSiblingNode(object); }
        });
        node.appendChild(editor);
      }
      applyColor(node, object.color);
    } else if (object.type === 'text') {
      const editor = el('div', {
        class: 'text-edit',
        contenteditable: 'plaintext-only',
        'data-placeholder': 'Text',
        style: {
          fontSize: `${object.fontSize ?? 20}px`,
          textAlign: object.align ?? 'left',
          color: object.color ? colorValue(object.color) : null,
        },
      });
      editor.textContent = object.text;
      editor.addEventListener('input', () => { object.text = editor.textContent; queue(); });
      node.appendChild(editor);
    } else if (object.type === 'frame') {
      // The name is the only part of a frame the pointer can touch; the rest
      // of it is a hole, so clicking inside reaches what is standing there.
      node.appendChild(el('div', {
        class: 'frame-name',
        ondblclick: async (event) => {
          event.stopPropagation();
          const name = await promptText({ title: 'Rename frame', label: 'Name', value: object.name ?? '', confirmLabel: 'Rename' });
          if (name === null) return;
          object.name = name || null;
          queue();
          drawObjects();
        },
      }, object.name ?? 'Frame'));
      applyColor(node, object.color ?? 'neutral');
    } else if (object.type === 'flashcard') {
      node.appendChild(el('div', { class: 'kicker' }, 'FLASHCARD'));
      const front = el('div', { class: 'front', contenteditable: 'plaintext-only', 'data-placeholder': 'Question' });
      const back = el('div', { class: 'back', contenteditable: 'plaintext-only', 'data-placeholder': 'Answer' });
      front.textContent = object.front;
      back.textContent = object.back;
      front.addEventListener('input', () => { object.front = front.textContent; queue(); });
      back.addEventListener('input', () => { object.back = back.textContent; queue(); });
      node.append(front, back);
    } else if (object.type === 'pdf_excerpt') {
      node.appendChild(el('div', { class: 'kicker' }, `PDF · PAGE ${object.page}`));
      node.appendChild(el('div', { class: 'back', text: object.quotedText ?? '' }));
    } else if (object.type === 'image') {
      node.appendChild(el('div', { class: 'kicker' }, object.alt ?? 'IMAGE'));
    } else if (object.type === 'link') {
      // The title is read fresh from the library, so renaming a note renames
      // it here too; the stored one is the fallback for a file that has gone.
      const target = fileById(object.fileId);
      const kind = target?.kind ?? 'doc';
      node.classList.toggle('missing', !target);
      node.append(
        el('div', { class: 'kicker' }, icon(FILE_ICON[kind] ?? 'file', { size: 12 }),
          target ? LINK_KINDS[kind] ?? 'FILE' : 'DELETED'),
        el('div', { class: 'link-title', text: target?.title || object.title || 'Untitled' }),
        target
          ? el('button', {
              class: 'link-open', type: 'button', title: `Open ${target.title || 'Untitled'}`,
              // The pointer press is stopped as well: on an object, a press is
              // the start of a drag, and the button would never see the click.
              onpointerdown: (event) => event.stopPropagation(),
              onclick: (event) => { event.stopPropagation(); navigate(routeFor({ kind: 'file', id: object.fileId, fileKind: kind })); },
            }, icon('arrow-up-right', { size: 12 }))
          : null,
      );
    }

    return node;
  }

  /** Ink strokes and connectors share the SVG layer beneath the objects. */
  function drawConnectors() {
    mount(inkLayer);
    for (const object of objects) {
      if (object.type === 'ink') {
        const width = object.stroke ?? 1.5;
        const inkClass = picked.has(object.id) ? 'ink-obj selected' : 'ink-obj';
        // A highlighter keeps its one width whatever the hand did, and so does
        // anything drawn by a device with no pressure to report.
        inkLayer.appendChild(width < HIGHLIGHT_MIN && hasPressure(object.points)
          ? svg('path', {
              class: inkClass,
              d: inkOutline(object.points, width),
              fill: colorValue(object.color ?? 'accent'),
              stroke: 'none',
            })
          : svg('polyline', {
              class: inkClass,
              points: object.points.map((p) => `${p[0]},${p[1]}`).join(' '),
              fill: 'none',
              stroke: colorValue(object.color ?? 'accent'),
              'stroke-width': width,
              'stroke-opacity': width >= HIGHLIGHT_MIN ? 0.35 : 1,
              'stroke-linecap': 'round',
              'stroke-linejoin': 'round',
            }));
      } else if (object.type === 'line') {
        inkLayer.appendChild(lineNode(object));
      } else if (object.type === 'connector') {
        const node = connectorNode(object);
        if (node) inkLayer.appendChild(node);
      }
    }
  }

  /** A free line or arrow: its own points, its own ends. */
  function lineNode(object) {
    const colour = colorValue(object.color ?? 'accent');
    const width = object.stroke ?? 1.5;
    const points = object.points;
    const group = svg('g', {
      class: 'line-obj' + (picked.has(object.id) ? ' selected' : ''),
      'data-obj': object.id,
      onpointerdown: (event) => {
        if (event.button !== 0 || event.altKey) return;
        if (tool !== 'select') return;
        event.stopPropagation();
        if (event.shiftKey) picked.add(object.id);
        else if (!picked.has(object.id)) select(object.id);
        selectedId = object.id;
        // A line has no corner to measure an offset from, so it is dragged by
        // where it was grabbed: the delta is taken fresh from its first point.
        startMove(object, event);
      },
      oncontextmenu: (event) => { event.preventDefault(); event.stopPropagation(); objectMenu(object, event.clientX, event.clientY); },
    });

    // An invisible fat stroke under the thin one, so a hairline is still
    // something a pointer can reasonably be expected to hit.
    group.appendChild(svg('polyline', {
      class: 'hit',
      points: points.map((p) => `${p[0]},${p[1]}`).join(' '),
      fill: 'none', stroke: 'transparent', 'stroke-width': Math.max(14, width * 4),
      'stroke-linecap': 'round',
    }));
    group.appendChild(svg('polyline', {
      points: points.map((p) => `${p[0]},${p[1]}`).join(' '),
      fill: 'none',
      stroke: colour,
      'stroke-width': width,
      'stroke-dasharray': dashFor(object.strokeStyle ?? 'solid', width),
      'stroke-linecap': object.edge === 'sharp' ? 'butt' : 'round',
      'stroke-linejoin': object.edge === 'sharp' ? 'miter' : 'round',
      'stroke-opacity': object.opacity ?? 1,
    }));

    const first = points[0];
    const second = points[1] ?? first;
    const last = points[points.length - 1];
    const prior = points[points.length - 2] ?? last;
    const head = arrowHead(object.endArrow, last, prior, object.color ?? 'accent', width);
    const tail = arrowHead(object.startArrow, first, second, object.color ?? 'accent', width);
    if (head) group.appendChild(head);
    if (tail) group.appendChild(tail);
    if (object.label) {
      group.appendChild(svg('text', {
        class: 'line-label',
        x: (first[0] + last[0]) / 2, y: (first[1] + last[1]) / 2 - 6,
        'text-anchor': 'middle', 'font-size': 11, fill: colour, text: object.label,
      }));
    }
    return group;
  }

  /**
   * A connector between two objects.
   *
   * It leaves each shape at its edge rather than at its centre, so the line
   * begins where the box ends instead of vanishing underneath it, and it can
   * be straight, right-angled or curved. A connector is bound to what it
   * joins: moving either end redraws it, which is what `drawConnectors` is
   * called for on every frame of a drag.
   */
  function connectorNode(object) {
    const from = objects.find((o) => o.id === object.fromId);
    const to = objects.find((o) => o.id === object.toId);
    if (!from || !to) return null;

    const fromBox = { x: from.x, y: from.y, width: from.width ?? 0, height: from.height ?? 0 };
    const toBox = { x: to.x, y: to.y, width: to.width ?? 0, height: to.height ?? 0 };
    const centre = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    const start = edgePoint(fromBox, centre(toBox));
    const stop = edgePoint(toBox, centre(fromBox));

    const colour = object.color ? colorValue(object.color) : 'var(--color-neutral-600)';
    const width = object.stroke ?? 1.5;
    const shape = object.path ?? 'straight';
    const dash = dashFor(object.strokeStyle ?? 'solid', width);

    const group = svg('g', {
      class: 'conn' + (picked.has(object.id) ? ' selected' : ''),
      'data-obj': object.id,
      oncontextmenu: (event) => { event.preventDefault(); event.stopPropagation(); objectMenu(object, event.clientX, event.clientY); },
      onpointerdown: (event) => {
        if (event.button !== 0 || tool !== 'select') return;
        event.stopPropagation();
        select(object.id);
        drawObjects();
      },
    });

    const geometry = shape === 'elbow'
      ? { kind: 'polyline', points: elbowPoints(start, stop) }
      : shape === 'curved'
        ? { kind: 'path', d: curvedPath(start, stop) }
        : { kind: 'polyline', points: [[start.x, start.y], [stop.x, stop.y]] };

    const stroke = (extra) => (geometry.kind === 'path'
      ? svg('path', { d: geometry.d, fill: 'none', ...extra })
      : svg('polyline', { points: geometry.points.map((p) => `${round(p[0])},${round(p[1])}`).join(' '), fill: 'none', ...extra }));

    group.appendChild(stroke({ class: 'hit', stroke: 'transparent', 'stroke-width': Math.max(14, width * 4) }));
    group.appendChild(stroke({
      stroke: colour,
      'stroke-width': width,
      'stroke-dasharray': dash,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'stroke-opacity': object.opacity ?? 1,
    }));

    // The head points along the last bit of the route, not along the chord —
    // on an elbow those are ninety degrees apart.
    const beforeEnd = shape === 'elbow' ? geometry.points[geometry.points.length - 2] : [start.x, start.y];
    const afterStart = shape === 'elbow' ? geometry.points[1] : [stop.x, stop.y];
    const head = arrowHead(object.endArrow, [stop.x, stop.y], beforeEnd, object.color ?? 'neutral', width);
    const tail = arrowHead(object.startArrow, [start.x, start.y], afterStart, object.color ?? 'neutral', width);
    if (head) group.appendChild(head);
    if (tail) group.appendChild(tail);

    if (object.label) {
      const at = shape === 'curved' ? curveMidpoint(start, stop)
        : { x: (start.x + stop.x) / 2, y: (start.y + stop.y) / 2 };
      group.appendChild(svg('text', {
        class: 'line-label',
        x: at.x, y: at.y - 6, 'text-anchor': 'middle', 'font-size': 11,
        fill: colour, text: object.label,
      }));
    }
    return group;
  }

  /** The next value in a list, wrapping — how every cycling item below works. */
  function nextIn(list, value, fallback) {
    const at = list.indexOf(value ?? fallback);
    return list[(at + 1) % list.length];
  }

  function objectMenu(object, x, y) {
    // A right click on something outside the selection selects it, so the menu
    // is never about one thing while the handles are on another.
    if (!picked.has(object.id)) { select(object.id); drawObjects(); }
    const many = picked.size > 1;
    const tintable = object.type !== 'flashcard' && object.type !== 'pdf_excerpt'
      && object.type !== 'image' && object.type !== 'link';
    const linear = object.type === 'line' || object.type === 'connector';
    const only = (test, row) => (!many && test ? row : null);

    openMenu({ x, y }, [
      { head: many ? `${picked.size} SELECTED` : object.type === 'pdf_excerpt' ? 'PDF EXCERPT' : object.type === 'link' ? 'LINKED FILE' : object.type.toUpperCase() },
      tintable ? {
        swatches: NOTE_COLORS.map((role) => ({
          color: colorValue(role), label: colorLabel(role), on: object.color === role,
          onSelect: () => applyToSelection({ color: role }),
        })),
      } : null,

      only(object.type === 'note', { icon: 'square', label: `Shape · ${object.shape ?? 'rounded'}`, onSelect: () => {
        object.shape = nextIn(SHAPES.filter((shape) => shape !== 'diamond'), object.shape, 'rounded');
        queue(); drawObjects();
      } }),
      only(object.type === 'note', { icon: 'paint-bucket', label: object.fill ? 'Remove fill' : 'Fill', onSelect: () => {
        object.fill = object.fill ? null : (object.color ?? drawColor);
        queue(); drawObjects();
      } }),

      only(linear, { sep: true }),
      only(linear, { icon: 'arrow-right', label: object.endArrow && object.endArrow !== 'none' ? 'Remove arrowhead' : 'Add arrowhead', onSelect: () => {
        object.endArrow = object.endArrow && object.endArrow !== 'none' ? 'none' : 'arrow';
        queue(); drawObjects();
      } }),
      only(object.type === 'connector', { icon: 'flow-arrow', label: `Route · ${object.path ?? 'straight'}`, onSelect: () => {
        object.path = nextIn(['straight', 'elbow', 'curved'], object.path, 'straight');
        queue(); drawObjects();
      } }),
      only(linear, { icon: 'text-t', label: object.label ? 'Edit label' : 'Add label', onSelect: async () => {
        const label = await promptText({ title: 'Label', label: 'Text', value: object.label ?? '', confirmLabel: 'Save' });
        if (label === null) return;
        object.label = label || null;
        queue(); drawObjects();
      } }),

      only(object.type === 'text', { sep: true }),
      only(object.type === 'text', { icon: 'text-aa', label: `Size · ${object.fontSize ?? 20}px`, onSelect: () => {
        object.fontSize = nextIn([14, 20, 28, 40], object.fontSize ?? 20, 20);
        queue(); drawObjects();
      } }),

      only(object.type === 'frame', { sep: true }),
      only(object.type === 'frame', { icon: 'pencil-simple', label: 'Rename frame', onSelect: async () => {
        const name = await promptText({ title: 'Rename frame', label: 'Name', value: object.name ?? '', confirmLabel: 'Rename' });
        if (name === null) return;
        object.name = name || null;
        queue(); drawObjects();
      } }),
      only(object.type === 'frame', { icon: 'selection-all', label: 'Select contents', onSelect: () => {
        const held = carriedBy(object);
        select(null);
        for (const child of held) picked.add(child.id);
        selectedId = held[0]?.id ?? null;
        if (!held.length) toast('Nothing inside this frame.');
        drawObjects();
      } }),

      only(object.type === 'note', { sep: true }),
      only(object.type === 'note', { icon: 'tree-structure', label: 'Add branch', kbd: '⇥', onSelect: () => addChildNode(object) }),
      only(object.type === 'note' && object.mindmap, { icon: 'broom', label: 'Tidy mindmap', onSelect: () => tidyMindmap(object) }),

      { sep: true },
      only(object.type !== 'connector', { icon: 'arrow-line-up', label: 'Bring to front', onSelect: () => reorder(object, 'front') }),
      only(object.type !== 'connector', { icon: 'arrow-line-down', label: 'Send to back', onSelect: () => reorder(object, 'back') }),
      object.type !== 'connector' ? { icon: 'copy', label: 'Duplicate', kbd: '⌘D', onSelect: () => duplicateSelection() } : null,
      { icon: 'trash', label: many ? `Delete ${picked.size}` : 'Delete', kbd: '⌫', danger: true, onSelect: () => deleteSelection() },
    ].filter(Boolean));
  }

  /* ── chrome: tool dock, style bar and zoom ─────────────────────────── */

  /**
   * Retints or re-weights whatever is selected, so the picker is not
   * write-only.
   *
   * Each field is only applied to the kinds that have it: a flashcard has no
   * outline and a standalone text block has no fill, and writing the field
   * anyway would put something on the object that the server's schema would
   * refuse the next time the canvas was saved.
   */
  const STYLEABLE = {
    color: ['note', 'ink', 'line', 'text', 'frame', 'connector'],
    stroke: ['ink', 'line', 'connector'],
    fill: ['note'],
  };

  function applyToSelection(patch) {
    let touched = false;
    for (const object of selectedObjects()) {
      for (const [field, kinds] of Object.entries(STYLEABLE)) {
        if (!(field in patch) || !kinds.includes(object.type)) continue;
        // A filled note keeps its fill in step with its colour.
        if (field === 'color' && object.type === 'note' && object.fill && !('fill' in patch)) object.fill = patch.color;
        object[field] = patch[field];
        touched = true;
      }
    }
    if (!touched) return;
    queue();
    drawObjects();
  }

  /** Copies everything selected, and selects the copies. */
  function duplicateSelection() {
    const copies = [];
    for (const object of selectedObjects()) {
      // A copy of a connector would join the originals, not the copies.
      if (object.type === 'connector') continue;
      const copy = structuredClone(object);
      copy.id = crypto.randomUUID();
      translate(copy, 20, 20);
      copies.push(copy);
    }
    if (!copies.length) return;
    objects.push(...copies);
    select(null);
    for (const copy of copies) picked.add(copy.id);
    selectedId = copies[copies.length - 1].id;
    queue();
    drawObjects();
  }

  const zoomLabel = el('span', { class: 'zoom' });

  function drawZoomLabel() {
    const turn = Math.round(viewport.rotation);
    const zoom = `${Math.round(viewport.zoom * 100)}%`;
    // Silent at zero, because that is the state nobody needs telling about —
    // and loud otherwise, because a canvas at 3° looks like a bug until the
    // corner says it is 3°.
    zoomLabel.textContent = turn ? `${zoom} · ${turn}°` : zoom;
  }

  const zoomPill = el('div', { class: 'zoom-pill' },
    el('button', { title: 'Zoom out', onclick: () => zoomBy(1 / 1.2) }, icon('minus', { size: 13 })),
    el('button', { class: 'zoom', title: 'Fit to content', onclick: () => fit() }, zoomLabel),
    el('button', { title: 'Zoom in', onclick: () => zoomBy(1.2) }, icon('plus', { size: 13 })),
  );

  const chromeHost = el('div', { class: 'canvas-chrome' });
  const styleHost = el('div', { class: 'style-host' });

  /**
   * The tools, in the order a study session reaches for them. `tier` is how
   * early each one folds into More as the pane narrows — the stylesheet hides
   * them, and More lists whatever it hid.
   */
  const TOOLS = [
    { id: 'select', glyph: 'cursor', label: 'Select', key: 'V' },
    { id: 'pan', glyph: 'hand', label: 'Pan', key: 'H', tier: 2 },
    { sep: true, tier: 2 },
    { id: 'ink', glyph: 'pencil-simple', label: 'Pen', key: 'P' },
    { id: 'highlight', glyph: 'highlighter', label: 'Highlighter', key: 'S', tier: 3 },
    { id: 'eraser', glyph: 'eraser', label: 'Eraser', key: 'E' },
    { sep: true },
    { id: 'text', glyph: 'text-t', label: 'Text', key: 'T' },
    { id: 'note', glyph: 'note', label: 'Note', key: 'N' },
    { id: 'rect', glyph: 'square', label: 'Rectangle', key: 'R', tier: 2 },
    { id: 'ellipse', glyph: 'circle', label: 'Ellipse', key: 'O', tier: 2 },
    { id: 'arrow', glyph: 'arrow-up-right', label: 'Arrow', key: 'A', tier: 3 },
    { sep: true, tier: 2 },
    { id: 'card', glyph: 'cards', label: 'Flashcard', key: 'K', tier: 2 },
    { id: 'connector', glyph: 'flow-arrow', label: 'Connect two objects', key: 'C', tier: 2 },
  ];

  function pickTool(id) {
    tool = id;
    linkFrom = null;
    drawChrome();
    updateCursor();
  }

  function drawChrome() {
    const spill = [];
    const buttons = TOOLS.map((t) => {
      const tier = t.tier ? ` tier-${t.tier}` : '';
      if (t.sep) return el('div', { class: `sep${tier}` });
      const node = el('button', {
        class: (tool === t.id ? 'on' : '') + tier,
        title: `${t.label} (${t.key})`,
        'aria-label': t.label,
        onclick: () => pickTool(t.id),
      }, icon(t.glyph));
      if (t.tier) spill.push({ node, t });
      return node;
    });

    const more = el('button', {
      class: 'more' + (spill.some(({ t }) => t.id === tool) ? ' on' : ''),
      title: 'More tools',
      'aria-label': 'More tools',
      onclick: (event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        openMenu({ x: rect.left, y: rect.top - 8 }, [
          { head: 'MORE TOOLS' },
          ...spill
            .filter(({ node }) => node.getClientRects().length === 0)
            .map(({ t }) => ({ icon: t.glyph, label: t.label, kbd: t.key, onSelect: () => pickTool(t.id) })),
        ]);
      },
    }, icon('dots-three-outline'));

    // Undo is on ⌘Z and in the Edit menu, and it is here as well: a canvas is
    // a drawing surface, and the hand that has just rubbed out the wrong
    // stroke is already down among the tools rather than up at the menu bar.
    const history = [
      el('button', { class: 'tier-3', title: 'Undo (⌘Z)', 'aria-label': 'Undo', disabled: past.length === 0, onclick: () => undo() }, icon('arrow-counter-clockwise')),
      el('button', { class: 'tier-3', title: 'Redo (⇧⌘Z)', 'aria-label': 'Redo', disabled: future.length === 0, onclick: () => redo() }, icon('arrow-clockwise')),
    ];

    const snapButton = el('button', {
      class: 'tier-3' + (snapOn ? ' on' : ''),
      title: `Snap to grid (G) — ${snapOn ? `${gridSize} px` : 'off'}`,
      'aria-label': 'Snap to grid',
      'aria-pressed': String(snapOn),
      onclick: () => toggleSnap(),
      oncontextmenu: (event) => { event.preventDefault(); openMenu({ x: event.clientX, y: event.clientY }, gridItems()); },
    }, icon('grid-four'));

    const hint = linkFrom
      ? el('span', { class: 'tool-hint', text: 'Now click the object to connect it to' })
      : null;

    mount(chromeHost,
      el('div', { class: chrome === 'tool_column' ? 'dock tool-column' : 'dock' },
        buttons, more, el('div', { class: 'sep tier-3' }), snapButton, history),
      styleHost, zoomPill, hint);
    drawStyle();
    updateCursor();
  }

  /**
   * The style bar: colour, width and fill for the pen in hand or for what is
   * selected, and nothing at all while neither needs one.
   */
  function drawStyle() {
    const chosen = selectedObjects();
    const inking = tool === 'ink' || tool === 'highlight';
    const shaping = tool === 'note' || tool === 'rect' || tool === 'ellipse' || tool === 'text'
      || tool === 'arrow' || tool === 'connector';
    if (tool === 'eraser') {
      const mode = (id, glyph, label, title) => el('button', {
        class: 'mode' + (eraseMode === id ? ' on' : ''),
        title,
        'aria-pressed': String(eraseMode === id),
        onclick: () => setEraseMode(id),
      }, icon(glyph), el('span', { text: label }));
      mount(styleHost, el('div', { class: 'style-bar erase-modes', role: 'group', 'aria-label': 'Eraser mode', onpointerdown: (event) => event.preventDefault() },
        mode('pixel', 'scissors', 'Precise', 'Draw mode: rub out only the part of a stroke you touch (E to switch)'),
        mode('stroke', 'eraser', 'Whole object', 'Select mode: remove any stroke or shape the eraser touches (E to switch)'),
      ));
      return;
    }
    if (!chosen.length && !inking && !shaping) { mount(styleHost); return; }

    const lead = chosen.find((o) => o.id === selectedId) ?? chosen[0];
    const colour = lead ? lead.color ?? null : drawColor;
    const kinds = new Set(chosen.map((o) => o.type));
    const hasWidth = chosen.length
      ? [...kinds].some((k) => STYLEABLE.stroke.includes(k)) && !(lead?.type === 'ink' && (lead.stroke ?? 0) >= HIGHLIGHT_MIN)
      : tool === 'ink' || tool === 'arrow' || tool === 'connector';
    const hasFill = chosen.length ? kinds.has('note') : tool === 'note' || tool === 'rect' || tool === 'ellipse';
    const hasColour = chosen.length ? [...kinds].some((k) => STYLEABLE.color.includes(k)) : true;
    const width = lead && lead.stroke !== undefined ? lead.stroke : drawStroke;
    const filled = lead ? Boolean(lead.fill) : drawFill !== null;

    const parts = [];
    if (hasColour) {
      parts.push(el('div', { class: 'swatch-row' }, ...NOTE_COLORS.map((role) => el('button', {
        class: 'swatch' + (colour === role ? ' on' : ''),
        title: colorLabel(role),
        'aria-label': role,
        style: { background: colorValue(role) },
        onclick: () => {
          drawColor = role;
          if (drawFill) drawFill = role;
          if (chosen.length) applyToSelection({ color: role }); else drawStyle();
        },
      })),
      ...recentInks().filter((hex) => !NOTE_COLORS.includes(hex)).slice(0, 3).map((hex) => el('button', {
        class: 'swatch' + (colour === hex ? ' on' : ''),
        title: hex,
        'aria-label': `Colour ${hex}`,
        style: { background: hex },
        onclick: () => pickCustom(hex),
      })),
      el('label', {
        class: 'swatch picker' + (colour && /^#/.test(colour) && !recentInks().slice(0, 3).includes(colour) ? ' on' : ''),
        title: 'Pick any colour',
      },
        icon('eyedropper'),
        el('input', {
          type: 'color',
          'aria-label': 'Pick any colour',
          value: /^#[0-9a-fA-F]{6}$/.test(colour ?? '') ? colour : '#6c63ff',
          onpointerdown: (event) => event.stopPropagation(),
          oninput: (event) => {
            const hex = event.target.value;
            drawColor = hex;
            if (drawFill) drawFill = hex;
            if (chosen.length) {
              for (const object of chosen) {
                if (STYLEABLE.color.includes(object.type)) object.color = hex;
                if (object.type === 'note' && object.fill) object.fill = hex;
              }
              drawObjects();
            }
          },
          onchange: (event) => pickCustom(event.target.value),
        }),
      ),
    ));
    }
    function pickCustom(hex) {
      rememberInk(hex);
      drawColor = hex;
      if (drawFill) drawFill = hex;
      if (chosen.length) applyToSelection({ color: hex }); else drawStyle();
    }
    if (hasWidth) {
      parts.push(el('div', { class: 'sep' }));
      parts.push(...STROKES.map((w) => el('button', {
        class: 'width' + (Math.abs(width - w) < 0.01 ? ' on' : ''),
        title: ['Fine', 'Medium', 'Bold'][STROKES.indexOf(w)],
        onclick: () => {
          drawStroke = w;
          if (chosen.length) applyToSelection({ stroke: w }); else drawStyle();
        },
      }, el('span', { style: { height: `${Math.max(2, w * 0.75)}px` } }))));
    }
    if (hasFill) {
      parts.push(el('div', { class: 'sep' }));
      parts.push(el('button', {
        class: filled ? 'on' : '',
        title: filled ? 'Remove fill' : 'Fill',
        'aria-label': 'Fill',
        onclick: () => {
          drawFill = filled ? null : drawColor;
          if (!chosen.length) { drawStyle(); return; }
          for (const object of chosen) {
            if (object.type === 'note') object.fill = filled ? null : (object.color ?? drawColor);
          }
          queue();
          drawObjects();
        },
      }, icon('paint-bucket', { bold: filled })));
    }
    if (chosen.length) {
      if (parts.length) parts.push(el('div', { class: 'sep' }));
      if (chosen.length > 1) parts.push(el('span', { class: 'count', text: String(chosen.length) }));
      parts.push(
        el('button', { title: 'Duplicate (⌘D)', 'aria-label': 'Duplicate', onclick: () => duplicateSelection() }, icon('copy')),
        el('button', { class: 'danger', title: 'Delete (⌫)', 'aria-label': 'Delete', onclick: () => deleteSelection() }, icon('trash')),
      );
    }
    mount(styleHost, el('div', { class: 'style-bar', onpointerdown: (event) => event.preventDefault() }, parts));
  }

  function updateCursor() {
    stage.classList.toggle('tool-ink', tool === 'ink' || tool === 'highlight');
    stage.classList.toggle('tool-note', tool in DRAWABLE);
    stage.classList.toggle('tool-line', tool in LINEAR);
    stage.classList.toggle('tool-erase', tool === 'eraser');
    stage.classList.toggle('tool-link', tool === 'connector');
  }

  function zoomBy(factor) {
    glide.stop();
    zoomedFrom = null;
    const rect = stage.getBoundingClientRect();
    const middle = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    anchor(toCanvas(middle.x, middle.y), middle.x, middle.y, clampZoom(viewport.zoom * factor));
    applyViewport();
    queueViewport();
  }

  /**
   * The objects that have an extent.
   *
   * Everything but the strokes: ink, a drawn line and a connector all keep
   * their shape in points rather than in a corner and a size, so asking one
   * for `x`/`width` gets zeroes, and letting those zeroes into a bounding box
   * drags it back to the origin.
   */
  function boxObjects() {
    return objects.filter((o) => o.type !== 'ink' && o.type !== 'connector' && o.type !== 'line');
  }

  /** The smallest box holding all of them, or nothing if there are none. */
  function contentBox() {
    const boxes = boxObjects();
    if (!boxes.length) return null;
    const minX = Math.min(...boxes.map((o) => o.x));
    const minY = Math.min(...boxes.map((o) => o.y));
    const maxX = Math.max(...boxes.map((o) => o.x + (o.width ?? 0)));
    const maxY = Math.max(...boxes.map((o) => o.y + (o.height ?? 0)));
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  /** Puts a box on the canvas in the middle of the window, with room around it. */
  function frame(box, padding) {
    const rect = stage.getBoundingClientRect();
    // A box seen at an angle needs a wider window than its own width.
    const cos = Math.abs(Math.cos(viewport.rotation * RAD));
    const sin = Math.abs(Math.sin(viewport.rotation * RAD));
    const width = Math.max(1, box.width * cos + box.height * sin);
    const height = Math.max(1, box.width * sin + box.height * cos);
    const zoom = clampZoom(Math.min(
      (rect.width - padding * 2) / width,
      (rect.height - padding * 2) / height,
    ));
    anchor(
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
      zoom,
    );
    applyViewport();
    queueViewport();
  }

  function fit() {
    glide.stop();
    // Fitting is also how a canvas that has been turned is put back straight:
    // it is the one control that promises the whole drawing, the right way up,
    // and there has to be one of those.
    viewport.rotation = 0;
    const box = contentBox();
    if (!box) { viewport = { x: 0, y: 0, zoom: 1, rotation: 0 }; applyViewport(); queueViewport(); return; }
    frame(box, 40);
  }

  /**
   * The canvas as it goes to paper.
   *
   * ⌘P on a canvas cannot mean "print the part of the plane that happens to be
   * under the window" — that is a scroll position, not a drawing. So the whole
   * canvas is fitted into the box the page gives it and put back exactly as it
   * was afterwards. Nothing is saved: this viewport lasts as long as the print
   * panel is open, and the position the student left the canvas in is theirs.
   *
   * Ink counts here, where `fit` ignores it. A canvas of nothing but
   * handwriting has bounds like any other, and printing it as a blank sheet
   * because none of it is a box would be absurd.
   */
  function fitForPrint() {
    const before = { ...viewport };
    const restore = () => { viewport = before; applyViewport(); };

    const xs = [];
    const ys = [];
    for (const object of objects) {
      if (object.type === 'connector') continue;
      if (object.type === 'ink' || object.type === 'line') {
        for (const [x, y] of object.points) { xs.push(x); ys.push(y); }
      } else {
        xs.push(object.x, object.x + (object.width ?? 0));
        ys.push(object.y, object.y + (object.height ?? 0));
      }
    }
    if (!xs.length) return restore;

    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(
      (PRINT_BOX.width - PRINT_MARGIN * 2) / Math.max(1, maxX - minX),
      (PRINT_BOX.height - PRINT_MARGIN * 2) / Math.max(1, maxY - minY),
    )));
    viewport = {
      zoom,
      x: PRINT_BOX.width / 2 - ((minX + maxX) / 2) * zoom,
      y: PRINT_BOX.height / 2 - ((minY + maxY) / 2) * zoom,
      // Paper has an up. However the plane was left on screen, it goes to the
      // printer square, and `restore` puts the angle back afterwards.
      rotation: 0,
    };
    applyViewport();
    return restore;
  }

  /* ── keyboard ──────────────────────────────────────────────────────── */

  const onKey = (event) => {
    if (!paneIsActive(host)) return;
    // Escape leaves the text being typed, keeping the object selected, so the
    // next key is a tool shortcut again rather than another letter.
    if (event.key === 'Escape' && event.target?.isContentEditable && layer.contains(event.target)) {
      event.target.blur();
      return;
    }
    if (/^(INPUT|TEXTAREA)$/.test(event.target?.tagName) || event.target?.isContentEditable) return;
    if ((event.key === 'Backspace' || event.key === 'Delete') && picked.size) {
      event.preventDefault();
      deleteSelection();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      select(null);
      for (const object of objects) if (object.type !== 'connector') picked.add(object.id);
      selectedId = [...picked].pop() ?? null;
      tool = 'select';
      drawChrome();
      drawObjects();
      return;
    }
    // Taken before the modifier guard below, and prevented, so WebKit stops
    // handing the keystroke on to the Edit menu's `undo:` — which reaches a
    // first responder that has nothing to say about a canvas.
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) redo(); else undo();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'd') {
      if (picked.size) { event.preventDefault(); duplicateSelection(); }
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) {
      // Z-order, on the bracket keys Excalidraw and every drawing program
      // before it put them on. Shift reaches past one step to the end.
      const order = { '[': event.shiftKey ? 'back' : 'backward', ']': event.shiftKey ? 'front' : 'forward' }[event.key];
      const object = order && objects.find((o) => o.id === selectedId);
      if (object) { event.preventDefault(); reorder(object, order); }
      return;
    }

    // Tab and Enter grow a mindmap. The same two keys do the same thing while
    // a node's text has focus — that handler lives on the editor — and this is
    // for the node that is merely selected, with the caret nowhere.
    if ((event.key === 'Tab' || event.key === 'Enter') && selectedId) {
      const node = objects.find((o) => o.id === selectedId);
      if (node?.type === 'note' && node.mindmap) {
        event.preventDefault();
        if (event.key === 'Tab') addChildNode(node); else addSiblingNode(node);
        return;
      }
    }

    if (event.key === 'Escape') {
      tool = 'select';
      linkFrom = null;
      if (picked.size) { select(null); drawObjects(); }
    }
    else {
      if (event.key.toLowerCase() === 'g' && !event.repeat) { toggleSnap(); return; }
      // Pressing E with the eraser already in hand flips between its modes.
      if (event.key.toLowerCase() === 'e' && tool === 'eraser' && !event.repeat) {
        setEraseMode(eraseMode === 'pixel' ? 'stroke' : 'pixel');
        return;
      }
      const pick = {
        v: 'select', h: 'pan', n: 'note', r: 'rect', o: 'ellipse',
        a: 'arrow', t: 'text', k: 'card',
        c: 'connector', p: 'ink', s: 'highlight', e: 'eraser',
      }[event.key.toLowerCase()];
      if (!pick) return;
      tool = pick;
      linkFrom = null;
    }
    drawChrome();
    updateCursor();
  };
  document.addEventListener('keydown', onKey);

  /* ── mount ─────────────────────────────────────────────────────────── */

  // The canvas's own paper. A device preference is still honoured for canvases
  // made before there was a choice, which is what the server falls back to.
  grid.classList.add(`grid-${paper}`);

  mount(host,
    topbar(fileCrumbs(file),
      status,
      pageMenu(() => [
        { icon: 'corners-out', label: 'Fit to content', onSelect: () => fit() },
        { icon: 'floppy-disk', label: 'Save now', onSelect: () => save() },
        { sep: true },
        ...gridItems(),
        { sep: true },
        ...fileItems(file),
      ], { title: 'Canvas options' }),
    ),
    el('div', { class: 'canvas-wrap-host', style: { flex: '1', display: 'flex', minHeight: '0', position: 'relative' } },
      stage, chromeHost,
    ),
  );

  drawChrome();
  drawObjects();
  applyViewport();

  const stopPrinting = onPrint(host, fitForPrint);

  // The grid is sized to the stage, so a window or split-view resize has to
  // size it again or the dots stop short of the new edge.
  const resized = new ResizeObserver(() => drawGrid());
  resized.observe(stage);

  return () => {
    clearTimeout(saveTimer);
    resized.disconnect();
    document.removeEventListener('keydown', onKey);
    stopPrinting();
    stopSmartZoom();
    // A frame loop running against a canvas nobody is looking at any more.
    glide.stop();
    if (dirty) save();
  };
}

/** Coordinates are bounded and finite server-side; keep them tidy client-side. */
function round(n) {
  return Math.max(-1_000_000, Math.min(1_000_000, Math.round(n * 100) / 100));
}
