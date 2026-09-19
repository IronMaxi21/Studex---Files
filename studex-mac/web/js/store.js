/** Shared application state: session, library tree, settings, and toasts. */
import { api } from './api.js';
import { log } from './log.js';

const listeners = new Set();

export const state = {
  user: null,
  settings: null,
  device: null,
  /**
   * What this build offers. Filled in at sign-in; until then, and if the call
   * ever fails, every screen is drawn — the flags take things away, so a
   * missing answer must not be the one that takes the app apart.
   */
  capabilities: { channel: 'dev', developer: true, layoutChoice: true, betaChannel: true },
  subjects: [],
  folders: [],
  files: [],
  /** Every tag, and the ids of the tags on each folder or file. */
  tags: [],
  tagsByItem: new Map(),
  expanded: new Set(),
  /** Whether the sidebar is out of the way. Per device, so it is kept here. */
  sidebarHidden: localStorage.getItem('studex.sidebar') === 'hidden',
  /**
   * Whether the window is too narrow to hold a sidebar and a page at once.
   *
   * At the minimum window size, and at any window at 200% interface zoom, the
   * 246px sidebar is half of what there is. So below that width it stops being
   * a column and becomes an overlay that is out of the way by default —
   * `sidebarPeek` is the temporary showing of it, kept apart from
   * `sidebarHidden` so that a narrow window never rewrites the preference the
   * student set in a wide one.
   */
  narrow: false,
  sidebarPeek: false,
  openTabs: [],
  activeTab: null,
  ready: false,
};

/**
 * Set by the bootstrap so views can ask for a full re-render without importing
 * app.js — which would make the module graph circular.
 */
let rerenderHook = null;
export function setRerender(fn) { rerenderHook = fn; }
export function rerender() { return rerenderHook?.(); }

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify() {
  for (const fn of listeners) fn();
}

/**
 * A stable per-installation id. Device settings (shell layout, canvas chrome)
 * are deliberately per-device on the server, so this is the key that keeps one
 * machine's layout from following the account onto another.
 */
export function deviceId() {
  let id = localStorage.getItem('studex.device');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('studex.device', id);
  }
  return id;
}

export async function loadLibrary() {
  const [subjects, folders, files] = await Promise.all([
    api.subjects(),
    api.folders(),
    api.allFiles({ sort: 'recent' }),
  ]);
  state.subjects = subjects.subjects;
  state.folders = folders.folders;
  state.files = files.files;
  await loadTags({ quiet: true });
  notify();
}

/**
 * The tag links for the whole account. A failure leaves the last known links:
 * dots are a convenience, and a library that will not open without them would
 * be the wrong trade.
 */
let tagsInFlight = null;
export function loadTags({ quiet = false } = {}) {
  // Collapse concurrent callers onto one request. Rapidly leaving the library
  // and coming back — or two panes reaching for tags at once — would otherwise
  // each fire the same /api/tags/links and race to overwrite the same state,
  // because the library only marks `state.tagsLoaded` after this resolves.
  // Each caller still applies its own `quiet`, even one that joined a request
  // already in flight.
  if (!tagsInFlight) tagsInFlight = runLoadTags().finally(() => { tagsInFlight = null; });
  return tagsInFlight.then(() => { if (!quiet) notify(); });
}

async function runLoadTags() {
  try {
    const { tags, links } = await api.tagLinks();
    state.tags = tags;
    const byItem = new Map();
    for (const link of links) {
      if (!byItem.has(link.item_id)) byItem.set(link.item_id, []);
      byItem.get(link.item_id).push(link.tag_id);
    }
    state.tagsByItem = byItem;
  } catch { /* keep what was there */ }
}

/** Whether this build offers something: `may('layoutChoice')`. */
export function may(name) {
  return state.capabilities?.[name] !== false;
}

/** The tags on one folder or file, in name order. */
export function tagsOnItem(id) {
  const ids = state.tagsByItem.get(id);
  if (!ids?.length) return [];
  return state.tags.filter((t) => ids.includes(t.id));
}

