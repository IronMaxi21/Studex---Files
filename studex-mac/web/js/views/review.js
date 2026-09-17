/**
 * Screen 08a — Daily review. One place that answers "what do I owe today, and
 * how much of it have I done", so the study habit has a home rather than being
 * a button on the deck list.
 */
import { el, icon, mount } from '../dom.js';
import { api } from '../api.js';
import { state } from '../store.js';
import { navigate } from '../router.js';
import { topbar, subnav } from '../shell.js';
import { plural, relative } from '../format.js';
import { reportDue } from '../badge.js';

export async function reviewView(route, host) {
  const [{ today }, decks] = await Promise.all([
    api.studyToday(),
    Promise.resolve(state.files.filter((f) => f.kind === 'deck')),
  ]);

  // What is left is what the queue would serve right now; the day's total is
  // that plus what has already been answered.
  const remaining = today.remaining;
  // The Dock is told what this screen has just been told, rather than asking
  // for the same number a second time.
  reportDue(remaining);
  const planned = remaining + today.reviewed_today;
  const done = planned ? Math.min(100, Math.round((today.reviewed_today / planned) * 100)) : 100;
  const capped = today.due_count > today.daily_review_limit || today.new_count > today.daily_new_cards;

  mount(host,
    topbar(['Study', 'Daily review'],
      el('button', { class: 'chip', onclick: () => navigate('settings/study') }, icon('sliders'), 'Daily limits'),
    ),
    subnav('study', 'review'),
    el('div', { class: 'content' },
      el('div', { class: 'page-head' },
        el('div', { class: 'page-title', text: 'Daily review' }),
        el('div', { class: 'note', text: today.streak_days ? `${plural(today.streak_days, 'day')} in a row` : 'Start a streak today' }),
      ),

      el('div', { class: 'today-card' + (remaining ? '' : ' clear') },
        el('div', { class: 'ring' + (remaining ? '' : ' full'), style: { '--pct': `${done}%` },
          role: 'img',
          'aria-label': remaining
            ? `${today.reviewed_today} of ${planned} cards reviewed today, ${remaining} to go — ${done}% done.`
            : today.reviewed_today ? `All ${today.reviewed_today} cards reviewed. Today is done.` : 'Nothing is due today.' },
          el('div', { class: 'inner', 'aria-hidden': 'true' },
            el('div', { class: 'big', text: String(remaining || today.reviewed_today) }),
            el('div', { class: 'cap', text: remaining ? 'to go' : 'done' }),
          ),
        ),
        el('div', { class: 'body' },
          el('div', { class: 'headline', text: remaining
            ? `${plural(remaining, 'card')} left today`
            : today.reviewed_today ? 'Today’s review is finished.' : 'Nothing is due today.' }),
          el('div', { class: 'muted', style: { lineHeight: '1.7', maxWidth: '46em' }, text: remaining
            ? `${today.reviewed_today} of ${planned} reviewed. The queue mixes cards that have come round again with new ones, up to your daily limits.`
            : 'Cards come back when the scheduler says they are worth seeing again — usually tomorrow.' }),
          capped
            ? el('div', { class: 'dim', style: { fontSize: '12px' } },
                `Your limits are holding back ${Math.max(0, today.due_count - today.daily_review_limit)} due and `
                + `${Math.max(0, today.new_count - today.daily_new_cards)} new cards.`)
            : null,
          el('div', { style: { display: 'flex', gap: '10px', marginTop: '4px' } },
            remaining
              ? el('button', { class: 'btn primary lg', onclick: () => navigate('deck/all/study') }, icon('play'), `Review ${remaining}`)
              : el('button', { class: 'btn lg', onclick: () => navigate('flashcards') }, icon('cards'), 'Browse decks'),
            today.new_count || today.due_count
              ? el('button', { class: 'btn lg', onclick: () => navigate('test') }, icon('exam'), 'Test me instead')
              : null,
          ),
        ),
      ),

      el('div', { class: 'stat-grid' },
        el('div', { class: 'stat lead' }, el('div', { class: 'kicker', text: 'DUE' }), el('div', { class: 'value', text: String(today.due_count) }), el('div', { class: 'sub', text: 'ready to review' })),
        el('div', { class: 'stat' }, el('div', { class: 'kicker', text: 'NEW' }), el('div', { class: 'value', text: String(today.new_count) }), el('div', { class: 'sub', text: 'never studied' })),
        el('div', { class: 'stat' }, el('div', { class: 'kicker', text: 'REVIEWED TODAY' }), el('div', { class: 'value', text: String(today.reviewed_today) }), el('div', { class: 'sub', text: 'answers logged' })),
        el('div', { class: 'stat' }, el('div', { class: 'kicker', text: 'STREAK' }), el('div', { class: 'value', text: String(today.streak_days) }), el('div', { class: 'sub', text: 'consecutive days' })),
      ),

      el('span', { class: 'section-label plain', text: 'DECKS WITH WORK WAITING' }),
      (() => {
        const waiting = decks.filter((d) => (d.due_count ?? 0) > 0);
        if (!waiting.length) return el('div', { class: 'dim', style: { fontSize: '12.5px' } }, 'No deck has cards waiting.');
        return el('div', { class: 'rows' }, waiting.map((deck) => el('button', {
          class: 'row', onclick: () => navigate(`deck/${deck.id}/study`),
        },
          icon('cards'),
          el('div', { class: 'grow' },
            el('div', { text: deck.title }),
            el('div', { class: 'dim', style: { fontSize: '11px', marginTop: '3px' },
              text: `${plural(deck.card_count ?? 0, 'card')} · updated ${relative(deck.updated_at)}` }),
          ),
          el('span', { class: 'pill ready', text: `${deck.due_count} due` }),
        )));
      })(),
    ),
  );
}
