/** Screen 01 — Home. Dashboard, tonight's plan, focus timer, deadlines. */
import { openRevisionPlan } from '../revision-plan.js';
import { el, svg, icon, mount, applyColor } from '../dom.js';
import { api } from '../api.js';
import { state, toast, reportError, homeLayout, setHomeLayout } from '../store.js';
import { navigate } from '../router.js';
import { topbar } from '../shell.js';
import { rollNumber } from '../celebrate.js';
import { focusState, onFocusChange, startFocus, pauseFocus, resumeFocus, endFocus, skipBreak, openFocus, setFocusPlan } from '../focus.js';
import {
  greeting, relative, eventWhen, shortDate, mmss, duration, countdown,
  clockTime, startOfDay, plural, FILE_ICON, FILE_LABEL,
} from '../format.js';

/** 2πr for the 39px dial radius the design specifies. */
const DIAL_CIRCUMFERENCE = 245;

export async function homeView(route, host) {
  const dayStart = startOfDay(Date.now());
  const dayEnd = dayStart + 24 * 60 * 60 * 1000 - 1;

  const [home, plan, needs] = await Promise.all([
    api.home(),
    api.todaysPlan(dayStart, dayEnd).catch(() => ({ blocks: [] })),
    api.statsNeedsWork().then((r) => r.needs_work).catch(() => null),
  ]);

  const timer = focusTimer();

  // Each dashboard panel, drawn on demand so re-arranging redraws without a
  // refetch. The timer is the exception — it owns a live session, so it is
  // built once and only re-parented.
  const panels = {
    continue: () => panel('continue', 'CONTINUE',
      continueGrid(home.pinned_files.length ? home.pinned_files : home.recent_files)),
    needs: () => panel('needs', 'NEEDS WORK', needsList(needs)),
    plan: () => panel('plan', "TONIGHT'S PLAN", planList(plan.blocks)),
    timer: () => panel('timer', 'FOCUS TIMER', timer.node),
    deadlines: () => panel('deadlines', 'DEADLINES', deadlineList(home.deadlines, home.exam_readiness)),
  };

  let arranging = false;
  const panelsHost = el('div', { class: 'home-panels' });

  function renderPanels() {
    const layout = homeLayout();
    panelsHost.classList.toggle('arranging', arranging);
    if (arranging) {
      mount(panelsHost, layout.map((item, i) => arrangeRow(item, i, layout, renderPanels)));
      return;
    }
    const shown = layout.filter((item) => item.visible);
    if (!shown.length) {
      mount(panelsHost, el('div', { class: 'empty-state' }, icon('squares-four'),
        'Every panel is hidden. Use Arrange to bring one back.'));
      return;
    }
    mount(panelsHost, shown.map((item) => panels[item.id]()));
  }
  renderPanels();

  const arrangeBtn = el('button', { class: 'chip', title: 'Arrange dashboard' },
    icon('squares-four'), el('span', { text: 'Arrange' }));
  arrangeBtn.onclick = () => {
    arranging = !arranging;
    arrangeBtn.classList.toggle('on', arranging);
    renderPanels();
  };

  const content = el('div', { class: 'content' },
    el('div', { class: 'page-head' },
      el('div', { class: 'page-title', text: `${greeting()}, ${firstName(home.user.display_name)}` }),
      home.next_exam
        ? el('div', { class: 'note', text: `${countdown(home.next_exam.days_until)} to ${home.next_exam.title}` })
        : null,
    ),

    el('div', { class: 'stat-grid' },
      el('div', { class: 'stat lead' },
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
      el('div', { class: 'stat' },
        el('div', { class: 'kicker', text: 'CARDS DUE' }),
        el('div', { class: 'value', text: String(home.cards_due) }),
        el('div', { class: 'sub', text: `across ${deckCount()} ${deckCount() === 1 ? 'deck' : 'decks'}` }),
      ),
      el('div', { class: 'stat' },
        el('div', { class: 'kicker', text: 'TONIGHT' }),
        el('div', { class: 'value', text: plan.blocks.length ? duration(plannedMinutes(plan.blocks)) : '—' }),
        el('div', { class: 'sub', text: `${plan.blocks.length} ${plan.blocks.length === 1 ? 'block' : 'blocks'} planned` }),
      ),
      el('div', { class: 'stat' },
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

/** A dashboard panel: a labelled section holding one widget. */
function panel(id, label, body) {
  return el('div', { class: 'col home-panel', 'data-panel': id },
    el('span', { class: 'section-label plain', text: label }),
    body,
  );
}

/** One row of the Arrange list: name, a visibility toggle, and move up/down. */
function arrangeRow(item, index, layout, rerenderPanels) {
  const label = { continue: 'Continue', needs: 'Needs work', plan: "Tonight's plan", timer: 'Focus timer', deadlines: 'Deadlines' }[item.id];
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

function firstName(name) { return (name ?? '').trim().split(/\s+/)[0] || 'there'; }
function deckCount() { return state.files.filter((f) => f.kind === 'deck').length; }
function plannedMinutes(blocks) {
  return blocks.reduce((sum, b) => sum + (b.ends_at ? (b.ends_at - b.starts_at) / 60000 : 45), 0);
}

function continueGrid(files) {
  if (!files.length) {
    return el('div', { class: 'empty-state' }, icon('folder-open'), 'Nothing open yet. Use Create to start something.');
  }
  return el('div', { class: 'file-grid tight' }, files.slice(0, 3).map(fileCard));
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

/** The streak rolls up from zero the first time home is drawn in a session, and sits still after. */
let streakRolled = false;
function streakValue(days) {
  const node = el('span', { text: String(days) });
  if (!streakRolled && days > 1) {
    streakRolled = true;
    requestAnimationFrame(() => rollNumber(node, 0, days, 800));
  }
  return node;
}
