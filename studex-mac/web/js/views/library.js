/** Screens 02 & 03 — Library, folders and colours. */
import { el, icon, mount, applyColor, colorValue, folderGlyph, colorLabel } from '../dom.js';
import { api } from '../api.js';
import { state, loadLibrary, folderById, childFolders, toast, reportError, loadTags, rerender } from '../store.js';
import { navigate, openBeside } from '../router.js';
import { topbar, openCreateMenu } from '../shell.js';
import { openMenu } from '../menu.js';
import { promptText, confirmDelete, promptColor } from '../dialog.js';
import { relative, plural, FILE_ICON, FILE_LABEL } from '../format.js';
import { openShareSheet } from '../share.js';
import { isNative, openWindow } from '../native.js';

const SORTS = [
  { id: 'recent', label: 'Recently edited' },
  { id: 'title', label: 'Name' },
];

import { openTagSheet } from '../tags.js';
import { dragItem, dropInto, moveMany } from '../dnd.js';

const COLOR_ROLES = ['accent', 'sky', 'teal', 'lime', 'amber', 'rose', 'neutral'];

/** View mode and sort are UI-local, so they live in the tab, not the account. */
const prefs = { view: 'grid', sort: 'recent', tag: null };

/**
 * What is selected, for ⌘-click and ⇧-click. It belongs to one folder: going
 * somewhere else starts again, the way Finder does.
 */
const selection = { folderId: undefined, items: new Map(), anchor: null };
const descriptor = (thing) => (thing.kind === 'folder'
  ? { kind: 'folder', id: thing.id, title: thing.name }
  : { kind: 'file', id: thing.id, title: thing.title, fileKind: thing.kind });

export async function libraryView(route, host) {
  return renderLibrary(host, { folderId: null });
}

export async function folderView(route, host) {
  return renderLibrary(host, { folderId: route.path[1] ?? null });
}

/**
 * A screenful, then another when the list is scrolled to the bottom of it.
 *
 * The first page is small enough to appear at once; the ones after it are
 * larger, because by then the reader is scrolling and a round trip per sixty
 * files would be felt as stutter.
 */
const FIRST_PAGE = 60;
const NEXT_PAGE = 120;

