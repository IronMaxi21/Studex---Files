/** The app shell: title bar, sidebar in its three layouts, and the top bar. */
import { el, icon, mount, applyColor, clear, folderGlyph, colorValue } from './dom.js';
import { state, childFolders, filesInFolder, folderById, setSidebarHidden, sidebarIsHidden, toast, tagsOnItem } from './store.js';
import { FILE_ICON } from './format.js';
import { navigate, currentRoute, isSplit, openBeside, canSplit, swapPanes, closePane, isPinned, setPinned } from './router.js';
import { openMenu } from './menu.js';
import { openFeedbackSheet } from './feedback.js';
import { openPalette } from './palette.js';
import { logoMark } from './logo.js';
import { chatButton } from './chat.js';
import { resetTips } from './tips.js';
import { dragItem, dropInto } from './dnd.js';

const SECTIONS = [
  { id: 'home', label: 'Home', icon: 'house' },
  { id: 'library', label: 'Library', icon: 'folders' },
  { id: 'study', label: 'Study', icon: 'graduation-cap' },
  { id: 'topics', label: 'Topics', icon: 'target' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar-blank' },
  { id: 'timetable', label: 'Timetable', icon: 'clock-countdown' },
  { id: 'stats', label: 'Statistics', icon: 'chart-line-up' },
];

/**
 * The second level of navigation, shown as a bar across the top of the screen
 * it belongs to rather than as a disclosure inside the sidebar. A section with
 * one screen has no bar.
 */
export const SUBNAV = {
  study: [
    { id: 'review', label: 'Daily review' },
    { id: 'flashcards', label: 'Decks' },
    { id: 'test', label: 'Test me' },
  ],
  calendar: [
    { id: 'calendar', label: 'Day' },
    { id: 'calendar/week', label: 'Week' },
    { id: 'calendar/month', label: 'Month' },
    { id: 'calendar/deadlines', label: 'Deadlines' },
  ],
  topics: [
    { id: 'topics', label: 'Matrix' },
    { id: 'topics/due', label: 'Due' },
  ],
  timetable: [
    { id: 'timetable', label: 'Lessons' },
  ],
};

/** Which section the current route belongs to, for the active highlight. */
function activeSection(route) {
  const head = route.path[0] ?? 'home';
  if (head === 'review' || head === 'flashcards' || head === 'deck' || head === 'test') return 'study';
  if (head === 'folder' || head === 'doc' || head === 'canvas' || head === 'pdf') return 'library';
  if (head === 'calendar') return 'calendar';
  return head;
}

export function renderSidebar(host) {
  const layout = state.device?.shell_layout ?? 'folder_tree';
  clear(host);
  if (layout === 'icon_rail') return renderRail(host);
  if (layout === 'workspace_tabs') return; // tabs live above the content instead
  return renderTree(host);
}

/* ── folder tree (default shell) ──────────────────────────────────────── */

function renderTree(host) {
  const route = currentRoute();
  const active = activeSection(route);
  const dueTotal = state.files.reduce((sum, f) => sum + (f.due_count ?? 0), 0);

  /* A landmark, not a stack of buttons: `aria-current` is what makes the
     highlight mean something to a reader, and it is the same fact the
     `active` class draws. */
  const nav = el('nav', { class: 'nav-group', 'aria-label': 'Sections' });
  for (const section of SECTIONS) {
    const isActive = active === section.id;
    const item = el('button', {
      class: 'nav-item' + (isActive ? ' active' : ''),
      'aria-current': isActive ? 'page' : null,
      onclick: () => navigate(section.id === 'study' ? 'review' : section.id),
    },
      icon(section.icon),
      section.label,
      section.id === 'study' && dueTotal > 0
        ? el('span', { class: 'count', 'aria-label': `${dueTotal} cards due`, text: `${dueTotal} due` })
        : null,
    );
    // Library is the top of the tree, so it is where something dropped comes
    // back out of every folder it was in.
    if (section.id === 'library') dropInto(item, null);
    nav.appendChild(item);
  }

  const folderList = el('nav', { class: 'nav-group', 'aria-label': 'Files' });
  {
    for (const folder of childFolders(null)) {
      if (!folder.pinned) folderList.appendChild(folderNode(folder, host));
    }
    // A file made without a folder belongs to no folder node, so it used to be
    // absent from the tree entirely — created, then apparently nowhere.
    for (const file of filesInFolder(null)) {
      if (!file.pinned) folderList.appendChild(fileNode(file));
    }
  }

  // A pin moves a thing to the top rather than copying it there. Drawn in both
  // places, the same folder answered to two rows in one short list, and
  // collapsing one did nothing to the other — which reads as a bug whichever
  // of the two you were looking at.
  const pinnedFolders = state.folders.filter((f) => f.pinned);
  const pinnedFiles = state.files.filter((f) => f.pinned);
  const pinnedOpen = !state.expanded.has('pinned:collapsed');
  const pinnedList = el('nav', { class: 'nav-group', 'aria-label': 'Pinned' });
  if (pinnedOpen) {
    for (const folder of pinnedFolders) pinnedList.appendChild(pinnedFolderNode(folder));
    for (const file of pinnedFiles) pinnedList.appendChild(fileNode(file, { flat: true }));
  }
  const hasPinned = pinnedFolders.length > 0 || pinnedFiles.length > 0;

  mount(host,
    // The sidebar's own header is now the window's drag handle: the strip
    // that used to be one is gone, and this is the piece of chrome that was
    // already at the top of the window.
    // The name and mark stay out of the way until the pointer is over this
    // corner; search and the sidebar toggle are always a click away beside it.
    el('div', { class: 'brand', dataset: { appRegion: 'drag' } },
      el('span', { class: 'brand-id' }, logoMark(), el('span', { text: 'Studex' })),
      el('span', { class: 'grow' }),
      el('button', {
        class: 'collapse no-drag', title: 'Search everything (⌘K)', 'aria-label': 'Search everything',
        onclick: () => openPalette(),
      }, icon('magnifying-glass', { size: 14 })),
      el('button', {
        class: 'collapse no-drag', title: 'Hide sidebar (⌘\\)',
        'aria-label': 'Hide sidebar',
        onclick: () => setSidebarHidden(true),
      }, icon('sidebar-simple', { size: 14 })),
    ),
    el('button', {
      class: 'create-btn', 'aria-haspopup': 'menu',
      onclick: (e) => openCreateMenu(e.currentTarget),
    }, icon('plus', { bold: true }), 'Create'),
    nav,
    // Only the tree scrolls: the header, sections and footer stay where they are.
    el('div', { class: 'sidebar-scroll' },
      hasPinned ? sectionToggle('PINNED', 'pinned:collapsed', pinnedOpen, host) : null,
      hasPinned ? pinnedList : null,
      folderList,
    ),
    el('div', { class: 'sidebar-foot' },
      el('button', {
        class: 'nav-item' + (['settings', 'trash'].includes(route.path[0]) ? ' active' : ''),
        'aria-current': ['settings', 'trash'].includes(route.path[0]) ? 'page' : null,
        onclick: () => navigate('settings'),
      }, icon('gear'), 'Settings'),
      el('button', {
        class: 'nav-item', 'aria-haspopup': 'menu',
        onclick: (e) => openAccountMenu(e.currentTarget),
      },
        el('span', { class: 'avatar', 'aria-hidden': 'true', text: initials(state.user?.display_name) }),
        state.user?.display_name ?? 'Account',
        icon('caret-up-down', { class: 'grow', size: 12 })),
    ),
  );
}

/** A section heading that is also the control for folding the section away. */
function sectionToggle(label, key, open, host) {
  return el('button', {
    class: 'section-label', style: { background: 'none', border: 0 },
    'aria-expanded': open ? 'true' : 'false',
    onclick: () => {
      if (open) state.expanded.add(key);
      else state.expanded.delete(key);
      renderSidebar(host);
    },
  }, icon(open ? 'caret-down' : 'caret-right'), label);
}

/** The star is the pin: filled and accent when set, an outline on hover when not. */
function pinButton(entity, kind) {
  const pinned = Boolean(entity.pinned);
  return el('button', {
    class: 'pin' + (pinned ? ' on' : ''),
    title: pinned ? 'Unpin' : 'Pin to the top',
    // The star is filled or hollow; neither of those is a word.
    'aria-label': pinned ? `Unpin ${entity.name ?? entity.title ?? ''}`.trim() : `Pin ${entity.name ?? entity.title ?? ''}`.trim(),
    'aria-pressed': pinned ? 'true' : 'false',
    onclick: async (event) => {
      event.stopPropagation();
      try {
        if (kind === 'folder') await createHandlers.setFolderPinned?.(entity, !pinned);
        else await createHandlers.setFilePinned?.(entity, !pinned);
      } catch { /* reported by the handler */ }
    },
  }, icon('star', { bold: pinned, size: 12 }));
}

function folderNode(folder, host) {
  const route = currentRoute();
  const open = state.expanded.has('folder:' + folder.id);
  const isActive = route.path[0] === 'folder' && route.path[1] === folder.id;

  const node = el('button', {
    class: 'tree-folder' + (isActive ? ' active' : ''),
    'aria-current': isActive ? 'page' : null,
    // One control that both opens the folder and folds it, so it says both.
    'aria-expanded': open ? 'true' : 'false',
    oncontextmenu: (e) => { e.preventDefault(); openFolderMenu(folder, e.clientX, e.clientY); },
    onclick: () => {
      if (state.expanded.has('folder:' + folder.id)) state.expanded.delete('folder:' + folder.id);
      else state.expanded.add('folder:' + folder.id);
      navigate(`folder/${folder.id}`);
    },
  },
    icon(open ? 'caret-down' : 'caret-right', { class: 'caret' }),
    folderGlyph(folder.effective_color, { open, size: 16 }),
    el('span', { class: 'label', text: folder.name }),
    pinButton(folder, 'folder'),
    el('i', {
      class: 'ph ph-dots-three more',
      'aria-hidden': 'true',
      onclick: (e) => { e.stopPropagation(); openFolderMenu(folder, e.clientX, e.clientY); },
    }),
  );
  applyColor(node, folder.effective_color);
  // The tree is the shortest path between any two folders in the account, so
  // it is the most useful place in the app to let go of something.
  dragItem(node, { kind: 'folder', id: folder.id, title: folder.name });
  dropInto(node, folder.id);

  const wrap = el('div', null, node);
  if (open) {
    // Pinned children are up in PINNED; drawing them here as well would be the
    // same row twice in one list.
    for (const child of childFolders(folder.id)) {
      if (!child.pinned) wrap.appendChild(folderNode(child, host));
    }
    for (const file of filesInFolder(folder.id)) {
      if (!file.pinned) wrap.appendChild(fileNode(file));
    }
  }
  return wrap;
}

/**
 * One file in the tree, wherever it hangs from. `flat` is the pinned list,
 * which is not a tree: nothing there is inside anything, so the indent that
 * says "this belongs to the folder above" would be saying something untrue.
 */
/** Up to three coloured dots for the tags on a file, so a link shows without opening it. */
function tagDots(id) {
  const tags = tagsOnItem(id);
  if (!tags.length) return null;
  return el('span', { class: 'tree-tags', title: tags.map((t) => `#${t.name}`).join(' ') },
    tags.slice(0, 3).map((tag) => el('span', {
      class: 'tree-tag-dot',
      style: { background: tag.color ? colorValue(tag.color) : 'var(--color-accent)' },
    })));
}

function fileNode(file, opts = {}) {
  const route = currentRoute();
  const node = el('button', {
    class: 'tree-file' + (opts.flat ? ' flat' : '') + (route.path[1] === file.id ? ' active' : ''),
    'aria-current': route.path[1] === file.id ? 'page' : null,
    oncontextmenu: (e) => { e.preventDefault(); createHandlers.fileMenu?.(file, e.clientX, e.clientY); },
    onclick: () => navigate(`${file.kind}/${file.id}`),
  },
    icon(FILE_ICON[file.kind] ?? 'file'),
    el('span', { class: 'label', text: file.title }),
    tagDots(file.id),
    pinButton(file, 'file'),
  );
  applyColor(node, file.effective_color);
  dragItem(node, { kind: 'file', id: file.id, title: file.title, fileKind: file.kind });
  return node;
}

/**
 * A pinned folder, shown as a shortcut rather than as a second copy of the
 * tree. It opens the folder; what is inside it is one place, further down.
 */
function pinnedFolderNode(folder) {
  const route = currentRoute();
  const isActive = route.path[0] === 'folder' && route.path[1] === folder.id;

  const node = el('button', {
    class: 'tree-folder flat' + (isActive ? ' active' : ''),
    'aria-current': isActive ? 'page' : null,
    oncontextmenu: (e) => { e.preventDefault(); openFolderMenu(folder, e.clientX, e.clientY); },
    onclick: () => navigate(`folder/${folder.id}`),
  },
    folderGlyph(folder.effective_color, { open: isActive, size: 16 }),
    el('span', { class: 'label', text: folder.name }),
    pinButton(folder, 'folder'),
    el('i', {
      class: 'ph ph-dots-three more',
      'aria-hidden': 'true',
      onclick: (e) => { e.stopPropagation(); openFolderMenu(folder, e.clientX, e.clientY); },
    }),
  );
  applyColor(node, folder.effective_color);
  dragItem(node, { kind: 'folder', id: folder.id, title: folder.name });
  dropInto(node, folder.id);
  return node;
}

/* ── icon rail shell ──────────────────────────────────────────────────── */

function renderRail(host) {
  const route = currentRoute();
  const active = activeSection(route);
  host.className = 'rail';

  /* Every button here is a glyph and a tooltip. A tooltip is not a name — it
     needs a hover to exist at all — so each one also carries the word. */
  const btn = (section) => el('button', {
    class: 'rail-btn' + (active === section.id ? ' active' : ''),
    title: section.label,
    'aria-label': section.label,
    'aria-current': active === section.id ? 'page' : null,
    onclick: () => navigate(section.id === 'study' ? 'review' : section.id),
  }, icon(section.icon));

  mount(host,
    el('div', { class: 'rail-mark', dataset: { appRegion: 'drag' } }, logoMark()),
    el('button', {
      class: 'rail-btn primary', title: 'Create', 'aria-label': 'Create', 'aria-haspopup': 'menu',
      onclick: (e) => openCreateMenu(e.currentTarget),
    }, icon('plus', { bold: true })),
    el('button', {
      class: 'rail-btn', title: 'Search everything (⌘K)', 'aria-label': 'Search everything',
      onclick: () => openPalette(),
    }, icon('magnifying-glass')),
    // The same list, in the same order, with the same glyphs as the tree draws
    // down the side. Two layouts of one app that disagree about where Calendar
    // comes are two apps.
    SECTIONS.map(btn),
    el('div', { class: 'rail-foot' },
      el('button', {
        class: 'rail-btn', title: 'Hide sidebar (⌘\\)', 'aria-label': 'Hide sidebar',
        onclick: () => setSidebarHidden(true),
      }, icon('sidebar-simple')),
      el('button', {
        class: 'rail-btn' + (active === 'settings' ? ' active' : ''),
        title: 'Settings', 'aria-label': 'Settings',
        'aria-current': active === 'settings' ? 'page' : null,
        onclick: () => navigate('settings'),
      }, icon('gear')),
      el('button', {
        class: 'avatar', 'aria-haspopup': 'menu',
        'aria-label': `Account: ${state.user?.display_name ?? 'signed in'}`,
        onclick: (e) => openAccountMenu(e.currentTarget),
        text: initials(state.user?.display_name),
      }),
    ),
  );
}

/* ── top bar ──────────────────────────────────────────────────────────── */

/* The icon and landing route for each name that can appear in a path, so the
   bar can draw where you came from as a single control. */
const CRUMB = {
  home: { icon: 'house', to: 'home' },
  library: { icon: 'folders', to: 'library' },
  study: { icon: 'graduation-cap', to: 'review' },
  calendar: { icon: 'calendar-blank', to: 'calendar' },
  timetable: { icon: 'clock-countdown', to: 'timetable' },
  statistics: { icon: 'chart-line-up', to: 'stats' },
  settings: { icon: 'gear', to: 'settings' },
  flashcards: { icon: 'cards', to: 'flashcards' },
  test: { icon: 'exam', to: 'test' },
};

function crumbPart(part) {
  const label = typeof part === 'string' ? part : part.label;
  const known = CRUMB[label.toLowerCase()] ?? {};
  const given = typeof part === 'object' ? part : {};
  return {
    label,
    to: given.to ?? known.to ?? null,
    icon: given.icon ?? known.icon ?? null,
    color: given.color ?? null,
  };
}

/**
 * The trail from the library down to a file, built from the folder each one
 * hangs off rather than from wherever the screen happened to be opened.
 *
 * A document inside Chemistry belongs to Chemistry, so that is what going back
 * from it has to mean. A single "Library" link is the same link from every
 * file in the account, which is another way of saying it is not a trail.
 */
export function fileCrumbs(file) {
  const chain = [];
  let cursor = file?.folder_id ? folderById(file.folder_id) : null;
  const seen = new Set();
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    chain.unshift({
      label: cursor.name,
      to: `folder/${cursor.id}`,
      icon: 'folder',
      color: cursor.effective_color,
    });
    cursor = cursor.parent_id ? folderById(cursor.parent_id) : null;
  }
  return [{ label: 'Library', to: 'library' }, ...chain, { label: file?.title ?? 'Untitled' }];
}

