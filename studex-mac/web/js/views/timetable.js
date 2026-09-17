/**
 * Screen 05 — Timetable.
 *
 * The school timetable itself, and nothing else: a week A and a week B, laid
 * out as periods down and days across, which is the shape it is printed in and
 * the shape it is remembered in. It is a pattern rather than a diary — nothing
 * in it has a date — so writing a lesson in once puts it in every week from now
 * until it changes.
 *
 * Real days against the clock live in Calendar, which shows the lessons this
 * pattern produces alongside everything else that is happening. The grids that
 * draw them are exported from here, because this is where a lesson is defined.
 */
import { el, icon, mount, applyColor, colorLabel } from '../dom.js';
import { dropdown } from '../select.js';
import { api } from '../api.js';
import { topbar, subnav } from '../shell.js';
import { state, subjectById, toast, reportError } from '../store.js';
import { openMenu } from '../menu.js';
import { dialog, confirmDelete, confirmDialog } from '../dialog.js';
import { clockTime, startOfDay, EVENT_ICON } from '../format.js';
import { addEvent, eventColor, eventMenu } from './events.js';
import { carriesItem, readItem } from '../dnd.js';

const DAY_MS = 86400000;
const HOUR_PX = 44;
const DOW = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

/** How long an event with no end runs, for layout purposes only. */
const ASSUMED_MINUTES = 45;

/** Anchor week (a Monday), kept across re-renders so paging survives refresh. */
let weekStart = null;
/** Anchor day, for the single-day view. Kept for the same reason. */
let dayAnchor = null;

export function mondayOf(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday-first weeks
  return d.getTime();
}

export async function timetableView(route, host) {
  return lessonsView(route, host);
}

/* ── the pattern: week A / week B ─────────────────────────────────────── */

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const LESSON_COLORS = ['accent', 'sky', 'teal', 'lime', 'amber', 'rose', 'violet', 'neutral'];

/** Which of the two weeks is on screen. Null means "whichever one this is". */
let shownWeek = null;
/** Most timetables stop on Friday; the two extra columns are asked for. */
let showWeekend = false;

/**
 * The timetable proper.
 *
 * A header of two weeks, periods down the side, days across the top, and a cell
 * for every lesson. Clicking a cell writes a lesson into it; the same cell in
 * the other week is a different lesson, which is the whole reason the fortnight
 * exists. Nothing here has a date: this is the pattern the term repeats, and the
 * calendar works out which week any particular Monday is.
 */
async function lessonsView(route, host) {
  const refresh = () => lessonsView(route, host);
  const { periods, lessons, weekAStart, currentWeek } = await api.timetable();
  const week = shownWeek ?? currentWeek;
  const tracking = weekAStart !== null && weekAStart !== undefined;

  const mine = lessons.filter((l) => l.week === week);
  const weekend = showWeekend || lessons.some((l) => l.day > 4);
  const days = weekend ? 7 : 5;

  const cells = new Map(mine.map((l) => [`${l.day}:${l.period}`, l]));
  const todayDow = (new Date().getDay() + 6) % 7;
  const markToday = tracking && week === currentWeek && todayDow < days;

  /* One flat grid rather than a row of rows: the day columns have to line up
     down the whole term's worth of periods, and a grid is the only thing that
     keeps them aligned when one period's name is longer than another's. */
  const grid = el('div', { class: 'lesson-grid' },
    el('div', { class: 'lg-corner' }, el('span', { class: 'lg-week-name', text: `WEEK ${week}` })),
    Array.from({ length: days }, (_, d) => el('div', {
      class: 'lg-day' + (markToday && d === todayDow ? ' today' : ''),
      text: DAY_NAMES[d].slice(0, 3).toUpperCase(),
    })),
    periods.map((period) => [
      el('div', { class: 'lg-period' },
        el('span', { class: 'name', text: period.label }),
        el('span', { class: 'when', text: `${period.starts_at}–${period.ends_at}` }),
      ),
      Array.from({ length: days }, (_, d) =>
        lessonCell(cells.get(`${d}:${period.idx}`), week, d, period, refresh, markToday && d === todayDow)),
    ]),
  );
  // The period column's width is the stylesheet's, so a narrow pane can take
  // some of it back for the days.
  grid.style.gridTemplateColumns = `var(--lg-period, 132px) repeat(${days}, minmax(0, 1fr))`;
  grid.style.setProperty('--lg-days', String(days));

  mount(host,
    topbar(['Timetable'],
      el('button', { class: 'chip', onclick: (e) => patternMenu(e.currentTarget, week, weekAStart, refresh) },
        icon('sliders-horizontal'), 'Timetable options'),
    ),
    subnav('timetable', 'timetable',
      weekTabs(week, tracking ? currentWeek : null, refresh),
      el('button', {
        class: 'btn', text: weekend ? 'Hide weekend' : 'Show weekend',
        disabled: lessons.some((l) => l.day > 4),
        title: lessons.some((l) => l.day > 4) ? 'A lesson is filed on a weekend day.' : null,
        onclick: () => { showWeekend = !showWeekend; refresh(); },
      }),
      el('span', {
        class: 'dim', style: { marginLeft: 'auto', fontSize: '12px' },
        text: mine.length
          ? `${mine.length} lesson${mine.length === 1 ? '' : 's'} in week ${week}`
          : 'Click a cell to write in a lesson.',
      }),
    ),
    el('div', { class: 'lesson-grid-scroll' }, grid),
    tracking ? null : el('p', { class: 'dim lg-note' },
      'Studex does not know which week this one is yet, so nothing is marked as today and the calendar treats every week as week A. ',
      el('button', {
        class: 'link-label', text: 'Say which week this is',
        onclick: (e) => patternMenu(e.currentTarget, week, weekAStart, refresh),
      }),
    ),
  );
}

