/**
 * Putting tags on things, and showing what they connect it to.
 *
 * The tag sheet is deliberately not a form with a Save button. Tagging is a
 * filing action, not a piece of authoring: the answer to "is this
 * photosynthesis" is known the instant the row is clicked, and a sheet that
 * then asked for confirmation would be asking about its own existence. So
 * every toggle writes immediately and the only button is the one that closes.
 */
import { el, icon, mount, clear, colorValue } from './dom.js';
import { api } from './api.js';
import { dialog } from './dialog.js';
import { navigate } from './router.js';
import { toast, reportError, loadTags } from './store.js';
import { FILE_ICON } from './format.js';

/** A tag's colour is optional; unset means it borrows the accent. */
function swatch(tag) {
  return el('span', {
    class: 'tag-dot',
    style: { background: tag.color ? colorValue(tag.color) : 'var(--color-accent)' },
  });
}

/**
 * The chip a tag is drawn as wherever it appears.
 *
 * `onRemove` is what makes one chip serve both jobs: with it the chip is a
 * control on the thing it is attached to, without it it is a way into the tag.
 */
export function tagChip(tag, { onRemove = null } = {}) {
  return el('span', { class: 'tag-chip' },
    el('button', {
      class: 'tag-chip-name',
      title: `Everything tagged ${tag.name}`,
      onclick: () => navigate(`tag/${encodeURIComponent(tag.key ?? tag.name)}`),
    }, swatch(tag), el('span', { text: tag.name })),
    onRemove
      ? el('button', {
        class: 'tag-chip-x',
        title: `Remove ${tag.name}`,
        'aria-label': `Remove ${tag.name}`,
        onclick: onRemove,
      }, icon('x', { size: 10 }))
      : null,
  );
}

/**
 * The row of tags on one folder or file, with a button to change them.
 *
 * It refreshes itself, because it is mounted into screens that have no idea a
 * tag was added — a document header does not re-render because a sheet three
 * layers above it was closed.
 */
export function tagStrip({ itemType, itemId, title }) {
  const node = el('div', { class: 'tag-strip' });

  async function draw() {
    let tags = [];
    try { ({ tags } = await api.tagsOn(itemType, itemId)); }
    catch { return; }

    clear(node);
    for (const tag of tags) {
      node.appendChild(tagChip(tag, {
        onRemove: async () => {
          try {
            await api.detachTag(tag.id, itemType, itemId);
            await draw();
            void loadTags();
            toast(`Removed #${tag.name}.`, {
              action: {
                label: 'Undo',
                onSelect: async () => {
                  try { await api.attachTag({ tagId: tag.id, itemType, itemId }); await draw(); void loadTags(); }
                  catch (err) { reportError(err); }
                },
              },
            });
          } catch (err) { reportError(err); }
        },
      }));
    }
    node.appendChild(el('button', {
      class: 'tag-add',
      title: 'Tags',
      onclick: () => void openTagSheet({ itemType, itemId, title }, draw),
    }, icon('hash', { size: 12 }), tags.length ? null : el('span', { text: 'Tag' })));
  }

  void draw();
  // A pair rather than a bare node: a document re-indexes its `##tags` on every
  // save, so the screen that owns this strip needs a way to ask it to look again.
  return { node, refresh: draw };
}

/**
 * Every tag in the account, with the ones on this thing ticked.
 *
 * The whole list rather than a search field, because a student has tens of
 * tags and not thousands, and seeing the list is what stops the fourteenth
 * spelling of "photosynthesis" from being invented.
 */
export async function openTagSheet({ itemType, itemId, title }, onChange = null) {
  let all = [];
  let mine = new Set();
  try {
    const [list, on] = await Promise.all([api.tags(), api.tagsOn(itemType, itemId)]);
    all = list.tags;
    mine = new Set(on.tags.map((t) => t.id));
  } catch (err) { reportError(err); return; }

  const picker = el('div', { class: 'tag-picker' });
  const field = el('input', { class: 'input', placeholder: 'New tag', spellcheck: 'false', 'aria-label': 'New tag', maxlength: 60 });

  function draw() {
    clear(picker);
    if (!all.length) {
      picker.appendChild(el('div', { class: 'tag-empty', text: 'No tags yet. Type one above.' }));
      return;
    }
    for (const tag of [...all].sort((a, b) => a.key.localeCompare(b.key))) {
      const on = mine.has(tag.id);
      picker.appendChild(el('button', {
        class: on ? 'tag-pick on' : 'tag-pick',
        type: 'button',
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        onclick: async () => {
          try {
            if (on) { await api.detachTag(tag.id, itemType, itemId); mine.delete(tag.id); }
            else { await api.attachTag({ tagId: tag.id, itemType, itemId }); mine.add(tag.id); }
            draw();
            void loadTags();
            onChange?.();
          } catch (err) { reportError(err); }
        },
      },
        on ? icon('check', { class: 'tag-tick', size: 12 }) : el('span', { class: 'tag-tick' }),
        swatch(tag),
        el('span', { class: 'grow', text: tag.name }),
        el('span', { class: 'tag-count', text: `${tag.count}` }),
      ));
    }
  }

  async function add() {
    const name = field.value.trim().replace(/^#+/, '');
    if (!name) return;
    if (/\s/.test(name)) { toast('A tag cannot contain spaces — try a hyphen.', 'error'); return; }
    try {
      const { tag } = await api.attachTag({ name, itemType, itemId });
      field.value = '';
      if (!all.some((t) => t.id === tag.id)) all.push({ ...tag, folders: 0, files: 0, count: 1 });
      mine.add(tag.id);
      draw();
      void loadTags();
      onChange?.();
    } catch (err) { reportError(err); }
  }

  field.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    // The sheet's only button closes it, so Enter here must not reach the form.
    event.preventDefault();
    void add();
  });

  draw();

  await dialog({
    title: `Tags for ${title}`,
    confirmLabel: 'Done',
    cancelLabel: null,
    body: el('div', null,
      el('div', { class: 'field' },
        el('label', { text: 'Add a tag' }),
        el('div', { class: 'tag-add-row' },
          field,
          el('button', { class: 'btn', type: 'button', text: 'Add', onclick: () => void add() }),
        ),
      ),
      picker,
      el('div', { class: 'sub', text: 'A tag holds folders and documents together across the tree. Typing ##name inside a document tags it too.' }),
    ),
  });
}

/**
 * What else carries the tags this thing carries.
 *
 * The panel the whole feature is for: it is the one place in the app where
 * something arrives that was never filed here.
 */
export function relatedPanel({ itemType, itemId }) {
  const node = el('div', { class: 'related-panel' });

  async function draw() {
    let related;
    try { ({ related } = await api.tagsOn(itemType, itemId)); }
    catch { return; }

    clear(node);

    const rows = [
      ...related.folders.map((f) => ({ label: f.name, glyph: 'folder', to: `folder/${f.id}` })),
      ...related.files.map((f) => ({ label: f.title, glyph: FILE_ICON[f.kind] ?? 'file-text', to: `${f.kind}/${f.id}` })),
    ];
    if (!rows.length) return;

    mount(node,
      el('div', { class: 'panel-head' }, icon('hash', { size: 13 }), 'Shares a tag'),
      el('div', { class: 'rows' }, rows.slice(0, 20).map((row) => el('button', {
        class: 'related-row',
        onclick: () => navigate(row.to),
      }, icon(row.glyph, { size: 15 }), el('span', { class: 'grow name', text: row.label || 'Untitled' })))),
    );
  }

  void draw();
  return { node, refresh: draw };
}
