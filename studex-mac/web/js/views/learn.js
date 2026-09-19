/**
 * Learn mode — the first pass through cards nobody has studied yet.
 *
 * The scheduler is built to keep what a student already knows; it is a poor
 * teacher of something seen for the first time, because its first question is
 * "how well did you recall this?" and the honest answer is "not at all". Learn
 * mode sits in front of it. Each new card climbs three rungs:
 *
 *   1. recognise — pick the answer out of four
 *   2. recall    — bring it to mind, reveal, and say whether you had it
 *   3. type      — write it out, and do so correctly twice
 *
 * A wrong answer drops the card a rung. A card that clears the top rung is
 * graduated with a real "Good" review, so it enters the spaced queue with a
 * first interval that reflects having been learned, and never before.
 *
 * Progress through a deck is kept on this device, so closing the window part
 * way through resumes where it stopped rather than starting the climb again.
 */
import { el, icon, mount } from '../dom.js';
import { api } from '../api.js';
import { fileById, loadLibrary, reportError } from '../store.js';
import { navigate, paneIsActive } from '../router.js';
import { topbar, fileCrumbs } from '../shell.js';
import { plural } from '../format.js';
import { studyPrefs, shuffled } from '../studyprefs.js';
import { submitReview } from '../review-queue.js';
import { refreshDue } from '../badge.js';
import { cardFaces } from '../cards-inline.js';
import { renderMathText, mathLineToText } from '../math.js';
import { matches, normalise } from '../answer-match.js';
import { templateFor, surfaceClasses, showBackFirst } from '../deck-template.js';
import { aiAvailable, explainCard } from '../ai.js';
import { confetti, celebrateIfStreakGrew, studyDay } from '../celebrate.js';
import { sfx } from '../sfx.js';

const STAGES = ['recognise', 'recall', 'type'];
/** Correct answers needed at each rung before the card moves up. */
const NEEDED = [1, 1, 2];
/** How many cards are in play at once — enough to interleave, few enough to hold. */
const WINDOW = 5;
const BATCH = 20;
const STORE = 'studex.learn';

function loadProgress(deckId) {
  try {
    const all = JSON.parse(localStorage.getItem(STORE) ?? '{}');
    return all?.[deckId] && typeof all[deckId] === 'object' ? all[deckId] : {};
  } catch { return {}; }
}

function saveProgress(deckId, progress) {
  try {
    const all = JSON.parse(localStorage.getItem(STORE) ?? '{}') ?? {};
    if (Object.keys(progress).length) all[deckId] = progress;
    else delete all[deckId];
    localStorage.setItem(STORE, JSON.stringify(all));
  } catch { /* progress is a convenience; the review itself is what counts */ }
}

function face(cls, text) {
  const node = el('div', { class: cls });
  renderMathText(node, text);
  return node;
}