async function renderLibrary(host, { folderId }) {
  const query = { folderId: folderId ?? undefined, sort: prefs.sort };
  if (!state.tagsLoaded) { await loadTags({ quiet: true }); state.tagsLoaded = true; }
  // A tag that has since been deleted is no longer a filter.
  const tag = prefs.tag ? state.tags.find((t) => t.id === prefs.tag) ?? null : null;
  if (!tag) prefs.tag = null;
  const [first] = await Promise.all([
    tag
      // Filtering by tag reads from the library already in memory: every tagged
      // file in this folder (or anywhere, at the top of the Library).
      ? Promise.resolve((() => {
          const hit = state.files.filter((f) => state.tagsByItem.get(f.id)?.includes(tag.id) && (!folderId || f.folder_id === folderId));
          if (prefs.sort === 'title') hit.sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''));
          return { files: hit, total: hit.length };
        })())
      : api.files({ ...query, limit: FIRST_PAGE, offset: 0 }),
  ]);

  /**
   * The library is read a page at a time, as it is scrolled.
   *
   * It used to be read whole: `api.allFiles` walked the list endpoint in
   * two-hundreds until it ran out, on every navigation into the library and
   * every change of sort or view. A student with a few thousand files paid for
   * a dozen round trips and held every row in memory to look at the first
   * screenful of them. `total` comes back with the first page, so the list
   * knows when it has reached the end without reading every row.
   */
  let files = first.files;
  const total = first.total ?? files.length;
  let fetching = false;
  let exhausted = files.length >= total;

  async function more() {
    if (fetching || exhausted) return;
    fetching = true;
    try {
      const page = await api.files({ ...query, limit: NEXT_PAGE, offset: files.length });
      files = files.concat(page.files);
      // A short page means the end, whatever the total said — a file trashed
      // in another window while this list was open would otherwise leave the
      // loop asking for a page that is never coming.
      if (page.files.length < NEXT_PAGE || files.length >= (page.total ?? total)) exhausted = true;
    } catch (err) {
      // Stop asking rather than spin: the rows already drawn stay usable.
      exhausted = true;
      reportError(err);
    } finally {
      fetching = false;
    }
  }

  const folder = folderId ? folderById(folderId) : null;
  const subfolders = childFolders(folderId)
    .filter((sub) => !tag || state.tagsByItem.get(sub.id)?.includes(tag.id));

  const refresh = async () => { await loadLibrary(); renderLibrary(host, { folderId }); };

  if (selection.folderId !== folderId) {
    selection.folderId = folderId;
    selection.items.clear();
    selection.anchor = null;
  }
  /** Every card in the order it is drawn, so ⇧-click can take a run of them. */
  const order = [];
  const nodes = new Map();
  const selectBar = el('div', { class: 'select-bar', hidden: true });
  const paint = () => {
    for (const [id, node] of nodes) node.classList.toggle('selected', selection.items.has(id));
    drawSelectBar(selectBar, paint);
  };
  /** Handles a click on a card; true when it was a selecting click. */
  const pick = (event, thing) => {
    const item = descriptor(thing);
    if (event.shiftKey && selection.anchor) {
      const a = order.findIndex((o) => o.id === selection.anchor);
      const b = order.findIndex((o) => o.id === item.id);
      if (a !== -1 && b !== -1) {
        for (const o of order.slice(Math.min(a, b), Math.max(a, b) + 1)) selection.items.set(o.id, o);
        paint();
        return true;
      }
    }
    if (event.metaKey || event.ctrlKey || event.shiftKey) {
      if (selection.items.has(item.id)) selection.items.delete(item.id);
      else selection.items.set(item.id, item);
      selection.anchor = item.id;
      paint();
      return true;
    }
    if (selection.items.size) { selection.items.clear(); selection.anchor = null; paint(); }
    return false;
  };
  const group = () => [...selection.items.values()];
  const ctx = { pick, group, register: (thing, node) => { const d = descriptor(thing); order.push(d); nodes.set(d.id, node); } };

  const crumbs = folder ? breadcrumb(folder) : ['Library'];

  /**
   * The files are drawn a screenful at a time, in step with the pages they
   * arrive in.
   *
   * Every file used to be built up front. That was invisible while the list
   * was capped at two hundred; two thousand files meant two thousand cards —
   * about thirteen thousand nodes — built in one go before anything appeared,
   * and the window did not respond while it happened. What is off the bottom
   * of the screen can wait until it is scrolled to.
   *
   * Driven by scroll rather than IntersectionObserver, for the same reason the
   * PDF reader is: an observer callback is delivered on the rendering
   * lifecycle, so a view the platform has decided not to paint never receives
   * one, and the list would stay at its first screenful for ever.
   */
  const grid = el('div', { class: prefs.view === 'grid' ? 'file-grid' : 'rows' });
  const makeCard = prefs.view === 'grid'
    ? (file) => libraryCard(file, refresh, ctx)
    : (file) => fileRow(file, refresh, ctx);
  // The invitation to make something new belongs at the end of the list, so it
  // is placed once and everything else is inserted in front of it.
  const tail = prefs.view === 'grid' ? newFileTile() : newFileRow();
  grid.appendChild(tail);

  let drawn = 0;
  function fill() {
    if (drawn >= files.length) return;
    const upto = Math.min(files.length, drawn + (drawn === 0 ? FIRST_PAGE : NEXT_PAGE));
    // One insertion rather than one per card: a fragment costs a single
    // layout instead of a hundred.
    const batch = document.createDocumentFragment();
    for (let i = drawn; i < upto; i += 1) batch.appendChild(makeCard(files[i]));
    grid.insertBefore(batch, tail);
    drawn = upto;
    paint();
  }

  const body = el('div', { class: 'content' },
    selectBar,
    subfolders.length
      ? el('div', { class: 'col' },
          el('span', { class: 'section-label plain', text: 'FOLDERS' }),
          el('div', { class: 'file-grid' }, subfolders.map((sub) => folderCard(sub, refresh, ctx))),
        )
      : null,

    el('div', { class: 'col' },
      subfolders.length ? el('span', { class: 'section-label plain', text: 'FILES' }) : null,
      grid,
      files.length === 0 && prefs.view === 'list'
        ? el('div', { class: 'empty-state' }, icon('folder-open'), tag ? `Nothing here is tagged #${tag.name}.` : 'This folder is empty.')
        : null,
    ),
  );

  fill();
  /** Keeps going while the bottom of the list is in view — fetching the next
      page when the drawn rows have caught up with the ones in hand. The first
      page may not even fill a tall window, and a list that stopped there would
      look like a library with sixty files in it. */
  const topUp = async () => {
    if (fetching) return;
    if (drawn >= files.length && exhausted) return;
    // A view that has been replaced keeps its detached nodes alive; every
    // measurement below reads zero, so without this it would page to the end.
    if (!body.isConnected) return;
    if (body.scrollHeight - body.scrollTop - body.clientHeight > 600) return;
    if (drawn >= files.length) await more();
    if (!body.isConnected) return;
    fill();
    // Called again on the next tick rather than looping here, so a very tall
    // window fills over a few frames instead of blocking on all of them.
    setTimeout(topUp, 0);
  };
  body.addEventListener('scroll', topUp, { passive: true });
  // Esc lets go of a selection, and a click on the empty space around the cards.
  body.tabIndex = -1;
  body.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && selection.items.size) { selection.items.clear(); paint(); }
    if (event.key === 'a' && (event.metaKey || event.ctrlKey) && !event.target.closest?.('input, textarea, [contenteditable]')) {
      event.preventDefault();
      for (const o of order) selection.items.set(o.id, o);
      paint();
    }
  });
  body.addEventListener('click', (event) => {
    if (event.target === body || event.target.classList?.contains('file-grid') || event.target.classList?.contains('col')) {
      if (selection.items.size) { selection.items.clear(); paint(); }
    }
  });
  // The listener dies with the node when this view is replaced, so there is
  // nothing to unsubscribe.
  setTimeout(topUp, 0);

  mount(host,
    topbar(crumbs,
      el('button', { class: 'chip', onclick: (e) => openSortMenu(e.currentTarget, host, folderId) },
        SORTS.find((s) => s.id === prefs.sort).label, icon('caret-down')),
      state.tags.length
        ? el('button', {
            class: 'chip' + (tag ? ' on' : ''),
            title: 'Show only files with a tag',
            onclick: (e) => openTagFilter(e.currentTarget, host, folderId),
          },
            tag
              ? el('span', { class: 'tag-dot', style: { background: tag.color ? colorValue(tag.color) : 'var(--color-accent)' } })
              : icon('tag'),
            tag ? `#${tag.name}` : 'Tag',
            icon('caret-down'))
        : null,
      el('div', { class: 'seg' },
        el('button', { class: prefs.view === 'grid' ? 'on' : '', text: 'Grid', onclick: () => { prefs.view = 'grid'; renderLibrary(host, { folderId }); } }),
        el('button', { class: prefs.view === 'list' ? 'on' : '', text: 'List', onclick: () => { prefs.view = 'list'; renderLibrary(host, { folderId }); } }),
      ),
      folder ? el('button', { class: 'chip', onclick: () => navigate(`test/folder/${folder.id}`) }, icon('exam'), 'Test this folder') : null,
    ),
    body,
  );
}

