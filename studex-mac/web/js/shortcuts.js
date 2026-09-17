/**
 * Every keyboard shortcut in one place.
 *
 * App-wide shortcuts are registered here with `register`, and one keydown
 * listener on the document runs them — so there is a single answer to "what
 * does ⌘K do", and two features cannot quietly claim the same keys. Shortcuts
 * that only mean something inside one editor (a canvas tool, bold in a note)
 * stay with that editor, which knows what is selected; they are declared here
 * with `describe` so the Keyboard shortcuts sheet can list them all.
 *
 * Keys are written `mod+shift+n`: `mod` is ⌘ on a Mac and Ctrl elsewhere. A
 * key named with a capital first letter longer than one character
 * (`Backslash`, `Escape`) is matched against `event.code` / `event.key` by
 * name, which is what Option-modified keys on a Mac keyboard need.
 */
import { el } from './dom.js';
import { dialog } from './dialog.js';

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export const GROUPS = ['General', 'Navigation', 'Sidebar & panes', 'Documents', 'Canvas', 'Flashcards'];

/** `{ id, keys, group, label, run, when?, inInput? }` for shortcuts this module runs. */
const registered = new Map();
/** `{ keys, group, label }` for shortcuts an editor runs itself. */
const described = [];

/**
 * Per-device rebindings, `{ [id]: keys }`. Kept on this machine, not on the
 * account: a keyboard belongs to a computer, and the same person on a laptop
 * and a desktop may want different keys. A rebinding only ever overrides an
 * app-wide shortcut this module runs — the in-editor keys (bold, a canvas tool)
 * are the editor's to interpret and are shown here read-only.
 */
const KEYMAP_KEY = 'studex.keymap';
let overrides = loadKeymap();

function loadKeymap() {
  try { return JSON.parse(localStorage.getItem(KEYMAP_KEY) || '{}') ?? {}; }
  catch { return {}; }
}
function saveKeymap() {
  try { localStorage.setItem(KEYMAP_KEY, JSON.stringify(overrides)); } catch { /* this device only */ }
}

/** The keys a shortcut actually answers to: a rebinding if one is set, else its default. */
function effectiveKeys(entry) {
  return overrides[entry.id] ?? entry.defaultKeys;
}
/** Re-derives every match spec after the keymap changes, so the next keystroke uses it. */
function reparseAll() {
  for (const entry of registered.values()) entry.spec = parse(effectiveKeys(entry));
}

function parse(keys) {
  const parts = keys.split('+');
  const key = parts.pop();
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  return { key, mod: mods.has('mod'), shift: mods.has('shift'), alt: mods.has('alt') };
}

function matches(spec, event) {
  const mod = event.metaKey || event.ctrlKey;
  if (spec.mod !== mod || spec.alt !== event.altKey) return false;
  if (spec.key.length > 1 && /^[A-Z]/.test(spec.key)) {
    if (event.code !== spec.key && event.key !== spec.key) return false;
    return spec.shift === event.shiftKey;
  }
  // `?` is itself a shifted key, so a printable symbol ignores Shift unless
  // the shortcut names it.
  if (/^[a-z0-9]$/i.test(spec.key)) {
    return event.key.toLowerCase() === spec.key.toLowerCase() && spec.shift === event.shiftKey;
  }
  return event.key === spec.key && (!spec.shift || event.shiftKey);
}

function isTyping(target) {
  return /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName) || Boolean(target?.isContentEditable);
}

/**
 * Registers an app-wide shortcut. Returns a function that removes it again.
 * `when()` returning false lets the keystroke through untouched; `inInput`
 * says the shortcut still applies while a text field has focus.
 */
export function register(shortcut) {
  const entry = { inInput: true, rebindable: true, ...shortcut, defaultKeys: shortcut.keys };
  entry.spec = parse(effectiveKeys(entry));
  registered.set(shortcut.id, entry);
  return () => { if (registered.get(shortcut.id) === entry) registered.delete(shortcut.id); };
}

/** Lists a shortcut that another module handles, so the sheet can show it. */
export function describe(group, entries) {
  for (const [keys, label] of entries) described.push({ group, keys, label });
}

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.isComposing) return;
  const typing = isTyping(event.target);
  for (const entry of registered.values()) {
    if (!matches(entry.spec, event)) continue;
    if (typing && !entry.inInput) continue;
    if (entry.when && !entry.when(event)) continue;
    if (entry.run(event) === false) continue;
    event.preventDefault();
    return;
  }
});

