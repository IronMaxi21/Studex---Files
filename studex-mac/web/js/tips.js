/**
 * A single tip the first time each kind of screen is opened, in the corner,
 * that says the one thing worth knowing *there* and then goes away for good.
 *
 * What has been seen is kept per account in this Mac's storage. It is not
 * worth a server round trip, and a tip seen again on a new Mac is not a harm.
 */
import { el, icon } from './dom.js';
import { state } from './store.js';
import { askAbout } from './chat.js';

const KEY = 'studex.tour';

function seen() {
  try { return JSON.parse(localStorage.getItem(`${KEY}.${state.user?.id ?? 'anon'}`) ?? '{}') ?? {}; }
  catch { return {}; }
}
function mark(id) {
  try {
    const all = seen();
    all[id] = Date.now();
    localStorage.setItem(`${KEY}.${state.user?.id ?? 'anon'}`, JSON.stringify(all));
  } catch { /* storage refused: the tip simply shows again next time */ }
}

/** Forgets every tip, from the account menu. */
export function resetTips() {
  try { localStorage.removeItem(`${KEY}.${state.user?.id ?? 'anon'}`); } catch { /* nothing to forget */ }
}

/* ── one tip per screen ───────────────────────────────────────────────── */

const TIPS = {
  library: {
    title: 'Your library',
    body: 'Drag files onto folders to file them, or drop files from Finder anywhere to import. Right-click anything for more.',
  },
  doc: {
    title: 'Writing notes',
    body: 'Type / for blocks. Drag across lines to select several. A bullet written “term :: meaning” makes a flashcard.',
    ai: { label: 'Quiz me on this', prompt: 'Ask me three short questions on this note, one at a time, and tell me if I get them right.' },
  },
  pdf: {
    title: 'Reading a PDF',
    body: 'Select text to highlight, annotate or explain it. Your notes stay attached to the page they belong to.',
    ai: { label: 'Summarise it', prompt: 'Summarise this PDF in five bullet points a student could revise from.' },
  },
  flashcards: {
    title: 'Decks and streaks',
    body: 'Review whatever is due each day to keep your streak. Cards you find hard come back sooner.',
  },
  deck: {
    title: 'A deck',
    body: 'Add cards here, or make them from any document or PDF. Press Review to study what is due.',
    ai: { label: 'Suggest more cards', prompt: 'Look at this deck and suggest five more cards that would fill gaps in it, as “term :: meaning”.' },
  },
  calendar: {
    title: 'Your calendar',
    body: 'Add exams and events, then let Studex plan revision blocks in the days before them.',
    ai: { label: 'Plan my week', prompt: 'Help me plan a realistic revision timetable for this week. Ask what exams I have first.', withPage: false },
  },
  topics: {
    title: 'Topics',
    body: 'Rate your confidence in each topic of a subject. The weakest ones are what Studex suggests revising first.',
    ai: { label: 'What should I revise first?', prompt: 'Based on my topics and confidence, what should I revise first and why?' },
  },
  canvas: {
    title: 'Canvas',
    body: 'Sticky notes, shapes and ink on an endless page. Scroll to move around and pinch to zoom.',
  },
  trash: {
    title: 'Trash',
    body: 'Trashed files stay here for 30 days, so a mistake can always be restored.',
  },
};

/** Shows the tip for this screen once, in the corner of its pane. */
export function pageTip(head, host) {
  const tip = TIPS[head];
  if (!tip || !host || !state.user) return;
  if (seen()[`tip:${head}`]) return;
  if (host.querySelector('.page-tip')) return;
  mark(`tip:${head}`);

  const node = el('div', { class: 'page-tip', role: 'note' },
    el('div', { class: 'page-tip-head' },
      icon('lightbulb', { size: 15 }),
      el('span', { class: 'grow', text: tip.title }),
      el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Dismiss tip', onclick: () => dismiss() }, icon('x', { size: 13 })),
    ),
    el('p', { text: tip.body }),
    el('div', { class: 'page-tip-actions' },
      tip.ai
        ? el('button', {
            class: 'chip', type: 'button',
            onclick: () => { dismiss(); askAbout(tip.ai.prompt, { withPage: tip.ai.withPage !== false }); },
          }, icon('sparkle', { size: 13 }), tip.ai.label)
        : null,
      el('span', { class: 'grow' }),
      el('button', { class: 'btn', type: 'button', text: 'Got it', onclick: () => dismiss() }),
    ),
  );
  let timer = null;
  function dismiss() {
    clearTimeout(timer);
    node.classList.remove('in');
    setTimeout(() => node.remove(), 200);
  }
  host.appendChild(node);
  requestAnimationFrame(() => node.classList.add('in'));
  // Long enough to read twice; a tip that never leaves becomes furniture.
  timer = setTimeout(dismiss, 20_000);
}