/** The header the section is really about: two weeks, one of them in front. */
function weekTabs(week, currentWeek, refresh) {
  return el('nav', { class: 'seg week-tabs', 'aria-label': 'Week' },
    ['A', 'B'].map((id) => el('button', {
      class: id === week ? 'on' : '',
      'aria-current': id === week ? 'page' : null,
      onclick: () => { shownWeek = id; refresh(); },
    },
      `Week ${id}`,
      id === currentWeek ? el('span', { class: 'tab-now', text: 'this week' }) : null,
    )),
  );
}

function lessonCell(lesson, week, day, period, refresh, isToday) {
  if (!lesson) {
    return el('button', {
      class: 'lg-cell empty' + (isToday ? ' today' : ''),
      'aria-label': `Add a lesson — ${DAY_NAMES[day]}, ${period.label}, week ${week}`,
      onclick: () => lessonDialog(null, { week, day, period: period.idx }, refresh),
    }, icon('plus', { size: 12 }));
  }

  const node = el('button', {
    class: 'lg-cell' + (isToday ? ' today' : ''),
    title: `${lesson.subject}${lesson.room ? ` · ${lesson.room}` : ''}${lessonTeacher(lesson) ? ` · ${lessonTeacher(lesson)}` : ''}`,
    onclick: () => lessonDialog(lesson, { week, day, period: period.idx }, refresh),
    oncontextmenu: (e) => { e.preventDefault(); lessonMenu(lesson, e.clientX, e.clientY, refresh); },
  },
    el('span', { class: 'name', text: lesson.subject }),
    lesson.room ? el('span', { class: 'where', text: lesson.room }) : null,
    lessonTeacher(lesson) ? el('span', { class: 'who', text: lessonTeacher(lesson) }) : null,
  );
  return applyColor(node, lessonColor(lesson));
}

/** The Studex subject a lesson is, by its link or failing that by its name. */
function lessonSubject(lesson) {
  if (lesson.subject_id) return subjectById(lesson.subject_id);
  const name = (lesson.subject ?? '').trim().toLowerCase();
  return name ? state.subjects.find((s) => s.name.trim().toLowerCase() === name) ?? null : null;
}

function lessonTeacher(lesson) {
  return lesson.teacher || lessonSubject(lesson)?.teacher || null;
}

/**
 * A lesson's own colour, or the colour the rest of that subject's work uses.
 *
 * A subject made without a colour is stored as the plain accent, while the
 * student sees it as the colour of the folder it is set on — so the folder's
 * colour is the subject's colour whenever the subject has none of its own.
 */
function lessonColor(lesson) {
  if (lesson.color) return lesson.color;
  const subject = lessonSubject(lesson);
  if (!subject) return 'accent';
  if (subject.color && subject.color !== 'accent') return subject.color;
  const folder = state.folders.find((f) => f.subject_id === subject.id && (f.color || f.effective_color));
  return folder?.color ?? folder?.effective_color ?? subject.color ?? 'accent';
}

