/** Screen 08 — Flashcards: spaced-repetition review and test mode. */
import { el, icon, mount, applyColor, colorValue } from '../dom.js';
import { dropdown } from '../select.js';
import { api } from '../api.js';
import { state, fileById, loadLibrary, toast, reportError, subjectOfFile, subjectById, folderPath } from '../store.js';
import { navigate, paneIsActive } from '../router.js';
import { topbar, subnav, fileCrumbs } from '../shell.js';
import { dialog, promptText, confirmDelete } from '../dialog.js';
import { openMenu } from '../menu.js';
import { relative, plural, FILE_ICON } from '../format.js';
import { onPrint } from '../print.js';
import { reportDue, refreshDue } from '../badge.js';
import { celebrateStreak, rollNumber } from '../celebrate.js';
import { aiAvailable, quizDialog, QUIZ_MODES } from '../ai.js';
import { studyPrefs, saveStudyPrefs, shuffled } from '../studyprefs.js';
import { submitReview } from '../review-queue.js';
import { speak, cancelSpeech, speechAvailable } from '../speak.js';
import { askAbout } from '../chat.js';
import { carriesBlock, readBlock } from '../dnd.js';
import { cardFaces, isCloze, clozePlain } from '../cards-inline.js';
import { readOcclusion, occlusionFigure, openOcclusionEditor } from '../occlusion.js';
import { renderMathText, mathLineToText, hasMath } from '../math.js';
import { pickDeckFile, readDeckFile, readPackFile, isPack, importCards, DeckImportError } from '../deck-import.js';
import { matches, normalise } from '../answer-match.js';
import { learnSession } from './learn.js';
import { templateFor, templatesFor, editTemplate, surfaceClasses, showBackFirst, extraFields, extraText, DEFAULT_TEMPLATE } from '../deck-template.js';

const RATINGS = [
  { value: 1, face: '😵', label: 'Again' },
  { value: 2, face: '😖', label: 'Hard' },
  { value: 3, face: '🙂', label: 'Good', primary: true },
  { value: 4, face: '😎', label: 'Easy' },
];

/**
 * A card face, with any `$…$` LaTeX in it typeset rather than shown as source.
 * Plain cards — the overwhelming majority — pay nothing: renderMathText sets
 * textContent and returns when the line holds no maths.
 */
function faceEl(cls, str) {
  const node = el('div', { class: cls });
  renderMathText(node, str);
  return node;
}

/* ── deck list ────────────────────────────────────────────────────────── */

/**
 * Decks, filed under the subject they belong to.
 *
 * A deck's subject comes from the folder it is in, and from that folder's
 * parents — so it is the library's own hierarchy doing the filing rather than
 * a second one kept in step by hand. Decks in no subject are not hidden: they
 * go last, under a heading that says so, because a deck nobody can find is
 * worse than an untidy screen.
 */
function bySubject(decks) {
  const groups = new Map();
  for (const deck of decks) {
    const subject = subjectOfFile(deck);
    const key = subject?.id ?? '';
    if (!groups.has(key)) {
      groups.set(key, { subject, decks: [], due: 0 });
    }
    const group = groups.get(key);
    group.decks.push(deck);
    group.due += (deck.due_count ?? 0);
  }
  return [...groups.values()].sort((a, b) => {
    // Everything filed, in name order, and then the ones that are not.
    if (Boolean(a.subject) !== Boolean(b.subject)) return a.subject ? -1 : 1;
    return (a.subject?.name ?? '').localeCompare(b.subject?.name ?? '');
  });
}

export async function flashcardsView(route, host) {
  const decks = state.files.filter((f) => f.kind === 'deck');
  const [queue, today] = await Promise.all([
    api.studyQueue({ limit: 1 }).catch(() => ({ due_count: 0, new_count: 0 })),
    api.studyToday().catch(() => null),
  ]);
  // Free of charge: the count the Dock wants is the one this screen just
  // fetched to draw its header with.
  if (today) reportDue(today.remaining);
  const groups = bySubject(decks);

  mount(host,
    topbar(['Study', 'Flashcards'],
      el('button', {
        class: 'chip', title: 'Sit a whole-subject mock paper', onclick: () => navigate('mock'),
      }, icon('exam'), 'Mock exam'),
      el('button', {
        class: 'chip', onclick: async () => {
          const title = await promptText({ title: 'New flashcard deck', label: 'Title', fallback: 'Untitled' });
          if (!title) return;
          try {
            const { file } = await api.createFile({ title, kind: 'deck' });
            await loadLibrary();
            navigate(`deck/${file.id}`);
          } catch (err) { reportError(err); }
        },
      }, icon('plus'), 'New deck'),
      el('button', {
        class: 'chip', title: 'Bring in a deck from Anki, Quizlet or a spreadsheet',
        onclick: () => void importDeck(null),
      }, icon('upload-simple'), 'Import deck'),
    ),
    subnav('study', 'flashcards'),
    el('div', { class: 'content' },
      el('div', { class: 'page-head' },
        el('div', { class: 'page-title', text: 'Flashcards' }),
        el('div', { class: 'note', text: `${queue.due_count} due · ${queue.new_count} new` }),
      ),

      queue.due_count + queue.new_count > 0
        ? el('div', null, el('button', { class: 'btn primary lg', onclick: () => navigate('deck/all/study') }, icon('play'), `Study all — ${plural(queue.due_count + queue.new_count, 'card')}`))
        : el('div', { class: 'muted' }, 'Nothing due right now. Nice work.'),

      today ? streakStrip(today) : null,

      decks.length
        ? groups.map((group) => el('div', { class: 'subject-group' },
            el('div', { class: 'subject-head' },
              el('span', {
                class: 'subject-dot',
                style: { background: colorValue(group.subject?.color ?? 'neutral') },
              }),
              el('span', { class: 'section-label plain', style: { padding: '0' }, text: (group.subject?.name ?? 'No subject').toUpperCase() }),
              el('span', { class: 'dim', style: { fontSize: '11.5px' }, text: plural(group.decks.length, 'deck') }),
              group.due
                ? el('span', { class: 'subject-due', text: `${group.due} due` })
                : null,
              // A mixed session across every deck in this subject at once, which
              // is what a student revising "Biology" the night before means —
              // not one deck, but the subject. Only worth offering past a single
              // deck, and only for a real subject (the "No subject" pile is not
              // one thing to revise).
              group.subject && group.due && group.decks.length > 1
                ? el('button', {
                    class: 'chip', style: { marginLeft: 'auto' },
                    title: `Study every ${group.subject.name} deck together`,
                    onclick: () => navigate(`deck/all/study/subject/${group.subject.id}`),
                  }, icon('play', { size: 12 }), 'Study subject')
                : null,
            ),
            el('div', { class: 'file-grid' }, group.decks.map(deckCard)),
          ))
        : el('div', { class: 'empty-state' }, icon('cards'), 'No decks yet. Create one to start.'),
    ),
  );
}

function deckCard(deck) {
  const where = folderPath(deck.folder_id).join(' / ');
  const node = el('button', {
    class: 'file-card', style: { height: '150px', padding: '14px' },
    onclick: () => navigate(`deck/${deck.id}`),
  },
    icon('cards', { size: 19 }),
    el('div', { class: 'name', text: deck.title }),
    el('div', { class: 'meta', text: `${plural(deck.card_count, 'card')}${deck.due_count ? ` · ${deck.due_count} due` : ''}` }),
    where ? el('div', { class: 'meta dim', text: where }) : null,
  );
  return applyColor(node, deck.effective_color);
}

