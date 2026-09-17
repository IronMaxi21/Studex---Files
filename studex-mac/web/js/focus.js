/**
 * Focus: a timer that takes over the screen when asked to, and gets out of the
 * way when it is not.
 *
 * One session at a time, owned here rather than by any page, so the countdown
 * carries on while the student moves between their notes. The server keeps the
 * authoritative elapsed time; this side only draws the countdown between
 * transitions. Breaks are local — nothing is logged for time spent not
 * studying.
 */
import { el, svg, icon, mount } from './dom.js';
import { api } from './api.js';
import { state, toast, reportError } from './store.js';
import { mmss } from './format.js';

const PREFS_KEY = 'studex.focus-prefs';

export const FOCUS_DEFAULTS = {
  minutes: 25,
  breakMinutes: 5,
  cycles: 4,
  blur: true,
  blurStrength: 18,    // px
  dim: 35,             // % of the page colour laid over Studex
  hideSidebar: true,
  autoContinue: false, // start the next block when a break ends
  subjectId: '',
};

export function focusPrefs() {
  try { return { ...FOCUS_DEFAULTS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { return { ...FOCUS_DEFAULTS }; }
}

export function setFocusPrefs(patch) {
  const next = { ...focusPrefs(), ...patch };
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* this sitting only */ }
  if (phase === 'idle') cycle = { index: 1, total: next.cycles };
  applyLook();
  emit();
  return next;
}

/* ── state ─────────────────────────────────────────────────────────────── */

let session = null;
let syncedAt = 0;
let baseRemaining = 0;
let phase = 'idle';          // idle | focus | break | between
let breakEndsAt = 0;
let cycle = { index: 1, total: focusPrefs().cycles };
let expanded = false;
let ticker = null;
let busy = false;
/** What this run of blocks is for: a goal and the calendar block it answers, kept across its blocks. */
let plan = { goal: '', eventId: null };
/** The last session that ended with a goal nobody has said was met. */
let askGoal = null;
/** Today's calendar study blocks, for linking a run to one. */
let blocks = [];
const listeners = new Set();

export function onFocusChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { for (const fn of listeners) { try { fn(focusState()); } catch { /* one listener is not all of them */ } } drawChrome(); }

export function remainingSeconds() {
  if (phase === 'break') return Math.max(0, Math.round((breakEndsAt - Date.now()) / 1000));
  if (!session) return focusPrefs().minutes * 60;
  const running = session.status === 'running';
  return Math.max(0, Math.round(baseRemaining - (running ? (Date.now() - syncedAt) / 1000 : 0)));
}

export function focusState() {
  return { session, phase, cycle, expanded, remaining: remainingSeconds(), prefs: focusPrefs() };
}

function adopt(next) {
  session = next && next.status !== 'completed' && next.status !== 'abandoned' ? next : null;
  syncedAt = Date.now();
  baseRemaining = session?.remaining_seconds ?? 0;
  if (session) {
    if (session.goal) plan = { goal: session.goal, eventId: session.event_id };
    phase = 'focus';
    cycle = { index: session.cycle_index ?? cycle.index, total: session.cycle_total ?? cycle.total };
  }
}

async function act(fn) {
  if (busy) return;
  busy = true;
  try { await fn(); } catch (err) { reportError(err); } finally { busy = false; emit(); }
}

/** Picks up a session left running, from another window or before a reload. */
export async function initFocus() {
  try {
    const { session: active } = await api.activeSession();
    adopt(active);
  } catch { /* no timer is a fine thing to show */ }
  applyLook();
  startTicker();
  emit();
  void loadBlocks();
}

async function loadBlocks() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  try {
    blocks = (await api.todaysPlan(start.getTime(), start.getTime() + 86_400_000)).blocks ?? [];
  } catch { blocks = []; }
}

/**
 * Sets what the next run is for. Linking a calendar block takes its subject
 * and, when no goal was typed, its title as the goal.
 */
