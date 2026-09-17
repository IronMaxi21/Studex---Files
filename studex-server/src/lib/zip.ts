/**
 * Just enough of the ZIP format to write one.
 *
 * Node ships deflate but no container writer, and an export is the one place
 * the app has to produce a file for someone else's computer to open. A
 * dependency for a hundred lines of well-documented, thirty-year-old struct
 * layout is a poor trade — especially for the feature whose whole purpose is
 * that the data survives this program.
 *
 * Written as a generator so an archive is never held in memory: entries are
 * pulled one at a time, and a PDF passes through as a stream. Only the central
 * directory accumulates, which is a few dozen bytes per file.
 *
 * The format is APPNOTE 6.3.2's baseline — no Zip64, no encryption — which
 * every unarchiver on every desktop reads without being told anything.
 */
import { deflateRawSync } from 'node:zlib';

const LOCAL_SIGNATURE = 0x04034b50;
const DESCRIPTOR_SIGNATURE = 0x08074b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

/** 2.0: the version that introduced deflate, which is all this uses. */
const VERSION_NEEDED = 20;
/** Upper byte 3 says the external attributes below are UNIX permissions. */
const VERSION_MADE_BY = (3 << 8) | VERSION_NEEDED;
/** 0644, in the high half where the UNIX mode lives. */
const EXTERNAL_ATTRIBUTES = (0o100644 << 16) >>> 0;

/** Bit 3: sizes and CRC follow the data instead of preceding it. */
const FLAG_DESCRIPTOR = 0x0008;
/** Bit 11: the name is UTF-8 rather than the DOS code page of 1989. */
const FLAG_UTF8 = 0x0800;

const STORED = 0;
const DEFLATED = 8;

/**
 * Where the baseline format stops being able to count.
 *
 * Past either of these an archive needs Zip64, which is a second set of
 * records this does not write. Refusing is honest; writing a header that says
 * 4,294,967,295 and hoping is not.
 */
const MAX_OFFSET = 0xffffffff;
const MAX_ENTRIES = 0xffff;

/** Bytes to put in the archive, given by value or pulled when they are due. */
export type ZipBody = Buffer | (() => AsyncIterable<Buffer> | Iterable<Buffer> | NodeJS.ReadableStream);

export interface ZipEntry {
  /** The path inside the archive, with `/` separators and no leading slash. */
  name: string;
  body: ZipBody;
  /**
   * Whether to try deflating. Text compresses to a fraction of itself; a PDF
   * or a JPEG is already compressed and deflating it spends time to make it
   * very slightly larger. The default follows that split, so callers rarely
   * set it.
   */
  compress?: boolean;
  /** Modification time. Defaults to now, which is when the export was made. */
  mtime?: number;
}

/* ---------------------------------- crc32 --------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

/** Rolling CRC-32, so a streamed entry never has to be held to be checksummed. */
function crc32(chunk: Buffer, running = 0): number {
  let c = ~running;
  for (let i = 0; i < chunk.length; i += 1) {
    c = CRC_TABLE[(c ^ chunk[i]!) & 0xff]! ^ (c >>> 8);
  }
  return ~c >>> 0;
}

/* ------------------------------- structures ------------------------------- */

/**
 * The MS-DOS date and time the format still records, seconds included only to
 * even numbers. Anything before 1980 cannot be expressed and is clamped there.
 */