export async function learnSession(host, deckId) {
  const deck = fileById(deckId) ?? (await api.file(deckId)).file;
  const [{ cards }, template] = await Promise.all([api.deckCards(deckId, { limit: 500 }), templateFor(deckId)]);
  const fresh = cards.filter((c) => c.state === 'new' && !c.suspended);
  const exit = () => navigate(`deck/${deckId}`);
  const crumbs = [...fileCrumbs(deck).slice(0, -1), { label: deck.title, to: `deck/${deckId}` }, { label: 'Learn' }];

  if (!fresh.length) {
    mount(host,
      topbar(crumbs),
      el('div', { class: 'empty-state', style: { flex: '1' } },
        icon('graduation-cap'), 'Every card in this deck has been learned. The scheduler has them now.',
        el('button', { class: 'btn', text: 'Back to the deck', onclick: exit }),
      ),
    );
    return;
  }

  // The day's figures before a single card is graded: a lesson is study, and
  // for a student starting a new deck it is often the day's first.
  const dayBefore = await studyDay();

  // Stored progress for cards that are still new; anything since reviewed,
  // deleted or suspended is dropped rather than resurrected.
  const saved = loadProgress(deckId);
  const progress = {};
  for (const card of fresh) {
    const p = saved[card.id];
    if (p && Number.isInteger(p.stage) && p.stage >= 0 && p.stage < STAGES.length) {
      progress[card.id] = { stage: p.stage, right: Math.max(0, Number(p.right) || 0) };
    }
  }
  // Cards already under way come first, so a resumed sitting finishes them.
  const pool = [
    ...fresh.filter((c) => progress[c.id]),
    ...fresh.filter((c) => !progress[c.id]),
  ].slice(0, BATCH);
  for (const card of pool) progress[card.id] ??= { stage: 0, right: 0 };

  const prefs = studyPrefs();
  // Learning follows the deck's own direction; the review-only reverse setting
  // is left to review.
  const facesOf = (card) => cardFaces(card, showBackFirst(template, false));
  // Recognition needs wrong answers to choose between; a deck of one card, or
  // one where every answer is the same, starts at recall instead.
  const distinctBacks = new Set(fresh.map((c) => normalise(facesOf(c).back))).size;
  const floor = distinctBacks >= 2 ? 0 : 1;
  for (const card of pool) progress[card.id].stage = Math.max(floor, progress[card.id].stage);

  let active = [];
  let waiting = pool.slice();
  let graduated = 0;
  let current = null;
  let phase = 'ask'; // ask → answered
  let result = null; // { correct, given }
  let options = null;
  let lastId = null;
  let shownAt = Date.now();

  const body = el('div', { class: 'study' });
  mount(host, topbar(crumbs), body);
  const ai = await aiAvailable().catch(() => false);
  // The explanation of the card on screen, once asked for; cleared with the card.
  let explainer = null;

  const persist = () => {
    const keep = {};
    for (const card of [...active, ...waiting]) keep[card.id] = progress[card.id];
    saveProgress(deckId, keep);
  };

  function refill() {
    while (active.length < WINDOW && waiting.length) active.push(waiting.shift());
  }

  function pickNext() {
    refill();
    if (!active.length) return null;
    // Not the same card twice running when there is any other choice.
    const choices = active.length > 1 ? active.filter((c) => c.id !== lastId) : active;
    // Lowest rung first: the least-known card is the one that needs the turn.
    const lowest = Math.min(...choices.map((c) => progress[c.id].stage));
    const candidates = choices.filter((c) => progress[c.id].stage === lowest);
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  function optionsFor(card) {
    const answer = facesOf(card).back;
    const others = shuffled(fresh.filter((c) => c.id !== card.id).map((c) => facesOf(c).back))
      .filter((b) => normalise(b) !== normalise(answer));
    const unique = [];
    for (const b of others) {
      if (!unique.some((u) => normalise(u) === normalise(b))) unique.push(b);
      if (unique.length === 3) break;
    }
    return shuffled([answer, ...unique]);
  }

  function next() {
    current = pickNext();
    if (!current) { void finish(); return; }
    lastId = current.id;
    delete body.dataset.revealed;
    phase = 'ask';
    result = null;
    explainer = null;
    options = STAGES[progress[current.id].stage] === 'recognise' ? optionsFor(current) : null;
    shownAt = Date.now();
    draw();
  }

  async function answer(correct, given = null) {
    if (phase !== 'ask') return;
    phase = 'saving';
    const card = current;
    const p = progress[card.id];
    result = { correct, given };
    phase = 'answered';
    sfx(correct ? 'right' : 'wrong');
    if (correct) {
      p.right += 1;
      if (p.right >= NEEDED[p.stage]) {
        if (p.stage === STAGES.length - 1) {
          // Top rung cleared: the card has been learned, so the scheduler
          // takes it from here with an honest first grade.
          try {
            await submitReview(card.id, { rating: 3, durationMs: Math.min(3_600_000, Date.now() - shownAt), mode: 'review' });
          } catch (err) { phase = 'ask'; result = null; p.right -= 1; reportError(err); return; }
          active = active.filter((c) => c.id !== card.id);
          delete progress[card.id];
          graduated += 1;
          result.graduated = true;
        } else {
          p.stage += 1;
          p.right = 0;
          result.promoted = STAGES[p.stage];
        }
      }
    } else {
      p.stage = Math.max(floor, p.stage - 1);
      p.right = 0;
    }
    persist();
    draw();
  }

  const onKey = (event) => {
    if (!paneIsActive(host) || !current) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'Escape') { exit(); return; }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName);
    if (phase === 'answered' && !typing && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); next(); return; }
    if (typing) return;
    const stage = STAGES[progress[current.id]?.stage];
    if (phase === 'ask' && stage === 'recognise' && /^[1-4]$/.test(event.key)) {
      body.querySelectorAll('.learn-option')[Number(event.key) - 1]?.click();
    }
    if (phase === 'ask' && stage === 'recall') {
      if (!result && (event.key === ' ' || event.key === 'Enter')) { event.preventDefault(); body.querySelector('.learn-reveal')?.click(); }
      if (event.key === '1') body.querySelector('.learn-miss')?.click();
      if (event.key === '2') body.querySelector('.learn-hit')?.click();
    }
  };
  document.addEventListener('keydown', onKey);

  async function finish() {
    document.removeEventListener('keydown', onKey);
    persist();
    await loadLibrary();
    refreshDue().catch(() => { /* a stale badge is not worth an error */ });
    const remaining = fresh.length - graduated;
    if (graduated) { confetti(); sfx('finish'); }
    mount(body,
      el('div', { class: 'empty-state session-done', style: { flex: '1' } },
        icon('graduation-cap', { size: 34 }),
        el('div', { style: { fontSize: '15px', color: 'var(--color-text)' }, text: `${plural(graduated, 'card')} learned.` }),
        el('div', { class: 'dim', text: remaining > 0
          ? `They are in the spaced queue now. ${plural(remaining, 'new card')} still to learn in this deck.`
          : 'They are in the spaced queue now, and the scheduler will bring each back when it is due.' }),
        el('div', { style: { display: 'flex', gap: '8px' } },
          remaining > 0 ? el('button', { class: 'btn lg', text: 'Learn more', onclick: () => void learnSession(host, deckId) }) : null,
          el('button', { class: 'btn primary lg', text: 'Done', onclick: exit }),
        ),
      ),
    );
    if (graduated) await celebrateIfStreakGrew(dayBefore);
  }

  function ladder(card) {
    const at = progress[card.id]?.stage ?? STAGES.length;
    return el('ol', { class: 'learn-ladder', 'aria-label': `Step ${Math.min(at + 1, 3)} of 3` },
      STAGES.map((name, i) => el('li', {
        class: i < at ? 'done' : i === at ? 'on' : '',
        text: { recognise: 'Recognise', recall: 'Recall', type: 'Type' }[name],
      })));
  }

  function feedback(faces) {
    if (!result) return null;
    const note = result.graduated
      ? 'Learned — it joins the spaced queue.'
      : result.promoted
        ? `Up a step: ${{ recall: 'now recall it', type: 'now type it' }[result.promoted]}.`
        : result.correct
          ? 'Right — once more to move up.'
          : 'Not yet — it will come round again.';
    return el('div', { class: 'a', role: 'status' },
      el('div', { class: 'learn-verdict' + (result.correct ? ' right' : ' wrong'), text: result.correct ? 'Correct' : 'Not quite' }),
      face('', faces.back),
      !result.correct && result.given ? el('div', { class: 'dim', style: { marginTop: '8px', fontSize: '13px' }, text: `You answered: ${result.given}` }) : null,
      el('div', { class: 'dim', style: { marginTop: '8px', fontSize: '12.5px' }, text: note }),
      ai ? explainRow(faces) : null,
    );
  }

  /**
   * "Explain" under a marked card. The answer is held on `explainer` rather
   * than re-requested: draw() runs again on every keystroke, and each
   * explanation is a paid request.
   */
  function explainRow(faces) {
    if (explainer) return explainer;
    return el('button', {
      type: 'button', class: 'chip ai', title: 'Ask AI to explain this card',
      onclick: () => {
        explainer = explainCard({
          front: faces.front,
          back: faces.back,
          given: result?.correct ? '' : (result?.given ?? ''),
        });
        draw();
      },
    }, icon('sparkle', { size: 13 }), 'Explain this');
  }

  function askArea(card, faces, stage) {
    if (phase === 'answered') {
      return el('button', { class: 'btn primary lg', autofocus: true, onclick: next }, 'Next ', el('span', { class: 'key', text: 'Enter' }));
    }
    if (stage === 'recognise') {
      return el('div', { class: 'ai-options', role: 'group', 'aria-label': 'Choose the answer' },
        options.map((option, i) => {
          const button = el('button', {
            type: 'button', class: 'ai-option learn-option',
            onclick: () => void answer(normalise(option) === normalise(faces.back), option),
          }, el('span', { class: 'letter', text: String(i + 1), 'aria-hidden': 'true' }));
          const text = el('span');
          renderMathText(text, option);
          button.append(text);
          button.setAttribute('aria-label', `${i + 1}. ${mathLineToText(option)}`);
          return button;
        }));
    }
    if (stage === 'recall') {
      return el('div', { class: 'learn-recall' },
        el('button', {
          type: 'button', class: 'btn learn-miss',
          onclick: () => void answer(false),
        }, 'Didn’t have it ', el('span', { class: 'key', text: '1' })),
        el('button', {
          type: 'button', class: 'btn primary learn-hit',
          onclick: () => void answer(true),
        }, 'Had it ', el('span', { class: 'key', text: '2' })),
      );
    }
    const expected = faces.cloze && faces.tested ? faces.tested : faces.back;
    const input = el('input', { placeholder: 'Type the answer', spellcheck: 'false', 'aria-label': 'Your answer' });
    queueMicrotask(() => input.focus());
    return el('form', {
      onsubmit: (event) => {
        event.preventDefault();
        if (!input.value.trim()) return;
        void answer(matches(input.value, expected, prefs.strictness), input.value);
      },
    }, el('div', { class: 'answer-input' }, input, el('span', { class: 'hint', text: '↵ to check' })));
  }

  function draw() {
    if (!body.isConnected || !current) return;
    const card = current;
    const faces = facesOf(card);
    const stage = STAGES[progress[card.id]?.stage ?? STAGES.length - 1];
    const total = pool.length;
    // Progress counts rungs climbed, so it moves on every right answer, not
    // only at the rare moment a card graduates.
    const climbed = graduated * (STAGES.length - floor)
      + [...active, ...waiting].reduce((sum, c) => sum + ((progress[c.id]?.stage ?? floor) - floor), 0);
    const pct = Math.round((climbed / Math.max(1, total * (STAGES.length - floor))) * 100);
    const label = { recognise: 'LEARN — PICK THE ANSWER', recall: 'LEARN — RECALL IT', type: 'LEARN — TYPE IT' }[stage];
    // Recall shows the answer only once asked; recognise and type show it once
    // answered.
    const showBack = phase === 'answered';

    mount(body,
      el('div', { class: 'study-head' },
        el('button', { title: 'End — progress is kept', onclick: exit }, icon('x', { size: 17, class: 'muted' })),
        el('span', { class: 'name', text: deck.title }),
        el('span', { class: 'pos', text: `${graduated} / ${total} learned` }),
        el('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) },
          el('div', { style: { width: `${Math.max(0, Math.min(100, pct))}%` } })),
        ladder(card),
      ),
      el('div', { class: 'study-body' },
        el('div', { class: 'card-face' },
          el('span', { class: 'section-label plain', text: label }),
          el('div', {
            class: 'card-surface' + surfaceClasses(template)
              + (showBack ? (result?.correct ? ' right' : ' wrong') : ' hidden-answer'),
            role: 'group', 'aria-live': 'polite',
            'aria-label': `${card.topic ? card.topic + '. ' : ''}Question. ${mathLineToText(faces.front)}.`,
          },
            card.topic ? el('div', { class: 'topic', text: card.topic }) : null,
            face('q', faces.front),
            stage === 'recall' && phase === 'ask' && result === null && body.dataset.revealed === card.id
              ? face('a', faces.back)
              : null,
            feedback(faces),
          ),
          stage === 'recall' && phase === 'ask' && body.dataset.revealed !== card.id
            ? el('button', {
                class: 'reveal-hint learn-reveal',
                onclick: () => { body.dataset.revealed = card.id; draw(); },
              }, 'Recall it, then press ', el('span', { class: 'key', text: 'Space' }), ' to check')
            : askArea(card, faces, stage),
        ),
      ),
    );
  }

  next();
  return () => { persist(); document.removeEventListener('keydown', onKey); };
}
