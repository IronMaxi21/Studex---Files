/**
 * The AI features, as far as the interface is concerned.
 *
 * Everything here is a dialog. Nothing here decides whether the feature is
 * allowed, what it costs, or what the model is asked — the server owns all of
 * that, which is what makes the allowance enforceable at all when the
 * interface is a folder of JavaScript inside a bundle the student owns. This
 * side has two jobs: not to offer a button that cannot work, and never to let
 * something a model wrote reach the screen looking like something Studex
 * knows.
 */
import { el, icon, mount } from './dom.js';
import { dropdown } from './select.js';
import { dialog } from './dialog.js';
import { api } from './api.js';
import { state, toast, loadLibrary } from './store.js';
import { plural } from './format.js';
import { extractSpec, ExtractError } from './spec-extract.js';

/**
 * Whether this install has an AI at all, asked once.
 *
 * The answer comes from the environment the server was started in and cannot
 * change while the app is open, so asking again for every right-click would be
 * a request per menu. The allowance inside it does move, so a dialog that
 * shows the number asks again; a menu deciding whether to draw an item does
 * not.
 */
let statusPromise = null;

export function aiStatus() {
  if (!statusPromise) {
    // A failure here is not worth a toast: it means the menu is drawn without
    // an AI item, which is exactly what an install with no AI looks like.
    statusPromise = api.aiStatus().catch(() => ({ available: false, usage: null }));
  }
  return statusPromise;
}

/** True when there is an AI to call. Await this before building a menu. */
export async function aiAvailable() {
  return (await aiStatus()).available === true;
}

/** Forgets the cached allowance, once something has been spent against it. */
function spent() {
  statusPromise = null;
}

/** Forgets whether there is an AI at all — for Settings, once a key is saved or removed. */
export function resetAiStatus() {
  statusPromise = null;
}

const NO_AI = 'No AI key is set. Add one in Settings → AI.';

/** "22 of 30 AI requests left this month", for the foot of a dialog. */
function allowanceLine(usage) {
  if (!usage) return null;
  return el('div', { class: 'ai-allowance' },
    icon('sparkle', { size: 12 }),
    `${usage.remaining} of ${usage.limit} AI requests left this month`,
  );
}

/**
 * The line that goes under every answer.
 *
 * Not decoration. Everything else on screen is something the student wrote or
 * the server measured; this is the one place showing text that was guessed,
 * and saying so is the whole difference between a study aid and a confident
 * source of wrong answers.
 */
function caveat(text) {
  return el('div', { class: 'ai-caveat' }, icon('warning-circle', { size: 12 }), text);
}

/** A model's failure, in the place the answer was going to be. */
function failure(err) {
  return el('div', { class: 'ai-failed' }, icon('warning-circle', { size: 13 }),
    err?.message || 'That did not work.');
}

/**
 * Paragraphs, as text.
 *
 * There is no markdown renderer in the app and this is not the place to
 * introduce one: it would be the only path where a remote string is parsed
 * into structure. Blank lines become paragraphs and nothing else is read.
 */
function prose(answer) {
  return el('div', { class: 'ai-prose' },
    answer.split(/\n{2,}/).map((para) => para.trim()).filter(Boolean)
      .map((para) => el('p', { text: para })),
  );
}

/* ------------------------------- explain ---------------------------------- */

/**
 * "What does this actually mean?", on a passage someone has highlighted.
 *
 * The dialog opens before the answer exists rather than after it arrives: the
 * request takes seconds, and a menu item that appears to do nothing for four
 * of them is a menu item people click twice.
 */
export async function explainPassage({ fileId = null, annotationId = null, text = null, title = 'Explain this' }) {
  const body = el('div', { class: 'ai-answer' },
    el('div', { class: 'ai-thinking' }, icon('sparkle', { size: 13 }), 'Reading the passage…'));

  const shown = dialog({ title, wide: true, confirmLabel: 'Done', cancelLabel: 'Close', body, onConfirm: () => true });

  try {
    // Only the keys that have a value: the endpoint takes either a highlight or
    // some text, and a `null` for the other one is a malformed request rather
    // than an absent field.
    const result = await api.aiExplain(
      fileId && annotationId ? { fileId, annotationId } : { text },
    );
    spent();
    mount(body,
      result.passage ? el('blockquote', { class: 'ai-passage', text: result.passage }) : null,
      prose(result.answer),
      caveat('Written by a model from the passage above. Check it against your notes.'),
    );
  } catch (err) {
    mount(body, failure(err));
  }

  return shown;
}

