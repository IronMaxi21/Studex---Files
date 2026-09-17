/**
 * The Studex dropdown.
 *
 * A native `<select>` is the one control in this app that the platform draws
 * itself: it ignores the type scale, the radii, the accent and the dark theme,
 * and its popup is a system window that cannot be told about any of them. Six
 * screens deep that is the one thing on screen that does not look like Studex.
 *
 * So this is a `<select>` in everything but the tag. It takes the same
 * arguments as `el('select', props, ...options)` — real `<option>` and
 * `<optgroup>` nodes, built the same way — reads them, and draws a button and
 * a listbox instead. Call sites change by one word.
 *
 * What it promises, because a replacement that keeps only the look is a
 * regression: `.value` reads and writes, a `change` event on every choice made
 * by a person and none made in code, `disabled`, focus, the arrows, Home and
 * End, type-to-find, Escape, and a search field once the list is long enough
 * to be worth typing at rather than looking through.
 */
import { el, icon } from './dom.js';
import { closeMenu } from './menu.js';

/** A list longer than this gets a search field at the top of its popup. */
const SEARCHABLE_AT = 12;

/** How long a run of typed letters counts as one word, in ms. */
const TYPEAHEAD_MS = 900;

let open = null;

export function closeSelect() {
  if (!open) return;
  const { popup, trigger } = open;
  popup.remove();
  open = null;
  document.removeEventListener('mousedown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', closeSelect);
  window.removeEventListener('scroll', closeSelect, true);
  trigger.setAttribute('aria-expanded', 'false');
  trigger.removeAttribute('aria-activedescendant');
  if (document.contains(trigger)) trigger.focus();
}

function onOutside(event) {
  if (open && !open.popup.contains(event.target) && !open.trigger.contains(event.target)) closeSelect();
}

/* ── reading the options that were handed in ──────────────────────────── */

/**
 * Options are flattened out of whatever nodes the call site built, keeping the
 * group each one came from so the popup can put the headings back.
 */
function readOptions(nodes, into = [], group = null) {
  for (const node of nodes) {
    if (node === null || node === undefined || node === false) continue;
    if (Array.isArray(node)) { readOptions(node, into, group); continue; }
    if (!(node instanceof Element)) continue;
    if (node.tagName === 'OPTGROUP') {
      readOptions([...node.children], into, node.label || null);
      continue;
    }
    if (node.tagName !== 'OPTION') continue;
    into.push({
      // A bare `<option>Text</option>` is its own value, exactly as in HTML.
      value: node.hasAttribute('value') ? node.getAttribute('value') : node.textContent,
      label: node.textContent,
      disabled: node.disabled,
      selected: node.selected || node.hasAttribute('selected'),
      group,
    });
  }
  return into;
}

/* ── the control ──────────────────────────────────────────────────────── */

/**
 * `props` are the same props `el` takes. `class` is added to rather than
 * replaced, so `{ class: 'input' }` at a call site still means what it meant.
 */
export function dropdown(props = null, ...children) {
  const options = readOptions(children);
  const rest = { ...(props ?? {}) };
  const extraClass = typeof rest.class === 'string' ? rest.class : '';
  const initial = rest.value;
  delete rest.class;
  delete rest.value;

  const onChange = typeof rest.onchange === 'function' ? rest.onchange : null;
  delete rest.onchange;

  const label = el('span', { class: 'sel-label' });
  const trigger = el('button', {
    ...rest,
    type: 'button',
    class: `sel ${extraClass}`.trim(),
    role: 'combobox',
    'aria-haspopup': 'listbox',
    'aria-expanded': 'false',
  }, label, icon('caret-up-down', { class: 'sel-caret' }));

  // Marks it for the two places that look for a select without holding one:
  // the dialog's initial focus, and the event form pre-picking its kind.
  trigger.dataset.select = '';

  let current = null;

  const find = (value) => options.find((o) => o.value === value) ?? null;

  function paint() {
    const chosen = find(current);
    label.textContent = chosen ? chosen.label : '';
    trigger.classList.toggle('empty', !chosen);
    // The value lives on the node as well, so anything reading the DOM — a
    // test, a debugger, a stylesheet — sees the same answer the property gives.
    if (current === null) trigger.removeAttribute('data-value');
    else trigger.setAttribute('data-value', current);
  }

  function set(value, { fire = false } = {}) {
    const next = value === null || value === undefined ? null : String(value);
    const same = next === current;
    current = next;
    paint();
    if (fire && !same) trigger.dispatchEvent(new Event('change', { bubbles: true }));
  }

  Object.defineProperty(trigger, 'value', {
    configurable: true,
    get: () => current ?? '',
    set: (value) => set(value),
  });

  // Native behaviour: with nothing marked selected, a select shows its first
  // option and reports that option's value — not the empty string.
  const preselected = options.find((o) => o.selected);
  set(initial !== undefined && initial !== null ? initial : (preselected ?? options[0])?.value ?? null);

  if (onChange) trigger.addEventListener('change', onChange);

  trigger.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (open?.trigger === trigger) closeSelect();
    else show(trigger, options, current, set);
  });

  trigger.addEventListener('keydown', (event) => {
    if (open?.trigger === trigger) return; // The popup owns the keyboard.
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      show(trigger, options, current, set);
      return;
    }
    // A single printable character opens the list and starts the search, which
    // is the shortest path from "I know what I want" to having picked it.
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      show(trigger, options, current, set, event.key);
    }
  });

  return trigger;
}

