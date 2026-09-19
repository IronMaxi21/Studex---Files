/** Screen 01 — Home. Dashboard, tonight's plan, focus timer, deadlines. */
import { openRevisionPlan } from '../revision-plan.js';
import { el, svg, icon, mount, applyColor, colorValue, folderGlyph } from '../dom.js';
import { api } from '../api.js';
import { state, toast, reportError, homeLayout, setHomeLayout, childFolders, filesInFolder, folderById } from '../store.js';
import { navigate } from '../router.js';
import { topbar } from '../shell.js';
import { rollNumber } from '../celebrate.js';
import { focusState, onFocusChange, startFocus, pauseFocus, resumeFocus, endFocus, skipBreak, openFocus, setFocusPlan } from '../focus.js';
import {
  greeting, relative, eventWhen, shortDate, mmss, duration, countdown,
  clockTime, startOfDay, plural, bytes, FILE_ICON, FILE_LABEL,
} from '../format.js';

/** 2πr for the 39px dial radius the design specifies. */
const DIAL_CIRCUMFERENCE = 245;

export async function homeView(route, host) {
  const dayStart = startOfDay(Date.now());
  const dayEnd = dayStart + 24 * 60 * 60 * 1000 - 1;

  const [home, plan, needs, today] = await Promise.all([
    api.home(),
    api.todaysPlan(dayStart, dayEnd).catch(() => ({ blocks: [] })),
    api.statsNeedsWork().then((r) => r.needs_work).catch(() => null),
    // The repeating week laid over today's date. A timetable nobody has filled
    // in yet answers with nothing, which the panel says in one line.
    api.lessonsBetween(dayStart, dayEnd).then((r) => r.lessons).catch(() => []),
  ]);

  const timer = focusTimer();
  // Both hold a selection, so like the timer they are built once and moved
  // rather than redrawn: re-arranging the dashboard must not throw away the
  // file someone is reading or the folder they opened.
  const preview = previewPanel(home);
  const library = libraryPanel(home.storage);

  // Each dashboard panel, drawn on demand so re-arranging redraws without a
  // refetch. The timer is the exception — it owns a live session, so it is
  // built once and only re-parented.
  const panels = {
    continue: () => panel('continue', 'CONTINUE',
      continueGrid(home.pinned_files.length ? home.pinned_files : home.recent_files)),
    today: () => panel('today', 'TODAY', lessonList(today)),
    preview: () => panel('preview', 'PREVIEW', preview.node, { wide: true }),
    library: () => panel('library', 'LIBRARY', library.node, { wide: true }),
    needs: () => panel('needs', 'NEEDS WORK', needsList(needs)),
    plan: () => panel('plan', "TONIGHT'S PLAN", planList(plan.blocks)),
    timer: () => panel('timer', 'FOCUS TIMER', timer.node),
    deadlines: () => panel('deadlines', 'DEADLINES', deadlineList(home.deadlines, home.exam_readiness)),
  };

  const panelsHost = el('div', { class: 'home-panels' });

  function renderPanels() {
    const shown = homeLayout().filter((item) => item.visible);
    if (!shown.length) {
      mount(panelsHost, el('div', { class: 'empty-state' }, icon('squares-four'),
        el('div', { text: 'Every panel is hidden.' }),
        el('button', { class: 'btn', type: 'button', text: 'Choose panels', onclick: () => navigate('settings/home') })));
      return;
    }
    mount(panelsHost, shown.map((item) => panels[item.id]()));
  }
  renderPanels();

  // Which panels show, and in what order, is a setting — so it lives in
  // Settings with every other setting, not as a mode the dashboard drops into.
  const arrangeBtn = el('button', {
    class: 'chip', title: 'Choose which panels Home shows',
    onclick: () => navigate('settings/home'),
  }, icon('squares-four'), el('span', { text: 'Customise' }));

  const content = el('div', { class: 'content' },
    el('div', { class: 'page-head home-head' },
      el('div', { class: 'page-title', text: `${greeting()}, ${firstName(home.user.display_name)}` }),
      home.next_exam
        ? el('div', { class: 'note', text: `${countdown(home.next_exam.days_until)} to ${home.next_exam.title}` })
        : null,
      clock(),
    ),

    el('div', { class: 'home-stats' },
      el('div', { class: 'figure lead' },
        el('div', { class: 'kicker', text: 'NEXT EXAM' }),
        el('div', { class: 'value', text: home.next_exam?.title ?? 'None scheduled' }),
        el('div', { class: 'sub', text: home.next_exam ? eventWhen(home.next_exam.starts_at, home.next_exam.all_day) : 'Add one from Create' }),
        home.next_exam
          ? el('button', {
            class: 'link-btn home-plan-link', type: 'button',
            onclick: async () => { if (await openRevisionPlan(home.next_exam)) homeView(route, host); },
          }, icon('calendar-check', { size: 13 }), ' Plan revision')
          : null,
      ),
      el('div', { class: 'figure' },
        el('div', { class: 'kicker', text: 'CARDS DUE' }),
        el('div', { class: 'value' }, countUp('due', home.cards_due, 650)),
        el('div', { class: 'sub', text: `across ${deckCount()} ${deckCount() === 1 ? 'deck' : 'decks'}` }),
      ),
      el('div', { class: 'figure' },
        el('div', { class: 'kicker', text: 'TONIGHT' }),
        el('div', { class: 'value', text: plan.blocks.length ? duration(plannedMinutes(plan.blocks)) : '—' }),
        el('div', { class: 'sub', text: `${plan.blocks.length} ${plan.blocks.length === 1 ? 'block' : 'blocks'} planned` }),
      ),
      el('div', { class: 'figure' },
        el('div', { class: 'kicker', text: 'STREAK' }),
        el('div', { class: 'value' },
          el('span', { class: 'home-streak-flame' + (home.streak_days ? ' lit' : '') }, icon('flame', { size: 18, bold: Boolean(home.streak_days) })),
          streakValue(home.streak_days),
          home.streak_days === 1 ? ' day' : ' days'),
        weekLine(home),
      ),
    ),

    panelsHost,
  );

  mount(host, topbar(['Home'],
    arrangeBtn,
    el('button', { class: 'chip', title: 'Notifications' }, icon('bell')),
    { bare: true }), content);

  return timer.dispose;
}

