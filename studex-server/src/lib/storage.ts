import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { config } from './config.js';
import { badRequest, payloadTooLarge } from './errors.js';

/** Storage keys are generated here and never taken from user input. */
const KEY_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;

export function newStorageKey(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Resolves a storage key to an absolute path, refusing anything that escapes
 * the storage root. Keys are server-generated, so this is defence in depth
 * against a future caller-supplied path reaching this function.
 */
export function resolveStoragePath(key: string): string {
  if (!KEY_PATTERN.test(key)) throw badRequest('Invalid storage key');
  const shard = key.slice(0, 2);
  const full = path.resolve(config.storageDir, shard, key);
  const root = path.resolve(config.storageDir);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw badRequest('Invalid storage key');
  }
  return full;
}

export interface StoredBlob {
  key: string;
  byteSize: number;
  sha256: string;
}

/**
 * Streams an upload to disk under a random key, enforcing a hard byte cap and
 * a magic-number check. The temp file is written first and only moved into
 * place once the content has been accepted, so a rejected upload leaves
 * nothing behind and a partial write is never visible as a real blob.
 */
export interface HeadCheck {
  /** How many bytes are needed before the format can be decided. */
  bytes: number;
  /** True when the head belongs to an accepted format. */
  test(head: Buffer): boolean;
  /** What to say when it does not. */
  message?: string;
}

export interface StoreOptions {
  maxBytes: number;
  expectMagic?: Buffer;
  expectFormat?: HeadCheck;
  /**
   * Whether the source delivered everything it had, asked once the stream has
   * ended.
   *
   * A multipart parser with a limit of its own does not error when it hits it:
   * it stops the stream early and sets a flag. To this function that is
   * indistinguishable from a file that simply ended, so the truncated bytes
   * hash cleanly, get renamed into place, and the caller goes on to insert a
   * row for them. The route then notices the flag and returns 413 — after the
   * blob exists and the quota has been charged, leaving a half a PDF in the
   * library with an error message on top of it.
   *
   * Asking here instead means the truncation is discovered while the temp file
   * is still a temp file, so the rejection is the same as any other: nothing
   * written, nothing counted, nothing to clean up.
   */
  complete?: () => boolean;
}

export async function storeStream(
  source: Readable,
  opts: StoreOptions,
): Promise<StoredBlob> {
  const key = newStorageKey();
  const finalPath = resolveStoragePath(key);
  await fsp.mkdir(path.dirname(finalPath), { recursive: true });

  const tmpPath = `${finalPath}.${randomBytes(6).toString('hex')}.part`;
  const hash = createHash('sha256');
  let bytes = 0;
  // One of the two checks may be set; a stream with neither is stored as-is.
  const head: HeadCheck | null = opts.expectMagic
    ? {
        bytes: opts.expectMagic.length,
        test: (buf) => buf.subarray(0, opts.expectMagic!.length).equals(opts.expectMagic!),
      }
    : opts.expectFormat ?? null;
  let magicChecked = head === null;
  let magicBuffer = Buffer.alloc(0);
  let rejection: Error | null = null;

  const out = fs.createWriteStream(tmpPath, { mode: 0o600 });

  try {
    await pipeline(source, async function* (chunks) {
      for await (const chunk of chunks) {
        const buf = chunk as Buffer;
        bytes += buf.length;
        if (bytes > opts.maxBytes) {
          rejection = payloadTooLarge('File exceeds the maximum allowed size');
          throw rejection;
        }

        if (!magicChecked && head) {
          magicBuffer = Buffer.concat([magicBuffer, buf]);
          if (magicBuffer.length >= head.bytes) {
            if (!head.test(magicBuffer)) {
              // Trusting the declared content type or the file extension would
              // let a caller store anything; the bytes themselves decide.
              rejection = badRequest(head.message ?? 'File content does not match the expected format');
              throw rejection;
            }
            magicChecked = true;
          }
        }

        hash.update(buf);
        yield buf;
      }
    }, out);

    if (!magicChecked) {
      throw badRequest(head?.message ?? 'File content does not match the expected format');
    }
    if (bytes === 0) throw badRequest('File is empty');
    if (opts.complete && !opts.complete()) {
      throw payloadTooLarge('File exceeds the maximum allowed size');
    }

    await fsp.rename(tmpPath, finalPath);
    return { key, byteSize: bytes, sha256: hash.digest('hex') };
  } catch (err) {
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    throw rejection ?? err;
  }
}

/**
 * Stores bytes already in hand.
 *
 * Pull downloads a whole object before it knows what to do with it, so there
 * is no stream to cap and no magic to sniff — the format was decided when the
 * item was written upstream. Callers remain responsible for the quota; this
 * only puts the bytes on disk.
 */
export async function storeBuffer(body: Buffer): Promise<StoredBlob> {
  const key = newStorageKey();
  const finalPath = resolveStoragePath(key);
  await fsp.mkdir(path.dirname(finalPath), { recursive: true });
  await fsp.writeFile(finalPath, body);
  return {
    key,
    byteSize: body.byteLength,
    sha256: createHash('sha256').update(body).digest('hex'),
  };
}

export async function deleteBlob(key: string): Promise<void> {
  try {
    await fsp.rm(resolveStoragePath(key), { force: true });
  } catch {
    // A missing blob is not an error for deletion purposes.
  }
}

/** The whole of a blob in memory. Used where the caller needs bytes, not a stream. */
export async function readBlob(key: string): Promise<Buffer> {
  return fsp.readFile(resolveStoragePath(key));
}

export function blobReadStream(key: string): Readable {
  return fs.createReadStream(resolveStoragePath(key));
}

export async function blobExists(key: string): Promise<boolean> {
  try {
    await fsp.access(resolveStoragePath(key));
    return true;
  } catch {
    return false;
  }
}

/** Strips anything that could break a Content-Disposition header. */
export function safeFilename(name: string, fallback = 'file.pdf'): string {
  const base = path
    .basename(name)
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return base.length > 0 ? base : fallback;
}
