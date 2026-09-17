/** Bootstrap: session, shell, routing and global shortcuts. */
import { el, icon, mount, clear, colorValue, folderGlyph, colorLabel } from './dom.js';
import { dropdown } from './select.js';
import { api, onUnauthorized, onReachabilityChange, isReachable } from './api.js';
import { state, loadLibrary, loadSettings, notify, subscribe, toast, reportError, deviceId, folderById, subjectOfFolder, setRerender, setSidebarHidden, sidebarIsHidden, announce, setAccentSection } from './store.js';
import { currentRoute, currentPanes, navigate, onRoute, focusPane, focusedPane, isSplit, openBeside, canSplit, closePane, swapPanes, restoreWindow, isPinned } from './router.js';
import { renderSidebar, setCreateHandlers } from './shell.js';
import { renderTabs, trackTab } from './tabs.js';
import { trackRecent } from './recents.js';
import { loginView } from './login.js';
import { openPalette, closePalette } from './palette.js';
import { register as registerShortcut } from './shortcuts.js';
import { openMenu, closeMenu } from './menu.js';
import { promptText, confirmDelete, dialog, promptColor } from './dialog.js';
import { FILE_LABEL } from './format.js';
import { onCommand, onScan, reportRoute, onNavigate, openWindow } from './native.js';
import { printCurrent } from './print.js';
import { startNotifications } from './notify.js';
import { startBadge, stopBadge } from './badge.js';
import { startUpdates, checkForUpdates } from './updates.js';
import { syncSpotlight, stopSpotlight } from './spotlight.js';
import { installFileDrop } from './drop.js';
import { importDocument, isImportableDocument } from './import-doc.js';
import { pageTip } from './tips.js';
import { hasOnboarded, onboardingView } from './onboarding.js';
import { initFocus, toggleFocus } from './focus.js';
import { showProFeatures } from './pro.js';
import { KINDS as EVENT_KINDS } from './views/events.js';

import { homeView } from './views/home.js';
import { libraryView, folderView, fileMenu, fileMenuItems } from './views/library.js';
import { calendarView } from './views/calendar.js';
import { timetableView } from './views/timetable.js';
import { topicsView } from './views/topics.js';
import { documentView } from './views/document.js';
import { canvasView } from './views/canvas.js';
import { pdfView } from './views/pdf.js';
import { deckView, flashcardsView, testView } from './views/flashcards.js';
import { mockView } from './views/mock.js';
import { reviewView } from './views/review.js';
import { statsView } from './views/stats.js';
import { settingsView } from './views/settings.js';
import { sharedView } from './views/shared.js';
import { tagsView } from './views/tags.js';
import { trashView } from './views/trash.js';
import { besideView } from './views/beside.js';
import { openTagSheet } from './tags.js';
import { dropPane } from './dnd.js';

const root = document.getElementById('root');

/**
 * One of these per pane: a window holds one screen, or two side by side.
 *
 * `dispose` lets a view cancel timers and listeners when its pane moves on.
 * `token` guards against a slow view winning a race it already lost — views
 * are async and mount themselves, so without it a screen whose data arrives
 * after the pane has gone elsewhere would paint over the new one, and any
 * later self-re-render (a sort toggle, a save) would keep doing so. `hash` is
 * what the pane is currently showing, which is how a change in one pane is
 * kept from repainting the other: a document being read on the left must not
 * be torn down and rebuilt because something was opened on the right.
 */
const panes = [newPane(), newPane()];

function newPane() {
  return { dispose: null, token: 0, hash: null };
}

/** Tears every pane down: a sign-out or a share link takes the whole window. */
function disposeAll() {
  for (const pane of panes) {
    pane.dispose?.();
    pane.dispose = null;
    pane.token += 1;
    pane.hash = null;
  }
}

/**
 * The app fills the window.
 *
 * There used to be a strip across the top carrying the word "Studex" and
 * nothing else — a band of chrome above every screen, telling you the name of
 * the app you had just opened. It is gone, and the shell starts at the top
 * edge. What the strip also carried was the window drag, which now lives on
 * the sidebar's own header and on the top bar; both are marked as drag
 * surfaces and the controls inside them opt out, so the window still moves
 * from anywhere it reasonably should.
 */
function shellFrame() {
  const sidebar = el('aside', { class: 'sidebar', id: 'sidebar', 'aria-label': 'Library and navigation' });
  // Clicking anywhere in a pane makes it the pane a plain `navigate()` moves,
  // and mousedown runs before click — so a crumb, a row or a shortcut pressed
  // on the right opens on the right without any screen having to know it is
  // in a pane at all.
  const main = el('main', {
    class: 'main', id: 'main', 'aria-label': 'Content',
    onmousedown: adoptFocus,
  });
  const tabs = el('div', { class: 'tabstrip hidden', id: 'tabstrip', dataset: { appRegion: 'drag' } });
  return el('div', { class: 'app' },
    tabs,
    el('div', { class: 'shell' }, sidebar, main),
  );
}

/**
 * A screen with no sidebar and no top bar still has to be draggable, and the
 * traffic lights still need somewhere to sit. This is that space and nothing
 * else: no background, no rule, no title.
 */
function dragStrip() {
  return el('div', { class: 'drag-strip', dataset: { appRegion: 'drag' } });
}

const ROUTES = {
  home: homeView,
  library: libraryView,
  folder: folderView,
  calendar: calendarView,
  timetable: timetableView,
  topics: topicsView,
  doc: documentView,
  canvas: canvasView,
  pdf: pdfView,
  deck: deckView,
  flashcards: flashcardsView,
  review: reviewView,
  test: testView,
  mock: mockView,
  stats: statsView,
  settings: settingsView,
  tag: tagsView,
  trash: trashView,
  beside: besideView,
};

/** The route the sidebar overlay was last left open over. */
let lastRoute = null;

/**
 * Where the split is: how much of the window pane one takes.
 *
 * A dragged divider is a setting, not a gesture — it should still be there
 * tomorrow — so it is remembered on the machine rather than in the account.
 * The two panes are a way of looking at one library, not a thing to sync.
 */
const SPLIT_KEY = 'studex.split';
// Per account: two students sharing a Mac should not drag each other's divider.
const splitKey = () => (state.user?.id ? `${SPLIT_KEY}.${state.user.id}` : SPLIT_KEY);
// And per display: half of a 13-inch laptop and half of a 27-inch monitor are
// not the same amount of page, so each screen keeps a ratio of its own.
const screenKey = () => `${splitKey()}@${window.screen?.width ?? 0}x${window.screen?.height ?? 0}`;