/**
 * The streak, where the reviewing happens.
 *
 * It was on the home screen and on the daily review screen, which are both
 * places you go before you start; here it is beside the decks, which is where
 * you are when you decide whether to do one more. It says plainly whether
 * today is already counted, because "9 days" on a day you have not studied
 * reads as a promise the app has not been asked to keep.
 */
function streakStrip(today) {
  const done = today.reviewed_today > 0;
  return el('div', { class: 'streak-strip' + (done ? ' on' : '') },
    el('span', { class: 'streak-flame-sm' + (done ? ' lit' : '') }, icon('flame', { size: 18, bold: done })),
    el('div', { class: 'grow' },
      el('div', { class: 'streak-count', text: today.streak_days ? plural(today.streak_days, 'day') + ' in a row' : 'No streak yet' }),
      el('div', {
        class: 'dim',
        style: { fontSize: '12px' },
        text: done
          ? `${plural(today.reviewed_today, 'card')} reviewed today — today is counted`
          : 'Review one card today to keep it going',
      }),
    ),
    today.best_streak_days > today.streak_days
      ? el('div', { class: 'streak-best' },
          el('div', { class: 'kicker', text: 'BEST' }),
          el('div', { text: plural(today.best_streak_days, 'day') }),
        )
      : null,
    today.due_count + today.new_count > 0
      ? el('button', { class: 'btn', onclick: () => navigate('deck/all/study') }, icon('play'), 'Review')
      : null,
  );
}

/* ── deck detail ──────────────────────────────────────────────────────── */

export async function deckView(route, host) {
  const deckId = route.path[1];
  if (!deckId) { navigate('flashcards'); return; }

  // "deck/all/study" and "deck/<id>/study" enter the review session directly.
  // A mixed session may carry a scope: "deck/all/study/subject/<id>" (or tag /
  // topic) narrows the interleave to that one axis.
  if (route.path[2] === 'study') {
    const scope = studyScope(route.path[3], route.path[4]);
    return reviewSession(host, deckId === 'all' ? null : deckId, scope);
  }
  // "deck/<id>/learn" is the guided first pass over the cards never studied.
  if (route.path[2] === 'learn') return learnSession(host, deckId);

  const [{ cards }, { stats }, ai, template] = await Promise.all([
    api.deckCards(deckId, { limit: 200 }),
    api.deckStats(deckId),
    aiAvailable().catch(() => false),
    templateFor(deckId),
  ]);
  const deck = fileById(deckId) ?? (await api.file(deckId)).file;
  const refresh = () => deckView(route, host);

  mount(host,
    topbar(fileCrumbs(deck),
      el('button', { class: 'chip', onclick: () => addCard(deckId, template, refresh) }, icon('plus'), 'Add card'),
      el('button', {
        class: 'chip', title: 'Set how this deck’s cards look and which extra fields they carry',
        onclick: async () => { if (await editTemplate(deckId)) { toast('Template saved.'); await refresh(); } },
      }, icon('layout'), 'Template'),
      el('button', {
        class: 'chip', title: 'Add cards from a CSV, Quizlet or Anki text export',
        onclick: () => void importDeck(deckId, refresh),
      }, icon('upload-simple'), 'Import'),
      el('button', {
        class: 'chip', title: 'Cover the labels on a diagram and study each one as a card',
        onclick: async () => {
          const file = await pickImageFile();
          if (!file) return;
          if (await openOcclusionEditor({ blob: file, deckId })) { await loadLibrary(); await refresh(); }
        },
      }, icon('selection-plus'), 'Diagram'),
      cards.length
        ? el('a', {
          class: 'chip', href: `/api/decks/${deckId}/pack`, download: '',
          title: 'Save this deck as a .studexpack file a classmate can import — cards and template, none of your progress',
        }, icon('package'), 'Pack')
        : null,
      el('button', { class: 'chip', onclick: () => navigate(`test/deck/${deckId}`) }, icon('exam'), 'Test'),
      ai && cards.length
        ? el('button', {
            class: 'chip ai-chip', title: 'Ask AI which cards this deck is missing',
            onclick: () => askAbout(`Here are the cards in my deck “${deck.title}”:\n${cards.slice(0, 80).map((c) => `- ${c.front} :: ${c.back}`).join('\n')}\n\nSuggest five more cards that fill gaps, one per line as “term :: meaning”.`, { withPage: false }),
          }, icon('sparkle'), 'Suggest cards')
        : null,
      stats.new > 0
        ? el('button', {
            class: 'chip', title: 'Learn the new cards step by step before they join the spaced queue',
            onclick: () => navigate(`deck/${deckId}/learn`),
          }, icon('graduation-cap'), `Learn ${stats.new}`)
        : null,
      stats.due + stats.new > 0
        ? el('button', { class: 'btn primary', onclick: () => navigate(`deck/${deckId}/study`) }, icon('play'), `Study ${stats.due + stats.new}`)
        : null,
    ),
    dropCards(el('div', { class: 'content' },
      el('div', { class: 'stat-grid' },
        el('div', { class: 'stat lead' }, el('div', { class: 'kicker', text: 'DUE' }), el('div', { class: 'value', text: String(stats.due) }), el('div', { class: 'sub', text: 'ready to review' })),
        el('div', { class: 'stat' }, el('div', { class: 'kicker', text: 'NEW' }), el('div', { class: 'value', text: String(stats.new) }), el('div', { class: 'sub', text: 'never studied' })),
        el('div', { class: 'stat' }, el('div', { class: 'kicker', text: 'KNOWN' }), el('div', { class: 'value', text: String(stats.known) }), el('div', { class: 'sub', text: 'interval over 21 days' })),
        el('div', { class: 'stat' }, el('div', { class: 'kicker', text: 'SHAKY' }), el('div', { class: 'value', text: String(stats.shaky) }), el('div', { class: 'sub', text: 'needs another pass' })),
      ),
      el('span', { class: 'section-label plain', text: plural(stats.total, 'CARD') }),
      cards.length
        ? el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
            groupByTopic(cards).map(([topic, group]) => (topic
              ? el('section', { class: 'deck-topic' },
                  el('div', { class: 'deck-topic-head' }, icon('text-h', { size: 12 }), el('span', { text: topic }), el('span', { class: 'dim', text: String(group.length) })),
                  group.map((card) => cardRow(card, template, refresh)))
              : group.map((card) => cardRow(card, template, refresh)))))
        : el('div', { class: 'empty-state' }, icon('cards'), 'This deck is empty. Add your first card, or drag a line of notes here.'),
    ), deckId, refresh),
  );

  onPrint(host, () => cramSheet(deck, cards));
}

/**
 * A line of notes dropped on a deck becomes a card in it. A "term :: meaning"
 * line splits itself; anything else lands as the question and the dialog opens
 * so the answer can be written while the line is still in mind.
 */
