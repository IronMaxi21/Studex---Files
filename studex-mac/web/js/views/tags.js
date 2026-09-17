/**
 * Screen 07b — the tags a library has, and what carries each one.
 *
 * A tag is the library's second axis. The tree answers "where did I put it";
 * a tag answers "what else is about this", and it crosses the tree freely:
 * one tag can hold a folder in Biology, a PDF in Downloads and a page written
 * in a lesson. Tags arrive two ways — attached by hand from a menu, or written
 * into a document as `##photosynthesis` — and this screen does not distinguish
 * between them, because the student does not either.
 */
import { el, icon, mount, applyColor, colorValue, folderGlyph, colorLabel } from '../dom.js';
import { api } from '../api.js';
import { fileById, reportError, toast } from '../store.js';
import { navigate } from '../router.js';
import { topbar } from '../shell.js';
import { promptText, confirmDelete, promptColor } from '../dialog.js';
import { openMenu } from '../menu.js';
import { plural, relative, FILE_ICON, FILE_LABEL } from '../format.js';

const COLOR_ROLES = ['accent', 'sky', 'teal', 'lime', 'amber', 'rose', 'neutral'];

export async function tagsView(route, host) {
  // The router has already decoded the hash; decoding again would throw on a
  // tag containing "%" and split one containing "/", so the name is
  // everything after "tag/", as it is.
  const only = route.hash.replace(/^tag\/?/, '').trim().toLowerCase() || null;
  const body = el('div', { class: 'tag-page' });
  const refresh = () => tagsView(route, host);

  mount(host,
    topbar(only
      ? [{ label: 'Library', to: 'library' }, { label: 'Tags', to: 'tag', icon: 'hash' }, { label: only, icon: 'hash' }]
      : [{ label: 'Library', to: 'library' }, { label: 'Tags', icon: 'hash' }]),
    el('div', { class: 'content' }, body),
  );

  try {
    if (only) await drawOne(body, only, refresh);
    else await drawAll(body, refresh);
  } catch (err) {
    reportError(err);
    mount(body, el('div', { class: 'empty-state' }, icon('warning-circle'), el('div', { text: 'Tags could not be read.' })));
  }
}

function dot(tag, size = 9) {
  return el('span', {
    class: 'tag-dot',
    style: {
      width: `${size}px`,
      height: `${size}px`,
      background: tag.color ? colorValue(tag.color) : 'var(--color-accent)',
    },
  });
}

async function drawAll(body, refresh) {
  const { tags } = await api.tags();
  if (!tags.length) {
    mount(body, el('div', { class: 'empty-state' },
      icon('hash'),
      el('div', { text: 'No tags yet.' }),
      el('div', { class: 'dim', text: 'Tag a folder or a document from its menu, or type ##topic inside a page.' }),
      el('button', { class: 'btn', text: 'New tag', onclick: () => void newTag(refresh) }),
    ));
    return;
  }

  // Commonest first: a tag on twenty things is the one being looked for, and a
  // tag used once is usually a misspelling of one used often — which shows up
  // as a near neighbour at the bottom rather than hidden in alphabetical order.
  const sorted = [...tags].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  mount(body,
    el('div', { class: 'page-head' },
      el('div', { class: 'page-title', text: 'Tags' }),
      el('div', { class: 'note', text: `${plural(sorted.length, 'tag')} across your library` }),
      el('button', { class: 'btn', onclick: () => void newTag(refresh) }, icon('plus', { size: 13 }), 'New tag'),
    ),
    el('div', { class: 'tag-cloud' }, sorted.map((row) => el('button', {
      class: 'tag-tile',
      onclick: () => navigate(`tag/${encodeURIComponent(row.key)}`),
      oncontextmenu: (event) => { event.preventDefault(); tagMenu(row, event.clientX, event.clientY, refresh); },
    },
      dot(row),
      el('span', { class: 'grow', text: row.name }),
      el('span', { class: 'tag-count', title: countTitle(row), text: `${row.count}` }),
    ))),
  );
}

function countTitle(row) {
  const parts = [];
  if (row.folders) parts.push(plural(row.folders, 'folder'));
  if (row.files) parts.push(plural(row.files, 'document'));
  return parts.join(' · ') || 'Nothing yet';
}