/**
 * "Why is that the answer?", for a card that has just been turned over.
 *
 * Deliberately not a dialog. The point is to read it beside the card and carry
 * on; a window over a study sitting breaks the rhythm the sitting exists for.
 * The node comes back empty and fills itself in, so the caller can put it on
 * screen in the same frame the button was pressed rather than leaving a button
 * that appears to do nothing for four seconds.
 */
export function explainCard({ front, back, given = '' }) {
  const box = el('div', { class: 'ai-explain' },
    el('div', { class: 'ai-thinking' }, icon('sparkle', { size: 13 }), 'Thinking about this card…'));

  // The card goes over as the passage, so the server's own rules about
  // explaining a fragment apply unchanged; the question is what turns
  // "explain this text" into "explain why this is the answer".
  const passage = [
    `Question: ${front}`,
    `Answer: ${back}`,
    given ? `The student wrote: ${given}` : null,
  ].filter(Boolean).join('\n');

  const question = given
    ? 'This is a flashcard a student has just got wrong. Explain why the answer is what it is, and what their own answer got wrong.'
    : 'This is a flashcard. Explain why the answer is what it is — the reasoning behind it, not a restatement of it.';

  void (async () => {
    try {
      const result = await api.aiExplain({ text: passage, question });
      spent();
      if (!box.isConnected) return;
      mount(box, prose(result.answer), caveat('Written by a model. Check it against your notes.'));
    } catch (err) {
      if (box.isConnected) mount(box, failure(err));
    }
  })();

  return box;
}

/* --------------------------- cards from material -------------------------- */

/**
 * Proposes cards, shows them, and only then writes them.
 *
 * The second dialog is the point. Cards are the thing people revise from for
 * months, and a deck quietly filled with twelve approximations is worse than
 * no cards at all — so the model's output is read first and adding it is a
 * separate, deliberate act. Adding is a plain `createCard` per card, the same
 * call the deck screen makes, so what lands in the deck is exactly what was on
 * the screen and no second request is spent to write it.
 */
export async function generateCards({ source, sourceLabel, deckId = null, sourceFileId = null }) {
  const decks = state.files.filter((f) => f.kind === 'deck');
  if (!decks.length) { toast('Create a flashcard deck first.', 'error'); return; }

  const status = await aiStatus();
  if (!status.available) { toast(NO_AI, 'error'); return; }

  const select = dropdown({ class: 'input' },
    decks.map((d) => el('option', { value: d.id, text: d.title, selected: d.id === deckId })));
  const count = el('input', { class: 'input', type: 'number', min: 1, max: 30, value: '10' });
  const note = el('div');

  let written = null;

  const asked = await dialog({
    title: 'Write cards with AI',
    confirmLabel: 'Write cards',
    body: el('div', { class: 'ai-form' },
      el('div', { class: 'muted' }, `Cards will be written from ${sourceLabel}.`),
      el('div', { class: 'field' }, el('label', { text: 'Deck' }), select),
      el('div', { class: 'field' }, el('label', { text: 'How many at most' }), count),
      note,
      allowanceLine(status.usage),
    ),
    onConfirm: async () => {
      mount(note, el('div', { class: 'ai-thinking' }, icon('sparkle', { size: 13 }), 'Reading, then writing…'));
      try {
        const result = await api.aiCards({
          deckId: select.value,
          source,
          count: Math.max(1, Math.min(30, Number(count.value) || 10)),
          commit: false,
        });
        spent();
        written = result.cards;
        return true;
      } catch (err) {
        mount(note, failure(err));
        return false;
      }
    },
  });

  if (!asked || !written?.length) return;

  const chosenDeck = select.value;
  const keep = await dialog({
    title: `${plural(written.length, 'card')} from ${sourceLabel}`,
    wide: true,
    confirmLabel: `Add ${plural(written.length, 'card')}`,
    cancelLabel: 'Discard',
    body: el('div', { class: 'ai-answer' },
      el('div', { class: 'ai-cards' }, written.map((card) => el('div', { class: 'ai-card' },
        el('div', { class: 'front', text: card.front }),
        el('div', { class: 'back', text: card.back }),
        card.topic ? el('div', { class: 'topic', text: card.topic }) : null,
      ))),
      caveat('Written by a model from your material. Read them before you revise from them.'),
    ),
    onConfirm: () => true,
  });

  if (!keep) return;

  for (const card of written) {
    await api.createCard({
      deckId: chosenDeck,
      front: card.front,
      back: card.back,
      topic: card.topic || null,
      sourceFileId,
    });
  }
  await loadLibrary();
  toast(`${plural(written.length, 'card')} added.`);
}