export function lessonMenu(lesson, x, y, refresh) {
  openMenu({ x, y }, [
    { head: lesson.subject.toUpperCase().slice(0, 30) },
    { icon: 'pencil-simple', label: 'Edit', onSelect: () => lessonDialog(lesson, lesson, refresh) },
    {
      icon: 'copy', label: `Copy to week ${lesson.week === 'A' ? 'B' : 'A'}`,
      onSelect: async () => {
        try {
          await api.putLesson({
            week: lesson.week === 'A' ? 'B' : 'A',
            day: lesson.day, period: lesson.period,
            subject: lesson.subject, subjectId: lesson.subject_id,
            room: lesson.room, teacher: lesson.teacher, color: lesson.color,
          });
          toast('Copied.');
          await refresh();
        } catch (err) { reportError(err); }
      },
    },
    { sep: true },
    {
      icon: 'trash', label: 'Remove', danger: true,
      onSelect: async () => {
        try {
          await api.deleteLesson(lesson.id);
          await refresh();
          toast(`${lesson.subject} removed.`, {
            action: {
              label: 'Undo',
              onSelect: async () => {
                try {
                  await api.putLesson({
                    week: lesson.week, day: lesson.day, period: lesson.period,
                    subject: lesson.subject, subjectId: lesson.subject_id,
                    room: lesson.room, teacher: lesson.teacher, color: lesson.color,
                  });
                  await refresh();
                } catch (err) { reportError(err); }
              },
            },
          });
        } catch (err) { reportError(err); }
      },
    },
  ]);
}

/**
 * Writing in a cell.
 *
 * The subject is free text before it is anything else, because the timetable is
 * usually the first thing typed in and the subjects it names may not exist in
 * Studex yet. Linking one is optional and does two things: it borrows that
 * subject's colour, and it lets the rest of the app tell that this hour of
 * Chemistry and that deck of Chemistry cards are the same Chemistry.
 */
async function lessonDialog(lesson, at, refresh) {
  const subject = el('input', { class: 'input', maxlength: 80, placeholder: 'Chemistry', value: lesson?.subject ?? '' });
  const link = dropdown({ class: 'input' },
    el('option', { value: '', text: 'Not linked' }),
    state.subjects.map((s) => el('option', { value: s.id, text: s.name, selected: lesson?.subject_id === s.id })),
  );
  link.addEventListener('change', () => {
    const chosen = state.subjects.find((s) => s.id === link.value);
    if (chosen && !subject.value.trim()) subject.value = chosen.name;
    if (chosen?.teacher && !teacher.value.trim()) teacher.value = chosen.teacher;
  });
  const room = el('input', { class: 'input', maxlength: 40, placeholder: 'B14', value: lesson?.room ?? '' });
  const teacher = el('input', { class: 'input', maxlength: 60, placeholder: 'Mrs Okafor', value: lesson?.teacher ?? '' });
  const color = dropdown({ class: 'input' },
    el('option', { value: '', text: 'Match the subject' }),
    LESSON_COLORS.map((role) => el('option', {
      value: role, text: colorLabel(role), selected: lesson?.color === role,
    })),
  );

  const ok = await dialog({
    title: lesson ? 'Edit lesson' : 'Add lesson',
    confirmLabel: lesson ? 'Save' : 'Add',
    body: el('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
      el('p', { class: 'sub', text: `Week ${at.week} · ${DAY_NAMES[at.day]} · period ${at.period + 1}` }),
      el('div', { class: 'field' }, el('label', { text: 'Lesson' }), subject),
      el('div', { class: 'field' }, el('label', { text: 'Studex subject' }), link),
      el('div', { class: 'field' }, el('label', { text: 'Room' }), room),
      el('div', { class: 'field' }, el('label', { text: 'Teacher' }), teacher),
      el('div', { class: 'field' }, el('label', { text: 'Colour' }), color),
    ),
    onConfirm: async () => {
      const name = subject.value.trim();
      if (!name) { subject.focus(); return false; }
      await api.putLesson({
        week: at.week, day: at.day, period: at.period,
        subject: name,
        // Typing a subject's name links it, so it takes that subject's colour.
        subjectId: link.value || state.subjects.find((x) => x.name.trim().toLowerCase() === name.toLowerCase())?.id || null,
        room: room.value.trim() || null,
        teacher: teacher.value.trim() || null,
        color: color.value || null,
      });
      return true;
    },
  });
  if (ok) { toast(lesson ? 'Lesson updated.' : 'Lesson added.'); await refresh(); }
}

