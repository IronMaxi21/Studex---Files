/** Screen 06 — PDF reader: pages drawn by pdf.js, with drawing tools over them. */
import { el, svg, icon, mount, applyColor, colorValue, colorLabel } from '../dom.js';
import { dropdown } from '../select.js';
import { api } from '../api.js';
import { state, fileById, loadLibrary, toast, reportError } from '../store.js';
import { navigate } from '../router.js';
import { topbar, fileCrumbs, pageMenu, fileItems } from '../shell.js';
import { openMenu } from '../menu.js';
import { dialog, confirmDelete, promptText } from '../dialog.js';
import { plural } from '../format.js';
import { aiAvailable, explainPassage, generateCards, quizDialog } from '../ai.js';
import { openDocument, pageSize, renderPage } from '../pdf-render.js';
import { openOcclusionEditor } from '../occlusion.js';

const HIGHLIGHT_COLORS = ['amber', 'lime', 'teal', 'sky', 'rose', 'accent'];

const TOOLS = [
  { id: 'select', glyph: 'cursor-text', title: 'Select text to highlight' },
  { id: 'pen', glyph: 'pencil-simple', title: 'Draw' },
  { id: 'marker', glyph: 'highlighter', title: 'Highlighter' },
  { id: 'text', glyph: 'text-t', title: 'Write on the page' },
  { id: 'pin', glyph: 'chat-centered-text', title: 'Add a note' },
  { id: 'eraser', glyph: 'eraser', title: 'Rub marks out — drag across them' },
];

/** Pen and marker are both ink; only the width and the opacity differ. */
const INK = {
  pen: { stroke: 2, opacity: 1 },
  marker: { stroke: 14, opacity: 0.32 },
};

/** Type size for a text mark, as a fraction of the page height. */
const TEXT_SIZE = 0.022;

const ZOOMS = [0.75, 1, 1.25, 1.5, 2];

