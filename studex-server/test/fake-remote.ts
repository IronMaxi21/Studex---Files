import { createHash } from 'node:crypto';
import type { RemoteItem, RemoteStore } from '../src/domain/sync.js';

/**
 * Supabase, reduced to the six operations sync performs.
 *
 * It is a real little database rather than a spy: rows are stored, objects are
 * stored beside them, and the foreign key that library_items actually has is
 * enforced. That is what lets a test push from one device and pull onto
 * another and have the result mean something — and what made the ordering bug
 * in the first push fail here instead of upstream.
 */
export interface FakeRemote {
  store: RemoteStore;
  items: Map<string, RemoteItem>;
  objects: Map<string, { body: Buffer; mime: string }>;
  uploads: string[];
  order: string[];
  deletedItems: string[];
  deletedObjects: string[];
  downloads: string[];
  /** Edits an item as though another device had pushed it. */
  edit(name: string, body: Buffer, mime?: string): void;
  find(name: string): RemoteItem;
}

export function fakeRemote(): FakeRemote {
  const items = new Map<string, RemoteItem>();
  const objects = new Map<string, { body: Buffer; mime: string }>();
  const uploads: string[] = [];
  const order: string[] = [];
  const deletedItems: string[] = [];
  const deletedObjects: string[] = [];
  const downloads: string[] = [];

  const store: RemoteStore = {
    async upsertItem(item) {
      // The real table has a foreign key and a trigger behind parent_id, so a
      // child arriving before its parent is a hard failure upstream. Modelling
      // that here means the test fails for the same reason production would.
      if (item.parentId && !items.has(item.parentId)) {
        throw new Error(`parent ${item.parentId} does not exist yet`);
      }
      items.set(item.id, { ...item });
      order.push(`${item.kind}:${item.name}`);
    },
    async deleteItem(id) {
      items.delete(id);
      deletedItems.push(id);
    },
    async putObject(path, body, mime) {
      objects.set(path, { body, mime });
      uploads.push(path);
    },
    async deleteObject(path) {
      objects.delete(path);
      deletedObjects.push(path);
    },
    async listItems(userId) {
      return [...items.values()].filter((i) => i.userId === userId).map((i) => ({ ...i }));
    },
    async getObject(path) {
      const found = objects.get(path);
      if (!found) throw new Error(`no object at ${path}`);
      downloads.push(path);
      return found.body;
    },
  };

  const find = (name: string): RemoteItem => {
    const found = [...items.values()].find((i) => i.name === name);
    if (!found) throw new Error(`no item named ${name} upstream`);
    return found;
  };

  return {
    store,
    items,
    objects,
    uploads,
    order,
    deletedItems,
    deletedObjects,
    downloads,
    find,
    /**
     * Stands in for the other Mac having pushed. The hash moves with the body,
     * because that is the only thing that makes an item look changed.
     */
    edit(name, body, mime) {
      const item = find(name);
      const hash = createHash('sha256').update(body).digest('hex');
      items.set(item.id, { ...item, contentHash: hash, byteSize: body.byteLength });
      objects.set(item.storagePath!, { body, mime: mime ?? item.mime ?? 'application/json' });
    },
  };
}