function breadcrumb(folder) {
  const chain = [];
  let cursor = folder;
  const seen = new Set();
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    chain.unshift({ label: cursor.name, to: `folder/${cursor.id}`, icon: 'folder', color: cursor.effective_color });
    cursor = cursor.parent_id ? folderById(cursor.parent_id) : null;
  }
  return [{ label: 'Library', to: 'library' }, ...chain];
}

function libraryCard(file, refresh, ctx) {
  const meta = file.kind === 'deck'
    ? `${plural(file.card_count, 'card')}${file.due_count ? ` · ${file.due_count} due` : ''}`
    : file.kind === 'pdf' && file.annotation_count
      ? `PDF · ${plural(file.annotation_count, 'note')}`
      : `${FILE_LABEL[file.kind]} · ${relative(file.updated_at)}`;

  const node = el('button', {
    class: 'file-card',
    style: { height: '150px', padding: '14px' },
    onclick: (event) => { if (!ctx?.pick(event, file)) navigate(`${file.kind}/${file.id}`); },
    oncontextmenu: (event) => { event.preventDefault(); fileMenu(file, event.clientX, event.clientY, refresh); },
  },
    el('div', { style: { display: 'flex', alignItems: 'center', width: '100%' } },
      icon(FILE_ICON[file.kind] ?? 'file', { size: 19 }),
      file.pinned ? icon('push-pin', { class: 'dim grow', size: 12 }) : null,
    ),
    el('div', { class: 'name', text: file.title }),
    el('div', { class: 'meta', text: meta }),
  );
  dragItem(node, { kind: 'file', id: file.id, title: file.title, fileKind: file.kind }, { group: ctx?.group });
  ctx?.register(file, node);
  return applyColor(node, file.effective_color);
}

