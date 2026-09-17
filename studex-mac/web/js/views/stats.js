/** Screen 09 — Statistics. Streak, hours, mastery and exam readiness. */
import { el, svg, icon, mount, applyColor } from '../dom.js';
import { api } from '../api.js';
import { navigate } from '../router.js';
import { topbar } from '../shell.js';
import { shortDate } from '../format.js';

const RANGES = [
  { id: 30, label: '30 days' },
  { id: 90, label: 'Term' },
  { id: 365, label: 'All' },
];

let range = 30;

export async function statsView(route, host) {
  const [{ overview }, hours, needs, bySubject, term] = await Promise.all([
    api.statsOverview(),
    api.statsHours({ days: range }).catch(() => null),
    api.statsNeedsWork().then((r) => r.needs_work).catch(() => null),
    api.statsHoursBySubject({ days: range }).then((r) => r.subjects).catch(() => []),
    api.statsTerm({ weeks: 14 }).then((r) => r.term).catch(() => null),
  ]);

  const series = hours?.series ?? overview.hours_series ?? [];

  mount(host,
    topbar(['Statistics'],
      el('div', { class: 'seg' }, RANGES.map((r) => el('button', {
        class: range === r.id ? 'on' : '', text: r.label,
        onclick: () => { range = r.id; statsView(route, host); },
      }))),
    ),
    el('div', { class: 'content' },
      el('div', { class: 'stat-grid' },
        el('div', { class: 'big-stat' },
          el('div', { class: 'k', text: 'STUDY STREAK' }),
          el('div', { class: 'v' }, String(overview.streak_days), el('span', { class: 'unit', text: overview.streak_days === 1 ? 'day' : 'days' })),
          streakSub(overview),
        ),
        el('div', { class: 'big-stat' },
          el('div', { class: 'k', text: 'HOURS / WEEK' }),
          el('div', { class: 'v', text: overview.hours_this_week.toFixed(1) }),
        ),
        el('div', { class: 'big-stat' },
          el('div', { class: 'k', text: 'RECALL' }),
          el('div', { class: 'v', text: `${overview.recall_pct}%` }),
        ),
        el('div', { class: 'big-stat' },
          el('div', { class: 'k', text: 'CARDS DUE' }),
          el('div', { class: 'v', text: String(overview.cards_due) }),
        ),
      ),

      el('div', null,
        el('div', { class: 'chart-head' },
          el('span', { class: 't', text: 'HOURS STUDIED' }),
          el('span', { class: 'dim', style: { fontSize: '11.5px' }, text: `last ${range} days` }),
        ),
        hoursChart(series),
      ),

      hoursBySubjectPanel(bySubject, range),

      termPanel(term),

      el('div', { class: 'two-col', style: { gridTemplateColumns: '1fr 1fr', gap: '44px' } },
        el('div', { class: 'col' },
          el('span', { class: 'section-label plain', text: 'MASTERY BY SUBJECT' }),
          overview.mastery.length
            ? el('div', { class: 'meter-group' }, overview.mastery.map((subject) => {
                const node = el('div', null,
                  el('div', { class: 'meter-row' },
                    el('span', { text: subject.name }),
                    el('span', { class: 'pct', text: `${subject.mastery_pct}%` }),
                  ),
                  el('div', { class: 'meter' }, el('div', { style: { width: `${subject.mastery_pct}%` } })),
                );
                return applyColor(node, subject.color);
              }))
            : el('div', { class: 'dim' }, 'Review some cards to build a mastery picture.'),
        ),
        el('div', { class: 'col' },
          el('span', { class: 'section-label plain', text: 'EXAM READINESS' }),
          overview.exam_readiness.length
            ? el('div', { class: 'rows' }, overview.exam_readiness.map((exam) => el('button', {
                class: 'row', onclick: () => navigate('calendar'),
              },
                el('span', { class: 'date', text: shortDate(exam.starts_at) }),
                el('span', { class: 'grow', text: exam.title }),
                el('span', {
                  class: 'pill ' + (exam.readiness === 'ready' ? 'ready' : exam.readiness === 'behind' ? 'behind' : ''),
                  text: exam.readiness === 'ready' ? 'Ready' : exam.readiness === 'behind' ? 'Behind' : 'On track',
                }),
              )))
            : el('div', { class: 'dim' }, 'No exams scheduled.'),
        ),
      ),

      needsWorkPanel(needs),
    ),
  );
}