/**
 * A dashboard panel: a labelled section holding one widget.
 *
 * A wide panel takes two columns of the grid wherever the window has two to
 * give; below that width every panel is the full width anyway.
 */
function panel(id, label, body, { wide = false } = {}) {
  return el('section', { class: 'home-panel' + (wide ? ' wide' : ''), 'data-panel': id },
    el('header', { class: 'home-panel-head' }, el('span', { class: 'section-label plain', text: label })),
    el('div', { class: 'home-panel-body col' }, body),
  );
}

/** What each panel is called, wherever it is listed. */
export const HOME_PANEL_LABELS = {
  continue: 'Continue',
  today: "Today's lessons",
  preview: 'Preview',
  library: 'Library',
  needs: 'Needs work',
  plan: "Tonight's plan",
  timer: 'Focus timer',
  deadlines: 'Deadlines',
};

/**
 * The dashboard as re-orderable rows. Home shows this inline under Arrange;
 * Settings shows the same list, so the two cannot drift apart.
 */
export function homeArrangeRows(onChange) {
  const layout = homeLayout();
  return layout.map((item, i) => arrangeRow(item, i, layout, onChange));
}

/** One row of the Arrange list: name, a visibility toggle, and move up/down. */
function arrangeRow(item, index, layout, rerenderPanels) {
  const label = HOME_PANEL_LABELS[item.id];
  const move = (delta) => {
    const next = [...layout];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setHomeLayout(next);
    rerenderPanels();
  };
  const setVisible = (visible) => {
    setHomeLayout(layout.map((p) => (p.id === item.id ? { ...p, visible } : p)));
    rerenderPanels();
  };
  return el('div', { class: 'arrange-row' + (item.visible ? '' : ' off') },
    icon('dots-six-vertical', { class: 'grip' }),
    el('span', { class: 'grow', text: label }),
    el('button', {
      class: 'btn icon', disabled: index === 0, title: 'Move up', 'aria-label': `Move ${label} up`,
      onclick: () => move(-1),
    }, icon('arrow-up', { size: 13 })),
    el('button', {
      class: 'btn icon', disabled: index === layout.length - 1, title: 'Move down', 'aria-label': `Move ${label} down`,
      onclick: () => move(1),
    }, icon('arrow-down', { size: 13 })),
    el('button', {
      class: 'btn icon', title: item.visible ? 'Hide' : 'Show', 'aria-label': `${item.visible ? 'Hide' : 'Show'} ${label}`,
      onclick: () => setVisible(!item.visible),
    }, icon(item.visible ? 'eye' : 'eye-slash', { size: 13 })),
  );
}

/**
 * The date and the time, at the end of the greeting.
 *
 * A dashboard that opens with "Tonight" and "3 days to the exam" is talking
 * about a today it never names, and the machine's own clock is behind whatever
 * window Studex is in front of. It ticks on the minute rather than the second:
 * a seconds hand on a revision screen is a thing to watch instead of working.
 *
 * The timer stops itself once the node has left the page, so moving between
 * screens does not leave one running per visit.
 */