/* ----------------------------- revision plan ------------------------------ */

/**
 * A syllabus and an exam date in; a set of study blocks out.
 *
 * Shown as dates before anything is written, because "is this plan any good?"
 * is mostly "are those the right evenings", and that cannot be answered from a
 * list of topics. As with cards, the sessions are added with the ordinary
 * `createEvent` call rather than by asking the model again.
 */
export async function planRevision(event) {
  const status = await aiStatus();
  if (!status.available) { toast(NO_AI, 'error'); return; }

  const syllabus = el('textarea', {
    class: 'input', rows: 6,
    placeholder: 'Paste the syllabus, a reading list, or the contents page. Leave it empty to plan from the exam’s title alone.',
  });
  const minutes = el('input', { class: 'input', type: 'number', min: 15, max: 240, step: 5, value: '45' });
  const perWeek = el('input', { class: 'input', type: 'number', min: 1, max: 21, value: '5' });
  const note = el('div');

  let sessions = null;

  const asked = await dialog({
    title: 'Plan revision with AI',
    confirmLabel: 'Draw up a plan',
    body: el('div', { class: 'ai-form' },
      el('div', { class: 'muted' }, `Sessions will be laid out between now and “${event.title}”.`),
      el('div', { class: 'field' }, el('label', { text: 'Material' }), syllabus),
      el('div', { class: 'ai-pair' },
        el('div', { class: 'field' }, el('label', { text: 'Minutes each' }), minutes),
        el('div', { class: 'field' }, el('label', { text: 'Sessions a week' }), perWeek),
      ),
      note,
      allowanceLine(status.usage),
    ),
    onConfirm: async () => {
      mount(note, el('div', { class: 'ai-thinking' }, icon('sparkle', { size: 13 }), 'Working out an order…'));
      try {
        const result = await api.aiRevisionPlan({
          examEventId: event.id,
          syllabus: syllabus.value.trim() || undefined,
          minutesPerSession: Math.max(15, Math.min(240, Number(minutes.value) || 45)),
          sessionsPerWeek: Math.max(1, Math.min(21, Number(perWeek.value) || 5)),
          // The server lays out the dates; it needs to know which evening six
          // o'clock is, and only this side knows that.
          utcOffsetMinutes: -new Date().getTimezoneOffset(),
          commit: false,
        });
        spent();
        sessions = result.sessions;
        return true;
      } catch (err) {
        mount(note, failure(err));
        return false;
      }
    },
  });

  if (!asked || !sessions?.length) return;

  const when = new Intl.DateTimeFormat(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
  });

  const keep = await dialog({
    title: `${plural(sessions.length, 'session')} before ${event.title}`,
    wide: true,
    confirmLabel: 'Add to calendar',
    cancelLabel: 'Discard',
    body: el('div', { class: 'ai-answer' },
      el('div', { class: 'ai-plan' }, sessions.map((session) => el('div', { class: 'ai-session' },
        el('div', { class: 'when', text: when.format(new Date(session.startsAt)) }),
        el('div', null,
          el('div', { class: 'title', text: session.title }),
          session.focus ? el('div', { class: 'focus', text: session.focus }) : null,
        ),
      ))),
      caveat('A suggestion, not a schedule. Move anything that clashes once it is in your calendar.'),
    ),
    onConfirm: () => true,
  });

  if (!keep) return;

  for (const session of sessions) {
    await api.createEvent({
      kind: 'study_block',
      title: session.title,
      subjectId: event.subject_id ?? null,
      location: session.focus ? session.focus.slice(0, 120) : null,
      startsAt: session.startsAt,
      endsAt: session.endsAt,
      allDay: false,
      // Drafted, not decided: the same status the server gives them when it
      // writes them itself, so a plan can be looked over before it is agreed to.
      status: 'drafting',
    });
  }
  toast(`${plural(sessions.length, 'study block')} added.`);
}

/* ------------------------------ quiz ------------------------------------ */

/**
 * Multiple choice, one question at a time.
 *
 * One at a time because the answer to the first should not be sitting in view
 * while the second is read, and because "I got that wrong" is worth a moment
 * with the explanation before moving on. Nothing is saved: a quiz is a way of
 * finding out, and the finding out is the student's to act on — usually by
 * rating the topic honestly afterwards.
 */