function crumbGlyph(part) {
  if (part.icon === 'folder') return folderGlyph(part.color, { size: 14 });
  return part.icon ? icon(part.icon, { size: 14 }) : null;
}

/**
 * A step of the path that a file can be dropped onto. Dragging a document up
 * two folders is otherwise a menu, a dialog and a tree to find your way back
 * down; the trail is already showing where "up" is.
 */
function crumbDrop(node, to) {
  if (to === 'library') return dropInto(node, null);
  if (typeof to === 'string' && to.startsWith('folder/')) return dropInto(node, to.slice('folder/'.length));
  return node;
}

function crumbLink(part, { current }) {
  if (current || !part.to) {
    return el('span', {
      class: 'crumb-step here',
      'aria-current': current ? 'page' : null,
    }, crumbGlyph(part), el('span', { text: part.label }));
  }
  return crumbDrop(el('button', {
    class: 'crumb-step',
    title: `Go to ${part.label}`,
    onclick: () => navigate(part.to),
  }, crumbGlyph(part), el('span', { text: part.label })), part.to);
}

/**
 * The path across the top, cut down to one step: the page this one sits in.
 *
 * A file's own name is already the title on the page, so it is not repeated
 * here until the pointer is over the path. A screen at the top of its section
 * (nothing above it) shows its own name instead, since that is all there is.
 * The parent is still a link and still a drop target for files.
 */