function clock() {
  const date = el('span', { class: 'date' });
  const time = el('span', { class: 'time' });
  const node = el('div', { class: 'home-clock' }, date, el('span', { class: 'sep', text: '·' }), time);

  const tick = () => {
    const now = new Date();
    date.textContent = now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
    time.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  };
  tick();

  // Line up with the minute, then keep to it — an interval started at an
  // arbitrary moment shows the wrong minute for up to fifty-nine seconds.
  let every = null;
  const align = setTimeout(() => {
    tick();
    every = setInterval(() => {
      if (!node.isConnected) { clearInterval(every); return; }
      tick();
    }, 60_000);
  }, 60_000 - (Date.now() % 60_000));
  const stop = setInterval(() => {
    if (node.isConnected) return;
    clearTimeout(align);
    if (every) clearInterval(every);
    clearInterval(stop);
  }, 60_000);

  return node;
}

function firstName(name) { return (name ?? '').trim().split(/\s+/)[0] || 'there'; }
function deckCount() { return state.files.filter((f) => f.kind === 'deck').length; }
function plannedMinutes(blocks) {
  return blocks.reduce((sum, b) => sum + (b.ends_at ? (b.ends_at - b.starts_at) / 60000 : 45), 0);
}

function continueGrid(files) {
  if (!files.length) {
    return el('div', { class: 'empty-state' }, icon('folder-open'), 'Nothing open yet. Use Create to start something.');
  }
  return el('div', { class: 'file-grid tight' }, files.slice(0, 6).map(fileCard));
}

/**
 * The Home face of the "Needs work" panel: the hardest cards up front, then the
 * two or three shakiest topics, each a way straight into a session on exactly
 * those. Statistics carries the fuller picture; here it is a nudge.
 */
function needsList(needs) {
  const has = needs && (needs.lapse_total || needs.weak_topics.length || needs.behind_subjects.length);
  if (!has) {
    return el('div', { class: 'empty-state' }, icon('check-circle'),
      'Nothing flagged. Keep the streak going.');
  }
  return el('div', { class: 'needs-work' },
    needs.lapse_total
      ? el('button', {
          class: 'row needs-lead', onclick: () => navigate('deck/all/study/needs'),
        },
          icon('play'),
          el('span', { class: 'grow', text: `Your ${needs.lapse_total} hardest cards` }),
        )
      : null,
    needs.weak_topics.length
      ? el('div', { class: 'rows' }, needs.weak_topics.slice(0, 3).map((t) => el('button', {
          class: 'row',
          onclick: () => navigate('deck/all/study/topic/' + encodeURIComponent(t.name)),
        },
          el('span', { class: 'grow', text: t.name }),
          el('span', { class: 'dim', text: 'shaky' }),
        )))
      : null,
  );
}

export function fileCard(file) {
  const meta = file.kind === 'pdf' && file.annotation_count
    ? `PDF · ${plural(file.annotation_count, 'note')}`
    : file.kind === 'deck'
      ? `${plural(file.card_count, 'card')}${file.due_count ? ` · ${file.due_count} due` : ''}`
      : `${FILE_LABEL[file.kind]} · ${relative(file.updated_at)}`;

  const node = el('button', {
    class: 'file-card',
    onclick: () => navigate(`${file.kind}/${file.id}`),
  },
    icon(FILE_ICON[file.kind] ?? 'file'),
    el('div', { class: 'name', text: file.title }),
    el('div', { class: 'meta', text: meta }),
  );
  return applyColor(node, file.effective_color);
}

function planList(blocks) {
  if (!blocks.length) {
    return el('div', { class: 'plan-row', style: { justifyContent: 'center', color: 'var(--color-neutral-600)' } },
      'No study blocks scheduled for today.');
  }
  const now = Date.now();
  return el('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
    blocks.map((block) => {
      const active = block.starts_at <= now && (block.ends_at ?? block.starts_at + 45 * 60000) > now;
      const mins = block.ends_at ? Math.round((block.ends_at - block.starts_at) / 60000) : null;
      const startBlock = () => {
        setFocusPlan({ eventId: block.id, block });
        openFocus();
      };
      return el('button', {
        class: 'plan-row' + (active ? ' now' : ''),
        title: active ? 'Start a focus session for this block' : undefined,
        onclick: active ? startBlock : () => navigate('calendar'),
      },
        el('span', { class: 'time', text: clockTime(block.starts_at) }),
        el('span', { text: block.title }),
        active ? icon('play', { class: 'go' }) : el('span', { class: 'len', text: mins ? `${mins}m` : '' }),
      );
    }),
  );
}