export const QUIZ_MODES = [
  { id: 'choice', icon: 'list-checks', label: 'Multiple choice', note: 'Four options, one right.' },
  { id: 'truefalse', icon: 'check-square', label: 'True or false', note: 'Statements to call.' },
  { id: 'short', icon: 'pencil-simple-line', label: 'Short answer', note: 'Type it; AI marks it.' },
  { id: 'exam', icon: 'exam', label: 'Exam style', note: 'Written answers against a mark scheme.' },
];

function quizNormal(text) {
  return String(text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[\p{P}\s]+/gu, ' ').trim();
}

/** Picks the kind of quiz, its length and an optional time limit. */
export async function quizSetup({ label, count = 5, mode = 'choice' }) {
  let chosen = mode;
  const modes = el('div', { class: 'quiz-modes' });
  const drawModes = () => mount(modes, QUIZ_MODES.map((m) => el('button', {
    type: 'button', class: 'quiz-mode' + (m.id === chosen ? ' on' : ''),
    onclick: () => { chosen = m.id; drawModes(); },
  }, icon(m.icon, { size: 18 }), el('b', { text: m.label }), el('span', { text: m.note }))));
  drawModes();
  const length = dropdown({ class: 'input' }, [3, 5, 10, 15, 20].map((n) => el('option', { value: String(n), text: `${n} questions`, selected: n === count })));
  const timer = dropdown({ class: 'input' }, [['0', 'No time limit'], ['2', '2 minutes'], ['5', '5 minutes'], ['10', '10 minutes'], ['20', '20 minutes'], ['45', '45 minutes']]
    .map(([v, t]) => el('option', { value: v, text: t })));
  const ok = await dialog({
    title: `AI test · ${label}`,
    confirmLabel: 'Start',
    body: el('div', { class: 'ai-form' }, modes,
      el('div', { class: 'quiz-row' },
        el('div', { class: 'field' }, el('label', { text: 'Length' }), length),
        el('div', { class: 'field' }, el('label', { text: 'Timer' }), timer))),
    onConfirm: () => true,
  });
  if (!ok) return null;
  return { mode: chosen, count: Number(length.value), minutes: Number(timer.value) };
}

