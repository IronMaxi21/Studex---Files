/**
 * How a deck's cards are set.
 *
 * A template is per deck: alignment, type size, whether a sitting shows the
 * back first, and up to two extra fields the student names — "Pronunciation",
 * "Worked answer". The server validates and stores it; this module reads it
 * (cached for the life of the window, since a sitting may interleave many
 * decks), edits it, and draws a card's extra fields.
 */
import { el } from './dom.js';
import { api } from './api.js';
import { dialog } from './dialog.js';
import { renderMathText } from './math.js';

export const DEFAULT_TEMPLATE = Object.freeze({ align: 'left', size: 'medium', backFirst: false, fields: [] });

const cache = new Map();

/** A deck's template, or the default look. Never throws: a sitting must not stall on it. */
export async function templateFor(deckId) {
  if (!deckId) return DEFAULT_TEMPLATE;
  if (!cache.has(deckId)) {
    cache.set(deckId, api.deckTemplate(deckId)
      .then((res) => res?.template ?? DEFAULT_TEMPLATE)
      .catch(() => { cache.delete(deckId); return DEFAULT_TEMPLATE; }));
  }
  return cache.get(deckId);
}

/** Templates for every deck a queue of cards comes from, keyed by deck id. */
export async function templatesFor(cards) {
  const ids = [...new Set(cards.map((c) => c.deck_id).filter(Boolean))];
  const pairs = await Promise.all(ids.map(async (id) => [id, await templateFor(id)]));
  return new Map(pairs);
}

/** Classes that set a card surface the way its deck asks. */
export function surfaceClasses(template) {
  const t = template ?? DEFAULT_TEMPLATE;
  return `${t.align === 'center' ? ' tpl-center' : ''}${t.size !== 'medium' ? ` tpl-${t.size}` : ''}`;
}

/** Whether a sitting should open on the back: the deck's choice, flipped by the student's own reverse setting. */
export function showBackFirst(template, reverse) {
  return Boolean(template?.backFirst) !== Boolean(reverse);
}

/** The extra fields a card has filled, drawn under its answer. */
export function extraFields(template, card) {
  const fields = template?.fields ?? [];
  const rows = fields
    .map((field, i) => ({ field, value: card?.[`extra${i + 1}`] }))
    .filter((row) => row.value);
  if (!rows.length) return null;
  return el('div', { class: 'card-extras' }, rows.map(({ field, value }) => {
    const body = el('div', { class: `value ${field.kind === 'worked' ? 'worked' : ''}` });
    renderMathText(body, value);
    return el('div', { class: 'card-extra' }, el('div', { class: 'label', text: field.label }), body);
  }));
}

/** Plain text of the extra fields, for screen readers and audio review. */
export function extraText(template, card) {
  return (template?.fields ?? [])
    .map((field, i) => (card?.[`extra${i + 1}`] ? `${field.label}. ${card[`extra${i + 1}`]}.` : ''))
    .filter(Boolean).join(' ');
}

function choice(id, label, options, value) {
  const select = el('select', { class: 'input', id },
    options.map(([v, text]) => el('option', { value: v, text, selected: v === value })));
  return { select, node: el('div', { class: 'field grow' }, el('label', { for: id, text: label }), select) };
}

/** Opens the template editor for a deck. Resolves true when a change was saved. */
export async function editTemplate(deckId) {
  const current = await templateFor(deckId);
  const align = choice('tpl-align', 'Alignment', [['left', 'Left'], ['center', 'Centred']], current.align);
  const size = choice('tpl-size', 'Type size', [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']], current.size);
  const backFirst = el('input', { type: 'checkbox', id: 'tpl-back-first', checked: current.backFirst });
  const fieldRows = [0, 1].map((i) => {
    const existing = current.fields[i];
    const label = el('input', {
      class: 'input', id: `tpl-field-${i}`, maxlength: 40,
      placeholder: i === 0 ? 'e.g. Pronunciation' : 'e.g. Worked answer', value: existing?.label ?? '',
    });
    const kind = choice(`tpl-kind-${i}`, 'Shown as', [['line', 'A short line'], ['worked', 'Worked steps']], existing?.kind ?? 'line');
    return {
      label, kind: kind.select,
      node: el('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-end' } },
        el('div', { class: 'field grow' }, el('label', { for: `tpl-field-${i}`, text: `Extra field ${i + 1}` }), label),
        kind.node),
    };
  });

  return dialog({
    title: 'Card template',
    confirmLabel: 'Save template',
    body: el('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
      el('div', { class: 'muted', text: 'How every card in this deck is set, and any extra fields its cards carry.' }),
      el('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap' } }, align.node, size.node),
      el('label', { for: 'tpl-back-first', style: { display: 'flex', alignItems: 'center', gap: '8px' } }, backFirst, ' Show the back first when studying'),
      fieldRows.map((row) => row.node),
    ),
    onConfirm: async () => {
      const fields = fieldRows
        .map((row) => ({ label: row.label.value.trim(), kind: row.kind.value }))
        .filter((f) => f.label);
      const next = { align: align.select.value, size: size.select.value, backFirst: backFirst.checked, fields };
      const isDefault = next.align === 'left' && next.size === 'medium' && !next.backFirst && !fields.length;
      const res = await api.setDeckTemplate(deckId, isDefault ? null : next);
      cache.set(deckId, Promise.resolve(res?.template ?? DEFAULT_TEMPLATE));
      return true;
    },
  });
}
