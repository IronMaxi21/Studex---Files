/**
 * Screen 09 — the topic matrix.
 *
 * A specification, broken into topics, with an honest mark out of five against
 * each one. That mark is the only thing anyone has to enter: the date to come
 * back is worked out from it and cannot be typed, so the schedule is a
 * consequence of the self-assessment rather than a second thing to maintain.
 *
 * Two readings of the same table. The matrix groups everything by subject and
 * unit and is for looking at the whole course at once — the shape of the
 * colour tells you where the year is weak. The due list flattens it to a
 * worklist in the order the dates fell, and is for a Tuesday evening.
 */
import { el, icon, mount, applyColor } from '../dom.js';
import { dropdown } from '../select.js';
import { api } from '../api.js';
import { navigate } from '../router.js';
import { topbar, subnav, pageMenu } from '../shell.js';
import { state, subjectById, toast, reportError } from '../store.js';
import { openMenu } from '../menu.js';
import { dialog, confirmDelete } from '../dialog.js';
import { shortDate, countdown, plural } from '../format.js';
import { aiAvailable, importSpecDialog, quizDialog, dedupeDialog } from '../ai.js';
import { pickDeckFile, readPackFile, isPack, DeckImportError } from '../deck-import.js';

/** A colour per step, so a glance across a unit reads as a heat map. */
const CONF_COLOR = ['rose', 'rose', 'amber', 'lime', 'teal'];

/** Filters, kept at module scope so they survive a rate-and-re-render. */
let filterSubject = '';
const folded = new Set();

/** True when nothing is left open — which is what turns the button around. */
function allFolded(groups) {
  return groups.length > 0 && groups.every(([key]) => folded.has(key));
}

export async function topicsView(route, host) {
  if (route.path[1] === 'due') return dueView(route, host);
  // topics/<subjectId> opens the matrix already filtered, so a lesson on Home,
  // a Spotlight result and a studex:// link can all name a subject and land on
  // it. An id that is not a subject any more is ignored rather than empty.
  const wanted = route.path[1];
  if (wanted && state.subjects.some((s) => s.id === wanted)) filterSubject = wanted;
  return matrixView(route, host);
}

/**
 * The subject's topic list as a .studexpack — names and units, none of the
 * confidence ratings. A menu row has no href, so the link is made, clicked and
 * thrown away, the same way the rest of the app hands a file to the browser.
 */
function downloadPack(subjectId) {
  const link = el('a', { href: `/api/subjects/${subjectId}/pack`, download: '' });
  document.body.append(link);
  link.click();
  link.remove();
}

/* ── the matrix ───────────────────────────────────────────────────────── */