export async function quizDialog({ source = null, topicId = null, label, count = 5, mode = null, minutes = 0 }) {
  const status = await aiStatus();
  if (!status.available) { toast(NO_AI, 'error'); return; }
  if (!mode) {
    const picked = await quizSetup({ label, count });
    if (!picked) return;
    ({ mode, count, minutes } = picked);
  }
  const written = mode === 'short' || mode === 'exam';

  const body = el('div', { class: 'ai-answer ai-quiz' },
    el('div', { class: 'ai-thinking' }, icon('sparkle', { size: 13 }), 'Writing questions…'));
  let timerId = null;
  const shown = dialog({ title: `${QUIZ_MODES.find((m) => m.id === mode)?.label ?? 'Quiz'} · ${label}`, wide: true, confirmLabel: 'Done', cancelLabel: null, body, onConfirm: () => true });
  shown.then(() => clearInterval(timerId));

  let questions;
  try {
    const result = await api.aiQuiz(topicId ? { topicId, count, mode } : { source, count, mode });
    spent();
    questions = result.questions;
  } catch (err) {
    mount(body, failure(err));
    return shown;
  }
  if (!questions?.length) { mount(body, failure(new Error('No usable questions came back. Try again.'))); return shown; }

  let index = 0;
  let score = 0;
  let finished = false;
  const missed = [];
  const answers = [];
  const clock = el('span', { class: 'quiz-clock' });

  if (minutes > 0) {
    const endsAt = Date.now() + minutes * 60_000;
    const tick = () => {
      const left = Math.max(0, endsAt - Date.now());
      clock.textContent = `${Math.floor(left / 60_000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}`;
      clock.classList.toggle('low', left < 30_000);
      if (left <= 0) { clearInterval(timerId); if (!finished) void timeUp(); }
    };
    tick();
    timerId = setInterval(tick, 500);
  }

  const progress = () => el('div', { class: 'ai-quiz-progress' },
    `Question ${index + 1} of ${questions.length}${mode === 'exam' ? '' : ` · ${score} right so far`}`, minutes > 0 ? clock : null);

  const nextButton = (next) => {
    const last = index === questions.length - 1;
    mount(next, el('button', {
      type: 'button', class: 'btn primary',
      text: last ? 'See how it went' : 'Next question',
      onclick: () => { index += 1; if (last) void finish(); else drawQuestion(); },
    }));
    next.querySelector('button')?.focus();
  };

  const drawChoice = () => {
    const q = questions[index];
    const explanation = el('div');
    const next = el('div', { class: 'ai-quiz-next' });
    const options = q.options.map((option, i) => el('button', {
      type: 'button',
      class: 'ai-option',
      onclick: () => {
        const right = i === q.answer;
        if (right) score += 1; else missed.push({ question: q.question, answer: q.options[q.answer] });
        options.forEach((btn, j) => {
          btn.disabled = true;
          if (j === q.answer) btn.classList.add('right');
          else if (j === i) btn.classList.add('wrong');
        });
        mount(explanation,
          el('div', { class: 'ai-quiz-verdict' + (right ? ' right' : ' wrong'), text: right ? 'Right.' : `Not quite — it was “${q.options[q.answer]}”.` }),
          q.explanation ? el('p', { class: 'ai-quiz-why', text: q.explanation }) : null,
        );
        nextButton(next);
      },
    }, el('span', { class: 'letter', text: String.fromCharCode(65 + i) }), el('span', { text: option })));

    mount(body, progress(),
      el('div', { class: 'ai-quiz-question', text: q.question }),
      el('div', { class: 'ai-options' }, options),
      explanation, next);
    options[0]?.focus();
  };

  const drawWritten = () => {
    const q = questions[index];
    const input = el('textarea', { class: 'input quiz-answer', rows: mode === 'exam' ? 5 : 2, placeholder: mode === 'exam' ? 'Write your answer…' : 'Type your answer…', value: answers[index]?.given ?? '' });
    const verdict = el('div');
    const next = el('div', { class: 'ai-quiz-next' });
    const check = el('button', {
      type: 'button', class: 'btn primary',
      text: mode === 'exam' ? (index === questions.length - 1 ? 'Hand in' : 'Next question') : 'Check',
      onclick: async () => {
        answers[index] = { question: q.question, expected: q.model_answer, given: input.value };
        if (mode === 'exam') {
          index += 1;
          if (index >= questions.length) void finish(); else drawQuestion();
          return;
        }
        check.disabled = true;
        input.disabled = true;
        let right = quizNormal(input.value) === quizNormal(q.model_answer);
        let feedback = '';
        if (!right && input.value.trim()) {
          mount(verdict, el('div', { class: 'ai-thinking' }, icon('sparkle', { size: 13 }), 'Marking…'));
          try {
            const { results } = await api.aiMark({ answers: [answers[index]] });
            spent();
            right = Boolean(results[0]?.correct);
            feedback = results[0]?.feedback ?? '';
          } catch (err) { mount(verdict, failure(err)); }
        }
        if (right) score += 1; else missed.push({ question: q.question, answer: q.model_answer });
        mount(verdict,
          el('div', { class: 'ai-quiz-verdict' + (right ? ' right' : ' wrong'), text: right ? 'Right.' : 'Not quite.' }),
          el('p', { class: 'ai-quiz-why' }, el('b', { text: 'Model answer: ' }), q.model_answer),
          feedback ? el('p', { class: 'ai-quiz-why', text: feedback }) : null,
          q.explanation ? el('p', { class: 'ai-quiz-why', text: q.explanation }) : null,
        );
        nextButton(next);
      },
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (mode === 'short' ? !event.shiftKey : (event.metaKey || event.ctrlKey))) { event.preventDefault(); if (!check.disabled) check.click(); }
    });
    mount(body, progress(),
      el('div', { class: 'ai-quiz-question', text: q.question }),
      input,
      el('div', { class: 'quiz-actions' }, check,
        mode === 'exam' ? el('span', { class: 'dim', text: '⌘↵ to continue · marked when you hand in' }) : el('span', { class: 'dim', text: '↵ to check' })),
      verdict, next);
    setTimeout(() => input.focus(), 0);
  };

  const drawQuestion = () => (written ? drawWritten() : drawChoice());

  async function timeUp() {
    if (mode === 'exam') {
      const q = questions[index];
      const box = body.querySelector('.quiz-answer');
      if (q && box) answers[index] = { question: q.question, expected: q.model_answer, given: box.value };
    }
    toast('Time is up.');
    await finish();
  }

  async function finish() {
    if (finished) return;
    finished = true;
    clearInterval(timerId);
    let marked = null;
    if (mode === 'exam') {
      const all = questions.map((q, i) => answers[i] ?? { question: q.question, expected: q.model_answer, given: '' });
      mount(body, el('div', { class: 'ai-thinking' }, icon('sparkle', { size: 13 }), 'Marking your paper…'));
      try {
        marked = (await api.aiMark({ answers: all })).results;
        spent();
      } catch (err) { mount(body, failure(err)); return; }
      score = marked.filter((r) => r.correct).length;
      const pct = Math.round((marked.reduce((n, r) => n + (Number(r.score) || 0), 0) / all.length) * 100);
      mount(body,
        el('div', { class: 'ai-quiz-score', text: `${pct}%` }),
        el('div', { class: 'muted', text: `${score} of ${all.length} answers earned most of the marks.` }),
        el('div', { class: 'ai-cards' }, all.map((a, i) => el('div', { class: 'ai-card' + (marked[i]?.correct ? ' right' : ' wrong') },
          el('div', { class: 'front', text: a.question }),
          el('div', { class: 'quiz-given', text: a.given.trim() || '(left blank)' }),
          el('div', { class: 'back' }, el('b', { text: `${Math.round((Number(marked[i]?.score) || 0) * 100)}% · ` }), marked[i]?.feedback ?? ''),
          el('div', { class: 'dim', text: `Mark scheme: ${a.expected}` }),
        ))),
        caveat('Marked by a model. Check anything surprising against your notes or the specification.'),
      );
      return;
    }
    const total = questions.length;
    mount(body,
      el('div', { class: 'ai-quiz-score', text: `${score} of ${total}` }),
      el('div', { class: 'muted', text: score === total
        ? 'Every one. Rate the topic to match.'
        : index < total ? 'Stopped early. The ones to look at again:' : 'The ones to look at again:' }),
      missed.length
        ? el('div', { class: 'ai-cards' }, missed.map((q) => el('div', { class: 'ai-card' },
            el('div', { class: 'front', text: q.question }),
            el('div', { class: 'back', text: q.answer }),
          )))
        : null,
      caveat('Questions and answers were written by a model. If one looks wrong, check it against the specification.'),
    );
  }

  drawQuestion();
  return shown;
}

