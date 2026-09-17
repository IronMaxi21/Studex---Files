/**
 * The moment a day is counted.
 *
 * The streak used to change silently: a number on the home screen that was
 * one higher the next time you happened to look. Finishing the first review
 * of the day is the one moment it actually moves, so that is when it is shown
 * moving — the flame lights, the count rolls from yesterday's to today's, and
 * a few sparks go up. Then it gets out of the way on its own.
 */
import { el, icon } from './dom.js';
import { plural } from './format.js';

const quiet = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** A number that counts up to `to` from `from`. */
export function rollNumber(node, from, to, ms = 700) {
  if (quiet() || from === to) { node.textContent = String(to); return; }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / ms);
    const eased = 1 - (1 - t) ** 3;
    node.textContent = String(Math.round(from + (to - from) * eased));
    if (t < 1) requestAnimationFrame(step);
  };
  node.textContent = String(from);
  requestAnimationFrame(step);
}

/**
 * The full celebration, over whatever is on screen. Resolves once it has gone.
 * `best` marks a new personal best.
 */
export function celebrateStreak({ from, to, best = false }) {
  return new Promise((resolve) => {
    const count = el('span', { class: 'streak-burst-n', text: String(from) });
    const sparks = el('div', { class: 'streak-sparks', 'aria-hidden': 'true' },
      Array.from({ length: 14 }, (_, i) => {
        // Custom properties cannot go through Object.assign on a style.
        const spark = el('i');
        spark.style.setProperty('--a', `${(360 / 14) * i + (Math.random() * 16 - 8)}deg`);
        spark.style.setProperty('--d', `${70 + Math.random() * 60}px`);
        spark.style.setProperty('--delay', `${Math.random() * 120}ms`);
        return spark;
      }),
    );
    const veil = el('div', { class: 'streak-burst', role: 'status', 'aria-live': 'polite' },
      el('div', { class: 'streak-burst-card' },
        sparks,
        el('div', { class: 'streak-flame' }, icon('flame', { size: 64, bold: true })),
        el('div', { class: 'streak-burst-count' }, count, el('span', { class: 'unit', text: to === 1 ? 'day' : 'days' })),
        el('div', { class: 'streak-burst-label', text: best && to > 1 ? 'New best streak!' : to === 1 ? 'Streak started' : 'Streak extended' }),
        el('div', { class: 'streak-burst-sub', text: to === 1 ? 'Come back tomorrow to make it two.' : `${plural(to, 'day')} in a row. See you tomorrow.` }),
      ),
    );

    let gone = false;
    const close = () => {
      if (gone) return;
      gone = true;
      veil.classList.remove('in');
      document.removeEventListener('keydown', close, true);
      setTimeout(() => { veil.remove(); resolve(); }, 220);
    };
    veil.addEventListener('click', close);
    document.addEventListener('keydown', close, true);
    document.body.appendChild(veil);

    requestAnimationFrame(() => {
      veil.classList.add('in');
      setTimeout(() => rollNumber(count, from, to, 650), quiet() ? 0 : 380);
    });
    setTimeout(close, quiet() ? 1800 : 2800);
  });
}