function dropCards(node, deckId, refresh) {
  node.addEventListener('dragover', (event) => {
    if (!carriesBlock(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    node.classList.add('drop-cards');
  });
  node.addEventListener('dragleave', (event) => {
    if (event.relatedTarget instanceof Node && node.contains(event.relatedTarget)) return;
    node.classList.remove('drop-cards');
  });
  node.addEventListener('drop', async (event) => {
    if (!carriesBlock(event)) return;
    event.preventDefault();
    event.stopPropagation();
    node.classList.remove('drop-cards');
    const line = readBlock(event);
    if (!line) return;
    try {
      if (!line.back) {
        const form = cardForm({ front: line.front, back: '' }, await templateFor(deckId));
        const ok = await dialog({
          title: 'New card from notes', confirmLabel: 'Add card', body: form.body,
          onConfirm: async () => {
            const values = form.read();
            if (!values) return false;
            await api.createCard({ deckId, ...values });
            return true;
          },
        });
        if (!ok) return;
      } else {
        await api.createCard({ deckId, front: line.front, back: line.back });
      }
      await loadLibrary();
      await refresh();
      toast('Card added from your notes.');
    } catch (error) { reportError(error); }
  });
  return node;
}

/**
 * A deck on paper.
 *
 * The screen is a list of rows with review state on them, which is a way of
 * deciding what to study next — a question paper wants none of it. So printing
 * a deck builds its own page: the cards two to a row, each one folded down the
 * middle with the question on one half and its answer facing it on the other,
 * so that a hand or a fold covers the answer and the row can be cut out whole.
 *
 * It is appended to the body rather than mounted into the view, because the
 * interface it replaces has to stay exactly as it was to be put back.
 */
function cramSheet(deck, cards) {
  const sheet = el('div', { class: 'print-sheet' },
    el('div', { class: 'sheet-head' },
      el('div', { class: 'name', text: deck?.title ?? 'Deck' }),
      el('div', { class: 'count', text: plural(cards.length, 'CARD') }),
    ),
    el('div', { class: 'cards' },
      cards.map((card) => {
        const face = cardFaces(card);
        return el('div', { class: 'cut' },
          el('div', { class: 'half question' },
            el('span', { class: 'side', text: 'Q' }),
            el('div', { text: face.front }),
          ),
          el('div', { class: 'half answer' },
            el('span', { class: 'side', text: 'A' }),
            el('div', { text: face.back }),
          ),
        );
      }),
    ),
  );

  document.body.appendChild(sheet);
  document.documentElement.dataset.printMode = 'sheet';
  return () => {
    sheet.remove();
    delete document.documentElement.dataset.printMode;
  };
}

/**
 * Cards in the order they came, gathered under the heading they were written
 * under. Cards with no topic stay first and ungrouped, so a deck made by hand
 * reads exactly as it did.
 */
function groupByTopic(cards) {
  const groups = new Map([['', []]]);
  for (const card of cards) {
    const key = card.topic ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(card);
  }
  return [...groups].filter(([, group]) => group.length);
}

function cardRow(card, template, refresh) {
  const due = card.due_at <= Date.now();
  return el('button', {
    class: 'deck-card',
    oncontextmenu: (e) => { e.preventDefault(); cardMenu(card, template, e.clientX, e.clientY, refresh); },
    onclick: (e) => cardMenu(card, template, e.clientX, e.clientY, refresh),
  },
    el('div', { class: 'grow' },
      el('div', { class: 'front', text: isCloze(card.front) ? clozePlain(card.front) : card.front }),
      el('div', { class: 'back', text: isCloze(card.front) ? 'Cloze deletion' : card.back }),
      readOcclusion(card) ? el('span', { class: 'card-kind-occl' }, icon('image', { size: 12 }), 'Diagram region') : null,
    ),
    el('div', { class: 'state' },
      el('span', { class: 'state-tag' + (due ? ' due' : ''), text: due ? 'due' : card.state }),
      el('span', { class: 'dim', style: { fontSize: '11px' }, text: card.interval_days ? `${card.interval_days}d interval` : 'new' }),
    ),
    // One card out of a deck is an ordinary edit, not something to go hunting
    // through a context menu for.
    el('i', {
      class: 'ph ph-trash card-delete',
      title: 'Delete this card',
      onclick: (e) => { e.stopPropagation(); void removeCard(card, refresh); },
    }),
  );
}

/** A picker for one picture, resolving to the File or null. */
function pickImageFile() {
  return new Promise((resolve) => {
    const picker = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', class: 'hidden' });
    document.body.appendChild(picker);
    picker.addEventListener('change', () => { const f = picker.files?.[0] ?? null; picker.remove(); resolve(f); });
    picker.addEventListener('cancel', () => { picker.remove(); resolve(null); });
    picker.click();
  });
}

/** Deletes one card, leaving the deck and every other card in it alone. */
async function removeCard(card, refresh) {
  const ok = await confirmDelete('This card and its review history. The rest of the deck is untouched.');
  if (!ok) return false;
  try {
    await api.deleteCard(card.id);
    await loadLibrary();
    await refresh?.();
    toast('Card deleted.');
    return true;
  } catch (err) { reportError(err); return false; }
}

function cardMenu(card, template, x, y, refresh) {
  openMenu({ x, y }, [
    { head: 'CARD' },
    { icon: 'pencil-simple', label: 'Edit', onSelect: () => editCard(card, template, refresh) },
    readOcclusion(card)
      ? {
          icon: 'selection-plus', label: 'Edit diagram…',
          onSelect: async () => {
            const occl = readOcclusion(card);
            const result = await openOcclusionEditor({
              imageId: occl.imageId, deckId: card.deck_id, masks: occl.masks, mode: occl.mode,
              prompt: card.front === 'What is hidden here?' ? '' : card.front, title: 'Edit diagram cards',
            });
            if (result) { await loadLibrary(); await refresh(); }
          },
        }
      : null,
    {
      icon: card.suspended ? 'play' : 'pause',
      label: card.suspended ? 'Unsuspend' : 'Suspend',
      onSelect: async () => {
        try { await api.updateCard(card.id, { suspended: !card.suspended }); await refresh(); }
        catch (err) { reportError(err); }
      },
    },
    { sep: true },
    {
      icon: 'trash', label: 'Delete card', danger: true, onSelect: () => { void removeCard(card, refresh); },
    },
  ]);
}

/**
 * Import a deck file. With no `deckId` a new deck is made, named after the file;
 * with one, the cards are added to that deck. The student sees what was found —
 * how many cards, the first few, and what was skipped — before anything is
 * written, so a file read with the wrong separator is caught at a glance.
 */
async function importDeck(deckId, refresh) {
  const file = await pickDeckFile();
  if (!file) return;
  if (isPack(file)) return importPackFile(file, deckId, refresh);

  let result;
  try {
    result = await readDeckFile(file);
  } catch (err) {
    if (err instanceof DeckImportError) toast(err.message, 'error');
    else reportError(err);
    return;
  }

  // Quizlet exports with custom separators read as one column; offer them.
  const termSep = el('input', { class: 'input', id: 'deck-import-term-sep', maxlength: 10, placeholder: 'e.g.  -  ' });
  const cardSep = el('input', { class: 'input', id: 'deck-import-card-sep', maxlength: 10, placeholder: 'new line' });
  const summary = el('div', { class: 'muted', 'aria-live': 'polite' });
  const preview = el('div', { class: 'rows', style: { maxHeight: '240px', overflow: 'auto' } });
  const paint = () => {
    summary.textContent = `${plural(result.cards.length, 'card')} found in ${result.format} format`
      + (result.skipped ? ` · ${result.skipped} ${result.skipped === 1 ? 'line' : 'lines'} without an answer skipped` : '')
      + (result.truncated ? ' · only the first 5,000 are imported' : '')
      + '.';
    mount(preview, result.cards.slice(0, 6).map((c) => el('div', { class: 'row', style: { cursor: 'default' } },
      el('div', { class: 'grow' },
        el('div', { text: c.front }),
        el('div', { class: 'dim', style: { fontSize: '12px', marginTop: '3px' }, text: c.back }),
      ),
      c.topic ? el('span', { class: 'pill', text: c.topic }) : null,
    )));
  };
  const reread = async () => {
    if (!termSep.value) return;
    const unescape = (s) => s.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    try {
      result = await readDeckFile(file, { termSeparator: unescape(termSep.value), cardSeparator: cardSep.value ? unescape(cardSep.value) : undefined });
      paint();
    } catch (err) { summary.textContent = err.message; }
  };
  termSep.addEventListener('change', reread);
  cardSep.addEventListener('change', reread);
  paint();

  const ok = await dialog({
    title: deckId ? 'Import cards' : `Import “${file.name}”`,
    confirmLabel: 'Import',
    body: el('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
      summary,
      preview,
      el('details', null,
        el('summary', { class: 'dim', style: { fontSize: '12px', cursor: 'pointer' }, text: 'Cards look wrong? Set Quizlet’s custom separators' }),
        el('div', { style: { display: 'flex', gap: '10px', marginTop: '10px', flexWrap: 'wrap' } },
          el('div', { class: 'field grow' }, el('label', { for: 'deck-import-term-sep', text: 'Between term and definition' }), termSep),
          el('div', { class: 'field grow' }, el('label', { for: 'deck-import-card-sep', text: 'Between cards' }), cardSep),
        ),
      ),
    ),
    onConfirm: async () => {
      if (!result.cards.length) return false;
      try {
        let target = deckId;
        if (!target) {
          const title = file.name.replace(/\.[^.]+$/, '').slice(0, 200).trim() || 'Imported deck';
          target = (await api.createFile({ title, kind: 'deck' })).file.id;
        }
        summary.textContent = 'Importing…';
        const { added, failed } = await importCards(target, result.cards, (p) => {
          summary.textContent = `Importing… ${Math.round(p * 100)}%`;
        });
        await loadLibrary();
        toast(failed ? `${plural(added, 'card')} imported; ${failed} could not be added.` : `${plural(added, 'card')} imported.`);
        if (deckId) await refresh?.();
        else navigate(`deck/${target}`);
        return true;
      } catch (err) {
        if (err?.status === 0) toast(`The connection dropped after ${plural(err.added ?? 0, 'card')}. Import the file again to add the rest.`, 'error');
        else reportError(err);
        return false;
      }
    },
  });
  void ok;
}

/**
 * A .studexpack. Into the library it arrives as a new deck with its template;
 * into an open deck its cards are added and the deck keeps its own look.
 */
async function importPackFile(file, deckId, refresh) {
  let pack;
  try {
    pack = await readPackFile(file);
  } catch (err) {
    if (err instanceof DeckImportError) toast(err.message, 'error');
    else reportError(err);
    return;
  }
  if (pack.type !== 'deck') {
    toast(`“${file.name}” is a topic list. Import it from Topics.`, 'error');
    return;
  }
  const cards = Array.isArray(pack.cards) ? pack.cards : [];
  await dialog({
    title: `Import “${pack.title ?? file.name}”`,
    confirmLabel: 'Import',
    body: el('div', { class: 'muted', text: deckId
      ? `${plural(cards.length, 'card')} will be added to this deck, each starting as new.`
      : `A new deck with ${plural(cards.length, 'card')}, each starting as new. Nothing of the sender’s progress comes with it.` }),
    onConfirm: async () => {
      try {
        if (deckId) {
          const { added, failed } = await importCards(deckId, cards);
          toast(failed ? `${plural(added, 'card')} imported; ${failed} could not be added.` : `${plural(added, 'card')} imported.`);
          await loadLibrary();
          await refresh?.();
        } else {
          const { imported } = await api.importPack({ pack });
          await loadLibrary();
          toast(`${plural(imported.cards, 'card')} imported.`);
          navigate(`deck/${imported.deckId}`);
        }
        return true;
      } catch (err) {
        reportError(err);
        return false;
      }
    },
  });
}

/**
 * A composer field that speaks LaTeX. `$…$` (inline) and `$$…$$` (display) are
 * typeset live beneath the box as they are typed, and the Equation button wraps
 * the selection in `$…$` so a student never has to remember the delimiter. This
 * is the equation editor the study loop needs: what is written here is what the
 * review screen renders.
 */
function mathField(labelText, textarea) {
  const preview = el('div', { class: 'card-math-preview', 'aria-hidden': 'true', hidden: true });
  const paint = () => {
    if (hasMath(textarea.value)) { preview.hidden = false; renderMathText(preview, textarea.value); }
    else { preview.hidden = true; preview.textContent = ''; }
  };
  textarea.addEventListener('input', paint);
  const insertEquation = () => {
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    const chosen = textarea.value.slice(start, end);
    const wrapped = `$${chosen}$`;
    textarea.value = textarea.value.slice(0, start) + wrapped + textarea.value.slice(end);
    // Selection wrapped: caret after it. Nothing selected: caret between the
    // dollars, ready to type the equation.
    const caret = chosen ? start + wrapped.length : start + 1;
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
    paint();
  };
  paint();
  return el('div', { class: 'field' },
    el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'space-between' } },
      el('label', { text: labelText }),
      el('button', { type: 'button', class: 'chip tiny', title: 'Wrap the selection in $…$ as an equation', onclick: insertEquation },
        icon('math-operations', { size: 13 }), 'Equation'),
    ),
    textarea,
    preview,
  );
}

