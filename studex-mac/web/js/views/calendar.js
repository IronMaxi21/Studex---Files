/**
 * Screen 04 — Calendar: a revision timetable that happens to hold the rest of
 * a life as well.
 *
 * Everything with a date on it lands here — revision blocks, exams, deadlines,
 * the repeating school timetable and personal things like a birthday or a shift
 * — because revision is only plannable against what the week already contains.
 * The strands are coloured by kind and each can be taken out of sight from the
 * legend, so the same screen answers "when am I free?" and "what is coming?".
 */
import { el, icon, mount, applyColor } from '../dom.js';
import { api } from '../api.js';
import { navigate } from '../router.js';
import { topbar, subnav } from '../shell.js';
import { openMenu } from '../menu.js';
import { subjectById } from '../store.js';
import { clockTime, eventWhen, shortDate, countdown, startOfDay, EVENT_ICON } from '../format.js';
import { addEvent, eventColor, eventMenu, KINDS } from './events.js';
import {
  weekGrid, weekControls, currentWeekStart,
  dayGrid, dayControls, currentDayStart, setDayStart,
  lessonEvents, lessonMenu, dropToRevise,
} from './timetable.js';

const DOW = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const DAY_MS = 86400000;

/** Anchor month, kept across re-renders so paging does not reset on refresh. */
let cursor = null;
let selectedDay = null;

/**
 * Which strands are currently out of sight.
 *
 * Kept at module scope so the choice survives paging through months and moving
 * between month, week and day: someone who has hidden lessons to find a free
 * evening should not have to hide them again on every click.
 */
const hidden = new Set();

/** Timetabled lessons are a pattern rather than stored events, so they get a pseudo-kind. */
function kindOf(event) {
  return event.lesson ? 'lesson' : event.kind;
}

function shown(event) {
  return !hidden.has(kindOf(event));
}

const KIND_COLOR = new Map(KINDS.map((k) => [k.id, k.color]));

/* Shorter than the labels on the event form, because a legend is read sideways. */
const LEGEND = [
  { id: 'study_block', label: 'Revision' },
  { id: 'exam', label: 'Exams' },
  { id: 'deadline', label: 'Deadlines' },
  { id: 'lesson', label: 'Lessons' },
  { id: 'class', label: 'Classes' },
  { id: 'personal', label: 'Personal' },
  { id: 'event', label: 'Other' },
].map((k) => ({ ...k, color: KIND_COLOR.get(k.id) ?? 'sky' }));

