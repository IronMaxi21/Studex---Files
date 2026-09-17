/**
 * Updates that arrive on their own.
 *
 * The Updates screen in Settings has always been able to find and install a
 * newer Studex, but only when somebody went looking. This is the part that
 * makes it behave like any other Mac app: it checks in the background, the
 * download happens quietly, and the student is asked once — "restart now, or
 * later" — when there is nothing left to do but swap the app. Choosing later
 * is not losing the update: the shell installs it as Studex quits.
 *
 * Only approved releases are ever seen here. Publishing puts a version in the
 * table as pending, and the feed the server reads leaves pending rows out, so
 * nothing reaches a Mac until the owner has approved it.
 *
 * Everything the student can tune lives in `studex.updates.*` (mirrored by the
 * shell, so it survives a relaunch): the channel, how often to look, and
 * whether to show what changed after an update. A critical release ignores
 * "later" and the auto-download switch — it exists because waiting is worse.
 */
import { el, icon } from './dom.js';
import { api } from './api.js';
import { dialog } from './dialog.js';
import { isNative, prepareUpdate, restartToUpdate, askUpdateStatus, watchUpdate } from './native.js';
import { log } from './log.js';

const FIRST_CHECK_MS = 15_000;
/** How often the timer wakes to see whether a check is due. */
const TICK_MS = 10 * 60 * 1000;
const CRITICAL_SNOOZE_MS = 10 * 60 * 1000;
const PREF_KEY = 'studex.autoUpdate';
const LATER_KEY = 'studex.updateLater';
const KEYS = {
  channel: 'studex.updates.channel',
  interval: 'studex.updates.interval',
  whatsNew: 'studex.updates.whatsNew',
  lastChecked: 'studex.updates.lastChecked',
  seen: 'studex.updates.seenVersion',
};

/** Hours between background checks; 0 means only when asked. */
export const INTERVALS = [
  { hours: 1, label: 'Hourly' },
  { hours: 4, label: 'Every 4 hours' },
  { hours: 24, label: 'Daily' },
  { hours: 168, label: 'Weekly' },
  { hours: 0, label: 'Only when I ask' },
];

let timer = null;
let card = null;
/** The last answer from the server, for its notes and history. */
let last = null;
/** The version the shell has downloaded and is waiting to swap in. */
let readyVersion = null;
let snoozeTimer = null;

const read = (key, fallback) => {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
};
const write = (key, value) => {
  try { localStorage.setItem(key, String(value)); } catch { /* per-device nicety only */ }
};

/** Whether this Mac downloads updates without being asked. On unless turned off. */
export function autoUpdateEnabled() {
  return read(PREF_KEY, 'on') !== 'off';
}

export function setAutoUpdate(on) {
  write(PREF_KEY, on ? 'on' : 'off');
  if (on) void checkForUpdates();
}

/** Every update preference, with its default filled in. */
export function updatePrefs() {
  const hours = Number(read(KEYS.interval, '4'));
  return {
    auto: autoUpdateEnabled(),
    channel: read(KEYS.channel, 'stable') === 'beta' ? 'beta' : 'stable',
    interval: INTERVALS.some((i) => i.hours === hours) ? hours : 4,
    whatsNew: read(KEYS.whatsNew, 'on') !== 'off',
    lastChecked: Number(read(KEYS.lastChecked, '0')) || null,
  };
}

export function setUpdatePref(name, value) {
  if (name === 'auto') return setAutoUpdate(value);
  if (name === 'whatsNew') return write(KEYS.whatsNew, value ? 'on' : 'off');
  if (name === 'interval') return write(KEYS.interval, value);
  if (name === 'channel') {
    write(KEYS.channel, value === 'beta' ? 'beta' : 'stable');
    // A different channel is a different answer; look again now.
    void checkForUpdates();
  }
}

/** What is known right now, for the Settings screen and its badge. */
export function updateStatus() {
  return {
    ready: readyVersion,
    available: last?.available ? last.latest?.version ?? null : null,
    critical: Boolean(last?.critical),
    last,
  };
}

/** Hears every change to `updateStatus()`. Returns the unsubscribe. */
export function onUpdateStatus(handler) {
  const listener = () => handler(updateStatus());
  window.addEventListener('studex:update-status', listener);
  return () => window.removeEventListener('studex:update-status', listener);
}

function changed() {
  window.dispatchEvent(new CustomEvent('studex:update-status'));
}

/** Starts the background loop, once, after sign-in. */
export function startUpdates() {
  if (timer || !isNative) return;
  watchUpdate(onProgress);
  // A window opened after another one finished the download should still offer
  // the restart, so the shell is asked what is already waiting.
  askUpdateStatus();
  timer = setInterval(() => { if (due()) void checkForUpdates(); }, TICK_MS);
  setTimeout(() => {
    void checkForUpdates().finally(() => { void showWhatsNew(); });
  }, FIRST_CHECK_MS);
}

function due() {
  const { interval, lastChecked } = updatePrefs();
  if (!interval) return false;
  return !lastChecked || Date.now() - lastChecked >= interval * 3600_000;
}

/**
 * Asks the server what is out there on this Mac's channel, and hands anything
 * newer to the shell to download. `manual` reports failures to the caller
 * rather than swallowing them, and downloads even with auto-download off.
 */