function streakSub(overview) {
  const bits = [];
  if (overview.best_streak_days) bits.push(`best ${overview.best_streak_days}`);
  if (overview.streak_freezes) bits.push(`${overview.streak_freezes} ${overview.streak_freezes === 1 ? 'freeze' : 'freezes'} banked`);
  return bits.length ? el('div', { class: 'dim', style: { fontSize: '11.5px', marginTop: '4px' }, text: bits.join(' · ') }) : null;
}

/** How much a day's work weighs on the heatmap: 0 (none) to 4. */
function dayLevel(day) {
  if (day.minutes >= 90) return 4;
  if (day.minutes >= 45) return 3;
  if (day.minutes >= 15 || day.reviews >= 50) return 2;
  if (day.minutes > 0 || day.reviews > 0) return 1;
  return 0;
}

/**
 * The term at a glance: one square a day, one column a week, and under each
 * week whether it reached the weekly goal. A frozen day is drawn as such, so a
 * streak that survived a gap shows where the gap was.
 */
function termPanel(term) {
  if (!term) return null;
  const weekCols = term.weeks.map((week, w) => {
    const days = term.days.slice(w * 7, w * 7 + 7);
    return el('div', { class: 'term-week' },
      days.map((day) => {
        const label = day.future ? day.day
          : day.frozen ? `${day.day} · streak freeze used`
          : `${day.day} · ${day.minutes} min focus · ${day.reviews} reviews`;
        return el('span', {
          class: `term-day l${dayLevel(day)}${day.frozen ? ' frozen' : ''}${day.future ? ' future' : ''}`,
          title: label,
        });
      }),
      term.goal_minutes
        ? el('span', { class: 'term-goal' + (week.met ? ' met' : ''), title: `Week of ${week.week_start}: ${Math.round(week.minutes / 6) / 10}h of ${term.goal_minutes / 60}h` },
          el('span', { style: { height: `${Math.min(100, Math.round((week.minutes / term.goal_minutes) * 100))}%` } }))
        : null,
    );
  });
  const summary = term.goal_minutes
    ? `${term.weeks_met} of ${term.weeks.length} weeks met the ${term.goal_minutes / 60}h goal`
    : 'Set a weekly goal in Settings › Study to track weeks against it';
  return el('div', { class: 'col' },
    el('div', { class: 'chart-head' },
      el('span', { class: 't', text: 'THIS TERM' }),
      el('span', { class: 'dim', style: { fontSize: '11.5px' }, text: summary }),
    ),
    el('div', { class: 'term-grid', role: 'img', 'aria-label': `Study activity over the last ${term.weeks.length} weeks. ${summary}.` },
      el('div', { class: 'term-week term-labels' }, ['Mon', '', 'Wed', '', 'Fri', '', 'Sun'].map((d) => el('span', { class: 'term-label', text: d }))),
      weekCols),
  );
}

/**
 * Where the time went. A focus session counts toward the subject it was
 * started for, the calendar block it answered, or the file it was opened on —
 * whichever it has — and a session with none of those is shown as its own bar
 * so the bars always add up to the hours above.
 */
function hoursBySubjectPanel(rows, days) {
  if (!rows?.length) return null;
  const max = Math.max(...rows.map((r) => r.hours), 0.01);
  return el('div', { class: 'col' },
    el('span', { class: 'section-label plain', text: `HOURS BY SUBJECT · LAST ${days} DAYS` }),
    el('div', { class: 'meter-group' }, rows.map((row) => {
      const goals = row.goals
        ? ` · ${row.goals_met} of ${row.goals} ${row.goals === 1 ? 'goal' : 'goals'} met`
        : '';
      const node = el('div', null,
        el('div', { class: 'meter-row' },
          el('span', { text: row.name }),
          el('span', { class: 'pct', text: `${row.hours.toFixed(1)} h${goals}` }),
        ),
        el('div', { class: 'meter' }, el('div', { style: { width: `${Math.round((row.hours / max) * 100)}%` } })),
      );
      return applyColor(node, row.color);
    })),
  );
}

