/**
 * Page rendering for the PDF reader, on top of a vendored pdf.js.
 *
 * The app used to hand the file to WebKit's own viewer in an iframe, which
 * draws it perfectly and tells the host page nothing: no page positions, no
 * text selection, nowhere to put a mark. Rendering the pages ourselves is what
 * makes annotation possible at all, so this module exists to keep that
 * machinery out of the screen that uses it.
 *
 * Everything an annotation stores is in **normalized page space** — 0…1 across
 * the page's width and height — so a mark keeps its place at any zoom, on any
 * screen, and on a page of any size.
 */
import './stream-iterator.js';

const PDFJS_URL = '/vendor/pdfjs/pdf.min.mjs';
const WORKER_URL = '/vendor/pdfjs/pdf.worker.shim.mjs';

/** Roughly eight megapixels of backing store per page, whatever the zoom. */
const MAX_CANVAS_PIXELS = 8_000_000;

let library = null;

/** Loaded on demand: it is 450 KB, and most screens never open a PDF. */
export async function pdfjs() {
  if (!library) {
    library = await import(PDFJS_URL);
    library.GlobalWorkerOptions.workerSrc = WORKER_URL;
  }
  return library;
}

/**
 * Opens a document, and hands back the means of closing it.
 *
 * pdf.js 6 took `destroy` off the document proxy — only the loading task can
 * release the worker and the rasterised pages now — so the task has to travel
 * with the document. Calling the old method threw on the way out of the
 * reader, which left the memory held and, because the throw happened inside
 * the view's teardown, left the reader itself on screen.
 */
export async function openDocument(url) {
  const lib = await pdfjs();
  // Same-origin, so the session cookie rides along on its own; the flag is set
  // anyway because pdf.js decides its credentials mode from it explicitly.
  const task = lib.getDocument({ url, withCredentials: true });
  const doc = await task.promise;
  return { doc, close: () => task.destroy() };
}

/**
 * Draws one page onto a canvas and lays the selectable text over it.
 *
 * The canvas is rendered at the device's own pixel density and then scaled
 * back down in CSS, which is what keeps small type sharp on a retina display.
 *
 * Returns a handle rather than a promise, because a reader scrolls and zooms
 * faster than a page rasterises: whoever asked for the page has to be able to
 * take the request back.
 */
export function renderPage(page, { canvas, textContainer, scale }) {
  let cancelled = false;
  let task = null;

  const done = (async () => {
    const lib = await pdfjs();
    if (cancelled) return null;

    const viewport = page.getViewport({ scale });
    // A backing store is four bytes a pixel and is held until the page is
    // released, so density is capped by area as well as by ratio: at a high
    // zoom the two multiply, and a handful of pages can otherwise account for
    // more memory than the rest of the app put together.
    let ratio = Math.min(window.devicePixelRatio || 1, 2);
    const area = viewport.width * viewport.height * ratio * ratio;
    if (area > MAX_CANVAS_PIXELS) ratio *= Math.sqrt(MAX_CANVAS_PIXELS / area);

    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;

    const context = canvas.getContext('2d', { alpha: false });
    context.setTransform(ratio, 0, 0, ratio, 0, 0);

    // pdf.js continues its own work on requestAnimationFrame, which is what
    // keeps a long page drawing in step with the frames the reader is being
    // scrolled through. It is left alone deliberately: putting a macrotask in
    // front of it, as this once did, costs every chunk of every page an extra
    // hop through the event loop for no gain.
    task = page.render({ canvasContext: context, viewport });
    try {
      await task.promise;
    } catch (err) {
      if (cancelled || err?.name === 'RenderingCancelledException') return null;
      throw err;
    }
    if (cancelled || !textContainer) return viewport;

    textContainer.replaceChildren();
    lib.setLayerDimensions(textContainer, viewport);
    const layer = new lib.TextLayer({
      textContentSource: page.streamTextContent(),
      container: textContainer,
      viewport,
    });
    await layer.render();
    if (cancelled) textContainer.replaceChildren();
    return viewport;
  })();

  return {
    done,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      try { task?.cancel(); } catch { /* already finished */ }
    },
  };
}

/** A page's size in PDF units, which is what normalized space is a fraction of. */
export function pageSize(page) {
  const viewport = page.getViewport({ scale: 1 });
  return { width: viewport.width, height: viewport.height };
}