export async function checkForUpdates({ manual = false } = {}) {
  const prefs = updatePrefs();
  if (!manual && !prefs.auto && !prefs.interval) return null;
  try {
    const { update } = await api.checkUpdate({ channel: prefs.channel });
    last = update;
    write(KEYS.lastChecked, Date.now());
    changed();
    if (update?.available && update.latest && update.canInstall
        && (manual || prefs.auto || update.critical)) {
      prepareUpdate(update.latest);
    }
    return update;
  } catch (err) {
    if (manual) throw err;
    // Background work: a failed check is retried at the next interval, and
    // saying so on screen every few hours would be noise.
    log.warn('background update check failed', err);
    return null;
  }
}

function onProgress(step) {
  if (step.stage === 'ready' && step.version) {
    readyVersion = step.version;
    changed();
    const critical = last?.latest?.version === step.version && last.critical;
    if (!critical && laterFor() === step.version) return;
    showCard(step.version, critical);
  } else if (step.stage === 'failed') {
    changed();
    if (card) {
      card.querySelector('.update-card-body').textContent = step.message ?? 'The update could not be installed.';
      card.classList.add('bad');
    }
  } else if ((step.stage === 'installing' || step.stage === 'relaunching') && card) {
    card.querySelector('.update-card-body').textContent = 'Putting the new version in place…';
  }
}

function laterFor() {
  try { return sessionStorage.getItem(LATER_KEY); } catch { return null; }
}

/** The notes of every release between `from` (exclusive) and `to`, newest first. */
function notesBetween(releases, from, to) {
  return (releases ?? []).filter((r) => r.notes
    && (!from || compareVersions(r.version, from) > 0)
    && compareVersions(r.version, to) <= 0);
}

function notesBlock(entries) {
  return el('div', { class: 'release-notes' },
    ...entries.map((r) => el('section', { class: 'release-notes-entry' },
      el('div', { class: 'release-notes-head' },
        el('strong', { text: `Version ${r.version}` }),
        r.channel === 'beta' ? el('span', { class: 'pill', text: 'Beta' }) : null,
        r.critical ? el('span', { class: 'pill behind', text: 'Important' }) : null,
        r.publishedAt ? el('span', { class: 'dim', text: formatDate(r.publishedAt) }) : null,
      ),
      el('div', { class: 'release-notes-body', text: r.notes }),
    )),
  );
}

export function formatDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function showCard(version, critical = false) {
  card?.remove();
  clearTimeout(snoozeTimer);
  const running = last?.version ?? null;
  const entries = notesBetween(last?.missed ?? last?.releases, running, version);
  const body = el('div', {
    class: 'update-card-body dim',
    text: critical
      ? 'This update fixes something important. Restart to install it — your work is saved first.'
      : 'Restart to finish updating. If you choose later, it installs when you quit Studex.',
  });
  const restart = el('button', { class: 'btn primary', text: 'Restart now', onclick: () => {
    restart.disabled = true;
    restartToUpdate();
  } });
  const later = el('button', { class: 'btn', text: critical ? 'In 10 minutes' : 'Later', onclick: () => {
    card?.remove();
    card = null;
    if (critical) {
      snoozeTimer = setTimeout(() => showCard(version, true), CRITICAL_SNOOZE_MS);
      return;
    }
    try { sessionStorage.setItem(LATER_KEY, version); } catch { /* shown again next launch */ }
  } });

  card = el('div', { class: critical ? 'update-card critical' : 'update-card', role: 'status', 'aria-live': 'polite' },
    el('div', { class: 'update-card-head' },
      icon(critical ? 'warning-circle' : 'arrow-circle-up', { class: critical ? 'warn' : 'ok' }),
      el('strong', { text: `Studex ${version} is ready` }),
    ),
    body,
    entries.length ? el('details', { class: 'update-card-notes' },
      el('summary', { text: entries.length > 1 ? `What's new in ${entries.length} updates` : "What's new" }),
      notesBlock(entries),
    ) : null,
    el('div', { class: 'update-card-actions' }, later, restart),
  );
  document.body.appendChild(card);
}

/**
 * After an update, once: what changed since the version this Mac last ran.
 * The first launch ever only records the version — there is nothing to
 * compare it with, and onboarding is already talking.
 */
async function showWhatsNew() {
  let current = last?.version ?? null;
  if (!current) {
    try { current = (await api.updateState()).update?.version ?? null; } catch { return; }
  }
  if (!current) return;
  const seen = read(KEYS.seen, null);
  write(KEYS.seen, current);
  if (!seen || seen === current || compareVersions(current, seen) < 0) return;
  if (!updatePrefs().whatsNew) return;

  const entries = notesBetween(last?.releases, seen, current);
  await dialog({
    title: `Studex is now ${current}`,
    wide: entries.length > 0,
    body: el('div', { class: 'whats-new' },
      el('p', { class: 'dim', text: entries.length
        ? `Updated from ${seen}. Here is what changed.`
        : `Updated from ${seen}.` }),
      entries.length ? notesBlock(entries) : null,
      el('p', { class: 'dim small', text: 'You can turn this off in Settings → Updates.' }),
    ),
    confirmLabel: 'Done',
    cancelLabel: null,
  });
}

/** Same rule as the server's: numbers as numbers, a pre-release before its release. */
export function compareVersions(a, b) {
  const split = (v) => {
    const [core = '', ...rest] = String(v).split('-');
    return [core.split('.').map((n) => Number.parseInt(n, 10) || 0), rest.join('-')];
  };
  const [an, apre] = split(a);
  const [bn, bpre] = split(b);
  for (let i = 0; i < Math.max(an.length, bn.length); i += 1) {
    const diff = (an[i] ?? 0) - (bn[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  if (apre === bpre) return 0;
  if (!apre) return 1;
  if (!bpre) return -1;
  return apre < bpre ? -1 : 1;
}