export function topbar(crumbs, ...extras) {
  // A plain `{ bare: true }` among the extras leaves off the AI button and the
  // ⋯ menu, for screens that are a place to look rather than to work.
  const bare = extras.some((e) => e && !(e instanceof Node) && e.bare);
  extras = extras.filter((e) => e instanceof Node);
  const parts = crumbs.map(crumbPart);
  const parent = parts.length > 1 ? parts[parts.length - 2] : null;
  const current = parts[parts.length - 1];

  const trail = el('nav', { class: 'crumbs' + (parent ? ' has-parent' : ''), 'aria-label': 'Breadcrumb' });
  if (parent) {
    trail.appendChild(crumbLink(parent, { current: false }));
    trail.appendChild(el('span', { class: 'crumb-sep crumb-reveal', 'aria-hidden': 'true', text: '/' }));
    const here = crumbLink(current, { current: true });
    here.classList.add('crumb-reveal');
    trail.appendChild(here);
  } else if (current) {
    trail.appendChild(crumbLink(current, { current: true }));
  }

  // Most of a screen's own controls belong on the right; a screen whose name
  // appears nowhere else marks it `lead` so it sits beside the path.
  const lead = extras.filter((e) => e && e.classList?.contains('lead'));
  const trailing = extras.filter((e) => e && !e.classList?.contains('lead'));
  const bar = el('div', { class: 'topbar', dataset: { appRegion: 'drag' } },
    // Only shown when the sidebar is away: it is the way back to it, and the
    // only control that has to survive the sidebar being gone.
    sidebarIsHidden()
      ? el('button', {
          class: 'reveal', title: 'Show sidebar (⌘\\)', 'aria-label': 'Show sidebar',
          onclick: () => setSidebarHidden(false),
        }, icon('sidebar-simple'))
      : null,
    trail,
    ...lead,
    el('span', { class: 'grow' }),
    // Search lives in the sidebar. With the sidebar away it would have no
    // visible way in at all, so it comes back here for as long as that lasts.
    sidebarIsHidden()
      ? el('button', {
          class: 'chip', title: 'Search everything (⌘K)', 'aria-label': 'Search everything',
          onclick: () => openPalette(),
        }, icon('magnifying-glass'))
      : null,
    ...trailing.filter((e) => !e.classList?.contains('page-menu')),
    bare ? null : chatButton(),
    bare ? null : (trailing.find((e) => e.classList?.contains('page-menu')) ?? pageMenu()),
  );

  // A chip's words go in a span of their own so a narrow pane can drop them
  // and keep the icon; the words stay on as the tooltip. This runs over the
  // finished bar, not just the screen's extras: a chip the bar adds itself
  // (Ask AI) or one inside a group kept its words as a bare text node, and the
  // icon-only rule then squared it and let the words spill out.
  for (const chip of bar.querySelectorAll('.chip')) {
    if (!chip.querySelector(':scope > i')) continue;
    for (const node of [...chip.childNodes]) {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) continue;
      if (!chip.title) chip.title = node.textContent.trim();
      node.replaceWith(el('span', { class: 'chip-label', text: node.textContent }));
    }
  }
  return bar;
}