/** Everything that changes the shape of the fortnight rather than one lesson. */
function patternMenu(anchor, week, weekAStart, refresh) {
  const rect = anchor.getBoundingClientRect();
  const monday = mondayOf(Date.now());
  const other = week === 'A' ? 'B' : 'A';

  const setAnchor = async (value, message) => {
    try { await api.setWeekAnchor(value); toast(message); await refresh(); }
    catch (err) { reportError(err); }
  };

  const tracking = weekAStart !== null && weekAStart !== undefined;
  const thisWeek = tracking ? weekOfAnchor(weekAStart, monday) : null;

  openMenu({ x: rect.left, y: rect.bottom + 6 }, [
    { head: 'THIS WEEK IS' },
    {
      icon: thisWeek === 'A' ? 'check' : 'circle',
      label: 'Week A', onSelect: () => setAnchor(monday, 'This week is week A.'),
    },
    {
      icon: thisWeek === 'B' ? 'check' : 'circle',
      label: 'Week B', onSelect: () => setAnchor(monday - 7 * DAY_MS, 'This week is week B.'),
    },
    {
      icon: tracking ? 'circle' : 'check', label: 'The same every week',
      onSelect: () => setAnchor(null, 'The fortnight is off; week A is used everywhere.'),
    },
    { sep: true },
    { head: 'PATTERN' },
    {
      icon: 'copy', label: `Copy week ${week} over week ${other}`,
      onSelect: async () => {
        const ok = await confirmDialog({
          title: `Copy week ${week} over week ${other}?`,
          message: `Everything already in week ${other} will be replaced.`,
          confirmLabel: 'Copy', danger: false,
        });
        if (!ok) return;
        try { await api.copyWeek(week); toast(`Week ${week} copied over week ${other}.`); await refresh(); }
        catch (err) { reportError(err); }
      },
    },
    { icon: 'clock', label: 'Edit the periods…', onSelect: () => periodsDialog(refresh) },
    { sep: true },
    {
      icon: 'eraser', label: `Clear week ${week}`, danger: true,
      onSelect: async () => {
        const ok = await confirmDelete(`Every lesson in week ${week} will be removed.`);
        if (!ok) return;
        try { await api.clearWeek(week); toast(`Week ${week} cleared.`); await refresh(); }
        catch (err) { reportError(err); }
      },
    },
  ]);
}

/**
 * The shape of the school day.
 *
 * Rows here are the rows of the grid, so removing one removes the lessons filed
 * under it — said plainly in the dialog rather than discovered afterwards. The
 * times are wall-clock text: 09:00 is 09:00 on the morning the clocks change
 * too, which is how a printed timetable behaves and not how an offset does.
 */
async function periodsDialog(refresh) {
  const { periods } = await api.timetable();
  const rows = periods.map((p) => ({ label: p.label, startsAt: p.starts_at, endsAt: p.ends_at }));
  const list = el('div', { class: 'period-rows' });

  const draw = () => {
    mount(list, rows.map((row, index) => el('div', { class: 'period-row' },
      el('input', {
        class: 'input', maxlength: 40, value: row.label, 'aria-label': 'Name',
        oninput: (e) => { row.label = e.currentTarget.value; },
      }),
      el('input', {
        class: 'input', type: 'time', value: row.startsAt, 'aria-label': 'Starts',
        oninput: (e) => { row.startsAt = e.currentTarget.value.slice(0, 5); },
      }),
      el('input', {
        class: 'input', type: 'time', value: row.endsAt, 'aria-label': 'Ends',
        oninput: (e) => { row.endsAt = e.currentTarget.value.slice(0, 5); },
      }),
      el('button', {
        class: 'btn icon', type: 'button', title: 'Remove this row',
        'aria-label': `Remove ${row.label}`,
        disabled: rows.length === 1,
        onclick: () => { rows.splice(index, 1); draw(); },
      }, icon('minus')),
    )));
  };
  draw();

  const ok = await dialog({
    title: 'The school day',
    confirmLabel: 'Save',
    wide: true,
    body: el('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
      el('p', { class: 'sub', text: 'These rows are the rows of the timetable. Removing one removes the lessons written in it.' }),
      list,
      el('button', {
        class: 'btn', type: 'button',
        onclick: () => {
          const last = rows[rows.length - 1];
          rows.push({
            label: `Period ${rows.length + 1}`,
            startsAt: last?.endsAt ?? '09:00',
            endsAt: nextHour(last?.endsAt ?? '09:00'),
          });
          draw();
        },
      }, icon('plus'), 'Add a row'),
    ),
    onConfirm: async () => {
      const cleaned = rows
        .map((r) => ({ label: r.label.trim(), startsAt: r.startsAt, endsAt: r.endsAt }))
        .filter((r) => r.label && /^\d{2}:\d{2}$/.test(r.startsAt) && /^\d{2}:\d{2}$/.test(r.endsAt));
      if (cleaned.length !== rows.length) { toast('Every row needs a name, a start and an end.'); return false; }
      await api.setPeriods(cleaned);
      return true;
    },
  });
  if (ok) { toast('The day was rewritten.'); await refresh(); }
}

