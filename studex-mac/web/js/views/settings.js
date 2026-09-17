/** Screen 10 — Settings. Appearance, study, account and sessions. */
import { el, icon, mount } from '../dom.js';
import { api } from '../api.js';
import { glassEnabled, setGlassEnabled, highContrast, setHighContrast, accentPrefs, setAccentPrefs, savedPalettes, savePalette, deletePalette, densityPrefs, setDensityPrefs, state, loadLibrary, applyTheme, deviceId, toast, reportError, rerender, fileById, folderById } from '../store.js';
import { navigate } from '../router.js';
import { topbar } from '../shell.js';
import { bytes } from '../format.js';
import { dialog, confirmDialog, promptText } from '../dialog.js';
import { showProFeatures, PRO_MULTIPLIER, FREE_INCLUDES } from '../pro.js';
import {
  isNative, prepareUpdate, restartToUpdate, askUpdateStatus, watchUpdate, notificationAccess, requestNotificationAccess,
  lockSettings, setLockSettings, lockNow,
} from '../native.js';
import { syncSpotlight } from '../spotlight.js';
import { updatePrefs, setUpdatePref, updateStatus, onUpdateStatus, checkForUpdates, compareVersions, formatDate, INTERVALS } from '../updates.js';
import { resetAiStatus } from '../ai.js';
import {
  shortcutList, formatKeys, remappableShortcuts, bindingConflict, setBinding,
  clearBinding, resetBindings, hasCustomBindings, comboFromEvent,
} from '../shortcuts.js';
import { drawTrash } from './trash.js';
import { dropdown } from '../select.js';
import { studyPrefs, saveStudyPrefs, STUDY_DEFAULTS } from '../studyprefs.js';
import { focusPrefs, setFocusPrefs, openFocus } from '../focus.js';
import { speechAvailable } from '../speak.js';

/**
 * Every screen, and the words someone might type looking for it. The search
 * box matches the label and these, so "dark mode" finds Appearance and
 * "password" finds Lock without anyone learning where things were filed.
 */
const SECTIONS = [
  { id: 'appearance', label: 'Appearance', icon: 'paint-brush', keywords: 'theme dark light mode accent colour color density glass contrast palette font' },
  { id: 'workspace', label: 'Workspace', icon: 'layout', keywords: 'layout sidebar shell dock tabs paper grid page width type size reading font spotlight' },
  { id: 'study', label: 'Study', icon: 'graduation-cap', keywords: 'cards review spaced repetition quiz goal focus timer pomodoro speech voice' },
  { id: 'notifications', label: 'Notifications', icon: 'bell', keywords: 'alerts reminders banners sound' },
  { id: 'plan', label: 'Plan', icon: 'sparkle', keywords: 'pro subscription billing upgrade' },
  { id: 'sync', label: 'Sync', icon: 'cloud-arrow-up', keywords: 'cloud backup devices supabase offline' },
  { id: 'sharing', label: 'Sharing', icon: 'share-network', keywords: 'share link collaborate public' },
  { id: 'lock', label: 'Lock', icon: 'lock-key', keywords: 'password passcode touch id privacy security' },
  { id: 'ai', label: 'AI', icon: 'sparkle', keywords: 'gemini openrouter model key assistant chat' },
  { id: 'shortcuts', label: 'Keyboard shortcuts', icon: 'keyboard', keywords: 'keys hotkeys commands' },
  { id: 'updates', label: 'Updates', icon: 'arrow-clockwise', keywords: 'version upgrade release beta channel changelog what\'s new download dmg install' },
  { id: 'data', label: 'Your data', icon: 'export', keywords: 'export import backup download delete library' },
  { id: 'trash', label: 'Trash', icon: 'trash', keywords: 'deleted restore bin recover' },
  { id: 'account', label: 'Account', icon: 'user', keywords: 'profile email name sign out log out' },
  { id: 'sessions', label: 'Sessions', icon: 'devices', keywords: 'signed in devices macs log out everywhere' },
];

/** Keeps what was typed while moving between screens, which rebuilds the nav. */
let settingsQuery = '';

/** The design's five accent swatches: one hue family at one lightness. */
const ACCENTS = [
  { hex: '#8a88b8', hue: 289, name: 'Slate purple' },
  { hex: '#7896b4', hue: 240, name: 'Blue' },
  { hex: '#739f8c', hue: 165, name: 'Green' },
  { hex: '#a89a6e', hue: 90, name: 'Olive' },
  { hex: '#b58a80', hue: 34, name: 'Clay' },
  { hex: '#8b9099', hue: 260, name: 'Grey', chroma: 0.015 },
];

const SHELLS = [
  { id: 'folder_tree', name: 'Folder tree', desc: 'One sidebar, everything nested.' },
  { id: 'icon_rail', name: 'Icon rail', desc: "Rail for sections, panel for the folder you're in." },
  { id: 'workspace_tabs', name: 'Workspace tabs', desc: 'No sidebar; open files as tabs with a floating dock.' },
];

const CHROMES = [
  { id: 'floating_dock', name: 'Floating dock', desc: 'Tools centred, minimap bottom-right.' },
  { id: 'tool_column', name: 'Tool column', desc: 'Fixed left column plus a properties strip.' },
];

export async function settingsView(route, host) {
  const section = route.path[1] ?? 'appearance';
  const settings = state.settings;
  const device = state.device;

  const body = el('div', { class: 'settings-body' });

  const navItems = SECTIONS.map((s) => el('button', {
    class: 'nav-item' + (section === s.id ? ' active' : ''),
    'aria-current': section === s.id ? 'page' : null,
    dataset: { section: s.id },
    onclick: () => navigate(`settings/${s.id}`),
  }, icon(s.icon), el('span', { class: 'grow', text: s.label }),
    s.id === 'updates' ? updatesBadge() : null));
  const noMatch = el('div', { class: 'dim settings-nomatch hidden', text: 'No settings match.' });
  const matches = (s, q) => `${s.label} ${s.keywords}`.toLowerCase().includes(q);
  const filter = () => {
    const q = settingsQuery.trim().toLowerCase();
    let shown = 0;
    SECTIONS.forEach((s, i) => {
      const hit = !q || matches(s, q);
      navItems[i].classList.toggle('hidden', !hit);
      if (hit) shown += 1;
    });
    noMatch.classList.toggle('hidden', shown > 0);
  };
  const search = el('input', {
    class: 'input small settings-search',
    type: 'search',
    placeholder: 'Search settings',
    'aria-label': 'Search settings',
    value: settingsQuery,
    oninput: (e) => { settingsQuery = e.target.value; filter(); },
    onkeydown: (e) => {
      if (e.key === 'Enter') {
        const q = settingsQuery.trim().toLowerCase();
        const first = SECTIONS.find((s) => q && matches(s, q));
        if (first) navigate(`settings/${first.id}`);
      } else if (e.key === 'Escape' && settingsQuery) {
        e.stopPropagation();
        settingsQuery = '';
        e.target.value = '';
        filter();
      }
    },
  });
  filter();

  mount(host,
    topbar(['Settings', SECTIONS.find((s) => s.id === section)?.label ?? 'Appearance']),
    el('div', { class: 'settings' },
      el('nav', { class: 'settings-nav', 'aria-label': 'Settings sections' },
        el('div', { class: 'section-label plain', style: { padding: '0 10px 12px' }, text: 'SETTINGS' }),
        search,
        ...navItems,
        noMatch,
        el('button', {
          class: 'plan-card' + (section === 'plan' ? ' on' : ''),
          'aria-current': section === 'plan' ? 'page' : null,
          onclick: () => navigate('settings/plan'),
        },
          el('div', { class: 'name', text: `Studex ${planLabel(state.user?.plan)}` }),
          el('div', { class: 'sub', text: state.user?.plan === 'pro' ? 'Change plan' : 'See what Pro adds' }),
        ),
      ),
      body,
    ),
  );

  if (section === 'appearance') drawAppearance(body, settings, device);
  else if (section === 'workspace') drawWorkspace(body, device);
  else if (section === 'study') drawStudy(body, settings);
  else if (section === 'notifications') drawNotifications(body, settings);
  else if (section === 'plan') drawPlan(body);
  else if (section === 'sync') drawSync(body);
  else if (section === 'sharing') drawSharing(body);
  else if (section === 'lock') drawLock(body);
  else if (section === 'ai') drawAi(body);
  else if (section === 'shortcuts') drawShortcuts(body);
  // The only settings screen that subscribes to anything, so the only one with
  // something to give back when the route moves on.
  else if (section === 'updates') return drawUpdates(body);
  else if (section === 'data') drawData(body);
  else if (section === 'trash') await drawTrash(body);
  else if (section === 'account') drawAccount(body);
  else drawSessions(body);
}

/**
 * A dot beside Updates when there is something to do there. It listens for as
 * long as it is on screen and lets go once the nav is rebuilt.
 */
function updatesBadge() {
  const dot = el('span', { class: 'nav-badge hidden', 'aria-hidden': 'true' });
  const paint = (status) => {
    if (!dot.isConnected && dot.dataset.drawn) { stop(); return; }
    dot.dataset.drawn = '1';
    const due = Boolean(status.ready || status.available);
    dot.classList.toggle('hidden', !due);
    dot.classList.toggle('warn', status.critical);
    dot.textContent = status.ready ? 'Ready' : status.available ? 'New' : '';
  };
  const stop = onUpdateStatus(paint);
  paint(updateStatus());
  return dot;
}

/* ── account-level settings write through to the API ──────────────────── */

async function patchAccount(patch) {
  try {
    const res = await api.updateSettings(patch);
    state.settings = res.settings;
    applyTheme();
    rerender();
  } catch (err) { reportError(err); }
}

async function patchDevice(patch) {
  try {
    const res = await api.updateDeviceSettings(deviceId(), patch);
    state.device = res.settings;
    applyTheme();
    // Spotlight is the one device setting with an effect outside the app, so
    // switching it off has to empty the index now rather than at sign-out.
    syncSpotlight();
    rerender();
  } catch (err) { reportError(err); }
}

/* ── appearance ───────────────────────────────────────────────────────── */

/**
 * Appearance is what follows the account: how the app looks, everywhere you
 * sign in. How it is arranged is a property of the machine you are sitting at,
 * and lives under Workspace.
 */