export async function loadSettings() {
  const [account, device, build] = await Promise.all([
    api.settings(),
    api.deviceSettings(deviceId()),
    // Older servers have no such route. The app is the newer half of the pair
    // often enough — a build talking to a library it has just updated past —
    // that a 404 here means "no limits known", not "no app".
    api.capabilities().catch(() => null),
  ]);
  state.settings = account.settings;
  state.device = device.settings;
  if (build?.capabilities) state.capabilities = build.capabilities;
  applyTheme();
  notify();
}

/** Theme and accent follow the account; the shell layout is per-device. */
export function applyTheme() {
  const root = document.documentElement;
  const theme = state.settings?.theme ?? 'dark';
  const resolved = theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : theme;
  root.dataset.theme = resolved;
  // Kept for the next launch, which has to paint before it can ask. The
  // setting is stored rather than what it resolved to, so `system` still
  // follows the machine. theme.js reads it, first thing, out of the head.
  try { localStorage.setItem('studex.theme', theme); } catch { /* storage may be unavailable */ }

  // The original accents were brighter than the app now wants; an account
  // still holding one is shown its restrained counterpart. The default is
  // left to the tokens, so each theme uses its own contrast-safe shade.
  const LEGACY_ACCENTS = { '#6fa8d4': '#7896b4', '#5fb598': '#739f8c', '#b2ac5e': '#a89a6e', '#d1877a': '#b58a80' };
  const saved = state.settings?.accent?.toLowerCase();
  const accent = saved === '#9184d9' || saved === '#8a88b8' ? null : (LEGACY_ACCENTS[saved] ?? saved);
  // Up to three accents. The second and third are per device; with section
  // colouring on, Study takes the second and the planning screens the third.
  const extra = accentPrefs();
  const HEX = /^#[0-9a-fA-F]{6}$/;
  // Organic is the one family that owns its own colour. Its whole point is a
  // set of pigments that belong together — clay, moss, ink on paper — and an
  // arbitrary accent dropped into that is the one thing that makes it stop
  // looking like paper. So the three accents are left to the stylesheet here,
  // and Settings hides the pickers rather than offering a control that does
  // nothing. Every other family takes the account's accent as before.
  const fixedAccent = themeFamily() === 'organic';
  for (const [name, hex] of [['--color-accent-2', extra.secondary], ['--color-accent-3', extra.tertiary]]) {
    if (!fixedAccent && hex && HEX.test(hex)) root.style.setProperty(name, hex);
    else root.style.removeProperty(name);
  }
  const section = root.dataset.section;
  let effective = accent && HEX.test(accent) ? accent : null;
  if (extra.sections && section === 'study' && extra.secondary) effective = extra.secondary;
  if (extra.sections && section === 'plan' && extra.tertiary) effective = extra.tertiary;
  if (!fixedAccent && effective && HEX.test(effective)) root.style.setProperty('--color-accent', effective);
  else root.style.removeProperty('--color-accent');

  document.body.dataset.density = state.device?.density ?? 'compact';
  // Sidebar and page density are sliders now, kept per device. Until one is
  // moved they follow the old compact/comfortable setting.
  const dens = densityPrefs();
  root.style.setProperty('--sidebar-density-step', `${dens.sidebar}px`);
  document.body.style.setProperty('--density-step', `${dens.page}px`);
  document.body.dataset.density = dens.page >= 3 ? 'comfortable' : 'compact';
  // Document measure and type size are per-device too, and are read by CSS
  // rather than by the editor: nothing about a document itself changes.
  root.dataset.docWidth = state.device?.doc_width ?? 'regular';
  root.dataset.docType = state.device?.doc_type_size ?? 'regular';
  // Reading typeface and line spacing are read by CSS off these attributes,
  // the same way width and type size are, and cover the document column and the
  // flashcard face.
  root.dataset.docFont = state.device?.doc_font ?? 'system';
  root.dataset.lineSpacing = state.device?.line_spacing ?? 'normal';
  // The family is the *material* the app is made of; light/dark, the accent,
  // the palettes and high contrast all sit on top of it unchanged.
  const family = themeFamily();
  root.dataset.themeFamily = family;
  // Glass is what the glass family is. Leaving the toggle able to switch it off
  // would let someone pick the frosted theme and then turn the frost off, which
  // leaves a theme that is nothing in particular.
  root.dataset.glass = (family === 'glass' || glassEnabled()) && !transparencyReduced() ? 'on' : 'off';
  root.dataset.contrast = highContrast() ? 'high' : 'normal';
  if (state.device?.reduce_motion) root.dataset.reduceMotion = 'true';
  else delete root.dataset.reduceMotion;
}

