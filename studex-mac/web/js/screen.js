/**
 * What is actually on screen, as text.
 *
 * The chat could already read a note or a deck, because those are rows the
 * server owns and can fetch by id. Everything else it was blind to: a PDF it
 * could only see through passages you had highlighted, and the calendar,
 * statistics, the timetable and a canvas it could not see at all. Asking "what
 * does this page say" got an answer about a file, or nothing.
 *
 * So the page sends what it is showing. The text is harvested from the pane
 * the question was asked from — not the window, so the chat panel, the sidebar
 * and the top bar stay out of it — and the part in view goes first, because on
 * a fifty-page PDF the budget is spent long before the end and the page being
 * read is the one the question is about.
 */

import { focusedPane } from './router.js';

/** Chrome, and things that are not the page: never part of what is being read. */
const SKIP = [
  'script', 'style', 'noscript', 'svg', 'canvas',
  '.ai-chat', '.topbar', '.sidebar', '.crumbs', '.pane-divider',
  '.dialog-backdrop', '.toast-stack', '.menu', '.palette', '.focus-overlay',
  '[aria-hidden="true"]', '[hidden]', '[data-screen="skip"]',
].join(',');

/** Blocks shorter than this are labels and chrome; longer ones are content. */
const MIN_BLOCK = 2;

/** What a single harvested block may contribute, so one huge node cannot take the lot. */
const MAX_BLOCK = 1_400;

function visible(node) {
  // `checkVisibility` covers display, visibility, `content-visibility` and the
  // closed half of a <details> in one call, which four separate checks did not.
  if (typeof node.checkVisibility === 'function') {
    return node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  }
  return node.getClientRects().length > 0;
}

function tidy(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The elements whose text is worth taking, in document order.
 *
 * Leaves only: an ancestor's `textContent` is every descendant's run together,
 * so taking both would send the page twice. A leaf here means "has no element
 * child that itself holds text", which keeps a paragraph with a bold word in
 * it whole rather than splitting it into three.
 */
function blocks(root) {
  const out = [];
  const walk = (node) => {
    if (!(node instanceof Element)) return;
    // Walked top down, so a skipped node's descendants are never reached.
    if (node.matches(SKIP)) return;
    if (!visible(node)) return;

    const children = [...node.children].filter((c) => !c.matches(SKIP) && c.textContent.trim());
    if (children.length) {
      for (const child of node.children) walk(child);
      // Text sitting directly on a node that also has element children — a
      // list item whose label is loose text beside a badge — would otherwise
      // be dropped between the two.
      const own = tidy([...node.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent).join(' '));
      if (own.length >= MIN_BLOCK) out.push({ node, text: own });
      return;
    }

    const text = tidy(node.textContent);
    if (text.length >= MIN_BLOCK) out.push({ node, text: text.slice(0, MAX_BLOCK) });
  };
  for (const child of root.children) walk(child);
  return out;
}

/** True when any part of the element is inside the scroller it sits in. */
function inView(node) {
  const rect = node.getBoundingClientRect();
  if (!rect.width && !rect.height) return false;
  return rect.bottom > 0 && rect.top < (window.innerHeight || 0)
    && rect.right > 0 && rect.left < (window.innerWidth || 0);
}

/**
 * The text of the pane the question was asked from, in view first.
 *
 * Returns an empty string when there is nothing worth sending, so the caller
 * can leave the field off rather than send a field that says nothing.
 */
export function screenText({ limit = 6_000 } = {}) {
  const panes = [...document.querySelectorAll('.pane')];
  const pane = panes[focusedPane()] ?? panes[0];
  if (!pane) return '';

  const found = blocks(pane);
  if (!found.length) return '';

  const seen = new Set();
  const near = [];
  const far = [];
  for (const block of found) {
    // The same string twice — a heading repeated in a sticky bar, a label on
    // both halves of a split — is one string as far as a reader is concerned.
    if (seen.has(block.text)) continue;
    seen.add(block.text);
    (inView(block.node) ? near : far).push(block.text);
  }

  const lines = [];
  let used = 0;
  for (const text of [...near, ...far]) {
    if (used + text.length > limit) break;
    lines.push(text);
    used += text.length + 1;
  }
  // Under the limit and nothing was dropped: the model is seeing all of it.
  return lines.join('\n');
}