function folderCard(folder, refresh, ctx) {
  const node = el('button', {
    class: 'file-card',
    style: { height: '150px', padding: '14px' },
    onclick: (event) => { if (!ctx?.pick(event, folder)) navigate(`folder/${folder.id}`); },
    oncontextmenu: (event) => { event.preventDefault(); folderMenu(folder, event.clientX, event.clientY, refresh); },
  },
    folderGlyph(folder.effective_color, { size: 22 }),
    el('div', { class: 'name', text: folder.name }),
    el('div', { class: 'meta', text: plural(folder.file_count, 'file') }),
  );
  // A folder is both: something you can pick up and somewhere to put things.
  dragItem(node, { kind: 'folder', id: folder.id, title: folder.name }, { group: ctx?.group });
  ctx?.register(folder, node);
  dropInto(node, folder.id);
  return applyColor(node, folder.effective_color);
}

function newFileTile() {
  return el('button', {
    class: 'file-card',
    style: {
      height: '150px', border: '1px dashed var(--color-neutral-800)', borderTop: '1px dashed var(--color-neutral-800)',
      background: 'none', alignItems: 'center', justifyContent: 'center', gap: '8px', color: 'var(--color-neutral-700)',
    },
    onclick: (event) => openCreateMenu(event.currentTarget),
  },
    icon('plus', { size: 20 }),
    el('span', { style: { fontSize: '11.5px' }, text: 'New file' }),
  );
}

/**
 * The list's own way in to Create. The grid had a dashed tile at the end and
 * the list had nothing, so switching to rows quietly took away the ability to
 * add a note or a PDF where you were standing.
 */
function newFileRow() {
  return el('button', {
    class: 'row new',
    onclick: (event) => openCreateMenu(event.currentTarget),
  },
    icon('plus', { size: 15 }),
    el('span', { class: 'grow', text: 'New file' }),
    el('span', { class: 'dim', style: { fontSize: '11.5px' }, text: 'Note, canvas, deck or PDF' }),
  );
}

