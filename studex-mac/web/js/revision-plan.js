/**
 * The revision plan an exam writes for itself.
 *
 * The server builds the plan from this student's own topic ratings and card
 * lapses, lays it out on free evenings before the exam, and shows it here
 * before anything is written. "Reshuffle" asks for the same weak spots on
 * different days and in a different order; "Add to calendar" writes it, and
 * replaces the sessions an earlier plan for this exam still had to come.
 */
import { el, icon, mount } from './dom.js';
import { api } from './api.js';
import { dialog, confirmDelete } from './dialog.js';
import { toast, reportError } from './store.js';
import { plural } from './format.js';

const when = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

function groundingLine(g) {
  const bits = [];
  if (g.weak_topics) bits.push(plural(g.weak_topics, 'topic') + ' rated weak');
  if (g.unrated_topics) bits.push(`${g.unrated_topics} not yet rated`);
  if (g.lapsed_decks) bits.push(plural(g.lapsed_decks, 'deck') + ' with lapsed cards');
  if (g.mastery_pct != null) bits.push(`${g.mastery_pct}% mastery`);
  if (!bits.length) {
    return 'Nothing rated or reviewed for this subject yet, so the plan is mixed review. Rate topics in the matrix for a sharper plan.';
  }
  return `Built from ${bits.join(', ')}. Weakest material gets the most sessions and comes back a second time.`;
}

/** Opens the planner for an exam. Resolves true when the calendar changed. */
export async function openRevisionPlan(exam) {
  const existing = await api.revisionPlan(exam.id).then((r) => r.sessions).catch(() => []);
  const upcoming = existing.filter((s) => s.starts_at > Date.now());

  const minutes = el('input', { class: 'input', id: 'plan-minutes', type: 'number', min: 15, max: 240, step: 5, value: '45' });
  const perWeek = el('input', { class: 'input', id: 'plan-per-week', type: 'number', min: 1, max: 14, value: '4' });
  const hour = el('input', { class: 'input', id: 'plan-hour', type: 'number', min: 6, max: 22, value: '18' });
  const preview = el('div', { class: 'plan-preview' });
  const summary = el('div', { class: 'muted', style: { lineHeight: '1.6' } });
  let shuffle = 0;
  let plan = null;
  let changed = false;

  const draw = async () => {
    mount(preview, el('div', { class: 'ai-thinking' }, icon('calendar-dots', { size: 13 }), 'Laying out sessions…'));
    try {
      plan = (await api.draftRevisionPlan(exam.id, {
        minutesPerSession: Math.max(15, Math.min(240, Number(minutes.value) || 45)),
        sessionsPerWeek: Math.max(1, Math.min(14, Number(perWeek.value) || 4)),
        startHour: Math.max(6, Math.min(22, Number(hour.value) || 18)),
        shuffle,
      })).plan;
      summary.textContent = groundingLine(plan.grounding);
      mount(preview, el('div', { class: 'ai-plan' }, plan.sessions.map((s) => el('div', { class: 'ai-session' },
        el('div', { class: 'when', text: when.format(new Date(s.startsAt)) }),
        el('div', null,
          el('div', { class: 'title' }, s.kind === 'review' ? icon('shuffle', { size: 13 }) : null, s.kind === 'review' ? ' ' : null, s.title),
          s.focus ? el('div', { class: 'focus', text: s.focus }) : null),
      ))));
    } catch (err) {
      plan = null;
      summary.textContent = '';
      mount(preview, el('div', { class: 'dim', text: err?.message ?? 'Could not draw up a plan.' }));
    }
  };

  for (const input of [minutes, perWeek, hour]) input.addEventListener('change', () => { shuffle = 0; draw(); });

  const body = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
    summary,
    upcoming.length
      ? el('div', { class: 'plan-existing' },
        icon('info', { size: 13 }),
        ` ${plural(upcoming.length, 'planned session')} already in your calendar — adding this plan replaces them. `,
        el('button', {
          class: 'btn sm', type: 'button', text: 'Clear them',
          onclick: async (event) => {
            if (!(await confirmDelete(`${plural(upcoming.length, 'upcoming revision session')} for “${exam.title}” will be removed.`))) return;
            try {
              const { removed } = await api.clearRevisionPlan(exam.id);
              changed = true;
              toast(`${plural(removed, 'session')} removed.`);
              event.target.closest('.plan-existing')?.remove();
            } catch (err) { reportError(err); }
          },
        }))
      : null,
    el('div', { class: 'ai-pair', style: { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-end' } },
      el('div', { class: 'field' }, el('label', { for: 'plan-minutes', text: 'Minutes each' }), minutes),
      el('div', { class: 'field' }, el('label', { for: 'plan-per-week', text: 'Sessions a week' }), perWeek),
      el('div', { class: 'field' }, el('label', { for: 'plan-hour', text: 'Start hour' }), hour),
      el('button', {
        class: 'btn', type: 'button', title: 'Same weak spots, different days and order',
        onclick: () => { shuffle = 1 + Math.floor(Math.random() * 999_999); draw(); },
      }, icon('shuffle', { size: 14 }), ' Reshuffle'),
    ),
    preview,
  );

  const drawing = draw();
  const saved = await dialog({
    title: `Revision plan for ${exam.title}`,
    wide: true,
    confirmLabel: 'Add to calendar',
    body,
    onConfirm: async () => {
      await drawing;
      if (!plan?.sessions?.length) return false;
      try {
        const res = await api.acceptRevisionPlan(exam.id, { sessions: plan.sessions });
        toast(`${plural(res.created, 'revision session')} added${res.replaced ? `, ${res.replaced} replaced` : ''}.`);
        return true;
      } catch (err) {
        reportError(err);
        return false;
      }
    },
  });
  return Boolean(saved) || changed;
}