/**
 * Which week a Monday is, counted from the anchor.
 *
 * The same arithmetic the server does, repeated here only so a menu can put a
 * tick against the week it is already showing without asking for it.
 */
function weekOfAnchor(anchor, ts) {
  const weeks = Math.round((mondayOf(ts) - mondayOf(anchor)) / (7 * DAY_MS));
  return (((weeks % 2) + 2) % 2) === 0 ? 'A' : 'B';
}

/** 'HH:MM' an hour later, clamped at the end of the day. */
function nextHour(hhmm) {
  const [h, m] = hhmm.split(':');
  return `${String(Math.min(23, Number(h) + 1)).padStart(2, '0')}:${m}`;
}

/**
 * The repeating pattern, dressed as events so the clock grids can place it.
 *
 * A lesson has no date of its own — it is "period 3 on a Tuesday in week B" —
 * so the server works out which real mornings that lands on and hands back one
 * entry per occurrence. They are never written to the events table: paging a
 * week forward asks again, and moving the A/B anchor moves all of them at once.
 */
export async function lessonEvents(from, to) {
  const { lessons } = await api.lessonsBetween(from, to);
  return lessons.map((lesson) => ({
    // Unique per occurrence, because the same lesson appears in every week.
    id: `lesson:${lesson.id}:${lesson.starts_at}`,
    title: lesson.subject,
    kind: 'class',
    starts_at: lesson.starts_at,
    ends_at: lesson.ends_at,
    all_day: 0,
    location: lesson.room,
    subject_id: lesson.subject_id,
    lesson,
  }));
}

/**
 * Lets a file from the library be dropped on a day, or on a time in one, to
 * book a revision session for it. `when(event)` says what time the drop means.
 */