async function matrixView(route, host) {
  const refresh = () => matrixView(route, host);
  const { topics, summary, confidenceDays, confidenceLabels } =
    await api.topics({ subjectId: filterSubject, limit: 1000 });

  const groups = groupTopics(topics);
  const ai = await aiAvailable();
  const scope = filterSubject ? `“${subjectById(filterSubject)?.name ?? 'this subject'}”` : 'every subject';

  mount(host,
    // Six chips across the top left no room for the path and none of them for
    // the one thing this screen is for. Adding a topic stays a button; getting
    // a list in or out is occasional, so it moves into the ⋯ menu.
    topbar(['Topics'],
      el('button', { class: 'chip', onclick: () => topicDialog(null, refresh) }, icon('plus'), 'New topic'),
      pageMenu(() => [
        { head: 'TOPICS' },
        ai ? { icon: 'sparkle', label: 'Import a specification…', onSelect: () => importSpecDialog({ subjectId: filterSubject, refresh }) } : null,
        { icon: 'clipboard-text', label: 'Paste a list…', onSelect: () => importDialog(refresh) },
        { icon: 'package', label: 'Import a pack…', onSelect: () => void importTopicPack(refresh) },
        filterSubject && topics.length
          ? { icon: 'share-network', label: 'Save this subject as a pack', onSelect: () => downloadPack(filterSubject) }
          : null,
        ai && topics.length > 1
          ? { icon: 'copy', label: 'Find duplicates…', onSelect: () => dedupeDialog({ subjectId: filterSubject || null, scope, refresh }) }
          : null,
      ]),
    ),
    subnav('topics', 'topics',
      subjectFilter(refresh),
      el('span', { class: 'week-label', text: plural(summary.total, 'topic') }),
      // A specification unpacks into thirty units, and the only way back to a
      // list you can see the shape of was thirty clicks. One button folds the
      // lot, and — once everything is folded — unfolds it again.
      groups.length > 1
        ? el('button', {
          class: 'chip', type: 'button',
          title: allFolded(groups) ? 'Open every subject' : 'Fold every subject down to its heading',
          onclick: () => {
            if (allFolded(groups)) folded.clear();
            else for (const [key] of groups) folded.add(key);
            refresh();
          },
        }, icon(allFolded(groups) ? 'arrows-out-line-vertical' : 'arrows-in-line-vertical', { size: 13 }),
        allFolded(groups) ? 'Expand all' : 'Collapse all')
        : null,
    ),
    el('div', { class: 'content' },
      summaryTiles(summary, confidenceDays),
      topics.length
        ? el('div', { class: 'matrix' },
            el('div', { class: 'matrix-head' },
              el('span', { text: 'TOPIC' }),
              el('span', { class: 'conf', text: 'CONFIDENCE' }),
              el('span', { text: 'LAST' }),
              el('span', { text: 'NEXT DUE' }),
              el('span'),
            ),
            groups.map(([key, group]) => groupBlock(key, group, confidenceLabels, refresh)),
          )
        : emptyMatrix(refresh),
    ),
  );
}

/**
 * Subject, then unit within it. Unplaced topics collect under one heading
 * rather than being scattered, because a half-entered specification is the
 * normal state of this screen and should still look like a list.
 */
function groupTopics(topics) {
  const groups = new Map();
  for (const topic of topics) {
    const subject = topic.subject_id ? subjectById(topic.subject_id) : null;
    const key = `${subject?.id ?? ''}/${topic.unit ?? ''}`;
    if (!groups.has(key)) {
      groups.set(key, {
        subject,
        unit: topic.unit,
        title: subject?.name ?? 'No subject',
        color: subject?.color ?? 'neutral',
        topics: [],
      });
    }
    groups.get(key).topics.push(topic);
  }
  return [...groups.entries()].sort((a, b) =>
    a[1].title.localeCompare(b[1].title) || (a[1].unit ?? '').localeCompare(b[1].unit ?? ''));
}

function groupBlock(key, group, labels, refresh) {
  const open = !folded.has(key);
  const rated = group.topics.filter((t) => t.confidence > 0);
  const mean = rated.length
    ? rated.reduce((sum, t) => sum + t.confidence, 0) / rated.length
    : 0;
  const due = group.topics.filter((t) => t.overdue || t.next_due_at === null).length;

  const head = el('button', {
    class: 'matrix-group' + (open ? ' open' : ''),
    'aria-expanded': String(open),
    onclick: () => { if (open) folded.add(key); else folded.delete(key); refresh(); },
  },
    icon(open ? 'caret-down' : 'caret-right', { size: 12, class: 'dim' }),
    el('span', { class: 'bar' }),
    el('span', { class: 'name', text: group.title }),
    group.unit ? el('span', { class: 'unit', text: group.unit }) : null,
    el('span', { class: 'grow' }),
    due ? el('span', { class: 'due-pill', text: `${due} due` }) : null,
    el('span', { class: 'mean', text: rated.length ? `${mean.toFixed(1)} / 5` : 'unrated' }),
    el('span', { class: 'count', text: String(group.topics.length) }),
  );

  return el('div', { class: 'matrix-block' },
    applyColor(head, group.color),
    open ? group.topics.map((topic) => topicRow(topic, labels, refresh)) : null,
  );
}

