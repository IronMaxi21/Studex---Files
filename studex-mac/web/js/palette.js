/** ⌘K search across files, folders, annotations and cards. */
import { el, icon, mount, applyColor, trapFocus } from './dom.js';
import { api } from './api.js';
import { navigate } from './router.js';
import { state, reportError, fileById, folderById } from './store.js';
import { FILE_ICON } from './format.js';
import { recentItems } from './recents.js';

let host = null;
let release = null;
let selected = 0;
let results = [];

const KIND_ICON = { file: 'file', folder: 'folder', annotation: 'highlighter-circle', card: 'cards', tag: 'hash' };

export function closePalette() {
  if (!host) return;
  host.remove();
  host = null;
  release?.();
  release = null;
  results = [];
  selected = 0;
}

export function openPalette() {
  if (host) return;

  /* The palette is a combobox in the strict sense: one field that filters a
     list the arrow keys walk, while the caret never leaves the field. So the
     rows are options rather than buttons, and which one is current is said
     with `aria-activedescendant` — focus itself must stay put, or every arrow
     press would take the keyboard out of the search box. */
  const input = el('input', {
    placeholder: 'Search files, notes, highlights and cards — or #tag…',
    autofocus: true,
    spellcheck: 'false',
    'aria-label': 'Search everything',
    role: 'combobox',
    'aria-expanded': 'false',
    'aria-controls': 'palette-results',
    'aria-autocomplete': 'list',
  });
  const list = el('div', { class: 'results', id: 'palette-results', role: 'listbox', 'aria-label': 'Results' });
  const panel = el('div', {
    class: 'palette',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'Search everything',
  }, input, list);
  host = el('div', { class: 'palette-wrap' }, panel);

  host.addEventListener('mousedown', (event) => { if (event.target === host) closePalette(); });

  let seq = 0;
  let timer = null;

  const run = async () => {
    const q = input.value.trim();
    // `#name` looks through tags, then everything carrying the one matched.
    if (q.startsWith('#')) {
      const needle = q.slice(1).toLowerCase();
      const tags = state.tags.filter((t) => t.name.toLowerCase().includes(needle)).slice(0, 5);
      results = [];
      for (const tag of tags) {
        results.push({ entity_type: 'tag', entity_id: tag.id, title: `#${tag.name}`, tag });
        const ids = new Set();
        for (const [id, on] of state.tagsByItem) if (on.includes(tag.id)) ids.add(id);
        for (const folder of state.folders) if (ids.has(folder.id)) results.push({ entity_type: 'folder', entity_id: folder.id, title: folder.name });
        for (const file of state.files) if (ids.has(file.id)) results.push({ entity_type: 'file', entity_id: file.id, file_id: file.id, title: file.title });
      }
      results = results.slice(0, 40);
      selected = 0;
      draw();
      return;
    }
    if (q.length < 2) { showRecent(); return; }
    const mine = ++seq;
    try {
      const res = await api.search(q, { limit: 20 });
      if (mine !== seq || !host) return; // a newer keystroke already won
      results = res.results ?? [];
      selected = 0;
      draw();
    } catch (err) {
      if (mine === seq) reportError(err);
    }
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 130);
  });

  /* What the field says about the list underneath it. Kept in one place
     because it has to be right after every one of the four things that can
     change the list: a keystroke, a result set, an arrow key, a close. */
  const describe = () => {
    input.setAttribute('aria-expanded', results.length > 0 ? 'true' : 'false');
    const current = results.length > 0 ? `palette-result-${selected}` : null;
    if (current) input.setAttribute('aria-activedescendant', current);
    else input.removeAttribute('aria-activedescendant');
  };

  // Before anything is typed the list is what you opened last, so getting
  // back to it is one keystroke — Enter — rather than a search.
  const showRecent = () => {
    results = recentItems(8).map((item) => item.kind === 'folder'
      ? { entity_type: 'folder', entity_id: item.id, title: item.record.name, recent: item.at }
      : { entity_type: 'file', entity_id: item.id, file_id: item.id, title: item.record.title, recent: item.at });
    selected = 0;
    if (results.length === 0) {
      mount(list, el('div', { class: 'empty', text: 'Type at least two characters.' }));
      describe();
      return;
    }
    draw();
  };

  const draw = () => {
    if (results.length === 0) {
      mount(list, el('div', { class: 'empty', text: 'Nothing found.' }));
      describe();
      return;
    }
    mount(list, results.map((result, i) => {
      // The index stores only ids, so the icon and colour come from the
      // library already in memory rather than from a second round trip.
      const file = result.file_id ? fileById(result.file_id) : null;
      const folder = result.entity_type === 'folder' ? folderById(result.entity_id) : null;
      const glyph = result.entity_type === 'file' || result.entity_type === 'card'
        ? (result.entity_type === 'card' ? 'cards' : FILE_ICON[file?.kind] ?? 'file')
        : KIND_ICON[result.entity_type] ?? 'file';

      const node = el('button', {
        class: 'result' + (i === selected ? ' sel' : ''),
        id: `palette-result-${i}`,
        role: 'option',
        'aria-selected': i === selected ? 'true' : 'false',
        // Out of the tab order: the field is the one focusable thing here, and
        // Tab through twenty results is not how anyone uses a palette.
        tabindex: '-1',
        onclick: () => choose(result),
        onmousemove: () => { if (selected !== i) { selected = i; draw(); } },
      },
        icon(glyph),
        el('span', { class: 'grow', text: result.title || result.snippet || 'Untitled' }),
        el('span', { class: 'kind', text: result.recent ? ago(result.recent) : result.entity_type }),
      );
      applyColor(node, folder?.effective_color ?? file?.effective_color);
      return node;
    }));
    list.querySelector('.result.sel')?.scrollIntoView({ block: 'nearest' });
    if (results[0]?.recent && !list.querySelector('.palette-section')) list.prepend(el('div', { class: 'palette-section', text: 'Recently opened' }));
    describe();
  };

  const choose = (result) => {
    closePalette();
    if (result.entity_type === 'tag') { navigate(`tag/${encodeURIComponent(result.tag.name)}`); return; }
    if (result.entity_type === 'folder') { navigate(`folder/${result.entity_id}`); return; }
    if (result.entity_type === 'annotation') { navigate(`pdf/${result.file_id}`); return; }

    const file = fileById(result.file_id);
    if (result.entity_type === 'card') { navigate(`deck/${result.file_id}`); return; }
    if (file) navigate(`${file.kind}/${file.id}`);
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); closePalette(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); selected = Math.min(selected + 1, results.length - 1); draw(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); selected = Math.max(selected - 1, 0); draw(); }
    else if (event.key === 'Enter') {
      event.preventDefault();
      const result = results[selected];
      if (result) choose(result);
    }
  });

  showRecent();
  document.body.appendChild(host);
  release = trapFocus(host);
  input.focus();
}

function ago(at) {
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