export function dropToRevise(node, when, refresh) {
  node.addEventListener('dragover', (event) => {
    if (!carriesItem(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    node.classList.add('drop-on');
  });
  node.addEventListener('dragleave', (event) => {
    const to = event.relatedTarget;
    if (to instanceof Node && node.contains(to)) return;
    node.classList.remove('drop-on');
  });
  node.addEventListener('drop', async (event) => {
    if (!carriesItem(event)) return;
    event.preventDefault();
    event.stopPropagation();
    node.classList.remove('drop-on');
    const item = readItem(event);
    const files = (item?.items ?? (item ? [item] : [])).filter((one) => one.kind === 'file');
    if (!files.length) { toast('Drop a note, PDF or deck here to plan revising it.'); return; }
    let startsAt = when(event);
    const made = [];
    try {
      for (const file of files) {
        const { event: booked } = await api.createEvent({
          kind: 'study_block', title: `Revise ${file.title || 'Untitled'}`, fileId: file.id,
          startsAt, endsAt: startsAt + 45 * 60000, allDay: false,
        });
        made.push(booked);
        startsAt += 60 * 60000;
      }
    } catch (err) { reportError(err); }
    if (!made.length) return;
    await refresh();
    const at = new Date(made[0].starts_at);
    toast(`${made.length === 1 ? 'Revision session' : `${made.length} revision sessions`} booked for ${at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} at ${clockTime(made[0].starts_at)}.`, {
      action: {
        label: 'Undo',
        onSelect: async () => {
          for (const one of made) { try { await api.deleteEvent(one.id); } catch (err) { reportError(err); } }
          await refresh();
        },
      },
    });
  });
  return node;
}

/** The time a drop at this height of a clock column means, on the quarter hour. */
function timeAt(event, col, dayStart, from) {
  const y = event.clientY - col.getBoundingClientRect().top;
  const offset = Math.max(0, y / HOUR_PX);
  const minutes = Math.round((from * 60 + offset * 60) / 15) * 15;
  return dayStart + Math.min(23 * 60 + 15, minutes) * 60000;
}

/** The same grid, reused by Calendar → Week. */
export function weekGrid(events, refresh) {
  const byDay = new Array(7).fill(null).map(() => []);
  const allDay = new Array(7).fill(null).map(() => []);

  for (const event of events) {
    const index = Math.floor((startOfDay(event.starts_at) - weekStart) / DAY_MS);
    if (index < 0 || index > 6) continue;
    (event.all_day ? allDay : byDay)[index].push(event);
  }
  for (const list of byDay) list.sort((a, b) => a.starts_at - b.starts_at || lengthMinutes(b) - lengthMinutes(a));

  const [from, to] = hourRange(byDay.flat());
  const hours = to - from;

  const gutter = el('div', { class: 'tt-gutter' });
  for (let h = from; h < to; h += 1) {
    gutter.appendChild(el('div', { class: 'tt-hour', style: { height: `${HOUR_PX}px` } },
      el('span', { text: `${String(h).padStart(2, '0')}:00` })));
  }

  const bodyCols = [gutter];
  const headCells = [el('div', { class: 'tt-corner' })];
  const allDayCells = [el('div', { class: 'tt-corner', text: allDay.flat().length ? 'ALL DAY' : '' })];

  const today = startOfDay(Date.now());
  for (let i = 0; i < 7; i += 1) {
    const dayStart = weekStart + i * DAY_MS;
    const date = new Date(dayStart);
    const isToday = dayStart === today;
    const weekend = i > 4;

    headCells.push(el('div', { class: ['tt-day', weekend ? 'weekend' : '', isToday ? 'today' : ''].filter(Boolean).join(' ') },
      el('span', { class: 'dow', text: DOW[i] }),
      el('span', { class: 'date', text: String(date.getDate()) }),
    ));

    allDayCells.push(el('div', { class: 'tt-allday-cell' + (weekend ? ' weekend' : '') },
      allDay[i].map((event) => chip(event, refresh))));

    const col = el('div', {
      class: 'tt-col' + (weekend ? ' weekend' : '') + (isToday ? ' today' : ''),
      style: { height: `${hours * HOUR_PX}px` },
      onclick: (e) => {
        // Only an empty part of the column creates — a block handles its own.
        if (e.target !== e.currentTarget) return;
        const offset = e.offsetY / HOUR_PX;
        const hour = Math.max(0, Math.min(23, from + Math.floor(offset)));
        const minute = Math.round(((offset % 1) * 60) / 15) * 15;
        addEvent(dayStart + hour * 3600000 + minute * 60000, refresh, { kind: 'class' });
      },
    });
    for (let h = from + 1; h < to; h += 1) {
      col.appendChild(el('div', { class: 'tt-line', style: { top: `${(h - from) * HOUR_PX}px` } }));
    }
    dropToRevise(col, (event) => timeAt(event, col, dayStart, from), refresh);
    for (const placed of layout(byDay[i])) col.appendChild(block(placed, from, refresh));
    if (isToday) {
      const minutes = (Date.now() - dayStart) / 60000;
      const top = (minutes / 60 - from) * HOUR_PX;
      if (top >= 0 && top <= hours * HOUR_PX) col.appendChild(el('div', { class: 'tt-now', style: { top: `${top}px` } }));
    }
    bodyCols.push(col);
  }

  return el('div', { class: 'tt' },
    el('div', { class: 'tt-head' }, headCells),
    allDay.flat().length ? el('div', { class: 'tt-allday' }, allDayCells) : null,
    el('div', { class: 'tt-scroll' }, el('div', { class: 'tt-body' }, bodyCols)),
  );
}

/**
 * One day, against the same clock the week uses.
 *
 * A week answers "when am I free"; a day answers "what is happening now" —
 * and at one seventh of the width every block finally has room for its own
 * name, its time and where it is.
 */
export function dayGrid(events, refresh) {
  const start = currentDayStart();
  const timed = [];
  const allDay = [];
  for (const event of events) {
    if (startOfDay(event.starts_at) !== start) continue;
    (event.all_day ? allDay : timed).push(event);
  }
  timed.sort((a, b) => a.starts_at - b.starts_at || lengthMinutes(b) - lengthMinutes(a));

  const [from, to] = hourRange(timed);
  const hours = to - from;

  const gutter = el('div', { class: 'tt-gutter' });
  for (let h = from; h < to; h += 1) {
    gutter.appendChild(el('div', { class: 'tt-hour', style: { height: `${HOUR_PX}px` } },
      el('span', { text: `${String(h).padStart(2, '0')}:00` })));
  }

  const date = new Date(start);
  const isToday = start === startOfDay(Date.now());
  const weekend = date.getDay() === 0 || date.getDay() === 6;

  const col = el('div', {
    class: 'tt-col' + (weekend ? ' weekend' : '') + (isToday ? ' today' : ''),
    style: { height: `${hours * HOUR_PX}px` },
    onclick: (e) => {
      if (e.target !== e.currentTarget) return;
      const offset = e.offsetY / HOUR_PX;
      const hour = Math.max(0, Math.min(23, from + Math.floor(offset)));
      const minute = Math.round(((offset % 1) * 60) / 15) * 15;
      addEvent(start + hour * 3600000 + minute * 60000, refresh, { kind: 'event' });
    },
  });
  for (let h = from + 1; h < to; h += 1) {
    col.appendChild(el('div', { class: 'tt-line', style: { top: `${(h - from) * HOUR_PX}px` } }));
  }
  dropToRevise(col, (event) => timeAt(event, col, start, from), refresh);
  for (const placed of layout(timed)) col.appendChild(block(placed, from, refresh));
  if (isToday) {
    const minutes = (Date.now() - start) / 60000;
    const top = (minutes / 60 - from) * HOUR_PX;
    if (top >= 0 && top <= hours * HOUR_PX) col.appendChild(el('div', { class: 'tt-now', style: { top: `${top}px` } }));
  }

  return el('div', { class: 'tt day' },
    el('div', { class: 'tt-head' },
      el('div', { class: 'tt-corner' }),
      el('div', { class: ['tt-day', weekend ? 'weekend' : '', isToday ? 'today' : ''].filter(Boolean).join(' ') },
        el('span', { class: 'dow', text: DOW[(date.getDay() + 6) % 7] }),
        el('span', { class: 'date', text: String(date.getDate()) }),
        el('span', { class: 'dim', style: { fontSize: '12px' },
          text: date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) }),
      ),
    ),
    allDay.length
      ? el('div', { class: 'tt-allday' },
          el('div', { class: 'tt-corner', text: 'ALL DAY' }),
          el('div', { class: 'tt-allday-cell' + (weekend ? ' weekend' : '') },
            allDay.map((event) => chip(event, refresh))),
        )
      : null,
    el('div', { class: 'tt-scroll' }, el('div', { class: 'tt-body' }, gutter, col)),
    timed.length === 0 && allDay.length === 0
      ? el('div', { class: 'tt-day-empty dim' }, 'Nothing scheduled. Click the column to add something.')
      : null,
  );
}

export function dayControls(refresh) {
  const date = new Date(currentDayStart());
  return [
    el('span', { class: 'week-label', text: date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }) }),
    el('button', { class: 'btn icon', title: 'Previous day', onclick: () => { dayAnchor = currentDayStart() - DAY_MS; refresh(); } }, icon('caret-left')),
    el('button', { class: 'btn icon', title: 'Next day', onclick: () => { dayAnchor = currentDayStart() + DAY_MS; refresh(); } }, icon('caret-right')),
    el('button', { class: 'btn', text: 'Today', onclick: () => { dayAnchor = startOfDay(Date.now()); refresh(); } }),
  ];
}