function setSplit(pct) {
  document.documentElement.style.setProperty('--split', `${pct}%`);
  try {
    localStorage.setItem(screenKey(), String(Math.round(pct)));
    localStorage.setItem(splitKey(), String(Math.round(pct)));
  } catch { /* storage may be unavailable */ }
}

function restoreSplit() {
  let saved = null;
  try { saved = localStorage.getItem(screenKey()) ?? localStorage.getItem(splitKey()) ?? localStorage.getItem(SPLIT_KEY); } catch { /* storage may be unavailable */ }
  const pct = Number(saved);
  if (Number.isFinite(pct) && pct >= 20 && pct <= 80) {
    document.documentElement.style.setProperty('--split', `${pct}%`);
  }
}

// A window dragged onto another display picks up that display's ratio.
let lastScreen = null;
window.addEventListener('resize', () => {
  const now = `${window.screen?.width}x${window.screen?.height}`;
  if (lastScreen !== null && now !== lastScreen) restoreSplit();
  lastScreen = now;
});

/** Whichever pane the pointer went down in is the one that answers next. */
function adoptFocus(event) {
  const host = event.target instanceof Element ? event.target.closest('.pane') : null;
  if (!host) return;
  const index = Number(host.dataset.pane ?? '0');
  if (index === focusedPane()) return;
  focusPane(index);
}

function paneDivider() {
  return el('div', {
    class: 'pane-divider',
    role: 'separator',
    'aria-orientation': 'vertical',
    title: 'Drag to resize',
    // Double-click is the way back to even, which is otherwise a drag you
    // have to land exactly.
    ondblclick: () => setSplit(50),
    onmousedown: startResize,
  });
}

function startResize(event) {
  event.preventDefault();
  const main = document.getElementById('main');
  if (!main) return;
  const move = (moveEvent) => {
    const box = main.getBoundingClientRect();
    if (!box.width) return;
    // A pane narrower than this is a column of ellipses; the limit is what
    // keeps the divider a resize rather than a way to hide a pane.
    const pct = Math.min(78, Math.max(22, ((moveEvent.clientX - box.left) / box.width) * 100));
    setSplit(pct);
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    document.body.classList.remove('resizing-panes');
  };
  document.body.classList.add('resizing-panes');
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

/**
 * Makes the window hold exactly `count` panes and hands back their hosts.
 *
 * Panes already on screen are kept as they are — closing the right pane must
 * not flash the left one, and opening one must not throw away what is being
 * read beside it.
 */
function syncPanes(main, count) {
  const have = /** @type {HTMLElement[]} */ ([...main.children].filter((node) => node instanceof HTMLElement && node.classList.contains('pane')));
  // Already arranged. This matters more than it looks: taking a pane out of
  // the document and putting it back resets its scroll, drops the selection
  // and blurs whatever was being typed into — and this runs on every repaint,
  // including the one that follows simply clicking in the other pane.
  if (have.length === count) return have;

  for (let i = count; i < panes.length; i += 1) {
    panes[i].dispose?.();
    panes[i].dispose = null;
    panes[i].token += 1;
    panes[i].hash = null;
  }
  const hosts = have.slice(0, count);
  while (hosts.length < count) hosts.push(dropPane(el('div', { class: 'pane' })));
  clear(main);
  hosts.forEach((host, index) => {
    host.dataset.pane = String(index);
    if (index > 0) main.appendChild(paneDivider());
    main.appendChild(host);
  });
  return hosts;
}

/**
 * Draws the window.
 *
 * By default this is a repaint of everything, because the hundred calls that
 * follow a rename or a delete mean "what is on screen is now out of date" and
 * both panes may be showing it. A route change is the exception: it passes
 * `force: false` so that only the pane whose address actually moved is rebuilt
 * and a document being read beside it is left alone.
 */
async function renderRoute({ force = true } = {}) {
  const routes = currentPanes();
  const main = document.getElementById('main');
  const sidebar = document.getElementById('sidebar');
  if (!main) return;

  closeMenu();

  const focus = focusedPane();
  const route = routes[focus] ?? routes[0];

  const layout = state.device?.shell_layout ?? 'folder_tree';
  sidebar.className = layout === 'icon_rail' ? 'rail' : 'sidebar';
  // In a narrow window the sidebar is an overlay, and going somewhere is the
  // end of it: it closes behind the row that was tapped. A re-render of the
  // same screen — a save, a sort — leaves it alone.
  const here = route.path.join('/');
  if (here !== lastRoute) { lastRoute = here; state.sidebarPeek = false; }
  // The shell keeps one of these per window: it is the window's title in the
  // Window menu, and the string a closed window is brought back from.
  reportWindow(routes);
  // Workspace tabs has no sidebar of its own, so there is nothing to hide —
  // but the reveal handle in the top bar follows the same flag either way.
  const noSidebar = layout === 'workspace_tabs' || sidebarIsHidden();
  sidebar.classList.toggle('hidden', noSidebar);
  document.documentElement.classList.toggle('sidebar-hidden', noSidebar);
  if (!noSidebar) renderSidebar(sidebar);

  // In the tabs layout the strip is the whole of the navigation, so it is
  // built before the view rather than after it resolves.
  trackRecent(route);
  setAccentSection(route.path[0] ?? 'home');
  document.documentElement.classList.toggle('layout-tabs', layout === 'workspace_tabs');
  const tabstrip = document.getElementById('tabstrip');
  if (tabstrip) {
    const tabbed = layout === 'workspace_tabs';
    tabstrip.classList.toggle('hidden', !tabbed);
    if (tabbed) { trackTab(route); renderTabs(tabstrip); }
  }

  const split = routes.length > 1;
  const hosts = syncPanes(main, routes.length);
  main.classList.toggle('split', split);
  hosts.forEach((host, index) => {
    host.classList.toggle('focused', split && index === focus);
    host.classList.toggle('pinned', index === 1 && isPinned());
  });

  await Promise.all(routes.map((paneRoute, index) => {
    if (!force && panes[index].hash === paneRoute.hash) return null;
    return renderPane(index, paneRoute, hosts[index]);
  }));
}

/**
 * The window's route is both panes, and its title names both — "Notes · Deck"
 * — so a split window comes back split and reads as two things in the Window
 * menu rather than as whichever half happened to be focused.
 */
function reportWindow(routes) {
  reportRoute(routes.map((r) => r.hash).join('|'), routes.map((r) => routeName(r)).join(' · '));
}

async function renderPane(index, route, host) {
  const pane = panes[index];
  if (!host) return;
  pane.dispose?.();
  pane.dispose = null;
  pane.hash = route.hash;

  const view = ROUTES[route.path[0]] ?? homeView;
  mount(host, el('div', { class: 'loading', role: 'status' }, el('div', { class: 'spinner', 'aria-hidden': 'true' }), 'Loading…'));

  // The view renders into a detached container and is only attached once it
  // resolves — and only if it is still what the pane is showing. A superseded
  // view keeps writing into a container that was never attached, which is inert.
  const token = ++pane.token;
  // `enter` is what animates the screen in. It is taken off again once it has
  // played, because a view that re-renders itself into the same container —
  // a sort toggle, a save — is not an arrival and should not be announced as
  // one.
  const container = el('div', { class: 'view enter' });

  try {
    const result = await view(route, container);
    if (token !== pane.token) return;
    if (typeof result === 'function') pane.dispose = result;
    mount(host, container);
    setTimeout(() => container.classList.remove('enter'), 400);
    // A tip only for the screen being worked in.
    if (index === focusedPane()) {
      setTimeout(() => { if (token === pane.token) pageTip(route.path[0] ?? 'home', host); }, 900);
    }
    // A screen change in this app is a repaint, not a page load, so nothing
    // tells a screen reader it happened. This does — with the name of the
    // screen, which is the one fact a sighted student gets for free. Only the
    // pane being worked in speaks; the one beside it would be interruption.
    if (index === focusedPane()) {
      announce(routeName(route));
      // A file's own title may only have arrived with the view; say it again
      // now that there is a real name to put in the Window menu.
      reportWindow(currentPanes());
    }
  } catch (err) {
    if (token !== pane.token) return;
    reportError(err);
    mount(host, el('div', { class: 'empty-state' },
      icon('warning-circle'),
      el('div', { text: err?.message ?? 'This screen could not be loaded.' }),
      el('button', { class: 'btn', text: 'Retry', onclick: () => renderRoute() }),
    ));
  }
}

/**
 * What to call the screen that has just been drawn.
 *
 * The file's own title where there is one, because "Document" is the same
 * announcement for every document in the account; otherwise the word the
 * sidebar uses, so that what is heard matches what is highlighted.
 */
const ROUTE_NAME = {
  home: 'Home',
  library: 'Library',
  calendar: 'Calendar',
  timetable: 'Timetable',
  topics: 'Topics',
  stats: 'Statistics',
  settings: 'Settings',
  review: 'Daily review',
  flashcards: 'Decks',
  test: 'Test me',
  tag: 'Tags',
  trash: 'Trash',
  beside: 'Open beside',
};

function routeName(route) {
  const head = route.path[0] ?? 'home';
  const id = route.path[1];
  if (head === 'folder') return `${folderById(id)?.name ?? 'Folder'}, folder`;
  if (id) {
    const file = state.files.find((f) => f.id === id);
    if (file) return `${file.title || 'Untitled'}, ${FILE_LABEL[file.kind] ?? head}`;
  }
  return ROUTE_NAME[head] ?? head;
}

/* ── create actions, shared by the sidebar menu and the shortcuts ─────── */

function currentFolderId() {
  const route = currentRoute();
  if (route.path[0] === 'folder') return route.path[1] ?? null;
  const file = state.files.find((f) => f.id === route.path[1]);
  return file?.folder_id ?? null;
}

/** The four papers a canvas can start on, and what each is good for. */
const CANVAS_PAPERS = [
  { id: 'dots', label: 'Dotted', hint: 'Alignment without ruling' },
  { id: 'plain', label: 'Plain', hint: 'Nothing in the way' },
  { id: 'lines', label: 'Lined', hint: 'Writing in rows' },
  { id: 'squares', label: 'Grid', hint: 'Diagrams and graphs' },
];

/**
 * The new-canvas sheet: a title and the paper to start on.
 *
 * The paper was a device-wide preference, which meant every canvas on a machine
 * looked the same. Asking once, here, is the only moment the answer is obvious
 * — you know what you are about to draw.
 */
async function newCanvasSheet() {
  const title = el('input', { class: 'input', placeholder: 'Untitled', maxlength: 200 });
  let paper = 'dots';

  const tiles = CANVAS_PAPERS.map((option) => {
    const tile = el('button', {
      class: 'paper' + (option.id === paper ? ' on' : ''),
      type: 'button',
      dataset: { paper: option.id },
      onclick: () => {
        paper = option.id;
        for (const other of tiles) other.classList.toggle('on', other.dataset.paper === paper);
      },
    },
      el('span', { class: `paper-swatch grid-${option.id}` }),
      el('span', { class: 'paper-name', text: option.label }),
      el('span', { class: 'paper-hint', text: option.hint }),
    );
    return tile;
  });

  const made = await dialog({
    title: 'New canvas',
    confirmLabel: 'Create',
    wide: true,
    body: el('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px' } },
      el('div', { class: 'field' }, el('label', { text: 'Title' }), title),
      el('div', { class: 'field' },
        el('label', { text: 'Background' }),
        el('div', { class: 'paper-grid' }, tiles),
      ),
    ),
    onConfirm: () => {
      return { title: title.value.trim() || 'Untitled', background: paper };
    },
  });
  setTimeout(() => title.focus(), 0);
  return made || null;
}