/* --------------------------- duplicate topics ----------------------------- */

/**
 * Topics that are the same thing twice, proposed and then merged by hand.
 *
 * Nothing is merged without a tick. Merging moves every rating onto the topic
 * kept and deletes the others, and a wrong merge of two topics that only
 * sounded alike is a rating history that cannot be pulled apart again.
 */
export async function dedupeDialog({ subjectId = null, scope = 'every subject', refresh }) {
  const status = await aiStatus();
  if (!status.available) { toast(NO_AI, 'error'); return; }

  const note = el('div');
  let found = null;

  const asked = await dialog({
    title: 'Find duplicate topics',
    confirmLabel: 'Look for duplicates',
    body: el('div', { class: 'ai-form' },
      el('div', { class: 'muted' }, `Topics in ${scope} are read for any that are the same thing written twice. Nothing is merged until you tick it.`),
      note,
      allowanceLine(status.usage),
    ),
    onConfirm: async () => {
      mount(note, el('div', { class: 'ai-thinking' }, icon('sparkle', { size: 13 }), 'Comparing topics…'));
      try {
        found = await api.aiDedupe({ subjectId });
        spent();
        return true;
      } catch (err) {
        mount(note, failure(err));
        return false;
      }
    },
  });
  if (!asked || !found) return;

  if (!found.groups.length) {
    toast(found.considered < 2 ? 'There are not enough topics to compare.' : `No duplicates among ${plural(found.considered, 'topic')}.`);
    return;
  }

  const describe = (t) => (t.ref ? `${t.ref} ${t.name}` : t.name);
  const ticks = found.groups.map(() => el('input', { type: 'checkbox', checked: true }));

  const keep = await dialog({
    title: `${plural(found.groups.length, 'possible duplicate')}`,
    wide: true,
    confirmLabel: 'Merge ticked',
    cancelLabel: 'Leave them',
    body: el('div', { class: 'ai-answer' },
      el('div', { class: 'ai-groups' }, found.groups.map((group, i) => el('label', { class: 'ai-group' },
        ticks[i],
        el('div', { class: 'grow' },
          el('div', { class: 'keep' }, el('span', { class: 'tag', text: 'KEEP' }), el('span', { text: describe(group.keep) })),
          group.merge.map((t) => el('div', { class: 'fold' }, el('span', { class: 'tag', text: 'FOLD IN' }), el('span', { text: describe(t) }))),
          group.reason ? el('div', { class: 'reason', text: group.reason }) : null,
        ),
      ))),
      found.truncated ? el('div', { class: 'muted', text: `Only the first ${found.considered} topics were compared. Filter by subject to check the rest.` }) : null,
      caveat('Suggested by a model. Folding a topic in moves its ratings and notes onto the one kept, and deletes it.'),
    ),
    onConfirm: async () => {
      let merged = 0;
      try {
        for (const [i, group] of found.groups.entries()) {
          if (!ticks[i].checked) continue;
          const result = await api.mergeTopics(group.keep.id, group.merge.map((t) => t.id));
          merged += result.merged;
        }
      } catch (err) {
        toast(err?.message || 'A merge failed.', 'error');
      }
      if (merged) toast(`Folded in ${plural(merged, 'topic')}.`);
      await refresh?.();
      return true;
    },
  });
  return keep;
}

