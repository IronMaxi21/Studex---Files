/**
 * Image occlusion: scheduled cards drawn over a diagram.
 *
 * A student boxes the labels of a cell, a map or a circuit, names each box, and
 * every named box becomes a card in a deck that hides that region and asks for
 * it back. The picture is copied into the deck, so the cards outlive the page
 * or PDF it came from; the boxes are fractions of the picture, so they land in
 * the same place at any size.
 *
 * Making cards from the same diagram again (from a card's "Edit diagram")
 * updates the set: surviving boxes keep their card and its history, new boxes
 * add cards, deleted boxes remove theirs.
 */
import { el, icon, mount } from './dom.js';
import { dropdown } from './select.js';
import { api } from './api.js';
import { state, toast, reportError } from './store.js';
import { dialog } from './dialog.js';
import { plural } from './format.js';

const MAX_MASKS = 60;

/** The occlusion data on a card, or null for an ordinary card. */
export function readOcclusion(card) {
  if (!card?.occlusion) return null;
  if (typeof card.occlusion === 'object') return card.occlusion;
  try {
    const data = JSON.parse(card.occlusion);
    return data && data.imageId && Array.isArray(data.masks) ? data : null;
  } catch {
    return null;
  }
}

const boxStyle = (mask) => ({
  left: `${mask.x * 100}%`,
  top: `${mask.y * 100}%`,
  width: `${mask.width * 100}%`,
  height: `${mask.height * 100}%`,
});

/**
 * The review face of an occlusion card: the diagram with its region hidden.
 *
 * In 'one' mode only the asked region is covered, so the rest of the diagram
 * is a clue; in 'all' mode every region stays covered and the asked one is
 * marked. On reveal the asked region opens and its answer is written on it.
 */
export function occlusionFigure(data, { revealed = false } = {}) {
  const shown = data.mode === 'all' ? data.masks : data.masks.filter((m) => m.id === data.target);
  const figure = el('div', { class: 'image-frame quiz-figure occlusion-figure' },
    el('img', { src: api.imageContentUrl(data.imageId), alt: 'Diagram', draggable: 'false' }),
    el('div', { class: 'mask-layer' }, shown.map((mask) => {
      const asked = mask.id === data.target;
      return el('span', {
        class: 'mask' + (asked ? ' asked' : '') + (asked && revealed ? ' open' : ''),
        style: boxStyle(mask),
      }, asked ? el('span', { class: 'mask-num', text: revealed ? '' : '?' }) : null);
    })),
  );
  const img = figure.querySelector('img');
  img.addEventListener('error', () => {
    mount(figure, el('div', { class: 'image-missing' },
      icon('image-broken', { size: 18 }), 'This diagram is no longer here.'));
  });
  return figure;
}

/**
 * Opens the editor. `source` is one of:
 *  - `{ blob }` — a picture not yet stored (a rendered PDF page);
 *  - `{ url }` — a picture stored elsewhere, copied into the deck on save;
 *  - `{ imageId, deckId }` — a diagram already in a deck, remade in place.
 * `masks` seeds the boxes; `sourceFileId` and `sourcePage` record provenance.
 * Resolves to the server's `{ cards, created, updated, removed }`, or null.
 */