const DOC_STYLES = [
  { id: 'standard', label: 'Standard', hint: 'Prose, headings and paragraphs.' },
  { id: 'bulleted', label: 'Bulleted', hint: 'Every line an item, outliner-style.' },
];

/**
 * Standard or bulleted, asked once when the document is made.
 *
 * It is a choice about how the notes will read, and the moment you know the
 * answer is the moment you decide what the page is for. It stays changeable
 * on the page itself afterwards.
 */
function stylePreview(id) {
  const widths = ['82%', '96%', '61%', '90%'];
  return el('span', { class: 'paper-swatch doc-preview' },
    // Prefixed, because `.row` is the library's list row and `.dot` is the
    // calendar's today marker — an unprefixed name here inherits their padding
    // and blows the preview out of its own box.
    widths.map((width) => el('span', { class: 'pv-row' },
      id === 'bulleted' ? el('span', { class: 'pv-dot' }) : null,
      el('span', { class: 'pv-ln', style: { width } }),
    )),
  );
}

async function newDocumentSheet() {
  const title = el('input', { class: 'input', placeholder: 'Untitled', maxlength: 200 });
  let chosen = 'standard';

  const tiles = DOC_STYLES.map((option) => el('button', {
    class: 'paper' + (option.id === chosen ? ' on' : ''),
    type: 'button',
    dataset: { style: option.id },
    onclick: () => {
      chosen = option.id;
      for (const other of tiles) other.classList.toggle('on', other.dataset.style === chosen);
    },
  },
    stylePreview(option.id),
    el('span', { class: 'paper-name', text: option.label }),
    el('span', { class: 'paper-hint', text: option.hint }),
  ));

  const made = await dialog({
    title: 'New document',
    confirmLabel: 'Create',
    body: el('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px' } },
      el('div', { class: 'field' }, el('label', { text: 'Title' }), title),
      el('div', { class: 'field' },
        el('label', { text: 'Style' }),
        el('div', { class: 'paper-grid two' }, tiles),
      ),
    ),
    onConfirm: () => {
      return { title: title.value.trim() || 'Untitled', style: chosen };
    },
  });
  setTimeout(() => title.focus(), 0);
  return made || null;
}

