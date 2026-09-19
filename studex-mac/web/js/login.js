import { el, mount } from './dom.js';
import { logoMark } from './logo.js';
import { api, ApiError } from './api.js';
import { isNative } from './native.js';
import { toast } from './store.js';

const MIN_PASSWORD = 12;

/**
 * Sign-in view. Resolves once a session exists.
 *
 * It also has to cope with an empty instance: a freshly installed desktop app
 * has no accounts, and offering only a sign-in form there would be a dead end.
 * The view therefore asks the server whether anyone has registered yet and
 * starts in whichever mode can actually succeed.
 */
export function loginView(onSuccess) {
  const form = el('form');
  const root = el('div', { class: 'login' }, form);

  let mode = 'sign-in';
  /** Null until the server answers; the toggle stays hidden until it does. */
  let hasUsers = null;
  /**
   * Where the server checks credentials. Under 'supabase' the accounts live in
   * the Supabase project, so an empty local database proves nothing about
   * whether the person already has one — the first-run shortcut below only
   * makes sense when this instance is also the account store.
   */
  let provider = 'local';
  /** Set to the address awaiting confirmation, which replaces the form. */
  let awaitingConfirmation = null;

  api.authStatus()
    .then((status) => {
      hasUsers = Boolean(status?.hasUsers);
      provider = status?.provider === 'supabase' ? 'supabase' : 'local';
      if (provider === 'local' && !hasUsers) mode = 'create';
      render();
    })
    .catch(() => {
      // Unreachable server: leave the sign-in form up, which will say so
      // plainly the moment it is submitted.
    });

  function render() {
    if (awaitingConfirmation) return renderConfirmation();

    const creating = mode === 'create';
    const firstRun = creating && hasUsers === false && provider === 'local';

    const error = el('div', { class: 'err' });
    const name = el('input', { class: 'input', type: 'text', name: 'name', autocomplete: 'name', maxlength: '80', required: true });
    const email = el('input', { class: 'input', type: 'email', name: 'email', autocomplete: creating ? 'email' : 'username', autofocus: true, required: true });
    const password = el('input', {
      class: 'input',
      type: 'password',
      name: 'password',
      autocomplete: creating ? 'new-password' : 'current-password',
      required: true,
    });
    const submitLabel = creating ? 'Create account' : 'Sign in';
    const submit = el('button', { class: 'btn primary lg', type: 'submit' }, submitLabel);

    let busy = false;

    async function attempt(event) {
      event.preventDefault();
      if (busy) return;

      if (creating && password.value.length < MIN_PASSWORD) {
        error.textContent = `Choose a password of at least ${MIN_PASSWORD} characters.`;
        password.focus();
        return;
      }

      busy = true;
      submit.disabled = true;
      error.textContent = '';
      submit.textContent = creating ? 'Creating…' : 'Signing in…';

      try {
        if (creating) {
          const result = await api.register(email.value.trim(), password.value, name.value.trim());
          // Supabase may be set to confirm the address first, in which case
          // there is no session yet and nothing to show the app for.
          if (result && result.pendingConfirmation) {
            awaitingConfirmation = email.value.trim();
            render();
            return;
          }
        } else {
          const result = await api.login(email.value.trim(), password.value);
          // One live session per account. If this sign-in ended one, say so
          // here rather than leaving the other Mac to work it out alone.
          if (result?.signedOutElsewhere > 0) {
            toast('Signed in here. Studex signed out your other device.');
          }
        }
        onSuccess();
        return;
      } catch (err) {
        error.textContent = message(err, creating);
        password.value = '';
        password.focus();
      } finally {
        busy = false;
        submit.disabled = false;
        submit.textContent = submitLabel;
      }
    }

    // The toggle is pointless on a first run — there is nothing to sign in to —
    // and it is hidden until the server has said which case this is, so it
    // never flickers into the wrong state.
    const toggle = hasUsers === null || firstRun
      ? null
      : el('button', {
          class: 'btn link',
          type: 'button',
          onclick: () => { mode = creating ? 'sign-in' : 'create'; render(); },
        }, creating ? 'I already have an account' : 'Create an account');

    form.onsubmit = attempt;
    // mount(), not form.append(): the native method stringifies null into the
    // page, and half of what follows is conditional.
    mount(form,
      logoMark(),
      el('h1', { text: 'Studex' }),
      el('div', { class: 'muted', style: { marginBottom: '4px' } },
        firstRun ? 'Set up your library to get started.'
          : creating ? 'Create an account for this library.'
            : 'Sign in to your library.'),
      ...(creating ? [el('div', { class: 'field' }, el('label', { for: 'name', text: 'Name' }), name)] : []),
      el('div', { class: 'field' }, el('label', { for: 'email', text: 'Email' }), email),
      el('div', { class: 'field' },
        el('label', { for: 'password', text: 'Password' }),
        password,
        creating ? el('div', { class: 'hint', text: `At least ${MIN_PASSWORD} characters.` }) : null),
      error,
      submit,
      toggle,
      // A development convenience against the seeded database. The packaged
      // app never shows credentials on its sign-in screen.
      !isNative && !creating && hasUsers && provider === 'local'
        ? el('div', { class: 'hint' }, 'Demo account: aisha@studex.test', el('br'), 'Password: revision-season-2026')
        : null,
    );
    email.focus();
  }

  /**
   * Shown instead of the form once Supabase has sent a confirmation email.
   * The account exists there, but nothing yet proves the address belongs to
   * whoever asked, so there is no session and no local library to open.
   */
  function renderConfirmation() {
    form.onsubmit = (event) => event.preventDefault();
    mount(form,
      logoMark(),
      el('h1', { text: 'Check your email' }),
      el('div', { class: 'muted', style: { marginBottom: '4px' } },
        'A confirmation link is on its way to'),
      el('div', { class: 'field' }, el('strong', { text: awaitingConfirmation })),
      el('div', { class: 'hint', text: 'Open it, then come back and sign in.' }),
      el('button', {
        class: 'btn primary lg',
        type: 'button',
        onclick: () => { awaitingConfirmation = null; mode = 'sign-in'; render(); },
      }, 'Back to sign in'),
    );
  }

  function message(err, creating) {
    if (!(err instanceof ApiError)) return 'Something went wrong. Please try again.';
    if (err.status === 0) return 'Cannot reach the Studex server.';
    if (err.status === 429) return 'Too many attempts. Wait a few minutes and try again.';
    // The identity provider is a second thing that can be down, and it fails
    // differently from the server being unreachable: retrying will not help
    // until it is back.
    if (err.status === 502) return err.message || 'The sign-in service is unavailable.';
    // Unconfirmed address, or a password the provider judged too weak. Both
    // carry a message worth showing verbatim.
    if (err.status === 403) return err.message || 'That sign-in was refused.';
    if (!creating) {
      // The server answers unknown-address and wrong-password identically, and
      // so does this: nothing here should hint at which half was wrong.
      return 'That email and password did not match.';
    }
    if (err.status === 409) return 'An account already exists for that email.';
    if (err.status === 422) return 'Check the details above and try again.';
    return err.message || 'Could not create the account.';
  }

  render();
  return root;
}
