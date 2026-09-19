/**
 * Background sound for a focus block, synthesised rather than played back.
 *
 * Every sound here is noise put through filters. There is no audio in the
 * bundle and nothing is fetched: rain is not a recording of rain, it is noise
 * shaped until it is indistinguishable from one at the volume this is meant to
 * be heard at. That is the whole reason for the approach — a decent loop of
 * rain is several megabytes, it repeats audibly after a minute, and it would
 * have to come down the wire on a train with no signal, which is exactly where
 * somebody is most likely to want it.
 *
 * Nothing starts without a press. Browsers will not let audio begin before a
 * gesture, and neither would we: a study app that starts making noise on its
 * own is a study app people turn off.
 */

/** What the picker offers, in the order it offers them. */
export const SOUNDSCAPES = [
  { id: 'off',    label: 'Off',       icon: 'speaker-simple-slash', hint: 'Silence' },
  { id: 'rain',   label: 'Rain',      icon: 'cloud-rain',  hint: 'Steady rain on a window' },
  { id: 'ocean',  label: 'Ocean',     icon: 'waves',       hint: 'Slow waves, a long way out' },
  { id: 'stream', label: 'Stream',    icon: 'drop',        hint: 'Water over stones' },
  { id: 'wind',   label: 'Wind',      icon: 'wind',        hint: 'Air through trees' },
  { id: 'fire',   label: 'Fireplace', icon: 'fire-simple', hint: 'A fire with the odd crackle' },
  { id: 'hum',    label: 'Deep hum',  icon: 'circle-half', hint: 'Low, even, almost nothing' },
];

export const soundscapeLabel = (id) => SOUNDSCAPES.find((s) => s.id === id)?.label ?? 'Off';

/* ── the audio graph ───────────────────────────────────────────────────── */

let ctx = null;
let master = null;
/** Everything the current sound made, so stopping is one loop and not a list. */
let voice = null;
let current = 'off';
let level = 0.45;

const FADE = 1.1; // seconds, long enough that neither end of a sound is a click

function context() {
  if (ctx) return ctx;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  master = ctx.createGain();
  master.gain.value = 0;
  master.connect(ctx.destination);
  return ctx;
}

/**
 * Four seconds of noise, made once and looped.
 *
 * `white` is flat; `brown` is white integrated, which tilts it heavily towards
 * the bottom and is what almost everything soft in nature sounds like. Four
 * seconds is long enough that the loop point is not a rhythm and short enough
 * that generating it is not felt.
 */
const buffers = new Map();
function noise(kind) {
  if (buffers.has(kind)) return buffers.get(kind);
  const seconds = 4;
  const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  if (kind === 'brown') {
    let last = 0;
    for (let i = 0; i < data.length; i += 1) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    }
  } else {
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
  }
  // The last 200 ms is crossfaded into the first, so the loop has no seam.
  const tail = Math.min(data.length >> 3, ctx.sampleRate * 0.2) | 0;
  for (let i = 0; i < tail; i += 1) {
    const t = i / tail;
    data[data.length - tail + i] = data[data.length - tail + i] * (1 - t) + data[i] * t;
  }
  buffers.set(kind, buffer);
  return buffer;
}

const source = (kind) => {
  const node = ctx.createBufferSource();
  node.buffer = noise(kind);
  node.loop = true;
  return node;
};

/** A very slow oscillator, for the movement that keeps a loop from sounding like one. */
function drift({ rate, depth, target, centre }) {
  const lfo = ctx.createOscillator();
  lfo.frequency.value = rate;
  const amount = ctx.createGain();
  amount.gain.value = depth;
  lfo.connect(amount).connect(target);
  if (centre !== undefined) target.value = centre;
  lfo.start();
  return [lfo, amount];
}

/* ── the sounds ────────────────────────────────────────────────────────── */

/**
 * Each builder returns the nodes it started and connects itself to `out`. The
 * shapes are the obvious ones: rain is bright noise with a little movement,
 * ocean is dark noise that swells, wind is a resonant sweep, fire is a low bed
 * with transients scheduled on top.
 */
