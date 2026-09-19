/** Screen 09 — Mock exams: a whole-subject paper, self-marked, feeding the topic matrix. */
import { el, icon, mount } from '../dom.js';
import { api } from '../api.js';
import { state, subjectById, loadLibrary, toast, reportError } from '../store.js';
import { navigate, paneIsActive } from '../router.js';
import { topbar } from '../shell.js';
import { plural } from '../format.js';
import { studyPrefs, saveStudyPrefs } from '../studyprefs.js';
import { confetti, rollNumber } from '../celebrate.js';
import { sfx } from '../sfx.js';

/**
 * A mock is deliberately unlike test mode: it spans a subject rather than a
 * deck, mixes its topics the way a real paper does, and its per-topic marking
 * feeds back into the topic matrix — so the score is not the point, the map of
 * what to revise next is.
 */
export async function mockView(route, host) {
  // Routes: mock (set one up) · mock/<id> (sit or review a paper)
  const examId = route.path[1] ?? null;
  if (examId) return sitting(examId, host);
  return setup(host);
}

/* ── setting a paper up ───────────────────────────────────────────────── */

async function setup(host) {
  const body = el('div', { class: 'study' });
  mount(host, body);

  const subjects = state.subjects ?? [];
  const back = () => navigate('flashcards');

  if (!subjects.length) {
    mount(body, topbar(['Mock exam']), el('div', { class: 'empty-state', style: { flex: '1' } },
      icon('exam'), 'Add a subject with some cards before sitting a mock.',
      el('button', { class: 'btn', text: 'Back', onclick: back })));
    return;
  }

  const prefs = studyPrefs();
  let subjectId = subjects[0].id;

  const pick = (key, value, options) => el('div', { class: 'seg' }, options.map(([v, t]) => el('button', {
    class: String(value) === String(v) ? 'on' : '',
    text: t,
    onclick: () => { saveStudyPrefs({ [key]: v }); draw(); },
  })));

  let recent = [];
  api.mocks().then((r) => { recent = r.mocks ?? []; draw(); }).catch(() => {});

  function draw() {
    const p = studyPrefs();
    mount(body,
      el('div', { class: 'study-head' },
        el('button', { title: 'Back', onclick: back }, icon('x', { size: 17, class: 'muted' })),
        el('span', { class: 'name', text: 'Mock exam' }),
        el('span', { class: 'pos', text: plural(subjects.length, 'subject') }),
      ),
      el('div', { class: 'study-body' },
        el('div', { class: 'card-face test-setup' },
          el('span', { class: 'section-label plain', text: 'SIT A MOCK PAPER' }),
          el('div', { class: 'quiz-modes' }, subjects.map((s) => el('button', {
            type: 'button', class: 'quiz-mode' + (subjectId === s.id ? ' on' : ''),
            onclick: () => { subjectId = s.id; draw(); },
          }, icon('folder', { size: 18 }), el('b', { text: s.name }),
             el('span', { text: 'Every live card in this subject, mixed.' })))),
          el('div', { class: 'test-options' },
            el('div', { class: 'setting-row' }, el('span', { class: 'label', text: 'Questions' }),
              pick('mockCount', p.mockCount, [[10, '10'], [20, '20'], [40, '40'], [60, '60']])),
            el('div', { class: 'setting-row' }, el('span', { class: 'label', text: 'Time limit' }),
              pick('mockTimer', p.mockTimer, [[0, 'None'], [30, '30m'], [60, '60m'], [90, '90m']])),
          ),
          el('button', { class: 'btn primary lg', text: 'Start mock', onclick: () => start(subjectId) }),
          recent.length
            ? el('div', { class: 'mock-recent' },
                el('span', { class: 'section-label plain', text: 'RECENT PAPERS' }),
                el('div', { class: 'rows' }, recent.slice(0, 5).map((m) => el('button', {
                  class: 'row', onclick: () => navigate('mock/' + m.id),
                }, el('span', { class: 'grow', text: m.title }),
                   el('span', { class: 'dim', text: m.score_pct === null ? 'unfinished' : `${Math.round(m.score_pct)}%` })))))
            : null,
        ),
      ),
    );
  }
  draw();

  async function start(id) {
    const p = studyPrefs();
    try {
      const { mock } = await api.startMock({ subjectId: id, count: p.mockCount, durationMin: p.mockTimer });
      navigate('mock/' + mock.id);
    } catch (err) { reportError(err); }
  }
}

