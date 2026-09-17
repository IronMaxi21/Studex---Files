/**
 * The Trash: files moved out of the way, kept for thirty days.
 *
 * Moving a file to the Trash no longer asks first — Undo on the toast and this
 * page are the safety net instead — so this is where a file comes back from
 * after the toast has gone, and the only place it is deleted for good.
 */
import { el, icon, mount } from '../dom.js';
import { api } from '../api.js';
import { loadLibrary, toast, reportError } from '../store.js';
import { navigate } from '../router.js';
import { confirmDialog } from '../dialog.js';
import { relative, FILE_ICON, FILE_LABEL } from '../format.js';

const KEEP_DAYS = 30;
const DAY = 86_400_000;

/** The old address: Trash now lives in Settings. */
export function trashView() {
  navigate('settings/trash', { replace: true });
}

/** Trash as a Settings section. */
export async function drawTrash(host) {
  const { files = [] } = await api.files({ trashed: '1', limit: 200, offset: 0 });

  const redraw = () => drawTrash(host);

  const restore = async (file) => {
    try {
      await api.restoreFile(file.id);
      await loadLibrary();
      toast(`“${file.title}” is back in your Library.`);
      redraw();
    } catch (err) { reportError(err); }
  };

  const purge = async (file) => {
    const ok = await confirmDialog({
      title: `Delete “${file.title}” for good?`,
      message: 'It cannot be brought back after this.',
      confirmLabel: 'Delete forever',
    });
    if (!ok) return;
    try {
      await api.purgeFile(file.id);
      redraw();
    } catch (err) { reportError(err); }
  };

  const emptyAll = async () => {
    const ok = await confirmDialog({
      title: `Delete ${files.length === 1 ? 'this file' : `all ${files.length} files`} for good?`,
      message: 'Everything in the Trash will be gone and cannot be brought back.',
      confirmLabel: 'Empty Trash',
    });
    if (!ok) return;
    try {
      for (const file of files) await api.purgeFile(file.id);
      toast('The Trash is empty.');
      redraw();
    } catch (err) { reportError(err); redraw(); }
  };

  const daysLeft = (file) => {
    const at = file.trashed_at ? new Date(file.trashed_at).getTime() : Date.now();
    return Math.max(0, Math.ceil((at + KEEP_DAYS * DAY - Date.now()) / DAY));
  };

  const rows = files.map((file) => {
    const left = daysLeft(file);
    return el('div', { class: 'row trash-row' },
      icon(FILE_ICON[file.kind] ?? 'file'),
      el('span', { class: 'grow', text: file.title || 'Untitled' }),
      el('span', { class: 'dim', text: `${FILE_LABEL[file.kind] ?? 'File'} · trashed ${relative(file.trashed_at ?? file.updated_at)} · ${left === 1 ? '1 day' : `${left} days`} left` }),
      el('button', { class: 'chip', type: 'button', onclick: () => restore(file) }, icon('arrow-counter-clockwise', { size: 13 }), 'Restore'),
      el('button', { class: 'chip danger', type: 'button', onclick: () => purge(file) }, icon('trash', { size: 13 }), 'Delete forever'),
    );
  });

  mount(host,
    el('div', null,
      el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        el('h2', { class: 'section grow', text: 'Trash' }),
        files.length ? el('button', { class: 'chip', type: 'button', onclick: emptyAll }, icon('trash'), 'Empty Trash') : null,
      ),
      el('div', { class: 'muted', style: { marginTop: '9px' }, text: `Files stay here for ${KEEP_DAYS} days, then they are deleted automatically.` }),
    ),
    files.length
      ? el('div', { class: 'rows' }, rows)
      : el('div', { class: 'empty-state' }, icon('trash'), 'Nothing in the Trash.'),
  );
}
