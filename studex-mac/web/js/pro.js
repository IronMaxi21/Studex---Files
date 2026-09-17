/**
 * The Pro pitch, and the one place that knows what Pro is.
 *
 * It appears twice: from the Plan screen, when someone asks to move up, and
 * from wherever a Free limit was just reached — because the moment you are
 * told you cannot make a fourth canvas is the moment the list of what Pro adds
 * is actually worth reading.
 */
import { el, icon } from './dom.js';
import { dialog } from './dialog.js';
import { api } from './api.js';
import { state, toast, reportError, rerender } from './store.js';

/** Kept in step with PRO_QUOTA_MULTIPLIER on the server. */
export const PRO_MULTIPLIER = 5;

/** What the server actually enforces differently. Nothing else is claimed. */
export const PRO_FEATURES = [
  { icon: 'infinity', title: 'Canvases without a ceiling', free: 'Free keeps 3.' },
  { icon: 'file-pdf', title: 'PDFs without a ceiling', free: 'Free keeps 5.' },
  { icon: 'hard-drives', title: `${PRO_MULTIPLIER}× the storage`, free: 'Room for a library of scanned notes.' },
];

export const FREE_INCLUDES = [
  'Notes and decks, as many as you like',
  'Spaced repetition, test mode and daily review',
  'Calendar, timetable and focus sessions',
  'Full-text search across everything',
];

function featureList() {
  return el('div', { class: 'pro-features' },
    PRO_FEATURES.map((feature) => el('div', { class: 'pro-feature' },
      icon(feature.icon, { size: 17 }),
      el('div', null,
        el('div', { class: 'title', text: feature.title }),
        el('div', { class: 'sub', text: feature.free }),
      ),
    )),
    el('div', { class: 'rule' }),
    el('div', { class: 'sub', text: 'Everything in Free is in Pro:' }),
    el('div', { class: 'pro-includes' },
      FREE_INCLUDES.map((line) => el('div', { class: 'line' }, icon('check', { size: 12 }), line)),
    ),
  );
}

/** "£4 a month", from the price Stripe actually holds. */
function priceLine(price) {
  if (!price || typeof price.amount !== 'number') return null;
  let amount;
  try {
    amount = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: (price.currency || 'gbp').toUpperCase(),
      minimumFractionDigits: price.amount % 100 === 0 ? 0 : 2,
    }).format(price.amount / 100);
  } catch {
    // An unrecognised currency code is not a reason to show nothing.
    amount = `${(price.amount / 100).toFixed(2)} ${String(price.currency).toUpperCase()}`;
  }
  return price.interval ? `${amount} a ${price.interval}` : amount;
}

/**
 * Opens a page outside the app.
 *
 * The shell hands any off-app https navigation to the default browser, which
 * is where a payment form belongs: it is the window with the padlock in it,
 * and it is the one the person can actually inspect.
 *
 * A `target` of `_blank` does not reach the shell's navigation delegate — it
 * goes to `createWebViewWith`, which the app implements for exactly this, and
 * which drops the click on the floor if it is ever removed. Keep them together.
 */
