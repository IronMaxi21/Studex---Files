import { printNow } from './native.js';
import { log } from './log.js';

/**
 * Printing, from the page's side.
 *
 * Most screens print from the stylesheet alone: web/css/print.css drops the
 * chrome, re-grounds the ramp on white and unwinds the scrolling panes, and
 * what is left is the document. Two screens cannot be printed by CSS, because
 * what should come out of the printer is not what is on the glass:
 *
 *  - a deck is a list of rows on screen and a sheet of cards on paper;
 *  - a canvas is a window onto a plane, and which part of the plane is under
 *    that window when ⌘P is pressed is not what anyone means by "print this".
 *
 * So a view may register a preparer, which rearranges the page for paper and
 * returns the function that puts it back.
 */

/**
 * One preparer at a time — only one view is on screen.
 *
 * It is held with the node it belongs to rather than with a lifetime. Views
 * are mounted by replacing what was there, and not all of them return a
 * disposer; a preparer whose node has left the document is a preparer for a
 * screen nobody is looking at, and is dropped when it is next reached for.
 */
let registered = null;

/**
 * Registers how this view wants to be printed.
 *
 * `prepare` may be async, and returns the function that undoes it — or
 * nothing, if it had nothing to undo. The returned function unregisters, for
 * views that do clean up after themselves.
 */
export function onPrint(node, prepare) {
  registered = { node, prepare };
  return () => { if (registered?.prepare === prepare) registered = null; };
}

/** Whether a print is already under way; ⌘P held down should not stack. */
let printing = false;

/** Prints the current screen, preparing it first if its view asked to. */
export async function printCurrent() {
  if (printing) return;
  printing = true;

  let restore = null;
  try {
    if (registered && !registered.node.isConnected) registered = null;
    if (registered) {
      try {
        restore = await registered.prepare();
      } catch (err) {
        // A preparer that failed leaves the screen as it was, which still
        // prints — badly for a deck, but printing nothing would be worse.
        log.error('print preparation failed', err);
      }
    }

    // Two frames, because the first is when the style and layout the preparer
    // asked for are calculated and the second is when they are on screen. The
    // shell snapshots the page the moment it is asked to, so handing it over
    // any sooner prints the screen as it was.
    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });

    await printNow();
  } finally {
    printing = false;
    if (typeof restore === 'function') {
      try { restore(); } catch (err) { log.error('print cleanup failed', err); }
    }
  }
}
