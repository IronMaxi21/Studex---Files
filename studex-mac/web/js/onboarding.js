/**
 * The first thing anyone sees, once: a few screens saying what Studex is,
 * before the sign-in page.
 *
 * "Once" has to survive a relaunch, and this page's own storage does not: the
 * server gets a new port every launch, and localStorage belongs to an origin,
 * port included. So the flag lives in the shell's UserDefaults — handed to
 * the page at load as `window.__studexOnboarded` and set over the bridge.
 * localStorage is kept as well, for a plain browser during development and for
 * a reload in the same launch, when the injected value is from before.
 */
import { el, icon } from './dom.js';
import { markOnboarded as tellShell } from './native.js';

const KEY = 'studex.onboarded';

const SCREENS = [
  {
    icon: 'graduation-cap',
    title: 'Welcome to Studex',
    subtitle: 'Your notes, flashcards, PDFs and revision plan, together in one app.',
  },
  {
    icon: 'note-pencil',
    title: 'Write notes that teach you back',
    subtitle: 'Turn any line of your notes into a flashcard, and review it just before you would forget.',
  },
  {
    icon: 'calendar-check',
    title: 'Plan around your exams',
    subtitle: 'Add your timetable and exam dates, and Studex fits revision into the days before them.',
  },
  {
    icon: 'sparkle',
    title: 'Ask AI about what is open',
    subtitle: 'Get an explanation, a quick quiz or a set of cards from the page you are reading.',
  },
];

export function hasOnboarded() {
  if (window.__studexOnboarded === true) return true;
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

function markOnboarded() {
  window.__studexOnboarded = true;
  tellShell();
  try { localStorage.setItem(KEY, '1'); } catch { /* the shell's copy is the one that lasts */ }
}

/** The onboarding screens; `onDone` runs after Get Started. */
export function onboardingView(onDone) {
  let at = 0;
  let done = false;
  const card = el('div', { class: 'onboarding-card', role: 'group', 'aria-roledescription': 'onboarding', 'aria-labelledby': 'onboarding-title' });
  const view = el('div', { class: 'onboarding' }, card);

  function draw() {
    const screen = SCREENS[at];
    const last = at === SCREENS.length - 1;
    card.replaceChildren(
      el('div', { class: 'onboarding-art' }, icon(screen.icon, { size: 36 })),
      el('h1', { class: 'onboarding-title', id: 'onboarding-title', text: screen.title }),
      el('p', { class: 'onboarding-subtitle', text: screen.subtitle }),
      el('div', { class: 'onboarding-dots', 'aria-label': `Screen ${at + 1} of ${SCREENS.length}` },
        SCREENS.map((_, i) => el('span', { class: 'onboarding-dot' + (i === at ? ' on' : '') }))),
      el('button', {
        class: 'btn primary lg onboarding-next', type: 'button',
        text: last ? 'Get Started' : 'Next',
        onclick: () => {
          if (!last) { at += 1; draw(); return; }
          if (done) return; // a double-click or a held Return
          done = true;
          markOnboarded();
          onDone();
        },
      }),
    );
    card.querySelector('.onboarding-next')?.focus();
  }

  draw();
  return view;
}
