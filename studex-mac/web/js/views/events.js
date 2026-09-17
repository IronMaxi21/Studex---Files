/**
 * Event editing shared by every screen that shows the schedule — the month
 * grid, the week timetable and the deadline list all open the same menu and
 * the same form, so they live here rather than in whichever view happened to
 * need them first.
 */
import { el } from '../dom.js';
import { dropdown } from '../select.js';
import { api } from '../api.js';
import { state, subjectById, toast, reportError } from '../store.js';
import { navigate } from '../router.js';
import { openMenu } from '../menu.js';
import { dialog, confirmDelete } from '../dialog.js';
import { startOfDay } from '../format.js';
import { aiAvailable, planRevision } from '../ai.js';
import { openRevisionPlan } from '../revision-plan.js';

export const KINDS = [
  { id: 'study_block', label: 'Revision', color: 'violet' },
  { id: 'exam', label: 'Exam', color: 'rose' },
  { id: 'deadline', label: 'Assignment or deadline', color: 'amber' },
  { id: 'class', label: 'Class', color: 'sky' },
  { id: 'personal', label: 'Personal', color: 'teal' },
  { id: 'event', label: 'Something else', color: 'accent' },
];

const KIND_COLOR = Object.fromEntries(KINDS.map((k) => [k.id, k.color]));

/**
 * What colour a thing is on the calendar.
 *
 * A subject's own colour wins where there is one, because a Chemistry exam
 * should look like the rest of Chemistry. Everything else falls back to the
 * colour of its kind, which is what lets a month of revision, exams, lessons
 * and birthdays be read apart at a glance rather than being one wash of accent.
 */
export function eventColor(event) {
  const subject = event.subject_id ? subjectById(event.subject_id) : null;
  return subject?.color ?? KIND_COLOR[event.kind] ?? 'accent';
}

/**
 * Asynchronous only because of the AI item: whether this install has an AI is
 * a question for the server, and drawing a "Plan revision" that fails on click
 * is worse than the small delay before the menu appears. Every caller treats
 * this as fire-and-forget already.
 */
export async function eventMenu(event, x, y, refresh) {
  const canPlan = event.kind === 'exam' && await aiAvailable();

  openMenu({ x, y }, [
    { head: event.title.toUpperCase().slice(0, 30) },
    { icon: 'pencil-simple', label: 'Edit', onSelect: () => editEvent(event, refresh) },
    (event.kind === 'exam' || event.kind === 'deadline') && event.starts_at > Date.now()
      ? { icon: 'calendar-check', label: 'Revision plan…', onSelect: async () => {
          try { if (await openRevisionPlan(event)) await refresh(); } catch (err) { reportError(err); }
        } }
      : null,
    canPlan
      ? { icon: 'sparkle', label: 'Plan revision with AI', onSelect: async () => {
          try { await planRevision(event); await refresh(); } catch (err) { reportError(err); }
        } }
      : null,
    event.kind === 'study_block'
      ? { icon: 'play', label: 'Start focus session', onSelect: async () => {
          try {
            await api.startSession({ plannedMinutes: 25, eventId: event.id, subjectId: event.subject_id, cycleIndex: 1, cycleTotal: 4 });
            toast('Focus session started.');
            navigate('home');
          } catch (err) { reportError(err); }
        } }
      : null,
    { sep: true },
    {
      icon: 'trash', label: 'Delete', danger: true, onSelect: async () => {
        const ok = await confirmDelete(`“${event.title}” will be removed from your calendar.`);
        if (!ok) return;
        try { await api.deleteEvent(event.id); await refresh(); } catch (err) { reportError(err); }
      },
    },
  ]);
}

function eventForm(event, startAt) {
  const title = el('input', { class: 'input', maxlength: 200, value: event?.title ?? '' });
  // Re-filing rather than retyping: something entered as a class that turns out
  // to be a revision session is the same event with the wrong label on it, and
  // the update schema now takes a kind, so this is no longer locked on edit.
  const kind = dropdown({ class: 'input' },
    KINDS.map((k) => el('option', { value: k.id, text: k.label, selected: event?.kind === k.id })));
  const when = el('input', { class: 'input', type: 'datetime-local' });
  const minutes = el('input', { class: 'input', type: 'number', min: 5, max: 720, step: 5 });
  const location = el('input', { class: 'input', maxlength: 120, value: event?.location ?? '' });
  const subject = dropdown({ class: 'input' },
    el('option', { value: '', text: 'No subject' }),
    state.subjects.map((s) => el('option', { value: s.id, text: s.name, selected: event?.subject_id === s.id })),
  );

  const base = new Date(event ? event.starts_at : startAt);
  when.value = new Date(base.getTime() - base.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  minutes.value = String(event?.ends_at ? Math.max(5, Math.round((event.ends_at - event.starts_at) / 60000)) : 60);

  const body = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
    el('div', { class: 'field' }, el('label', { text: 'Title' }), title),
    el('div', { class: 'field' }, el('label', { text: 'Kind' }), kind),
    el('div', { class: 'field' }, el('label', { text: 'When' }), when),
    el('div', { class: 'field' }, el('label', { text: 'Length (minutes)' }), minutes),
    el('div', { class: 'field' }, el('label', { text: 'Subject' }), subject),
    el('div', { class: 'field' }, el('label', { text: 'Location (optional)' }), location),
  );

  return {
    body,
    read: () => {
      const name = title.value.trim();
      if (!name || !when.value) { title.focus(); return null; }
      const startsAt = new Date(when.value).getTime();
      const length = Math.max(5, Math.min(720, Number(minutes.value) || 60));
      const values = {
        title: name,
        startsAt,
        // A timetable can only place a block once it knows how long it runs,
        // so the form always sends an end rather than leaving it open.
        endsAt: startsAt + length * 60000,
        subjectId: subject.value || null,
        location: location.value.trim() || null,
        kind: kind.value,
      };
      return values;
    },
  };
}

/**
 * `at` is the instant the new event should start — a day cell passes its own
 * 18:00, a timetable slot passes the hour the user clicked.
 */
export async function addEvent(at, refresh, { kind = null } = {}) {
  const form = eventForm(null, at ?? startOfDay(Date.now()) + 18 * 3600000);
  if (kind) {
    const select = form.body.querySelector('[data-select]');
    if (select) select.value = kind;
  }
  const ok = await dialog({
    title: 'New event',
    confirmLabel: 'Add',
    body: form.body,
    onConfirm: async () => {
      const values = form.read();
      if (!values) return false;
      await api.createEvent(values);
      return true;
    },
  });
  if (ok) { toast('Event added.'); await refresh(); }
}

export async function editEvent(event, refresh) {
  const form = eventForm(event, event.starts_at);
  const ok = await dialog({
    title: 'Edit event',
    confirmLabel: 'Save',
    body: form.body,
    onConfirm: async () => {
      const values = form.read();
      if (!values) return false;
      await api.updateEvent(event.id, values);
      return true;
    },
  });
  if (ok) { toast('Event updated.'); await refresh(); }
}