/* ------------------------- specification import --------------------------- */

const FLAG_LABEL = { duplicate: 'Duplicate', not_a_topic: 'Not a topic', unclear: 'Unclear' };

/**
 * A specification file in, a matrix of topics out — with a look in between.
 *
 * The file's text is taken out here and sent as words, not bytes. The Reader
 * model splits it into units and topics, the Checker marks anything that looks
 * wrong, and every row is shown with a tick before any of it is written. Rows
 * the Checker doubts start unticked; references the document mentions but the
 * Reader did not return are listed at the bottom, unticked, so a skipped
 * section is visible rather than silently absent.
 */
export async function importSpecDialog({ subjectId = '', refresh }) {
  const status = await aiStatus();
  if (!status.available) { toast(NO_AI, 'error'); return; }

  let chosen = null;
  let extracted = null;
  let result = null;

  const fileLabel = el('div', { class: 'headline', text: 'Drop a specification here' });
  const fileSub = el('div', { text: 'PDF, Word (.docx) or text' });
  const picker = el('input', {
    type: 'file', accept: '.pdf,.docx,.txt,.md,application/pdf,text/plain', hidden: true,
    onchange: () => { if (picker.files?.[0]) choose(picker.files[0]); },
  });
  const zone = el('div', { class: 'dropzone' },
    icon('file-text', { size: 26 }), fileLabel, fileSub,
    el('button', { type: 'button', class: 'btn', text: 'Choose a file', onclick: () => picker.click() }),
    picker,
  );
  function choose(file) {
    chosen = file;
    extracted = null;
    fileLabel.textContent = file.name;
    fileSub.textContent = file.size > 1_048_576 ? `${(file.size / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(file.size / 1024))} KB`;
  }
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    const file = e.dataTransfer?.files?.[0];
    if (file) choose(file);
  });

  const subject = dropdown({ class: 'input' },
    el('option', { value: '', text: 'No subject', selected: !subjectId }),
    state.subjects.map((s) => el('option', { value: s.id, text: s.name, selected: subjectId === s.id })),
  );
  const note = el('div');
  const weight = status.weights?.spec_import ?? 5;

  const asked = await dialog({
    title: 'Import a specification',
    confirmLabel: 'Read it',
    wide: true,
    body: el('div', { class: 'ai-form' },
      zone,
      el('div', { class: 'field' }, el('label', { text: 'Subject' }), subject),
      el('div', { class: 'muted' }, `The file’s text is read by a model and split into units and topics. You see the list before anything is added. Uses ${plural(weight, 'AI request')}.`),
      note,
      allowanceLine(status.usage),
    ),
    onConfirm: async () => {
      if (!chosen) { toast('Choose a file first.'); return false; }
      const thinking = (text) => mount(note, el('div', { class: 'ai-thinking' }, icon('sparkle', { size: 13 }), text));
      try {
        if (!extracted) {
          thinking('Taking the text out of the file…');
          extracted = await extractSpec(chosen, { onProgress: (n, total) => thinking(`Taking the text out of page ${n} of ${total}…`) });
        }
        thinking(`Reading ${plural(extracted.pages.length, extracted.realPages ? 'page' : 'section')}. A long specification takes a few minutes.`);
        result = await api.aiSpecUnpack({
          subjectId: subject.value || null,
          fileName: chosen.name.slice(0, 200),
          pages: extracted.pages,
        });
        spent();
        return true;
      } catch (err) {
        if (err instanceof ExtractError) extracted = null;
        mount(note, failure(err));
        return false;
      }
    },
  });
  if (!asked || !result) return;

  const realPages = extracted.realPages;
  const units = result.units.map((u) => ({
    name: el('input', { class: 'input unit-name', value: u.unit, maxlength: 80, 'aria-label': 'Unit name' }),
    topics: u.topics.map((t) => topicModel(t, !t.flags.some((f) => f.issue === 'not_a_topic' || f.issue === 'duplicate'))),
  }));
  const extras = result.missing.filter((m) => m.name?.trim());
  if (extras.length) {
    units.push({
      name: el('input', { class: 'input unit-name', value: 'Not picked up by the reader', maxlength: 80, 'aria-label': 'Unit name' }),
      missed: true,
      topics: extras.map((m) => topicModel({ ref: m.ref, name: m.name, page: m.page, flags: [] }, false)),
    });
  }

  function topicModel(t, keep) {
    return {
      ref: t.ref, page: t.page, flags: t.flags,
      tick: el('input', { type: 'checkbox', checked: keep, 'aria-label': `Add ${t.name}`, onchange: tally }),
      name: el('input', { class: 'input', value: t.name, maxlength: 160, 'aria-label': 'Topic name' }),
    };
  }

  const counter = el('div', { class: 'ai-spec-count' });
  function tally() {
    const n = units.reduce((sum, u) => sum + u.topics.filter((t) => t.tick.checked).length, 0);
    counter.textContent = `${plural(n, 'topic')} ticked to add`;
  }
  tally();

  const unitBlock = (u) => {
    const all = el('input', {
      type: 'checkbox', 'aria-label': 'Tick every topic in this unit',
      checked: u.topics.every((t) => t.tick.checked),
      onchange: () => { u.topics.forEach((t) => { t.tick.checked = all.checked; }); tally(); },
    });
    return el('div', { class: 'ai-spec-unit' + (u.missed ? ' missed' : '') },
      el('div', { class: 'head' }, all, u.name, el('span', { class: 'count', text: String(u.topics.length) })),
      u.missed ? el('div', { class: 'muted small', text: 'These references appear in the document but were not in the reader’s list. Tick any that belong.' }) : null,
      u.topics.map((t) => el('div', { class: 'ai-spec-topic' },
        t.tick,
        el('span', { class: 'ref', text: t.ref ?? '' }),
        t.name,
        el('span', { class: 'page', text: realPages && t.page ? `p. ${t.page}` : '' }),
        t.flags.length
          ? el('span', { class: 'flags' }, t.flags.map((f) => el('span', { class: `ai-flag ${f.issue}`, title: f.note || '', text: FLAG_LABEL[f.issue] ?? f.issue })))
          : null,
      )),
    );
  };

  await dialog({
    title: `${plural(result.topicCount, 'topic')} from ${result.fileName}`,
    wide: true,
    confirmLabel: 'Add ticked topics',
    cancelLabel: 'Discard',
    body: el('div', { class: 'ai-answer ai-spec' },
      el('div', { class: 'muted' }, result.checked
        ? 'A second model checked the list. Rows it doubts start unticked; hover a flag for why.'
        : 'The second check did not run, so nothing is flagged. Read the list over before adding it.'),
      result.unread.map((r) => el('div', { class: 'ai-failed' }, icon('warning-circle', { size: 13 }),
        `${realPages ? `Pages ${r.fromPage}–${r.toPage}` : 'Part of the file'} could not be read${r.reason ? `: ${r.reason}` : '.'}`)),
      counter,
      units.map(unitBlock),
      caveat('Read out of the document by a model. Names can be edited here; ratings start empty.'),
    ),
    onConfirm: async () => {
      let created = 0;
      let skipped = 0;
      try {
        for (const u of units) {
          const names = u.topics
            .filter((t) => t.tick.checked && t.name.value.trim())
            .map((t) => ({ name: t.name.value.trim().slice(0, 160), ref: t.ref ?? null, page: realPages ? t.page ?? null : null }));
          for (let i = 0; i < names.length; i += 500) {
            const res = await api.importTopics({
              subjectId: subject.value || null,
              unit: u.name.value.trim().slice(0, 80) || null,
              names: names.slice(i, i + 500),
            });
            created += res.created.length;
            skipped += res.skipped;
          }
        }
      } catch (err) {
        toast(err?.message || 'Some topics could not be added.', 'error');
        if (!created) return false;
      }
      if (!created && !skipped) { toast('Tick at least one topic.'); return false; }
      toast(skipped ? `Added ${plural(created, 'topic')}, skipped ${skipped} already there.` : `Added ${plural(created, 'topic')}.`);
      await refresh?.();
      return true;
    },
  });
}
