/**
 * Choosing what goes in the second pane.
 *
 * Opening a split used to drop Home or the Library into the new pane, which
 * was never what anyone split the window for. This is the page that opens
 * instead: what is pinned, what was worked on lately, today's lessons and the
 * main places, with a search field that already has the caret. Whatever is
 * picked replaces this page in the same pane.
 */
import { el, icon, mount } from '../dom.js';
import { api } from '../api.js';
import { state } from '../store.js';
import { navigate } from '../router.js';
import { topbar } from '../shell.js';
import { relative, FILE_ICON, FILE_LABEL } from '../format.js';

// Only places that work at half a window: Home, Study, Topics, Calendar and
// Statistics always take the whole window.
const PLACES = [
  { icon: 'books', label: 'Library', to: 'library' },
  { icon: 'table', label: 'Timetable', to: 'timetable' },
];

export async function besideView(route, host) {
  const paneIndex = () => Number(host.closest?.('.pane')?.dataset.pane ?? '1');
  const open = (to) => navigate(to, { pane: paneIndex(), replace: true });

  const search = el('input', {
    class: 'input beside-search', type: 'search', placeholder: 'Search your files…',
    'aria-label': 'Search your files',
  });
  const list = el('div', { class: 'beside-list' });

  const fileRow = (file) => el('button', { class: 'row', type: 'button', onclick: () => open(`${file.kind}/${file.id}`) },
    icon(FILE_ICON[file.kind] ?? 'file', { size: 15 }),
    el('span', { class: 'grow', text: file.title || 'Untitled' }),
    el('span', { class: 'dim', style: { fontSize: '11.5px' }, text: `${FILE_LABEL[file.kind] ?? ''} · ${relative(file.updated_at)}` }),
  );
  const section = (label, rows) => (rows.length
    ? el('div', { class: 'beside-section' }, el('span', { class: 'section-label plain', text: label }), el('div', { class: 'rows' }, rows))
    : null);

  let lessons = [];
  function draw() {
    const q = search.value.trim().toLowerCase();
    if (q) {
      const hits = state.files.filter((f) => (f.title ?? '').toLowerCase().includes(q)).slice(0, 30);
      mount(list, hits.length
        ? section('MATCHES', hits.map(fileRow))
        : el('div', { class: 'empty-state' }, icon('magnifying-glass'), `Nothing called “${search.value.trim()}”.`));
      return;
    }
    const recent = [...state.files].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, 8);
    mount(list,
      el('div', { class: 'beside-places' },
        PLACES.map((p) => el('button', { class: 'chip', type: 'button', onclick: () => open(p.to) }, icon(p.icon), p.label))),
      section('PINNED', state.files.filter((f) => f.pinned).map(fileRow)),
      section('TODAY’S LESSONS', lessons.map((lesson) => el('button', { class: 'row', type: 'button', onclick: () => open('timetable') },
        icon('chalkboard-teacher', { size: 15 }),
        el('span', { class: 'grow', text: lesson.subject }),
        el('span', { class: 'dim', style: { fontSize: '11.5px' }, text: [timeOf(lesson.starts_at), lesson.room].filter(Boolean).join(' · ') }),
      ))),
      section('RECENT', recent.map(fileRow)),
    );
  }

  search.addEventListener('input', draw);
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') list.querySelector('.row')?.click();
  });

  mount(host,
    topbar([{ label: 'Open beside' }]),
    el('div', { class: 'content beside' },
      el('p', { class: 'dim', text: 'Pick what to keep open next to your other page.' }),
      search,
      list,
    ),
  );
  draw();
  setTimeout(() => search.focus(), 0);

  try {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    lessons = (await api.lessonsBetween(start.getTime(), end.getTime() - 1)).lessons ?? [];
    if (!search.value.trim()) draw();
  } catch { /* no timetable: the section simply stays away */ }
}

function timeOf(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