/**
 * Today's timetable, from the repeating A/B week.
 *
 * A student's day is already decided by the time they open Studex, so the
 * dashboard says what it is rather than making them go and look. The lesson
 * happening now is marked; the ones already over are dimmed but kept, because
 * "what have I had today" is half of what this panel is for. Pressing one goes
 * to the subject it belongs to, or to the timetable when it belongs to none.
 */
function lessonList(lessons) {
  if (!lessons.length) {
    return el('div', { class: 'empty-state' }, icon('calendar-blank'),
      el('div', { text: 'No lessons today.' }),
      el('button', { class: 'btn', type: 'button', text: 'Set up your timetable', onclick: () => navigate('timetable') }));
  }
  const now = Date.now();
  const ordered = [...lessons].sort((a, b) => a.starts_at - b.starts_at);
  return el('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
    ordered.map((lesson) => {
      const active = lesson.starts_at <= now && lesson.ends_at > now;
      const done = lesson.ends_at <= now;
      const where = [lesson.room, lesson.teacher].filter(Boolean).join(' · ');
      return el('button', {
        class: 'plan-row' + (active ? ' now' : ''),
        style: done ? { opacity: '.55' } : null,
        title: where ? `${lesson.subject} — ${where}` : lesson.subject,
        onclick: () => navigate(lesson.subject_id ? `topics/${lesson.subject_id}` : 'timetable'),
      },
        el('span', { class: 'time', text: clockTime(lesson.starts_at) }),
        // The subject's own colour, the same dot the timetable grid uses, so a
        // day reads as a run of colours before any of the words are read.
        el('span', { class: 'lesson-dot', style: { background: colorValue(lesson.color) } }),
        el('span', { class: 'grow', text: lesson.subject }),
        where ? el('span', { class: 'len', text: where }) : null,
      );
    }),
  );
}

function deadlineList(deadlines, readiness) {
  if (!deadlines.length) {
    return el('div', { class: 'empty-state' }, icon('calendar-check'), 'No deadlines coming up.');
  }
  const byId = new Map(readiness.map((r) => [r.event_id, r]));
  return el('div', { class: 'rows' },
    deadlines.map((event, i) => {
      const state_ = byId.get(event.id);
      const label = state_
        ? state_.readiness === 'ready' ? 'Ready' : state_.readiness === 'behind' ? 'Behind' : 'On track'
        : event.kind === 'deadline' ? 'Drafting' : 'On track';
      return el('button', { class: 'row' + (i === 0 ? ' soon' : ''), onclick: () => navigate('calendar') },
        el('span', { class: 'date', text: shortDate(event.starts_at) }),
        el('span', { class: 'grow', text: event.title }),
        el('span', { class: 'pill ' + (label === 'Ready' ? 'ready' : label === 'Behind' ? 'behind' : ''), text: label }),
      );
    }),
  );
}

/* ── preview ──────────────────────────────────────────────────────────── */

/** How many files the rail offers. Past this it stops being a glance. */
const PREVIEW_FILES = 7;

/**
 * A file read without opening it.
 *
 * Home already knew which files were worth coming back to and said nothing
 * about what was in them, so every check meant opening a note to find the one
 * paragraph you half-remembered. This shows it in place: the first lines of a
 * note, the first cards of a deck, the passages marked in a PDF, a small
 * drawing of a canvas. One request per file, kept once fetched, so moving
 * along the rail and back is instant.
 */
function previewPanel(home) {
  const seen = new Set();
  const files = [...home.pinned_files, ...home.recent_files]
    .filter((f) => (seen.has(f.id) ? false : seen.add(f.id)))
    .slice(0, PREVIEW_FILES);

  const node = el('div', { class: 'preview-panel' });
  if (!files.length) {
    mount(node, el('div', { class: 'empty-state' }, icon('file-dashed'),
      'Nothing to preview yet. Anything you make shows up here.'));
    return { node };
  }

  const cache = new Map();
  const rail = el('div', { class: 'preview-rail' });
  const pane = el('div', { class: 'preview-pane' });
  let current = null;
  /** Only the newest request may draw: a fast rail outruns the network. */
  let request = 0;

  function drawRail() {
    mount(rail, files.map((file) => applyColor(el('button', {
      class: 'preview-tab' + (file.id === current ? ' on' : ''),
      title: file.title,
      onclick: () => select(file.id),
      ondblclick: () => navigate(`${file.kind}/${file.id}`),
    },
      icon(FILE_ICON[file.kind] ?? 'file', { size: 13 }),
      el('span', { class: 'grow', text: file.title }),
    ), file.effective_color)));
  }

  async function select(id) {
    current = id;
    drawRail();
    if (cache.has(id)) { mount(pane, previewBody(cache.get(id))); return; }
    const mine = ++request;
    mount(pane, el('div', { class: 'preview-loading' }, icon('circle-notch'), 'Reading…'));
    try {
      const preview = await api.filePreview(id);
      cache.set(id, preview);
      if (mine === request) mount(pane, previewBody(preview));
    } catch {
      if (mine === request) {
        mount(pane, el('div', { class: 'empty-state' }, icon('warning-circle'),
          'That file could not be read just now.'));
      }
    }
  }

  mount(node, rail, pane);
  select(files[0].id);
  return { node };
}