function cardForm(card, template = DEFAULT_TEMPLATE) {
  const front = el('textarea', { class: 'input', rows: 3, maxlength: 4000 });
  const back = el('textarea', { class: 'input', rows: 4, maxlength: 4000 });
  const topic = el('input', { class: 'input', maxlength: 120, value: card?.topic ?? '' });
  front.value = card?.front ?? '';
  back.value = card?.back ?? '';
  // The deck template's extra fields, named as the student named them.
  const extras = template.fields.map((field, i) => {
    const input = el('textarea', { class: 'input', rows: field.kind === 'worked' ? 4 : 1, maxlength: 4000 });
    input.value = card?.[`extra${i + 1}`] ?? '';
    return { input, node: mathField(field.label, input) };
  });

  return {
    body: el('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
      mathField('Question', front),
      mathField('Answer', back),
      extras.map((x) => x.node),
      el('div', { class: 'field' }, el('label', { text: 'Topic (optional)' }), topic),
    ),
    read: () => {
      const f = front.value.trim();
      const b = back.value.trim();
      if (!f || !b) { front.focus(); return null; }
      const values = { front: f, back: b, topic: topic.value.trim() || null };
      // Only the fields the template names are sent, so editing a card in a
      // deck whose template dropped a field leaves what was written there.
      extras.forEach((x, i) => { values[`extra${i + 1}`] = x.input.value.trim() || null; });
      return values;
    },
  };
}

async function addCard(deckId, template, refresh) {
  const form = cardForm(null, template);
  const ok = await dialog({
    title: 'New card', confirmLabel: 'Add card', body: form.body,
    onConfirm: async () => {
      const values = form.read();
      if (!values) return false;
      await api.createCard({ deckId, ...values });
      return true;
    },
  });
  if (ok) { await loadLibrary(); await refresh(); toast('Card added.'); }
}

