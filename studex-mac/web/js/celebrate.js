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
import { api } from './api.js';
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
 * Paper over the window, for the end of a sitting.
 *
 * Drawn on a canvas rather than built out of elements: a hundred nodes with
 * their own transforms make the compositor do a hundred layers of work every
 * frame, and this has to run while the finish screen is fading in behind it.
 * One canvas, one draw call per piece, and the whole thing removes itself the
 * frame after the last piece has fallen past the bottom.
 *
 * The colours are the app's own — read off the theme, so confetti in the
 * organic theme is not the same paper as confetti in the default one.
 *
 * @param {object} [opts]
 * @param {number} [opts.count]    How many pieces. Scaled down on a small window.
 * @param {number} [opts.spread]   Fraction of the width the pieces launch across.
 * @param {number} [opts.originY]  Where they launch from, 0 top, 1 bottom.
 */
export function confetti({ count = 110, spread = 0.7, originY = 0.62 } = {}) {
  // Reduced motion means reduced motion. Nothing falls, and nothing is left
  // behind either — the finish screen says the same thing in words.
  if (quiet()) return;

  const canvas = el('canvas', { class: 'confetti-layer', 'aria-hidden': 'true' });
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = window.innerWidth;
  const height = window.innerHeight;
  canvas.width = Math.floor(width * ratio);
  canvas.height = Math.floor(height * ratio);
  ctx.scale(ratio, ratio);
  document.body.appendChild(canvas);

  // Most of the tokens are `color-mix(...)` or `oklch(...)` expressions, and a
  // canvas fillStyle takes a colour, not an expression — assigning one is
  // silently ignored and every piece comes out the colour before it. So they
  // are resolved the only way a stylesheet can be asked to do arithmetic: set
  // them on a real element and read back what the engine computed.
  const probe = el('span', { style: { position: 'absolute', opacity: '0', pointerEvents: 'none' } });
  document.body.appendChild(probe);
  const resolve = (expr, fallback) => {
    try {
      probe.style.color = '';
      probe.style.color = expr;
      const value = getComputedStyle(probe).color;
      return value && value !== 'rgba(0, 0, 0, 0)' ? value : fallback;
    } catch { return fallback; }
  };
  const palette = [
    resolve('var(--color-accent)', '#7aa2f7'),
    resolve('var(--color-accent-300)', '#9db7ff'),
    resolve('var(--color-accent-700)', '#3f5fb0'),
    resolve('var(--color-danger)', '#e2707a'),
    resolve('color-mix(in oklab, var(--color-accent) 40%, #f2c14e)', '#f2c14e'),
    resolve('var(--color-text)', '#e6e6e6'),
  ];
  probe.remove();

  // Fewer pieces in a small window: the density is what reads as celebration,
  // not the count, and a narrow pane fills up at half of this.
  const pieces = Array.from({ length: Math.round(count * Math.min(1, width / 1100 + 0.35)) }, () => {
    const angle = (Math.random() - 0.5) * 1.5 - Math.PI / 2;
    const speed = 9 + Math.random() * 11;
    return {
      x: width * (0.5 + (Math.random() - 0.5) * spread),
      y: height * originY,
      vx: Math.cos(angle) * speed * (0.6 + Math.random() * 0.8),
      vy: Math.sin(angle) * speed,
      w: 5 + Math.random() * 6,
      h: 7 + Math.random() * 8,
      spin: (Math.random() - 0.5) * 0.4,
      turn: Math.random() * Math.PI,
      tilt: Math.random() * Math.PI,
      fill: palette[Math.floor(Math.random() * palette.length)],
    };
  });

  const GRAVITY = 0.42;
  const DRAG = 0.985;
  let frames = 0;
  const step = () => {
    frames += 1;
    ctx.clearRect(0, 0, width, height);
    let alive = 0;
    for (const p of pieces) {
      p.vy += GRAVITY;
      p.vx *= DRAG;
      p.x += p.vx;
      p.y += p.vy;
      p.turn += p.spin;
      p.tilt += 0.08;
      if (p.y - p.h > height) continue;
      alive += 1;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.turn);
      // A flat rectangle seen edge-on is what makes paper look like paper:
      // scaling the height by a sine is a tumble without a 3-D transform.
      ctx.scale(1, Math.cos(p.tilt));
      ctx.globalAlpha = Math.max(0, 1 - frames / 190);
      ctx.fillStyle = p.fill;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    // Belt and braces: the fade runs out at 190 frames whatever the physics do,
    // so a piece caught in a browser that has stopped stepping cannot pin a
    // full-window canvas over the app for ever.
    if (alive && frames < 200) requestAnimationFrame(step);
    else canvas.remove();
  };
  requestAnimationFrame(step);
}

/**
 * Runs worth stopping for. A week is the first one that feels like a habit
 * rather than a few days in a row; after a hundred the paper would be coming
 * out every day, so the list simply ends.
 */
const MILESTONES = new Set([7, 14, 30, 50, 100, 200, 365]);

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
        el('div', { class: 'streak-burst-label', text: MILESTONES.has(to) ? `${to} days!` : best && to > 1 ? 'New best streak!' : to === 1 ? 'Streak started' : 'Streak extended' }),
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
      // A round number gets paper of its own, thrown from the card rather than
      // from the middle of the window, so it reads as coming off the flame.
      if (MILESTONES.has(to)) setTimeout(() => confetti({ count: 80, spread: 0.45, originY: 0.5 }), quiet() ? 0 : 520);
    });
    setTimeout(close, quiet() ? 1800 : MILESTONES.has(to) ? 3600 : 2800);
  });
}

/**
 * The day's figures, to be held over a sitting and compared at the end of it.
 * Never throws: a celebration is not worth an error.
 */
export function studyDay() {
  return api.studyToday().catch(() => null);
}

/**
 * Show the streak moving, if this sitting is what moved it.
 *
 * Any sitting can be the first study of the day — a review, a test, a lesson —
 * and each of them writes the same review log, so each of them can be the one
 * that counts the day. This is where that comparison lives, so a screen only
 * has to remember what the figures were when it started.
 *
 * @param {object|null} before  What `studyDay()` returned at the start.
 * @returns {Promise<{from:number,to:number,best:boolean}|null>} null if nothing moved.
 */
export async function celebrateIfStreakGrew(before) {
  const after = await studyDay();
  const from = before?.streak_days ?? 0;
  const to = after?.streak_days ?? from;
  if (!after || to <= from) return null;
  const best = to >= (after.best_streak_days ?? 0) && to > (before?.best_streak_days ?? 0);
  await celebrateStreak({ from, to, best });
  return { from, to, best };
}