function topicRow(topic, labels, refresh) {
  const overdue = topic.next_due_at !== null && topic.overdue;
  const never = topic.confidence === 0;

  return el('div', { class: 'matrix-row' + (overdue ? ' overdue' : '') + (never ? ' unrated' : '') },
    el('button', {
      class: 'name',
      title: topic.notes || 'Edit this topic',
      onclick: () => topicDialog(topic, refresh),
    },
      topic.spec_ref ? el('span', { class: 'spec-ref', text: topic.spec_ref }) : null,
      topic.name,
    ),
    confidenceControl(topic, labels, refresh),
    el('span', { class: 'last', text: topic.last_rated_at ? shortDate(topic.last_rated_at) : '—' }),
    el('span', { class: 'next' },
      never
        ? el('span', { class: 'flag new', text: 'Not yet rated' })
        : overdue
          ? el('span', { class: 'flag over', text: `${shortDate(topic.next_due_at)} · overdue` })
          : el('span', { text: `${shortDate(topic.next_due_at)} · ${countdown(topic.days_until)}` }),
    ),
    el('button', {
      class: 'btn icon',
      title: 'More',
      'aria-label': `More for ${topic.name}`,
      onclick: (e) => rowMenu(topic, e.currentTarget, refresh),
    }, icon('dots-three-vertical', { size: 14 })),
  );
}

/**
 * The one control on the screen.
 *
 * Five steps, filled like a signal strength, each labelled with the sentence
 * it means so that "3" is never a number someone has to interpret. Clicking the
 * step you are already on re-rates rather than doing nothing, which is what
 * makes it usable as "I looked at this again today and it still holds".
 */
function confidenceControl(topic, labels, refresh) {
  const row = el('div', { class: 'conf', role: 'group', 'aria-label': `Confidence in ${topic.name}` });
  for (let level = 1; level <= 5; level += 1) {
    const on = topic.confidence >= level;
    const step = el('button', {
      class: 'conf-step' + (on ? ' on' : ''),
      title: `${labels[level - 1]} — next in ${plural(CONFIDENCE_DAYS_FALLBACK[level - 1], 'day')}`,
      'aria-label': labels[level - 1],
      'aria-pressed': String(topic.confidence === level),
      onclick: async () => {
        try {
          await api.rateTopic(topic.id, level);
          await refresh();
        } catch (err) { reportError(err); }
      },
    });
    row.appendChild(applyColor(step, on ? CONF_COLOR[topic.confidence - 1] : 'neutral'));
  }
  return row;
}

/* The schedule is the server's, but the tooltip has to say something before the
   first request comes back; these are the same numbers and are only ever read. */
const CONFIDENCE_DAYS_FALLBACK = [1, 3, 7, 16, 35];

function summaryTiles(summary, days) {
  const tiles = [
    { kicker: 'TOPICS', value: summary.total, sub: 'across every subject' },
    { kicker: 'DUE NOW', value: summary.due, sub: 'including everything unrated', lead: true },
    { kicker: 'NEVER RATED', value: summary.unrated, sub: 'no judgement yet' },
    { kicker: 'SHAKY', value: summary.shaky, sub: 'rated 1 or 2' },
    { kicker: 'SOLID', value: summary.solid, sub: 'rated 4 or 5' },
  ];
  return el('div', null,
    el('div', { class: 'matrix-stats' },
      tiles.map((t) => el('div', { class: 'stat' + (t.lead ? ' lead' : '') },
        el('div', { class: 'kicker', text: t.kicker }),
        el('div', { class: 'value', text: String(t.value ?? 0) }),
        el('div', { class: 'sub', text: t.sub }),
      )),
    ),
    el('p', { class: 'matrix-note' },
      `A rating buys ${(days ?? CONFIDENCE_DAYS_FALLBACK).join(', ')} days as it climbs. `,
      el('button', {
        class: 'link-label',
        text: `Work through what is due (${summary.due ?? 0})`,
        onclick: () => navigate('topics/due'),
      }),
    ),
  );
}