function drawAppearance(host, settings, device) {
  mount(host,
    el('div', null,
      el('h2', { class: 'section', text: 'Appearance' }),
      el('div', { class: 'muted', style: { marginTop: '9px', maxWidth: '52em', lineHeight: '1.7' } },
        'Theme and accent follow your account to every device you sign in on. '
        + 'How the app is laid out is per-device, under Workspace.'),
    ),

    el('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px', maxWidth: '520px' } },
      el('div', { class: 'section-label plain', text: 'THEME' }),

      row('Theme', seg(['dark', 'light', 'system'], settings?.theme ?? 'dark',
        (value) => patchAccount({ theme: value }), { dark: 'Dark', light: 'Light', system: 'System' })),
      el('div', { class: 'muted', style: { fontSize: '12px', lineHeight: '1.6', marginTop: '-6px' } },
        'System follows what macOS is set to, and changes with it while the app is open.'),

      row('Accent', primaryAccentPicker(settings)),
      row('Second accent', accentPicker('secondary')),
      row('Third accent', accentPicker('tertiary')),
      row('Colour sections by accent', toggle(accentPrefs().sections, (value) => { setAccentPrefs({ sections: value }); rerender(); })),
      el('div', { class: 'muted', style: { fontSize: '12px', lineHeight: '1.6', marginTop: '-6px' } },
        'The second and third accents tint highlights, progress and focus. With section colouring on, Study uses the second and Calendar, Timetable and Topics use the third. Kept on this device.'),

      el('div', { class: 'section-label plain', style: { marginTop: '4px' }, text: 'PALETTES' }),
      palettesPanel(settings),
      el('div', { class: 'muted', style: { fontSize: '12px', lineHeight: '1.6', marginTop: '-6px' } },
        'Save the three accents together as a palette, then switch the whole set with one click. Palettes are kept on this device.'),

      row('Liquid glass', toggle(glassEnabled(), (value) => { setGlassEnabled(value); rerender(); })),

      el('div', { class: 'section-label plain', style: { marginTop: '4px' }, text: 'ACCESSIBILITY' }),
      row('Reduce motion', toggle(device?.reduce_motion ?? false, (value) => patchDevice({ reduceMotion: value }))),
      row('High contrast', toggle(highContrast(), (value) => { setHighContrast(value); rerender(); })),
      el('div', { class: 'muted', style: { fontSize: '12px', lineHeight: '1.6', marginTop: '-6px' } },
        'High contrast deepens text against its background and makes menus and panels solid rather than translucent. '
        + 'Kept on this device.'),
    ),
  );
}

/** The four papers a new canvas can start on. Kept beside the server's list. */
const CANVAS_GRIDS = { dots: 'Dots', plain: 'Plain', lines: 'Lines', squares: 'Grid' };

/**
 * Workspace: how this machine arranges the app, and what a new canvas or an
 * open document defaults to. All of it is per-device — the same account on a
 * laptop and a desktop wants different answers.
 */
function drawWorkspace(host, device) {
  mount(host,
    el('div', null,
      el('h2', { class: 'section', text: 'Workspace' }),
      el('div', { class: 'muted', style: { marginTop: '9px', maxWidth: '52em', lineHeight: '1.7' } },
        'Layout and defaults for this device. Nothing here changes what anyone else sees, '
        + 'and nothing here changes a file you have already made — a canvas keeps the paper it was created on.'),
    ),

    el('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
      el('div', { class: 'section-label plain', text: 'LAYOUT' }),
      el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 220px)', gap: '16px' } },
        SHELLS.map((shell) => el('button', {
          class: 'option-card' + (device?.shell_layout === shell.id ? ' on' : ''),
          onclick: () => patchDevice({ shellLayout: shell.id }),
        },
          shellPreview(shell.id),
          el('div', { class: 'name' }, el('span', { class: 'radio-dot' }), shell.name),
          el('div', { class: 'desc', text: shell.desc }),
        )),
      ),
      row('Sidebar density', densitySlider('sidebar')),
      row('Page density', densitySlider('page')),
      el('div', { class: 'muted', style: { fontSize: '12px', lineHeight: '1.6', marginTop: '-6px' } },
        'Left is tighter, right is roomier. The sidebar and the page are set separately.'),
    ),

    el('div', { class: 'rule' }),

    el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '44px' } },
      el('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
        el('div', { class: 'section-label plain', text: 'CANVAS' }),
        el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '16px' } },
          CHROMES.map((chrome) => el('button', {
            class: 'option-card' + (device?.canvas_chrome === chrome.id ? ' on' : ''),
            onclick: () => patchDevice({ canvasChrome: chrome.id }),
          },
            chromePreview(chrome.id),
            el('div', { class: 'name' }, el('span', { class: 'radio-dot' }), chrome.name),
            el('div', { class: 'desc', text: chrome.desc }),
          )),
        ),
        row('Default paper', seg(Object.keys(CANVAS_GRIDS), device?.canvas_grid ?? 'dots',
          (value) => patchDevice({ canvasGrid: value }), CANVAS_GRIDS)),
        el('div', { class: 'muted', style: { fontSize: '12px', lineHeight: '1.6', marginTop: '-6px' } },
          'What the New canvas sheet offers first. You can pick a different one each time.'),
      ),

      el('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px' } },
        el('div', { class: 'section-label plain', text: 'DOCUMENTS' }),

        row('Page width', seg(['narrow', 'regular', 'wide'], device?.doc_width ?? 'regular',
          (value) => patchDevice({ docWidth: value }), { narrow: 'Narrow', regular: 'Regular', wide: 'Wide' })),
        row('Type size', seg(['small', 'regular', 'large'], device?.doc_type_size ?? 'regular',
          (value) => patchDevice({ docTypeSize: value }), { small: 'Small', regular: 'Regular', large: 'Large' })),
        row('Reading font', seg(['system', 'serif', 'sans', 'mono', 'dyslexic'], device?.doc_font ?? 'system',
          (value) => patchDevice({ docFont: value }),
          { system: 'Default', serif: 'Serif', sans: 'Rounded', mono: 'Mono', dyslexic: 'Dyslexic' })),
        row('Line spacing', seg(['tight', 'normal', 'relaxed', 'loose'], device?.line_spacing ?? 'normal',
          (value) => patchDevice({ lineSpacing: value }),
          { tight: 'Tight', normal: 'Normal', relaxed: 'Relaxed', loose: 'Loose' })),
        el('div', { class: 'muted', style: { fontSize: '12px', lineHeight: '1.6', marginTop: '-6px' } },
          'Applies to every document and flashcard on this device. A narrower column with larger type is '
          + 'easier to read for long stretches; a wide one suits tables and code. “Dyslexic” uses '
          + 'OpenDyslexic, which many readers with dyslexia find clearer.'),      ),
    ),

    el('div', { class: 'rule' }),
    focusPrefsPanel(),

    ...(isNative ? [
      el('div', { class: 'rule' }),
      el('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        el('div', { class: 'section-label plain', text: 'SPOTLIGHT' }),
        row('Find my notes in Spotlight',
          toggle(device?.spotlight ?? false, (value) => patchDevice({ spotlight: value }))),
        el('div', { class: 'muted', style: { fontSize: '12px', lineHeight: '1.6', maxWidth: '52em' } },
          'Lets ⌘Space find your files by title and by the first few hundred words of what is in them, '
          + 'and open them straight into Studex. Off by default, and only for this device: what macOS '
          + 'indexes is stored by the Mac rather than by Studex, so anyone using this computer can see '
          + 'those titles without signing in. Turning it off — or signing out — removes them again.'),
      ),
    ] : []),
  );
}

/* Every setting row is a sentence and its control. The two are siblings rather
   than a <label> and its field, so the connection has to be made by hand — a
   switch with the word "Notifications" beside it is, to a screen reader, an
   unnamed button next to some text. */
let rowSeq = 0;

/** Swatches, a custom colour, and none — for the second and third accents. */
function accentPicker(key) {
  const current = accentPrefs()[key];
  const pick = (hex) => { setAccentPrefs({ [key]: hex }); rerender(); };
  const custom = current && !ACCENTS.some((a) => a.hex === current) ? current : null;
  return el('div', { class: 'accent-picker' },
    el('button', {
      class: 'swatch none' + (current ? '' : ' on'), title: 'None', 'aria-label': 'No accent',
      onclick: () => pick(null),
    }, icon('prohibit', { size: 12 })),
    ACCENTS.map((accent) => el('button', {
      class: 'swatch' + (current === accent.hex ? ' on' : ''),
      title: accent.name, 'aria-label': `${accent.name}`,
      style: { background: accent.hex },
      onclick: () => pick(accent.hex),
    })),
    el('label', {
      class: 'swatch picker' + (custom ? ' on' : ''), title: 'Custom colour',
      style: custom ? { background: custom } : {},
    },
      el('input', { type: 'color', value: current ?? '#8a88b8', 'aria-label': 'Custom accent colour', onchange: (event) => pick(event.target.value) })),
  );
}

/** The primary accent an account holds, mapped past the two old brightnesses. */
const LEGACY_ACCENTS = { '#9184d9': '#8a88b8', '#6fa8d4': '#7896b4', '#5fb598': '#739f8c', '#b2ac5e': '#a89a6e', '#d1877a': '#b58a80' };
function currentPrimary(settings) {
  const saved = (settings?.accent ?? '#8a88b8').toLowerCase();
  return LEGACY_ACCENTS[saved] ?? saved;
}

/** The account accent: the six swatches plus a true colour picker. */
function primaryAccentPicker(settings) {
  const current = currentPrimary(settings);
  const custom = !ACCENTS.some((a) => a.hex === current) ? current : null;
  return el('div', { class: 'accent-picker' },
    ACCENTS.map((accent) => el('button', {
      class: 'swatch' + (current === accent.hex ? ' on' : ''),
      title: accent.name, 'aria-label': `Accent: ${accent.name}`,
      style: { background: accent.hex },
      onclick: () => patchAccount({ accent: accent.hex }),
    })),
    el('label', {
      class: 'swatch picker' + (custom ? ' on' : ''), title: 'Custom colour',
      style: custom ? { background: custom } : {},
    },
      el('input', {
        type: 'color', value: current, 'aria-label': 'Custom accent colour',
        onchange: (event) => patchAccount({ accent: event.target.value.toLowerCase() }),
      })),
  );
}

/** Saved palettes: swatches to apply, plus "Save current" from the live trio. */
function palettesPanel(settings) {
  const prefs = accentPrefs();
  const list = savedPalettes();
  const applyPalette = (p) => {
    setAccentPrefs({ secondary: p.secondary ?? null, tertiary: p.tertiary ?? null });
    patchAccount({ accent: p.primary }); // rerenders the whole screen on success
    rerender();
  };
  const chips = list.length
    ? list.map((p) => el('div', { class: 'palette-chip' },
        el('button', {
          class: 'palette-swatches', title: `Apply ${p.name}`, 'aria-label': `Apply palette ${p.name}`,
          onclick: () => applyPalette(p),
        },
          [p.primary, p.secondary, p.tertiary].filter(Boolean).map((hex) =>
            el('span', { class: 'dot', style: { background: hex } })),
          el('span', { class: 'palette-name', text: p.name }),
        ),
        el('button', {
          class: 'btn icon', title: `Delete ${p.name}`, 'aria-label': `Delete palette ${p.name}`,
          onclick: () => { deletePalette(p.id); rerender(); },
        }, icon('x', { size: 12 })),
      ))
    : el('div', { class: 'muted', style: { fontSize: '12px' }, text: 'No saved palettes yet.' });

  const saveCurrent = async () => {
    const name = await promptText({
      title: 'Name this palette', label: 'Palette name',
      placeholder: 'e.g. Exam season', confirmLabel: 'Save', fallback: 'Palette',
    });
    if (!name) return;
    savePalette({ name, primary: currentPrimary(settings), secondary: prefs.secondary, tertiary: prefs.tertiary });
    rerender();
  };

  return el('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
    el('div', { class: 'palette-list' }, chips),
    el('div', null, el('button', { class: 'btn', onclick: saveCurrent }, icon('bookmark-simple'), 'Save current as palette')),
  );
}

function row(label, control) {
  const labelId = `setting-label-${++rowSeq}`;
  const named = control instanceof HTMLElement
    && (control.hasAttribute('aria-label') || control.hasAttribute('aria-labelledby'));
  if (control instanceof HTMLElement && !named) control.setAttribute('aria-labelledby', labelId);
  // A group of controls is named as a group; the buttons inside keep their own
  // words, so "Density, Comfortable, selected" is what comes out.
  if (control instanceof HTMLElement && control.classList.contains('seg')) {
    control.setAttribute('role', 'group');
  }
  return el('div', { class: 'setting-row' }, el('span', { class: 'label', id: labelId, text: label }), control);
}

