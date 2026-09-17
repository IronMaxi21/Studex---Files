/**
 * Share links, and the one place that knows what a link can and cannot do.
 *
 * The permission model lives on the server: a token resolves to an owner and a
 * scope, and every shared route then calls the same domain function the
 * owner's own routes call. Nothing here decides access — this is the screen
 * that creates the token, shows it once, and takes it away again.
 */
import { el, icon } from './dom.js';
import { dropdown } from './select.js';
import { dialog, confirmDialog } from './dialog.js';
import { api } from './api.js';
import { toast, reportError } from './store.js';
import { lockSettings, authenticate } from './native.js';

/**
 * The address a link holder opens.
 *
 * Built from wherever this page is being served, which in the desktop app is
 * loopback — so a link made there works on that machine and nowhere else. That
 * is a property of running your own server, not something to paper over, and
 * the sheet below says so rather than implying an internet URL.
 */
export function shareUrl(token) {
  return `${location.origin}${location.pathname}#/s/${token}`;
}

/** True when the app is its own server on this machine, i.e. the desktop app. */
function isLoopback() {
  return /^(127\.|localhost$|\[?::1\]?$)/.test(location.hostname);
}

function relativeExpiry(share) {
  if (share.expires_at === null) return 'No expiry';
  const days = Math.round((share.expires_at - Date.now()) / 86_400_000);
  if (days < 0) return 'Expired';
  if (days === 0) return 'Expires today';
  return `Expires in ${days} day${days === 1 ? '' : 's'}`;
}

const EXPIRY_CHOICES = [
  { label: 'No expiry', days: null },
  { label: '24 hours', days: 1 },
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
];

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Link copied.');
  } catch {
    // Clipboard access can be refused; the link is on screen either way, so
    // this says which rather than failing silently.
    toast('The link could not be copied. Select it and copy manually.', 'error');
  }
}

/**
 * A row for one live link.
 *
 * The token is not shown, because it is not stored — only its hash is, so it
 * genuinely cannot be recovered here. A link whose URL was lost is revoked and
 * made again, which is also the safer of the two habits.
 */
function shareRow(share, { onChange, justCreated = null }) {
  const row = el('div', { class: 'share-row' },
    el('div', { class: 'head' },
      icon(share.permission === 'edit' ? 'pencil-simple' : 'eye', { size: 15 }),
      el('div', { class: 'grow' },
        el('div', {
          class: 'what',
          text: share.permission === 'edit'
            ? 'Anyone with the link can edit'
            : 'Anyone with the link can read',
        }),
        el('div', { class: 'when', text: relativeExpiry(share) }),
      ),
      el('button', {
        class: 'pill-btn danger',
        type: 'button',
        title: 'Revoke this link',
        onclick: async () => {
          const ok = await confirmDialog({
            title: 'Revoke this link?',
            message: 'Anyone holding it loses access immediately. This cannot be undone — a new link can be made, but it will be a different address.',
            confirmLabel: 'Revoke',
            danger: true,
          });
          if (!ok) return;
          try { await api.deleteShare(share.id); toast('Link revoked.'); await onChange(); }
          catch (err) { reportError(err); }
        },
      }, 'Revoke'),
    ),
  );

  // The plaintext token exists for exactly as long as this sheet is open, so
  // the link is shown in full on the row that was just made and never again.
  if (justCreated) {
    const url = shareUrl(justCreated);
    const field = el('input', { class: 'input mono', value: url, readonly: 'readonly', spellcheck: 'false' });
    field.addEventListener('focus', () => field.select());
    row.appendChild(el('div', { class: 'copy-line' },
      field,
      el('button', { class: 'btn', type: 'button', onclick: () => copy(url) }, icon('copy', { size: 14 }), 'Copy'),
    ));
    row.appendChild(el('div', {
      class: 'once',
      text: 'Copy it now — Studex stores only a hash of this link and cannot show it again.',
    }));
  }

  return row;
}

/**
 * The sharing sheet for one file or folder.
 *
 * `target` is `{ type: 'file' | 'folder', id, title }`.
 */
export async function openShareSheet(target) {
  const list = el('div', { class: 'share-links' });
  const permission = dropdown({ class: 'input' },
    el('option', { value: 'view', text: 'Can read' }),
    el('option', { value: 'edit', text: 'Can edit' }),
  );
  const expiry = dropdown({ class: 'input' },
    EXPIRY_CHOICES.map((choice, i) => el('option', { value: String(i), text: choice.label })),
  );

  /** Tokens created while this sheet has been open, by share id. */
  const fresh = new Map();

  /**
   * Whether making a link asks for a fingerprint first, started now so the
   * answer has arrived by the time anybody presses the button. Making a link
   * is the one action here that reaches outside the account, and the only one
   * a person at a borrowed keyboard could do in ten seconds.
   */
  const lock = lockSettings();

  async function refresh() {
    let mine = [];
    try {
      const { shares } = await api.shares();
      mine = shares.filter((s) => s.target_type === target.type && s.target_id === target.id);
    } catch (err) { reportError(err); return; }

    list.replaceChildren(
      ...(mine.length
        ? mine.map((s) => shareRow(s, { onChange: refresh, justCreated: fresh.get(s.id) ?? null }))
        : [el('div', { class: 'share-empty', text: 'No links yet. Anything not shared stays private to your account.' })]),
    );
  }

  const create = el('button', {
    class: 'btn',
    type: 'button',
    onclick: async () => {
      const { share: guarded } = await lock;
      if (guarded && !(await authenticate('create a share link'))) {
        toast('Nothing was shared.', 'error');
        return;
      }
      const days = EXPIRY_CHOICES[Number(expiry.value)].days;
      try {
        const { share, token } = await api.createShare({
          targetType: target.type,
          targetId: target.id,
          permission: permission.value,
          expiresAt: days === null ? null : Date.now() + days * 86_400_000,
        });
        fresh.set(share.id, token);
        await refresh();
      } catch (err) { reportError(err); }
    },
  }, icon('link', { size: 14 }), 'Create link');

  await refresh();

  await dialog({
    title: `Share “${target.title}”`,
    confirmLabel: 'Done',
    cancelLabel: 'Close',
    wide: true,
    body: el('div', { class: 'share-sheet' },
      el('div', { class: 'share-new' },
        el('div', { class: 'field grow' }, el('label', { text: 'A new link' }), permission),
        el('div', { class: 'field grow' }, el('label', { text: 'Expires' }), expiry),
        create,
      ),
      list,
      el('div', { class: 'share-note' },
        isLoopback()
          ? 'Studex is running as your own server on this machine, so a link opens on this machine. '
            + 'Sharing with someone else means putting that server somewhere you both can reach.'
          : 'Anyone with the link needs no account. An edit link cannot tell two holders apart, so give it out accordingly.',
      ),
    ),
    onConfirm: () => true,
  });
}