/**
 * The ⋯ at the end of every top bar: the page's own actions, then the window's.
 *
 * One menu rather than a row of chips, because a row of chips is what stops a
 * page fitting in half a window. `items` is called at the moment of opening,
 * so what it lists (a file's pin state, whether AI is on) is never stale. The
 * split belongs to the window rather than to any one screen, and the page that
 * closes is the one whose menu was opened.
 */
export function pageMenu(items = () => [], { title = 'Page options' } = {}) {
  return el('button', {
    class: 'chip page-menu', title, 'aria-label': title, 'aria-haspopup': 'menu',
    onclick: (event) => {
      const button = event.currentTarget;
      const rect = button.getBoundingClientRect();
      const pane = button.closest('.pane');
      const own = items().filter(Boolean);
      const panes = isSplit()
        ? [
            Number(pane?.dataset.pane ?? '0') === 1
              ? { icon: isPinned() ? 'push-pin-slash' : 'push-pin', label: isPinned() ? 'Unpin this page' : 'Pin this page here', onSelect: () => { setPinned(!isPinned()); toast(isPinned() ? 'Pinned. Everything else opens on the left.' : 'Unpinned.'); } }
              : null,
            { icon: 'arrows-left-right', label: 'Swap the two pages', onSelect: () => swapPanes() },
            { icon: 'x', label: 'Close this page', kbd: '⌘⌥\\', onSelect: () => closePane(Number(pane?.dataset.pane ?? '0')) },
          ]
        : canSplit(currentRoute().hash)
          ? [{
              icon: 'square-split-horizontal', label: 'Open a page beside', kbd: '⌘⌥\\',
              onSelect: () => openBeside('beside'),
            }]
          : [];
      openMenu({ x: rect.right - 230, y: rect.bottom + 6 }, [...own, own.length && panes.length ? { sep: true } : null, ...panes].filter(Boolean));
    },
  }, icon('dots-three'));
}

