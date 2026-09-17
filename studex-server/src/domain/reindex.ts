/**
 * Puts a restored file's contents back into the search index.
 *
 * Trashing a file sweeps out everything that came from it, which is what stops
 * a search result outliving the thing it points at. Restoring has to be able to
 * undo that, and only the domain that owns each kind of content knows how to
 * describe it — so the rebuild lives here, above all of them, rather than
 * inside library.ts where it would close a circle of imports.
 */
import { getDb } from '../lib/db.js';
import * as search from './search.js';
import { blocksToText, type Block } from './documents.js';
import type { FileRow } from './library.js';

interface CardText {
  id: string;
  front: string;
  back: string;
}
interface AnnotationText {
  id: string;
  kind: string;
  page: number;
  quoted_text: string | null;
  note: string | null;
}

export function reindexFile(userId: string, file: FileRow): void {
  const db = getDb();

  // A document's own text is indexed as the file entity, so the body has to be
  // read back rather than left empty the way a fresh file starts.
  let body = '';
  if (file.kind === 'doc') {
    const row = getDb()
      .prepare<[string], { blocks: string }>('SELECT blocks FROM documents WHERE file_id = ?')
      .get(file.id);
    if (row) {
      try {
        body = blocksToText(JSON.parse(row.blocks) as Block[]);
      } catch {
        body = '';
      }
    }
  }

  search.indexEntity({
    userId,
    entityType: 'file',
    entityId: file.id,
    fileId: file.id,
    title: file.title,
    body,
  });

  if (file.kind === 'deck') {
    const cards = db
      .prepare<[string, string], CardText>(
        'SELECT id, front, back FROM cards WHERE user_id = ? AND deck_id = ?',
      )
      .all(userId, file.id);
    for (const card of cards) {
      search.indexEntity({
        userId,
        entityType: 'card',
        entityId: card.id,
        fileId: file.id,
        title: card.front,
        body: card.back,
      });
    }
    return;
  }

  if (file.kind === 'pdf') {
    const annotations = db
      .prepare<[string, string], AnnotationText>(
        'SELECT id, kind, page, quoted_text, note FROM annotations WHERE user_id = ? AND file_id = ?',
      )
      .all(userId, file.id);
    for (const annotation of annotations) {
      search.indexEntity({
        userId,
        entityType: 'annotation',
        entityId: annotation.id,
        fileId: file.id,
        title: annotation.quoted_text?.slice(0, 200) ?? `${annotation.kind} on page ${annotation.page}`,
        body: [annotation.quoted_text, annotation.note].filter(Boolean).join('\n'),
      });
    }
  }
}