function fileRow(file, refresh, ctx) {
  const node = el('button', {
    class: 'row',
    onclick: (event) => { if (!ctx?.pick(event, file)) navigate(`${file.kind}/${file.id}`); },
    oncontextmenu: (event) => { event.preventDefault(); fileMenu(file, event.clientX, event.clientY, refresh); },
  },
    icon(FILE_ICON[file.kind] ?? 'file', { size: 15 }),
    el('span', { class: 'grow', text: file.title }),
    el('span', { class: 'dim', style: { fontSize: '11.5px' }, text: FILE_LABEL[file.kind] }),
    el('span', { class: 'dim', style: { fontSize: '11.5px', width: '90px', textAlign: 'right' }, text: relative(file.updated_at) }),
  );
  dragItem(node, { kind: 'file', id: file.id, title: file.title, fileKind: file.kind }, { group: ctx?.group });
  ctx?.register(file, node);
  return applyColor(node, file.effective_color);
}

/* ── several at once ──────────────────────────────────────────────────── */

function drawSelectBar(bar, repaint) {
  const items = [...selection.items.values()];
  bar.hidden = items.length === 0;
  if (!items.length) { bar.replaceChildren(); return; }
  const files = items.filter((i) => i.kind === 'file');
  const clear = () => { selection.items.clear(); selection.anchor = null; repaint(); };
  bar.replaceChildren(
    el('span', { class: 'select-count', text: String(items.length) }),
    el('span', { class: 'grow', text: `${items.length === 1 ? 'item' : 'items'} selected · drag any of them to move all` }),
    el('button', { class: 'chip', type: 'button', onclick: (e) => openMoveMenu(e.currentTarget, items, clear) }, icon('folder-simple-dashed'), 'Move to…'),
    state.tags.length
      ? el('button', { class: 'chip', type: 'button', onclick: (e) => openBulkTag(e.currentTarget, items, clear) }, icon('hash'), 'Tag…')
      : null,
    files.length
      ? el('button', { class: 'chip danger', type: 'button', onclick: () => trashMany(files) }, icon('trash'), files.length === items.length ? 'Trash' : `Trash ${plural(files.length, 'file')}`)
      : null,
    el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Clear selection', onclick: clear }, icon('x', { size: 14 })),
  );
}

function openMoveMenu(anchor, items, done) {
  const rect = anchor.getBoundingClientRect();
  const path = (folder) => {
    const names = [];
    const seen = new Set();
    for (let f = folder; f && !seen.has(f.id); f = folderById(f.parent_id)) { seen.add(f.id); names.unshift(f.name); }
    return names.join(' / ');
  };
  const choices = [...state.folders].map((f) => ({ f, label: path(f) })).sort((a, b) => a.label.localeCompare(b.label));
  openMenu({ x: rect.left, y: rect.bottom + 6 }, [
    { head: 'MOVE TO' },
    { icon: 'books', label: 'Library', onSelect: async () => { await moveMany(items, null); done(); } },
    ...choices.map(({ f, label }) => ({
      icon: 'folder', label: label.length > 48 ? `…${label.slice(-47)}` : label,
      onSelect: async () => { await moveMany(items, f.id); done(); },
    })),
  ]);
}

function openBulkTag(anchor, items, done) {
  const rect = anchor.getBoundingClientRect();
  openMenu({ x: rect.left, y: rect.bottom + 6 }, [
    { head: 'ADD TAG' },
    ...state.tags.map((tag) => ({
      icon: 'hash', label: tag.name,
      onSelect: async () => {
        let added = 0;
        for (const item of items) {
          if (state.tagsByItem.get(item.id)?.includes(tag.id)) continue;
          try { await api.attachTag({ tagId: tag.id, itemType: item.kind, itemId: item.id }); added += 1; }
          catch (err) { reportError(err); break; }
        }
        await loadTags({ quiet: true });
        toast(added ? `Tagged ${plural(added, 'item')} #${tag.name}.` : `Everything there already has #${tag.name}.`);
        done();
      },
    })),
  ]);
}

