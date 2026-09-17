/**
 * What was opened lately, newest first — the palette's list before you type.
 *
 * Kept per device in localStorage: it is a convenience of this machine, and a
 * list that went missing costs nothing but a search.
 */
import { fileById, folderById } from './store.js';

const KEY = 'studex.recents';
const LIMIT = 16;
const KINDS = new Set(['doc', 'canvas', 'pdf', 'deck', 'folder']);

function read() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((item) => item && KINDS.has(item.kind) && item.id) : [];
  } catch { return []; }
}

/** Records a route as opened, if it names a file or folder. */
export function trackRecent(route) {
  const [kind, id] = route?.path ?? [];
  if (!KINDS.has(kind) || !id) return;
  const list = read().filter((item) => item.id !== id);
  list.unshift({ kind, id, at: Date.now() });
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, LIMIT))); } catch { /* private mode */ }
}

/** Recent items that still exist in the library, resolved to their records. */
export function recentItems(limit = 8) {
  const out = [];
  for (const item of read()) {
    const record = item.kind === 'folder' ? folderById(item.id) : fileById(item.id);
    if (record) out.push({ ...item, record });
    if (out.length >= limit) break;
  }
  return out;
}