window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (state.settings?.theme === 'system') applyTheme();
});

// Reduce Transparency can be turned on with Studex already open, and the point
// of turning it on is that it takes effect now.
try {
  window.matchMedia('(prefers-reduced-transparency: reduce)').addEventListener('change', () => applyTheme());
} catch { /* an older WebKit that has no opinion on the matter */ }

const FAMILY_KEY = 'studex.themeFamily';
/** The three shipped materials. Anything else saved falls back to the default. */
export const THEME_FAMILIES = ['default', 'organic', 'glass'];

/**
 * Which of the three visual families the app is wearing.
 *
 * A family re-grounds the neutrals, the corner radii and the typeface — the
 * material — and deliberately touches nothing else: light and dark, the
 * account's accent, the saved palettes and high contrast are all orthogonal
 * to it and keep working exactly as they did. Kept per device, beside the
 * glass and contrast settings, because it is about this screen.
 */
export function themeFamily() {
  try {
    const saved = localStorage.getItem(FAMILY_KEY);
    return THEME_FAMILIES.includes(saved) ? saved : 'default';
  } catch { return 'default'; }
}
export function setThemeFamily(name) {
  const next = THEME_FAMILIES.includes(name) ? name : 'default';
  try { localStorage.setItem(FAMILY_KEY, next); } catch { /* this sitting only */ }
  applyTheme();
}

const GLASS_KEY = 'studex.glass';
/**
 * Whether the machine has been told to keep interfaces opaque.
 *
 * System Settings → Accessibility → Display → Reduce Transparency. Someone who
 * has asked for that has asked every app, and an app that carries on frosting
 * its sidebar is not honouring the setting — so this beats the in-app toggle
 * rather than sitting beside it in Settings as a second switch to find.
 */
export function transparencyReduced() {
  try { return window.matchMedia('(prefers-reduced-transparency: reduce)').matches; } catch { return false; }
}
/** Frosted, translucent floating surfaces; on unless turned off on this device. */
export function glassEnabled() {
  if (transparencyReduced()) return false;
  try { return localStorage.getItem(GLASS_KEY) !== 'off'; } catch { return true; }
}
export function setGlassEnabled(on) {
  try { localStorage.setItem(GLASS_KEY, on ? 'on' : 'off'); } catch { /* this sitting only */ }
  applyTheme();
}

const CONTRAST_KEY = 'studex.contrast';
/**
 * High-contrast mode: stronger borders, opaque surfaces and maximal text
 * contrast, for a student who needs the interface to read harder. Kept per
 * device because it is about this screen and these eyes, not the account, and
 * layered on top of whichever light or dark theme is in use.
 */
export function highContrast() {
  try { return localStorage.getItem(CONTRAST_KEY) === 'on'; } catch { return false; }
}
export function setHighContrast(on) {
  try { localStorage.setItem(CONTRAST_KEY, on ? 'on' : 'off'); } catch { /* this sitting only */ }
  applyTheme();
}