export function setFocusPlan({ block: given, ...next }) {
  plan = { ...plan, ...next };
  if (given && !blocks.some((b) => b.id === given.id)) blocks = [...blocks, given];
  if (next.eventId) {
    const block = blocks.find((b) => b.id === next.eventId);
    if (block?.subject_id) setFocusPrefs({ subjectId: block.subject_id });
    if (block && !plan.goal) plan.goal = block.title;
  }
  emit();
}

async function answerGoal(met) {
  const asked = askGoal;
  askGoal = null;
  emit();
  if (!asked) return;
  try {
    await api.markSessionGoal(asked.id, met);
    toast(met ? 'Goal met. Logged against the subject.' : 'Logged. The time still counts.');
  } catch (err) { reportError(err); }
}

export function startFocus(overrides = {}) {
  const prefs = focusPrefs();
  const minutes = overrides.minutes ?? prefs.minutes;
  const index = overrides.cycleIndex ?? (phase === 'between' || phase === 'break' ? cycle.index : 1);
  return act(async () => {
    const res = await api.startSession({
      plannedMinutes: minutes,
      cycleIndex: Math.min(20, index),
      cycleTotal: Math.min(20, prefs.cycles),
      subjectId: prefs.subjectId || undefined,
      eventId: plan.eventId || undefined,
      goal: plan.goal.trim() || undefined,
    });
    askGoal = null;
    adopt(res.session);
  });
}

export const pauseFocus = () => session && act(async () => adopt((await api.pauseSession(session.id)).session));
export const resumeFocus = () => session && act(async () => adopt((await api.resumeSession(session.id)).session));

export function endFocus({ completed = false } = {}) {
  if (phase === 'break' || phase === 'between') {
    phase = 'idle';
    cycle = { index: 1, total: focusPrefs().cycles };
    plan = { goal: '', eventId: null };
    emit();
    return Promise.resolve();
  }
  if (!session) return Promise.resolve();
  const ending = session;
  return act(async () => {
    await api.endSession(ending.id, completed ? 'completed' : undefined);
    session = null;
    const prefs = focusPrefs();
    if (completed && cycle.index < cycle.total) {
      phase = 'break';
      breakEndsAt = Date.now() + prefs.breakMinutes * 60_000;
      cycle = { ...cycle, index: cycle.index + 1 };
      toast(`Focus block done. ${prefs.breakMinutes} minute break.`);
    } else {
      phase = 'idle';
      cycle = { index: 1, total: prefs.cycles };
      if (ending.goal) {
        askGoal = { id: ending.id, goal: ending.goal };
        plan = { goal: '', eventId: null };
        toast(`Did you finish “${ending.goal}”?`, { action: { label: 'Yes', onSelect: () => answerGoal(true) } });
      } else {
        toast(completed ? 'All focus blocks done. Well studied.' : 'Session logged.');
        if (completed) setExpanded(false);
      }
    }
  });
}

export const skipBreak = () => { if (phase === 'break') { phase = 'between'; emit(); } };

function startTicker() {
  if (ticker) return;
  ticker = setInterval(() => {
    if (!state.user) return;
    if (phase === 'focus' && session?.status === 'running' && remainingSeconds() <= 0 && !busy) {
      void endFocus({ completed: true });
      return;
    }
    if (phase === 'break' && Date.now() >= breakEndsAt) {
      phase = 'between';
      toast('Break over.');
      if (focusPrefs().autoContinue) { void startFocus(); return; }
      emit();
      return;
    }
    if (phase !== 'idle') updateReadouts();
  }, 500);
}

/* ── chrome: the overlay and the pill ─────────────────────────────────── */

let overlay = null;
let pill = null;

export function openFocus() { setExpanded(true); }
export function toggleFocus() { setExpanded(!expanded); }

function setExpanded(value) {
  expanded = value;
  applyLook();
  emit();
  if (expanded) requestAnimationFrame(() => overlay?.querySelector('.focus-primary')?.focus());
}

