/**
 * Sending something to the people who make Studex.
 *
 * Issues live on GitHub, which is where the developers already work, so the
 * app does not run its own inbox: it collects what someone wants to say, adds
 * the two facts every report needs — which version, which macOS — and hands
 * the whole thing to the issue form with the fields already filled in. The
 * person still sees what is about to be posted, and still presses the button
 * on GitHub, because an issue goes out under their name and in public.
 */
import { el, icon } from './dom.js';
import { api } from './api.js';
import { dialog } from './dialog.js';
import { toast } from './store.js';

const REPO = 'https://github.com/IronMaxi21/Studex-releases';

const KINDS = [
  {
    id: 'improvement',
    template: 'improvement.yml',
    label: 'Suggest an improvement',
    hint: 'Something Studex should do, or should do better.',
    icon: 'lightbulb',
    prompt: 'What should Studex do?',
    placeholder: 'Describe it the way you would to a friend using the app.',
    field: 'idea',
  },
  {
    id: 'bug',
    template: 'bug.yml',
    label: 'Report something broken',
    hint: 'It did the wrong thing, or stopped doing anything.',
    icon: 'bug',
    prompt: 'What happened?',
    placeholder: 'What you were doing, and what Studex did instead.',
    field: 'what',
  },
];

/** The macOS version, as far as the browser engine will say. */
function macOsVersion() {
  const match = /Mac OS X (\d+[._]\d+(?:[._]\d+)?)/.exec(navigator.userAgent);
  return match ? match[1].replace(/_/g, '.') : '';
}

async function runningVersion() {
  try {
    return (await api.updateState()).update?.version ?? '';
  } catch {
    // Offline, or signed out of the release project: the form still opens,
    // just without this one field filled in.
    return '';
  }
}

function issueUrl(kind, note, version) {
  const params = new URLSearchParams({ template: kind.template, macos: macOsVersion() });
  if (note) params.set(kind.field, note);
  if (version) params.set('version', version);
  return `${REPO}/issues/new?${params.toString()}`;
}

/**
 * Opens the sheet. `kind` preselects one of the two, which is how a menu item
 * that already says "report a problem" avoids asking again.
 */
export async function openFeedbackSheet(kindId = 'improvement') {
  let kind = KINDS.find((k) => k.id === kindId) ?? KINDS[0];
  const version = await runningVersion();

  const note = el('textarea', {
    class: 'input',
    id: 'feedback-note',
    rows: 5,
    placeholder: kind.placeholder,
  });

  const choices = el('div', { class: 'feedback-kinds' });
  const drawChoices = () => {
    choices.replaceChildren(...KINDS.map((k) => el('button', {
      class: k.id === kind.id ? 'feedback-kind on' : 'feedback-kind',
      type: 'button',
      'aria-pressed': String(k.id === kind.id),
      onclick: () => {
        kind = k;
        note.placeholder = k.placeholder;
        prompt.textContent = k.prompt;
        drawChoices();
        note.focus();
      },
    },
      icon(k.icon),
      el('div', {},
        el('div', { class: 'feedback-kind-label', text: k.label }),
        el('div', { class: 'dim', text: k.hint }),
      ),
    )));
  };
  const prompt = el('label', { for: 'feedback-note', text: kind.prompt });
  drawChoices();

  const body = el('div', { class: 'feedback-sheet' },
    choices,
    el('div', { class: 'field' }, prompt, note),
    el('div', { class: 'feedback-note dim' },
      icon('info'),
      el('span', {
        text: version
          ? `Studex ${version} and your macOS version go with it. Nothing else leaves this Mac — issues are public, so your notes stay here.`
          : 'Your macOS version goes with it. Nothing else leaves this Mac — issues are public, so your notes stay here.',
      }),
    ),
  );

  await dialog({
    title: 'Send this to the developers',
    body,
    confirmLabel: 'Open on GitHub',
    cancelLabel: 'Not now',
    onConfirm: () => {
      // The browser, not this window: the issue is posted as the person, from
      // an account the app has nothing to do with.
      const link = el('a', { href: issueUrl(kind, note.value.trim(), version), target: '_blank', rel: 'noopener noreferrer' });
      document.body.appendChild(link);
      link.click();
      link.remove();
      toast('Opened the form on GitHub — press Submit there to send it.');
      return true;
    },
  });
}