function kindCounts(events) {
  const counts = new Map();
  for (const event of events) {
    const key = kindOf(event);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * The filter bar under the sub-navigation.
 *
 * A count next to each kind doubles as the week's shape at a glance — four
 * revision blocks against eleven lessons is a different week from the reverse.
 * Kinds with nothing in range still show, greyed, so the row does not reflow as
 * you page through months.
 */
function kindLegend(counts, refresh) {
  return el('div', { class: 'cal-legend' },
    LEGEND.map((kind) => {
      const count = counts.get(kind.id) ?? 0;
      const off = hidden.has(kind.id);
      const node = el('button', {
        class: 'legend-chip' + (off ? ' off' : '') + (count ? '' : ' none'),
        title: off ? `Show ${kind.label.toLowerCase()}` : `Hide ${kind.label.toLowerCase()}`,
        'aria-pressed': String(!off),
        onclick: () => {
          if (off) hidden.delete(kind.id);
          else hidden.add(kind.id);
          refresh();
        },
      },
        el('span', { class: 'dot' }),
        el('span', { text: kind.label }),
        count ? el('span', { class: 'n', text: String(count) }) : null,
      );
      return applyColor(node, kind.color);
    }),
    hidden.size
      ? el('button', { class: 'link-label', text: 'Show everything', onclick: () => { hidden.clear(); refresh(); } })
      : null,
  );
}

/** One click on anything dated, whichever of the two things it turns out to be. */
function openThing(event, e, refresh) {
  e.stopPropagation();
  if (event.lesson) lessonMenu(event.lesson, e.clientX, e.clientY, refresh);
  else eventMenu(event, e.clientX, e.clientY, refresh);
}

export async function calendarView(route, host) {
  // Bare `calendar` is the day, because the day is what a school morning
  // actually asks of this screen. Month is a step back from it, not the way in.
  const mode = route.path[1] ?? 'day';
  if (mode === 'week') return weekView(route, host);
  if (mode === 'month') return monthView(route, host);
  if (mode === 'deadlines') return deadlinesView(route, host);
  return dayView(route, host);
}

/* ── month ────────────────────────────────────────────────────────────── */

async function monthView(route, host) {
  const now = new Date();
  if (!cursor) cursor = new Date(now.getFullYear(), now.getMonth(), 1);
  if (selectedDay === null) selectedDay = startOfDay(Date.now());

  const gridStart = mondayBefore(new Date(cursor.getFullYear(), cursor.getMonth(), 1));
  const gridEnd = gridStart + 42 * DAY_MS;

  const [{ events: booked }, { events: upcoming }, lessons, { topics: due }] = await Promise.all([
    api.events({ from: gridStart, to: gridEnd, limit: 1000 }),
    api.upcoming(5),
    lessonEvents(gridStart, gridEnd - 1),
    api.topics({ due: 'true', limit: 200 }),
  ]);

  const all = [...lessons, ...booked];
  const counts = kindCounts(all);
  const events = all.filter(shown);

  const byDay = new Map();
  for (const event of events) {
    const key = startOfDay(event.starts_at);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(event);
  }
  for (const list of byDay.values()) list.sort((a, b) => a.starts_at - b.starts_at);

  const refresh = () => monthView(route, host);

  const grid = el('div', { class: 'cal-grid' });
  for (let i = 0; i < 42; i += 1) {
    const dayStart = gridStart + i * DAY_MS;
    const date = new Date(dayStart);
    const inMonth = date.getMonth() === cursor.getMonth();
    const isToday = dayStart === startOfDay(Date.now());
    const weekend = date.getDay() === 0 || date.getDay() === 6;
    const dayEvents = byDay.get(dayStart) ?? [];

    grid.appendChild(dropToRevise(el('button', {
      class: ['cal-cell', weekend ? 'weekend' : '', inMonth ? '' : 'outside', isToday ? 'today' : ''].filter(Boolean).join(' '),
      onclick: () => { selectedDay = dayStart; refresh(); },
      oncontextmenu: (event) => {
        event.preventDefault();
        openMenu({ x: event.clientX, y: event.clientY }, [
          { icon: 'plus', label: 'Add event here', onSelect: () => addEvent(dayStart + 18 * 3600000, refresh) },
          { icon: 'calendar-dot', label: 'Open this day', onSelect: () => { setDayStart(dayStart); navigate('calendar/day'); } },
        ]);
      },
    },
      el('div', { class: 'num' },
        isToday ? el('span', { class: 'dot', text: String(date.getDate()) }) : String(date.getDate()),
        isToday ? 'Today' : null,
      ),
      ...dayEvents.slice(0, 3).map((event) => eventChip(event, refresh)),
      dayEvents.length > 3 ? el('span', { class: 'dim', style: { fontSize: '10.5px' }, text: `+${dayEvents.length - 3} more` }) : null,
    // A drop on a day with no time to it means the early evening, when most
    // revision actually happens.
    ), () => dayStart + 17 * 3600000, refresh));
  }

  const dayEvents = (byDay.get(selectedDay) ?? []);

  mount(host,
    topbar(['Calendar', 'Month'],
      el('button', { class: 'chip', onclick: () => addEvent(selectedDay + 18 * 3600000, refresh) }, icon('plus'), 'New event'),
    ),
    subnav('calendar', 'calendar/month',
      el('span', { class: 'week-label', text: cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) }),
      el('button', { class: 'btn icon', title: 'Previous month', onclick: () => { cursor = new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1); refresh(); } }, icon('caret-left')),
      el('button', { class: 'btn icon', title: 'Next month', onclick: () => { cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1); refresh(); } }, icon('caret-right')),
      el('button', {
        class: 'btn', text: 'Today',
        onclick: () => { const t = new Date(); cursor = new Date(t.getFullYear(), t.getMonth(), 1); selectedDay = startOfDay(Date.now()); refresh(); },
      }),
    ),
    kindLegend(counts, refresh),
    el('div', { class: 'cal' },
      el('div', { class: 'cal-main' },
        el('div', { class: 'cal-dow' }, DOW.map((d) => el('span', { text: d }))),
        grid,
      ),
      el('div', { class: 'cal-rail' },
        el('button', {
          class: 'section-label plain link-label',
          title: 'Open this day',
          text: new Date(selectedDay).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).toUpperCase(),
          onclick: () => { setDayStart(selectedDay); navigate('calendar/day'); },
        }),
        dayEvents.length
          ? el('div', { style: { display: 'flex', flexDirection: 'column', gap: '9px' } },
              dayEvents.map((event) => dayRow(event, refresh)))
          : el('div', { class: 'dim', style: { fontSize: '12px' } }, 'Nothing scheduled.'),
        el('div', { class: 'rule' }),
        el('button', {
          class: 'section-label plain link-label',
          title: 'Open the topic matrix',
          text: 'DUE FOR REVIEW',
          onclick: () => navigate('topics'),
        }),
        due.length
          ? el('div', { class: 'rows' }, due.slice(0, 6).map((topic) => dueRow(topic)))
          : el('div', { class: 'dim', style: { fontSize: '12px' } }, 'Nothing waiting. Rate a topic to start its clock.'),
        due.length > 6
          ? el('button', { class: 'link-label', text: `and ${due.length - 6} more`, onclick: () => navigate('topics') })
          : null,
        el('div', { class: 'rule' }),
        el('span', { class: 'section-label plain', text: 'NEXT UP' }),
        upcoming.length
          ? el('div', { class: 'rows' }, upcoming.map((event, i) => nextRow(event, i === 0)))
          : el('div', { class: 'dim', style: { fontSize: '12px' } }, 'Nothing on the horizon.'),
      ),
    ),
  );
}