async function createFile(kind) {
  let background;
  let style;
  let title;
  if (kind === 'canvas') {
    const made = await newCanvasSheet();
    if (!made) return;
    ({ title, background } = made);
  } else if (kind === 'doc') {
    const made = await newDocumentSheet();
    if (!made) return;
    ({ title, style } = made);
  } else {
    title = await promptText({
      title: `New ${FILE_LABEL[kind]?.toLowerCase() ?? kind}`,
      label: 'Title',
      value: '',
      fallback: 'Untitled',
    });
  }
  if (!title) return;
  const folderId = currentFolderId();
  try {
    const { file } = await api.createFile({ title, kind, folderId, background, style });
    await loadLibrary();
    revealIn(folderId);
    navigate(`${kind}/${file.id}`);
    toast(`${FILE_LABEL[kind]} created.`);
  } catch (err) { reportPlanError(err); }
}

/**
 * A refusal that a plan caused is not a failure to report — it is an offer.
 * The toast says what happened; the sheet says what would change it.
 */
function reportPlanError(err) {
  if (err?.status === 402) { showProFeatures({ reason: err.message }); return; }
  reportError(err);
}

/**
 * Name and colour together.
 *
 * The colour was only reachable afterwards, by right-clicking the folder you
 * had just made — which is one step too late to be the thing that tells you
 * which subject you are looking at.
 */
async function newFolder() {
  const name = el('input', { class: 'input', placeholder: 'Chemistry', maxlength: 120 });
  let color = COLOR_ROLES[0];

  const swatches = el('div', { class: 'swatches' });
  const preview = el('div', { class: 'folder-preview' });
  const paint = () => {
    for (const button of swatches.children) {
      button.classList.toggle('on', button.dataset.color === color);
      if (button.dataset.color === 'custom') button.style.background = colorValue(color);
    }
    preview.replaceChildren(folderGlyph(color, { size: 40 }));
  };

  for (const role of COLOR_ROLES) {
    swatches.appendChild(el('button', {
      class: 'swatch', type: 'button', title: colorLabel(role), 'aria-label': colorLabel(role),
      dataset: { color: role },
      style: { background: colorValue(role) },
      onclick: () => { color = role; paint(); },
    }));
  }
  swatches.appendChild(el('button', {
    class: 'swatch custom', type: 'button', title: 'Custom colour',
    dataset: { color: 'custom' },
    onclick: async () => {
      const picked = await promptColor({ title: 'Folder colour', value: /^#/.test(color) ? color : '#4f46e5' });
      if (!picked) return;
      color = picked;
      paint();
    },
  }, icon('eyedropper', { size: 11 })));
  paint();

  const made = await dialog({
    title: 'New folder',
    confirmLabel: 'Create',
    body: el('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px' } },
      el('div', { class: 'field' }, el('label', { text: 'Name' }), name),
      el('div', { class: 'field' },
        el('label', { text: 'Colour' }),
        el('div', { class: 'folder-color-row' }, preview, swatches),
      ),
    ),
    onConfirm: () => {
      return { name: name.value.trim() || 'Untitled', color };
    },
  });
  if (!made) return;

  try {
    await api.createFolder({ name: made.name, color: made.color, parentId: currentFolderId() });
    await loadLibrary();
    renderRoute();
    toast('Folder created.');
  } catch (err) { reportError(err); }
}

const COLOR_ROLES = ['accent', 'sky', 'teal', 'lime', 'amber', 'rose', 'neutral'];

/**
 * Which subject a folder belongs to.
 *
 * Subjects existed and could be attached to an exam or a study block, but
 * nothing in the library could be put in one — so the shelf and the timetable
 * were two filing systems that never met. Set here, on a folder, and inherited
 * by everything inside it: the decks in Chemistry/Year 13 are Chemistry decks
 * without being told so one at a time.
 */
async function setFolderSubject(folder) {
  const NEW = '\u0000new';
  const inherited = folder.parent_id ? subjectOfFolder(folder.parent_id) : null;
  const select = dropdown({ class: 'input' },
    el('option', {
      value: '',
      text: inherited ? `Inherit — ${inherited.name}` : 'No subject',
      selected: !folder.subject_id,
    }),
    state.subjects.map((s) => el('option', {
      value: s.id, text: s.name, selected: folder.subject_id === s.id,
    })),
    el('option', { value: NEW, text: 'New subject…' }),
  );
  const fresh = el('input', { class: 'input', placeholder: 'Chemistry', maxlength: 80, disabled: true });
  const teacher = el('input', { class: 'input', placeholder: 'Mrs Okafor', maxlength: 60 });
  const syncTeacher = () => {
    const chosen = state.subjects.find((s) => s.id === select.value);
    teacher.disabled = !chosen && select.value !== NEW;
    teacher.value = chosen?.teacher ?? '';
  };
  syncTeacher();
  select.addEventListener('change', () => {
    fresh.disabled = select.value !== NEW;
    if (!fresh.disabled) fresh.focus();
    syncTeacher();
  });

  const ok = await dialog({
    title: `Subject for ${folder.name}`,
    confirmLabel: 'Save',
    body: el('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
      el('div', { class: 'field' }, el('label', { text: 'Subject' }), select),
      el('div', { class: 'field' }, el('label', { text: 'New subject name' }), fresh),
      el('div', { class: 'field' }, el('label', { text: 'Teacher' }), teacher),
    ),
    onConfirm: async () => {
      let subjectId = select.value || null;
      if (subjectId === NEW) {
        const name = fresh.value.trim();
        if (!name) { fresh.focus(); return false; }
        try {
          // The new subject takes the folder's colour, so its lessons on the
          // timetable are the same colour as its folder in the sidebar.
          const color = folder.color ?? folder.effective_color ?? undefined;
          const { subject } = await api.createSubject({ name, color: color || undefined, teacher: teacher.value.trim() || null });
          subjectId = subject.id;
        } catch (err) {
          // A name already in use is the likely one, and it is worth saying so
          // rather than letting the sheet close on a failure.
          reportError(err);
          return false;
        }
      }
      const existing = state.subjects.find((x) => x.id === select.value);
      if (existing && (existing.teacher ?? '') !== teacher.value.trim()) {
        try { await api.updateSubject(existing.id, { teacher: teacher.value.trim() || null }); }
        catch (err) { reportError(err); return false; }
      }
      try { await api.updateFolder(folder.id, { subjectId }); }
      catch (err) { reportError(err); return false; }
      return true;
    },
  });
  if (!ok) return;
  await loadLibrary();
  renderRoute();
  toast('Subject saved.');
}