const ACCENTS_KEY = 'studex.accents';
/** `{ secondary, tertiary, sections }` — extra accents kept on this device. */
export function accentPrefs() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(ACCENTS_KEY) || '{}') ?? {}; } catch { /* defaults */ }
  const hex = (v) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : null);
  return { secondary: hex(saved.secondary), tertiary: hex(saved.tertiary), sections: saved.sections === true };
}
export function setAccentPrefs(patch) {
  const next = { ...accentPrefs(), ...patch };
  try { localStorage.setItem(ACCENTS_KEY, JSON.stringify(next)); } catch { /* this sitting only */ }
  applyTheme();
  return next;
}
const PALETTES_KEY = 'studex.palettes';
const isHex = (v) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : null);
/**
 * Saved accent palettes — a named trio of primary/secondary/tertiary the
 * student can switch between. Kept on this device: the primary follows the
 * account, but a palette is a local shortcut for setting all three at once,
 * so a laptop and a desktop can keep different ones.
 */
export function savedPalettes() {
  let raw = [];
  try { raw = JSON.parse(localStorage.getItem(PALETTES_KEY) || '[]'); } catch { /* none */ }
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p) => p && typeof p.name === 'string' && isHex(p.primary))
    .map((p) => ({ id: p.id || p.name, name: p.name.slice(0, 40), primary: isHex(p.primary), secondary: isHex(p.secondary), tertiary: isHex(p.tertiary) }));
}
/** Adds a palette (or replaces one with the same name). Returns the new list. */
export function savePalette({ name, primary, secondary, tertiary }) {
  const clean = { id: `p${Date.now().toString(36)}`, name: String(name || 'Palette').trim().slice(0, 40) || 'Palette', primary: isHex(primary), secondary: isHex(secondary), tertiary: isHex(tertiary) };
  if (!clean.primary) return savedPalettes();
  const next = savedPalettes().filter((p) => p.name.toLowerCase() !== clean.name.toLowerCase());
  next.push(clean);
  try { localStorage.setItem(PALETTES_KEY, JSON.stringify(next)); } catch { /* this sitting only */ }
  return next;
}
/** Removes a saved palette by id. Returns the new list. */
export function deletePalette(id) {
  const next = savedPalettes().filter((p) => p.id !== id);
  try { localStorage.setItem(PALETTES_KEY, JSON.stringify(next)); } catch { /* this sitting only */ }
  return next;
}

/** Which accent family a route belongs to; re-applies the accent if it changed. */
export function setAccentSection(head) {
  const section = ['study', 'review', 'flashcards', 'deck', 'test'].includes(head) ? 'study'
    : ['calendar', 'timetable', 'topics', 'stats'].includes(head) ? 'plan' : 'library';
  const root = document.documentElement;
  if (root.dataset.section === section) return;
  root.dataset.section = section;
  if (accentPrefs().sections) applyTheme();
}

const HOME_KEY = 'studex.home';
/** The dashboard panels, in their default order. Home reads this to lay itself out. */
export const HOME_PANELS = ['continue', 'today', 'preview', 'library', 'needs', 'plan', 'timer', 'deadlines'];
/**
 * How this device arranges the Home dashboard: an ordered list of
 * `{ id, visible }`, kept per device. A phone-sized laptop and a big desktop
 * want different things forward, and the dashboard is a view, not account data.
 */
export function homeLayout() {
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(HOME_KEY) || '[]'); } catch { /* defaults */ }
  const byId = new Map();
  if (Array.isArray(saved)) {
    for (const item of saved) {
      if (item && HOME_PANELS.includes(item.id) && !byId.has(item.id)) {
        byId.set(item.id, { id: item.id, visible: item.visible !== false });
      }
    }
  }
  // Any panel added in a later version that the saved list predates is appended,
  // visible, so an upgrade never hides a new dashboard section.
  for (const id of HOME_PANELS) if (!byId.has(id)) byId.set(id, { id, visible: true });
  return [...byId.values()];
}
export function setHomeLayout(list) {
  const clean = list.filter((i) => HOME_PANELS.includes(i.id)).map((i) => ({ id: i.id, visible: i.visible !== false }));
  try { localStorage.setItem(HOME_KEY, JSON.stringify(clean)); } catch { /* this sitting only */ }
  return clean;
}