function applyLook() {
  const prefs = focusPrefs();
  const root = document.documentElement;
  root.style.setProperty('--focus-blur', prefs.blur ? `${prefs.blurStrength}px` : '0px');
  root.style.setProperty('--focus-dim', `${prefs.dim}%`);
  const running = phase !== 'idle';
  document.body.classList.toggle('focus-open', expanded);
  document.body.classList.toggle('focus-running', running);
  document.body.classList.toggle('focus-hide-sidebar', running && prefs.hideSidebar);
}

const RING = 2 * Math.PI * 120;

function updateReadouts() {
  const left = remainingSeconds();
  const total = phase === 'break' ? focusPrefs().breakMinutes * 60 : (session?.planned_minutes ?? focusPrefs().minutes) * 60;
  document.querySelectorAll('[data-focus-time]').forEach((node) => { node.textContent = mmss(left); });
  document.querySelectorAll('[data-focus-ring]').forEach((node) => {
    const r = Number(node.getAttribute('r'));
    const c = 2 * Math.PI * r;
    node.setAttribute('stroke-dasharray', String(c));
    node.setAttribute('stroke-dashoffset', String(c * (1 - (total ? Math.max(0, left) / total : 0))));
  });
}

function ring(size, radius, stroke) {
  return svg('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, 'aria-hidden': 'true', class: 'focus-ring' },
    svg('circle', { cx: size / 2, cy: size / 2, r: radius, fill: 'none', class: 'track', 'stroke-width': stroke }),
    svg('circle', { cx: size / 2, cy: size / 2, r: radius, fill: 'none', class: 'arc' + (phase === 'break' ? ' break' : ''), 'stroke-width': stroke, 'stroke-linecap': 'round', 'data-focus-ring': '', 'stroke-dasharray': RING }),
  );
}

function drawChrome() {
  if (!state.user) { overlay?.remove(); pill?.remove(); overlay = pill = null; return; }
  const running = phase !== 'idle';
  if (expanded) {
    if (!overlay) {
      overlay = el('div', { class: 'focus-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Focus' });
      overlay.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); setExpanded(false); } });
      overlay.addEventListener('mousedown', (event) => { if (event.target === overlay && running) setExpanded(false); });
      document.body.append(overlay);
    }
    mount(overlay, overlayBody());
  } else if (overlay) {
    const leaving = overlay;
    overlay = null;
    leaving.classList.add('leaving');
    setTimeout(() => leaving.remove(), 220);
  }

  if (running && !expanded) {
    if (!pill) { pill = el('div', { class: 'focus-pill' }); document.body.append(pill); }
    mount(pill, pillBody());
  } else if (pill) { pill.remove(); pill = null; }
  updateReadouts();
}

function pillBody() {
  const paused = session?.status === 'paused';
  return [
    el('button', { class: 'focus-pill-main', title: 'Open focus (⌘⇧F)', onclick: () => setExpanded(true) },
      ring(26, 10, 3),
      el('span', { class: 'focus-pill-label', text: phase === 'break' ? 'Break' : phase === 'between' ? 'Ready' : paused ? 'Paused' : 'Focus' }),
      phase === 'between' ? null : el('span', { class: 'focus-pill-time', 'data-focus-time': '' }),
    ),
    phase === 'focus'
      ? el('button', { class: 'focus-pill-btn', title: paused ? 'Resume' : 'Pause', onclick: () => (paused ? resumeFocus() : pauseFocus()) }, icon(paused ? 'play' : 'pause', { size: 14 }))
      : phase === 'between'
        ? el('button', { class: 'focus-pill-btn', title: 'Start next block', onclick: () => startFocus() }, icon('play', { size: 14 }))
        : null,
  ];
}