function dosDateTime(ms: number): { time: number; date: number } {
  const d = new Date(ms);
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

interface Written {
  name: Buffer;
  flags: number;
  method: number;
  time: number;
  date: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  offset: number;
}

function localHeader(e: Written): Buffer {
  const head = Buffer.alloc(30);
  head.writeUInt32LE(LOCAL_SIGNATURE, 0);
  head.writeUInt16LE(VERSION_NEEDED, 4);
  head.writeUInt16LE(e.flags, 6);
  head.writeUInt16LE(e.method, 8);
  head.writeUInt16LE(e.time, 10);
  head.writeUInt16LE(e.date, 12);
  // With a descriptor these three are written twice: zero here, real below.
  head.writeUInt32LE(e.flags & FLAG_DESCRIPTOR ? 0 : e.crc, 14);
  head.writeUInt32LE(e.flags & FLAG_DESCRIPTOR ? 0 : e.compressedSize, 18);
  head.writeUInt32LE(e.flags & FLAG_DESCRIPTOR ? 0 : e.uncompressedSize, 22);
  head.writeUInt16LE(e.name.length, 26);
  head.writeUInt16LE(0, 28);
  return Buffer.concat([head, e.name]);
}

function dataDescriptor(e: Written): Buffer {
  const tail = Buffer.alloc(16);
  tail.writeUInt32LE(DESCRIPTOR_SIGNATURE, 0);
  tail.writeUInt32LE(e.crc, 4);
  tail.writeUInt32LE(e.compressedSize, 8);
  tail.writeUInt32LE(e.uncompressedSize, 12);
  return tail;
}

function centralHeader(e: Written): Buffer {
  const head = Buffer.alloc(46);
  head.writeUInt32LE(CENTRAL_SIGNATURE, 0);
  head.writeUInt16LE(VERSION_MADE_BY, 4);
  head.writeUInt16LE(VERSION_NEEDED, 6);
  head.writeUInt16LE(e.flags, 8);
  head.writeUInt16LE(e.method, 10);
  head.writeUInt16LE(e.time, 12);
  head.writeUInt16LE(e.date, 14);
  head.writeUInt32LE(e.crc, 16);
  head.writeUInt32LE(e.compressedSize, 20);
  head.writeUInt32LE(e.uncompressedSize, 24);
  head.writeUInt16LE(e.name.length, 28);
  head.writeUInt16LE(0, 30); // extra
  head.writeUInt16LE(0, 32); // comment
  head.writeUInt16LE(0, 34); // disk
  head.writeUInt16LE(0, 36); // internal attributes
  head.writeUInt32LE(EXTERNAL_ATTRIBUTES, 38);
  head.writeUInt32LE(e.offset, 42);
  return Buffer.concat([head, e.name]);
}

function endOfCentralDirectory(count: number, size: number, offset: number): Buffer {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD_SIGNATURE, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // the disk the directory starts on
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment
  return end;
}

/* --------------------------------- writing -------------------------------- */

/**
 * A name that means the same thing to every unarchiver.
 *
 * Backslashes become separators, `.` and `..` segments are dropped, and a
 * leading slash goes — a path that climbs out of the folder it was extracted
 * into is the one thing an archive must never be able to say.
 */
export function zipName(name: string): string {
  return name
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
}

/**
 * Writes an archive of `entries`, yielding it in the order it goes out.
 *
 * The caller may hand over an async iterable, so entries can be read from the
 * database as they are needed rather than gathered first.
 */
export async function* zipStream(
  entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>,
): AsyncGenerator<Buffer> {
  const directory: Written[] = [];
  let offset = 0;

  for await (const entry of entries) {
    if (directory.length >= MAX_ENTRIES) {
      throw new Error('That is more files than a zip archive can hold');
    }

    const name = Buffer.from(zipName(entry.name), 'utf8');
    if (!name.length) continue;
    const { time, date } = dosDateTime(entry.mtime ?? Date.now());

    if (Buffer.isBuffer(entry.body)) {
      const raw = entry.body;
      const deflated = entry.compress === false ? null : deflateRawSync(raw);
      // Deflate is only worth it if it actually shrank the file; a stored
      // entry is smaller than a deflate stream that gained a few bytes.
      const useDeflate = deflated !== null && deflated.length < raw.length;
      const written: Written = {
        name,
        flags: FLAG_UTF8,
        method: useDeflate ? DEFLATED : STORED,
        time,
        date,
        crc: crc32(raw),
        compressedSize: useDeflate ? deflated!.length : raw.length,
        uncompressedSize: raw.length,
        offset,
      };
      const head = localHeader(written);
      yield head;
      yield useDeflate ? deflated! : raw;
      offset += head.length + written.compressedSize;
      directory.push(written);
    } else {
      // A stream's length and checksum are not known until it has run, so the
      // header promises nothing and a descriptor follows with the truth. This
      // is what bit 3 is for, and it is why blobs never have to be buffered.
      const written: Written = {
        name,
        flags: FLAG_UTF8 | FLAG_DESCRIPTOR,
        method: STORED,
        time,
        date,
        crc: 0,
        compressedSize: 0,
        uncompressedSize: 0,
        offset,
      };
      const head = localHeader(written);
      yield head;
      offset += head.length;

      for await (const chunk of entry.body() as AsyncIterable<Buffer>) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        written.crc = crc32(buf, written.crc);
        written.uncompressedSize += buf.length;
        offset += buf.length;
        yield buf;
      }
      written.compressedSize = written.uncompressedSize;

      const tail = dataDescriptor(written);
      yield tail;
      offset += tail.length;
      directory.push(written);
    }

    if (offset > MAX_OFFSET) {
      throw new Error('That is more data than a zip archive can address');
    }
  }

  const start = offset;
  let size = 0;
  for (const entry of directory) {
    const head = centralHeader(entry);
    size += head.length;
    yield head;
  }
  yield endOfCentralDirectory(directory.length, size, start);
}