/** The line under a preview's title: what this file is, in its own terms. */
function previewMeta(preview) {
  const file = preview.file;
  const edited = `edited ${relative(file.updated_at)}`;
  if (preview.doc) return `${plural(preview.doc.words, 'word')} · ${edited}`;
  if (preview.deck) {
    const due = preview.deck.due ? ` · ${preview.deck.due} due` : '';
    return `${plural(preview.deck.total, 'card')}${due} · ${edited}`;
  }
  if (preview.pdf) {
    const pages = preview.pdf.page_count ? `${plural(preview.pdf.page_count, 'page')} · ` : '';
    return `${pages}${plural(preview.pdf.annotations, 'note')} · ${edited}`;
  }
  if (preview.canvas) {
    const ink = preview.canvas.ink_strokes ? ` · ${plural(preview.canvas.ink_strokes, 'stroke')}` : '';
    return `${plural(preview.canvas.objects, 'object')}${ink} · ${edited}`;
  }
  return `${FILE_LABEL[file.kind]} · ${edited}`;
}

function previewBody(preview) {
  const file = preview.file;
  const body = preview.doc ? docPreview(preview.doc)
    : preview.deck ? deckPreview(preview.deck)
      : preview.pdf ? pdfPreview(preview.pdf)
        : preview.canvas ? canvasPreview(preview.canvas)
          : el('div', { class: 'empty-state' }, icon('file'), 'Nothing to show.');

  return el('div', { class: 'preview-inner' },
    el('div', { class: 'preview-head' },
      icon(FILE_ICON[file.kind] ?? 'file', { size: 15, class: 'preview-kind' }),
      el('div', { class: 'grow' },
        el('div', { class: 'preview-name', text: file.title }),
        el('div', { class: 'preview-meta', text: previewMeta(preview) }),
      ),
      el('button', {
        class: 'btn', onclick: () => navigate(`${file.kind}/${file.id}`),
      }, 'Open', icon('arrow-right', { size: 13 })),
    ),
    body,
  );
}

function docPreview(doc) {
  if (!doc.lines.length) {
    return el('div', { class: 'empty-state' }, icon('note-pencil'), 'This note is still empty.');
  }
  return el('div', { class: 'doc-preview' },
    doc.lines.map((line) => el('div', {
      class: `pl ${line.type}` + (line.type === 'heading' ? ` h${line.level ?? 1}` : '') + (line.done ? ' done' : ''),
      style: line.indent ? { paddingLeft: `${Math.min(line.indent, 4) * 14}px` } : null,
    },
      line.type === 'todo' ? icon(line.done ? 'check-square' : 'square', { size: 12 }) : null,
      line.type === 'bullet' ? el('span', { class: 'dot' }) : null,
      el('span', { text: line.text }),
    )),
    doc.truncated ? el('div', { class: 'pl more', text: '⋯' }) : null,
  );
}

function deckPreview(deck) {
  if (!deck.cards.length) {
    return el('div', { class: 'empty-state' }, icon('cards'), 'No cards in this deck yet.');
  }
  return el('div', { class: 'deck-preview' },
    el('div', { class: 'deck-stats' },
      deck.due ? el('span', { class: 'pill behind', text: `${deck.due} due` }) : null,
      deck.new ? el('span', { class: 'pill', text: `${deck.new} new` }) : null,
      deck.known ? el('span', { class: 'pill ready', text: `${deck.known} known` }) : null,
      deck.shaky ? el('span', { class: 'pill', text: `${deck.shaky} shaky` }) : null,
    ),
    el('div', { class: 'rows' }, deck.cards.map((card) => el('div', { class: 'card-row' },
      el('span', { class: 'front', text: card.front }),
      el('span', { class: 'back', text: card.back }),
    ))),
    deck.total > deck.cards.length
      ? el('div', { class: 'dim small', text: `and ${deck.total - deck.cards.length} more` })
      : null,
  );
}