function seg(values, current, onPick, labels) {
  return el('div', { class: 'seg' }, values.map((value) => el('button', {
    class: current === value ? 'on' : '',
    'aria-pressed': current === value ? 'true' : 'false',
    text: labels?.[value] ?? value,
    onclick: () => { if (current !== value) onPick(value); },
  })));
}

function toggle(on, onChange) {
  return el('button', {
    class: 'toggle' + (on ? ' on' : ''),
    // A switch, and it says which way it is thrown: the knob's position is the
    // only thing that said so before, and a position is not a word.
    role: 'switch',
    'aria-checked': on ? 'true' : 'false',
    onclick: () => onChange(!on),
  }, el('span', { class: 'knob', 'aria-hidden': 'true' }));
}

function shellPreview(id) {
  if (id === 'workspace_tabs') {
    return el('div', { class: 'shell-preview', style: { flexDirection: 'column' } },
      el('div', { class: 'p-top' }, el('span', { class: 'p-tab on' }), el('span', { class: 'p-tab' }), el('span', { class: 'p-tab' })),
      el('div', { class: 'p-body', style: { gridTemplateColumns: '1fr 1fr 1fr' } },
        el('span', { class: 'p-tile' }), el('span', { class: 'p-tile' }), el('span', { class: 'p-tile' })),
    );
  }
  if (id === 'icon_rail') {
    return el('div', { class: 'shell-preview' },
      el('div', { class: 'p-rail', style: { width: '18px', alignItems: 'center', padding: '7px 4px' } },
        el('span', { class: 'p-bar on', style: { width: '9px', height: '9px', borderRadius: '3px' } }),
        el('span', { class: 'p-bar', style: { width: '9px', height: '9px', borderRadius: '3px' } }),
        el('span', { class: 'p-bar', style: { width: '9px', height: '9px', borderRadius: '3px' } })),
      el('div', { class: 'p-rail', style: { width: '44px' } },
        el('span', { class: 'p-bar' }), el('span', { class: 'p-bar' }), el('span', { class: 'p-bar', style: { width: '75%' } })),
      el('div', { class: 'p-body', style: { gridTemplateColumns: '1fr 1fr' } },
        el('span', { class: 'p-tile' }), el('span', { class: 'p-tile' }),
        el('span', { class: 'p-tile' }), el('span', { class: 'p-tile' })),
    );
  }
  return el('div', { class: 'shell-preview' },
    el('div', { class: 'p-rail', style: { width: '52px' } },
      el('span', { class: 'p-bar on' }), el('span', { class: 'p-bar' }), el('span', { class: 'p-bar' }),
      el('span', { class: 'p-bar', style: { width: '70%' } }), el('span', { class: 'p-bar', style: { width: '80%' } })),
    el('div', { class: 'p-body', style: { gridTemplateColumns: '1fr 1fr' } },
      el('span', { class: 'p-tile' }), el('span', { class: 'p-tile' }),
      el('span', { class: 'p-tile' }), el('span', { class: 'p-tile' })),
  );
}

function chromePreview(id) {
  if (id === 'tool_column') {
    return el('div', { class: 'shell-preview', style: { height: '92px' } },
      el('div', { class: 'p-rail', style: { width: '15px', alignItems: 'center', padding: '5px 3px' } },
        el('span', { class: 'p-bar on', style: { width: '8px', height: '8px', borderRadius: '2px' } }),
        el('span', { class: 'p-bar', style: { width: '8px', height: '8px', borderRadius: '2px' } }),
        el('span', { class: 'p-bar', style: { width: '8px', height: '8px', borderRadius: '2px' } })),
      el('div', { class: 'p-dots' }),
    );
  }
  return el('div', { class: 'shell-preview', style: { height: '92px', position: 'relative' } },
    el('div', { class: 'p-dots' }),
    el('span', { style: { position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: '7px', width: '88px', height: '13px', borderRadius: '7px', background: 'var(--color-surface)', border: '1px solid var(--color-neutral-700)' } }),
    el('span', { style: { position: 'absolute', right: '7px', bottom: '24px', width: '34px', height: '30px', borderRadius: '4px', background: 'var(--color-surface)', border: '1px solid var(--color-accent-700)' } }),
  );
}

/* ── study ────────────────────────────────────────────────────────────── */

function drawStudy(host, settings) {
  const newCards = el('input', { class: 'input', type: 'number', min: 0, max: 1000, value: String(settings?.daily_new_cards ?? 20) });
  const reviewLimit = el('input', { class: 'input', type: 'number', min: 0, max: 10000, value: String(settings?.daily_review_limit ?? 200) });
  const retention = el('input', { class: 'input', type: 'number', min: 70, max: 99, step: 1, value: String(Math.round((settings?.retention_target ?? 0.9) * 100)) });
  const weeklyGoal = el('input', { class: 'input', id: 'weekly-goal-hours', type: 'number', min: 0, max: 100, step: 0.5, value: String((settings?.weekly_goal_minutes ?? 0) / 60) });
  const freeze = el('input', { type: 'checkbox', id: 'streak-freeze', checked: (settings?.streak_freeze ?? 1) === 1 });

  mount(host,
    el('div', null,
      el('h2', { class: 'section', text: 'Study' }),
      el('div', { class: 'muted', style: { marginTop: '9px', maxWidth: '52em', lineHeight: '1.7' } },
        'Daily limits shape the review queue. The retention target sets how well you aim to remember — the scheduler spaces cards to hit it.'),
    ),
    el('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px', maxWidth: '420px' } },
      el('div', { class: 'field' }, el('label', { text: 'New cards per day' }), newCards),
      el('div', { class: 'field' }, el('label', { text: 'Reviews per day' }), reviewLimit),
      el('div', { class: 'field' },
        el('label', { text: 'Retention target (%)' }),
        retention,
        el('div', { class: 'muted', style: { fontSize: '12px', lineHeight: '1.6', marginTop: '4px' } },
          'Higher means cards come back sooner and you forget less, at the cost of more reviews. 90% is the default; aim for 95% close to exams.'),
      ),
      el('div', { class: 'field' },
        el('label', { for: 'weekly-goal-hours', text: 'Weekly study goal (hours)' }),
        weeklyGoal,
        el('div', { class: 'muted', style: { fontSize: '12px', lineHeight: '1.6', marginTop: '4px' } },
          'Focus time counted from Monday. Leave at 0 for no goal.'),
      ),
      el('label', { for: 'streak-freeze', style: { display: 'flex', alignItems: 'flex-start', gap: '8px', lineHeight: '1.6' } },
        freeze,
        el('span', null, 'Streak freezes',
          el('span', { class: 'muted', style: { display: 'block', fontSize: '12px' } },
            'Every seven days in a row earns a freeze (up to two). A missed day spends one instead of ending the streak.'))),
      el('div', null, el('button', {
        class: 'btn primary lg', text: 'Save study settings',
        onclick: () => patchAccount({
          dailyNewCards: Math.max(0, Math.min(1000, Number(newCards.value) || 0)),
          dailyReviewLimit: Math.max(0, Math.min(10000, Number(reviewLimit.value) || 0)),
          retentionTarget: Math.max(0.7, Math.min(0.99, (Number(retention.value) || 90) / 100)),
          weeklyGoalMinutes: Math.round(Math.max(0, Math.min(100, Number(weeklyGoal.value) || 0)) * 60),
          streakFreeze: freeze.checked,
        }).then(() => toast('Study settings saved.')),
      })),
    ),
    el('div', { class: 'rule' }),
    schedulerPanel(),
    el('div', { class: 'rule' }),
    studyPrefsPanel(),
  );
}

/**
 * "Tune my scheduler". The server fits the spacing to this account's own
 * reviews and keeps the result only if it predicts held-back cards better
 * than the defaults, so pressing it can never make the schedule worse.
 */
function schedulerPanel() {
  const host = el('div', { class: 'tune-panel' });
  const note = (text) => el('div', { class: 'muted', style: { fontSize: '12px', lineHeight: '1.6' }, text });

  const draw = (status, result = null) => {
    const progress = Math.min(1, status.scored_reviews / status.needed_reviews);
    const button = el('button', {
      class: 'btn primary', type: 'button', disabled: !status.eligible,
      onclick: async () => {
        button.disabled = true;
        button.textContent = 'Tuning…';
        try {
          const res = await api.tuneScheduler();
          toast(res.result.applied ? 'Scheduler tuned to your reviews.' : 'Defaults already fit you best — nothing changed.');
          draw(res.scheduler, res.result);
        } catch (err) {
          reportError(err);
          draw(status);
        }
      },
    }, icon('sliders-horizontal', { size: 14 }), status.tuned ? ' Tune again' : ' Tune my scheduler');

    mount(host,
      el('div', { class: 'section-label plain', text: 'SCHEDULER' }),
      el('div', { class: 'tune-state' },
        el('span', { class: status.tuned ? 'tune-pill tuned' : 'tune-pill', text: status.tuned ? 'Tuned to you' : 'Default weights' }),
        status.tuned && status.tuned_at
          ? el('span', { class: 'muted', text: `Fitted ${new Date(status.tuned_at).toLocaleDateString()} from ${status.tuned_reviews.toLocaleString()} reviews` })
          : null),
      status.eligible
        ? note(status.tuned
          ? `${status.new_since_tuning.toLocaleString()} reviews since the last fit. Tuning again uses them too.`
          : `${status.scored_reviews.toLocaleString()} reviews across ${status.cards} cards — enough to fit the spacing to how you actually remember.`)
        : el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
          note(`Tuning unlocks after ${status.needed_reviews} reviews of cards you saw on an earlier day. You have ${status.scored_reviews}.`),
          el('div', { class: 'tune-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(status.needed_reviews), 'aria-valuenow': String(status.scored_reviews) },
            el('span', { style: { width: `${Math.round(progress * 100)}%` } }))),
      result
        ? el('div', { class: 'tune-result' },
          el('div', null, el('b', { text: `${result.recall_actual_pct}%` }), el('span', { class: 'muted', text: ' recalled on held-back cards' })),
          el('div', null, el('b', { text: `${result.recall_predicted_default_pct}%` }), el('span', { class: 'muted', text: ' default prediction' })),
          el('div', null, el('b', { text: `${result.recall_predicted_tuned_pct}%` }), el('span', { class: 'muted', text: result.applied ? ' tuned prediction — kept' : ' tuned prediction — not better, discarded' })))
        : null,
      el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        button,
        status.tuned
          ? el('button', {
            class: 'btn', type: 'button', text: 'Use defaults',
            onclick: async () => {
              try { draw((await api.resetScheduler()).scheduler); toast('Back to the default weights.'); } catch (err) { reportError(err); }
            },
          })
          : null),
      note('Only grades from now on use the new spacing; cards already scheduled keep their dates.'),
    );
  };

  mount(host, el('div', { class: 'section-label plain', text: 'SCHEDULER' }), note('Checking your review history…'));
  api.scheduler().then((r) => draw(r.scheduler)).catch(() => mount(host, note('The scheduler status is unavailable offline.')));
  return host;
}