async function trashMany(files) {
  const gone = [];
  for (const file of files) {
    try { await api.trashFile(file.id); gone.push(file); } catch (err) { reportError(err); break; }
  }
  if (!gone.length) return;
  selection.items.clear();
  await loadLibrary();
  rerender();
  toast(`${plural(gone.length, 'file')} moved to the Trash.`, {
    action: {
      label: 'Undo',
      onSelect: async () => {
        for (const file of gone) { try { await api.restoreFile(file.id); } catch (err) { reportError(err); } }
        await loadLibrary();
        rerender();
        toast(gone.length === 1 ? `“${gone[0].title}” is back.` : `${plural(gone.length, 'file')} are back.`);
      },
    },
  });
}

/* ── context menus ────────────────────────────────────────────────────── */

export function fileMenu(file, x, y, refresh) {
  openMenu({ x, y }, fileMenuItems(file, refresh));
}

/** The file menu as rows, so a page's own ⋯ menu can carry the same ones. */
export function fileMenuItems(file, refresh) {
  return [
    { head: file.title.toUpperCase().slice(0, 32) },
    // Most used first: what a file is called and where it sits, then where
    // it opens, then how it looks, with the one that removes it kept last.
    {
      icon: 'pencil-simple', label: 'Rename', onSelect: async () => {
        const title = await promptText({ title: 'Rename file', label: 'Title', value: file.title, confirmLabel: 'Rename', fallback: 'Untitled' });
        if (!title) return;
        try { await api.updateFile(file.id, { title }); await refresh(); } catch (err) { reportError(err); }
      },
    },
    {
      icon: file.pinned ? 'push-pin-slash' : 'push-pin',
      label: file.pinned ? 'Unpin' : 'Pin',
      onSelect: async () => {
        try { await api.updateFile(file.id, { pinned: !file.pinned }); await refresh(); } catch (err) { reportError(err); }
      },
    },
    {
      icon: 'share-network', label: 'Share…', onSelect: () => openShareSheet({ type: 'file', id: file.id, title: file.title }),
    },
    {
      icon: 'hash', label: 'Tags…',
      onSelect: () => void openTagSheet({ itemType: 'file', itemId: file.id, title: file.title }, refresh),
    },
    { sep: true },
    // Only in the app: a browser tab cannot be asked for a second window with
    // the menu bar and the bridge in it, and a plain one would be worse than
    // none. Revising usually means two things side by side — the notes and the
    // cards made from them — which is the whole reason windows came back.
    ...(isNative ? [{
      icon: 'copy', label: 'Open in New Window',
      onSelect: () => openWindow(`${file.kind}/${file.id}`),
    }] : []),
    // The same intention without a second window: beside what is already open,
    // in this one.
    {
      icon: 'square-split-horizontal', label: 'Open Beside',
      onSelect: () => openBeside(`${file.kind}/${file.id}`),
    },
    { sep: true },
    {
      swatches: COLOR_ROLES.map((role) => ({
        color: colorValue(role),
        label: colorLabel(role),
        on: file.color_override === role,
        onSelect: async () => {
          try { await api.updateFile(file.id, { colorOverride: role }); await refresh(); }
          catch (err) { reportError(err); }
        },
      })),
    },
    {
      icon: 'eyedropper', label: 'Custom colour…', onSelect: async () => {
        const color = await promptColor({ title: `Colour for ${file.title}`, value: file.color_override });
        if (!color) return;
        try { await api.updateFile(file.id, { colorOverride: color }); await refresh(); }
        catch (err) { reportError(err); }
      },
    },
    {
      icon: 'paint-brush-household', label: 'Use folder colour', onSelect: async () => {
        try { await api.updateFile(file.id, { colorOverride: null }); await refresh(); }
        catch (err) { reportError(err); }
      },
    },
    { sep: true },
    {
      icon: 'trash', label: 'Move to trash', danger: true, onSelect: async () => {
        // No confirmation: the trash is itself the safety net, and Undo is one
        // click away for eight seconds — then the Trash for thirty days.
        try {
          await api.trashFile(file.id);
          await refresh();
          toast(`“${file.title}” moved to the Trash.`, {
            action: {
              label: 'Undo',
              onSelect: async () => {
                try { await api.restoreFile(file.id); await refresh(); toast(`“${file.title}” is back.`); }
                catch (err) { reportError(err); }
              },
            },
          });
        } catch (err) { reportError(err); }
      },
    },
  ];
}