const BUILD = {
  rain(out) {
    const src = source('white');
    const body = ctx.createBiquadFilter();
    body.type = 'bandpass'; body.frequency.value = 1400; body.Q.value = 0.5;
    const roof = ctx.createBiquadFilter();
    roof.type = 'lowpass'; roof.frequency.value = 6500;
    src.connect(body).connect(roof).connect(out);
    src.start();
    // Rain is not even — it comes in and goes off, over about half a minute.
    const [lfo, amp] = drift({ rate: 0.035, depth: 500, target: body.frequency, centre: 1400 });
    return [src, lfo, amp];
  },

  ocean(out) {
    const src = source('brown');
    const roof = ctx.createBiquadFilter();
    roof.type = 'lowpass'; roof.frequency.value = 500; roof.Q.value = 0.7;
    const swell = ctx.createGain();
    swell.gain.value = 0.55;
    src.connect(roof).connect(swell).connect(out);
    src.start();
    // One wave every eleven seconds or so, which is about right for open water.
    const [lfo, amp] = drift({ rate: 0.09, depth: 0.42, target: swell.gain, centre: 0.55 });
    const [lfo2, amp2] = drift({ rate: 0.09, depth: 280, target: roof.frequency, centre: 620 });
    return [src, lfo, amp, lfo2, amp2];
  },

  stream(out) {
    const src = source('white');
    const body = ctx.createBiquadFilter();
    body.type = 'bandpass'; body.frequency.value = 2600; body.Q.value = 0.35;
    const bed = source('brown');
    const bedRoof = ctx.createBiquadFilter();
    bedRoof.type = 'lowpass'; bedRoof.frequency.value = 400;
    const bedGain = ctx.createGain();
    bedGain.gain.value = 0.5;
    src.connect(body).connect(out);
    bed.connect(bedRoof).connect(bedGain).connect(out);
    src.start(); bed.start();
    // Faster than rain: water over stones is busy.
    const [lfo, amp] = drift({ rate: 0.22, depth: 700, target: body.frequency, centre: 2600 });
    return [src, bed, lfo, amp];
  },

  wind(out) {
    const src = source('brown');
    const throat = ctx.createBiquadFilter();
    throat.type = 'bandpass'; throat.frequency.value = 420; throat.Q.value = 2.2;
    const gust = ctx.createGain();
    gust.gain.value = 0.8;
    src.connect(throat).connect(gust).connect(out);
    src.start();
    const [lfo, amp] = drift({ rate: 0.06, depth: 260, target: throat.frequency, centre: 480 });
    const [lfo2, amp2] = drift({ rate: 0.045, depth: 0.45, target: gust.gain, centre: 0.7 });
    return [src, lfo, amp, lfo2, amp2];
  },

  fire(out) {
    const src = source('brown');
    const roof = ctx.createBiquadFilter();
    roof.type = 'lowpass'; roof.frequency.value = 760;
    const bed = ctx.createGain();
    bed.gain.value = 0.7;
    src.connect(roof).connect(bed).connect(out);
    src.start();
    const [lfo, amp] = drift({ rate: 0.13, depth: 0.22, target: bed.gain, centre: 0.7 });

    // The crackles, which are what makes it a fire rather than a rumble. Each
    // one is a few milliseconds of bright noise with a hard envelope, and the
    // gaps are random so the ear never finds a pattern to follow.
    let timer = null;
    const pop = () => {
      const burst = ctx.createBufferSource();
      burst.buffer = noise('white');
      burst.loop = false;
      const shaped = ctx.createBiquadFilter();
      shaped.type = 'bandpass';
      shaped.frequency.value = 1200 + Math.random() * 2600;
      shaped.Q.value = 1.4;
      const env = ctx.createGain();
      const at = ctx.currentTime;
      const peak = 0.1 + Math.random() * 0.22;
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(peak, at + 0.004);
      env.gain.exponentialRampToValueAtTime(0.0001, at + 0.05 + Math.random() * 0.09);
      burst.connect(shaped).connect(env).connect(out);
      burst.start(at, Math.random() * 3);
      burst.stop(at + 0.2);
      timer = setTimeout(pop, 120 + Math.random() * 900);
    };
    timer = setTimeout(pop, 400);
    return [src, lfo, amp, { stop: () => clearTimeout(timer) }];
  },

  hum(out) {
    const src = source('brown');
    const roof = ctx.createBiquadFilter();
    roof.type = 'lowpass'; roof.frequency.value = 190;
    src.connect(roof).connect(out);
    src.start();
    const [lfo, amp] = drift({ rate: 0.02, depth: 40, target: roof.frequency, centre: 200 });
    return [src, lfo, amp];
  },
};

/* ── control ───────────────────────────────────────────────────────────── */

function teardown(nodes, at) {
  for (const node of nodes) {
    try { node.stop?.(at); } catch { /* already stopped */ }
  }
  // Disconnecting after the fade rather than at it, or the tail is cut off.
  setTimeout(() => { for (const node of nodes) { try { node.disconnect?.(); } catch { /* gone */ } } }, (FADE + 0.4) * 1000);
}

/**
 * Starts `id`, fading whatever was playing out underneath it. Called from a
 * press, always — `resume()` on a context the browser suspended needs one.
 */
export function playSoundscape(id, volume = level) {
  level = clamp(volume);
  if (!id || id === 'off') { stopSoundscape(); return; }
  if (!BUILD[id]) return;
  if (!context()) return;
  void ctx.resume?.();

  if (voice && current === id) { fade(level); return; }
  if (voice) teardown(voice, ctx.currentTime + FADE);

  const bus = ctx.createGain();
  bus.gain.value = 1;
  bus.connect(master);
  const made = BUILD[id](bus);
  voice = [...made, bus];
  current = id;
  fade(level);
}

/**
 * Plays a sound as a sample rather than as part of a session.
 *
 * Settings needs to be able to audition rain without starting a focus block,
 * and the timer's own bookkeeping would stop it again the moment anything
 * emitted — so a held sound ignores stop() until it is released. One holder at
 * a time, which is all there has ever been.
 */
export function auditionSoundscape(id, volume) {
  holding = false;          // so a switch between samples is not blocked
  playSoundscape(id, volume);
  holding = id !== 'off';
}

export function releaseSoundscape() {
  holding = false;
  stopSoundscape();
}

let holding = false;

export function stopSoundscape() {
  if (holding) return;
  current = 'off';
  if (!ctx || !voice) return;
  const going = voice;
  voice = null;
  fade(0);
  teardown(going, ctx.currentTime + FADE);
}

/** Quietens without stopping, for a paused timer. */
export function duckSoundscape(down) {
  if (!ctx || !voice) return;
  fade(down ? level * 0.25 : level);
}

export function setSoundscapeVolume(volume) {
  level = clamp(volume);
  if (voice) fade(level);
}

export const soundscapePlaying = () => Boolean(voice);
export const soundscapeCurrent = () => current;

function clamp(v) { return Math.max(0, Math.min(1, Number(v) || 0)); }

function fade(to) {
  if (!master) return;
  const now = ctx.currentTime;
  master.gain.cancelScheduledValues(now);
  master.gain.setValueAtTime(master.gain.value, now);
  // A gain ramp that ends at silence has to be linear; exponential never gets
  // there, and the last inaudible fraction would keep the graph alive.
  master.gain.linearRampToValueAtTime(to, now + FADE);
}