function emptyMatrix(refresh) {
  return el('div', { class: 'empty-state' },
    icon('target'),
    filterSubject
      ? 'Nothing in this subject yet.'
      : 'No topics yet. Import a specification and every topic on it becomes one you can rate.',
    el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'center' } },
      el('button', { class: 'btn primary', text: 'Import a specification file', onclick: () => importSpecDialog({ subjectId: filterSubject, refresh }) }),
      el('button', { class: 'btn', text: 'Paste a list', onclick: () => importDialog(refresh) }),
    ),
  );
}

function subjectFilter(refresh) {
  const select = dropdown({
    class: 'input', title: 'Subject',
    onchange: () => { filterSubject = select.value; refresh(); },
  },
    el('option', { value: '', text: 'Every subject', selected: filterSubject === '' }),
    state.subjects.map((s) => el('option', { value: s.id, text: s.name, selected: filterSubject === s.id })),
  );
  return select;
}

/* ── the due list ─────────────────────────────────────────────────────── */

/**
 * The same topics, flattened and in date order, which is the only order that
 * matters once you have sat down to work. Unrated topics come first because
 * they are the ones nobody has looked at at all.
 */
async function dueView(route, host) {
  const refresh = () => dueView(route, host);
  const { topics, summary, confidenceLabels } =
    await api.topics({ subjectId: filterSubject, due: 'true', limit: 500 });

  mount(host,
    topbar(['Topics', 'Due'],
      el('button', { class: 'chip', onclick: () => topicDialog(null, refresh) }, icon('plus'), 'New topic'),
    ),
    subnav('topics', 'topics/due',
      subjectFilter(refresh),
      el('span', { class: 'week-label', text: `${topics.length} of ${summary.total}` }),
    ),
    el('div', { class: 'content' },
      el('div', { class: 'page-head' },
        el('div', { class: 'page-title', text: 'Due for review' }),
        el('div', { class: 'note', text: topics.length ? `${plural(topics.length, 'topic')} waiting` : 'All caught up' }),
      ),
      topics.length
        ? el('div', { class: 'matrix' },
            topics.map((topic) => dueRow(topic, confidenceLabels, refresh)))
        : el('div', { class: 'empty-state' }, icon('check-circle'),
            'Nothing is due. Every topic has been rated recently enough to leave alone.'),
    ),
  );
}

function dueRow(topic, labels, refresh) {
  const subject = topic.subject_id ? subjectById(topic.subject_id) : null;
  const node = el('div', { class: 'matrix-row wide' + (topic.overdue ? ' overdue' : '') },
    el('span', { class: 'bar' }),
    el('button', { class: 'name', text: topic.name, onclick: () => topicDialog(topic, refresh) }),
    el('span', { class: 'where', text: [subject?.name, topic.unit].filter(Boolean).join(' · ') || 'Unfiled' }),
    confidenceControl(topic, labels, refresh),
    el('span', { class: 'next' },
      topic.confidence === 0
        ? el('span', { class: 'flag new', text: 'Never rated' })
        : el('span', { class: 'flag over', text: `due ${shortDate(topic.next_due_at)}` }),
    ),
    el('button', {
      class: 'btn icon', title: 'More', 'aria-label': `More for ${topic.name}`,
      onclick: (e) => rowMenu(topic, e.currentTarget, refresh),
    }, icon('dots-three-vertical', { size: 14 })),
  );
  return applyColor(node, subject?.color ?? 'violet');
}

/* ── menus and dialogs ────────────────────────────────────────────────── */

function rowMenu(topic, anchor, refresh) {
  const rect = anchor.getBoundingClientRect();
  openMenu({ x: rect.left, y: rect.bottom + 6 }, [
    { head: topic.name.toUpperCase().slice(0, 30) },
    { icon: 'pencil-simple', label: 'Edit', onSelect: () => topicDialog(topic, refresh) },
    { icon: 'clock-counter-clockwise', label: 'Rating history', onSelect: () => historyDialog(topic) },
    { icon: 'sparkle', label: 'Quiz me on this', onSelect: () => quizDialog({ topicId: topic.id, label: topic.name }) },
    topic.confidence > 0
      ? { icon: 'circle-dashed', label: 'Clear the rating', onSelect: async () => {
          try {
            /* A rating is cleared by rating it at the bottom step, which is the
               honest thing: "I have looked and I do not know this" is a fact
               worth keeping in the history, not an absence. */
            await api.rateTopic(topic.id, 1);
            toast('Back to tomorrow.');
            await refresh();
          } catch (err) { reportError(err); }
        } }
      : null,
    { sep: true },
    { icon: 'trash', label: 'Delete', danger: true, onSelect: async () => {
        if (!await confirmDelete(`“${topic.name}” and every rating it has.`)) return;
        try { await api.deleteTopic(topic.id); await refresh(); } catch (err) { reportError(err); }
      } },
  ]);
}