export async function openOcclusionEditor({
  blob = null, url = null, imageId = null, deckId = null,
  masks: seed = [], mode: seedMode = 'one', prompt: seedPrompt = '',
  sourceFileId = null, sourcePage = null, title = 'Make cards from a diagram',
} = {}) {
  const decks = state.files.filter((f) => f.kind === 'deck' && !f.trashed_at);
  if (!decks.length && !deckId) { toast('Create a flashcard deck first.', 'error'); return null; }

  const objectUrl = blob ? URL.createObjectURL(blob) : null;
  const src = objectUrl ?? url ?? api.imageContentUrl(imageId);
  const masks = seed
    .filter((m) => m && Number.isFinite(m.x) && Number.isFinite(m.y))
    .slice(0, MAX_MASKS)
    .map((m) => ({ id: String(m.id ?? crypto.randomUUID()).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || crypto.randomUUID(), x: m.x, y: m.y, width: m.width, height: m.height, label: m.label ?? '' }));
  let mode = seedMode === 'all' ? 'all' : 'one';

  const layer = el('div', { class: 'mask-layer editing' });
  const draft = el('div', { class: 'mask-draft' });
  draft.hidden = true;
  const list = el('ol', { class: 'occl-list' });
  const count = el('div', { class: 'sub occl-count' });

  function draw(focusAt = -1) {
    mount(layer,
      ...masks.map((mask, at) => el('button', {
        type: 'button',
        class: 'mask' + (mask.label ? ' named' : ''),
        style: boxStyle(mask),
        title: mask.label ? `“${mask.label}”` : 'Name this region in the list',
        onclick: (event) => { event.stopPropagation(); list.querySelectorAll('input')[at]?.focus(); },
      }, el('span', { class: 'mask-num', text: `${at + 1}` }))),
      draft,
    );
    mount(list, ...masks.map((mask, at) => el('li', { class: 'occl-row' },
      el('span', { class: 'mask-num', text: `${at + 1}` }),
      el('input', {
        class: 'input', value: mask.label, maxlength: '200',
        placeholder: 'What is under this box?',
        'aria-label': `Answer for region ${at + 1}`,
        oninput: (event) => {
          mask.label = event.target.value;
          layer.children[at]?.classList.toggle('named', !!mask.label.trim());
          updateCount();
        },
      }),
      el('button', {
        type: 'button', class: 'icon-btn', title: 'Remove this box',
        onclick: () => { masks.splice(at, 1); draw(); },
      }, icon('x', { size: 13 })),
    )));
    if (!masks.length) list.appendChild(el('li', { class: 'sub', text: 'Drag across the picture to cover a label.' }));
    updateCount();
    if (focusAt >= 0) list.querySelectorAll('input')[focusAt]?.focus();
  }

  function updateCount() {
    const named = masks.filter((m) => m.label.trim()).length;
    count.textContent = named
      ? `${plural(named, 'card')} will be made${masks.length > named ? ` · ${masks.length - named} unnamed ${masks.length - named === 1 ? 'box hides' : 'boxes hide'} only` : ''}`
      : 'Name a box to make a card from it.';
  }

  layer.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target !== layer) return;
    event.preventDefault();
    const frame = layer.getBoundingClientRect();
    if (frame.width < 4 || frame.height < 4) return;
    const clamp = (n) => Math.max(0, Math.min(1, n));
    const x0 = clamp((event.clientX - frame.left) / frame.width);
    const y0 = clamp((event.clientY - frame.top) / frame.height);
    layer.setPointerCapture(event.pointerId);
    const at = (e) => [clamp((e.clientX - frame.left) / frame.width), clamp((e.clientY - frame.top) / frame.height)];
    const move = (e) => {
      const [x1, y1] = at(e);
      draft.hidden = false;
      Object.assign(draft.style, boxStyle({ x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) }));
    };
    const up = (e) => {
      layer.removeEventListener('pointermove', move);
      layer.removeEventListener('pointerup', up);
      layer.removeEventListener('pointercancel', up);
      draft.hidden = true;
      const [x1, y1] = at(e);
      const width = Math.abs(x1 - x0);
      const height = Math.abs(y1 - y0);
      if (width < 0.01 || height < 0.01) return;
      if (masks.length >= MAX_MASKS) { toast('That is as many boxes as one diagram can hold.', 'error'); return; }
      masks.push({ id: crypto.randomUUID(), x: Math.min(x0, x1), y: Math.min(y0, y1), width, height, label: '' });
      draw(masks.length - 1);
    };
    layer.addEventListener('pointermove', move);
    layer.addEventListener('pointerup', up);
    layer.addEventListener('pointercancel', up);
  });

  const deckPick = deckId
    ? null
    : dropdown({ class: 'input', value: state.lastOcclusionDeck ?? decks[0].id },
      decks.map((d) => el('option', { value: d.id, text: d.title })));
  const promptField = el('input', { class: 'input', value: seedPrompt, maxlength: '200', placeholder: 'What is hidden here?' });
  const modeSeg = el('div', { class: 'seg small', role: 'group', 'aria-label': 'What stays covered' });
  const drawMode = () => mount(modeSeg,
    el('button', { type: 'button', class: mode === 'one' ? 'on' : '', text: 'Hide one', title: 'Only the asked box is covered; the rest of the diagram is a clue', onclick: () => { mode = 'one'; drawMode(); } }),
    el('button', { type: 'button', class: mode === 'all' ? 'on' : '', text: 'Hide all', title: 'Every box stays covered; one is asked', onclick: () => { mode = 'all'; drawMode(); } }),
  );
  drawMode();
  draw();

  try {
    return await dialog({
      title,
      wide: true,
      confirmLabel: 'Make cards',
      body: el('div', { class: 'occl-editor' },
        el('div', { class: 'image-frame occl-stage' }, el('img', { src, alt: 'Diagram', draggable: 'false' }), layer),
        el('div', { class: 'occl-side' },
          el('div', { class: 'field' }, el('label', { text: 'Boxes' }), list, count),
          el('div', { class: 'occl-options' },
            deckPick ? el('div', { class: 'field' }, el('label', { text: 'Deck' }), deckPick) : null,
            el('div', { class: 'field' }, el('label', { text: 'Question' }), promptField),
            el('div', { class: 'field' }, el('label', { text: 'While studying' }), modeSeg),
          ),
        ),
      ),
      onConfirm: async () => {
        const named = masks.filter((m) => m.label.trim());
        if (!named.length) { toast('Name at least one box — its name is the answer.', 'error'); return false; }
        const target = deckId ?? deckPick.value;
        try {
          let id = imageId;
          if (!id) {
            const picture = blob ?? await (await fetch(url, { credentials: 'same-origin' })).blob();
            const form = new FormData();
            form.append('file', picture, 'diagram.png');
            ({ image: { id } } = await api.uploadDeckImage(target, form));
          }
          const result = await api.occlusionCards(target, {
            imageId: id,
            masks: masks.map((m) => ({ ...m, label: m.label.trim() || null })),
            mode,
            prompt: promptField.value.trim() || null,
            sourceFileId,
            sourcePage,
          });
          state.lastOcclusionDeck = target;
          const parts = [
            result.created ? `${plural(result.created, 'card')} made` : '',
            result.updated ? `${result.updated} updated` : '',
            result.removed ? `${result.removed} removed` : '',
          ].filter(Boolean);
          toast(parts.join(' · ') || 'Cards saved');
          return result;
        } catch (err) {
          reportError(err);
          return false;
        }
      },
    });
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}
