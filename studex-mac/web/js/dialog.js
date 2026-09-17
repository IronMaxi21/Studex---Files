/** Modal prompts and confirmations. */
import { el, icon, trapFocus } from './dom.js';

/* Each dialog needs an id of its own to be named by, and two open at once —
   a confirmation raised from inside a prompt — must not both answer to it. */
let dialogSeq = 0;

export function dialog({ title, body, confirmLabel = 'Save', cancelLabel = 'Cancel', danger = false, wide = false, onConfirm }) {
  return new Promise((resolve) => {
    const backdrop = el('div', { class: 'backdrop' });
    const titleId = `dialog-title-${++dialogSeq}`;
    let release = null;

    const close = (result) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      // Released after the node is gone, so focus lands on the control that
      // opened the dialog rather than being taken back off it a tick later.
      release?.();
      release = null;
      resolve(result);
    };

    function onKey(event) {
      if (event.key === 'Escape') { event.preventDefault(); close(null); }
    }

    const confirm = el('button', {
      class: 'btn primary lg',
      type: 'submit',
      style: danger ? { borderColor: 'var(--color-danger-strong)', color: 'var(--color-danger)' } : null,
      text: confirmLabel,
    });

    const form = el('form', {
      onsubmit: async (event) => {
        event.preventDefault();
        confirm.disabled = true;
        try {
          const value = onConfirm ? await onConfirm() : true;
          if (value !== false) close(value ?? true);
          else confirm.disabled = false;
        } catch (err) {
          confirm.disabled = false;
          throw err;
        }
      },
    },
      el('div', {
        class: wide ? 'dialog wide' : 'dialog',
        // Declared rather than merely drawn: `aria-modal` is what tells a
        // screen reader that the rest of the document is not there for the
        // moment, which is the thing the backdrop says to everyone else.
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': titleId,
      },
        el('div', { class: 'title', id: titleId, text: title }),
        body,
        el('div', { class: 'actions' },
          // A sheet whose every change is already written has nothing to
          // cancel; `cancelLabel: null` is how such a sheet says so.
          cancelLabel
            ? el('button', { class: 'btn lg', type: 'button', text: cancelLabel, onclick: () => close(null) })
            : null,
          confirm,
        ),
      ),
    );

    backdrop.appendChild(form);
    backdrop.addEventListener('mousedown', (event) => { if (event.target === backdrop) close(null); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(backdrop);

    release = trapFocus(backdrop);

    // A field if there is one; otherwise the confirm button, so that a
    // confirmation opens with the keyboard already inside it rather than on
    // whatever was behind the backdrop.
    const first = form.querySelector('input, textarea, select, [data-select]') ?? confirm;
    first.focus();
  });
}

/**
 * Single-field text prompt. Resolves to the trimmed string, or null.
 * With `fallback`, a blank answer resolves to it instead of being refused —
 * how every file and folder name becomes "Untitled" when left empty.
 */
export function promptText({ title, label, value = '', placeholder = '', confirmLabel = 'Create', fallback = null }) {
  const input = el('input', { class: 'input', value, placeholder: placeholder || fallback || '', maxlength: 200 });
  return dialog({
    title,
    confirmLabel,
    body: el('div', { class: 'field' }, label ? el('label', { text: label }) : null, input),
    onConfirm: () => {
      const text = input.value.trim() || fallback;
      if (!text) { input.focus(); return false; }
      return text;
    },
  });
}

/**
 * The one question asked before anything is deleted.
 *
 * It is deliberately the same sentence every time. Confirmations that reword
 * themselves per screen are the ones people stop reading, and a delete is the
 * last place that should happen — so the wording is fixed here and the caller
 * may only add what is lost, underneath it.
 */
export function confirmDelete(detail, { confirmLabel = 'Delete' } = {}) {
  return dialog({
    title: 'Are you sure you want to delete that?',
    confirmLabel,
    danger: true,
    body: detail
      ? el('div', { class: 'muted', style: { lineHeight: '1.6' } }, detail)
      : null,
    onConfirm: () => true,
  });
}

export function confirmDialog({ title, message, confirmLabel = 'Delete', danger = true }) {
  return dialog({
    title,
    confirmLabel,
    danger,
    body: el('div', { class: 'muted', style: { lineHeight: '1.6' } }, message),
    onConfirm: () => true,
  });
}

/**
 * A colour of the student's own choosing.
 *
 * The seven roles cover the palette the app was designed around, but a subject
 * has whatever colour its textbook has. Both fields drive the same value, so
 * the swatch can be dragged or the hex typed, whichever is to hand.
 */
export function promptColor({ title = 'Custom colour', value = '#4f46e5' } = {}) {
  const start = /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : '#4f46e5';
  const swatch = el('input', { type: 'color', class: 'color-input', value: start });
  const hex = el('input', { class: 'input', value: start, maxlength: 7, spellcheck: 'false' });

  swatch.addEventListener('input', () => { hex.value = swatch.value; });
  hex.addEventListener('input', () => {
    if (/^#[0-9a-fA-F]{6}$/.test(hex.value.trim())) swatch.value = hex.value.trim().toLowerCase();
  });

  return dialog({
    title,
    confirmLabel: 'Use colour',
    body: el('div', { class: 'field' },
      el('label', { text: 'Colour' }),
      el('div', { class: 'color-row' }, swatch, hex),
    ),
    onConfirm: () => {
      const chosen = hex.value.trim().toLowerCase();
      if (!/^#[0-9a-f]{6}$/.test(chosen)) { hex.focus(); return false; }
      return chosen;
    },
  });
}