/** Habits of a sitting, kept on this Mac and applied the next time a deck opens. */
function studyPrefsPanel() {
  const host = el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '44px' } });
  const draw = () => {
    const p = studyPrefs();
    const set = (patch) => { saveStudyPrefs(patch); draw(); };
    const pick = (key, options) => seg(options.map(([v]) => String(v)), String(p[key]),
      (value) => set({ [key]: typeof STUDY_DEFAULTS[key] === 'number' ? Number(value) : value }), Object.fromEntries(options.map(([v, t]) => [String(v), t])));
    const note = (text) => el('div', { class: 'muted', style: { fontSize: '12px', lineHeight: '1.6', marginTop: '-6px' }, text });
    mount(host,
      el('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
        el('div', { class: 'section-label plain', text: 'REVIEW' }),
        row('Shuffle cards', toggle(p.shuffle, (v) => set({ shuffle: v }))),
        row('Show the back first', toggle(p.reverse, (v) => set({ reverse: v }))),
        note('Reverse recall: see the answer, remember the question.'),
        row('Cards per sitting', pick('sessionCap', [[0, 'All'], [10, '10'], [20, '20'], [50, '50']])),
        row('Reveal automatically', pick('autoReveal', [[0, 'Off'], [5, '5s'], [10, '10s'], [20, '20s']])),
        row('Again cards return this sitting', toggle(p.requeueAgain, (v) => set({ requeueAgain: v }))),
        row('AI Explain button', toggle(p.showExplain, (v) => set({ showExplain: v }))),
        row('Show seen count and interval', toggle(p.showCardInfo, (v) => set({ showCardInfo: v }))),
        speechAvailable() ? row('Read cards aloud', toggle(p.audioReview, (v) => set({ audioReview: v }))) : null,
        speechAvailable() ? note('Hands-free revision: each card is spoken as it shows, the question first, then the answer when it reveals. Toggle it per sitting from the study screen too.') : null,
        speechAvailable() && p.audioReview
          ? row('Reading speed', pick('speechRate', [[0.75, 'Slow'], [1, 'Normal'], [1.5, 'Fast'], [2, 'Fastest']]))
          : null,
      ),
      el('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
        el('div', { class: 'section-label plain', text: 'TEST' }),
        row('Default mode', pick('testMode', [['typed', 'Typed'], ['choice', 'Choice'], ['truefalse', 'True/false']])),
        row('Questions', pick('testLength', [[0, 'All'], [10, '10'], [20, '20'], [40, '40']])),
        row('Shuffle questions', toggle(p.testShuffle, (v) => set({ testShuffle: v }))),
        row('Time limit', pick('testTimer', [[0, 'None'], [5, '5m'], [10, '10m'], [20, '20m']])),
        row('Typed answers', pick('strictness', [['exact', 'Exact'], ['normal', 'Normal'], ['lenient', 'Lenient']])),
        note('Exact wants every character. Normal ignores case, spacing and end punctuation. Lenient also ignores accents, inner punctuation and a leading “the” or “a”.'),
        el('div', null, el('button', { class: 'btn', text: 'Reset to defaults', onclick: () => set({ ...STUDY_DEFAULTS }) })),
      ),
    );
  };
  draw();
  return host;
}

/* ── notifications ────────────────────────────────────────────────────── */

const NOTIFICATIONS = [
  {
    key: 'due_cards',
    label: 'Cards are due',
    note: 'A nudge when reviews are waiting, at most once every few hours, and never while you are looking at Studex.',
  },
  {
    key: 'exam_reminders',
    label: 'Exams and deadlines',
    note: 'A week before, three days before, the day before, and on the morning itself.',
  },
  {
    key: 'daily_summary',
    label: 'Daily summary',
    note: 'One line each morning: what is due, and what is coming up.',
  },
];

/**
 * The three switches, and an honest account of what macOS will let them do.
 *
 * A switch turned on is the moment to ask macOS for permission — that is when
 * the system alert makes sense to the person seeing it. Turning one off never
 * asks, because a preference the app cannot act on yet is still a preference
 * worth keeping.
 */
function drawNotifications(host, settings) {
  const prefs = settings?.notifications ?? {};
  const status = el('div', { class: 'muted', style: { fontSize: '12px', lineHeight: '1.6' } });

  const describe = (access) => {
    if (access === 'granted' || access === 'not-determined') return '';
    if (access === 'denied') {
      return 'macOS is blocking notifications from Studex. Turn them back on in '
        + 'System Settings › Notifications › Studex.';
    }
    return 'This build cannot post notifications. The settings are saved and will apply in the Mac app.';
  };

  const refresh = () => {
    notificationAccess().then((access) => { status.textContent = describe(access); });
  };
  refresh();

  async function set(key, on) {
    // The whole object is sent because the server stores it as one value; a
    // patch naming a single key would clear the other two.
    await patchAccount({ notifications: { ...prefs, [key]: on } });
    if (on) {
      const access = await requestNotificationAccess();
      if (access === 'denied') toast('macOS is blocking notifications from Studex.', 'error');
      status.textContent = describe(access);
    }
  }

  mount(host,
    el('div', null,
      el('h2', { class: 'section', text: 'Notifications' }),
      el('div', { class: 'muted', style: { marginTop: '9px', maxWidth: '52em', lineHeight: '1.7' } },
        'Studex notifies you while it is open. It has no background service and sends nothing '
        + 'once you quit, so these are reminders for a day you are already working, not an alarm clock.'),
    ),

    el('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px', maxWidth: '520px' } },
      NOTIFICATIONS.map(({ key, label, note }) => el('div', null,
        row(label, toggle(prefs[key] ?? false, (value) => set(key, value))),
        el('div', { class: 'muted', style: { fontSize: '12px', lineHeight: '1.6', marginTop: '6px' }, text: note }),
      )),
      status,
    ),
  );
}

/* ── plan ────────────────────────────────────────────────────────────── */

function planLabel(plan) {
  return (plan ?? 'free').replace(/^./, (c) => c.toUpperCase());
}

/**
 * The tiers, and only what the server truly enforces: storage, how many
 * canvases and how many PDFs. Everything else on these cards is what both
 * tiers already include, and is listed as such rather than as a difference.
 */
const PLANS = [
  {
    id: 'free',
    name: 'Free',
    price: 'No cost',
    blurb: 'Everything you need to revise.',
    quota: (base) => base,
  },
  {
    id: 'pro',
    name: 'Pro',
    price: 'Paid',
    blurb: 'The same app, without the ceilings.',
    quota: (base, mult) => base * mult,
  },
];



/** "3 canvases", or "Unlimited canvases". */
function limitText(limit, many) {
  return `${limit === null || limit === undefined ? 'Unlimited' : limit} ${many}`;
}

async function drawPlan(host) {
  mount(host, el('div', { class: 'loading' }, el('div', { class: 'spinner' }), 'Loading…'));
  const [storage, status] = await Promise.all([
    api.storage().then((r) => r.storage).catch(() => null),
    api.planStatus().catch(() => null),
  ]);

  const current = status?.plan ?? state.user?.plan ?? 'free';
  const held = new Map((status?.limits ?? []).map((row) => [row.kind, row]));
  const freeLimits = status?.freeLimits ?? { canvas: 3, pdf: 5 };
  const used = storage?.used_bytes ?? 0;
  const quota = storage?.quota_bytes ?? 0;
  // The current tier's quota is the base; the other tier is derived from it,
  // so a self-hosted install with a raised limit shows its own numbers.
  const base = current === 'pro' ? quota / PRO_MULTIPLIER : quota;

  mount(host,
    el('div', null,
      el('h2', { class: 'section', text: 'Plan' }),
      el('div', { class: 'muted', style: { marginTop: '9px', maxWidth: '52em', lineHeight: '1.7' } },
        'Free keeps a few canvases and PDFs and a fixed amount of storage; Pro lifts both. '
        + 'Moving up needs the account to have been paid for, so the switch is not something '
        + 'this screen can do on its own. Moving back down is always yours to make, and nothing '
        + 'is deleted when you do.'),
    ),

    el('div', { class: 'usage' },
      el('div', { class: 'top' },
        el('span', { class: 'label', text: 'STORAGE' }),
        el('span', { class: 'dim', text: `${bytes(used)} of ${bytes(quota)} used` }),
      ),
      el('div', { class: 'meter' }, el('div', { style: { width: `${quota ? Math.min(100, Math.round((used / quota) * 100)) : 0}%` } })),
    ),

    el('div', { class: 'plan-grid' }, PLANS.map((plan) => {
      const isCurrent = plan.id === current;
      return el('div', { class: 'plan-tier' + (isCurrent ? ' on' : '') },
        el('div', { class: 'head' },
          el('span', { class: 'name', text: plan.name }),
          isCurrent ? el('span', { class: 'pill ready', text: 'Current' }) : null,
        ),
        el('div', { class: 'price', text: plan.price }),
        el('div', { class: 'blurb', text: plan.blurb }),
        el('div', { class: 'rule' }),
        el('div', { class: 'feature lead' }, icon('hard-drives', { size: 14 }), `${bytes(plan.quota(base, PRO_MULTIPLIER))} of storage`),
        el('div', { class: 'feature' }, icon('infinity', { size: 13 }),
          limitText(plan.id === 'pro' ? null : freeLimits.canvas, 'canvases')
          + (isCurrent && held.has('canvas') ? ` · ${held.get('canvas').used} in use` : '')),
        el('div', { class: 'feature' }, icon('file-pdf', { size: 13 }),
          limitText(plan.id === 'pro' ? null : freeLimits.pdf, 'PDFs')
          + (isCurrent && held.has('pdf') ? ` · ${held.get('pdf').used} in use` : '')),
        FREE_INCLUDES.map((line) => el('div', { class: 'feature' }, icon('check', { size: 13 }), line)),
        el('button', {
          class: 'btn' + (isCurrent ? '' : ' primary') + ' lg',
          disabled: isCurrent,
          text: isCurrent
            ? 'Your plan'
            : plan.id === 'pro' ? 'See what Pro adds' : 'Switch to Free',
          onclick: () => (plan.id === 'pro'
            ? showProFeatures().then(() => drawPlan(host))
            : switchPlan(plan.id, used, plan.quota(base, PRO_MULTIPLIER), host)),
        }),
      );
    })),
  );
}

async function switchPlan(plan, used, nextQuota, host) {
  if (plan === 'free' && used > nextQuota) {
    const ok = await confirmDialog({
      title: 'Your library is over the Free limit',
      message: `You are using ${bytes(used)}, and Free allows ${bytes(nextQuota)}. `
        + 'Nothing is deleted, but you will not be able to import more until you free some space.',
      confirmLabel: 'Switch anyway',
    });
    if (!ok) return;
  }
  try {
    const { user } = await api.setPlan(plan);
    state.user = user;
    toast(`Switched to Studex ${planLabel(plan)}.`);
    rerender();
    await drawPlan(host);
  } catch (err) { reportError(err); }
}

/* ── updates ──────────────────────────────────────────────────────────── */

/**
 * Checking for a newer Studex, installing it, and choosing how that happens.
 *
 * Releases are a table in the same Supabase project the app signs in against,
 * so every Mac that can sign in finds its own updates. Each approved release
 * is also written out as an appcast and a releases.json — the same list the
 * website's changelog and download button read — so the app, the site and the
 * DMG never disagree about what the newest Studex is.
 *
 * The check is made by the server rather than the page: it is the one part of
 * the app allowed to reach out of the machine. Installing is the shell's,
 * because nothing else can replace the running bundle.
 */