async function editCard(card, template, refresh) {
  const form = cardForm(card, template);
  const ok = await dialog({
    title: 'Edit card', confirmLabel: 'Save', body: form.body,
    onConfirm: async () => {
      const values = form.read();
      if (!values) return false;
      await api.updateCard(card.id, values);
      return true;
    },
  });
  if (ok) { await refresh(); }
}

/* ── review session ───────────────────────────────────────────────────── */

/**
 * Where a study session sits: inside the deck, which is inside its folder. The
 * way out of a sitting is the deck it came from, not the list of every deck.
 */
function studyCrumbs(deck) {
  if (!deck) return [{ label: 'Flashcards', to: 'flashcards' }, { label: 'Study' }];
  const trail = fileCrumbs(deck);
  return [
    ...trail.slice(0, -1),
    { label: deck.title, to: `deck/${deck.id}` },
    { label: 'Study' },
  ];
}

/**
 * A mixed-session scope read out of the route: "subject/<id>", "tag/<id>" or
 * "topic/<id>" become the matching filter the study queue understands, and
 * anything else is no scope at all.
 */
function studyScope(kind, id) {
  // The "Needs work" session carries no id — it is the account's own weak spots.
  if (kind === 'needs') return { weak: true };
  if (!id) return null;
  if (kind === 'subject') return { subjectId: id };
  if (kind === 'tag') return { tagId: id };
  // A topic is free text (spaces and all), so it rides the hash encoded.
  if (kind === 'topic') return { topic: decodeURIComponent(id) };
  return null;
}

/**
 * What to call a scoped mixed session on its header, drawn from what the client
 * already holds — the subject's or tag's own name, so the sitting reads as
 * "Biology", not "All decks". A topic is its own label, so it names itself.
 */
function scopeName(scope) {
  if (!scope) return null;
  if (scope.weak) return 'Needs work';
  if (scope.subjectId) return subjectById(scope.subjectId)?.name ?? null;
  if (scope.tagId) return state.tags.find((t) => t.id === scope.tagId)?.name ?? null;
  if (scope.topic) return scope.topic;
  return null;
}