function pdfPreview(pdf) {
  if (!pdf.highlights.length) {
    return el('div', { class: 'empty-state' }, icon('highlighter'),
      pdf.annotations ? 'Marked up, but nothing quoted yet.' : 'Nothing highlighted yet.');
  }
  return el('div', { class: 'pdf-preview' },
    pdf.highlights.map((h) => el('div', { class: 'quote-row' },
      el('span', { class: 'page', text: `p${h.page}` }),
      el('span', { class: 'grow' },
        el('span', { class: 'quote', text: h.quote || '—' }),
        h.note ? el('span', { class: 'note-line', text: h.note }) : null,
      ),
    )),
    pdf.annotations > pdf.highlights.length
      ? el('div', { class: 'dim small', text: `and ${pdf.annotations - pdf.highlights.length} more marks` })
      : null,
  );
}

/**
 * A canvas at thumbnail size.
 *
 * The server sends the shapes already thinned and the extent they cover, so
 * the whole board fits whatever box this panel happens to be, and the strokes
 * stay hairlines however far it is scaled down.
 */
function canvasPreview(canvas) {
  if (!canvas.bounds || !canvas.shapes.length) {
    return el('div', { class: 'empty-state' }, icon('infinity'), 'This canvas is empty.');
  }
  const { x, y, width, height } = canvas.bounds;
  const pad = Math.max(16, Math.max(width, height) * 0.03);
  const shapes = canvas.shapes.map((shape) => {
    const stroke = colorValue(shape.color);
    if (shape.points?.length) {
      return svg('polyline', {
        points: shape.points.map((p) => `${p[0]},${p[1]}`).join(' '),
        fill: 'none', stroke, 'stroke-width': 1.6, 'stroke-linecap': 'round',
        'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke',
      });
    }
    if (!shape.width || !shape.height) return null;
    return svg('rect', {
      x: shape.x, y: shape.y, width: shape.width, height: shape.height,
      rx: shape.type === 'note' || shape.type === 'flashcard' ? 8 : 2,
      fill: shape.fill ? colorValue(shape.fill) : stroke,
      'fill-opacity': shape.fill ? 0.5 : shape.type === 'frame' ? 0.04 : 0.16,
      stroke, 'stroke-width': 1.2, 'vector-effect': 'non-scaling-stroke',
    });
  });

  return el('div', { class: 'canvas-preview' + (canvas.background === 'plain' ? '' : ' dotted') },
    svg('svg', {
      class: 'canvas-mini', 'aria-hidden': 'true',
      viewBox: `${x - pad} ${y - pad} ${width + pad * 2} ${height + pad * 2}`,
      preserveAspectRatio: 'xMidYMid meet',
    }, shapes),
    canvas.truncated ? el('span', { class: 'canvas-more', text: 'part of the board' }) : null,
  );
}

/* ── library ──────────────────────────────────────────────────────────── */

const LIBRARY_FOLDERS = 4;
const LIBRARY_FILES = 5;

/**
 * A corner of the library, on Home.
 *
 * Enough of a folder to recognise it and step into it, not a second Library
 * screen: the folders across the top, what is inside underneath, and the way
 * through to the real thing at the bottom. Everything here is already loaded,
 * so moving between folders costs nothing.
 */