function folderMenu(folder, x, y) {
  openMenu({ x, y }, [
    { head: folder.name.toUpperCase() },
    {
      icon: 'pencil-simple', label: 'Rename', onSelect: async () => {
        const name = await promptText({ title: 'Rename folder', label: 'Name', value: folder.name, confirmLabel: 'Rename', fallback: 'Untitled' });
        if (!name) return;
        try { await api.updateFolder(folder.id, { name }); await loadLibrary(); renderRoute(); }
        catch (err) { reportError(err); }
      },
    },
    {
      icon: 'star',
      label: folder.pinned ? 'Unpin' : 'Pin to the top',
      onSelect: async () => {
        try { await api.updateFolder(folder.id, { pinned: !folder.pinned }); await loadLibrary(); renderRoute(); }
        catch (err) { reportError(err); }
      },
    },
    { icon: 'exam', label: 'Test this folder', onSelect: () => navigate(`test/folder/${folder.id}`) },
    {
      icon: 'square-split-horizontal',
      label: 'Open Beside',
      onSelect: () => openBeside(`folder/${folder.id}`),
    },
    { sep: true },
    {
      icon: 'graduation-cap',
      label: 'Subject…',
      onSelect: () => setFolderSubject(folder),
    },
    {
      icon: 'hash',
      label: 'Tags…',
      onSelect: () => void openTagSheet({ itemType: 'folder', itemId: folder.id, title: folder.name }, renderRoute),
    },
    { sep: true },
    {
      swatches: COLOR_ROLES.map((role) => ({
        color: colorValue(role),
        label: colorLabel(role),
        on: folder.color === role,
        onSelect: async () => {
          try {
            await api.updateFolder(folder.id, { color: role });
            await loadLibrary();
            renderRoute();
          } catch (err) { reportError(err); }
        },
      })),
    },
    {
      icon: 'eyedropper', label: 'Custom colour…', onSelect: async () => {
        const color = await promptColor({ title: `Colour for ${folder.name}`, value: folder.color });
        if (!color) return;
        try { await api.updateFolder(folder.id, { color }); await loadLibrary(); renderRoute(); }
        catch (err) { reportError(err); }
      },
    },
    { sep: true },
    {
      icon: 'trash', label: 'Delete folder', danger: true, onSelect: async () => {
        const ok = await confirmDelete(`“${folder.name}” and everything in it. This cannot be undone.`);
        if (!ok) return;
        try { await api.deleteFolder(folder.id); await loadLibrary(); navigate('library'); toast('Folder deleted.'); }
        catch (err) { reportError(err); }
      },
    },
  ]);
}

async function newEvent() {
  const title = el('input', { class: 'input', placeholder: 'Chem Paper 2', maxlength: 200 });
  const when = el('input', { class: 'input', type: 'datetime-local' });
  // The same list the calendar's own form offers, rather than a second copy
  // of it that drifts the moment a kind is added.
  const kind = dropdown({ class: 'input' },
    EVENT_KINDS.map((k) => el('option', { value: k.id, text: k.label })));
  const location = el('input', { class: 'input', placeholder: 'Hall B', maxlength: 200 });

  const soon = new Date(Date.now() + 24 * 60 * 60 * 1000);
  soon.setMinutes(0, 0, 0);
  when.value = new Date(soon.getTime() - soon.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

  const created = await dialog({
    title: 'New event',
    confirmLabel: 'Add',
    wide: true,
    body: el('div', { class: 'form-grid' },
      el('div', { class: 'field span' }, el('label', { text: 'Title' }), title),
      el('div', { class: 'field' }, el('label', { text: 'Kind' }), kind),
      el('div', { class: 'field' }, el('label', { text: 'When' }), when),
      el('div', { class: 'field span' }, el('label', { text: 'Location (optional)' }), location),
    ),
    onConfirm: async () => {
      const name = title.value.trim();
      if (!name || !when.value) { title.focus(); return false; }
      await api.createEvent({
        title: name,
        kind: kind.value,
        startsAt: new Date(when.value).getTime(),
        location: location.value.trim() || null,
      });
      return true;
    },
  });

  if (created) { toast('Added to your calendar.'); renderRoute(); }
}

/** POST /api/pdfs answers with { fileId, pdf } — the id of the file row, not the row. */
async function sendPdf(file, folderId, onProgress) {
  const form = new FormData();
  form.append('file', file, file.name);
  if (folderId) form.append('folderId', folderId);
  const { fileId } = onProgress
    ? await api.uploadPdfProgress(form, onProgress)
    : await api.uploadPdf(form);
  return fileId;
}

/* ── import progress ──────────────────────────────────────────────────── */

/**
 * What a drop looks like while it is happening.
 *
 * A PDF is tens of megabytes and the app was silent for the whole of it — the
 * veil lifted on release and nothing else happened until the reader opened,
 * which on a large file reads as a drop that did not work. This says which
 * file, which of how many, and how far.
 */
let importVeil = null;

function showImport(total) {
  const bar = el('div', { class: 'import-fill' });
  const name = el('div', { class: 'import-name' });
  const step = el('div', { class: 'import-step' });
  importVeil = el('div', { class: 'import-veil' },
    el('div', { class: 'import-card' },
      el('div', { class: 'import-head' }, el('span', { class: 'import-glyph' }, icon('file-arrow-up', { size: 17 })), step),
      name,
      el('div', { class: 'import-bar' }, bar),
    ),
  );
  importVeil.parts = { bar, name, step, total };
  document.body.appendChild(importVeil);
  requestAnimationFrame(() => importVeil?.classList.add('in'));
  return importVeil;
}

/** `fraction` is how far through the whole drop we are, from 0 to 1. */
function updateImport(index, file, fraction) {
  if (!importVeil) return;
  const { bar, name, step, total } = importVeil.parts;
  step.textContent = fraction >= 1 && index + 1 >= total
    ? (total === 1 ? 'Imported' : `Imported ${total} files`)
    : total === 1 ? 'Importing' : `Importing ${index + 1} of ${total}`;
  name.textContent = file.name;
  bar.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
}

/** A moment of "done" before the veil goes, so a fast import is still seen to finish. */
async function finishImport(count) {
  if (!importVeil) return;
  const { bar, step } = importVeil.parts;
  bar.style.width = '100%';
  step.textContent = count === 1 ? 'Imported' : `Imported ${count} files`;
  importVeil.classList.add('done');
  const glyph = importVeil.querySelector('.import-glyph');
  if (glyph) glyph.replaceChildren(icon('check-circle', { size: 18, bold: true }));
  const quiet = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  await new Promise((r) => setTimeout(r, quiet ? 150 : 650));
}

function hideImport() {
  const veil = importVeil;
  importVeil = null;
  if (!veil) return;
  veil.classList.remove('in');
  setTimeout(() => veil.remove(), 200);
}

/**
 * Puts a newly imported file where it can be seen before opening it. A file
 * made into a closed folder exists and shows nowhere, because the tree only
 * draws a folder's contents once it is open.
 */
function revealIn(folderId) {
  if (folderId) state.expanded.add('folder:' + folderId);
  state.expanded.delete('folders:collapsed');
}

async function addPdf() {
  const picker = el('input', {
    type: 'file', multiple: true, class: 'hidden',
    accept: 'application/pdf,.pdf,.docx,.md,.markdown,.txt,.text,.html,.htm,text/plain,text/markdown,text/html',
  });
  document.body.appendChild(picker);
  picker.addEventListener('change', async () => {
    const files = [...(picker.files ?? [])];
    picker.remove();
    if (files.length) await importDroppedFiles(files);
  });
  picker.click();
}

/**
 * A page photographed or scanned with an iPhone.
 *
 * It arrives as a PDF whichever button was pressed over there — the shell
 * wraps a photograph in a page of its own size — so from here it is the same
 * import as a drop, minus the drag: into the folder being looked at, revealed
 * in the tree, and opened in the reader that can already annotate it.
 */
onScan(async (file) => {
  if (!state.user || !state.ready) { toast('Sign in first.'); return; }

  const folderId = currentFolderId();
  showImport(1);
  let fileId = null;
  try {
    fileId = await sendPdf(file, folderId, (fraction) => updateImport(0, file, fraction));
  } catch (err) {
    reportPlanError(err);
    return;
  } finally {
    hideImport();
  }

  try {
    await loadLibrary();
    revealIn(folderId);
    navigate(`pdf/${fileId}`);
  } catch (err) { reportError(err); }
  toast('Added from your iPhone.');
});

/**
 * A PDF dropped on the window.
 *
 * The name is checked as well as the type because a drag out of some apps
 * arrives with an empty mimetype; the bytes are the real test and the server
 * makes it, so this only decides what is worth sending. Anything else in the
 * drag is left alone rather than guessed at.
 */
const isPdf = (file) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name);

