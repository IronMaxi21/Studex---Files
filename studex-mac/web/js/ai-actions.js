/**
 * Things the tutor can offer to make, and the buttons that make them.
 *
 * The model is never given the keys to the database. It writes; it does not
 * act. When a student asks for a set of cards or a slot in their calendar, the
 * answer comes back with a small block of JSON describing what it would make,
 * and that block is drawn here as a card with a button on it. Nothing happens
 * until the student presses it, and when they do the work is done by this
 * client, over the same authenticated endpoints the rest of the app uses, with
 * the same validation on the far side.
 *
 * That is the whole security story, and it is why there is no tool-calling
 * plumbing on the server: a proposal that is never pressed is a paragraph of
 * text, and a proposal that is pressed is the student's own action.
 *
 * Everything a block claims is checked here before it is sent — a title that
 * is 4,000 characters, a confidence of 11, a date in words — so a bad block
 * fails with a sentence rather than a 400.
 */
import { el, icon } from './dom.js';
import { api } from './api.js';
import { navigate } from './router.js';
import { loadLibrary, toast } from './store.js';

const MAX_CARDS = 40;

/* ── turning a proposal into the thing it proposes ─────────────────────── */

/** The Markdown the tutor is asked to write, as document lines. */
function blocksFrom(markdown) {
  const blocks = [];
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  const push = (block) => blocks.push({ id: crypto.randomUUID(), ...block });

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;

    // A display equation, which may run over several lines.
    if (/^\s*\$\$/.test(line)) {
      const body = [line.replace(/^\s*\$\$/, '')];
      while (body.join('\n').indexOf('$$') === -1 && i + 1 < lines.length) { i += 1; body.push(lines[i]); }
      const latex = body.join('\n').replace(/\$\$[\s\S]*$/, '').trim();
      if (latex) { push({ type: 'math', latex: latex.slice(0, 4_000), caption: null }); continue; }
    }

    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      push({ type: 'heading', level: Math.min(heading[1].length, 3), text: heading[2].trim().slice(0, 500) });
      continue;
    }
    const bullet = /^\s*([-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) { push({ type: 'bullet', text: bullet[2].trim().slice(0, 5_000), indent: 0 }); continue; }

    // Everything else is a paragraph, and consecutive lines are one paragraph —
    // a soft wrap in the model's output is not a new line in the note.
    const para = [line];
    while (i + 1 < lines.length && lines[i + 1].trim() && !/^\s*(#{1,6}\s|[-*•]\s|\d+[.)]\s|\$\$)/.test(lines[i + 1])) {
      i += 1; para.push(lines[i]);
    }
    push({ type: 'paragraph', text: para.join(' ').trim().slice(0, 20_000) });
  }
  // A document with nothing in it is still a document, and an empty one opens
  // on a blank line rather than on nothing at all.
  if (!blocks.length) push({ type: 'paragraph', text: '' });
  return blocks;
}

/** A local date-time as the model writes it, as milliseconds. */
function whenFrom(value, what) {
  const str = String(value ?? '').trim();
  if (!str) throw new Error(`No ${what} was given.`);
  // A bare date is midnight *here*, not midnight UTC — which is the previous
  // evening for most of the world, and puts an exam on the wrong day.
  const ms = new Date(str.includes('T') ? str : `${str}T00:00`).getTime();
  if (!Number.isFinite(ms)) throw new Error(`“${str}” is not a date I can read.`);
  return ms;
}

function title(value, fallback) {
  const str = String(value ?? '').trim().slice(0, 200);
  if (!str) return fallback;
  return str;
}

const EVENT_KINDS = ['exam', 'deadline', 'study_block', 'class', 'event', 'personal'];

/** Confidence is an integer out of five; anything else is a mistake, not a rating. */
function clampConfidence(value) {
  return Math.max(0, Math.min(5, Math.round(Number(value) || 0)));
}

/**
 * One entry per thing the tutor may offer. `summary` is what the card says
 * before it is pressed, `run` does it and returns where the result lives.
 */
