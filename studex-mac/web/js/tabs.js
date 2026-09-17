/**
 * The tab strip for the workspace-tabs shell.
 *
 * That layout trades the sidebar for a row of open files, so the strip is the
 * only navigation it has: everything you have opened, in the order you chose,
 * with one of them current. Three things decide whether it is usable —
 *
 *  - it must never spill. Tabs give up width together until they reach a floor
 *    and only then does the row scroll, so nine open files look like nine tabs
 *    rather than four tabs and a cliff;
 *  - the current one must be obvious at a glance, which takes more than a
 *    slightly brighter label;
 *  - dragging one somewhere else must look like moving a tab, not like the row
 *    being rebuilt underneath the pointer.
 */
import { el, icon, mount, applyColor } from './dom.js';
import { state, fileById } from './store.js';
import { navigate, currentRoute } from './router.js';
import { FILE_ICON } from './format.js';
import { openPalette } from './palette.js';

/* With no sidebar the strip is the only way anywhere, so the sections sit at
   its start and search at its end. */
const NAV = [
  { to: 'home', label: 'Home', icon: 'house', match: ['home'] },
  { to: 'library', label: 'Library', icon: 'folders', match: ['library', 'folder', 'tag'] },
  { to: 'study', label: 'Study', icon: 'graduation-cap', match: ['study', 'review', 'flashcards', 'test'] },
  { to: 'calendar', label: 'Calendar', icon: 'calendar-blank', match: ['calendar'] },
  { to: 'timetable', label: 'Timetable', icon: 'clock-countdown', match: ['timetable'] },
  { to: 'topics', label: 'Topics', icon: 'target', match: ['topics'] },
];
const TABS_KEY = 'studex.tabs';

/** Open tabs survive a reload; the library decides later which still exist. */
export function restoreTabs() {
  try {
    const saved = JSON.parse(localStorage.getItem(TABS_KEY) ?? 'null');
    if (Array.isArray(saved?.tabs) && state.openTabs.length === 0) {
      state.openTabs = saved.tabs.filter((tab) => tab && FILE_ROUTES.has(tab.kind) && tab.id).slice(0, 24);
    }
  } catch { /* nothing saved */ }
}

function saveTabs() {
  try { localStorage.setItem(TABS_KEY, JSON.stringify({ tabs: state.openTabs })); } catch { /* private mode */ }
}

/** Routes that name a file, which are the ones worth keeping a tab for. */
const FILE_ROUTES = new Set(['doc', 'canvas', 'pdf', 'deck']);
let restored = false;

/**
 * Records the current route as a tab. A file already open is promoted to
 * current rather than opened twice — the same file in two tabs is a bug in
 * every editor that has ever allowed it.
 */
export function trackTab(route) {
  if (!restored) { restored = true; restoreTabs(); }
  const [kind, id] = route.path;
  if (!FILE_ROUTES.has(kind) || !id) return;
  if (!state.openTabs.some((tab) => tab.id === id)) {
    state.openTabs.push({ kind, id });
    // A strip that grows without limit is a strip nobody can read.
    if (state.openTabs.length > 24) state.openTabs.shift();
  }
  state.activeTab = id;
  saveTabs();
}

function closeTab(id) {
  const at = state.openTabs.findIndex((tab) => tab.id === id);
  if (at < 0) return;
  state.openTabs.splice(at, 1);
  saveTabs();
  if (state.activeTab !== id) { renderTabs(); return; }

  // Closing what you are looking at hands you the neighbour, preferring the
  // one on the left the way a browser does.
  const next = state.openTabs[at - 1] ?? state.openTabs[at] ?? null;
  state.activeTab = next?.id ?? null;
  if (next) navigate(`${next.kind}/${next.id}`);
  else navigate('library');
}

let strip = null;