async function importDroppedFiles(files) {
  const wanted = files.filter((f) => isPdf(f) || isImportableDocument(f));
  if (!wanted.length) {
    toast(files.length === 1
      ? 'Studex can import PDFs, Word files (.docx), Markdown, text and HTML — not that kind of file.'
      : 'None of those can be imported. Try PDFs, Word files, Markdown, text or HTML.', 'error');
    return;
  }
  const skipped = files.length - wanted.length;

  // Where you were standing when you let go, so a drop inside a folder lands
  // in that folder rather than at the top of the library.
  const folderId = currentFolderId();

  let opened = null;
  let done = 0;
  let failure = null;
  let truncated = false;
  showImport(wanted.length);
  // One at a time: the upload endpoint is rate limited, and a dropped folder of
  // twenty would otherwise arrive as twenty simultaneous requests.
  try {
    for (const [index, file] of wanted.entries()) {
      updateImport(index, file, index / wanted.length);
      // The bar covers the whole drop, not this one file, so ten files do not
      // each fill it and start again.
      const progress = (fraction) => updateImport(index, file, (index + fraction) / wanted.length);
      try {
        if (isPdf(file)) {
          const fileId = await sendPdf(file, folderId, progress);
          opened ??= `pdf/${fileId}`;
        } else {
          const result = await importDocument(file, folderId, progress);
          truncated ||= result.truncated;
          opened ??= `doc/${result.fileId}`;
        }
        done += 1;
      } catch (err) { failure ??= err; }
    }
    if (done) await finishImport(done);
  } finally {
    hideImport();
  }

  if (done) {
    // Reloading the library can fail on its own — the upload already happened,
    // and losing the toast plus the navigation to a failed refresh would leave
    // the student with no sign that anything arrived.
    try {
      await loadLibrary();
      revealIn(folderId);
      navigate(opened);
    } catch (err) {
      reportError(err);
    }
  }
  // A refusal is worth more than a count, so it is reported instead of the
  // tally. Whatever did arrive is already open behind it.
  if (failure) { reportPlanError(failure); return; }
  const parts = [done === 1 ? 'Imported.' : `${done} files imported.`];
  if (truncated) parts.push('A very long file was cut to 5,000 lines.');
  if (skipped) parts.push(`${skipped} ${skipped === 1 ? 'file was' : 'files were'} not a kind Studex can import.`);
  toast(parts.join(' '));
}

/**
 * Dropping is only offered once there is a library to drop into. Before then
 * the drop is still swallowed rather than left to WebKit, so a file let go
 * over the login screen does nothing instead of trying to become the page.
 */
installFileDrop({
  enabled: () => Boolean(state.user && state.ready),
  caption: () => {
    const folder = folderById(currentFolderId());
    return {
      title: 'Drop to import',
      hint: `PDF, Word, Markdown or text${folder ? ` · into ${folder.name}` : ''}`,
    };
  },
  onDrop: (files) => importDroppedFiles(files),
});

async function signOut() {
  try { await api.logout(); } catch { /* the session is going away regardless */ }
  state.user = null;
  // The count goes with the session. A number left on the Dock is one
  // student's workload advertised to whoever uses the Mac next.
  stopBadge();
  // And so do the note titles: an index left behind outlives the session and
  // is readable from the desktop by whoever signs in next.
  stopSpotlight();
  // The pages that were open belong to the account that just left. Without
  // this the next person to sign in lands on them — and on the second pane
  // especially, which nothing else ever closes.
  history.replaceState(null, '', '#/home');
  showLogin();
}

async function setFolderPinned(folder, pinned) {
  try { await api.updateFolder(folder.id, { pinned }); await loadLibrary(); renderRoute(); }
  catch (err) { reportError(err); }
}

async function setFilePinned(file, pinned) {
  try { await api.updateFile(file.id, { pinned }); await loadLibrary(); renderRoute(); }
  catch (err) { reportError(err); }
}

setCreateHandlers({
  create: createFile, newFolder, folderMenu, event: newEvent,
  fileMenu: (file, x, y) => fileMenu(file, x, y, async () => { await loadLibrary(); renderRoute(); }),
  fileMenuItems: (file) => fileMenuItems(file, async () => { await loadLibrary(); renderRoute(); }),
  addPdf, signOut, setFolderPinned, setFilePinned,
});