/* ── sitting a paper ──────────────────────────────────────────────────── */

async function sitting(examId, host) {
  const body = el('div', { class: 'study' });
  mount(host, body);
  const back = () => navigate('mock');

  let exam;
  try { ({ mock: exam } = await api.mock(examId)); } catch (err) { reportError(err); back(); return; }

  // Already sat: straight to the marked paper.
  if (exam.ended_at !== null) { results({ justMarked: false }); return; }

  const subject = exam.subject_id ? subjectById(exam.subject_id) : null;
  const questions = exam.questions;
  // Resume where the paper was left: first still-unanswered question.
  let index = Math.max(0, questions.findIndex((q) => q.correct === null));
  if (index < 0) index = 0;
  let revealed = false;
  let finished = false;
  let timerId = null;
  let alive = true;
  const clock = el('span', { class: 'quiz-clock' });
  const endsAt = exam.duration_min > 0 ? exam.started_at + exam.duration_min * 60_000 : 0;

  const onKey = (event) => {
    if (!paneIsActive(host) || finished) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target?.tagName === 'INPUT' || event.target?.tagName === 'TEXTAREA') return;
    if (!revealed && event.key === ' ') { event.preventDefault(); revealed = true; draw(); return; }
    if (revealed) {
      if (event.key === 'j' || event.key === '1') mark(true);
      if (event.key === 'f' || event.key === '2') mark(false);
    }
  };
  document.addEventListener('keydown', onKey);

  if (endsAt) {
    const tick = () => {
      if (!body.isConnected || !alive) { clearInterval(timerId); return; }
      const left = Math.max(0, endsAt - Date.now());
      clock.textContent = `${Math.floor(left / 60_000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}`;
      clock.classList.toggle('low', left < 60_000);
      if (left <= 0 && !finished) { toast('Time is up.'); void finish(); }
    };
    tick();
    timerId = setInterval(tick, 500);
  }

  async function mark(correct) {
    if (finished) return;
    const q = questions[index];
    if (q.correct !== null) { advance(); return; }
    try {
      const { mock } = await api.answerMock(examId, { questionId: q.id, correct });
      // Keep the local list in step so the scoreboard and resume point stay right.
      const updated = mock.questions.find((x) => x.id === q.id);
      if (updated) questions[index] = updated;
    } catch (err) { reportError(err); return; }
    advance();
  }

  function advance() {
    revealed = false;
    if (index + 1 >= questions.length) { void finish(); return; }
    index += 1;
    draw();
  }

  async function finish() {
    if (finished) return;
    finished = true;
    clearInterval(timerId);
    document.removeEventListener('keydown', onKey);
    try {
      const { mock } = await api.finishMock(examId);
      exam = mock;
    } catch (err) { reportError(err); }
    await loadLibrary();
    if (!body.isConnected) return;
    results({ justMarked: true });
  }

  function draw() {
    if (!body.isConnected) return;
    const q = questions[index];
    const answered = questions.filter((x) => x.correct !== null).length;
    const correct = questions.filter((x) => x.correct === 1).length;

    mount(body,
      el('div', { class: 'study-head' },
        el('button', { title: 'End mock', onclick: () => finish() }, icon('x', { size: 17, class: 'muted' })),
        el('span', { class: 'name', text: subject?.name ?? exam.title }),
        el('span', { class: 'pos', text: `${index + 1} / ${questions.length}` }),
        el('div', { class: 'progress' }, el('div', { style: { width: `${Math.round((index / questions.length) * 100)}%` } })),
        endsAt ? clock : null,
      ),
      el('div', { class: 'study-body' },
        el('div', { class: 'card-face' },
          el('span', { class: 'section-label plain', text: 'MOCK EXAM' }),
          el('div', { class: 'card-surface' + (revealed ? '' : ' hidden-answer') },
            q.topic ? el('div', { class: 'topic', text: q.topic }) : null,
            el('div', { class: 'q', text: q.prompt }),
            revealed
              ? el('div', { class: 'a' }, el('div', { class: 'dim', style: { marginBottom: '8px' }, text: 'Mark scheme' }), el('div', { text: q.answer }))
              : null,
            el('div', { class: 'foot' },
              el('span', { style: { marginLeft: 'auto' }, text: revealed ? 'Did you get it right?' : 'Answer in your head, then reveal' }),
            ),
          ),
          revealed
            ? el('div', { class: 'ai-options', style: { flexDirection: 'row' } },
                el('button', { type: 'button', class: 'ai-option', onclick: () => mark(false) },
                  el('span', { class: 'letter', text: '✗' }), 'Got it wrong'),
                el('button', { type: 'button', class: 'ai-option', onclick: () => mark(true) },
                  el('span', { class: 'letter', text: '✓' }), 'Got it right'),
              )
            : el('button', { class: 'btn primary lg', text: 'Reveal answer', onclick: () => { revealed = true; draw(); } }),
          el('div', { class: 'scoreboard' },
            el('div', null, el('div', { class: 'k', text: 'CORRECT' }), el('div', { class: 'v lead', text: String(correct) })),
            el('div', null, el('div', { class: 'k', text: 'MISSED' }), el('div', { class: 'v', text: String(answered - correct) })),
            el('div', null, el('div', { class: 'k', text: 'ANSWERED' }), el('div', { class: 'v', text: `${answered}/${questions.length}` })),
            el('button', { class: 'btn primary', style: { marginLeft: 'auto' }, text: 'Finish & mark', onclick: () => finish() }),
          ),
        ),
      ),
    );
  }

  /* ---- the marked paper ---- */
  /**
   * The marked paper. `justMarked` separates finishing one from reopening one:
   * a paper sat a week ago should not throw paper about when it is looked at
   * again, and its score should already be on the page rather than counting up.
   */
  function results({ justMarked = false } = {}) {
    alive = false;
    clearInterval(timerId);
    document.removeEventListener('keydown', onKey);
    const subj = exam.subject_id ? subjectById(exam.subject_id) : null;
    const total = exam.questions.length;
    const right = exam.questions.filter((q) => q.correct === 1).length;
    const score = Math.round(exam.score_pct ?? 0);
    // The figure and its sign are separate nodes so the figure can count up
    // without the per-cent sign counting with it.
    const scoreNode = el('span', { text: String(score) });
    const pct = el('div', { class: 'mock-score-pct' }, scoreNode, el('span', { class: 'sign', text: '%' }));

    mount(body,
      el('div', { class: 'study-head' },
        el('button', { title: 'Back', onclick: back }, icon('x', { size: 17, class: 'muted' })),
        el('span', { class: 'name', text: subj?.name ?? exam.title }),
        el('span', { class: 'pos', text: 'Marked' }),
      ),
      el('div', { class: 'study-body' },
        el('div', { class: 'card-face' },
          el('div', { class: 'mock-score' },
            pct,
            el('div', { class: 'dim', text: `${right} of ${total} correct` }),
          ),
          el('span', { class: 'section-label plain', text: 'BY TOPIC — RE-RATED IN YOUR TOPIC MATRIX' }),
          el('div', { class: 'mock-breakdown' }, (exam.breakdown ?? []).map((line) => el('div', { class: 'mock-topic-row' },
            el('span', { class: 'grow', text: line.topic }),
            el('span', { class: 'dim', text: `${line.correct}/${line.total}` }),
            el('div', { class: 'mock-bar' }, el('div', {
              class: 'mock-bar-fill' + (line.pct >= 70 ? ' good' : line.pct >= 40 ? ' mid' : ' low'),
              style: { width: `${line.pct}%` },
            })),
            el('span', { class: 'mock-pct', text: `${line.pct}%` }),
            line.confidence !== null
              ? el('span', { class: 'mock-conf', title: 'New confidence', text: '●'.repeat(line.confidence) + '○'.repeat(5 - line.confidence) })
              : el('span', { class: 'mock-conf dim', title: 'No matching topic in your matrix', text: '—' }),
          ))),
          el('div', { style: { display: 'flex', gap: '8px', marginTop: '4px' } },
            el('button', { class: 'btn lg', text: 'New mock', onclick: () => navigate('mock') }),
            el('button', { class: 'btn lg', text: 'Topic matrix', onclick: () => navigate('topics') }),
            el('button', { class: 'btn primary lg', text: 'Done', onclick: back }),
          ),
        ),
      ),
    );
    if (justMarked) {
      // Paper for having sat the thing, not for the mark: a mock is worth
      // finishing at forty per cent, and that is the one most in need of it.
      confetti();
      sfx('finish');
      rollNumber(scoreNode, 0, score, 900);
    }
  }
}