function openOutside(url) {
  const link = el('a', { href: url, rel: 'noopener noreferrer', target: '_blank' });
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/**
 * Waits for the purchase to land.
 *
 * Payment finishes in another application, and what makes it real is a webhook
 * Stripe sends to the server — so there is no event here to listen for, and
 * the only honest thing the app can do is keep asking. It gives up after ten
 * minutes rather than polling for ever, and says what to do if it does.
 */
function watchForEntitlement(host, onGranted) {
  const deadline = Date.now() + 10 * 60 * 1000;
  let timer = null;

  const tick = async () => {
    // The sheet was closed; there is nobody left to tell.
    if (!document.body.contains(host)) return;
    if (Date.now() > deadline) {
      host.replaceChildren(el('div', { class: 'sub' },
        'Studex is still waiting to hear from the payment. If it went through, it will '
        + 'appear the next time you open the Plan screen.'));
      return;
    }
    let status = null;
    try { status = await api.planStatus(); }
    catch { /* Offline for a moment is not a failed purchase. */ }

    if (status?.entitled) {
      onGranted(status);
      return;
    }
    timer = setTimeout(tick, 3000);
  };

  timer = setTimeout(tick, 2500);
  return () => { if (timer) clearTimeout(timer); };
}

/**
 * Shows what Pro adds, and offers the switch only when the switch would work.
 *
 * There are four different truths to tell here and the sheet tells whichever
 * one applies: an account already on Pro, an account that has been paid for
 * and only needs moving, an install that can sell Pro, and an install that
 * cannot. The last one is the one worth being careful about — a build with no
 * checkout says so, rather than showing a button that fails.
 */
export async function showProFeatures({ reason = null } = {}) {
  let status = null;
  let billing = null;
  try {
    [status, billing] = await Promise.all([
      api.planStatus(),
      api.billingConfig().catch(() => null),
    ]);
  } catch { /* The pitch does not need the server to be readable. */ }

  const entitled = Boolean(status?.entitled);
  const already = (status?.plan ?? state.user?.plan) === 'pro';
  const forSale = Boolean(billing?.available);
  const cost = priceLine(billing?.price);

  /** Everything below the feature list, redrawn as the situation changes. */
  const action = el('div', { class: 'pro-action' });
  let stopWatching = null;
  let switched = false;

  const finish = async (message) => {
    try {
      const { user } = await api.me();
      state.user = user;
      rerender();
    } catch (err) { reportError(err); }
    switched = true;
    toast(message);
  };

  const drawPaid = () => {
    action.replaceChildren(
      el('div', { class: 'sub', text: 'You are on Pro.' }),
      forSale
        ? el('button', {
            class: 'btn lg', type: 'button', text: 'Manage subscription',
            onclick: async (event) => {
              event.target.disabled = true;
              try {
                const { url } = await api.billingPortal();
                openOutside(url);
              } catch (err) { reportError(err); }
              event.target.disabled = false;
            },
          })
        : null,
    );
  };

  const drawSwitch = () => {
    action.replaceChildren(
      el('div', { class: 'sub', text: 'This account has been paid for, so the switch is yours to make.' }),
      el('button', {
        class: 'btn primary lg', type: 'button', text: 'Switch to Pro',
        onclick: async (event) => {
          event.target.disabled = true;
          try {
            await api.setPlan('pro');
            await finish('Switched to Studex Pro.');
            drawPaid();
          } catch (err) {
            event.target.disabled = false;
            reportError(err);
          }
        },
      }),
    );
  };

  const drawWaiting = () => {
    action.replaceChildren(
      el('div', { class: 'sub' },
        'The payment page is open in your browser. Studex will switch this account '
        + 'over as soon as the payment goes through — you can leave this open, or close it '
        + 'and carry on.'),
    );
    stopWatching = watchForEntitlement(action, async () => {
      await finish('Studex Pro is active on this account.');
      drawPaid();
    });
  };

  const drawBuy = () => {
    action.replaceChildren(
      cost ? el('div', { class: 'pro-price', text: cost }) : null,
      el('button', {
        class: 'btn primary lg', type: 'button', text: 'Subscribe to Pro',
        onclick: async (event) => {
          event.target.disabled = true;
          try {
            const { url } = await api.startCheckout();
            openOutside(url);
            drawWaiting();
          } catch (err) {
            event.target.disabled = false;
            reportError(err);
          }
        },
      }),
      el('div', { class: 'sub' },
        'Payment is handled by Stripe, in your browser. Studex never sees your card. '
        + 'You can cancel at any time from this screen.'),
    );
  };

  const drawNoCheckout = () => {
    action.replaceChildren(el('div', { class: 'sub' },
      'This install of Studex has no checkout, so Pro cannot be bought from inside the app. '
      + 'An account is moved up by adding a licence to the install it runs on — '
      + 'until then the plan stays as it is.'));
  };

  if (already) drawPaid();
  else if (entitled) drawSwitch();
  else if (forSale) drawBuy();
  else drawNoCheckout();

  const body = el('div', { class: 'pro-sheet' },
    reason ? el('div', { class: 'pro-reason' }, icon('info', { size: 15 }), reason) : null,
    featureList(),
    action,
  );

  await dialog({
    title: 'Studex Pro',
    body,
    cancelLabel: 'Close',
    confirmLabel: 'Done',
    onConfirm: () => true,
  });

  if (stopWatching) stopWatching();
  return switched;
}
