import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import { exportEntries, exportFilename } from '../domain/export.js';
import { requireAuth } from '../lib/http.js';
import { zipStream } from '../lib/zip.js';

export async function exportRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The whole account, as one archive.
   *
   * Rate-limited hard because it is by far the most expensive thing a session
   * can ask for — it reads every file the account has — and because nobody
   * needs their entire library twice in a minute.
   *
   * No content-length: the archive is generated as it is sent and its size is
   * not known until the last entry has been written. That is the trade for
   * never holding a degree's worth of PDFs in memory, and every client handles
   * a chunked download.
   */
  app.get(
    '/export',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const { user } = requireAuth(req);

      return reply
        .header('content-type', 'application/zip')
        .header('x-content-type-options', 'nosniff')
        .header('content-disposition', `attachment; filename="${exportFilename()}"`)
        // An export is a snapshot of the moment it was asked for; a cached one
        // is a lie about what the account currently holds.
        .header('cache-control', 'no-store')
        .send(Readable.from(zipStream(exportEntries(user.id))));
    },
  );
}