async function historyDialog(topic) {
  let ratings = [];
  try { ({ ratings } = await api.topicHistory(topic.id)); } catch (err) { reportError(err); return; }

  await dialog({
    title: topic.name,
    confirmLabel: 'Done',
    cancelLabel: 'Close',
    body: el('div', null,
      el('div', { class: 'sub' }, 'Every rating, newest first. The gaps between them are the schedule working.'),
      ratings.length
        ? el('div', { class: 'rows' }, ratings.map((r) => el('div', { class: 'hist-row' },
            el('span', { class: 'when', text: shortDate(r.rated_at) }),
            el('span', { class: 'grow', text: `Rated ${r.confidence} / 5` }),
            el('span', { class: 'in', text: r.next_due_at ? `next ${shortDate(r.next_due_at)}` : '—' }),
          )))
        : el('div', { class: 'muted' }, 'Never rated.'),
    ),
    onConfirm: () => true,
  });
}

/** New topic, or the details of one that exists. The rating is not editable here. */
async function topicDialog(topic, refresh) {
  const name = el('input', { class: 'input', value: topic?.name ?? '', autofocus: true, placeholder: 'Rates of reaction' });
  const subject = dropdown({ class: 'input' },
    el('option', { value: '', text: 'No subject', selected: !topic?.subject_id }),
    state.subjects.map((s) => el('option', { value: s.id, text: s.name, selected: topic?.subject_id === s.id })),
  );
  const unit = el('input', { class: 'input', value: topic?.unit ?? '', placeholder: 'Paper 1 · Module 3' });
  const notes = el('textarea', { class: 'input', rows: 3, placeholder: 'What to look at when this comes round' });
  notes.value = topic?.notes ?? '';

  await dialog({
    title: topic ? 'Edit topic' : 'New topic',
    confirmLabel: topic ? 'Save' : 'Add',
    body: el('div', { class: 'dialog-form' },
      el('div', { class: 'field' }, el('label', { text: 'Topic' }), name),
      el('div', { class: 'field' }, el('label', { text: 'Subject' }), subject),
      el('div', { class: 'field' }, el('label', { text: 'Unit or paper' }), unit),
      el('div', { class: 'field' }, el('label', { text: 'Notes' }), notes),
      topic
        ? el('div', { class: 'sub' }, topic.next_due_at
            ? `Rated ${topic.confidence} / 5, next due ${shortDate(topic.next_due_at)}.`
            : 'Not rated yet, so it counts as due.')
        : el('div', { class: 'sub' }, 'A new topic starts unrated, which puts it straight on the due list.'),
    ),
    onConfirm: async () => {
      const title = name.value.trim();
      if (!title) { toast('Give the topic a name.'); return false; }
      const body = {
        name: title,
        subjectId: subject.value || null,
        unit: unit.value.trim() || null,
        notes: notes.value.trim() || null,
      };
      try {
        if (topic) await api.updateTopic(topic.id, body);
        else await api.createTopic(body);
        await refresh();
        return true;
      } catch (err) { reportError(err); return false; }
    },
  });
}

/**
 * The way a matrix actually gets filled: a specification is already a list, so
 * paste it and let every line become a topic. Bullet marks and numbering are
 * stripped because that is how specifications are written, and names already
 * present are skipped so the same paste can be repeated after an edit.
 */