function libraryPanel(storage) {
  const node = el('div', { class: 'library-panel' });
  let folderId = null;

  function open(id) { folderId = id; draw(); }

  function draw() {
    const roots = childFolders(null);
    const folder = folderId ? folderById(folderId) : null;
    if (folderId && !folder) { folderId = null; }

    const folders = childFolders(folderId);
    const files = folderId
      ? filesInFolder(folderId)
      : state.files.filter((f) => !f.folder_id);

    const chips = el('div', { class: 'library-chips' },
      el('button', {
        class: 'chip' + (folderId === null ? ' on' : ''), onclick: () => open(null),
      }, icon('books', { size: 13 }), 'All'),
      roots.slice(0, LIBRARY_FOLDERS).map((f) => el('button', {
        class: 'chip' + (folderId === f.id ? ' on' : ''), title: f.name, onclick: () => open(f.id),
      }, folderGlyph(f.effective_color, { size: 13 }), el('span', { text: f.name }))),
    );

    const rows = [
      ...folders.slice(0, LIBRARY_FOLDERS).map((f) => el('button', {
        class: 'row', onclick: () => open(f.id),
      },
        folderGlyph(f.effective_color, { size: 15 }),
        el('span', { class: 'grow', text: f.name }),
        el('span', { class: 'dim', text: plural(f.file_count, 'file') }),
      )),
      ...files.slice(0, LIBRARY_FILES).map((f) => applyColor(el('button', {
        class: 'row file', onclick: () => navigate(`${f.kind}/${f.id}`),
      },
        icon(FILE_ICON[f.kind] ?? 'file', { size: 14 }),
        el('span', { class: 'grow', text: f.title }),
        el('span', { class: 'dim', text: relative(f.updated_at) }),
      ), f.effective_color)),
    ];

    const hidden = Math.max(0, folders.length - LIBRARY_FOLDERS) + Math.max(0, files.length - LIBRARY_FILES);

    mount(node,
      chips,
      folder
        ? el('div', { class: 'library-crumb' },
          el('button', { class: 'home-link', onclick: () => open(folder.parent_id) },
            icon('caret-left', { size: 12 }), folder.parent_id ? folderById(folder.parent_id)?.name ?? 'Back' : 'All'),
          el('span', { class: 'dim', text: folder.name }))
        : null,
      rows.length
        ? el('div', { class: 'rows' }, rows)
        : el('div', { class: 'empty-state' }, icon('folder-open'),
          folder ? 'This folder is empty.' : 'Nothing at the top level yet.'),
      el('div', { class: 'library-foot' },
        storage
          ? el('span', { class: 'dim', title: `${(storage.used_fraction * 100).toFixed(1)}% of your storage used` },
            `${bytes(storage.used_bytes)} of ${bytes(storage.quota_bytes)}`)
          : el('span'),
        hidden ? el('span', { class: 'dim', text: `${hidden} more` }) : null,
        el('button', {
          class: 'home-link', onclick: () => navigate(folderId ? `folder/${folderId}` : 'library'),
        }, 'Open in Library', icon('arrow-right', { size: 12 })),
      ),
    );
  }

  draw();
  return { node };
}

/* ── focus timer ──────────────────────────────────────────────────────── */

/**
 * A window onto the shared focus timer (focus.js). The session lives there so
 * it keeps counting while the student leaves Home; this card only draws it.
 */