function drawUpdates(host) {
  // Released when the screen is left. The settings view is re-run on every
  // navigation within Settings, so without this each visit would leave another
  // handler behind holding the page it drew.
  let unwatch = null;
  const summary = el('div', { class: 'update-summary' });
  const prefsHost = el('div', { class: 'rows', style: { maxWidth: '640px' } });
  const historyHost = el('div', { class: 'update-history' });
  const check = el('button', { class: 'btn primary lg', text: 'Check for updates' });
  const progress = el('div', { class: 'update-progress hidden' });
  const bar = el('div', { class: 'progress' }, el('div'));
  const progressText = el('div', { class: 'dim', style: { fontSize: '12px' } });
  let busy = false;
  let installing = false;
  let current = null;
  let result = updateStatus().last;
  const installerLink = el('a', { class: 'btn hidden', target: '_blank', rel: 'noopener noreferrer' },
    icon('download-simple'), 'Download installer (DMG)');

  const since = (ms) => {
    if (!ms) return 'Never';
    const mins = Math.round((Date.now() - ms) / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} h ago`;
    return new Date(ms).toLocaleDateString();
  };

  function drawSummary() {
    const prefs = updatePrefs();
    const { ready } = updateStatus();
    const version = current?.version ?? result?.version;
    let tone = 'ok';
    let headline = 'Studex is up to date';
    let detail = result ? `Checked ${since(prefs.lastChecked).toLowerCase()}.` : 'Not checked yet on this Mac.';
    let action = null;

    if (!isNative) {
      tone = 'dim';
      headline = 'Updates are installed by the Studex app';
      detail = 'Open Studex on your Mac to check for and install new versions.';
    } else if (ready) {
      headline = `Studex ${ready} is ready to install`;
      detail = 'Restart to switch over. If you quit instead, it installs as Studex closes.';
      action = el('button', { class: 'btn primary', text: 'Restart to update', onclick: () => restartToUpdate() });
    } else if (result?.available && result.latest) {
      tone = result.critical ? 'warn' : 'accent';
      headline = `Studex ${result.latest.version} is available`;
      detail = result.critical
        ? 'This release fixes something important — install it soon.'
        : (result.missed?.length > 1 ? `${result.missed.length} updates since your version.` : 'A new version is out.');
      action = result.canInstall
        ? el('button', { class: 'btn primary', text: `Install ${result.latest.version}`, onclick: () => begin(result.latest) })
        : null;
    } else if (result?.blocked) {
      tone = 'warn';
      headline = `Studex ${result.blocked.version} needs a newer macOS`;
      detail = `It requires macOS ${result.blocked.minimumSystemVersion ?? 'newer than this one'}`
        + `${result.system ? ` — this Mac runs ${result.system}` : ''}. Update macOS in System Settings to get it.`;
    }

    const facts = [
      ['Version', version ? `${version}${current?.build ? ` (${current.build})` : ''}` : '—'],
      ['Channel', prefs.channel === 'beta' ? 'Beta' : 'Stable'],
      ['macOS', result?.system ?? '—'],
      ['Last checked', since(prefs.lastChecked)],
    ];
    mount(summary,
      el('div', { class: `update-hero ${tone}` },
        icon(tone === 'warn' ? 'warning-circle' : tone === 'accent' ? 'sparkle' : 'check-circle'),
        el('div', { class: 'grow' },
          el('div', { class: 'update-hero-title', text: headline }),
          el('div', { class: 'dim', text: detail }),
        ),
        action,
      ),
      el('dl', { class: 'update-facts' },
        ...facts.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })])),
    );
  }

  function drawPrefs() {
    if (!isNative) { mount(prefsHost); return; }
    const prefs = updatePrefs();
    const set = (name, value) => { setUpdatePref(name, value); drawPrefs(); drawSummary(); };
    const described = (title, hint, control) => el('div', { class: 'row' },
      el('div', { class: 'grow' },
        el('div', { text: title }),
        el('div', { class: 'dim', style: { fontSize: '12px', marginTop: '3px' }, text: hint }),
      ),
      control,
    );
    mount(prefsHost,
      described('Download updates automatically',
        'New versions download in the background, then Studex asks you to restart. Important fixes always download.',
        toggle(prefs.auto, (on) => set('auto', on))),
      described('Release channel',
        prefs.channel === 'beta'
          ? 'Beta gets new features first, and may be rougher. You still get every stable release.'
          : 'Stable gets releases once they are finished.',
        seg(['stable', 'beta'], prefs.channel, (v) => set('channel', v), { stable: 'Stable', beta: 'Beta' })),
      described('Check for new versions', 'How often Studex looks while it is open.',
        dropdown({
          class: 'input', 'aria-label': 'Check frequency',
          onchange: (e) => set('interval', e.target.value),
        }, ...INTERVALS.map((i) => el('option', { value: String(i.hours), selected: i.hours === prefs.interval, text: i.label })))),
      described("Show what's new after updating", 'A short summary of the changes, once, after each update.',
        toggle(prefs.whatsNew, (on) => set('whatsNew', on))),
    );
  }

  function drawHistory() {
    const releases = result?.releases ?? [];
    const version = current?.version ?? result?.version;
    if (!releases.length) {
      mount(historyHost, el('div', { class: 'dim', style: { fontSize: '12.5px' },
        text: result ? 'No release notes have been published yet.' : 'Check for updates to see the release history.' }));
      return;
    }
    mount(historyHost, ...releases.slice(0, 12).map((r, i) => {
      const isCurrent = version && compareVersions(r.version, version) === 0;
      const isNew = version && compareVersions(r.version, version) > 0;
      return el('details', { class: 'update-release', open: i === 0 && Boolean(r.notes) },
        el('summary', null,
          el('strong', { text: r.version }),
          isCurrent ? el('span', { class: 'pill ready', text: 'Installed' }) : null,
          isNew ? el('span', { class: 'pill', text: 'New' }) : null,
          r.channel === 'beta' ? el('span', { class: 'pill', text: 'Beta' }) : null,
          r.critical ? el('span', { class: 'pill behind', text: 'Important' }) : null,
          el('span', { class: 'grow' }),
          r.publishedAt ? el('span', { class: 'dim', text: formatDate(r.publishedAt) }) : null,
        ),
        el('div', { class: 'update-release-notes', text: r.notes || 'No notes for this release.' }),
      );
    }));
  }

  /** The newest disk image, for setting Studex up on another Mac. */
  function drawInstaller() {
    const dmg = (result?.releases ?? []).find((r) => r.dmgUrl && r.channel !== 'beta')?.dmgUrl;
    installerLink.classList.toggle('hidden', !dmg);
    if (dmg) installerLink.href = dmg;
  }

  function drawAll() { drawSummary(); drawPrefs(); drawHistory(); drawInstaller(); }

  async function load() {
    try {
      current = (await api.updateState()).update;
    } catch (err) { reportError(err); }
    drawAll();
  }

  async function run() {
    if (busy) return;
    busy = true;
    check.disabled = true;
    check.textContent = 'Checking…';
    try {
      result = await checkForUpdates({ manual: true });
      if (result && !result.available && !result.blocked) toast('Studex is up to date.');
    } catch (err) {
      reportError(err);
    } finally {
      busy = false;
      check.disabled = false;
      check.textContent = 'Check for updates';
      drawAll();
    }
  }

  /**
   * The point of no return, so it is asked as one. Everything after this is
   * reported step by step, and a failure leaves the app exactly as it is.
   */
  async function begin(latest) {
    const ok = await confirmDialog({
      title: `Install Studex ${latest.version}?`,
      message: 'The update is downloaded, checked against its published checksum and signature, '
        + 'and put in place. Studex then quits and reopens on the new version. '
        + 'Your library is untouched — it lives outside the app.',
      confirmLabel: 'Download and install',
      danger: false,
    });
    if (!ok) return;

    installing = true;
    progress.classList.remove('hidden', 'bad');
    check.disabled = true;
    unwatch?.();
    unwatch = watchUpdate((step) => {
      const pct = typeof step.fraction === 'number' ? Math.round(step.fraction * 100) : null;
      bar.firstElementChild.style.width = pct === null ? '100%' : `${pct}%`;
      progressText.textContent = {
        downloading: pct === null ? 'Downloading…' : `Downloading… ${pct}%`,
        verifying: 'Checking the download against its signature…',
        unpacking: 'Unpacking…',
        ready: 'Ready — restarting…',
        installing: 'Putting the new version in place…',
        relaunching: 'Reopening Studex…',
        failed: step.message ?? 'The update could not be installed.',
      }[step.stage] ?? step.stage;
      if (step.stage === 'failed') {
        installing = false;
        progress.classList.add('bad');
        check.disabled = false;
        reportError(new Error(step.message ?? 'The update could not be installed.'));
      }
      // Asked for here, so there is no second question: straight on to the swap.
      if (step.stage === 'ready') restartToUpdate();
    });
    prepareUpdate(latest);
  }

  check.onclick = () => run();
  mount(progress, bar, progressText);

  mount(host,
    el('div', null,
      el('h2', { class: 'section', text: 'Updates' }),
      el('div', { class: 'muted', style: { marginTop: '9px', maxWidth: '52em', lineHeight: '1.7' } },
        'Every Mac signed in to Studex gets new versions as soon as they are approved. A download '
        + 'is only installed if it matches its published checksum and signature, and your library '
        + 'sits outside the app, so an update never touches it.'),
    ),
    summary,
    el('div', { class: 'sync-actions' }, check, installerLink),
    progress,
    isNative ? el('h3', { class: 'section-label plain', text: 'PREFERENCES' }) : null,
    prefsHost,
    el('h3', { class: 'section-label plain', text: 'RELEASE HISTORY' }),
    historyHost,
  );

  const unlisten = onUpdateStatus((status) => {
    if (installing) return;
    result = status.last ?? result;
    drawAll();
  });

  drawAll();
  load().then(() => { if (isNative) askUpdateStatus(); });
  return () => { unwatch?.(); unlisten(); };
}

/* ── AI ─────────────────────────────────────────────────────────────── */

const ROLE_DOES = {
  reader: 'Reads specification files into units and topics.',
  writer: 'Writes cards, explanations, quiz questions and chat answers.',
  checker: 'Checks imported topics, plans revision, finds duplicates.',
};

const FEATURE_LABEL = {
  spec_import: 'Spec import', spec_check: 'Spec check', cards: 'Cards', explain: 'Explain',
  quiz: 'Quiz', plan: 'Revision plan', dedupe: 'Duplicates', chat: 'Chat',
};

/**
 * Where the Google AI Studio (Gemini) key goes in, and what it has been used for.
 *
 * The key is written once and never shown again — the server keeps it in a
 * file only it reads and hands back the last four characters, so this screen
 * can say which key is in use without being a place a key can be copied from.
 */
function drawShortcuts(host) {
  const editable = el('div');
  const list = el('div');
  const search = el('input', {
    class: 'input', type: 'search', id: 'shortcut-search', placeholder: 'Find a shortcut', 'aria-label': 'Find a shortcut',
    oninput: () => mount(list, shortcutList({ filter: search.value })),
  });
  mount(list, shortcutList());

  const resetBtn = el('button', {
    class: 'btn', disabled: !hasCustomBindings(),
    onclick: () => { resetBindings(); toast('Shortcuts reset to defaults'); redraw(); },
  }, icon('arrow-counter-clockwise'), 'Reset to defaults');

  function redraw() {
    resetBtn.disabled = !hasCustomBindings();
    mount(editable, keymapEditor(redraw));
  }
  redraw();

  mount(host,
    el('div', null,
      el('h2', { class: 'section', text: 'Keyboard shortcuts' }),
      el('div', { class: 'muted', style: { marginTop: '9px', maxWidth: '52em', lineHeight: '1.7' } },
        'Click a shortcut and press the keys you want. Rebindings are kept on this device. '
        + 'Press ⌘/ anywhere to see the full list. In-editor keys — bold, canvas tools — are '
        + 'shown for reference below and stay as they are.'),
    ),
    el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '4px' } },
      el('div', { class: 'section-label plain', text: 'REBINDABLE' }),
      el('span', { style: { marginLeft: 'auto' } }, resetBtn),
    ),
    editable,
    el('div', { class: 'rule' }),
    el('div', { class: 'section-label plain', text: 'REFERENCE' }),
    el('div', { class: 'shortcut-sheet' }, search, list),
  );
}

/**
 * The editable keymap: every app-wide shortcut with a keycap you press into.
 *
 * A keycap in "listening" state captures the very next keystroke on the whole
 * document — capturing, so it beats the shortcut it is trying to replace, which
 * is otherwise listening for those same keys. Escape cancels; a plain
 * Backspace or Delete puts the row back to its default.
 */
function keymapEditor(onChange) {
  let listeningFor = null; // the shortcut id currently capturing keys
  const wrap = el('div', { class: 'shortcut-groups' });

  const stopListening = () => {
    if (!listeningFor) return;
    document.removeEventListener('keydown', onCapture, true);
    listeningFor = null;
  };

  function onCapture(event) {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') { stopListening(); onChange(); return; }
    // A lone modifier keeps the row waiting for a real key.
    if (['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) return;
    const id = listeningFor;
    if ((event.key === 'Backspace' || event.key === 'Delete') && !event.metaKey && !event.ctrlKey && !event.altKey) {
      clearBinding(id); stopListening(); toast('Reset to default'); onChange(); return;
    }
    const combo = comboFromEvent(event);
    if (!combo) { toast('Add ⌘, ⌥ or a named key — a plain letter would swallow typing.', 'error'); return; }
    const clash = bindingConflict(combo, id);
    if (clash) { toast(`${formatKeys(combo)} is already ${clash}`, 'error'); stopListening(); onChange(); return; }
    setBinding(id, combo);
    stopListening();
    onChange();
  }

  for (const { group, rows } of remappableShortcuts()) {
    wrap.append(el('section', { class: 'shortcut-group' },
      el('h3', { text: group }),
      el('dl', null, rows.flatMap((r) => [
        el('dt', { text: r.label }),
        el('dd', null,
          el('button', {
            class: 'btn keycap' + (r.custom ? ' custom' : '') + (listeningFor === r.id ? ' listening' : ''),
            title: r.custom ? `Custom — default is ${formatKeys(r.defaultKeys)}` : 'Click, then press new keys',
            'aria-label': `Rebind ${r.label}, currently ${formatKeys(r.keys)}`,
            onclick: () => {
              const wasListening = listeningFor === r.id;
              stopListening();
              if (wasListening) { onChange(); return; }
              listeningFor = r.id;
              document.addEventListener('keydown', onCapture, true);
              onChange();
            },
          }, listeningFor === r.id
            ? el('span', { class: 'dim', text: 'Press keys…' })
            : formatKeys(r.keys).split(' / ').map((k) => el('kbd', { text: k }))),
          r.custom
            ? el('button', {
                class: 'btn icon', title: 'Reset to default', 'aria-label': `Reset ${r.label} to default`,
                onclick: () => { stopListening(); clearBinding(r.id); onChange(); },
              }, icon('arrow-counter-clockwise'))
            : null,
        ),
      ])),
    ));
  }
  return wrap;
}

function drawAi(host) {
  const status = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '640px' } });
  const models = el('div');
  const calls = el('div', { class: 'ai-calls' });

  mount(host,
    el('div', null,
      el('h2', { class: 'section', text: 'AI' }),
      el('div', { class: 'muted', style: { marginTop: '9px', maxWidth: '52em', lineHeight: '1.7' } },
        'Studex calls three Gemini models through Google AI Studio: one reads specifications, one writes, and one checks. '
        + 'Each has a backup it falls back to when a model is busy. Your key stays on this Mac and is never shown again once saved.'),
    ),
    status,
    models,
    calls,
  );

  async function load() {
    let info;
    try { info = await api.aiStatus(); } catch (err) { reportError(err); return; }
    drawStatus(info);
    drawModels(info);
    void drawCalls();
  }

  function drawStatus(info) {
    const field = el('input', {
      class: 'input', type: 'password', autocomplete: 'off', spellcheck: 'false',
      placeholder: info.keySet ? `Replace the key ending ${info.keyHint?.replace('…', '') ?? ''}` : 'AIza…',
      'aria-label': 'Gemini API key',
      disabled: !info.keyEditable,
    });
    const message = el('div', { style: { fontSize: '12.5px' } });
    const save = el('button', { class: 'btn primary', type: 'button', text: info.keySet ? 'Replace key' : 'Save key', disabled: !info.keyEditable });
    const builtIn = info.keySource === 'builtin';
    if (builtIn) field.placeholder = 'Paste your own key to use it instead';
    if (builtIn) save.textContent = 'Use my key';
    const remove = info.keySource === 'settings' && info.keyEditable
      ? el('button', { class: 'btn', type: 'button', text: 'Remove key' })
      : null;

    save.onclick = async () => {
      const key = field.value.trim();
      if (!key) { message.textContent = 'Paste a key first.'; return; }
      save.disabled = true;
      message.textContent = 'Checking the key with Google AI Studio…';
      try {
        const res = await api.aiSetKey(key);
        field.value = '';
        resetAiStatus();
        const free = res.account?.models ? ` ${res.account.models} models available to this key.` : '';
        toast('Key saved.');
        await load();
        const fresh = status.querySelector('[data-ai-message]');
        if (fresh) fresh.textContent = `Saved and working.${free}`;
      } catch (err) {
        message.textContent = err?.message ?? 'The key could not be saved.';
        save.disabled = false;
      }
    };

    if (remove) {
      remove.onclick = async () => {
        if (!await confirmDialog({ title: 'Remove the AI key?', message: 'The AI features disappear until a key is saved again.', confirmLabel: 'Remove' })) return;
        try {
          await api.aiClearKey();
          resetAiStatus();
          toast('Key removed.');
          await load();
        } catch (err) { reportError(err); }
      };
    }

    const source = info.keySource === 'env'
      ? 'From the server’s environment (GEMINI_API_KEY), which wins over anything saved here.'
      : info.keySource === 'settings'
        ? `Saved on this Mac, ending ${info.keyHint?.replace('…', '') ?? '????'}.`
        : builtIn
          ? 'Built into this copy of Studex — nothing to set up.'
          : 'No key yet. Create one at aistudio.google.com/apikey and paste it here.';

    message.dataset.aiMessage = '';
    mount(status,
      row('Status', el('span', null,
        el('span', { class: 'pill', style: { marginRight: '8px' }, text: info.available ? 'On' : 'Off' }),
        source)),
      info.keyEditable || info.keySource !== 'env'
        ? row('Key', el('div', { class: 'ai-key-row' }, field, save, remove))
        : null,
      !info.keyEditable && info.keySource !== 'env'
        ? el('div', { class: 'muted', text: 'This server takes its key from where it is deployed, not from the app.' })
        : null,
      message,
      info.usage
        ? row('This month', el('span', { text: `${info.usage.used} of ${info.usage.limit} requests used · ${info.usage.remaining} left` }))
        : null,
      info.weights
        ? el('div', { class: 'muted', style: { fontSize: '12px' }, text: `A specification import counts as ${info.weights.spec_import ?? 5} requests; everything else counts as one.` })
        : null,
    );
  }

  function drawModels(info) {
    if (!info.models) { mount(models); return; }
    mount(models,
      el('div', { class: 'section-label plain', style: { marginBottom: '10px' }, text: 'MODELS' }),
      el('div', { class: 'ai-models' }, ['reader', 'writer', 'checker'].map((role) => [
        el('span', { class: 'role', text: role }),
        el('div', null,
          el('div', { class: 'model' }, info.models[role]?.primary ?? '—',
            info.models[role]?.backup ? el('span', { class: 'backup', text: `  → ${info.models[role].backup}` }) : null),
          el('div', { class: 'does', text: ROLE_DOES[role] }),
        ),
      ])),
    );
  }

  async function drawCalls() {
    let list = [];
    try { ({ calls: list } = await api.aiCalls()); } catch { return; }
    const time = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    mount(calls,
      el('div', { class: 'section-label plain', style: { marginBottom: '10px' }, text: 'RECENT CALLS' }),
      list.length
        ? el('table', null,
            el('thead', null, el('tr', null, ['When', 'Feature', 'Model', 'Tokens', 'Time', 'Result'].map((h) => el('th', { text: h.toUpperCase() })))),
            el('tbody', null, list.map((c) => el('tr', null,
              el('td', { text: time.format(new Date(c.created_at)) }),
              el('td', { text: FEATURE_LABEL[c.feature] ?? c.feature }),
              el('td', { class: 'model', text: c.model.replace(/:free$/, '') }),
              el('td', { text: c.ok ? `${c.input_tokens} → ${c.output_tokens}` : '—' }),
              el('td', { text: `${(c.duration_ms / 1000).toFixed(1)} s` }),
              el('td', { class: c.ok ? '' : 'bad', text: c.ok ? 'OK' : (c.error ?? `Failed (${c.status ?? 'network'})`) }),
            ))),
          )
        : el('div', { class: 'muted', text: 'Nothing yet.' }),
    );
  }

  void load();
}

/* ── account ──────────────────────────────────────────────────────────── */

/* ── sync ────────────────────────────────────────────────────────────── */

/**
 * The intervals the server will accept, kept beside its own list. Off is a
 * real choice: someone on a metered connection, or with one Mac, should be
 * able to say so.
 */
const AUTO_SYNC_CHOICES = ['0', '5', '15', '60', '360'];
const AUTO_SYNC_LABELS = { 0: 'Off', 5: '5 min', 15: '15 min', 60: 'Hourly', 360: '6 hours' };

function drawSync(host) {
  const summary = el('div', { class: 'muted', style: { marginTop: '9px', maxWidth: '52em', lineHeight: '1.7' } });
  const detail = el('div', { class: 'rows', style: { maxWidth: '640px' } });
  const button = el('button', { class: 'btn primary lg', text: 'Sync now' });
  const pullButton = el('button', { class: 'btn lg', text: 'Bring down only' });
  const pushButton = el('button', { class: 'btn lg', text: 'Send up only' });
  let busy = false;

  function when(ms) {
    if (!ms) return 'never';
    const d = new Date(ms);
    const today = new Date().toDateString() === d.toDateString();
    return today
      ? `today at ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  /**
   * The next automatic run. A time already gone means the loop simply has not
   * reached its next wake-up yet, and saying "12:04" for a moment in the past
   * would read like something had gone wrong.
   */
  function whenNext(ms) {
    if (!ms) return 'not scheduled';
    return ms <= Date.now() ? 'any moment' : when(ms);
  }

  function paint(status) {
    if (status.provider !== 'supabase') {
      summary.textContent =
        'This library signs in locally, so there is no project to sync with. Sync becomes available once the app is configured with a Supabase project.';
      for (const b of [button, pullButton, pushButton]) b.disabled = true;
      mount(detail);
      return;
    }

    summary.textContent =
      'Your library is kept on this Mac and mirrored to your Supabase project, and syncing goes both ways: '
      + 'work done on another Mac arrives here, and work done here goes up. Where both sides changed the same '
      + 'file, neither version is thrown away — this Mac keeps its own and the other one arrives beside it. '
      + 'The trash stays on this Mac: binning a file removes it from the project rather than reproducing your '
      + 'bin everywhere, and it is still here to restore. The copy upstream is private to your account: '
      + 'nothing is readable without signing in as you.';

    const last = status.last;
    mount(detail,
      el('div', { class: 'row' },
        el('div', { class: 'grow' },
          el('div', { text: 'Items this sync covers' }),
          el('div', { class: 'dim', style: { fontSize: '11px', marginTop: '3px' }, text: 'Anything in the trash is left out.' })),
        el('span', { class: 'dim', text: String(status.items) }),
      ),
      el('div', { class: 'row' },
        el('div', { class: 'grow' }, el('div', { text: 'Last sync' })),
        el('span', { class: 'dim', text: when(last?.finished_at) }),
      ),
      el('div', { class: 'row' },
        el('div', { class: 'grow' },
          el('div', { text: 'Automatically' }),
          el('div', { class: 'dim', style: { fontSize: '11px', marginTop: '3px' },
            text: 'Runs in the background whenever the app is open, whether or not this window is.' })),
        seg(AUTO_SYNC_CHOICES, String(status.auto?.minutes ?? 0),
          (value) => patchAccount({ autoSyncMinutes: Number(value) }), AUTO_SYNC_LABELS),
      ),
      status.auto?.minutes
        ? el('div', { class: 'row' },
            el('div', { class: 'grow' }, el('div', { text: 'Next automatic sync' })),
            el('span', { class: 'dim', text: whenNext(status.auto.nextRunAt) }),
          )
        : null,
      /*
       * Whether this Mac is being told about changes or waiting its turn.
       * `connected` is deliberately reported separately from `enabled`: the
       * feature can be switched on while the socket is down, and saying
       * "instantly" in that state would be a promise the app cannot keep.
       */
      status.live?.enabled
        ? el('div', { class: 'row' },
            el('div', { class: 'grow' },
              el('div', { text: 'Changes from your other Macs' }),
              el('div', { class: 'dim', style: { fontSize: '11px', marginTop: '3px' },
                text: status.live.connected
                  ? 'Arrive within a few seconds, without waiting for the next automatic sync.'
                  : 'Not connected at the moment, so these arrive on the next automatic sync instead.' })),
            el('span', { class: 'dim', text: status.live.connected ? 'Listening' : 'Off' }),
          )
        : null,
      last?.pulled
        ? el('div', { class: 'row' },
            el('div', { class: 'grow' }, el('div', { text: 'Brought down last time' })),
            el('span', { class: 'dim', text: String(last.pulled) }),
          )
        : null,
      last?.conflicts
        ? el('div', { class: 'row' },
            icon('files'),
            el('div', { class: 'grow' },
              el('div', { text: `${last.conflicts} kept twice` }),
              el('div', { class: 'dim', style: { fontSize: '11px', marginTop: '3px' },
                text: 'Both Macs had changed the same file. Look for “(from another device)” in your library.' })),
          )
        : null,
      last?.error
        ? el('div', { class: 'row' },
            icon('warning-circle', { class: 'bad' }),
            el('div', { class: 'grow' },
              el('div', { text: 'The last sync did not finish' }),
              el('div', { class: 'dim', style: { fontSize: '11px', marginTop: '3px' }, text: last.error })),
          )
        : null,
    );
  }

  async function refresh() {
    try {
      paint(await api.syncStatus());
    } catch (err) {
      summary.textContent = err?.message ?? 'Could not read the sync status.';
    }
  }

  /**
   * One report for whichever halves ran.
   *
   * "Synced" on its own tells a student nothing about the thing they actually
   * want to know after setting a second Mac up, which is how much arrived.
   */
  function describe({ pulled, pushed }) {
    const parts = [];
    if (pulled?.created) parts.push(`${pulled.created} brought down`);
    if (pulled?.updated) parts.push(`${pulled.updated} updated from elsewhere`);
    if (pulled?.trashed) parts.push(`${pulled.trashed} moved to trash`);
    if (pulled?.conflicted) parts.push(`${pulled.conflicted} kept twice`);
    if (pushed?.uploaded) parts.push(`${pushed.uploaded} uploaded`);
    if (pushed?.removed) parts.push(`${pushed.removed} removed upstream`);
    return parts.length ? parts.join(' · ') : 'Everything was already in step.';
  }

  async function run(action, label, node) {
    if (busy) return;
    busy = true;
    for (const b of [button, pullButton, pushButton]) b.disabled = true;
    const was = node.textContent;
    node.textContent = label;
    try {
      toast(describe(await action()));
      await loadLibrary();
      await refresh();
    } catch (err) {
      reportError(err);
      await refresh();
    } finally {
      busy = false;
      for (const b of [button, pullButton, pushButton]) b.disabled = false;
      node.textContent = was;
    }
  }

  button.onclick = () => run(() => api.runSync(), 'Syncing…', button);
  pullButton.onclick = () => run(() => api.pullSync(), 'Bringing down…', pullButton);
  pushButton.onclick = () => run(() => api.pushSync(), 'Sending up…', pushButton);

  mount(host,
    el('div', null, el('h2', { class: 'section', text: 'Sync' }), summary),
    detail,
    el('div', { class: 'sync-actions' }, button, pullButton, pushButton),
  );
  refresh();
}

/* ── your data ───────────────────────────────────────────── */

/**
 * The way out.
 *
 * Sync is a mirror, and a mirror faithfully reproduces a deletion, so it is
 * not a backup and this screen does not pretend it is. What is offered here is
 * one archive of plain files — Markdown, SVG, the original PDFs, JSON — that
 * opens on a computer which has never heard of Studex. Somebody trusting a
 * degree's worth of work to an app is owed a door that is visibly unlocked,
 * and being able to see it is most of the point of it existing.
 *
 * It is an anchor rather than a button because a download is a navigation: the
 * app's WKWebView hands it to the save panel, and the archive streams to disk
 * without the web layer ever holding it.
 */
async function drawData(host) {
  const usage = el('span', { class: 'muted', text: '—' });

  mount(host,
    el('div', null,
      el('h2', { class: 'section', text: 'Your data' }),
      el('div', { class: 'muted', style: { marginTop: '9px', maxWidth: '560px' } },
        'Everything on this account, as one archive of ordinary files. Nothing in it needs '
        + 'Studex, or any other program in particular, to be read.'),
    ),
    el('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '560px' } },
      el('div', { class: 'setting-row' }, el('span', { class: 'label', text: 'In the archive' }),
        el('span', { text: 'Notes as Markdown, canvases as SVG, your PDFs unchanged, and your decks, calendar and library as JSON.' })),
      el('div', { class: 'setting-row' }, el('span', { class: 'label', text: 'Roughly' }), usage),
      el('div', { class: 'rule' }),
      el('div', null,
        el('a', { class: 'btn lg primary', href: '/api/export', download: '' },
          icon('download-simple'), 'Export everything'),
      ),
      el('div', { class: 'dim', style: { fontSize: '11.5px' } },
        'A large library takes a moment to gather. The archive is built as it downloads, so '
        + 'the size is not known until it finishes.'),
    ),
  );

  try {
    const { storage } = await api.storage();
    usage.textContent = bytes(storage?.used_bytes ?? 0);
    usage.classList.remove('muted');
  } catch {
    // A figure that could not be fetched is not worth an error over: the
    // export itself does not depend on it.
    usage.textContent = '—';
  }
}

function drawAccount(host) {
  mount(host,
    el('div', null,
      el('h2', { class: 'section', text: 'Account' }),
      el('div', { class: 'muted', style: { marginTop: '9px' }, text: state.user?.email ?? '' }),
    ),
    el('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '420px' } },
      el('div', { class: 'setting-row' }, el('span', { class: 'label', text: 'Name' }), el('span', { text: state.user?.display_name ?? '' })),
      el('div', { class: 'setting-row' }, el('span', { class: 'label', text: 'Plan' }), el('span', { text: state.user?.plan ?? 'free' })),
      el('div', { class: 'setting-row' }, el('span', { class: 'label', text: 'Member since' }),
        el('span', { text: state.user?.created_at ? new Date(state.user.created_at).toLocaleDateString() : '—' })),
      el('div', { class: 'rule' }),
      el('div', null, el('button', { class: 'btn lg', onclick: () => changePassword() }, icon('key'), 'Change password')),
    ),
  );
}

async function changePassword() {
  const current = el('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
  const next = el('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const confirm = el('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const error = el('div', { style: { color: 'oklch(0.78 0.12 25)', fontSize: '12.5px' } });

  const ok = await dialog({
    title: 'Change password',
    confirmLabel: 'Change password',
    body: el('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
      el('div', { class: 'field' }, el('label', { text: 'Current password' }), current),
      el('div', { class: 'field' }, el('label', { text: 'New password' }), next),
      el('div', { class: 'field' }, el('label', { text: 'Confirm new password' }), confirm),
      el('div', { class: 'dim', style: { fontSize: '11.5px' } }, 'Changing your password signs out every other session.'),
      error,
    ),
    onConfirm: async () => {
      error.textContent = '';
      if (next.value !== confirm.value) { error.textContent = 'The new passwords do not match.'; return false; }
      try {
        await api.changePassword(current.value, next.value);
        return true;
      } catch (err) {
        error.textContent = err?.status === 422
          ? 'That password is too weak. Use at least 12 characters.'
          : err?.message ?? 'Could not change the password.';
        return false;
      }
    },
  });
  if (ok) toast('Password changed. Other sessions signed out.');
}

/* ── sharing ──────────────────────────────────────────────────────────── */

/**
 * Every live link on the account, in one list.
 *
 * A link is made from the file it shares, which is the right place to make
 * one and the wrong place to audit them: a link created months ago sits inside
 * a file nobody has opened since. This is the answer to "what have I got out
 * there", and the one place all of it can be taken back.
 *
 * The addresses are not here, and cannot be — only a hash of each token is
 * stored. What a row can honestly show is what the link opens, what it permits
 * and when it lapses.
 */
async function drawSharing(host) {
  mount(host, el('div', { class: 'loading' }, el('div', { class: 'spinner' }), 'Loading…'));
  let shares = [];
  try { ({ shares } = await api.shares()); } catch (err) { reportError(err); }

  const name = (share) => {
    const target = share.target_type === 'file' ? fileById(share.target_id) : folderById(share.target_id);
    // A share outlives nothing — deleting the target revokes it — but the
    // library in memory can be a moment behind, so this does not insist.
    return target?.title ?? target?.name ?? 'Somewhere in your library';
  };

  const when = (share) => {
    if (share.expires_at === null) return 'No expiry';
    const days = Math.round((share.expires_at - Date.now()) / 86_400_000);
    if (days < 0) return 'Expired';
    if (days === 0) return 'Expires today';
    return `Expires in ${days} ${days === 1 ? 'day' : 'days'}`;
  };

  const revoke = async (share) => {
    const ok = await confirmDialog({
      title: 'Revoke this link?',
      message: `Anyone holding the link to “${name(share)}” loses access immediately. This cannot be undone.`,
      confirmLabel: 'Revoke',
    });
    if (!ok) return;
    try { await api.deleteShare(share.id); toast('Link revoked.'); drawSharing(host); }
    catch (err) { reportError(err); }
  };

  mount(host,
    el('div', null,
      el('h2', { class: 'section', text: 'Sharing' }),
      el('div', { class: 'muted', style: { marginTop: '9px', maxWidth: '52em', lineHeight: '1.7' } },
        'Links you have made. Anyone holding one needs no account, and an edit link cannot tell two holders apart. '
        + 'Studex stores only a hash of each link, so an address can be revoked here but never shown again.'),
    ),
    shares.length
      ? el('div', { class: 'rows', style: { maxWidth: '640px' } },
          shares.map((share) => el('div', { class: 'row' },
            icon(share.target_type === 'folder' ? 'folder' : 'file-text', { class: 'dim' }),
            el('div', { class: 'grow' },
              el('div', { text: name(share) }),
              el('div', { class: 'dim', style: { fontSize: '11px', marginTop: '3px' },
                text: `${share.permission === 'edit' ? 'Can edit' : 'Read only'} · ${when(share)}` }),
            ),
            el('button', { class: 'pill-btn', onclick: () => revoke(share) }, icon('x', { size: 12 }), 'Revoke'),
          )),
        )
      : el('div', { class: 'muted', style: { maxWidth: '52em' },
          text: 'Nothing is shared. Every file stays private to this account until you make a link for it.' }),
    shares.length
      ? el('div', null, el('button', {
          class: 'btn lg', onclick: async () => {
            const ok = await confirmDialog({
              title: `Revoke all ${shares.length} links?`,
              message: 'Everyone holding any link to anything of yours loses access immediately.',
              confirmLabel: 'Revoke them all',
            });
            if (!ok) return;
            try {
              // One at a time and in order, so a failure part-way through
              // leaves a list that says exactly how far it got.
              for (const share of shares) await api.deleteShare(share.id);
              toast(`${shares.length} ${shares.length === 1 ? 'link' : 'links'} revoked.`);
            } catch (err) { reportError(err); }
            drawSharing(host);
          },
        }, icon('link-break'), 'Revoke every link'))
      : null,
  );
}

/* ── lock ─────────────────────────────────────────────────────────────── */

/**
 * The delays worth offering. A minute at the bottom because that is what
 * somebody who wants this actually wants, and an hour at the top because past
 * that the Mac's own lock has already taken over.
 */
const LOCK_DELAYS = [
  { value: 0, label: 'Never' },
  { value: 1, label: '1 min' },
  { value: 5, label: '5 min' },
  { value: 15, label: '15 min' },
  { value: 60, label: '1 hour' },
];

const BIOMETRY_NAME = {
  'touch-id': 'Touch ID',
  'optic-id': 'Optic ID',
  password: 'your login password',
};

/**
 * Locking the app when you walk away from it.
 *
 * The window is covered the moment Studex stops being the app in front,
 * whatever the delay says — that costs nothing and is the part that matters to
 * somebody walking past a library desk. The delay decides only whether coming
 * back also costs a fingerprint.
 *
 * What this is not is said plainly at the bottom. The database on disk is
 * exactly as readable as it was; this stops a person at the keyboard, not a
 * person with the drive, and pretending otherwise would be the worst thing a
 * screen like this could do.
 */
async function drawLock(host) {
  mount(host, el('div', { class: 'loading' }, el('div', { class: 'spinner' }), 'Loading…'));
  const lock = await lockSettings();

  const redraw = async (patch) => {
    // The shell answers with what it then holds, which is not always what was
    // asked for: a Mac that cannot authenticate refuses to be locked.
    await setLockSettings(patch);
    drawLock(host);
  };

  const unavailable = isNative
    ? 'This Mac has no Touch ID, no paired Watch and no login password to fall back on, '
      + 'so there would be no way back in. The lock is switched off until it has one.'
    : 'The lock is part of the Mac app. Nothing here applies in a browser tab, which is '
      + 'locked by whatever locks the machine it is open on.';

  mount(host,
    el('div', null,
      el('h2', { class: 'section', text: 'Lock' }),
      el('div', { class: 'muted', style: { marginTop: '9px', maxWidth: '52em', lineHeight: '1.7' } },
        'Studex covers its window as soon as you switch away from it, so what is on screen is not '
        + 'left on screen. How long you can be gone before getting back in needs '
        + `${BIOMETRY_NAME[lock.biometry] ?? 'your login password'} is up to you.`),
    ),

    lock.supported
      ? el('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px', maxWidth: '520px' } },
          el('div', null,
            row('Ask again after', seg(
              LOCK_DELAYS.map((d) => d.value),
              lock.minutes,
              (value) => redraw({ minutes: value }),
              Object.fromEntries(LOCK_DELAYS.map((d) => [d.value, d.label])),
            )),
            el('div', { class: 'muted', style: { fontSize: '12px', lineHeight: '1.6', marginTop: '6px' } },
              'Time away from Studex, not time idle in it. Never still covers the window; '
              + 'it just never asks for anything to uncover it.'),
          ),

          el('div', null,
            row('Ask before making a share link',
              toggle(lock.share, (value) => redraw({ share: value }))),
            el('div', { class: 'muted', style: { fontSize: '12px', lineHeight: '1.6', marginTop: '6px' } },
              'Making a link is the one thing in Studex that reaches outside your account, and the '
              + 'one thing somebody at your open Mac could do in ten seconds. A link already made '
              + 'cannot ask anything of whoever opens it — it opens in their browser, on their '
              + 'machine — so this guards the making of it.'),
          ),

          el('div', null,
            el('button', { class: 'btn lg', onclick: () => lockNow() }, icon('lock'), 'Lock now'),
            el('div', { class: 'muted', style: { fontSize: '12px', lineHeight: '1.6', marginTop: '9px' } },
              'Also ⇧⌘L, or Studex › Lock Studex.'),
          ),

          el('div', { class: 'muted', style: { fontSize: '12px', lineHeight: '1.6', maxWidth: '52em' } },
            'This locks the window, not the disk. Your library is a file in your home folder and '
            + 'stays as readable as anything else there — turn on FileVault in System Settings if '
            + 'that is what you need.'),
        )
      : el('div', { class: 'muted', style: { maxWidth: '52em', lineHeight: '1.7' }, text: unavailable }),
  );
}

/* ── sessions ─────────────────────────────────────────────────────────── */

async function drawSessions(host) {
  mount(host, el('div', { class: 'loading' }, el('div', { class: 'spinner' }), 'Loading…'));
  let sessions = [];
  try { sessions = (await api.sessions()).sessions; } catch (err) { reportError(err); }

  mount(host,
    el('div', null,
      el('h2', { class: 'section', text: 'Sessions' }),
      el('div', { class: 'muted', style: { marginTop: '9px', maxWidth: '52em', lineHeight: '1.7' } },
        'Every device signed in to this account. Sessions expire after 14 days of inactivity, and 90 days regardless.'),
    ),
    el('div', { class: 'rows', style: { maxWidth: '640px' } },
      sessions.map((session) => el('div', { class: 'row' },
        icon(session.current ? 'desktop' : 'devices', { class: session.current ? '' : 'dim' }),
        el('div', { class: 'grow' },
          el('div', { text: session.user_agent ? shortUserAgent(session.user_agent) : 'Unknown device' }),
          el('div', { class: 'dim', style: { fontSize: '11px', marginTop: '3px' },
            text: `Last used ${new Date(session.last_used_at ?? session.created_at).toLocaleString()}` }),
        ),
        session.current ? el('span', { class: 'pill ready', text: 'This device' }) : null,
      )),
    ),
    sessions.length > 1
      ? el('div', null, el('button', {
          class: 'btn lg', onclick: async () => {
            const ok = await confirmDialog({
              title: 'Sign out other sessions?',
              message: 'Every other signed-in device will need to sign in again.',
              confirmLabel: 'Sign them out',
            });
            if (!ok) return;
            try {
              const { revoked } = await api.revokeOtherSessions();
              toast(`${revoked} ${revoked === 1 ? 'session' : 'sessions'} signed out.`);
              drawSessions(host);
            } catch (err) { reportError(err); }
          },
        }, icon('sign-out'), 'Sign out other sessions'))
      : null,
  );
}

/** Keeps the device list readable without pretending to parse user agents. */
function shortUserAgent(ua) {
  if (/Studex/i.test(ua)) return 'Studex for Mac';
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Windows/i.test(ua)) return 'Windows PC';
  return ua.slice(0, 60);
}