async function reviewSession(host, deckId, scope = null) {
  const [res, before, ai] = await Promise.all([
    api.studyQueue({ deckId: deckId ?? undefined, limit: 100, ...(scope ?? {}) }),
    api.studyToday().catch(() => null),
    aiAvailable().catch(() => false),
  ]);
  const templates = await templatesFor(res.cards);
  const sessionName = deckId ? null : scopeName(scope);
  const prefs = studyPrefs();
  let queue = prefs.shuffle ? shuffled(res.cards) : res.cards;
  if (prefs.sessionCap > 0) queue = queue.slice(0, prefs.sessionCap);
  const total = queue.length;
  let index = 0;
  let revealed = false;
  let shownAt = Date.now();
  let done = 0;
  let revealTimer = null;
  // Audio review reads each card aloud — front, then back on reveal. It is
  // keyed so a redraw (progress bar, a settings change) never restarts a
  // sentence mid-word; only a genuinely new face speaks.
  let spokenKey = null;
  const audioOn = () => studyPrefs().audioReview && speechAvailable();

  const deck = deckId ? fileById(deckId) : null;

  if (!queue.length) {
    mount(host,
      topbar(studyCrumbs(deck)),
      el('div', { class: 'empty-state', style: { flex: '1' } },
        icon('check-circle'), 'Nothing due right now.',
        el('button', { class: 'btn', text: 'Back to decks', onclick: () => navigate('flashcards') }),
      ),
    );
    return;
  }

  const body = el('div', { class: 'study' });
  mount(host, body);

  const onKey = (event) => {
    if (!paneIsActive(host)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName) || event.target?.isContentEditable) return;
    if (!revealed && (event.key === ' ' || event.key === 'Enter')) { event.preventDefault(); revealed = true; draw(); return; }
    if (revealed && ['1', '2', '3', '4'].includes(event.key)) { event.preventDefault(); rate(Number(event.key)); }
    if (event.key === 'Escape') navigate(deckId ? `deck/${deckId}` : 'flashcards');
  };
  document.addEventListener('keydown', onKey);

  async function rate(rating) {
    const card = queue[index];
    if (!card) return;
    const durationMs = Math.min(3_600_000, Date.now() - shownAt);
    // A dropped connection must never cost the student a review: submitReview
    // sends it now when it can and keeps it on this device to replay when the
    // server returns, so the sitting keeps moving either way.
    try {
      await submitReview(card.id, { rating, durationMs, mode: 'review' });
    } catch (err) { reportError(err); return; }

    done += 1;
    // "Again" puts the card back in this sitting, which is what the
    // scheduler's learning steps mean in practice.
    if (rating === 1 && prefs.requeueAgain) queue.push(card);
    index += 1;
    revealed = false;
    shownAt = Date.now();

    if (index >= queue.length) { await finish(); return; }
    draw();
  }

  /**
   * Deleting the card being studied. A card is never more obviously wrong than
   * when it is in front of you, so the session has to be able to act on that
   * without breaking off to go and find the deck.
   */
  async function deleteCurrent() {
    const card = queue[index];
    if (!card) return;
    if (!(await removeCard(card, null))) return;
    // A card rated Again is pushed back onto the queue, so the same one can be
    // waiting further along this same sitting.
    queue = queue.filter((other, at) => at < index || other.id !== card.id);
    revealed = false;
    shownAt = Date.now();
    if (index >= queue.length) { await finish(); return; }
    draw();
  }

  async function finish() {
    clearTimeout(revealTimer);
    cancelSpeech();
    document.removeEventListener('keydown', onKey);
    await loadLibrary();
    // The queue has moved on, so the badge has too — and this is the one
    // moment a student is certain to be looking somewhere other than the Dock.
    refreshDue().catch(() => { /* a stale count is not worth an error */ });
    const after = done ? await api.studyToday().catch(() => null) : null;
    const was = before?.streak_days ?? 0;
    const now = after?.streak_days ?? was;
    const counted = Boolean(after && now > was);
    const streakNode = el('span', { class: 'streak-done-n', text: String(counted ? was : now) });
    mount(body,
      el('div', { class: 'empty-state session-done', style: { flex: '1' } },
        icon('confetti', { size: 34 }),
        el('div', { style: { fontSize: '15px', color: 'var(--color-text)' }, text: `${plural(done, 'card')} reviewed.` }),
        now
          ? el('div', { class: 'streak-done' + (counted ? ' lit' : '') }, icon('flame', { size: 16, bold: true }), streakNode, ' day streak')
          : null,
        el('div', { class: 'dim' }, 'Intervals updated by the scheduler.'),
        el('button', { class: 'btn primary lg', text: 'Done', onclick: () => navigate(deckId ? `deck/${deckId}` : 'flashcards') }),
      ),
    );
    if (counted) {
      await celebrateStreak({ from: was, to: now, best: now >= (after.best_streak_days ?? 0) && now > (before?.best_streak_days ?? 0) });
      if (streakNode.isConnected) rollNumber(streakNode, was, now, 500);
    }
  }

  function draw() {
    const card = queue[index];
    if (!card) return;
    const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
    // A cloze card draws its own front and back — one group blanked, the rest
    // revealed — and rotates the group by how often it has been seen; reverse
    // has no meaning for it, so cardFaces quietly ignores it there.
    const template = templates.get(card.deck_id) ?? DEFAULT_TEMPLATE;
    // An occlusion card asks about a picture, so it has no reverse side.
    const occl = readOcclusion(card);
    const faces = cardFaces(card, occl ? false : showBackFirst(template, prefs.reverse));
    const shownFront = faces.front;
    const shownBack = faces.back;
    const extras = extraText(template, card);
    clearTimeout(revealTimer);
    if (!revealed && prefs.autoReveal > 0) {
      const at = card;
      revealTimer = setTimeout(() => {
        if (!body.isConnected || queue[index] !== at || revealed) return;
        revealed = true;
        draw();
      }, prefs.autoReveal * 1000);
    }

    mount(body,
      el('div', { class: 'study-head' },
        el('button', { title: 'End session', onclick: () => navigate(deckId ? `deck/${deckId}` : 'flashcards') }, icon('x', { size: 17, class: 'muted' })),
        el('button', { class: 'study-delete', title: 'Delete this card', onclick: () => { void deleteCurrent(); } }, icon('trash', { size: 15 })),
        el('span', { class: 'name', text: deck?.title ?? sessionName ?? 'All decks' }),
        el('span', { class: 'pos', text: `${Math.min(done + 1, total)} / ${total}` }),
        el('div', { class: 'progress' }, el('div', { style: { width: `${pct}%` } })),
        el('span', { class: 'dim', style: { fontSize: '12px' }, text: `Spaced repetition · ${res.due_count} due today` }),
        speechAvailable()
          ? el('button', {
              class: 'chip' + (prefs.audioReview ? ' on' : ''), type: 'button',
              'aria-pressed': prefs.audioReview ? 'true' : 'false',
              title: prefs.audioReview ? 'Reading cards aloud — click to stop' : 'Read each card aloud for hands-free review',
              onclick: () => {
                const next = !studyPrefs().audioReview;
                saveStudyPrefs({ audioReview: next });
                prefs.audioReview = next;
                spokenKey = null;
                if (!next) cancelSpeech();
                draw();
              },
            }, icon(prefs.audioReview ? 'speaker-high' : 'speaker-simple-low', { size: 14 }), 'Audio')
          : null,
        el('div', { class: 'seg' },
          el('button', { class: 'on', text: 'Review' }),
          el('button', { text: 'Test', onclick: () => navigate(deckId ? `test/deck/${deckId}` : 'test') }),
        ),
      ),
      el('div', { class: 'study-body' },
        el('div', { class: 'card-face' },
          el('span', { class: 'section-label plain', text: revealed ? 'REVIEW — CARD REVEALED' : 'REVIEW — RECALL THE ANSWER' }),
          el('div', {
            class: 'card-surface' + surfaceClasses(template) + (revealed ? '' : ' hidden-answer'),
            role: 'group', 'aria-live': 'polite',
            'aria-label': `${card.topic ? card.topic + '. ' : ''}Question. ${mathLineToText(shownFront)}.${revealed ? ` Answer. ${mathLineToText(shownBack)}.${extras ? ` ${extras}` : ''}` : ' Answer hidden — recall it, then reveal.'}`,
          },
            card.topic ? el('div', { class: 'topic', text: card.topic }) : null,
            faceEl('q', shownFront),
            occl ? occlusionFigure(occl, { revealed }) : null,
            revealed ? faceEl('a', shownBack) : null,
            revealed ? extraFields(template, card) : null,
            el('div', { class: 'foot' },
              occl && revealed
                ? el('button', {
                    class: 'chip', type: 'button', title: 'Move, rename or add boxes on this diagram',
                    onclick: async () => {
                      const result = await openOcclusionEditor({
                        imageId: occl.imageId, deckId: card.deck_id, masks: occl.masks, mode: occl.mode,
                        prompt: card.front === 'What is hidden here?' ? '' : card.front, title: 'Edit diagram cards',
                      });
                      const fresh = result?.cards?.find((c) => c.id === card.id);
                      if (fresh) { queue[index] = fresh; draw(); return; }
                      if (!result) return;
                      // Its box was removed, so the card went with it.
                      queue = queue.filter((other, at) => at < index || other.id !== card.id);
                      revealed = false;
                      if (index >= queue.length) { await finish(); return; }
                      draw();
                    },
                  }, icon('selection-plus', { size: 13 }), 'Edit diagram')
                : null,
              card.source_file_id ? icon('link-simple') : null,
              card.source_file_id ? el('span', null, 'From ', el('span', { style: { color: 'var(--color-accent-300)' }, text: fileById(card.source_file_id)?.title ?? 'a linked file' })) : null,
              revealed && ai && prefs.showExplain
                ? el('button', {
                    class: 'chip ai-chip', type: 'button', title: 'Ask AI to explain this card',
                    onclick: () => askAbout(`Explain this flashcard so I understand it rather than memorise it, with a memorable example.\n\nQuestion: ${shownFront}\nAnswer: ${shownBack}`, { withPage: false }),
                  }, icon('sparkle', { size: 13 }), 'Explain')
                : null,
              prefs.showCardInfo ? el('span', { style: { marginLeft: 'auto' }, text: `Seen ${card.repetitions} ${card.repetitions === 1 ? 'time' : 'times'}${card.interval_days ? ` · interval ${card.interval_days}d` : ''}` }) : null,
            ),
          ),
          revealed
            ? el('div', { class: 'ratings', role: 'group', 'aria-label': 'How well did you recall it?' }, RATINGS.map((r) => el('button', {
                class: 'rating' + (r.primary ? ' good' : ''),
                'aria-label': `${r.label} — press ${r.value}`,
                onclick: () => rate(r.value),
              },
                el('span', { class: 'face', text: r.face, 'aria-hidden': 'true' }),
                r.label,
                el('span', { class: 'k', text: String(r.value), 'aria-hidden': 'true' }),
              )))
            : el('button', { class: 'reveal-hint', onclick: () => { revealed = true; draw(); } },
                'Press ', el('span', { class: 'key', text: 'Space' }), prefs.autoReveal > 0 ? ` to reveal the answer · shows in ${prefs.autoReveal}s` : ' to reveal the answer'),
        ),
      ),
    );

    // Read the face that is now showing, once. Front on a fresh card, back once
    // it is revealed — the "front, pause, back" a hands-free student hears.
    if (audioOn()) {
      const key = `${card.id}:${revealed ? 'back' : 'front'}`;
      if (key !== spokenKey) {
        spokenKey = key;
        speak(revealed ? `${mathLineToText(shownBack)}${extras ? ` ${extras}` : ''}` : mathLineToText(shownFront), { rate: studyPrefs().speechRate });
      }
    }
  }

  draw();
  return () => { clearTimeout(revealTimer); cancelSpeech(); document.removeEventListener('keydown', onKey); };
}

/* ── test mode ────────────────────────────────────────────────────────── */