const DENSITY_KEY = 'studex.density';
/** `{ sidebar, page }` in px added to paddings and gaps; -2 is tight, 8 is airy. */
export function densityPrefs() {
  const fallback = state.device?.density === 'comfortable' ? 3 : 0;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(DENSITY_KEY) || '{}'); } catch { /* defaults */ }
  const clamp = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-2, Math.min(8, v)) : fallback);
  return { sidebar: clamp(saved.sidebar), page: clamp(saved.page) };
}
export function setDensityPrefs(patch) {
  const next = { ...densityPrefs(), ...patch };
  try { localStorage.setItem(DENSITY_KEY, JSON.stringify(next)); } catch { /* this sitting only */ }
  applyTheme();
  return next;
}

export function folderById(id) { return state.folders.find((f) => f.id === id) ?? null; }
export function fileById(id) { return state.files.find((f) => f.id === id) ?? null; }
export function subjectById(id) { return state.subjects.find((s) => s.id === id) ?? null; }

export function childFolders(parentId) {
  return state.folders.filter((f) => f.parent_id === (parentId ?? null));
}

export function filesInFolder(folderId) {
  return state.files.filter((f) => f.folder_id === folderId);
}

/**
 * Which subject something belongs to.
 *
 * A subject is set on a folder and inherited by everything inside it, the same
 * way colour is — so "Organic mechanisms" filed under Chemistry/Year 13 is a
 * Chemistry deck without anyone having said so twice. Walking up stops at the
 * first folder that names one, and a cycle cannot spin here even if the tree
 * were ever to acquire one.
 */
export function subjectOfFolder(folderId) {
  let cursor = folderId ? folderById(folderId) : null;
  const seen = new Set();
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    if (cursor.subject_id) return subjectById(cursor.subject_id);
    cursor = cursor.parent_id ? folderById(cursor.parent_id) : null;
  }
  return null;
}

export function subjectOfFile(file) {
  return subjectOfFolder(file?.folder_id ?? null);
}

/** The folder trail down to something, as names. */
export function folderPath(folderId) {
  const parts = [];
  let cursor = folderId ? folderById(folderId) : null;
  const seen = new Set();
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    parts.unshift(cursor.name);
    cursor = cursor.parent_id ? folderById(cursor.parent_id) : null;
  }
  return parts;
}

/* ── toasts ───────────────────────────────────────────────────────────── */

let toastHost = null;
let toastLanes = null;

/**
 * The toast stack, and the two live regions it is made of.
 *
 * A toast is the app's only way of saying anything back — "Saved", "Cannot
 * reach the Studex server" — and until now it said it in pixels alone: a
 * screen reader sat in silence through every confirmation and every failure.
 *
 * Two lanes rather than one because the two kinds are not equally urgent. A
 * confirmation is polite: it waits for whatever is being read to finish. A
 * failure is assertive: it interrupts, because it usually means the thing the
 * student just did did not happen. Both lanes are `display: contents`, so the
 * stack still lays out as the single column it looks like.
 */
function lanes() {
  if (toastLanes) return toastLanes;
  toastHost = document.createElement('div');
  toastHost.className = 'toasts';

  const make = (role, live) => {
    const lane = document.createElement('div');
    lane.className = 'toast-lane';
    lane.setAttribute('role', role);
    lane.setAttribute('aria-live', live);
    // Additions only: a toast expiring is not news, and announcing its removal
    // would read the message back a second time as it disappeared.
    lane.setAttribute('aria-relevant', 'additions');
    toastHost.appendChild(lane);
    return lane;
  };

  toastLanes = { info: make('status', 'polite'), error: make('alert', 'assertive') };
  document.body.appendChild(toastHost);
  return toastLanes;
}

