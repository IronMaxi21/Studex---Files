/**
 * Turns the AI on for one test file.
 *
 * Same reason as `stripe-env.ts`: config.ts reads the environment once at
 * module scope, so this has to be evaluated before anything that imports it.
 * It imports `setup.ts` itself rather than sitting beside it, because setup
 * clears the API key and would otherwise undo this.
 *
 * The key is not a credential — it is a non-empty string, which is the only
 * thing config asks of it — and nothing in this file ever leaves the process:
 * `fetch` is replaced before the first request is made, and refuses anything
 * not aimed at the model.
 *
 * The allowance is set low on purpose. The month's cap is one of the things
 * being tested, and reaching it honestly is cheaper than mocking a counter.
 */
import './setup.js';

process.env.GEMINI_API_KEY = 'AIzaSy-not-a-real-key';
// Six, so a specification import (which counts as five) fits inside it.
process.env.AI_MONTHLY_REQUESTS = '6';
// Well above what this file provokes in a minute. The month's allowance above
// is the limit being tested; the per-minute one only exists to stop a loop.
process.env.AI_RATE_LIMIT_MAX = '1000';
