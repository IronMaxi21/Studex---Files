import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { config } from './config.js';

/** 256 bits of entropy, url-safe. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Secrets that must be looked up (session tokens, share tokens) are stored as
 * SHA-256 hashes. They are already high-entropy random values, so a fast hash
 * is appropriate here — unlike passwords, which use argon2id.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function sha256File(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Constant-time comparison that does not leak length through early return. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Still burn a comparison so the timing profile does not distinguish
    // "wrong length" from "wrong value".
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Authenticated encryption for credentials this server has to keep rather than
 * hash — Supabase refresh tokens, which must be replayable to be useful.
 *
 * The key is derived from SESSION_SECRET, which means a database copied on its
 * own decrypts to nothing, and that rotating the secret invalidates every
 * stored token. In development the secret is ephemeral per restart, so these
 * simply stop opening and the user signs in again: the safe direction to fail.
 */
const SEAL_KEY = scryptSync(config.sessionSecret, 'studex-sealed-secret-v1', 32);

export function sealSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', SEAL_KEY, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    body.toString('base64url'),
  ].join('.');
}

/** Returns null for anything that does not open — tampered, or sealed under an older secret. */
export function openSecret(sealed: string): string | null {
  const parts = sealed.split('.');
  if (parts.length !== 3) return null;
  try {
    const [iv, tag, body] = parts.map((p) => Buffer.from(p, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', SEAL_KEY, iv!);
    decipher.setAuthTag(tag!);
    return Buffer.concat([decipher.update(body!), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