export function folderMenu(folder, x, y, refresh) {
  openMenu({ x, y }, [
    { head: folder.name.toUpperCase().slice(0, 32) },
    {
      icon: 'pencil-simple', label: 'Rename', onSelect: async () => {
        const name = await promptText({ title: 'Rename folder', label: 'Name', value: folder.name, confirmLabel: 'Rename', fallback: 'Untitled' });
        if (!name) return;
        try { await api.updateFolder(folder.id, { name }); await refresh(); } catch (err) { reportError(err); }
      },
    },
    { icon: 'exam', label: 'Test this folder', onSelect: () => navigate(`test/folder/${folder.id}`) },
    {
      icon: 'share-network', label: 'Share…', onSelect: () => openShareSheet({ type: 'folder', id: folder.id, title: folder.name }),
    },
    {
      icon: 'hash', label: 'Tags…',
      onSelect: () => void openTagSheet({ itemType: 'folder', itemId: folder.id, title: folder.name }, refresh),
    },
    {
      icon: 'square-split-horizontal', label: 'Open Beside',
      onSelect: () => openBeside(`folder/${folder.id}`),
    },
    { sep: true },
    {
      swatches: COLOR_ROLES.map((role) => ({
        color: colorValue(role),
        label: colorLabel(role),
        on: folder.color === role,
        onSelect: async () => {
          try { await api.updateFolder(folder.id, { color: role }); await refresh(); }
          catch (err) { reportError(err); }
        },
      })),
    },
    {
      icon: 'eyedropper', label: 'Custom colour…', onSelect: async () => {
        const color = await promptColor({ title: `Colour for ${folder.name}`, value: folder.color });
        if (!color) return;
        try { await api.updateFolder(folder.id, { color }); await refresh(); }
        catch (err) { reportError(err); }
      },
    },
    { sep: true },
    {
      icon: 'trash', label: 'Delete folder', danger: true, onSelect: async () => {
        const ok = await confirmDelete(`“${folder.name}” and everything in it. This cannot be undone.`);
        if (!ok) return;
        try { await api.deleteFolder(folder.id); await refresh(); navigate('library'); }
        catch (err) { reportError(err); }
      },
    },
  ]);
}

function openTagFilter(anchor, host, folderId) {
  const rect = anchor.getBoundingClientRect();
  openMenu({ x: rect.left, y: rect.bottom + 6 }, [
    { icon: prefs.tag ? 'dot-outline' : 'check', label: 'All files', onSelect: () => { prefs.tag = null; renderLibrary(host, { folderId }); } },
    { sep: true },
    ...state.tags.map((tag) => ({
      icon: prefs.tag === tag.id ? 'check' : 'hash',
      label: `${tag.name} (${tag.count})`,
      onSelect: () => { prefs.tag = tag.id; renderLibrary(host, { folderId }); },
    })),
  ]);
}

function openSortMenu(anchor, host, folderId) {
  const rect = anchor.getBoundingClientRect();
  openMenu({ x: rect.left, y: rect.bottom + 6 }, SORTS.map((sort) => ({
    icon: prefs.sort === sort.id ? 'check' : 'dot-outline',
    label: sort.label,
    onSelect: () => { prefs.sort = sort.id; renderLibrary(host, { folderId }); },
  })));
}
