/**
 * Grants or revokes Studex Pro on this install.
 *
 * The app itself cannot do this — `setPlan` refuses to raise a tier with no
 * entitlement behind it, and nothing a client can call writes one. When there
 * is a checkout, its callback writes the same row this does. Until then, this
 * is how somebody who has paid (or who runs their own copy) gets Pro.
 *
 *   npm run licence -- grant you@example.com
 *   npm run licence -- grant you@example.com --until 2027-01-01
 *   npm run licence -- revoke you@example.com
 *   npm run licence -- status you@example.com
 */
import { getDb } from './lib/db.js';
import * as auth from './domain/auth.js';
import { normalizeEmail } from './lib/validation.js';

const [command, rawEmail, ...rest] = process.argv.slice(2);

if (!command || !rawEmail) {
  console.error('Usage: npm run licence -- <grant|revoke|status> <email> [--until YYYY-MM-DD]');
  process.exit(2);
}

const row = getDb()
  .prepare<[string], { id: string; email: string; plan: string }>(
    'SELECT id, email, plan FROM users WHERE email_normalized = ?',
  )
  .get(normalizeEmail(rawEmail));

if (!row) {
  console.error(`No account here with the address ${rawEmail}.`);
  process.exit(1);
}

function expiryFrom(args: string[]): number | null {
  const at = args.indexOf('--until');
  if (at === -1) return null;
  const value = args[at + 1];
  const parsed = value ? Date.parse(value) : NaN;
  if (Number.isNaN(parsed)) {
    console.error('--until wants a date the runtime can read, e.g. 2027-01-01.');
    process.exit(2);
  }
  return parsed;
}

switch (command) {
  case 'grant': {
    const expiresAt = expiryFrom(rest);
    auth.grantProEntitlement(row.id, { source: 'licence', reference: null, expiresAt });
    auth.setPlan(row.id, 'pro');
    console.log(
      `${row.email} is on Studex Pro${expiresAt ? ` until ${new Date(expiresAt).toDateString()}` : ''}.`,
    );
    break;
  }
  case 'revoke': {
    auth.revokeProEntitlement(row.id);
    console.log(`${row.email} is back on Studex Free. Nothing was deleted.`);
    break;
  }
  case 'status': {
    const entitled = auth.hasProEntitlement(row.id);
    console.log(`${row.email}: plan ${row.plan}, ${entitled ? 'entitled to Pro' : 'not entitled to Pro'}.`);
    break;
  }
  default:
    console.error(`Unknown command "${command}". Use grant, revoke or status.`);
    process.exit(2);
}