/* ── native menu ──────────────────────────────────────────────────────── */

/**
 * The menu bar exists before anyone has signed in, and AppKit will happily
 * fire ⌘1 at the login screen. Commands that need a library are dropped
 * there rather than failing halfway through.
 */
function whenSignedIn(fn) {
  return () => { if (state.user) fn(); };
}

onCommand({
  'new-canvas': whenSignedIn(() => createFile('canvas')),
  'new-doc': whenSignedIn(() => createFile('doc')),
  'new-deck': whenSignedIn(() => createFile('deck')),
  'new-folder': whenSignedIn(newFolder),
  'new-event': whenSignedIn(newEvent),
  'add-pdf': whenSignedIn(addPdf),
  'print': whenSignedIn(printCurrent),
  'export-all': whenSignedIn(() => navigate('settings/data')),
  'palette': whenSignedIn(openPalette),
  'sign-out': whenSignedIn(signOut),
  'go-home': whenSignedIn(() => navigate('home')),
  'go-library': whenSignedIn(() => navigate('library')),
  'go-calendar': whenSignedIn(() => navigate('calendar')),
  'go-review': whenSignedIn(() => navigate('review')),
  'go-topics': whenSignedIn(() => navigate('topics')),
  'go-timetable': whenSignedIn(() => navigate('timetable')),
  'go-stats': whenSignedIn(() => navigate('stats')),
  'go-settings': whenSignedIn(() => navigate('settings')),
  // The Updates screen checks as it opens when asked to from the menu.
  'check-updates': whenSignedIn(() => {
    navigate('settings/updates');
    void checkForUpdates({ manual: true }).catch(reportError);
  }),
  'toggle-sidebar': whenSignedIn(() => setSidebarHidden(!sidebarIsHidden())),
  'toggle-split': whenSignedIn(() => {
    if (isSplit()) closePane(focusedPane());
    else splitBeside();
  }),
  'swap-panes': whenSignedIn(() => swapPanes()),
  'focus-left-pane': whenSignedIn(() => { if (isSplit()) focusPane(0); }),
  'focus-right-pane': whenSignedIn(() => { if (isSplit()) focusPane(1); }),
});

/* ── global shortcuts ─────────────────────────────────────────────────── */

const signedIn = () => Boolean(state.user);
const shortcut = (id, keys, group, label, run, extra = {}) =>
  registerShortcut({ id, keys, group, label, run, when: signedIn, ...extra });

registerShortcut({ id: 'palette', keys: 'mod+k', group: 'Navigation', label: 'Search and jump anywhere', run: () => openPalette() });
// ⌘⌥\ opens a second page beside this one, and the same keys close it
// again. Option changes what the key produces on a Mac keyboard, so this
// one reads the physical key rather than the character it typed.
shortcut('split', 'mod+alt+Backslash', 'Sidebar & panes', 'Open or close a page beside this one', () => {
  if (isSplit()) closePane(focusedPane());
  else splitBeside();
});

/** Opens the picker beside this page, unless this page always takes the whole window. */
function splitBeside() {
  if (!canSplit(currentRoute().hash)) { toast('This page takes the whole window. Open a file or the Library to split.'); return; }
  openBeside('beside');
}
shortcut('sidebar', 'mod+\\', 'Sidebar & panes', 'Show or hide the sidebar', () => setSidebarHidden(!sidebarIsHidden()));
// In the app the File menu's key equivalent gets there first and this never
// runs; in a browser during development it is the only way to print.
shortcut('print', 'mod+p', 'General', 'Print or export as PDF', () => { void printCurrent(); });
shortcut('new-canvas', 'mod+1', 'General', 'New canvas', () => createFile('canvas'));
shortcut('new-doc', 'mod+2', 'General', 'New document', () => createFile('doc'));
shortcut('new-deck', 'mod+3', 'General', 'New flashcard deck', () => createFile('deck'));
// ⇧⌘N, matching Finder — in the app ⌘N opens a second window instead.
shortcut('new-folder', 'mod+shift+n', 'General', 'New folder', () => newFolder(), { inInput: false });
shortcut('go-settings', 'mod+,', 'Navigation', 'Settings', () => navigate('settings'));
shortcut('focus', 'mod+shift+f', 'General', 'Open or minimise focus mode', () => toggleFocus());

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { closeMenu(); closePalette(); }
});

/* ── reachability ─────────────────────────────────────────────────────── */

/**
 * What the app shows when its own server stops answering.
 *
 * The server is a child process on this Mac, so this is a passing condition
 * with an end — a restart, a slow migration on first launch — not a state the
 * student has to do anything about. It says so, keeps checking, and puts
 * itself away when the answer comes back. Nothing is thrown away in the
 * meantime: an unsaved document keeps retrying its own save.
 */
let offlineBar = null;
let watchTimer = 0;
let watchDelay = 0;

function showOffline() {
  if (offlineBar) return;
  offlineBar = el('div', { class: 'offline-bar' },
    icon('plugs', { size: 14 }),
    el('span', { text: 'Studex cannot reach its own server. Retrying…' }),
    el('button', { class: 'btn', text: 'Try now', onclick: () => probe(true) }),
  );
  document.body.appendChild(offlineBar);
  watchDelay = 1_000;
  scheduleProbe();
}

function hideOffline() {
  clearTimeout(watchTimer);
  watchTimer = 0;
  offlineBar?.remove();
  offlineBar = null;
}

function scheduleProbe() {
  clearTimeout(watchTimer);
  // Backs off to a ten-second check rather than hammering a process that is
  // probably busy doing the very thing that will bring it back.
  watchTimer = setTimeout(() => probe(false), watchDelay);
  watchDelay = Math.min(watchDelay * 2, 10_000);
}

async function probe(immediate) {
  try {
    await api.health();
    hideOffline();
    // Whatever is on screen was drawn from data that may have moved on.
    if (state.user) { await loadLibrary(); lastLibraryLoad = Date.now(); renderRoute(); }
  } catch {
    if (immediate) watchDelay = 1_000;
    scheduleProbe();
  }
}

onReachabilityChange((up) => { if (up) hideOffline(); else showOffline(); });

/* ── catching up on what synced behind the window ─────────────────────── */

/**
 * The server syncs on its own timer, so files can arrive from another Mac
 * while this window is in the background — and until something asks, the
 * library on screen is a snapshot from whenever it was last loaded.
 *
 * Coming back to the window is the moment that matters, because it is the
 * moment somebody looks. Only the library is reloaded, deliberately: a full
 * re-render would throw away whatever is half-typed in an open document, and
 * the sidebar redraw that notify() triggers is the visible part anyway.
 */
const REFRESH_AFTER_MS = 30_000;
let lastLibraryLoad = Date.now();

