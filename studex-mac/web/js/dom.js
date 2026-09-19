/**
 * Minimal element builder.
 *
 * Everything the UI renders goes through here, and text is always assigned
 * with textContent — there is no innerHTML path anywhere in the app. A note
 * title, a card front or a folder name is therefore inert markup by
 * construction rather than by remembering to escape at each call site.
 */
export function el(tag, props = null, ...children) {
  const node = document.createElement(tag);

  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;

      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = String(value);
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key === 'value') node.value = value;
      else if (key === 'checked' || key === 'disabled' || key === 'autofocus') node[key] = Boolean(value);
      else node.setAttribute(key, String(value));
    }
  }

  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(node, child);
    else if (child instanceof Node) node.appendChild(child);
    else node.appendChild(document.createTextNode(String(child)));
  }
}

/**
 * Phosphor glyph. `name` is a bare icon name such as "house".
 *
 * Always hidden from the screen reader. The glyph is a character from a
 * private-use block, so what a reader would otherwise announce is not the word
 * "house" but a codepoint it has no name for — and every icon in this app is
 * either beside its own label or inside a control that carries one.
 */
export function icon(name, opts = {}) {
  const node = document.createElement('i');
  node.className = opts.bold ? `ph-bold ph-${name}` : `ph ph-${name}`;
  if (opts.class) node.className += ' ' + opts.class;
  if (opts.color) node.style.color = opts.color;
  if (opts.size) node.style.fontSize = typeof opts.size === 'number' ? `${opts.size}px` : opts.size;
  node.setAttribute('aria-hidden', 'true');
  return node;
}

/**
 * Text for the screen reader and for nothing else.
 *
 * Not `display: none` and not `hidden`: both remove the text from the
 * accessibility tree along with the picture, which is the opposite of the
 * point. It is clipped to a single pixel instead, which every reader still
 * reads. Use it where a control's meaning is carried by a shape — a count
 * badge, a ring, a coloured dot — that has no word attached to it.
 */
export function srOnly(text) {
  const node = document.createElement('span');
  node.className = 'sr-only';
  node.textContent = String(text);
  return node;
}

/**
 * Traps Tab inside a container until it is torn down.
 *
 * A modal that does not do this is a modal in appearance only: the backdrop
 * stops the mouse and the keyboard walks straight out underneath it into the
 * page behind, where every control is still focusable and none of it is
 * visible. Returns the function that releases the trap and puts focus back
 * where it was, which is the other half of the same promise — being returned
 * to the button you opened the thing with.
 */
export function trapFocus(container) {
  const restore = document.activeElement;

  const focusable = () => [...container.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]),'
    + ' textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]',
  )].filter((node) => node.offsetParent !== null || node === document.activeElement);

  const onKey = (event) => {
    if (event.key !== 'Tab') return;
    const items = focusable();
    if (items.length === 0) { event.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;

    // Focus outside the container at all — which happens the moment anything
    // in it is removed while focused — is pulled back to the near end.
    if (!container.contains(active)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }
    if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
  };

  // On the document and capturing, not on the container: once focus has left
  // the container there is nothing left inside it to hear the key that would
  // bring it back.
  document.addEventListener('keydown', onKey, true);
  return () => {
    document.removeEventListener('keydown', onKey, true);
    if (restore instanceof HTMLElement && document.contains(restore)) restore.focus();
  };
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(node, ...children) {
  clear(node);
  append(node, children);
  return node;
}

/**
 * Applies a colour role or hex value to an element as --role-color.
 * The API stores either a role name from a fixed set or a 6-digit hex, so a
 * value that is neither is ignored rather than written into a style.
 */
const ROLES = new Set(['accent', 'accent-2', 'neutral', 'amber', 'rose', 'teal', 'violet', 'lime', 'sky']);

export function applyColor(node, color) {
  if (!color) return node;
  if (ROLES.has(color)) node.classList.add('c-' + color);
  else if (/^#[0-9a-fA-F]{6}$/.test(color)) node.style.setProperty('--role-color', color);
  return node;
}

/** Resolves a colour role to a CSS colour usable outside a class context. */
export function colorValue(color) {
  if (!color) return 'var(--color-accent)';
  if (/^#[0-9a-fA-F]{6}$/.test(color)) return color;
  if (!ROLES.has(color)) return 'var(--color-accent)';
  if (color === 'neutral') return 'var(--color-neutral-400)';
  const hue = { 'accent': 289, 'accent-2': 289, violet: 289, sky: 240, teal: 195, lime: 140, amber: 80, rose: 20 }[color];
  return `oklch(var(--folder-l) var(--folder-c) ${hue})`;
}

/**
 * What a colour role is called on screen. The stored ids stay as they were
 * (`sky`, `lime`…) so existing folders and notes keep their colour; only the
 * names people read are the plain ones.
 */
const COLOR_NAMES = { accent: 'Accent', 'accent-2': 'Purple', violet: 'Purple', sky: 'Blue', teal: 'Teal', lime: 'Green', amber: 'Yellow', rose: 'Red', neutral: 'Grey', grey: 'Grey' };

export function colorLabel(color) {
  if (/^#[0-9a-fA-F]{6}$/.test(color ?? '')) return 'Custom';
  return COLOR_NAMES[color] ?? 'Colour';
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Same shape as el(), but in the SVG namespace. */
export function svg(tag, props = null, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.setAttribute('class', value);
      else if (key === 'text') node.textContent = String(value);
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else node.setAttribute(key, String(value));
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/* A folder, drawn rather than lettered.
   The icon font has one weight and no fill, so a folder in the tree could only
   ever be an outline in the text colour. Drawing it means the colour a student
   gave the folder is the folder — which is the whole point of colouring one. */
const FOLDER_BODY = 'M2.5 6.2A2.5 2.5 0 0 1 5 3.7h4.05c.65 0 1.27.3 1.67.83l1.3 1.72H19a2.5 2.5 0 0 1 2.5 2.5V18a2.5 2.5 0 0 1-2.5 2.5H5A2.5 2.5 0 0 1 2.5 18Z';
const FOLDER_FLAP = 'M2.5 9.6h19V18a2.5 2.5 0 0 1-2.5 2.5H5A2.5 2.5 0 0 1 2.5 18Z';
const FOLDER_FLAP_OPEN = 'M4.6 9.6h18.1l-2.2 8.9a2.5 2.5 0 0 1-2.43 1.9H5A2.5 2.5 0 0 1 2.5 18Z';

export function folderGlyph(color, { open = false, size = 16 } = {}) {
  const fill = colorValue(color);
  return svg('svg', {
    class: 'folder-glyph', viewBox: '0 0 24 24', width: size, height: size,
    'aria-hidden': 'true', focusable: 'false',
  },
    svg('path', { d: FOLDER_BODY, fill, 'fill-opacity': '0.55' }),
    svg('path', { d: open ? FOLDER_FLAP_OPEN : FOLDER_FLAP, fill }),
  );
}