/**
 * The weak spots, gathered from three places the app already measures — the
 * topics rated lowest, the cards lapsed on most, the subjects behind their
 * exams — each with a button that starts a session on exactly those. Retrieval
 * aimed at what you are worst at is the most efficient revision there is, so it
 * earns the loudest place on the screen.
 */
function needsWorkPanel(needs) {
  if (!needs) return null;
  const has =
    needs.weak_topics.length || needs.lapse_cards.length || needs.behind_subjects.length;
  if (!has) return null;

  return el('div', { class: 'needs-work' },
    el('span', { class: 'section-label plain', text: 'NEEDS WORK' }),

    needs.lapse_total
      ? el('button', {
          class: 'row needs-lead', onclick: () => navigate('deck/all/study/needs'),
        },
          icon('play'),
          el('span', { class: 'grow', text: `Your ${needs.lapse_total} hardest cards` }),
          el('span', { class: 'dim', text: 'most-lapsed first' }),
        )
      : null,

    needs.weak_topics.length
      ? el('div', { class: 'col' },
          el('span', { class: 'micro-label', text: 'SHAKIEST TOPICS' }),
          el('div', { class: 'rows' }, needs.weak_topics.map((t) => el('button', {
            class: 'row',
            onclick: () => navigate('deck/all/study/topic/' + encodeURIComponent(t.name)),
          },
            el('span', { class: 'grow', text: t.name }),
            t.unit ? el('span', { class: 'dim', text: t.unit }) : null,
          ))),
        )
      : null,

    needs.behind_subjects.length
      ? el('div', { class: 'col' },
          el('span', { class: 'micro-label', text: 'SUBJECTS BEHIND' }),
          el('div', { class: 'rows' }, needs.behind_subjects.map((s) => el('button', {
            class: 'row', onclick: () => s.subject_id
              ? navigate('deck/all/study/subject/' + s.subject_id)
              : navigate('calendar'),
          },
            el('span', { class: 'grow', text: s.title }),
            el('span', { class: 'pill behind', text: 'Behind' }),
          ))),
        )
      : null,
  );
}

/** Area + line chart over the daily hours series. */
function hoursChart(series) {
  const width = 1120;
  const height = 200;
  const baseline = 170;
  const top = 20;

  if (!series.length) {
    return el('div', { class: 'dim', style: { padding: '30px 0' } }, 'No study time logged yet.');
  }

  const values = series.map((d) => Number(d.hours ?? (d.seconds ?? 0) / 3600));
  const peak = Math.max(1, ...values);
  const step = series.length > 1 ? width / (series.length - 1) : width;

  const points = values.map((value, i) => [
    i * step,
    baseline - (value / peak) * (baseline - top),
  ]);

  const line = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = `${line} L${width} ${baseline} L0 ${baseline} Z`;
  const last = points[points.length - 1];

  const labelEvery = Math.max(1, Math.floor(series.length / 5));
  const labels = series.filter((_, i) => i % labelEvery === 0 || i === series.length - 1);

  return el('div', null,
    svg('svg', { viewBox: `0 0 ${width} ${height}`, class: 'chart', preserveAspectRatio: 'none', 'aria-hidden': 'true' },
      svg('line', { x1: 0, y1: baseline, x2: width, y2: baseline, stroke: 'var(--color-neutral-800)', 'stroke-width': 1 }),
      svg('line', { x1: 0, y1: (baseline + top) / 2, x2: width, y2: (baseline + top) / 2, stroke: 'var(--color-neutral-900)', 'stroke-width': 1 }),
      svg('path', { d: area, fill: 'var(--color-accent)', opacity: '0.10' }),
      svg('path', { d: line, fill: 'none', stroke: 'var(--color-accent)', 'stroke-width': 1.8, 'vector-effect': 'non-scaling-stroke' }),
      svg('circle', { cx: last[0], cy: last[1], r: 4, fill: 'var(--color-accent)' }),
    ),
    el('div', { class: 'chart-axis' }, labels.map((d) => el('span', { text: axisLabel(d.day) }))),
  );
}

function axisLabel(day) {
  const ts = Date.parse(day);
  return Number.isNaN(ts) ? String(day ?? '') : shortDate(ts);
}