/* ── the popup ────────────────────────────────────────────────────────── */

let popupSeq = 0;

function show(trigger, options, current, set, typed = '') {
  closeSelect();
  closeMenu(); // Only one floating layer at a time, whichever kind it is.
  if (trigger.disabled || !options.length) return;

  const id = `sel-pop-${++popupSeq}`;
  const popup = el('div', { class: 'menu sel-pop', role: 'listbox', id, 'aria-label': trigger.title || 'Options' });
  const searchable = options.length >= SEARCHABLE_AT;

  const rows = [];
  let lastGroup = null;
  for (const [index, option] of options.entries()) {
    if (option.group && option.group !== lastGroup) {
      popup.appendChild(el('div', { class: 'head', role: 'presentation', text: option.group }));
    }
    lastGroup = option.group;
    const on = option.value === current;
    const row = el('button', {
      type: 'button',
      role: 'option',
      id: `${id}-${index}`,
      class: on ? 'on' : '',
      'aria-selected': on ? 'true' : 'false',
      disabled: option.disabled,
      onclick: () => { closeSelect(); set(option.value, { fire: true }); },
    },
      el('i', { class: on ? 'ph ph-check sel-tick' : 'sel-tick', 'aria-hidden': 'true' }),
      el('span', { class: 'sel-row-label', text: option.label }),
    );
    rows.push(row);
    popup.appendChild(row);
  }

  let search = null;
  if (searchable) {
    search = el('input', {
      class: 'menu-search', type: 'search', placeholder: 'Search', spellcheck: 'false',
      'aria-label': 'Search these options', 'aria-controls': id,
    });
    search.addEventListener('input', () => {
      const needle = search.value.trim().toLowerCase();
      for (const [index, row] of rows.entries()) {
        row.hidden = Boolean(needle) && !options[index].label.toLowerCase().includes(needle);
      }
      for (const head of popup.querySelectorAll('.head')) {
        let next = head.nextElementSibling;
        let any = false;
        while (next && !next.classList.contains('head')) {
          if (next.matches('button[role="option"]') && !next.hidden) { any = true; break; }
          next = next.nextElementSibling;
        }
        head.hidden = !any;
      }
    });
    search.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      popup.querySelector('button[role="option"]:not([hidden]):not([disabled])')?.click();
    });
    popup.prepend(search);
  }

  document.body.appendChild(popup);

  // Under the control and at least as wide as it, because a list that is
  // narrower than the thing it belongs to reads as a different control.
  const anchor = trigger.getBoundingClientRect();
  popup.style.minWidth = `${Math.round(anchor.width)}px`;
  const box = popup.getBoundingClientRect();
  const below = window.innerHeight - anchor.bottom - 10;
  const flip = box.height > below && anchor.top > below;
  const top = flip ? Math.max(8, anchor.top - box.height - 4) : Math.min(anchor.bottom + 4, window.innerHeight - box.height - 10);
  popup.style.top = `${Math.max(8, top)}px`;
  popup.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - box.width - 10))}px`;

  trigger.setAttribute('aria-expanded', 'true');
  open = { popup, trigger, rows, search };

  if (search && typed) { search.value = typed; search.dispatchEvent(new Event('input')); }
  if (search) search.focus();
  else (rows.find((r) => r.classList.contains('on')) ?? rows.find((r) => !r.disabled))?.focus();
  if (!search && typed) typeahead(typed);

  setTimeout(() => {
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', closeSelect);
    // True, so a scroll anywhere above the control counts: the popup is fixed
    // and would otherwise stay behind where the control used to be.
    window.addEventListener('scroll', closeSelect, true);
  }, 0);
}

function walkable() {
  if (!open) return [];
  return open.rows.filter((r) => !r.hidden && !r.disabled);
}

function step(delta) {
  const all = walkable();
  if (!all.length) return;
  const at = all.indexOf(document.activeElement);
  const next = at === -1 ? (delta > 0 ? 0 : all.length - 1) : (at + delta + all.length) % all.length;
  all[next]?.focus();
  open?.trigger.setAttribute('aria-activedescendant', all[next]?.id ?? '');
}

let typedRun = '';
let typedAt = 0;

function typeahead(key) {
  const now = Date.now();
  typedRun = now - typedAt > TYPEAHEAD_MS ? key : typedRun + key;
  typedAt = now;
  const hit = walkable().find((row) => row.textContent.trim().toLowerCase().startsWith(typedRun.toLowerCase()));
  hit?.focus();
}

function onKey(event) {
  if (!open) return;
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSelect(); return; }
  if (event.key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); step(1); return; }
  if (event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); step(-1); return; }
  const typing = document.activeElement === open.search;
  if (event.key === 'Home' && !typing) { event.preventDefault(); walkable()[0]?.focus(); return; }
  if (event.key === 'End' && !typing) { event.preventDefault(); walkable().at(-1)?.focus(); return; }
  if (event.key === 'Tab') { event.preventDefault(); closeSelect(); return; }
  if (!typing && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    typeahead(event.key);
  }
}