/**
 * The section's second level, as a bar under the top bar rather than a
 * disclosure inside the sidebar. Extras sit on the right — a screen's own
 * controls (month paging, "Today") now live here instead of over the grid.
 */
export function subnav(sectionId, activeId, ...extras) {
  const items = SUBNAV[sectionId] ?? [];
  const bar = el('div', { class: 'subbar' });
  if (items.length) {
    bar.appendChild(el('nav', { class: 'seg', 'aria-label': 'Views' }, items.map((item) => el('button', {
      class: item.id === activeId ? 'on' : '',
      'aria-current': item.id === activeId ? 'page' : null,
      text: item.label,
      onclick: () => { if (item.id !== activeId) navigate(item.id); },
    }))));
  }
  for (const extra of extras.filter(Boolean)) bar.appendChild(extra);
  return bar;
}

/* ── menus ────────────────────────────────────────────────────────────── */

let createHandlers = {};
export function setCreateHandlers(handlers) { createHandlers = handlers; }
/** The app's own actions, for screens that offer one of them in their own chrome. */
export function appActions() { return createHandlers; }

/**
 * A file's own menu rows, for the ⋯ on the page that file is open in. "Open
 * Beside" is dropped there: from inside the page it would open the same page
 * twice, which is never what was meant.
 */