/* ── week ─────────────────────────────────────────────────────────────── */

async function weekView(route, host) {
  const refresh = () => weekView(route, host);
  const from = currentWeekStart();
  const to = from + 7 * DAY_MS;
  const [{ events: booked }, lessons] = await Promise.all([
    api.events({ from, to, limit: 1000 }),
    lessonEvents(from, to - 1),
  ]);
  const all = [...lessons, ...booked];

  mount(host,
    topbar(['Calendar', 'Week'],
      el('button', { class: 'chip', onclick: () => addEvent(from + 18 * 3600000, refresh) }, icon('plus'), 'New event'),
    ),
    subnav('calendar', 'calendar/week', ...weekControls(refresh)),
    kindLegend(kindCounts(all), refresh),
    weekGrid(all.filter(shown), refresh),
  );
}

/* ── day ──────────────────────────────────────────────────────────────── */

async function dayView(route, host) {
  const refresh = () => dayView(route, host);
  const from = currentDayStart();
  const [{ events: booked }, lessons] = await Promise.all([
    api.events({ from, to: from + DAY_MS, limit: 500 }),
    lessonEvents(from, from + DAY_MS - 1),
  ]);
  const all = [...lessons, ...booked];

  mount(host,
    topbar(['Calendar'],
      el('button', { class: 'chip', onclick: () => addEvent(from + 18 * 3600000, refresh) }, icon('plus'), 'New event'),
    ),
    subnav('calendar', 'calendar', ...dayControls(refresh)),
    kindLegend(kindCounts(all), refresh),
    dayGrid(all.filter(shown), refresh),
  );
}

/* ── deadlines ────────────────────────────────────────────────────────── */

async function deadlinesView(route, host) {
  const refresh = () => deadlinesView(route, host);
  const from = startOfDay(Date.now());
  const { events } = await api.events({ from, kinds: 'exam,deadline', limit: 500 });
  const dated = events.slice().sort((a, b) => a.starts_at - b.starts_at);

  mount(host,
    topbar(['Calendar', 'Deadlines'],
      el('button', { class: 'chip', onclick: () => addEvent(from + 18 * 3600000, refresh, { kind: 'deadline' }) }, icon('plus'), 'New deadline'),
    ),
    subnav('calendar', 'calendar/deadlines'),
    el('div', { class: 'content' },
      el('div', { class: 'page-head' },
        el('div', { class: 'page-title', text: 'Deadlines' }),
        el('div', { class: 'note', text: dated.length ? `Next in ${countdown(daysUntil(dated[0].starts_at))}` : 'Nothing on the horizon' }),
      ),
      dated.length
        ? el('div', { class: 'rows' }, dated.map((event) => deadlineRow(event, refresh)))
        : el('div', { class: 'empty-state' }, icon('flag'), 'No exams or deadlines ahead. Add one to start counting down.'),
    ),
  );
}