export async function testView(route, host) {
  // Routes: test · test/deck/<id> · test/folder/<id>
  let deckId = null;
  if (route.path[1] === 'deck') deckId = route.path[2];
  else if (route.path[1] === 'folder') {
    const decks = state.files.filter((f) => f.kind === 'deck' && f.folder_id === route.path[2]);
    if (decks.length === 1) deckId = decks[0].id;
    else if (decks.length === 0) {
      mount(host, topbar(['Test']), el('div', { class: 'empty-state', style: { flex: '1' } },
        icon('exam'), 'That folder has no flashcard decks to test.',
        el('button', { class: 'btn', text: 'Back', onclick: () => navigate('library') })));
      return;
    } else {
      // The API scopes a test to one deck, so pick rather than silently guess.
      const select = dropdown({ class: 'input' }, decks.map((d) => el('option', { value: d.id, text: d.title })));
      const ok = await dialog({
        title: 'Test which deck?', confirmLabel: 'Start',
        body: el('div', { class: 'field' }, el('label', { text: 'Deck' }), select),
        onConfirm: () => true,
      });
      if (!ok) { navigate('library'); return; }
      deckId = select.value;
    }
  }

  const deck = deckId ? fileById(deckId) : null;
  const { cards } = await api.deckCards(deckId ?? '', { limit: 200 }).catch(() => ({ cards: [] }));
  let all = cards.length ? cards : (await api.studyQueue({ deckId: deckId ?? undefined, limit: 100 })).cards;
  all = all.filter((c) => !c.suspended);
  if (!all.length) {
    mount(host, topbar(['Test']), el('div', { class: 'empty-state', style: { flex: '1' } },
      icon('exam'), 'No cards to test.',
      el('button', { class: 'btn', text: 'Back', onclick: () => navigate('flashcards') })));
    return;
  }

  const body = el('div', { class: 'study' });
  mount(host, body);
  const back = () => navigate(deckId ? `deck/${deckId}` : 'flashcards');
  const ai = await aiAvailable().catch(() => false);
  let timerId = null;
  let alive = true;

  /* ---- setup: which kind of test ---- */
  const LOCAL_MODES = [
    { id: 'typed', icon: 'keyboard', label: 'Typed answer', note: 'Type the back of each card.' },
    { id: 'choice', icon: 'list-checks', label: 'Multiple choice', note: 'Pick from other cards’ answers.' },
    { id: 'truefalse', icon: 'check-square', label: 'True or false', note: 'Does this answer match?' },
  ];

  function setup() {
    const p = studyPrefs();
    let chosen = p.testMode;
    const modeCard = (m, isAi) => el('button', {
      type: 'button', class: 'quiz-mode' + (chosen === m.id ? ' on' : '') + (isAi ? ' ai' : ''),
      onclick: () => { chosen = m.id; draw(); },
    }, icon(isAi ? 'sparkle' : m.icon, { size: 18 }), el('b', { text: m.label }), el('span', { text: m.note }));
    const pick = (key, options) => el('div', { class: 'seg' }, options.map(([v, t]) => el('button', {
      class: String(studyPrefs()[key]) === String(v) ? 'on' : '',
      text: t,
      onclick: () => { saveStudyPrefs({ [key]: v }); draw(); },
    })));
    const draw = () => {
      const aiPick = QUIZ_MODES.find((m) => `ai-${m.id}` === chosen);
      mount(body,
        el('div', { class: 'study-head' },
          el('button', { title: 'Back', onclick: back }, icon('x', { size: 17, class: 'muted' })),
          el('span', { class: 'name', text: deck?.title ?? 'All decks' }),
          el('span', { class: 'pos', text: plural(all.length, 'card') }),
          el('div', { class: 'seg', style: { marginLeft: 'auto' } },
            el('button', { text: 'Review', onclick: () => navigate(deckId ? `deck/${deckId}/study` : 'flashcards') }),
            el('button', { class: 'on', text: 'Test' }),
          ),
        ),
        el('div', { class: 'study-body' },
          el('div', { class: 'card-face test-setup' },
            el('span', { class: 'section-label plain', text: 'TEST MODE' }),
            el('div', { class: 'quiz-modes' }, LOCAL_MODES.map((m) => modeCard(m, false))),
            ai ? el('span', { class: 'section-label plain', text: 'AI TESTS — WRITTEN FROM THIS DECK' }) : null,
            ai ? el('div', { class: 'quiz-modes' }, QUIZ_MODES.map((m) => modeCard({ ...m, id: `ai-${m.id}` }, true))) : null,
            el('div', { class: 'test-options' },
              el('div', { class: 'setting-row' }, el('span', { class: 'label', text: 'Questions' }), pick('testLength', [[0, 'All'], [10, '10'], [20, '20'], [40, '40']])),
              el('div', { class: 'setting-row' }, el('span', { class: 'label', text: 'Time limit' }), pick('testTimer', [[0, 'None'], [5, '5m'], [10, '10m'], [20, '20m']])),
              aiPick ? null : el('div', { class: 'setting-row' }, el('span', { class: 'label', text: 'Shuffle' }), pick('testShuffle', [[true, 'On'], [false, 'Off']])),
              aiPick || chosen !== 'typed' ? null : el('div', { class: 'setting-row' }, el('span', { class: 'label', text: 'Answer checking' }), pick('strictness', [['exact', 'Exact'], ['normal', 'Normal'], ['lenient', 'Lenient']])),
            ),
            el('button', { class: 'btn primary lg', text: 'Start test', onclick: () => {
              if (aiPick) {
                const prefs = studyPrefs();
                const text = all.slice(0, 150).map((c) => `Q: ${c.front}\nA: ${c.back}`).join("\n\n").slice(0, 23_000);
                void quizDialog({
                  source: { from: 'text', text },
                  label: deck?.title ?? 'All decks',
                  mode: aiPick.id,
                  count: Math.min(20, prefs.testLength || 10),
                  minutes: prefs.testTimer,
                });
                return;
              }
              saveStudyPrefs({ testMode: chosen });
              void run(chosen);
            } }),
          ),
        ),
      );
    };
    draw();
  }

  /* ---- a sitting ---- */
  async function run(mode) {
    const prefs = studyPrefs();
    let pool = prefs.testShuffle ? shuffled(all) : all.slice();
    if (prefs.testLength > 0) pool = pool.slice(0, prefs.testLength);

    let current;
    try { ({ test: current } = await api.startTest({ deckId })); } catch (err) { reportError(err); return; }

    let index = 0;
    let shownAt = Date.now();
    let lastResult = null;
    let finished = false;
    let endsAt = prefs.testTimer > 0 ? Date.now() + prefs.testTimer * 60_000 : 0;
    const clock = el('span', { class: 'quiz-clock' });

    const onKey = (event) => {
      if (!paneIsActive(host) || finished) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.target?.tagName === 'INPUT' || event.target?.tagName === 'TEXTAREA') return;
      if (lastResult && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); advance(); return; }
      if (!lastResult && mode === 'choice' && /^[1-4]$/.test(event.key)) { body.querySelectorAll('.ai-option')[Number(event.key) - 1]?.click(); }
      if (!lastResult && mode === 'truefalse') {
        if (event.key.toLowerCase() === 't') body.querySelectorAll('.ai-option')[0]?.click();
        if (event.key.toLowerCase() === 'f') body.querySelectorAll('.ai-option')[1]?.click();
      }
    };
    document.addEventListener('keydown', onKey);

    if (endsAt) {
      const tick = () => {
        if (!body.isConnected || !alive) { clearInterval(timerId); return; }
        const left = Math.max(0, endsAt - Date.now());
        clock.textContent = `${Math.floor(left / 60_000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}`;
        clock.classList.toggle('low', left < 30_000);
        if (left <= 0 && !finished) { toast('Time is up.'); void end(); }
      };
      tick();
      timerId = setInterval(tick, 500);
    }

    // Choices come from the rest of the deck, so they are the answers a
    // student could actually confuse.
    const choicesFor = (card) => {
      const others = shuffled(all.filter((c) => c.id !== card.id && normalise(c.back) !== normalise(card.back)).map((c) => c.back));
      const unique = [...new Set(others)].slice(0, 3);
      return shuffled([card.back, ...unique]);
    };
    const statementFor = (card) => {
      const others = all.filter((c) => c.id !== card.id && normalise(c.back) !== normalise(card.back));
      const truthful = !others.length || Math.random() < 0.5;
      return { truthful, shown: truthful ? card.back : others[Math.floor(Math.random() * others.length)].back };
    };
    let prepared = null;
    const prepare = () => {
      const card = pool[index];
      prepared = mode === 'choice' ? { options: choicesFor(card) } : mode === 'truefalse' ? statementFor(card) : null;
    };

    async function submit(correct, given) {
      const card = pool[index];
      lastResult = { correct, expected: card.back, given };
      try {
        const res = await api.answerTest(current.id, {
          cardId: card.id,
          correct,
          durationMs: Math.min(3_600_000, Date.now() - shownAt),
        });
        current = res.test;
      } catch (err) { reportError(err); return; }
      draw();
    }

    function advance() {
      index += 1;
      lastResult = null;
      shownAt = Date.now();
      if (index >= pool.length) { void end(); return; }
      prepare();
      draw();
    }

    async function end() {
      if (finished) return;
      finished = true;
      clearInterval(timerId);
      document.removeEventListener('keydown', onKey);
      try {
        const { test: done } = await api.endTest(current.id);
        current = done;
      } catch (err) { reportError(err); }
      await loadLibrary();
      if (!body.isConnected) return;
      mount(body,
        el('div', { class: 'empty-state', style: { flex: '1' } },
          icon('seal-check', { size: 34 }),
          el('div', { style: { fontSize: '15px', color: 'var(--color-text)' }, text: `Score ${current.score_pct ?? 0}%` }),
          el('div', { class: 'dim', text: `${current.correct_count} correct · ${current.answered_count - current.correct_count} missed${current.answered_count < pool.length ? ` · ${pool.length - current.answered_count} unanswered` : ''}` }),
          el('div', { style: { display: 'flex', gap: '8px' } },
            el('button', { class: 'btn lg', text: 'Test again', onclick: () => setup() }),
            el('button', { class: 'btn primary lg', text: 'Done', onclick: back }),
          ),
        ),
      );
    }

    function answerArea(card) {
      if (lastResult) {
        return el('button', { class: 'btn primary lg', text: index + 1 >= pool.length ? 'Finish' : 'Next card', onclick: () => advance() });
      }
      if (mode === 'choice') {
        return el('div', { class: 'ai-options test-options-list' }, prepared.options.map((option, i) => el('button', {
          type: 'button', class: 'ai-option',
          onclick: () => submit(normalise(option) === normalise(card.back), option),
        }, el('span', { class: 'letter', text: String(i + 1) }), el('span', { text: option }))));
      }
      if (mode === 'truefalse') {
        return el('div', { class: 'test-truefalse' },
          el('div', { class: 'test-statement' }, el('span', { class: 'dim', text: 'Answer: ' }), prepared.shown),
          el('div', { class: 'ai-options', style: { flexDirection: 'row' } },
            el('button', { type: 'button', class: 'ai-option', onclick: () => submit(prepared.truthful, 'True') }, el('span', { class: 'letter', text: 'T' }), 'True'),
            el('button', { type: 'button', class: 'ai-option', onclick: () => submit(!prepared.truthful, 'False') }, el('span', { class: 'letter', text: 'F' }), 'False'),
          ),
        );
      }
      const input = el('input', { placeholder: 'Type the answer', autofocus: true, spellcheck: 'false' });
      queueMicrotask(() => input.focus());
      return el('form', {
        onsubmit: (event) => { event.preventDefault(); submit(matches(input.value, card.back, prefs.strictness), input.value); },
      }, el('div', { class: 'answer-input' }, input, el('span', { class: 'hint', text: '↵ to check' })));
    }

    function draw() {
      if (!body.isConnected) return;
      const card = pool[index];
      const answered = current.answered_count ?? 0;
      const correct = current.correct_count ?? 0;
      const label = { typed: 'TYPED ANSWER', choice: 'MULTIPLE CHOICE', truefalse: 'TRUE OR FALSE' }[mode];

      mount(body,
        el('div', { class: 'study-head' },
          el('button', { title: 'End test', onclick: () => end() }, icon('x', { size: 17, class: 'muted' })),
          el('span', { class: 'name', text: deck?.title ?? 'All decks' }),
          el('span', { class: 'pos', text: `${index + 1} / ${pool.length}` }),
          el('div', { class: 'progress' }, el('div', { style: { width: `${Math.round((index / pool.length) * 100)}%` } })),
          endsAt ? clock : null,
          el('div', { class: 'seg' },
            el('button', { text: 'Review', onclick: () => navigate(deckId ? `deck/${deckId}/study` : 'flashcards') }),
            el('button', { class: 'on', text: 'Test' }),
          ),
        ),
        el('div', { class: 'study-body' },
          el('div', { class: 'card-face' },
            el('span', { class: 'section-label plain', text: `TEST MODE — ${label}` }),
            el('div', { class: 'card-surface' + (lastResult ? '' : ' hidden-answer') },
              card.topic ? el('div', { class: 'topic', text: card.topic }) : null,
              el('div', { class: 'q', text: card.front }),
              readOcclusion(card) ? occlusionFigure(readOcclusion(card), { revealed: Boolean(lastResult) }) : null,
              lastResult
                ? el('div', { class: 'a' },
                    el('div', { style: { color: lastResult.correct ? 'var(--color-accent-300)' : 'oklch(0.78 0.12 25)', marginBottom: '10px' }, text: lastResult.correct ? 'Correct' : 'Not quite' }),
                    el('div', { text: card.back }),
                    !lastResult.correct && mode === 'typed' && lastResult.given ? el('div', { class: 'dim', style: { marginTop: '8px', fontSize: '13px' }, text: `You wrote: ${lastResult.given}` }) : null,
                  )
                : null,
              el('div', { class: 'foot' },
                el('span', { style: { marginLeft: 'auto' }, text: lastResult ? 'Enter for the next card' : 'Scored on the server from its own tally' }),
              ),
            ),
            answerArea(card),
            el('div', { class: 'scoreboard' },
              el('div', null, el('div', { class: 'k', text: 'CORRECT' }), el('div', { class: 'v lead', text: String(correct) })),
              el('div', null, el('div', { class: 'k', text: 'MISSED' }), el('div', { class: 'v', text: String(answered - correct) })),
              el('div', null, el('div', { class: 'k', text: 'ANSWERED' }), el('div', { class: 'v', text: `${answered}/${pool.length}` })),
              el('div', null, el('div', { class: 'k', text: 'SCORE' }), el('div', { class: 'v', text: `${current.score_pct ?? 0}%` })),
              el('button', { class: 'btn primary', style: { marginLeft: 'auto' }, text: 'End & save score', onclick: () => end() }),
            ),
          ),
        ),
      );
    }

    prepare();
    draw();
  }

  setup();
  return () => { alive = false; clearInterval(timerId); };
}