/** Lets the month grid open a chosen day, and Calendar → Day share the anchor. */
export function setDayStart(ts) { dayAnchor = startOfDay(ts); }
export function currentDayStart() { return dayAnchor ?? startOfDay(Date.now()); }

export function weekControls(refresh) {
  const label = new Date(weekStart);
  const end = new Date(weekStart + 6 * DAY_MS);
  const sameMonth = label.getMonth() === end.getMonth();
  const title = sameMonth
    ? `${label.getDate()}–${end.getDate()} ${label.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}`
    : `${label.getDate()} ${label.toLocaleDateString(undefined, { month: 'short' })} – ${end.getDate()} ${end.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`;

  return [
    el('span', { class: 'week-label', text: title }),
    el('button', { class: 'btn icon', title: 'Previous week', onclick: () => { weekStart -= 7 * DAY_MS; refresh(); } }, icon('caret-left')),
    el('button', { class: 'btn icon', title: 'Next week', onclick: () => { weekStart += 7 * DAY_MS; refresh(); } }, icon('caret-right')),
    el('button', { class: 'btn', text: 'This week', onclick: () => { weekStart = mondayOf(Date.now()); refresh(); } }),
  ];
}

/** Lets Calendar → Week page the same anchor the timetable uses. */
export function setWeekStart(ts) { weekStart = mondayOf(ts); }
export function currentWeekStart() { return weekStart ?? mondayOf(Date.now()); }