function overlayBody() {
  const prefs = focusPrefs();
  const paused = session?.status === 'paused';
  const subject = state.subjects?.find((s) => s.id === (session?.subject_id ?? prefs.subjectId));

  const eyebrow = phase === 'break' ? 'BREAK'
    : phase === 'between' ? `READY FOR BLOCK ${cycle.index} OF ${cycle.total}`
    : phase === 'focus' ? `FOCUS · BLOCK ${cycle.index} OF ${cycle.total}${paused ? ' · PAUSED' : ''}`
    : 'FOCUS';

  const presets = el('div', { class: 'focus-presets' }, [15, 25, 45, 60, 90].map((m) => el('button', {
    class: 'focus-chip' + (prefs.minutes === m ? ' on' : ''), text: `${m} min`,
    onclick: () => setFocusPrefs({ minutes: m }),
  })));

  const stepper = (label, key, min, max, step, unit) => el('div', { class: 'focus-stepper' },
    el('span', { text: label }),
    el('button', { title: `Less ${label.toLowerCase()}`, onclick: () => setFocusPrefs({ [key]: Math.max(min, prefs[key] - step) }) }, icon('minus', { size: 12 })),
    el('b', { text: `${prefs[key]}${unit}` }),
    el('button', { title: `More ${label.toLowerCase()}`, onclick: () => setFocusPrefs({ [key]: Math.min(max, prefs[key] + step) }) }, icon('plus', { size: 12 })),
  );

  const subjectPicker = el('select', {
    class: 'focus-select', 'aria-label': 'Subject',
    onchange: (event) => setFocusPrefs({ subjectId: event.target.value }),
  }, el('option', { value: '', text: 'No subject' }),
    (state.subjects ?? []).map((s) => el('option', { value: s.id, text: s.name, selected: s.id === prefs.subjectId })));

  const goalInput = el('input', {
    class: 'focus-goal', id: 'focus-goal', maxlength: 200, value: plan.goal,
    placeholder: 'Goal for this session — e.g. finish the Organic deck', 'aria-label': 'Session goal',
    onchange: (event) => setFocusPlan({ goal: event.target.value }),
  });
  const now = Date.now();
  const upcoming = blocks.filter((b) => (b.ends_at ?? b.starts_at + 45 * 60_000) > now);
  const blockPicker = upcoming.length ? el('select', {
    class: 'focus-select', 'aria-label': 'Calendar block',
    onchange: (event) => setFocusPlan({ eventId: event.target.value || null }),
  }, el('option', { value: '', text: 'No calendar block' }),
    upcoming.map((b) => el('option', {
      value: b.id, selected: b.id === plan.eventId,
      text: `${new Date(b.starts_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ${b.title}`,
    }))) : null;
  const goalAsk = askGoal && phase === 'idle' ? el('div', { class: 'focus-goal-ask' },
    el('span', { text: `Did you finish “${askGoal.goal}”?` }),
    el('button', { class: 'focus-chip', text: 'Yes', onclick: () => answerGoal(true) }),
    el('button', { class: 'focus-chip', text: 'Not quite', onclick: () => answerGoal(false) }),
  ) : null;
  const goalLine = phase !== 'idle' && plan.goal ? el('div', { class: 'focus-goal-line' }, icon('target', { size: 14 }), plan.goal) : null;

  const controls = phase === 'idle'
    ? [el('button', { class: 'focus-btn primary focus-primary', onclick: () => startFocus() }, icon('play', { size: 16 }), 'Start focus')]
    : phase === 'between'
      ? [el('button', { class: 'focus-btn primary focus-primary', onclick: () => startFocus() }, icon('play', { size: 16 }), `Start block ${cycle.index}`),
         el('button', { class: 'focus-btn', onclick: () => endFocus() }, icon('stop', { size: 16 }), 'Stop here')]
      : phase === 'break'
        ? [el('button', { class: 'focus-btn primary focus-primary', onclick: () => { skipBreak(); void startFocus(); } }, icon('skip-forward', { size: 16 }), 'Skip break'),
           el('button', { class: 'focus-btn', onclick: () => endFocus() }, icon('stop', { size: 16 }), 'Stop')]
        : [el('button', { class: 'focus-btn primary focus-primary', onclick: () => (paused ? resumeFocus() : pauseFocus()) }, icon(paused ? 'play' : 'pause', { size: 16 }), paused ? 'Resume' : 'Pause'),
           el('button', { class: 'focus-btn', title: 'Finish this block now and log it', onclick: () => endFocus({ completed: true }) }, icon('check', { size: 16 }), 'Done'),
           el('button', { class: 'focus-btn', title: 'Stop and log the time so far', onclick: () => endFocus() }, icon('stop', { size: 16 }), 'Stop')];

  const look = el('div', { class: 'focus-look' },
    el('label', { class: 'focus-toggle' },
      el('input', { type: 'checkbox', checked: prefs.blur, onchange: (e) => setFocusPrefs({ blur: e.target.checked }) }), 'Blur Studex'),
    el('input', {
      type: 'range', min: 2, max: 40, value: prefs.blurStrength, disabled: !prefs.blur, 'aria-label': 'Blur strength',
      oninput: (e) => { document.documentElement.style.setProperty('--focus-blur', `${e.target.value}px`); },
      onchange: (e) => setFocusPrefs({ blurStrength: Number(e.target.value) }),
    }),
    el('label', { class: 'focus-toggle', text: 'Dim' }),
    el('input', {
      type: 'range', min: 0, max: 90, value: prefs.dim, 'aria-label': 'Dim',
      oninput: (e) => { document.documentElement.style.setProperty('--focus-dim', `${e.target.value}%`); },
      onchange: (e) => setFocusPrefs({ dim: Number(e.target.value) }),
    }),
    el('label', { class: 'focus-toggle' },
      el('input', { type: 'checkbox', checked: prefs.hideSidebar, onchange: (e) => setFocusPrefs({ hideSidebar: e.target.checked }) }), 'Hide sidebar'),
    el('label', { class: 'focus-toggle' },
      el('input', { type: 'checkbox', checked: prefs.autoContinue, onchange: (e) => setFocusPrefs({ autoContinue: e.target.checked }) }), 'Auto-start next block'),
  );

  return el('div', { class: 'focus-panel' },
    el('div', { class: 'focus-top' },
      el('span', { class: 'focus-eyebrow', text: eyebrow }),
      el('button', { class: 'focus-icon', title: phase === 'idle' ? 'Close' : 'Minimise — the timer keeps running', onclick: () => setExpanded(false) }, icon(phase === 'idle' ? 'x' : 'arrows-in-simple', { size: 16 })),
    ),
    el('div', { class: 'focus-dial' },
      ring(280, 120, 8),
      el('div', { class: 'focus-readout' },
        el('span', { class: 'focus-time', 'data-focus-time': '' }),
        el('span', { class: 'focus-sub', text: phase === 'break' ? 'Stand up, look away' : subject ? subject.name : phase === 'idle' ? 'Ready when you are' : 'Deep work' }),
      ),
    ),
    el('div', { class: 'focus-cycles' }, Array.from({ length: cycle.total }, (_, i) => el('span', {
      class: 'focus-dot' + (i + 1 < cycle.index ? ' done' : i + 1 === cycle.index && phase !== 'idle' ? ' current' : ''),
    }))),
    goalAsk,
    goalLine,
    phase === 'idle' ? goalInput : null,
    phase === 'idle' ? presets : null,
    phase === 'idle' ? el('div', { class: 'focus-settings-row' },
      stepper('Break', 'breakMinutes', 1, 30, 1, 'm'),
      stepper('Blocks', 'cycles', 1, 12, 1, ''),
      subjectPicker,
      blockPicker,
    ) : null,
    el('div', { class: 'focus-controls' }, controls),
    look,
    el('div', { class: 'focus-hint', text: 'Esc to minimise · ⌘⇧F to bring back' }),
  );
}
