import { z } from 'zod';
import { unprocessable } from './errors.js';

/** Parses untrusted input, converting zod failures into a 422 with field detail. */
export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    throw unprocessable(
      // One problem reads better as its own sentence than as "Validation failed".
      result.error.issues.length === 1 && first && !/^(Required|Invalid|Expected)/.test(first.message)
        ? first.message
        : 'Validation failed',
      result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    );
  }
  return result.data;
}

/** Any C0/C1 control character, plus DEL. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;
/** Same, but tab, line feed and carriage return are allowed. */
const CONTROL_CHARS_MULTILINE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

/** Trimmed, length-bounded single-line text. Rejects control characters. */
export const text = (max: number, min = 1) =>
  z
    .string()
    .transform((s) => s.normalize('NFC').trim())
    .pipe(
      z
        .string()
        .min(min)
        .max(max)
        .refine((s) => !CONTROL_CHARS.test(s), {
          message: 'Control characters are not allowed',
        }),
    );

/**
 * A name for something the person made — a file, a folder. Left blank (or
 * missing), it is "Untitled" rather than an error: nothing in the library is
 * nameless, and nobody should be stopped at a dialog for want of a title.
 */
export const nameOrUntitled = (max: number) =>
  z
    .string()
    .nullish()
    .transform((s) => (s ?? '').normalize('NFC').trim() || 'Untitled')
    .pipe(text(max));

/** Multi-line text: same rules, but newlines and tabs are permitted. */
export const richText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((s) => s.normalize('NFC'))
    .refine((s) => !CONTROL_CHARS_MULTILINE.test(s), {
      message: 'Control characters are not allowed',
    });

export const uuid = z.string().uuid();

/** Year 2100 — rejects nonsense far-future timestamps. */
const MAX_EPOCH_MS = 4102444800000;

export const epochMs = z.number().int().min(0).max(MAX_EPOCH_MS);

/**
 * The same instant as it arrives in a query string, where every value is text.
 * Using the plain `epochMs` on a query parameter rejects every request,
 * because a number never survives the URL.
 */
export const epochMsParam = z.coerce.number().int().min(0).max(MAX_EPOCH_MS);

/** A CSS colour token: a hex value or one of the design system's named roles. */
export const colorToken = z
  .string()
  .trim()
  .regex(
    /^(#[0-9a-fA-F]{6}|accent|accent-2|neutral|amber|rose|teal|violet|lime|sky)$/,
    'Must be a 6-digit hex colour or a known colour role',
  );

export const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .email('Must be a valid email address');

/**
 * NIST SP 800-63B: length is what matters; composition rules are not required.
 * The upper bound guards against pathologically large inputs being hashed.
 */
export const password = z
  .string()
  .min(12, 'Must be at least 12 characters')
  .max(1024, 'Must be at most 1024 characters');

export const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

/** Normalises an email for uniqueness checks without mangling the display form. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase().normalize('NFKC');
}

/** The most-abused passwords; rejected regardless of length. */
const COMMON = new Set([
  'password1234',
  'passwordpassword',
  '123456789012',
  'qwertyuiopas',
  'administrator',
  'letmeinletmein',
  'iloveyouiloveyou',
  'welcome12345',
]);

export function isWeakPassword(pw: string, emailAddr: string): string | null {
  const lower = pw.toLowerCase();
  if (COMMON.has(lower)) return 'That password is too common';
  const local = emailAddr.split('@')[0]?.toLowerCase() ?? '';
  if (local.length >= 4 && lower.includes(local)) {
    return 'Password must not contain your email address';
  }
  if (/^(.)\1+$/.test(pw)) return 'Password must not be a single repeated character';
  return null;
}