/* ── layout ───────────────────────────────────────────────────────────── */

function lengthMinutes(event) {
  if (event.all_day) return 0;
  const end = event.ends_at ?? event.starts_at + ASSUMED_MINUTES * 60000;
  return Math.max(15, Math.round((end - event.starts_at) / 60000));
}

/**
 * The visible hours: wide enough for everything in the week, but never the
 * full 24 when the week is an ordinary one. Empty weeks show a school day.
 */
function hourRange(events) {
  let from = 8;
  let to = 20;
  for (const event of events) {
    const start = new Date(event.starts_at);
    const startHour = start.getHours() + start.getMinutes() / 60;
    const endHour = startHour + lengthMinutes(event) / 60;
    from = Math.min(from, Math.floor(startHour));
    to = Math.max(to, Math.ceil(endHour));
  }
  return [Math.max(0, from), Math.min(24, Math.max(to, from + 4))];
}

/**
 * Side-by-side placement for events that overlap. Events are swept in start
 * order into a cluster; a cluster's width is shared by however many of its
 * members run at once, which is what makes two 09:00 classes both readable.
 */
function layout(dayEvents) {
  const placed = [];
  let cluster = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    if (!cluster.length) return;
    const columns = [];
    const assigned = [];
    for (const event of cluster) {
      let index = columns.findIndex((end) => end <= event.starts_at);
      if (index === -1) { index = columns.length; columns.push(0); }
      columns[index] = endOf(event);
      assigned.push({ event, col: index });
    }
    for (const entry of assigned) placed.push({ ...entry, cols: columns.length });
    cluster = [];
    clusterEnd = -Infinity;
  };

  for (const event of dayEvents) {
    if (event.starts_at >= clusterEnd) flush();
    cluster.push(event);
    clusterEnd = Math.max(clusterEnd, endOf(event));
  }
  flush();
  return placed;
}

function endOf(event) { return event.starts_at + lengthMinutes(event) * 60000; }

/* ── pieces ───────────────────────────────────────────────────────────── */

function block({ event, col, cols }, from, refresh) {
  const start = new Date(event.starts_at);
  const offsetHours = start.getHours() + start.getMinutes() / 60 - from;
  const height = (lengthMinutes(event) / 60) * HOUR_PX;
  const width = 100 / cols;

  const open = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (event.lesson) lessonMenu(event.lesson, e.clientX, e.clientY, refresh);
    else eventMenu(event, e.clientX, e.clientY, refresh);
  };

  const node = el('button', {
    class: 'tt-block' + (height < 40 ? ' short' : '')
      + (event.lesson ? ' lesson' : event.kind === 'exam' ? ' exam' : event.kind === 'study_block' ? ' study' : ''),
    style: {
      top: `${offsetHours * HOUR_PX}px`,
      height: `${Math.max(20, height - 2)}px`,
      left: `calc(${col * width}% + 3px)`,
      width: `calc(${width}% - 6px)`,
    },
    title: `${event.title} · ${clockTime(event.starts_at)}${event.location ? ` · ${event.location}` : ''}`,
    onclick: open,
    oncontextmenu: open,
  },
    el('span', { class: 'time', text: clockTime(event.starts_at) }),
    el('span', { class: 'name', text: event.title }),
    height > 54 && event.location ? el('span', { class: 'where', text: event.location }) : null,
  );
  return applyColor(node, event.lesson ? lessonColor(event.lesson) : eventColor(event));
}

function chip(event, refresh) {
  const node = el('button', {
    class: 'tt-chip' + (event.kind === 'exam' ? ' exam' : ''),
    title: event.title,
    onclick: (e) => { e.stopPropagation(); eventMenu(event, e.clientX, e.clientY, refresh); },
  }, icon(EVENT_ICON[event.kind] ?? 'circle', { size: 11 }), event.title);
  return applyColor(node, eventColor(event));
}
