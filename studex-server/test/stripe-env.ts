/**
 * Turns the checkout on for one test file.
 *
 * config.ts reads the environment once, at module scope, so this has to be
 * evaluated before anything that imports it — which is why it is a module of
 * its own rather than three lines at the top of the test.
 *
 * These are not credentials. They are the shapes config.ts insists on, so that
 * the validation which rejects a publishable key in the secret slot is itself
 * exercised, and no request in this file ever leaves the process: `fetch` is
 * replaced before the first one is made.
 */
process.env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key';
process.env.STRIPE_PRICE_ID = 'price_test_pro_monthly';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_signing_secret';
