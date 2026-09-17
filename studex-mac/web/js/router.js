/**
 * Hash routing. Routes are "section/id/sub", e.g. "doc/<uuid>" or "settings/account".
 *
 * A window can hold two of them at once, written into the same hash with a
 * pipe between: `#/doc/<uuid>|flashcards/<uuid>`. One address rather than two
 * pieces of hidden state, because the address is what the app is restored
 * from — a reopened window, a Spotlight result, a `studex://` link — and a
 * split that lived anywhere else would not survive any of them.
 *
 * `currentRoute()` still answers with a single route, the one in the focused
 * pane, so every screen written before the split existed keeps working: a view
 * reads its own id out of the route it was handed and never asks where it is.
 */
import { el } from './dom.js';
import { dialog } from './dialog.js';

const listeners = new Set();

/** Which pane a plain `navigate()` moves. Reset whenever the split closes. */
let focused = 0;

/**
 * The hash, decoded. A malformed escape — a hand-typed link, a truncated
 * share URL, a tag with a literal "%" — makes decodeURIComponent throw, and
 * this runs on every navigation, so one bad link would otherwise leave the
 * whole window unable to route anywhere. Undecodable text is used as it is.
 */
function decodeHash(hash) {
  try { return decodeURIComponent(hash); } catch { return hash; }
}

function parse(hash) {
  return { hash, path: hash.split('/').filter(Boolean) };
}

/** Every route in the window, left to right — one entry, or two. */
export function currentPanes() {
  const raw = decodeHash(location.hash.replace(/^#\/?/, ''));
  const parts = raw.split('|').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return [parse('home')];
  return parts.slice(0, 2).map(parse);
}

export function isSplit() {
  return currentPanes().length > 1;
}

/** The pane a plain `navigate()` acts on, clamped to what is actually open. */
export function focusedPane() {
  return Math.min(focused, currentPanes().length - 1);
}

export function focusPane(index) {
  const next = Math.min(Math.max(0, index), currentPanes().length - 1);
  if (next === focused) return;
  focused = next;
  emit();
}

/**
 * Whether a page's own keyboard shortcuts should answer. With the window split,
 * both pages are listening on the same document, and a Space meant for the deck
 * on the left must not also turn a card on the right.
 */
export function paneIsActive(host) {
  if (!isSplit()) return true;
  const pane = host?.closest?.('.pane');
  if (!pane) return true;
  return Number(pane.dataset.pane ?? '0') === focusedPane();
}

export function currentRoute() {
  const panes = currentPanes();
  return panes[focusedPane()] ?? panes[0];
}

/** The route in one particular pane, whether or not it is the focused one. */
export function routeAt(index) {
  return currentPanes()[index] ?? null;
}

function clean(to) {
  return String(to).replace(/^#?\/+/, '').replace(/\|/g, '');
}

/**
 * Pages that are a whole window's worth on their own — the dashboards. Half a
 * calendar or half a home page is a worse version of both, so opening one of
 * these while split closes the split and gives it the window.
 */
export function canSplit(to) {
  const path = clean(to).split('/').filter(Boolean);
  const head = path[0] ?? 'home';
  if (['home', 'review', 'test', 'mock', 'topics', 'calendar', 'stats'].includes(head)) return false;
  return !(head === 'flashcards' && !path[1]);
}

/** Same page in both panes: refused, since two editors on one file fight. */
function samePage(parts) {
  if (parts.length < 2) return false;
  const key = (p) => clean(p).split('/').filter(Boolean).slice(0, 2).join('/');
  return key(parts[0]) === key(parts[1]) && key(parts[0]) !== 'beside';
}

function alreadyOpen() {
  dialog({
    title: 'Error: page already open',
    body: el('p', { text: 'That page is already open in the other pane. Please select a different file.' }),
    confirmLabel: 'OK',
    cancelLabel: null,
  });
}

function write(parts, replace) {
  if (samePage(parts)) { alreadyOpen(); return; }
  if (parts.length > 1 && !parts.every(canSplit)) {
    const keep = canSplit(parts[focused] ?? '') ? parts.find((p) => !canSplit(p)) : parts[focused];
    parts = [keep];
    focused = 0;
    pinned = false;
  }
  const target = '#/' + parts.join('|');
  if (location.hash === target) { emit(); return; }
  if (replace) { history.replaceState(null, '', target); emit(); }
  else location.hash = target;
}

/**
 * Puts a whole window back — both panes, if it had two. A saved window route
 * is the full `a|b` string, which `navigate` would otherwise fold into one.
 */
export function restoreWindow(raw) {
  const parts = String(raw ?? '').replace(/^#?\/+/, '').split('|').map((s) => s.trim()).filter(Boolean).slice(0, 2);
  if (!parts.length) { navigate('home'); return; }
  focused = 0;
  write(samePage(parts) ? parts.slice(0, 1) : parts, false);
}

/** Every pane's route as one string, the way a window is remembered. */
export function windowRoute() {
  return currentPanes().map((r) => r.hash).join('|');
}

/**
 * A pinned right-hand pane stays put for the evening: a timetable or a mark
 * scheme kept up while everything else changes on the left. Navigation from
 * outside it lands on the left, and Open Beside replaces the left instead.
 */
let pinned = false;
export function isPinned() { return pinned && isSplit(); }
export function setPinned(on) { pinned = Boolean(on); emit(); }

function fromInsidePinned() {
  const origin = window.event?.target;
  return origin instanceof Element && Boolean(origin.closest('.pane[data-pane="1"]'));
}

export function navigate(to, { replace = false, pane = null } = {}) {
  let index = pane === null ? focusedPane() : pane;
  if (pane === null && index === 1 && isPinned() && !fromInsidePinned()) index = 0;
  const parts = currentPanes().map((r) => r.hash);
  // Asking for a pane that is not open yet is asking for the split.
  if (index >= parts.length) { openBeside(to, { replace }); return; }
  parts[index] = clean(to);
  focused = index;
  write(parts, replace);
}

/**
 * Put a route beside the one already open, and move the focus onto it.
 *
 * Beside rather than instead: the second pane is always the new thing, so the
 * page you were reading stays where your eyes left it. Splitting twice
 * replaces the second pane rather than opening a third — two is what a laptop
 * screen holds, and a third pane is three narrow columns of nothing.
 */
export function openBeside(to, { replace = false } = {}) {
  const parts = currentPanes().map((r) => r.hash);
  if (isPinned()) {
    parts[0] = clean(to);
    focused = 0;
  } else {
    parts[1] = clean(to);
    focused = 1;
  }
  write(parts.slice(0, 2), replace);
}

/** Close one pane; whatever is left becomes the whole window. */
export function closePane(index, { replace = false } = {}) {
  const parts = currentPanes().map((r) => r.hash);
  if (parts.length < 2) return;
  parts.splice(index, 1);
  focused = 0;
  pinned = false;
  write(parts, replace);
}

/** Left becomes right and right becomes left, focus following the content. */
export function swapPanes() {
  const parts = currentPanes().map((r) => r.hash);
  if (parts.length < 2) return;
  focused = focused === 0 ? 1 : 0;
  pinned = false;
  write([parts[1], parts[0]], false);
}

export function onRoute(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) fn(currentRoute());
}

window.addEventListener('hashchange', emit);
