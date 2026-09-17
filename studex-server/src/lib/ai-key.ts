/**
 * The Google AI Studio (Gemini) key, wherever it was put.
 *
 * Three places, in order. `GEMINI_API_KEY` in the environment, for a server
 * someone runs themselves and for the tests. Then a file beside the database,
 * which is where the desktop app's Settings screen writes the key pasted into
 * it — so the key works the moment it is saved, with no restart. Last, the key
 * a release build carries (`GEMINI_BUILTIN_KEY_FILE`, handed down by the app),
 * so a downloaded copy has AI with nothing to set up, while a key of the
 * student's own still wins over it.
 *
 * A file with 0600 permissions rather than the Keychain for the same reason as
 * `SessionSecret.swift`: an ad-hoc signed app changes identity on every build,
 * and the Keychain would ask for a password each time it did. The file sits in
 * the same Application Support folder as the database, which already holds
 * everything the key could be used to reach.
 *
 * The key is never read back out through the API. Settings is told whether one
 * is set and where it came from, and the last four characters to recognise it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

function keyFile(): string {
  return path.join(path.dirname(config.databasePath), 'gemini.key');
}

/**
 * What a key can look like: the same rule Settings applies to a pasted one.
 * Anything else — a hand-edited file with a stray character, a truncated or
 * mismatched built-in pad unmasking to binary — is not a key, and must not be
 * treated as one: it would go out as the `x-goog-api-key` header, which fetch
 * refuses to send, so every AI request failed with an opaque error while
 * Settings reported a key as set.
 */
function usable(value: string | null | undefined): string | null {
  const key = value?.trim();
  return key && /^[\x21-\x7E]{20,512}$/.test(key) ? key : null;
}

let cached: { value: string | null } | null = null;

function fromFile(): string | null {
  if (cached) return cached.value;
  let value: string | null = null;
  try {
    value = usable(fs.readFileSync(keyFile(), 'utf8'));
  } catch { /* no file is the ordinary case */ }
  cached = { value };
  return value;
}

let builtinCache: { value: string | null } | null = null;

/**
 * The release build's key. Stored masked — XOR against a pad kept beside it —
 * which is not protection (anyone with the app can undo it), only enough that
 * a scan of the bundle for key-shaped strings finds nothing.
 */
function builtin(): string | null {
  if (builtinCache) return builtinCache.value;
  let value: string | null = null;
  const file = process.env.GEMINI_BUILTIN_KEY_FILE?.trim();
  if (file) {
    try {
      const { pad, data } = JSON.parse(fs.readFileSync(file, 'utf8')) as { pad: string; data: string };
      if (typeof pad !== 'string' || typeof data !== 'string') throw new Error('malformed');
      const padBytes = Buffer.from(pad, 'base64');
      const dataBytes = Buffer.from(data, 'base64');
      // The pad is exactly as long as the key. A shorter one (an empty pad
      // made every byte XOR with undefined, i.e. left it unmasked) means the
      // file is damaged, not that the pad should repeat.
      if (padBytes.length < dataBytes.length) throw new Error('pad too short');
      const bytes = dataBytes.map((b, i) => b ^ padBytes[i]!);
      value = usable(Buffer.from(bytes).toString('latin1'));
    } catch { /* a build without one, or a damaged file: no built-in key */ }
  }
  builtinCache = { value };
  return value;
}

export function currentKey(): string | null {
  return process.env.GEMINI_API_KEY?.trim() || fromFile() || builtin();
}

export function keySource(): 'env' | 'settings' | 'builtin' | null {
  if (process.env.GEMINI_API_KEY?.trim()) return 'env';
  if (fromFile()) return 'settings';
  return builtin() ? 'builtin' : null;
}

/** Enough to tell two keys apart, not enough to use one. */
export function keyHint(): string | null {
  const key = currentKey();
  return key ? `…${key.slice(-4)}` : null;
}

export function saveKey(key: string): void {
  const file = keyFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Written to a sibling and renamed, so a crash mid-write cannot leave half a
  // key that looks like a whole one.
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${key}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  fs.chmodSync(file, 0o600);
  cached = { value: key };
}

export function clearKey(): void {
  try {
    fs.rmSync(keyFile(), { force: true });
  } finally {
    cached = { value: null };
  }
}