/** Mounts, or re-mounts, the strip into its host. */
export function renderTabs(host) {
  if (host) strip = host;
  if (!strip) return;

  const route = currentRoute();
  // A tab whose file is not in the library is skipped, not forgotten. The
  // library reloads constantly — after a save, a rename, a create — and a tab
  // dropped because a reload happened to be in flight would never come back.
  // Only closing a tab, or deleting the file through the menu, removes one.
  const drawable = state.openTabs.filter((tab) => fileById(tab.id));

  const head = route.path[0] ?? 'home';
  mount(strip,
    el('nav', { class: 'tabs-nav', 'aria-label': 'Sections' }, NAV.map((item) => el('button', {
      class: 'tabs-nav-btn' + (item.match.includes(head) ? ' on' : ''),
      title: item.label, 'aria-label': item.label,
      'aria-current': item.match.includes(head) ? 'page' : null,
      onclick: () => navigate(item.to),
    }, icon(item.icon, { size: 15 })))),
    el('span', { class: 'tabs-sep', 'aria-hidden': 'true' }),
    el('nav', { class: 'tabs-rail', 'aria-label': 'Open files' },
      drawable.length
        ? drawable.map((tab) => tabNode(tab, route))
        : el('span', { class: 'tabs-empty', text: 'Open a file and it becomes a tab' })),
    el('button', {
      class: 'tabs-add', title: 'Open a file (⌘K)', 'aria-label': 'Open a file',
      onclick: () => openPalette(),
    }, icon('plus', { size: 13 })),
    el('button', {
      class: 'tabs-add', title: 'Settings', 'aria-label': 'Settings',
      onclick: () => navigate('settings'),
    }, icon('gear-six', { size: 14 })),
  );

  // Whatever you just opened has to be the thing you can see.
  requestAnimationFrame(() => {
    strip?.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}

function tabNode(tab, route) {
  const file = fileById(tab.id);
  const active = route.path[1] === tab.id;

  const node = el('button', {
    class: 'tab' + (active ? ' active' : ''),
    dataset: { id: tab.id },
    title: file.title,
    'aria-current': active ? 'page' : null,
    onclick: () => { if (!active) navigate(`${tab.kind}/${tab.id}`); },
    onpointerdown: (event) => startDrag(event, tab.id),
    // Middle-click closes, as it does in every strip of tabs anyone has used.
    onauxclick: (event) => { if (event.button === 1) { event.preventDefault(); closeTab(tab.id); } },
  },
    icon(FILE_ICON[file.kind] ?? 'file', { size: 13 }),
    el('span', { class: 'label', text: file.title }),
    el('i', {
      class: 'ph ph-x close',
      title: 'Close',
      // A control inside a control: not focusable, and hidden from the reader,
      // which reaches the same action through the tab's own context menu.
      'aria-hidden': 'true',
      onpointerdown: (event) => event.stopPropagation(),
      onclick: (event) => { event.stopPropagation(); closeTab(tab.id); },
    }),
  );
  return applyColor(node, file.effective_color);
}

/* ── reordering ───────────────────────────────────────────────────────── */

/**
 * Dragging a tab moves the tab, not the list.
 *
 * The dragged tab follows the pointer under a transform and its neighbours
 * slide out of the way by one tab's width, so the row animates rather than
 * jumping. The array is only rewritten once, on release, which is what keeps
 * the movement smooth: re-rendering mid-drag would restart every transition
 * and drop the pointer capture with it.
 */
function startDrag(event, id) {
  if (event.button !== 0) return;
  const rail = strip?.querySelector('.tabs-rail');
  const node = event.currentTarget;
  if (!rail) return;

  const nodes = [...rail.querySelectorAll('.tab')];
  const startIndex = nodes.indexOf(node);
  if (startIndex < 0) return;

  const startX = event.clientX;
  const width = node.getBoundingClientRect().width;
  const gap = 2;
  const step = width + gap;
  let offset = 0;
  let moved = false;

  const onMove = (move) => {
    const dx = move.clientX - startX;
    if (!moved && Math.abs(dx) < 4) return;
    if (!moved) {
      moved = true;
      node.setPointerCapture(move.pointerId);
      node.classList.add('dragging');
      for (const other of nodes) if (other !== node) other.classList.add('sliding');
    }

    node.style.transform = `translateX(${dx}px)`;
    // How many places the tab has travelled, rounded to the nearest slot.
    const places = Math.max(-startIndex, Math.min(nodes.length - 1 - startIndex, Math.round(dx / step)));
    if (places === offset) return;
    offset = places;

    nodes.forEach((other, index) => {
      if (other === node) return;
      let shift = 0;
      if (offset > 0 && index > startIndex && index <= startIndex + offset) shift = -step;
      if (offset < 0 && index < startIndex && index >= startIndex + offset) shift = step;
      other.style.transform = shift ? `translateX(${shift}px)` : '';
    });
  };

  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
    if (!moved) return;

    const from = state.openTabs.findIndex((tab) => tab.id === id);
    const to = Math.max(0, Math.min(state.openTabs.length - 1, from + offset));
    if (from >= 0 && from !== to) {
      const [tab] = state.openTabs.splice(from, 1);
      state.openTabs.splice(to, 0, tab);
      saveTabs();
    }
    // Every transform is thrown away with the re-render, which now draws the
    // order the drag just described.
    renderTabs();
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onUp);
}