/** `mod+shift+n` as the keys printed on the keyboard: ⇧⌘N, or Ctrl+Shift+N. */
export function formatKeys(keys) {
  return keys.split(' / ').map((combo) => {
    const { key, mod, shift, alt } = parse(combo);
    const names = { Backslash: '\\', Escape: 'Esc', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Enter: '↩', Backspace: '⌫', Delete: '⌦', Tab: '⇥', Space: 'Space' };
    const label = names[key] ?? (key.length === 1 ? key.toUpperCase() : key);
    if (IS_MAC) return `${alt ? '⌥' : ''}${shift ? '⇧' : ''}${mod ? '⌘' : ''}${label}`;
    return [mod && 'Ctrl', alt && 'Alt', shift && 'Shift', label].filter(Boolean).join('+');
  }).join(' / ');
}

/** Every shortcut, grouped in the order of `GROUPS`. */
export function allShortcuts() {
  const rows = [
    ...[...registered.values()].filter((s) => s.label).map((s) => ({ group: s.group, keys: effectiveKeys(s), label: s.label })),
    ...described,
  ];
  return GROUPS
    .map((group) => ({ group, rows: rows.filter((r) => r.group === group) }))
    .filter((g) => g.rows.length);
}

/**
 * The app-wide shortcuts a student can rebind, grouped like the sheet.
 *
 * Only the ones this module actually runs and shows a label for: an in-editor
 * key is the editor's to read, so rebinding it here would change the printed
 * hint and nothing else.
 */
export function remappableShortcuts() {
  const rows = [...registered.values()]
    .filter((s) => s.label && s.rebindable !== false)
    .map((s) => ({
      id: s.id, group: s.group, label: s.label,
      keys: effectiveKeys(s), defaultKeys: s.defaultKeys, custom: s.id in overrides,
    }));
  return GROUPS
    .map((group) => ({ group, rows: rows.filter((r) => r.group === group) }))
    .filter((g) => g.rows.length);
}

/** The label of another shortcut already answering to `keys`, or null if they are free. */
export function bindingConflict(keys, exceptId) {
  const want = parse(keys);
  const same = (a, b) => a.mod === b.mod && a.shift === b.shift && a.alt === b.alt
    && a.key.toLowerCase() === b.key.toLowerCase();
  for (const entry of registered.values()) {
    if (entry.id === exceptId || !entry.label || entry.rebindable === false) continue;
    if (same(parse(effectiveKeys(entry)), want)) return entry.label;
  }
  return null;
}

/** Rebinds a shortcut on this device. Takes effect on the next keystroke. */
export function setBinding(id, keys) {
  const entry = registered.get(id);
  if (!entry) return;
  if (keys === entry.defaultKeys) delete overrides[id];
  else overrides[id] = keys;
  saveKeymap();
  reparseAll();
}
/** Puts one shortcut back to its default. */
export function clearBinding(id) {
  if (!(id in overrides)) return;
  delete overrides[id];
  saveKeymap();
  reparseAll();
}
/** Puts every shortcut back to its default. */
export function resetBindings() {
  overrides = {};
  saveKeymap();
  reparseAll();
}
/** Whether anything has been rebound on this device. */
export function hasCustomBindings() {
  return Object.keys(overrides).length > 0;
}

/**
 * A `KeyboardEvent` as a keys string this module understands, or null if it is
 * only a modifier being held. Letters and digits are lowercased; a named key
 * (Enter, Escape, an arrow) keeps the capitalised `event.key` that `matches`
 * compares against, so a captured combo round-trips through `parse`.
 */
export function comboFromEvent(event) {
  const key = event.key;
  if (key === 'Meta' || key === 'Control' || key === 'Alt' || key === 'Shift') return null;
  const mods = [];
  if (event.metaKey || event.ctrlKey) mods.push('mod');
  if (event.altKey) mods.push('alt');
  if (event.shiftKey) mods.push('shift');
  let named = key;
  if (key === ' ') named = 'Space';
  else if (key.length === 1) named = key.toLowerCase();
  // A bare printable key with no modifier would swallow ordinary typing, so a
  // rebinding must carry at least one modifier unless it is a named non-typing
  // key (an arrow, Escape, a function key).
  if (!mods.length && key.length === 1) return null;
  return [...mods, named].join('+');
}