/**
 * A line at the bottom right. `kind` is 'info' or 'error'; either argument
 * position can instead be `{ kind, action: { label, onSelect } }`, and a toast
 * with an action — Undo, most often — stays for eight seconds so there is time
 * to reach it.
 */
export function toast(message, kind = 'info') {
  const opts = typeof kind === 'object' && kind ? kind : { kind };
  const lane = opts.kind === 'error' ? lanes().error : lanes().info;
  const node = document.createElement('div');
  node.className = opts.kind === 'error' ? 'toast error' : 'toast';
  const text = document.createElement('span');
  text.textContent = message;
  node.appendChild(text);
  let timer = 0;
  const dismiss = () => {
    clearTimeout(timer);
    node.classList.add('out');
    setTimeout(() => node.remove(), 180);
  };
  if (opts.action) {
    node.classList.add('has-action');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toast-action';
    button.textContent = opts.action.label;
    button.addEventListener('click', () => {
      dismiss();
      try { void opts.action.onSelect?.(); } catch (err) { console.error(err); }
    });
    node.appendChild(button);
  }
  lane.appendChild(node);
  timer = setTimeout(dismiss, opts.action ? 8000 : opts.kind === 'error' ? 6000 : 3200);
  return dismiss;
}

/**
 * Says something to the screen reader without putting anything on screen.
 *
 * Used for the things a sighted student learns from the screen simply
 * changing — which screen they are now on, that a list has been re-sorted,
 * that a card was buried. One region, reused: readers coalesce rapid changes
 * to a single region, and a fresh one per message is how you end up with
 * fifty of them in the document and half the announcements dropped.
 */
let announcer = null;

export function announce(message) {
  if (!announcer) {
    announcer = document.createElement('div');
    announcer.className = 'sr-only';
    announcer.setAttribute('role', 'status');
    announcer.setAttribute('aria-live', 'polite');
    document.body.appendChild(announcer);
  }
  // Cleared first so that saying the same thing twice in a row is still heard
  // twice: a region whose text does not change is a region nothing happened in.
  announcer.textContent = '';
  setTimeout(() => { if (announcer) announcer.textContent = String(message); }, 60);
}

/** Reports a failed call without ever surfacing a raw stack to the user. */
export function reportError(err) {
  const message = err?.status === 0
    ? 'Cannot reach the Studex server.'
    : err?.message || 'Something went wrong.';
  toast(message, 'error');
  if (err?.status >= 500 || err?.status === 0) log.error(err);
}


/** Whether the sidebar is actually off the screen, whatever the reason. */
export function sidebarIsHidden() {
  return state.narrow ? !state.sidebarPeek : state.sidebarHidden;
}

/** Shows or hides the sidebar, remembering the choice for this device. */
export function setSidebarHidden(hidden) {
  // In a narrow window the same control opens and closes the overlay; what it
  // must not do is record that as the preference, or a student who once opened
  // the app in a small window would find the sidebar gone in a large one.
  if (state.narrow) state.sidebarPeek = !hidden;
  else {
    state.sidebarHidden = hidden;
    localStorage.setItem('studex.sidebar', hidden ? 'hidden' : 'shown');
  }
  document.documentElement.classList.toggle('sidebar-hidden', sidebarIsHidden());
  rerender();
}

/**
 * Watches for the window becoming too narrow for the wide layout.
 *
 * 760px is where the sidebar, a page with its own side rail and the padding
 * between them stop fitting; below it the shell reflows and the sidebar
 * floats. The overlay closes on the way through, because a window that cannot
 * show both should not come back showing both.
 */
const narrowQuery = window.matchMedia('(max-width: 760px)');
state.narrow = narrowQuery.matches;
narrowQuery.addEventListener('change', (event) => {
  state.narrow = event.matches;
  state.sidebarPeek = false;
  document.documentElement.classList.toggle('sidebar-hidden', sidebarIsHidden());
  rerender();
});