async function drawOne(body, key, refresh) {
  let found;
  try {
    found = await api.tagged(key);
  } catch (err) {
    if (err?.status !== 404) throw err;
    mount(body, el('div', { class: 'empty-state' },
      icon('hash'),
      el('div', { text: `Nothing carries ${key} any more.` }),
      el('button', { class: 'btn', text: 'All tags', onclick: () => navigate('tag') }),
    ));
    return;
  }

  const { tag, folders, files } = found;
  const total = folders.length + files.length;

  mount(body,
    el('div', { class: 'page-head' },
      el('div', { class: 'page-title' }, dot(tag, 11), tag.name),
      el('div', { class: 'note', text: total ? countTitle({ folders: folders.length, files: files.length }) : 'Nothing carries this tag yet' }),
      el('button', {
        class: 'icon-btn',
        title: 'Tag options',
        onclick: (event) => {
          const box = event.currentTarget.getBoundingClientRect();
          tagMenu(tag, box.left, box.bottom + 4, refresh, true);
        },
      }, icon('dots-three', { size: 16 })),
    ),
    folders.length
      ? el('div', { class: 'tag-group' },
        el('div', { class: 'panel-head' }, icon('folder', { size: 13 }), 'Folders'),
        el('div', { class: 'tag-rows' }, folders.map((folder) => el('button', {
          class: 'tag-row',
          onclick: () => navigate(`folder/${folder.id}`),
        },
          folderGlyph(folder.color, { size: 17 }),
          el('div', { class: 'grow' },
            el('div', { class: 'name', text: folder.name }),
            el('div', { class: 'tag-row-note', text: plural(folder.file_count, 'document') }),
          ),
          icon('caret-right', { size: 12 }),
        ))),
      )
      : null,
    files.length
      ? el('div', { class: 'tag-group' },
        el('div', { class: 'panel-head' }, icon('files', { size: 13 }), 'Documents'),
        el('div', { class: 'tag-rows' }, files.map((row) => {
          const known = fileById(row.id) ?? row;
          const node = el('button', {
            class: 'tag-row',
            onclick: () => navigate(`${known.kind}/${row.id}`),
          },
            icon(FILE_ICON[known.kind] ?? 'file-text', { size: 17 }),
            el('div', { class: 'grow' },
              el('div', { class: 'name', text: row.title || 'Untitled' }),
              el('div', { class: 'tag-row-note', text: `${FILE_LABEL[known.kind] ?? 'Doc'} · edited ${relative(row.updated_at)}` }),
            ),
            icon('caret-right', { size: 12 }),
          );
          applyColor(node, known.color ?? null);
          return node;
        })),
      )
      : null,
    total
      ? null
      : el('div', { class: 'empty-state' },
        icon('hash'),
        el('div', { text: 'Nothing carries this tag yet.' }),
        el('div', { class: 'dim', text: 'Tag a folder or document from its menu to gather it here.' }),
      ),
  );
}

function tagMenu(tag, x, y, refresh, isTagPage = false) {
  openMenu({ x, y }, [
    { head: tag.name.toUpperCase().slice(0, 32) },
    {
      icon: 'pencil-simple', label: 'Rename', onSelect: async () => {
        const name = await promptText({ title: 'Rename tag', label: 'Name', value: tag.name, confirmLabel: 'Rename' });
        if (!name) return;
        if (/\s/.test(name)) { toast('A tag cannot contain spaces — try a hyphen.', 'error'); return; }
        try {
          const { tag: next } = await api.updateTag(tag.id, { name: name.replace(/^#+/, '') });
          // The name is what the URL holds, so a rename moves this page under
          // its own feet; the tag page follows it rather than 404ing.
          if (isTagPage) navigate(`tag/${encodeURIComponent(next.key)}`, { replace: true });
          else await refresh();
        } catch (err) { reportError(err); }
      },
    },
    { sep: true },
    {
      swatches: COLOR_ROLES.map((role) => ({
        color: colorValue(role),
        label: colorLabel(role),
        on: tag.color === role,
        onSelect: async () => {
          try { await api.updateTag(tag.id, { color: role }); await refresh(); }
          catch (err) { reportError(err); }
        },
      })),
    },
    {
      icon: 'eyedropper', label: 'Custom colour…', onSelect: async () => {
        const color = await promptColor({ title: `Colour for ${tag.name}`, value: tag.color });
        if (!color) return;
        try { await api.updateTag(tag.id, { color }); await refresh(); }
        catch (err) { reportError(err); }
      },
    },
    { sep: true },
    {
      icon: 'trash', label: 'Delete tag', danger: true, onSelect: async () => {
        const ok = await confirmDelete('The folders and documents stay where they are; only the thread between them is cut.');
        if (!ok) return;
        try {
          await api.deleteTag(tag.id);
          if (isTagPage) navigate('tag', { replace: true });
          else await refresh();
        } catch (err) { reportError(err); }
      },
    },
  ]);
}

async function newTag(refresh) {
  const name = await promptText({ title: 'New tag', label: 'Name', placeholder: 'photosynthesis', confirmLabel: 'Create' });
  if (!name) return;
  if (/\s/.test(name)) { toast('A tag cannot contain spaces — try a hyphen.', 'error'); return; }
  try { await api.createTag(name.replace(/^#+/, '')); refresh(); }
  catch (err) { reportError(err); }
}