export async function pdfView(route, host) {
  const fileId = route.path[1];
  if (!fileId) { navigate('library'); return; }

  const [{ pdf }, { annotations }] = await Promise.all([
    api.pdf(fileId),
    api.annotations(fileId),
  ]);
  const file = fileById(fileId) ?? (await api.file(fileId)).file;

  let list = annotations;
  // `pdf/<id>/<page>` — a link from a document naming the page it is about.
  const opensAt = Math.max(0, Math.floor(Number(route.path[2]) || 0));
  let tool = 'select';
  let colour = 'amber';
  let scale = 1;
  let doc = null;
  let closeDoc = null;
  let disposed = false;

  const stage = el('div', { class: 'pdf-stage' });
  const toolbar = el('div', { class: 'pdf-tools' });
  /** page number → { host, layer, notes, size, rendered } */
  const pages = new Map();

  const refresh = async () => {
    list = (await api.annotations(fileId)).annotations;
    drawToolbar();
    for (const page of pages.keys()) drawAnnotations(page);
  };

  /* ── geometry ──────────────────────────────────────────────────────── */

  /** Client coordinates → this page's normalized space. */
  function toPage(pageNumber, clientX, clientY) {
    const box = pages.get(pageNumber).canvas.getBoundingClientRect();
    return {
      x: clamp01((clientX - box.left) / box.width),
      y: clamp01((clientY - box.top) / box.height),
    };
  }

  function clamp01(value) { return Math.max(0, Math.min(1, value)); }

  /* ── drawing ───────────────────────────────────────────────────────── */

  let stroke = null;

  function startStroke(pageNumber, event) {
    const spec = INK[tool];
    const at = toPage(pageNumber, event.clientX, event.clientY);
    const preview = svg('polyline', {
      fill: 'none',
      stroke: colorValue(colour),
      'stroke-width': spec.stroke,
      'stroke-opacity': spec.opacity,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'vector-effect': 'non-scaling-stroke',
    });
    pages.get(pageNumber).layer.appendChild(preview);
    stroke = { page: pageNumber, points: [[at.x, at.y]], preview, spec };
  }

  function extendStroke(event) {
    if (!stroke) return;
    const at = toPage(stroke.page, event.clientX, event.clientY);
    const last = stroke.points[stroke.points.length - 1];
    // A point that has not moved adds nothing but bytes.
    if (Math.abs(last[0] - at.x) < 0.001 && Math.abs(last[1] - at.y) < 0.001) return;
    stroke.points.push([at.x, at.y]);
    stroke.preview.setAttribute('points', stroke.points.map((p) => `${p[0] * 1000},${p[1] * 1000}`).join(' '));
  }

  async function endStroke() {
    if (!stroke) return;
    const finished = stroke;
    stroke = null;
    finished.preview.remove();
    if (finished.points.length < 2) return;

    try {
      await api.createAnnotation(fileId, {
        page: finished.page,
        kind: 'ink',
        geometry: { kind: 'path', points: finished.points, stroke: finished.spec.stroke },
        color: colour,
      });
      await refresh();
    } catch (err) { reportError(err); }
  }

  /* ── erasing ───────────────────────────────────────────────────────── */

  /**
   * The rubber, as a gesture rather than as a click.
   *
   * It used to be a click handler on the mark itself, which for ink meant
   * hitting a two-pixel line exactly — the tool looked broken because in
   * practice you always missed. Every mark now carries a generous invisible
   * hit area and the rubber is dragged across them: whatever is under the
   * pointer as it moves goes.
   *
   * Removal is done on screen first and confirmed with the server afterwards.
   * A rubber that waits for a round trip before anything disappears does not
   * feel like a rubber, and the id is remembered so one that is already on its
   * way out is not sent twice.
   */
  let erasing = false;
  const erased = new Set();

  /** How close the rubber has to come, in screen pixels. */
  const ERASER_REACH = 12;

  /** Where a text mark ended up, by annotation id — a text box has no geometry
   *  of its own until it has been laid out, so it is measured rather than
   *  computed. */
  const textNodes = new Map();

  function distance(ax, ay, bx, by) {
    return Math.hypot(ax - bx, ay - by);
  }

  /** How far a point is from a line segment, rather than from its ends. */
  function distanceToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) return distance(px, py, ax, ay);
    // How far along the segment the nearest point is, clamped to its ends.
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
    return distance(px, py, ax + t * dx, ay + t * dy);
  }

  /**
   * Whether the rubber, at this point on the screen, is on this mark.
   *
   * Worked out from the mark's own geometry rather than by asking the document
   * what is under the pointer. Hit-testing a drawn line means hitting a
   * two-pixel stroke exactly, which is why the tool used to look broken; and
   * the answer here does not depend on the page having been composited, on
   * what is drawn on top of what, or on how the SVG layer happens to be
   * stretched.
   */
  function touches(annotation, x, y, box) {
    const geometry = annotation.geometry;
    if (!geometry) return false;
    const toX = (v) => box.left + v * box.width;
    const toY = (v) => box.top + v * box.height;

    if (geometry.kind === 'quads') {
      return geometry.quads.some((quad) =>
        x >= toX(quad.x) - ERASER_REACH
        && x <= toX(quad.x + quad.width) + ERASER_REACH
        && y >= toY(quad.y) - ERASER_REACH
        && y <= toY(quad.y + quad.height) + ERASER_REACH);
    }

    if (geometry.kind === 'path') {
      const points = geometry.points;
      // A highlighter is fourteen pixels wide; the rubber has to reach the
      // whole of what was drawn, not just its middle.
      const reach = Math.max(ERASER_REACH, (geometry.stroke ?? 2) / 2 + 4);
      if (points.length === 1) {
        return distance(x, y, toX(points[0][0]), toY(points[0][1])) <= reach;
      }
      for (let i = 1; i < points.length; i += 1) {
        const near = distanceToSegment(
          x, y,
          toX(points[i - 1][0]), toY(points[i - 1][1]),
          toX(points[i][0]), toY(points[i][1]),
        );
        if (near <= reach) return true;
      }
      return false;
    }

    if (geometry.kind === 'point') {
      // The pin is drawn as a nine-unit circle; this is that plus the reach.
      return distance(x, y, toX(geometry.x), toY(geometry.y)) <= ERASER_REACH + 9;
    }

    if (geometry.kind === 'text') {
      const node = textNodes.get(annotation.id);
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      return x >= rect.left - ERASER_REACH && x <= rect.right + ERASER_REACH
        && y >= rect.top - ERASER_REACH && y <= rect.bottom + ERASER_REACH;
    }

    return false;
  }

  /**
   * Takes a mark off the page now and tells the server afterwards.
   *
   * A rubber that waits for a round trip before anything disappears does not
   * feel like a rubber. The id is remembered so one already on its way out is
   * not sent twice, and a refusal puts it back rather than leaving the page
   * disagreeing with the server.
   */
  function drop(id) {
    erased.add(id);
    list = list.filter((a) => a.id !== id);
    for (const page of pages.keys()) drawAnnotations(page);
    drawToolbar();
    api.deleteAnnotation(fileId, id).catch(async (err) => {
      reportError(err);
      erased.delete(id);
      if (!disposed) await refresh();
    });
  }

  function eraseAt(pageNumber, clientX, clientY) {
    const entry = pages.get(pageNumber);
    if (!entry) return false;
    const box = entry.canvas.getBoundingClientRect();
    let hit = false;
    // A copy, because dropping a mark rewrites the list underneath.
    for (const annotation of [...list]) {
      if (annotation.page !== pageNumber || erased.has(annotation.id)) continue;
      if (!touches(annotation, clientX, clientY, box)) continue;
      drop(annotation.id);
      hit = true;
    }
    return hit;
  }

  /* ── text on the page ──────────────────────────────────────────────── */

  /**
   * Opens a box to type into, at the point that was clicked.
   *
   * The box is a real element in the page's own overlay rather than a dialog,
   * so what you type sits where it will end up. Enter commits, Escape and an
   * empty box both abandon it, and clicking away commits whatever is there —
   * which is what every other text tool does.
   */
  function writeText(pageNumber, at, existing = null) {
    const entry = pages.get(pageNumber);
    if (!entry) return;

    const box = el('div', {
      class: 'pdf-note editing',
      contenteditable: 'plaintext-only',
      style: textStyle(entry, at, existing?.color ?? colour),
    });
    if (existing?.note) box.textContent = existing.note;
    entry.notes.appendChild(box);
    // Focused a frame later: focusing a node in the same tick it was attached
    // loses the caret in WebKit often enough to be worth the frame.
    requestAnimationFrame(() => {
      box.focus();
      const range = document.createRange();
      range.selectNodeContents(box);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });

    let settled = false;
    const finish = async (commit) => {
      if (settled) return;
      settled = true;
      const note = box.textContent.trim();
      box.remove();
      if (!commit || !note || note === (existing?.note ?? '')) {
        // Nothing to say, or nothing changed. The mark that was already there
        // is redrawn by the pass below; a new one simply never happens.
        if (existing) drawAnnotations(pageNumber);
        return;
      }
      try {
        if (existing) await api.updateAnnotation(fileId, existing.id, { note });
        else {
          await api.createAnnotation(fileId, {
            page: pageNumber,
            kind: 'text',
            geometry: { kind: 'text', x: at.x, y: at.y, size: TEXT_SIZE },
            color: colour,
            note,
          });
        }
        await refresh();
      } catch (err) {
        reportError(err);
        if (!disposed) await refresh();
      }
    };

    box.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void finish(true); }
      else if (event.key === 'Escape') { event.preventDefault(); void finish(false); }
    });
    box.addEventListener('blur', () => { void finish(true); });
    // The page below is listening for pointerdown to start marks; a click
    // inside the box is not one of those.
    box.addEventListener('pointerdown', (event) => event.stopPropagation());
  }

  /** Where a text mark sits and how big it is, at the current zoom. */
  function textStyle(entry, at, color) {
    return {
      left: `${at.x * 100}%`,
      top: `${at.y * 100}%`,
      fontSize: `${Math.max(9, (at.size ?? TEXT_SIZE) * entry.size.height * scale)}px`,
      color: colorValue(color ?? 'accent'),
    };
  }

  /* ── selection → highlight ─────────────────────────────────────────── */

  /**
   * Turns the current text selection into a highlight.
   *
   * Every rectangle the selection reports is mapped into the page's own space,
   * which is what lets the mark be redrawn at a different zoom later. The
   * selected text is stored with it, and is what a card made from this passage
   * will ask.
   */
  async function highlightSelection(pageNumber) {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;

    const text = selection.toString().trim();
    const range = selection.getRangeAt(0);
    const box = pages.get(pageNumber).canvas.getBoundingClientRect();

    const quads = [...range.getClientRects()]
      .filter((rect) => rect.width > 1 && rect.height > 1)
      .map((rect) => ({
        x: clamp01((rect.left - box.left) / box.width),
        y: clamp01((rect.top - box.top) / box.height),
        width: clamp01(rect.width / box.width),
        height: clamp01(rect.height / box.height),
      }))
      .slice(0, 500);

    if (!quads.length || !text) return;
    selection.removeAllRanges();

    try {
      await api.createAnnotation(fileId, {
        page: pageNumber,
        kind: 'highlight',
        geometry: { kind: 'quads', quads },
        color: colour,
        quotedText: text.slice(0, 10_000),
      });
      await refresh();
    } catch (err) { reportError(err); }
  }

  async function addPin(pageNumber, event) {
    const at = toPage(pageNumber, event.clientX, event.clientY);
    const note = await promptText({ title: `Note on page ${pageNumber}`, label: 'Your note', confirmLabel: 'Add' });
    if (!note) return;
    try {
      await api.createAnnotation(fileId, {
        page: pageNumber,
        kind: 'comment',
        geometry: { kind: 'point', x: at.x, y: at.y },
        color: colour,
        note,
      });
      await refresh();
    } catch (err) { reportError(err); }
  }

  async function erase(annotation) {
    try {
      await api.deleteAnnotation(fileId, annotation.id);
      await refresh();
    } catch (err) { reportError(err); }
  }

  /* ── annotation layer ──────────────────────────────────────────────── */

  function drawAnnotations(pageNumber) {
    const entry = pages.get(pageNumber);
    if (!entry) return;
    entry.layer.replaceChildren();
    // A box being typed into is not an annotation yet, and redrawing the ones
    // that are must not take it away mid-sentence.
    for (const node of [...entry.notes.children]) {
      if (!node.classList.contains('editing')) node.remove();
    }
    for (const annotation of list) {
      if (annotation.page === pageNumber) textNodes.delete(annotation.id);
    }

    for (const annotation of list.filter((a) => a.page === pageNumber)) {
      const paint = colorValue(annotation.color ?? 'amber');
      const onPick = (event) => {
        event.stopPropagation();
        if (tool === 'eraser') { void erase(annotation); return; }
        annotationMenu(annotation, event.clientX, event.clientY);
      };

      if (annotation.geometry?.kind === 'quads') {
        for (const quad of annotation.geometry.quads) {
          entry.layer.appendChild(svg('rect', {
            x: quad.x * 1000, y: quad.y * 1000,
            width: quad.width * 1000, height: quad.height * 1000,
            rx: 2, fill: paint, 'fill-opacity': 0.3,
            class: 'ann-mark', 'data-ann-id': annotation.id, onclick: onPick,
          }));
        }
      } else if (annotation.geometry?.kind === 'path') {
        const points = annotation.geometry.points.map((p) => `${p[0] * 1000},${p[1] * 1000}`).join(' ');
        const width = annotation.geometry.stroke ?? 2;
        entry.layer.appendChild(svg('polyline', {
          points, fill: 'none', stroke: paint,
          'stroke-width': width,
          'stroke-opacity': width >= 8 ? 0.32 : 1,
          'stroke-linecap': 'round', 'stroke-linejoin': 'round',
          'vector-effect': 'non-scaling-stroke',
          class: 'ann-ink',
        }));
        // The line itself is two pixels wide, which is not something anyone
        // can be asked to hit. This is what the pointer actually meets: the
        // same line, drawn fat and invisible.
        entry.layer.appendChild(svg('polyline', {
          points, fill: 'none', stroke: 'transparent',
          'stroke-width': Math.max(14, width),
          'stroke-linecap': 'round', 'stroke-linejoin': 'round',
          'vector-effect': 'non-scaling-stroke',
          class: 'ann-mark hit', 'data-ann-id': annotation.id, onclick: onPick,
        }));
      } else if (annotation.geometry?.kind === 'point') {
        entry.layer.appendChild(svg('circle', {
          cx: annotation.geometry.x * 1000, cy: annotation.geometry.y * 1000,
          r: 9, fill: paint, 'fill-opacity': 0.85, stroke: 'white', 'stroke-width': 1.5,
          class: 'ann-mark pin', 'data-ann-id': annotation.id, onclick: onPick,
        }));
      } else if (annotation.geometry?.kind === 'text') {
        const node = el('div', {
          class: 'pdf-note',
          text: annotation.note ?? '',
          dataset: { annId: annotation.id },
          style: textStyle(entry, annotation.geometry, annotation.color),
          onclick: onPick,
          ondblclick: (event) => {
            event.stopPropagation();
            node.remove();
            writeText(pageNumber, annotation.geometry, annotation);
          },
        });
        entry.notes.appendChild(node);
        textNodes.set(annotation.id, node);
      }
    }
  }

  /* ── pages ─────────────────────────────────────────────────────────── */

  /**
   * How many pages there are is only knowable once pdf.js has parsed the file,
   * which is after the import that created it has finished — so an imported
   * PDF arrives with no count at all and nothing was ever writing one back.
   *
   * The header is filled in from the document itself, because that is where
   * the number comes from and it is true whether or not the server takes it.
   * The write is so that everywhere else showing this file knows too, and a
   * refusal is swallowed: a number beside a title is not worth interrupting
   * the pages for, and the next time it is opened is another chance.
   */
  async function recordPageCount(count) {
    if (disposed || !count || count === pdf.page_count) return;
    pageCount.textContent = plural(count, 'page');
    try {
      await api.updatePdf(fileId, { pageCount: count });
      pdf.page_count = count;
    } catch { /* drawn is what matters; counted can wait */ }
  }

  async function buildPages() {
    ({ doc, close: closeDoc } = await openDocument(api.pdfContentUrl(fileId)));
    if (disposed) return;
    void recordPageCount(doc.numPages);

    mount(stage);
    pages.clear();

    for (let number = 1; number <= doc.numPages; number += 1) {
      const page = await doc.getPage(number);
      if (disposed) return;
      const size = pageSize(page);

      const canvas = el('canvas', { class: 'pdf-canvas' });
      const text = el('div', { class: 'pdf-text' });
      // One thousand units across, whatever the page's real size — the same
      // space the annotations are stored in, so nothing has to be converted
      // when the zoom changes.
      const layer = svg('svg', { class: 'pdf-ink', viewBox: '0 0 1000 1000', preserveAspectRatio: 'none' });
      // Text marks are HTML rather than SVG: the layer above is stretched to
      // the page's aspect ratio, and letters drawn inside it would be
      // stretched with it.
      const notes = el('div', { class: 'pdf-notes' });

      const holder = el('div', {
        class: 'pdf-page',
        dataset: { page: String(number) },
        style: { width: `${size.width * scale}px`, height: `${size.height * scale}px` },
      }, canvas, text, layer, notes, el('span', { class: 'pdf-page-number', text: String(number) }));

      pages.set(number, { page, holder, canvas, text, layer, notes, size, rendered: false, job: null });
      stage.appendChild(holder);
      attachPointer(number, holder);
    }

    // Pages are drawn as they come near the viewport: a hundred-page paper
    // would otherwise rasterise every page before showing the first one.
    //
    // Driven by scroll rather than by IntersectionObserver. Observer callbacks
    // are delivered on the rendering lifecycle, so a view the platform has
    // decided not to paint never receives one and the reader stays blank;
    // scroll events, and the first pass below, do not depend on that.
    stage.addEventListener('scroll', schedulePaint, { passive: true });
    window.addEventListener('resize', schedulePaint);

    // Jump before the first paint, so the pages that get drawn are the ones
    // being asked for rather than page one and then, a moment later, these.
    const target = pages.get(opensAt);
    if (target) target.holder.scrollIntoView({ block: 'start' });
    paintVisible();
  }

  let paintPending = false;
  let painting = false;
  let paintAgain = false;

  function schedulePaint() {
    if (paintPending) return;
    paintPending = true;
    setTimeout(() => { paintPending = false; void paintVisible(); }, 80);
  }

  /** How far outside the viewport a page is drawn, and how far it is kept. */
  const DRAW_MARGIN = 400;
  const KEEP_MARGIN = 2400;

  /** The page most of the view is on: the one nearest the middle of the stage. */
  function pageInView() {
    const view = stage.getBoundingClientRect();
    const middle = (view.top + view.bottom) / 2;
    let best = 1;
    let bestDistance = Infinity;
    for (const [number, entry] of pages) {
      const box = entry.holder.getBoundingClientRect();
      const d = box.top <= middle && box.bottom >= middle ? 0 : Math.min(Math.abs(box.top - middle), Math.abs(box.bottom - middle));
      if (d < bestDistance) { bestDistance = d; best = number; }
    }
    return best;
  }

  /**
   * A page drawn to a picture of its own, for covering its labels. Rendered at
   * a fixed scale rather than the reading zoom, so the boxes a student draws
   * land on a picture sharp enough to study from.
   */
  async function diagramCards(number) {
    const entry = pages.get(number);
    if (!entry) return;
    const canvas = document.createElement('canvas');
    try {
      await renderPage(entry.page, { canvas, textContainer: null, scale: 2 }).done;
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('The page could not be drawn as a picture.');
      await openOcclusionEditor({ blob, sourceFileId: fileId, sourcePage: number, title: `Diagram cards from page ${number}` });
    } catch (err) {
      reportError(err);
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  /** How far a page's box is from the part of the stage being looked at. */
  function distanceFromView(entry) {
    const view = stage.getBoundingClientRect();
    const box = entry.holder.getBoundingClientRect();
    if (box.bottom < view.top) return view.top - box.bottom;
    if (box.top > view.bottom) return box.top - view.bottom;
    return 0;
  }

  /**
   * Draws every page within a screen's reach of the one being read, and gives
   * back the ones that have been left far behind.
   *
   * The giving back is the point. A page's canvas is four bytes per pixel and
   * its text layer is a few thousand positioned spans; a reader who scrolls
   * through a long paper would otherwise accumulate every page they passed and
   * hand the renderer more than it can hold. Only the raster and the text go —
   * the marks on the page are ours, they stay.
   */
  async function paintVisible() {
    // A pass walks the pages in order, so a reader who jumps back to a page it
    // has already gone past would not be served until the next scroll event —
    // which, at the end of a scroll, may never come. Ask for one more pass.
    if (painting) { paintAgain = true; return; }
    painting = true;
    try {
      for (const [number, entry] of pages) {
        if (disposed) return;
        const distance = distanceFromView(entry);
        if (!entry.rendered && distance <= DRAW_MARGIN) await paint(number);
        // Re-measured each time round: the paint above takes long enough that
        // the reader may have scrolled somewhere else entirely.
        else if (entry.rendered && distanceFromView(entry) > KEEP_MARGIN) release(entry);
      }
    } finally {
      painting = false;
    }
    if (paintAgain && !disposed) { paintAgain = false; await paintVisible(); }
  }

  async function paint(number) {
    const entry = pages.get(number);
    if (!entry || entry.rendered) return;
    entry.rendered = true;
    const job = renderPage(entry.page, { canvas: entry.canvas, textContainer: entry.text, scale });
    entry.job = job;
    try {
      const viewport = await job.done;
      if (viewport) drawAnnotations(number);
    } catch (err) {
      entry.rendered = false;
      reportError(err);
    } finally {
      if (entry.job === job) entry.job = null;
    }
  }

  /** Drops a page's raster and text, keeping its marks and its place. */
  function release(entry) {
    entry.job?.cancel();
    entry.job = null;
    entry.rendered = false;
    entry.text.replaceChildren();
    entry.canvas.width = 0;
    entry.canvas.height = 0;
    entry.canvas.style.width = '';
    entry.canvas.style.height = '';
  }

  function attachPointer(number, holder) {
    holder.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      if (tool === 'pen' || tool === 'marker') {
        event.preventDefault();
        holder.setPointerCapture(event.pointerId);
        startStroke(number, event);
      } else if (tool === 'pin') {
        event.preventDefault();
        void addPin(number, event);
      } else if (tool === 'text') {
        event.preventDefault();
        writeText(number, { ...toPage(number, event.clientX, event.clientY), size: TEXT_SIZE });
      } else if (tool === 'eraser') {
        event.preventDefault();
        holder.setPointerCapture(event.pointerId);
        erasing = true;
        eraseAt(number, event.clientX, event.clientY);
      }
    });
    holder.addEventListener('pointermove', (event) => {
      if (erasing) { eraseAt(number, event.clientX, event.clientY); return; }
      extendStroke(event);
    });
    holder.addEventListener('pointerup', () => { erasing = false; void endStroke(); });
    holder.addEventListener('pointercancel', () => { erasing = false; void endStroke(); });
    holder.addEventListener('mouseup', () => {
      if (tool === 'select') void highlightSelection(number);
    });
  }

  async function rescale(next) {
    scale = next;
    for (const [number, entry] of pages) {
      entry.holder.style.width = `${entry.size.width * scale}px`;
      entry.holder.style.height = `${entry.size.height * scale}px`;
      // Every page is now the wrong size, including any part-way through
      // drawing: a render left running would finish onto a canvas that has
      // already been resized under it.
      release(entry);
      // The marks do not wait for the raster. Text on the page is sized
      // against the page, so leaving it until the repaint finishes means the
      // words stay the size they were while the page around them grows.
      drawAnnotations(number);
    }
    drawToolbar();
    await paintVisible();
  }

  /* ── chrome ────────────────────────────────────────────────────────── */

  function drawToolbar() {
    // What can become a card is what carries a quoted passage — that is the
    // front of the card. The kind of annotation is beside the point.
    const quoted = list.filter((a) => a.quoted_text?.trim());

    mount(toolbar,
      el('div', { class: 'seg' }, TOOLS.map((t) => el('button', {
        class: tool === t.id ? 'on' : '',
        title: t.title,
        onclick: () => { tool = t.id; drawToolbar(); stage.dataset.tool = t.id; },
      }, icon(t.glyph)))),
      el('div', { class: 'ink-swatches' }, HIGHLIGHT_COLORS.map((role) => el('button', {
        class: 'ink-swatch' + (colour === role ? ' on' : ''),
        title: role,
        style: { background: colorValue(role) },
        onclick: () => { colour = role; drawToolbar(); },
      }))),
      el('span', { class: 'grow' }),
      // The rail this used to live in is gone, so the one thing on it that was
      // not just a list of what you had already done comes here instead.
      quoted.length
        ? el('button', { class: 'chip', onclick: (e) => chooseCards(quoted, e) },
            icon('cards'), `${plural(quoted.length, 'passage')} → cards`)
        : null,
      el('div', { class: 'seg' },
        el('button', { title: 'Zoom out', onclick: () => rescale(step(-1)) }, icon('minus')),
        el('button', { class: 'zoom', text: `${Math.round(scale * 100)}%` }),
        el('button', { title: 'Zoom in', onclick: () => rescale(step(1)) }, icon('plus')),
      ),
    );
  }

  function step(direction) {
    const at = ZOOMS.findIndex((z) => z >= scale - 0.001);
    const next = Math.max(0, Math.min(ZOOMS.length - 1, (at === -1 ? 1 : at) + direction));
    return ZOOMS[next];
  }

  /**
   * One chip, two ways to fill a deck.
   *
   * With no AI configured this is the button it has always been. With one, the
   * distinction is worth a menu: the first makes cards *of* the passages, the
   * quote on the front, and the second makes cards *from* them. Deciding here
   * rather than inside the dialog keeps either path a single question deep.
   */
  async function chooseCards(passages, event) {
    if (!(await aiAvailable())) { makeCards(passages); return; }

    openMenu({ x: event.clientX, y: event.clientY }, [
      { head: plural(passages.length, 'PASSAGE', 'PASSAGES') },
      { icon: 'cards', label: 'Cards from the quotes', onSelect: () => makeCards(passages) },
      {
        icon: 'sparkle',
        label: 'Write cards with AI',
        onSelect: () => generateCards({
          // The quotes themselves, not a page range: the passages on screen are
          // the ones that were chosen, and a range would sweep in every other
          // mark that happens to sit between them.
          source: { from: 'text', text: passages.map((p) => p.quoted_text).filter(Boolean).join('\n\n') },
          sourceLabel: plural(passages.length, 'quoted passage'),
          sourceFileId: fileId,
        }),
      },
      {
        icon: 'question',
        label: 'Quiz me with AI',
        onSelect: () => quizDialog({
          source: { from: 'text', text: passages.map((p) => p.quoted_text).filter(Boolean).join('\n\n') },
          label: plural(passages.length, 'quoted passage'),
        }),
      },
    ]);
  }

  async function makeCards(passages) {
    const decks = state.files.filter((f) => f.kind === 'deck');
    if (!decks.length) { toast('Create a flashcard deck first.', 'error'); return; }

    const select = dropdown({ class: 'input' }, decks.map((d) => el('option', { value: d.id, text: d.title })));
    const ok = await dialog({
      title: 'Turn passages into cards',
      confirmLabel: 'Create cards',
      body: el('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        el('div', { class: 'muted' }, `${plural(passages.length, 'quoted passage')} will become flashcards.`),
        el('div', { class: 'field' }, el('label', { text: 'Deck' }), select),
      ),
      onConfirm: async () => {
        await api.cardsFromHighlights(fileId, {
          deckId: select.value,
          annotationIds: passages.map((p) => p.id),
        });
        return true;
      },
    });
    if (ok) { await loadLibrary(); toast('Cards created.'); }
  }

  // Asynchronous for the AI item alone: an "Explain this" that turns out to
  // have no model behind it is worse than the moment before the menu opens.
  /**
   * Puts a passage into a page of notes, as a block that links back here.
   *
   * A highlight on its own is a mark on someone else's document: it is only
   * worth anything once it is somewhere the student writes. The block carries
   * the words as well as the page number, so the note still says something on
   * a device that never downloaded the PDF, and it opens the reader at the
   * page the passage came from.
   */
  async function sendToDocument(annotation) {
    const quote = (annotation.quoted_text ?? annotation.note ?? '').trim();
    const docs = state.files.filter((f) => f.kind === 'doc' && !f.trashed_at);
    if (!docs.length) { toast('Create a page of notes first.', 'error'); return; }

    const pick = dropdown({ class: 'input' }, docs.map((d) => el('option', { value: d.id, text: d.title })));
    const note = el('input', { class: 'input', placeholder: 'What you made of it (optional)' });
    const ok = await dialog({
      title: `Send page ${annotation.page} to a page of notes`,
      confirmLabel: 'Send',
      body: el('div', null,
        el('div', { class: 'field' }, el('label', { text: 'Page' }), pick),
        el('div', { class: 'field' }, el('label', { text: 'Note' }), note),
        el('div', { class: 'sub', text: quote ? `\u201c${quote.slice(0, 120)}${quote.length > 120 ? '…' : ''}\u201d` : 'This mark has no words with it, so only the link is sent.' }),
      ),
      onConfirm: async () => {
        const { document: doc } = await api.document(pick.value);
        const block = {
          id: crypto.randomUUID(),
          type: 'pdf',
          fileId,
          page: annotation.page,
          quote: quote ? quote.slice(0, 4_000) : null,
          note: note.value.trim() ? note.value.trim().slice(0, 4_000) : null,
        };
        await api.saveDocument(pick.value, [...doc.blocks, block], doc.revision, doc.style);
        return true;
      },
    });
    if (!ok) return;
    const target = docs.find((d) => d.id === pick.value);
    toast(`Sent to \u201c${target?.title ?? 'your notes'}\u201d.`);
  }

  async function annotationMenu(annotation, x, y) {
    const canExplain = Boolean(annotation.quoted_text?.trim()) && await aiAvailable();

    openMenu({ x, y }, [
      { head: `PAGE ${annotation.page}` },
      {
        swatches: HIGHLIGHT_COLORS.map((role) => ({
          color: colorValue(role), label: colorLabel(role), on: annotation.color === role,
          onSelect: async () => {
            try { await api.updateAnnotation(fileId, annotation.id, { color: role }); await refresh(); }
            catch (err) { reportError(err); }
          },
        })),
      },
      { sep: true },
      canExplain
        ? { icon: 'sparkle', label: 'Explain this', onSelect: () => explainPassage({
            fileId, annotationId: annotation.id, title: `Page ${annotation.page}`,
          }) }
        : null,
      {
        icon: 'arrow-bend-up-right',
        label: 'Send to a page of notes',
        onSelect: () => void sendToDocument(annotation),
      },
      {
        icon: 'note-pencil',
        label: annotation.kind === 'text' ? 'Edit text' : annotation.note ? 'Edit note' : 'Add note',
        onSelect: async () => {
          const note = await promptText({
            title: annotation.kind === 'text' ? 'Text' : 'Note',
            label: annotation.kind === 'text' ? 'What it says' : 'Your note',
            value: annotation.note ?? '',
            confirmLabel: 'Save',
          });
          if (note === null) return;
          try { await api.updateAnnotation(fileId, annotation.id, { note }); await refresh(); }
          catch (err) { reportError(err); }
        },
      },
      { sep: true },
      {
        icon: 'trash', label: 'Delete annotation', danger: true, onSelect: async () => {
          const ok = await confirmDelete('The mark and its note are removed from the page.');
          if (!ok) return;
          await erase(annotation);
        },
      },
    ]);
  }

  /* ── mount ─────────────────────────────────────────────────────────── */

  stage.dataset.tool = tool;
  const pageCount = el('span', {
    class: 'dim',
    style: { fontSize: '11.5px' },
    text: pdf.page_count ? plural(pdf.page_count, 'page') : '',
  });
  mount(host,
    topbar(fileCrumbs(file),
      pageCount,
      pageMenu(() => [
        pages.size
          ? { icon: 'selection-plus', label: `Diagram cards from page ${pageInView()}…`, onSelect: () => void diagramCards(pageInView()) }
          : null,
        {
          icon: 'export', label: 'Export notes',
          onSelect: () => el('a', { href: `/api/pdfs/${fileId}/export`, download: 'annotations.md' }).click(),
        },
        { sep: true },
        ...fileItems(file),
      ], { title: 'PDF options' }),
    ),
    toolbar,
    // One column. The list of annotations down the side said nothing the page
    // itself does not already show, and took a fifth of the reading width to
    // say it.
    el('div', { class: 'pdf' }, stage),
  );

  drawToolbar();
  mount(stage, el('div', { class: 'loading' }, el('div', { class: 'spinner' }), 'Rendering…'));
  buildPages().catch((err) => {
    // The reason matters: a password-protected file, a truncated upload and a
    // blocked worker all fail here and need different things done about them.
    mount(stage, el('div', { class: 'empty-state' },
      icon('warning-circle'),
      'That PDF could not be opened.',
      el('div', { class: 'dim', style: { fontSize: '12px', maxWidth: '46ch' }, text: err?.message ?? String(err) }),
    ));
    reportError(err);
  });

  return () => {
    disposed = true;
    stage.removeEventListener('scroll', schedulePaint);
    window.removeEventListener('resize', schedulePaint);
    for (const entry of pages.values()) entry.job?.cancel();
    void closeDoc?.();
  };
}