function focusTimer() {
  const node = el('div', { class: 'timer' });
  let readout = null;
  let setArc = () => {};
  let lastKey = '';

  const arcFor = (arc, remaining, total) => {
    arc.setAttribute('stroke-dashoffset', String(DIAL_CIRCUMFERENCE * (1 - Math.max(0, remaining) / Math.max(1, total))));
  };

  function draw(fs) {
    const { session, phase, cycle, prefs } = fs;
    const key = `${phase}|${session?.id}|${session?.status}|${cycle.index}|${prefs.minutes}|${prefs.breakMinutes}`;
    if (key === lastKey && readout) { readout.textContent = mmss(fs.remaining); setArc(fs.remaining); return; }
    lastKey = key;

    if (phase === 'idle') { readout = null; mount(node, idle(prefs)); return; }

    const total = phase === 'break' ? prefs.breakMinutes * 60 : (session?.planned_minutes ?? prefs.minutes) * 60;
    readout = el('span', { class: 't', text: mmss(fs.remaining) });
    const arc = svg('circle', {
      cx: 44, cy: 44, r: 39, fill: 'none', stroke: phase === 'break' ? 'var(--color-accent-300)' : 'var(--color-accent)',
      'stroke-width': 4, 'stroke-linecap': 'round', 'stroke-dasharray': DIAL_CIRCUMFERENCE,
    });
    setArc = (remaining) => arcFor(arc, remaining, total);
    setArc(fs.remaining);

    const status = phase === 'break' ? 'BREAK' : phase === 'between' ? 'READY' : session?.status === 'paused' ? 'PAUSED' : 'LEFT';
    const title = phase === 'break' ? 'On a break' : phase === 'between' ? 'Break over' : session?.file_id
      ? state.files.find((f) => f.id === session.file_id)?.title ?? 'Focus'
      : 'Focus';

    const buttons = phase === 'focus'
      ? [session.status === 'running'
          ? el('button', { class: 'btn primary', onclick: () => pauseFocus() }, icon('pause'), 'Pause')
          : el('button', { class: 'btn primary', onclick: () => resumeFocus() }, icon('play'), 'Resume'),
        el('button', { class: 'btn icon', title: 'End session', onclick: () => endFocus() }, icon('stop'))]
      : phase === 'break'
        ? [el('button', { class: 'btn primary', onclick: () => skipBreak() }, icon('skip-forward'), 'Skip break')]
        : [el('button', { class: 'btn primary', onclick: () => startFocus() }, icon('play'), 'Next block'),
           el('button', { class: 'btn icon', title: 'Stop', onclick: () => endFocus() }, icon('stop'))];

    mount(node,
      el('div', { class: 'top' },
        el('div', { class: 'dial' },
          svg('svg', { viewBox: '0 0 88 88', width: 88, height: 88, 'aria-hidden': 'true' },
            svg('circle', { cx: 44, cy: 44, r: 39, fill: 'none', stroke: 'var(--color-neutral-900)', 'stroke-width': 4 }),
            arc,
          ),
          el('div', { class: 'readout' }, readout, el('span', { class: 'l', text: status })),
        ),
        el('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', minWidth: '0' } },
          el('div', { style: { font: '500 13.5px/1.35 var(--font-heading)' } },
            title,
            el('span', { class: 'dim', style: { fontWeight: '400', fontSize: '11.5px', marginLeft: '8px' }, text: `block ${cycle.index} of ${cycle.total}` }),
          ),
          el('div', { class: 'muted', style: { fontSize: '11.5px', lineHeight: '1.5' } },
            `${session?.planned_minutes ?? prefs.minutes} min focus · ${prefs.breakMinutes} min break`),
          el('div', { style: { display: 'flex', gap: '7px', marginTop: '2px' } },
            ...buttons,
            el('button', { class: 'btn icon', title: 'Full screen focus (⌘⇧F)', onclick: () => openFocus() }, icon('arrows-out-simple')),
          ),
        ),
      ),
      el('div', { class: 'cycles' },
        Array.from({ length: cycle.total }, (_, i) => el('span', {
          class: 'cycle-dot' + (i + 1 < cycle.index ? ' done' : i + 1 === cycle.index ? ' current' : ''),
        })),
      ),
    );
  }

  function idle(prefs) {
    return el('div', { class: 'top', style: { flexDirection: 'column', alignItems: 'stretch', gap: '12px' } },
      el('div', { style: { font: '500 13.5px/1.35 var(--font-heading)' } }, 'No session running'),
      el('div', { class: 'muted', style: { fontSize: '11.5px' } }, `${prefs.minutes} min focus · ${prefs.breakMinutes} min break · ${prefs.cycles} blocks`),
      el('div', { style: { display: 'flex', gap: '7px' } },
        el('button', { class: 'btn primary', onclick: () => { startFocus(); } }, icon('play'), 'Start focus'),
        el('button', { class: 'btn', onclick: () => openFocus() }, icon('arrows-out-simple'), 'Focus mode'),
      ),
    );
  }

  draw(focusState());
  const off = onFocusChange(draw);
  const tick = setInterval(() => draw(focusState()), 1000);
  return { node, dispose: () => { off(); clearInterval(tick); } };
}

/** Hours this week — against the weekly goal when one is set — and any banked freezes. */
function weekLine(home) {
  const week = home.week;
  const freezes = home.streak_freezes ?? 0;
  const freezeNote = freezes
    ? el('span', { class: 'home-freezes', title: `${freezes} streak ${freezes === 1 ? 'freeze' : 'freezes'} banked — a missed day spends one` },
      icon('snowflake', { size: 12 }), ` ${freezes}`)
    : null;
  if (!week?.goal_minutes) {
    return el('div', { class: 'sub' }, `${home.hours_this_week.toFixed(1)}h this week`, freezeNote ? ' · ' : null, freezeNote);
  }
  const hours = (m) => `${(m / 60).toFixed(m % 60 ? 1 : 0)}h`;
  return el('div', { class: 'sub home-week' },
    el('span', null, week.met ? `Weekly goal met · ${hours(week.minutes)}` : `${hours(week.minutes)} of ${hours(week.goal_minutes)} this week`),
    freezeNote ? ' · ' : null, freezeNote,
    el('div', { class: 'home-week-bar' + (week.met ? ' met' : ''), role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': week.pct ?? 0 },
      el('span', { style: { width: `${week.pct ?? 0}%` } })));
}

/**
 * Figures count up from zero the first time home is drawn in a session, and
 * sit still after.
 *
 * Once, deliberately: home is redrawn whenever a panel is rearranged or a plan
 * is saved, and a number that counted up every time would be a fidget rather
 * than an arrival. Small numbers are left alone — counting to two is not worth
 * watching.
 */
const rolled = new Set();
function countUp(key, value, ms = 800) {
  const node = el('span', { text: String(value) });
  if (!rolled.has(key) && value > 2) {
    rolled.add(key);
    requestAnimationFrame(() => rollNumber(node, 0, value, ms));
  }
  return node;
}

function streakValue(days) { return countUp('streak', days); }
