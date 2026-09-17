import { hash, verify, Algorithm } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';

/**
 * argon2id at the OWASP-recommended floor (m=19 MiB, t=2, p=1).
 * Raising memoryCost is the cheapest way to harden this later; existing hashes
 * carry their own parameters, so verification keeps working across changes.
 */
const OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS);
}

export async function verifyPassword(digest: string, plain: string): Promise<boolean> {
  try {
    return await verify(digest, plain, OPTIONS);
  } catch {
    // A malformed stored hash must read as "does not match", never as a crash.
    return false;
  }
}

/**
 * Verifying against a real throwaway hash so that a login attempt for an
 * unknown account costs the same as one for a real account. Without this,
 * response time enumerates registered emails.
 *
 * The hash is computed once at startup rather than hardcoded, because a
 * malformed literal would fail instantly and silently defeat the purpose.
 */
const dummyHash: Promise<string> = hash(randomBytes(32).toString('hex'), OPTIONS);

export async function burnPasswordCycle(plain: string): Promise<void> {
  await verifyPassword(await dummyHash, plain);
}
