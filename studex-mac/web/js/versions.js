/**
 * Earlier versions of a file.
 *
 * A file is one file on every device: when two Macs have both changed it, the
 * version that synced most recently is what the file holds, and the one it
 * replaced is kept behind it. This sheet is where that version can be brought
 * back — a short list, newest first, each row one button away from being the
 * file again.
 */
import { el, icon } from './dom.js';
import { api } from './api.js';
import { dialog } from './dialog.js';
import { toast, reportError } from './store.js';
import { relative, bytes } from './format.js';

const WHY = {
  sync: 'Replaced by another device',
  restore: 'Replaced when a version was put back',
};

function rows(list, file, refresh, redraw) {
  if (list.length === 0) {
    return el('div', { class: 'empty-state' },
      icon('clock-counter-clockwise'),
      el('p', { text: 'No earlier versions yet.' }),
      el('p', {
        class: 'muted',
        text: 'One is kept whenever another device’s version of this file arrives, so nothing you wrote is lost.',
      }),
    );
  }

  return el('ul', { class: 'version-list' }, ...list.map((rev) => el('li', { class: 'version-row' },
    el('div', { class: 'version-meta' },
      el('div', { class: 'version-when', text: relative(rev.created_at) }),
      el('div', { class: 'version-why muted', text: `${WHY[rev.reason] ?? 'Replaced'} · ${bytes(rev.byte_size)}` }),
    ),
    el('button', {
      class: 'btn',
      type: 'button',
      text: 'Restore',
      onclick: async (event) => {
        event.currentTarget.disabled = true;
        try {
          const next = await api.restoreRevision(file.id, rev.id);
          toast(`“${file.title}” is back to how it was ${relative(rev.created_at).toLowerCase()}.`);
          redraw(next.revisions);
          await refresh?.();
        } catch (err) {
          event.currentTarget.disabled = false;
          reportError(err);
        }
      },
    }),
  )));
}

/**
 * Opens the list for one file. `refresh` is whatever the caller uses to redraw
 * the page behind the sheet, since a restore changes what the file holds.
 */
export async function openVersionSheet(file, refresh) {
  let list = [];
  try {
    list = (await api.fileRevisions(file.id)).revisions;
  } catch (err) {
    reportError(err);
    return;
  }

  const holder = el('div', { class: 'version-sheet' });
  const redraw = (next) => {
    holder.replaceChildren(rows(next, file, refresh, redraw));
  };
  redraw(list);

  await dialog({
    title: `Earlier versions of ${file.title}`,
    body: holder,
    // Every restore is already written by the time it returns, so there is
    // nothing here to confirm or to cancel.
    confirmLabel: 'Done',
    cancelLabel: null,
  });
}