function daysUntil(ts) {
  return Math.max(0, Math.round((startOfDay(ts) - startOfDay(Date.now())) / DAY_MS));
}

function deadlineRow(event, refresh) {
  const days = daysUntil(event.starts_at);
  const node = el('button', {
    class: 'deadline-row' + (days <= 7 ? ' soon' : ''),
    onclick: (e) => eventMenu(event, e.clientX, e.clientY, refresh),
  },
    el('span', { class: 'date', text: shortDate(event.starts_at) }),
    el('div', { class: 'grow' },
      el('div', { class: 'title', text: event.title }),
      el('div', { class: 'when', text: eventWhen(event.starts_at, event.all_day) + (event.location ? ` · ${event.location}` : '') }),
    ),
    icon(EVENT_ICON[event.kind] ?? 'flag', { class: 'dim', size: 14 }),
    el('span', { class: 'in', text: countdown(days) }),
  );
  return applyColor(node, eventColor(event));
}

/* ── shared pieces ────────────────────────────────────────────────────── */

function mondayBefore(date) {
  const d = new Date(date);
  const shift = (d.getDay() + 6) % 7; // Monday-first weeks, as the design shows
  d.setDate(d.getDate() - shift);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function eventChip(event, refresh) {
  const kind = kindOf(event);
  const label = event.all_day || kind === 'study_block'
    ? event.title
    : `${event.title} · ${clockTime(event.starts_at)}`;

  const node = el('button', {
    class: 'cal-ev'
      + (kind === 'exam' ? ' exam' : '')
      + (kind === 'study_block' ? ' study' : '')
      + (kind === 'lesson' ? ' lesson' : ''),
    title: label,
    text: label,
    onclick: (e) => openThing(event, e, refresh),
  });
  return applyColor(node, eventColor(event));
}

function dayRow(event, refresh) {
  const kind = kindOf(event);
  const node = el('button', {
    class: 'plan-row' + (kind === 'study_block' && isNow(event) ? ' now' : ''),
    onclick: (e) => openThing(event, e, refresh),
  },
    el('span', { class: 'time', text: event.all_day ? 'All day' : clockTime(event.starts_at) }),
    el('span', { class: 'grow', style: { fontSize: '12.5px' }, text: event.title }),
    icon(EVENT_ICON[kind] ?? 'circle', { class: 'dim', size: 13 }),
  );
  return applyColor(node, eventColor(event));
}

/**
 * A topic the matrix says is ready to be looked at again.
 *
 * It sits in the same rail as the day's events on purpose: what to revise this
 * evening is decided by looking at the evening and the backlog together, and
 * the two lists being a rule apart is the whole argument of the screen.
 */
function dueRow(topic) {
  const subject = topic.subject_id ? subjectById(topic.subject_id) : null;
  const node = el('button', {
    class: 'next-row due-row' + (topic.overdue ? ' soon' : ''),
    title: 'Open the topic matrix',
    onclick: () => navigate('topics'),
  },
    el('span', { class: 'bar' }),
    el('div', null,
      el('div', { text: topic.name }),
      el('div', { class: 'when', text: subject?.name ?? topic.unit ?? 'No subject yet' }),
    ),
    el('span', { class: 'in', text: topic.confidence === 0 ? 'New' : 'Due' }),
  );
  return applyColor(node, subject?.color ?? 'violet');
}

function isNow(event) {
  const now = Date.now();
  return event.starts_at <= now && (event.ends_at ?? event.starts_at + 45 * 60000) > now;
}

function nextRow(event, soon) {
  const node = el('button', { class: 'next-row' + (soon ? ' soon' : ''), onclick: () => navigate('calendar/deadlines') },
    el('span', { class: 'bar' }),
    el('div', null,
      el('div', { text: event.title }),
      el('div', { class: 'when', text: eventWhen(event.starts_at, event.all_day) + (event.location ? ` · ${event.location}` : '') }),
    ),
    el('span', { class: 'in', text: `${event.days_until}d` }),
  );
  return applyColor(node, eventColor(event));
}