/** The shortcut list as a node, for the sheet and for Settings. */
export function shortcutList({ filter = '' } = {}) {
  const needle = filter.trim().toLowerCase();
  return el('div', { class: 'shortcut-groups' }, allShortcuts().map(({ group, rows }) => {
    const shown = needle ? rows.filter((r) => r.label.toLowerCase().includes(needle) || group.toLowerCase().includes(needle)) : rows;
    if (!shown.length) return null;
    return el('section', { class: 'shortcut-group' },
      el('h3', { text: group }),
      el('dl', null, shown.flatMap((r) => [
        el('dt', { text: r.label }),
        el('dd', null, formatKeys(r.keys).split(' / ').map((k) => el('kbd', { text: k }))),
      ])),
    );
  }));
}

let sheetOpen = false;

/** The Keyboard shortcuts sheet, from ⌘/ or ? anywhere. */
export async function openShortcuts() {
  if (sheetOpen) return;
  sheetOpen = true;
  const holder = el('div', { class: 'shortcut-sheet' });
  const search = el('input', { class: 'input', type: 'search', placeholder: 'Find a shortcut', 'aria-label': 'Find a shortcut' });
  const list = el('div');
  const refresh = () => { list.replaceChildren(shortcutList({ filter: search.value })); };
  search.oninput = refresh;
  refresh();
  holder.append(search, list);
  try {
    await dialog({ title: 'Keyboard shortcuts', body: holder, confirmLabel: 'Done', cancelLabel: null, wide: true });
  } finally {
    sheetOpen = false;
  }
}

register({ id: 'shortcuts', keys: 'mod+/', group: 'General', label: 'Show keyboard shortcuts', run: () => { void openShortcuts(); } });
register({ id: 'shortcuts-help', keys: '?', group: 'General', label: '', inInput: false, run: () => { void openShortcuts(); } });

describe('Documents', [
  ['mod+b', 'Bold'],
  ['mod+i', 'Italic'],
  ['mod+u', 'Underline'],
  ['mod+e', 'Inline code'],
  ['mod+shift+h', 'Highlight'],
  ['mod+shift+c', 'Cloze deletion {answer}'],
  ['mod+shift+k', 'Link to a page [[Page]]'],
  ['mod+shift+t', 'Tag ##topic'],
  ['/', 'Insert a block (on an empty line)'],
  ['::', 'Type :: to make a flashcard (Question → Answer)'],
  ['Tab / shift+Tab', 'Indent / outdent'],
  ['alt+ArrowUp / alt+ArrowDown', 'Move line up / down'],
  ['mod+Backspace', 'Delete to the start of the line'],
  ['shift+ArrowUp / shift+ArrowDown', 'Extend line selection'],
  ['mod+z', 'Undo'],
]);

describe('Canvas', [
  ['v', 'Select'],
  ['h', 'Pan'],
  ['p', 'Pen'],
  ['s', 'Highlighter'],
  ['e', 'Eraser (press again to switch Precise / Whole object)'],
  ['t', 'Text'],
  ['n', 'Note'],
  ['r', 'Rectangle'],
  ['o', 'Ellipse'],
  ['a', 'Arrow'],
  ['k', 'Flashcard'],
  ['c', 'Connect two objects'],
  ['g', 'Toggle snap to grid (grid size in the canvas menu)'],
  ['Shift', 'Hold while resizing to keep proportions'],
  ['Shift', 'Hold while drawing a line to keep it at 45°'],
  ['mod+a', 'Select everything'],
  ['mod+d', 'Duplicate'],
  ['mod+z / mod+shift+z', 'Undo / redo'],
  ['mod+[ / mod+]', 'Send backward / bring forward'],
  ['Backspace', 'Delete selection'],
  ['Escape', 'Back to Select'],
]);

describe('Flashcards', [
  ['Space', 'Show the answer'],
  ['1 / 2 / 3 / 4', 'Again / Hard / Good / Easy'],
]);