async function catchUp() {
  if (!state.user || !state.ready) return;
  if (Date.now() - lastLibraryLoad < REFRESH_AFTER_MS) return;
  lastLibraryLoad = Date.now();
  try {
    await loadLibrary();
  } catch {
    // An unreachable server is already the offline bar's problem, and a
    // failed background refresh is not worth interrupting anybody over.
  }
}

window.addEventListener('focus', () => void catchUp());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void catchUp();
  liveWatch();
});

/**
 * The other half of live sync.
 *
 * The server can now be told by the project that a row moved and pull it
 * within seconds, which is worth very little if the window somebody is looking
 * at still shows what it loaded an hour ago. Focus is the wrong moment here:
 * the case this exists for is two Macs open at once, where the window never
 * loses focus at all.
 *
 * So while the window is visible this asks the local server — not the project
 * — whether a sync has finished since the last time it asked, and reloads the
 * library only when one has. It is a request to a server on this machine
 * carrying two counters, and it stops entirely when the window is hidden.
 */
const LIVE_POLL_MS = 20_000;
let liveTimer = null;
let lastFinishedAt = null;

async function pollSync() {
  if (!state.user || !state.ready) return;
  try {
    const status = await api.syncStatus();
    if (!status.live?.enabled) {
      // Nothing is listening upstream, so polling for its results is waste.
      stopLiveWatch();
      return;
    }
    const finished = status.last?.finished_at ?? null;
    if (finished && finished !== lastFinishedAt) {
      const first = lastFinishedAt === null;
      lastFinishedAt = finished;
      // The first answer only establishes where we are; reloading on it would
      // throw away an open document for a sync that happened before the app
      // was even started.
      if (!first) {
        lastLibraryLoad = Date.now();
        await loadLibrary();
      }
    }
  } catch {
    // An unreachable server is the offline bar's problem, not this one's.
  }
}

function stopLiveWatch() {
  if (liveTimer === null) return;
  clearInterval(liveTimer);
  liveTimer = null;
}

/** Runs only while somebody could actually see the result. */
function liveWatch() {
  if (document.visibilityState !== 'visible' || !state.user) {
    stopLiveWatch();
    return;
  }
  if (liveTimer !== null) return;
  liveTimer = setInterval(() => void pollSync(), LIVE_POLL_MS);
  void pollSync();
}

/* ── session lifecycle ────────────────────────────────────────────────── */

let sessionLost = false;

onUnauthorized(() => {
  if (sessionLost || !state.user) return;
  sessionLost = true;
  state.user = null;
  toast('Your session expired. Please sign in again.');
  showLogin();
});

function showLogin() {
  stopLiveWatch();
  // The watch is a timer and a memory, and stopping the timer leaves the
  // memory. It holds when the last sync finished for the account that just
  // signed out; the next account's first answer is then a different timestamp
  // rather than the first one, so its opening poll reloads the library twenty
  // seconds in and takes whatever was open down with it. Forgetting is the
  // whole of the fix.
  lastFinishedAt = null;
  disposeAll();
  document.documentElement.style.removeProperty('--split');
  closeMenu();
  closePalette();
  mount(root, el('div', { class: 'app' },
    dragStrip(),
    el('div', { class: 'shell' }, loginView(() => start())),
  ));
}

/**
 * A share link is the one route that runs in front of the session rather than
 * behind it. The token in the address is the credential, so this has to be
 * decided before `me()` is ever called — otherwise the first thing someone
 * following a link would see is a sign-in page for an account they do not have.
 */
function isShareRoute(route = currentRoute()) {
  return route.path[0] === 's';
}

/** True while a share link is what is on screen. */
let sharedOpen = false;

async function showShared() {
  sharedOpen = true;
  sessionLost = false;
  disposeAll();
  closeMenu();
  closePalette();

  const container = el('div', { class: 'shell share-shell' });
  mount(root, el('div', { class: 'app' }, dragStrip(), container));

  const pane = panes[0];
  const token = ++pane.token;
  try {
    const result = await sharedView(currentRoute(), container);
    if (token !== pane.token) return;
    if (typeof result === 'function') pane.dispose = result;
  } catch (err) {
    if (token !== pane.token) return;
    mount(container, el('div', { class: 'empty-state' },
      icon('warning-circle'),
      el('div', { text: err?.message ?? 'This link could not be opened.' }),
    ));
  }
}

/**
 * One boot at a time. Get Started, "Try again", sign-in and leaving a share
 * link can all call this, and a double-click or a held Return used to run it
 * twice at once: two shells mounted over each other and two library loads
 * racing, the slower of which overwrote the newer state. A call made while
 * one is running waits for that one instead.
 */
let booting = null;
function start() {
  if (!booting) booting = boot().finally(() => { booting = null; });
  return booting;
}

async function boot() {
  sessionLost = false;
  if (isShareRoute()) { await showShared(); return; }
  sharedOpen = false;
  try {
    const { user } = await api.me();
    state.user = user;
  } catch (err) {
    if (err?.status === 0) {
      mount(root, el('div', { class: 'app' },
        dragStrip(),
        el('div', { class: 'empty-state', style: { flex: '1' } },
          icon('plugs'),
          el('div', { text: 'Cannot reach the Studex server.' }),
          el('button', { class: 'btn', text: 'Try again', onclick: () => start() }),
        ),
      ));
      return;
    }
    showLogin();
    return;
  }

  mount(root, shellFrame());
  restoreSplit();
  await Promise.all([loadSettings(), loadLibrary()]);
  lastLibraryLoad = Date.now();
  state.ready = true;
  startNotifications();
  startBadge();
  void initFocus();
  startUpdates();
  syncSpotlight();
  liveWatch();

  if (!location.hash) navigate('home', { replace: true });
  else renderRoute();
}

setRerender(() => { void renderRoute(); });
// Handoff from another Mac, a Spotlight result, a studex:// link — the shell
// resolves all three to a route and this is where they land.
onNavigate((route) => { if (String(route).includes('|')) restoreWindow(route); else navigate(route); });
onRoute((route) => {
  if (isShareRoute(route)) { void showShared(); return; }
  // Leaving a share link is a return to the app proper, which for a visitor
  // with no session means the sign-in screen rather than a blank one.
  if (sharedOpen) { sharedOpen = false; void start(); return; }
  // Only the pane that moved: opening something on the right must not tear
  // down the page being read on the left.
  if (state.user) renderRoute({ force: false });
});
subscribe(() => {
  const sidebar = document.getElementById('sidebar');
  if (sidebar && state.user) renderSidebar(sidebar);
});

if (hasOnboarded() || isShareRoute()) start();
else mount(root, el('div', { class: 'app' }, dragStrip(), onboardingView(() => start())));