const ACTIONS = {
  document: {
    icon: 'file-text', kind: 'Note', verb: 'Create note',
    summary: (a) => title(a.title, 'Untitled note'),
    detail: (a) => `${blocksFrom(a.body).length} lines`,
    async run(a) {
      const name = title(a.title, 'Untitled note');
      const { file } = await api.createFile({ title: name, kind: 'doc' });
      await api.saveDocument(file.id, blocksFrom(a.body));
      return { route: `doc/${file.id}`, label: name };
    },
  },

  deck: {
    icon: 'cards', kind: 'Deck', verb: 'Create deck',
    summary: (a) => title(a.title, 'Untitled deck'),
    detail: (a) => `${Math.min((a.cards ?? []).length, MAX_CARDS)} cards`,
    async run(a) {
      const cards = (Array.isArray(a.cards) ? a.cards : [])
        .filter((c) => String(c?.front ?? '').trim() && String(c?.back ?? '').trim())
        .slice(0, MAX_CARDS);
      if (!cards.length) throw new Error('That deck came back with no cards in it.');
      const name = title(a.title, 'Untitled deck');
      const { file } = await api.createFile({ title: name, kind: 'deck' });
      // One at a time and in order, so a deck half-made by a dropped connection
      // is still the first half of the deck rather than a shuffled sample.
      for (const card of cards) {
        await api.createCard({ deckId: file.id, front: String(card.front).trim(), back: String(card.back).trim() });
      }
      return { route: `deck/${file.id}`, label: `${name} · ${cards.length} cards` };
    },
  },

  canvas: {
    icon: 'scribble-loop', kind: 'Canvas', verb: 'Create canvas',
    summary: (a) => title(a.title, 'Untitled canvas'),
    detail: () => 'blank, ready to work on',
    async run(a) {
      const name = title(a.title, 'Untitled canvas');
      const { file } = await api.createFile({ title: name, kind: 'canvas' });
      return { route: `canvas/${file.id}`, label: name };
    },
  },

  event: {
    icon: 'calendar-plus', kind: 'Calendar', verb: 'Add to calendar',
    summary: (a) => title(a.title, 'Untitled'),
    detail: (a) => {
      try {
        const start = new Date(whenFrom(a.startsAt, 'start'));
        const day = start.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
        return a.allDay ? day : `${day}, ${start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
      } catch { return 'date unreadable'; }
    },
    async run(a) {
      const startsAt = whenFrom(a.startsAt, 'start');
      const endsAt = a.endsAt ? whenFrom(a.endsAt, 'end') : null;
      if (endsAt !== null && endsAt < startsAt) throw new Error('That event ends before it starts.');
      await api.createEvent({
        title: title(a.title, 'Untitled'),
        kind: EVENT_KINDS.includes(a.kind) ? a.kind : 'study_block',
        startsAt,
        ...(endsAt !== null ? { endsAt } : {}),
        allDay: Boolean(a.allDay),
      });
      return { route: 'calendar', label: title(a.title, 'Untitled') };
    },
  },

  topic: {
    icon: 'list-checks', kind: 'Topic', verb: 'Add topic',
    summary: (a) => title(a.name, 'Untitled topic'),
    detail: (a) => (a.unit ? String(a.unit).slice(0, 80) : 'to your topic list'),
    async run(a) {
      const name = title(a.name, '');
      if (!name) throw new Error('That topic has no name.');
      await api.createTopic({
        name,
        ...(a.unit ? { unit: String(a.unit).slice(0, 80) } : {}),
        ...(a.notes ? { notes: String(a.notes).slice(0, 2_000) } : {}),
        ...(a.confidence != null ? { confidence: clampConfidence(a.confidence) } : {}),
      });
      return { route: 'topics', label: name };
    },
  },

  topicEdit: {
    icon: 'pencil-simple', kind: 'Topic', verb: 'Apply change',
    summary: (a) => title(a.name, 'Update a topic'),
    detail: (a) => {
      const bits = [];
      if (a.name) bits.push('rename');
      if (a.unit) bits.push('unit');
      if (a.notes) bits.push('notes');
      if (a.confidence != null) bits.push(`confidence ${clampConfidence(a.confidence)}`);
      return bits.length ? bits.join(', ') : 'no change';
    },
    async run(a) {
      const id = String(a.id ?? '').trim();
      if (!id) throw new Error('That change does not say which topic it is for.');
      const patch = {
        ...(a.name ? { name: String(a.name).slice(0, 160) } : {}),
        ...(a.unit ? { unit: String(a.unit).slice(0, 80) } : {}),
        ...(a.notes ? { notes: String(a.notes).slice(0, 2_000) } : {}),
      };
      // Confidence is not an edit but a rating: it moves the topic's place in
      // the spaced schedule, so it goes through the endpoint that reschedules
      // it rather than through a plain field update. Zero means "not rated",
      // which that endpoint has no way to express, so it is left alone.
      const rating = a.confidence != null ? clampConfidence(a.confidence) : 0;
      if (!Object.keys(patch).length && !rating) throw new Error('That change would not change anything.');
      if (Object.keys(patch).length) await api.updateTopic(id, patch);
      if (rating) await api.rateTopic(id, rating);
      return { route: 'topics', label: 'Topics' };
    },
  },
};

/* ── the card ──────────────────────────────────────────────────────────── */

/**
 * Draws one proposal. `source` is the raw text of the fenced block; anything
 * that is not a proposal this app understands is shown as the code it is,
 * rather than swallowed — a student who sees the model produce something odd
 * should be able to see what it produced.
 */
export function actionCard(source) {
  let spec;
  try { spec = JSON.parse(source); } catch { return el('pre', null, el('code', { text: source })); }
  const action = ACTIONS[spec?.do];
  if (!action) return el('pre', null, el('code', { text: source }));

  const status = el('div', { class: 'note' });
  const go = el('button', { class: 'btn primary', type: 'button', text: action.verb });
  const card = el('div', { class: 'ai-action' },
    el('div', { class: 'head' },
      icon(action.icon, { size: 15 }),
      el('div', { class: 'what' },
        el('div', { class: 'kind', text: action.kind }),
        el('div', { class: 'title', text: safely(() => action.summary(spec), 'Something to make') }),
      ),
    ),
    el('div', { class: 'detail', text: safely(() => action.detail(spec), '') }),
    el('div', { class: 'go' }, go, status),
  );

  go.onclick = async () => {
    go.disabled = true;
    go.textContent = 'Working…';
    status.textContent = '';
    try {
      const made = await action.run(spec);
      // The sidebar counts files, so it has to hear about a new one.
      await loadLibrary().catch(() => {});
      card.classList.add('done');
      go.replaceWith(el('button', {
        class: 'btn', type: 'button', text: 'Open',
        onclick: () => navigate(made.route),
      }));
      status.textContent = made.label;
      toast('Done.');
    } catch (err) {
      go.disabled = false;
      go.textContent = action.verb;
      status.textContent = err?.message ?? 'That did not work.';
      card.classList.add('failed');
    }
  };

  return card;
}

/** A describing function is not worth an exception; a card without a subtitle is. */
function safely(fn, fallback) {
  try { return fn() ?? fallback; } catch { return fallback; }
}
