/** Floating context / dropdown menus. One at a time; closes on outside click. */
import { el, icon } from './dom.js';

let open = null;
let restore = null;

export function closeMenu() {
  if (!open) return;
  open.remove();
  open = null;
  document.removeEventListener('mousedown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
  // Back to whatever summoned the menu. Without this the keyboard is left at
  // the top of the document every time a menu is dismissed, which is worse
  // than never having opened one.
  if (restore instanceof HTMLElement && document.contains(restore)) restore.focus();
  restore = null;
}

function onOutside(event) {
  if (open && !open.contains(event.target)) closeMenu();
}

/**
 * Every item that can be moved to, in the order they are drawn.
 *
 * Hidden rows are skipped: once a search has filtered the menu, the arrows
 * have to walk what is on screen, not what used to be.
 */
function items() {
  if (!open) return [];
  return [...open.querySelectorAll('button:not([disabled])')].filter((b) => !b.hidden);
}

function step(delta) {
  const all = items();
  if (all.length === 0) return;
  const at = all.indexOf(document.activeElement);
  // From nowhere, the ends: Down opens at the top and Up opens at the bottom,
  // which is what every menu on this platform does.
  const next = at === -1
    ? (delta > 0 ? 0 : all.length - 1)
    : (at + delta + all.length) % all.length;
  all[next]?.focus();
}

/**
 * A menu is walked with the arrows, not with Tab.
 *
 * Declaring `role="menu"` is a promise about the keys, so the keys have to be
 * there: a menu that announces itself as a menu and then only answers to Tab
 * is a worse lie than a menu that says nothing at all.
 */
function onKey(event) {
  if (!open) return;
  if (event.key === 'Escape') { event.stopPropagation(); closeMenu(); return; }
  if (event.key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); step(1); return; }
  if (event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); step(-1); return; }
  // In the search field Home and End belong to the text being typed.
  const typing = document.activeElement?.classList?.contains('menu-search');
  if (event.key === 'Home' && !typing) { event.preventDefault(); items()[0]?.focus(); return; }
  if (event.key === 'End' && !typing) { event.preventDefault(); items().at(-1)?.focus(); return; }
  // Tab leaves rather than walking the items: the menu is over either way, and
  // dismissing it is the only thing Tab could mean here.
  if (event.key === 'Tab') { event.preventDefault(); closeMenu(); }
}

/**
 * `items` entries: {head}, {sep}, {swatches}, {search}, or
 * {icon, label, kbd, keywords, danger, onSelect}.
 *
 * `search` puts a filter field at the top of the menu; `keywords` are extra
 * words a row answers to, so that "h1" finds Heading 1 and "checkbox" finds
 * To-do without either word having to appear on the row.
 */
export function openMenu(at, items) {
  closeMenu();

  restore = document.activeElement;
  const node = el('div', { class: 'menu', role: 'menu' });
  // Rows are dropped conditionally (no AI, not in the app), which can leave a
  // divider with nothing on one side of it. Those go.
  const rows = items.filter(Boolean).filter((item, i, all) =>
    !item.sep || (i > 0 && !all[i - 1].sep && i < all.length - 1 && !all[i - 1].head));
  for (const item of rows) {
    if (item.head !== undefined) { node.appendChild(el('div', { class: 'head', role: 'presentation', text: item.head })); continue; }
    if (item.sep) { node.appendChild(el('div', { class: 'sep', role: 'separator' })); continue; }
    if (item.search !== undefined) {
      // A long menu is faster to type at than to look through. The field only
      // hides rows, so the arrows still walk exactly what is on screen, and
      // Enter takes the first one left — which is what a search is for.
      const field = el('input', {
        class: 'menu-search', type: 'search', placeholder: item.search || 'Search',
        spellcheck: 'false', autofocus: true, 'aria-label': item.search || 'Search this menu',
      });
      field.addEventListener('input', () => {
        const needle = field.value.trim().toLowerCase();
        for (const row of node.querySelectorAll('button[role="menuitem"]')) {
          const hay = `${row.textContent} ${row.dataset.keywords ?? ''}`.toLowerCase();
          row.hidden = Boolean(needle) && !hay.includes(needle);
        }
        // A heading with nothing left under it is noise.
        for (const head of node.querySelectorAll('.head')) {
          let next = head.nextElementSibling;
          let any = false;
          while (next && !next.classList.contains('head')) {
            if (next.matches('button[role="menuitem"]') && !next.hidden) { any = true; break; }
            next = next.nextElementSibling;
          }
          head.hidden = !any;
        }
      });
      field.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        node.querySelector('button[role="menuitem"]:not([hidden])')?.click();
      });
      node.appendChild(field);
      continue;
    }
    if (item.swatches) {
      const row = el('div', { class: 'swatches', role: 'group', 'aria-label': 'Colour' });
      for (const swatch of item.swatches) {
        row.appendChild(el('button', {
          // A swatch may name its colour in CSS instead of carrying a value:
          // a text colour has to move when the theme does, and a stylesheet is
          // the only place that knows which theme is on.
          class: 'swatch' + (swatch.class ? ` ${swatch.class}` : '') + (swatch.on ? ' on' : ''),
          title: swatch.label,
          // A swatch is a colour and nothing else, so its name has to be
          // spoken: without this it is a button called "".
          'aria-label': swatch.label,
          role: 'menuitemradio',
          'aria-checked': swatch.on ? 'true' : 'false',
          style: swatch.color ? { background: swatch.color } : null,
          onclick: () => { closeMenu(); swatch.onSelect?.(); },
        }));
      }
      node.appendChild(row);
      continue;
    }
    node.appendChild(el('button', {
      role: 'menuitem',
      onclick: () => { closeMenu(); item.onSelect?.(); },
      style: item.danger ? { color: 'var(--color-danger)' } : null,
      dataset: item.keywords ? { keywords: item.keywords } : null,
    },
      item.icon ? icon(item.icon) : null,
      item.label,
      item.kbd ? el('span', { class: 'kbd', text: item.kbd }) : null,
    ));
  }

  document.body.appendChild(node);

  // Keep the menu on screen regardless of where it was summoned.
  const rect = node.getBoundingClientRect();
  let x = at.x;
  let y = at.anchorBottom ? at.y - rect.height : at.y;
  x = Math.min(x, window.innerWidth - rect.width - 10);
  y = Math.min(Math.max(8, y), window.innerHeight - rect.height - 10);
  node.style.left = `${Math.max(8, x)}px`;
  node.style.top = `${y}px`;
  // A menu grows out of the control that opened it, so the corner it grows from
  // is the corner nearest that control — which, once the menu has been nudged
  // back on screen, is not always the one that was asked for.
  node.style.setProperty('--menu-origin-y', y < at.y ? 'bottom' : 'top');
  node.style.setProperty('--menu-origin-x', x < at.x ? 'right' : 'left');

  open = node;
  node.querySelector('.menu-search')?.focus();
  // Deferred so the click that opened the menu does not immediately close it.
  setTimeout(() => {
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
  return node;
}
