/**
 * Dragging things from one page to the other.
 *
 * With two pages open side by side the obvious question is what happens if you
 * pick something up on the left and let go on the right, and the obvious answer
 * is the one the app gives: a document dropped on the other pane opens there, a
 * document dropped on a folder moves into it. Both work within a single pane
 * too — this is not a split-view feature that happens to work elsewhere, it is
 * how the library moves now.
 *
 * The payload is a private mime type carrying JSON. `text/plain` rides along
 * with it so a drag that leaves the window — into a note in another app, into
 * a mail message — arrives as the title rather than as nothing, and the private
 * type is what everything inside the app reads, so a drag out of Finder is
 * never mistaken for one of ours.
 */
import { api } from './api.js';
import { state, loadLibrary, rerender, toast, reportError, folderById } from './store.js';
import { navigate } from './router.js';

export const MIME = 'application/x-studex';

/**
 * Whether a drag is carrying something of ours.
 *
 * `getData` is deliberately blank until the drop — the page a drag passes over
 * is not allowed to read what it is carrying — so everything decided mid-drag
 * has to be decided from the type alone.
 */
export function carriesItem(event) {
  const types = event.dataTransfer?.types;
  return types ? [...types].includes(MIME) : false;
}

/** What was dropped, or null if it was not ours or arrived malformed. */
export function readItem(event) {
  const raw = event.dataTransfer?.getData(MIME);
  if (!raw) return null;
  try {
    const item = JSON.parse(raw);
    const valid = (it) => it && typeof it.id === 'string' && (it.kind === 'file' || it.kind === 'folder');
    if (!valid(item)) return null;
    // A drag of several carries them all; one that arrives malformed is one.
    if (Array.isArray(item.items)) {
      item.items = item.items.filter(valid);
      if (item.items.length < 2) delete item.items;
    }
    return item;
  } catch {
    return null;
  }
}

/** Where an item opens. */
export function routeFor(item) {
  return item.kind === 'folder' ? `folder/${item.id}` : `${item.fileKind ?? 'doc'}/${item.id}`;
}

/**
 * What is being dragged right now, if it started in this window.
 *
 * `getData` is blank until the drop, so a folder could not otherwise tell that
 * the drag passing over it is itself — or one of its own parents — and would
 * light up for a move the server was always going to refuse.
 */
let current = null;

/** A small pill under the pointer naming what is being carried. */
function dragImage(item) {
  const pill = document.createElement('div');
  pill.className = 'drag-pill';
  pill.textContent = item.title || 'Untitled';
  if (item.items?.length > 1) {
    const badge = document.createElement('span');
    badge.className = 'drag-count';
    badge.textContent = String(item.items.length);
    pill.appendChild(badge);
  }
  document.body.appendChild(pill);
  // The browser snapshots the node during dragstart; afterwards it can go.
  setTimeout(() => pill.remove(), 0);
  return pill;
}

/**
 * Makes a row, card or tile the handle for the thing it stands for.
 *
 * `group`, when given, is asked at the start of the drag for everything
 * selected alongside this item; picking up one of a selection carries all of it.
 */
export function dragItem(node, item, { group } = {}) {
  node.draggable = true;
  node.addEventListener('dragstart', (event) => {
    const data = event.dataTransfer;
    if (!data) return;
    const others = group?.() ?? [];
    const payload = others.length > 1 && others.some((o) => o.id === item.id)
      ? { ...item, items: others, title: `${others.length} items` }
      : item;
    current = payload;
    data.setData(MIME, JSON.stringify(payload));
    data.setData('text/plain', payload.items ? payload.items.map((o) => o.title ?? '').join('\n') : item.title ?? '');
    data.effectAllowed = 'copyMove';
    try { data.setDragImage(dragImage(payload), 14, 14); } catch { /* the default image is fine */ }
    node.classList.add('dragging');
  });
  node.addEventListener('dragend', () => { current = null; node.classList.remove('dragging'); });
  return node;
}

/**
 * A single line of notes, picked up by its handle.
 *
 * It travels under its own type so every file target — folders, panes, the
 * calendar — ignores it without having to be taught to, and only the places
 * where a line means something (a deck, a canvas) listen for it.
 */
export const BLOCK_MIME = 'application/x-studex-block';

export function dragBlock(node, payload) {
  node.draggable = true;
  node.addEventListener('dragstart', (event) => {
    const data = event.dataTransfer;
    const line = payload();
    if (!data || !line?.text) { event.preventDefault(); return; }
    event.stopPropagation();
    data.setData(BLOCK_MIME, JSON.stringify(line));
    data.setData('text/plain', line.text);
    data.effectAllowed = 'copy';
    try { data.setDragImage(dragImage({ title: line.text.slice(0, 60) }), 14, 14); } catch { /* default image */ }
  });
  return node;
}

export function carriesBlock(event) {
  const types = event.dataTransfer?.types;
  return types ? [...types].includes(BLOCK_MIME) : false;
}

/** `{text, front, back, fileId}` from a dropped line, or null. */
export function readBlock(event) {
  try {
    const line = JSON.parse(event.dataTransfer?.getData(BLOCK_MIME) || 'null');
    return line && typeof line.text === 'string' && line.text.trim() ? line : null;
  } catch {
    return null;
  }
}