export function fileItems(file) {
  return (createHandlers.fileMenuItems?.(file) ?? []).filter((item) => item.label !== 'Open Beside');
}

export function openCreateMenu(anchor) {
  const rect = anchor.getBoundingClientRect();
  openMenu({ x: rect.left, y: rect.bottom + 6 }, [
    { head: 'CREATE' },
    { icon: 'infinity', label: 'Canvas', kbd: '⌘1', onSelect: () => createHandlers.create?.('canvas') },
    { icon: 'file-text', label: 'Document', kbd: '⌘2', onSelect: () => createHandlers.create?.('doc') },
    { icon: 'cards', label: 'Flashcard deck', kbd: '⌘3', onSelect: () => createHandlers.create?.('deck') },
    { icon: 'folder-plus', label: 'Folder', onSelect: () => promptNewFolder() },
    { sep: true },
    { icon: 'calendar-plus', label: 'Event, exam or assignment', onSelect: () => createHandlers.event?.() },
    { icon: 'file-arrow-up', label: 'Import a file…', onSelect: () => createHandlers.addPdf?.() },
  ]);
}

function openAccountMenu(anchor) {
  const rect = anchor.getBoundingClientRect();
  openMenu({ x: rect.left, y: rect.top - 8, anchorBottom: true }, [
    { head: state.user?.email ?? 'Account' },
    { icon: 'user', label: 'Account settings', onSelect: () => navigate('settings/account') },
    { icon: 'paint-brush', label: 'Appearance', onSelect: () => navigate('settings') },
    { sep: true },
    { icon: 'lightbulb', label: 'Show tips again', onSelect: () => { resetTips(); toast('Tips will show again on each page.'); } },
    { icon: 'paper-plane-tilt', label: 'Send feedback…', onSelect: () => void openFeedbackSheet('improvement') },
    { sep: true },
    { icon: 'sign-out', label: 'Sign out', onSelect: () => createHandlers.signOut?.() },
  ]);
}

function openFolderMenu(folder, x, y) {
  createHandlers.folderMenu?.(folder, x, y);
}

function promptNewFolder() { createHandlers.newFolder?.(); }

function initials(name) {
  if (!name) return '?';
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
}