async function importDialog(refresh) {
  const subject = dropdown({ class: 'input' },
    el('option', { value: '', text: 'No subject', selected: !filterSubject }),
    state.subjects.map((s) => el('option', { value: s.id, text: s.name, selected: filterSubject === s.id })),
  );
  const unit = el('input', { class: 'input', placeholder: 'Paper 1 · Module 3' });
  const text = el('textarea', { class: 'input', rows: 12, autofocus: true, placeholder: '3.1.1 Atomic structure\n3.1.2 Amount of substance\n3.1.3 Bonding' });
  const count = el('div', { class: 'sub', text: 'Nothing pasted yet.' });
  const tally = () => {
    const n = parseSpec(text.value).length;
    count.textContent = n ? `${plural(n, 'topic')} to add.` : 'Nothing pasted yet.';
  };
  text.addEventListener('input', tally);

  await dialog({
    title: 'Paste a specification',
    confirmLabel: 'Add them',
    wide: true,
    body: el('div', { class: 'dialog-form' },
      el('div', { class: 'field' }, el('label', { text: 'Subject' }), subject),
      el('div', { class: 'field' }, el('label', { text: 'Unit or paper' }), unit),
      el('div', { class: 'field' }, el('label', { text: 'One topic per line' }), text),
      count,
    ),
    onConfirm: async () => {
      const names = parseSpec(text.value);
      if (!names.length) { toast('Paste a list first.'); return false; }
      if (names.length > 500) { toast('That is more than 500 lines — split it in two.'); return false; }
      try {
        const { created, skipped } = await api.importTopics({
          subjectId: subject.value || null,
          unit: unit.value.trim() || null,
          names,
        });
        toast(skipped
          ? `Added ${plural(created.length, 'topic')}, skipped ${skipped} already there.`
          : `Added ${plural(created.length, 'topic')}.`);
        await refresh();
        return true;
      } catch (err) { reportError(err); return false; }
    },
  });
}

/** A topic-list pack from a file, into a subject the student picks. */
async function importTopicPack(refresh) {
  const file = await pickDeckFile();
  if (!file) return;
  let pack;
  try {
    if (!isPack(file)) throw new DeckImportError(`“${file.name}” is not a .studexpack file.`);
    pack = await readPackFile(file);
    if (pack.type !== 'topics') throw new DeckImportError(`“${file.name}” is a card deck. Import it from Flashcards.`);
  } catch (err) {
    if (err instanceof DeckImportError) toast(err.message, 'error');
    else reportError(err);
    return;
  }
  const subject = el('select', { class: 'input', id: 'topic-pack-subject' },
    el('option', { value: '', text: 'No subject' }),
    state.subjects.map((s) => el('option', { value: s.id, text: s.name, selected: filterSubject === s.id })));
  const count = Array.isArray(pack.topics) ? pack.topics.length : 0;
  await dialog({
    title: `Import “${pack.title ?? file.name}”`,
    confirmLabel: 'Add them',
    body: el('div', { class: 'dialog-form' },
      el('div', { class: 'muted', text: `${plural(count, 'topic')}. Any you already have are skipped.` }),
      el('div', { class: 'field' }, el('label', { for: 'topic-pack-subject', text: 'Subject' }), subject),
    ),
    onConfirm: async () => {
      try {
        const { imported } = await api.importPack({ pack, subjectId: subject.value || undefined });
        toast(imported.skipped
          ? `Added ${plural(imported.created, 'topic')}, skipped ${imported.skipped} already there.`
          : `Added ${plural(imported.created, 'topic')}.`);
        await refresh();
        return true;
      } catch (err) { reportError(err); return false; }
    },
  });
}

/** Lines into topic names: trim, drop the bullet or the numbering, drop blanks. */
export function parseSpec(raw) {
  const seen = new Set();
  const names = [];
  for (const line of raw.split('\n')) {
    const name = line
      .replace(/^[\s•‣◦⁃*\-–—]+/, '')
      .replace(/^\(?[0-9]+(\.[0-9]+)*\)?[.)]?\s+/, '')
      .trim()
      .slice(0, 160);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}