/** Whether `folderId` is `ancestorId` or sits somewhere inside it. */
function within(folderId, ancestorId) {
  const seen = new Set();
  let cursor = folderId;
  while (cursor && !seen.has(cursor)) {
    if (cursor === ancestorId) return true;
    seen.add(cursor);
    cursor = folderById(cursor)?.parent_id ?? null;
  }
  return false;
}

/**
 * The shared half of every target: the highlight while a drag is over it and
 * the tidying up afterwards, so each caller is left with only what its own
 * drop means.
 *
 * `dragleave` fires at every element boundary inside the target, including the
 * ones its own children make, so it is checked against where the pointer
 * actually went rather than trusted on its own.
 */
function target(node, className, onDrop, accepts = () => true) {
  node.addEventListener('dragover', (event) => {
    if (!carriesItem(event)) return;
    if (current && !accepts(current)) return;
    event.preventDefault();
    // A folder inside a pane is the more specific answer, so it takes the drop
    // and the pane behind it neither lights up nor acts.
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    node.classList.add(className);
  });
  node.addEventListener('dragleave', (event) => {
    const to = event.relatedTarget;
    if (to instanceof Node && node.contains(to)) return;
    node.classList.remove(className);
  });
  node.addEventListener('drop', (event) => {
    if (!carriesItem(event)) return;
    event.preventDefault();
    event.stopPropagation();
    node.classList.remove(className);
    const item = readItem(event);
    if (item && accepts(item)) void onDrop(item);
  });
  return node;
}

/**
 * A folder that things can be dropped into.
 *
 * `folderId` of null is the root of the library, which is how the Library
 * crumb takes a file back out of a folder.
 */
export function dropInto(node, folderId) {
  const fits = (one) => !(one.kind === 'folder' && folderId && within(folderId, one.id));
  return target(node, 'drop-on',
    (item) => (item.items ? moveMany(item.items.filter(fits), folderId) : moveInto(item, folderId)),
    (item) => (item.items ? item.items.some(fits) : fits(item)));
}

/** Where a file or folder sits now, for Undo. */
const parentOf = (one) => (one.kind === 'folder'
  ? folderById(one.id)?.parent_id ?? null
  : state.files.find((f) => f.id === one.id)?.folder_id ?? null);

/** Several things into one folder: one request each, one reload, one Undo. */
export async function moveMany(items, folderId) {
  const name = folderId ? folderById(folderId)?.name ?? 'that folder' : 'Library';
  const moving = items.filter((one) => one.id !== folderId && parentOf(one) !== folderId);
  if (!moving.length) return;
  const from = new Map(moving.map((one) => [one.id, parentOf(one)]));
  const put = (one, to) => (one.kind === 'folder'
    ? api.updateFolder(one.id, { parentId: to })
    : api.updateFile(one.id, { folderId: to }));
  let moved = 0;
  let failure = null;
  for (const one of moving) {
    try { await put(one, folderId); moved += 1; } catch (err) { failure ??= err; }
  }
  try { await loadLibrary(); } catch { /* the moves stand; the next reload shows them */ }
  rerender();
  if (failure) reportError(failure);
  if (!moved) return;
  toast(`${moved} ${moved === 1 ? 'item' : 'items'} moved to ${name}.`, {
    action: {
      label: 'Undo',
      onSelect: async () => {
        for (const one of moving) {
          try { await put(one, from.get(one.id)); } catch (err) { reportError(err); }
        }
        await loadLibrary();
        rerender();
      },
    },
  });
}

/**
 * A pane: letting go here opens the thing here, beside whatever it came from.
 *
 * Which pane this is is read at the drop rather than closed over, because
 * closing the left pane renumbers the right one without rebuilding it.
 */
export function dropPane(node) {
  return target(node, 'drop-here', (item) => {
    navigate(routeFor(item), { pane: Number(node.dataset.pane ?? '0') });
  });
}

export async function moveInto(item, folderId) {
  const name = folderId ? folderById(folderId)?.name ?? 'that folder' : 'Library';
  if (item.kind === 'folder' && folderId && within(folderId, item.id)) return;
  // Dropping something where it already is is not a mistake worth a message.
  if (item.kind === 'folder') {
    if (item.id === folderId) return;
    if ((folderById(item.id)?.parent_id ?? null) === folderId) return;
  } else if ((state.files.find((f) => f.id === item.id)?.folder_id ?? null) === folderId) {
    return;
  }

  const from = item.kind === 'folder'
    ? folderById(item.id)?.parent_id ?? null
    : state.files.find((f) => f.id === item.id)?.folder_id ?? null;
  try {
    if (item.kind === 'folder') await api.updateFolder(item.id, { parentId: folderId });
    else await api.updateFile(item.id, { folderId });
    await loadLibrary();
    rerender();
    toast(`“${item.title}” moved to ${name}.`, {
      action: {
        label: 'Undo',
        onSelect: async () => {
          try {
            if (item.kind === 'folder') await api.updateFolder(item.id, { parentId: from });
            else await api.updateFile(item.id, { folderId: from });
            await loadLibrary();
            rerender();
          } catch (err) { reportError(err); }
        },
      },
    });
  } catch (err) {
    reportError(err);
  }
}
