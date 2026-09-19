/**
 * The small sounds the app makes: a press, a right answer, a wrong one.
 *
 * Synthesised, for the same reason the soundscapes are — there is no audio in
 * the bundle and nothing is fetched. Every sound here is one or two oscillators
 * through an envelope lasting a tenth of a second or less. That is deliberate:
 * a UI sound that can be heard *as* a sound is a UI sound people switch off
 * within a day. These are meant to be felt more than heard.
 *
 * Nothing plays before the first press. A browser will not start an
 * AudioContext without a gesture anyway, and the first press is a gesture, so
 * the graph is built on the way through the first click that would use it.
 *
 * Off by default, because an app that starts making noises on a first run is
 * an app somebody quietly stops trusting. Settings → Sound turns it on.
 */
import { log } from './log.js';

const KEY = 'studex.sfx';

export const SFX_DEFAULTS = {
  on: false,      // click sounds
  volume: 45,     // 0–100
};

export function sfxPrefs() {
  try {
    return { ...SFX_DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...SFX_DEFAULTS };
  }
}

export function setSfxPrefs(patch) {
  const next = { ...sfxPrefs(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* this sitting only */ }
  prefs = next;
  return next;
}

/** Read once and kept, because this is consulted on every click in the app. */
let prefs = sfxPrefs();

/* ── the audio graph ───────────────────────────────────────────────────── */

let ctx = null;
let master = null;

function context() {
  if (ctx) return ctx;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);
  } catch (err) {
    log.warn('no audio for sound effects', err);
    return null;
  }
  return ctx;
}

/**
 * One tone with a percussive envelope.
 *
 * The attack is two milliseconds rather than zero — a gain that steps from
 * silence is a click on top of the sound, which is audible as a tick even when
 * the note itself is not. The release ends with a linear ramp, because an
 * exponential one cannot reach zero and leaves the oscillator ringing under
 * everything else.
 */
function tone(at, { freq, to = freq, type = 'sine', gain = 0.2, attack = 0.002, hold = 0.01, release = 0.06 }) {
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  if (to !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), at + attack + hold + release);
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(gain, at + attack);
  env.gain.setValueAtTime(gain, at + attack + hold);
  env.gain.linearRampToValueAtTime(0, at + attack + hold + release);
  osc.connect(env).connect(master);
  osc.start(at);
  osc.stop(at + attack + hold + release + 0.02);
}

/**
 * What each named sound is.
 *
 * Kept as data rather than as functions so the whole vocabulary can be read at
 * once and stays consistent: everything is quiet, everything is short, and the
 * pitches are the same handful of intervals so two sounds in a row do not
 * clash.
 */
const SOUNDS = {
  /** A press. The commonest sound in the app, so it is the quietest. */
  tap:    (t) => tone(t, { freq: 780, to: 620, type: 'triangle', gain: 0.1, release: 0.045 }),
  /** A press that turns something on or opens something. */
  toggle: (t) => { tone(t, { freq: 620, type: 'triangle', gain: 0.09, release: 0.04 }); tone(t + 0.045, { freq: 930, type: 'triangle', gain: 0.08, release: 0.06 }); },
  /** A card revealed, a step forward. */
  flip:   (t) => tone(t, { freq: 420, to: 700, type: 'sine', gain: 0.1, hold: 0.015, release: 0.07 }),
  /** Right. A rising fifth — the interval everything reads as "yes". */
  right:  (t) => { tone(t, { freq: 660, type: 'sine', gain: 0.13, release: 0.07 }); tone(t + 0.07, { freq: 990, type: 'sine', gain: 0.12, hold: 0.02, release: 0.1 }); },
  /** Wrong. Low, falling, and short enough not to feel like a telling-off. */
  wrong:  (t) => tone(t, { freq: 300, to: 190, type: 'sawtooth', gain: 0.075, hold: 0.02, release: 0.11 }),
  /** A sitting finished. Three notes up, under the confetti. */
  finish: (t) => {
    [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
      tone(t + i * 0.085, { freq, type: 'sine', gain: 0.11, hold: 0.03, release: 0.2 });
    });
  },
  /** Something was put somewhere: a drop, a file filed. */
  drop:   (t) => tone(t, { freq: 520, to: 340, type: 'triangle', gain: 0.11, hold: 0.012, release: 0.08 }),
  /** Something went wrong that was not the student's fault. */
  error:  (t) => { tone(t, { freq: 340, type: 'square', gain: 0.055, release: 0.05 }); tone(t + 0.1, { freq: 250, type: 'square', gain: 0.055, release: 0.09 }); },
};

/**
 * Play one of the sounds above, if sound is on.
 *
 * Never throws and never awaits: this is called from click handlers all over
 * the app, and a sound that cannot be made is not a reason for anything else
 * to stop.
 */
export function sfx(name) {
  if (!prefs.on) return;
  const sound = SOUNDS[name];
  if (!sound) return;
  try {
    if (!context()) return;
    // Safari suspends the context whenever it likes — on a tab change, on a
    // window being hidden — and a suspended context accepts every schedule
    // call and plays none of them.
    if (ctx.state === 'suspended') void ctx.resume();
    master.gain.value = Math.max(0, Math.min(1, prefs.volume / 100));
    sound(ctx.currentTime + 0.001);
  } catch (err) {
    log.warn('sound effect failed', err);
  }
}

/**
 * Plays a sound whether or not sound is on, for the Settings preview.
 *
 * Auditioning is the one place where the switch being off is not an answer:
 * you are turning it on, and you want to hear what you are turning on.
 */
export function auditionSfx(name, volume) {
  const was = prefs;
  prefs = { on: true, volume: volume ?? prefs.volume };
  try { sfx(name); } finally { prefs = was; }
}

/**
 * Every press in the app, without every press in the app having to ask.
 *
 * One listener on the document rather than a call in each handler: there are
 * several hundred buttons and they are built in twenty files, so the only
 * version of this that stays true is the one nothing has to remember. It runs
 * on `pointerdown` so the sound lands with the press rather than after the
 * work the click sets off, and it is deliberately blind to what the button
 * does — a press sounds like a press.
 */
export function initSfx() {
  document.addEventListener('pointerdown', (event) => {
    if (!prefs.on) return;
    const target = event.target instanceof Element ? event.target : null;
    const hit = target?.closest('button, [role="button"], .row, .sel, a[href]');
    if (!hit || hit.disabled || hit.getAttribute('aria-disabled') === 'true') return;
    // A view that plays its own sound for the press says so, and this stays
    // out of the way — two sounds on one press is a rattle.
    if (hit.closest('[data-quiet]')) return;
    const pressed = hit.getAttribute('aria-pressed') ?? hit.getAttribute('aria-expanded');
    sfx(pressed !== null ? 'toggle' : 'tap');
  }, true);
}