/** Focus mode: how long, and how much of Studex fades away while it runs. */
function focusPrefsPanel() {
  const host = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px' } });
  const slider = (key, min, max, step, unit) => {
    const value = el('span', { class: 'range-value', text: `${focusPrefs()[key]}${unit}` });
    const input = el('input', {
      type: 'range', min, max, step, value: focusPrefs()[key], class: 'range',
      oninput: (e) => { const v = Number(e.target.value); value.textContent = `${v}${unit}`; setFocusPrefs({ [key]: v }); },
    });
    return el('div', { class: 'range-row' }, input, value);
  };
  const draw = () => {
    const p = focusPrefs();
    const set = (patch) => { setFocusPrefs(patch); draw(); };
    mount(host,
      el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
        el('div', { class: 'section-label plain', text: 'FOCUS MODE' }),
        el('button', { class: 'btn', style: { marginLeft: 'auto' }, onclick: () => openFocus() }, icon('arrows-out-simple'), 'Open focus'),
      ),
      el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '44px' } },
        el('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px' } },
          row('Focus length', slider('minutes', 5, 120, 5, ' min')),
          row('Break length', slider('breakMinutes', 1, 30, 1, ' min')),
          row('Blocks per session', seg(['2', '3', '4', '6', '8'], String(p.cycles), (v) => set({ cycles: Number(v) }))),
          row('Start next block after a break', toggle(p.autoContinue, (v) => set({ autoContinue: v }))),
        ),
        el('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px' } },
          row('Blur Studex behind the timer', toggle(p.blur, (v) => set({ blur: v }))),
          p.blur ? row('Blur strength', slider('blurStrength', 2, 40, 1, ' px')) : null,
          row('Dim', slider('dim', 0, 90, 5, '%')),
          row('Hide the sidebar while focusing', toggle(p.hideSidebar, (v) => set({ hideSidebar: v }))),
          el('div', { class: 'muted', style: { fontSize: '12px', lineHeight: '1.6' } },
            '⌘⇧F opens or minimises focus from anywhere. Minimised, it sits in the corner and keeps counting.'),
        ),
      ),
    );
  };
  draw();
  return host;
}

/** A density slider that applies as it moves, without redrawing the page under the pointer. */
function densitySlider(key) {
  const label = (v) => (v <= -1 ? 'Tight' : v <= 1 ? 'Compact' : v <= 4 ? 'Comfortable' : 'Airy');
  const value = el('span', { class: 'range-value', style: { minWidth: '84px' }, text: label(densityPrefs()[key]) });
  return el('div', { class: 'range-row' },
    el('input', {
      type: 'range', class: 'range', min: -2, max: 8, step: 1, value: densityPrefs()[key],
      'aria-label': key === 'sidebar' ? 'Sidebar density' : 'Page density',
      oninput: (e) => { const v = Number(e.target.value); value.textContent = label(v); setDensityPrefs({ [key]: v }); },
    }),
    value,
  );
}
